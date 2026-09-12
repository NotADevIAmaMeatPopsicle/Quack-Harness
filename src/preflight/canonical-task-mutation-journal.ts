import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  recoverDecompositionReplacementArtifactsInDirectory,
  recoverDecompositionReplacementArtifacts,
  unlinkDecompositionFileWithRetry,
  writeDecompositionFileAtomicExclusive,
} from "./decomposition-file-io.js";

const execFileAsync = promisify(execFile);
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const JOURNAL_PREFIX = "mutation-";
const JOURNAL_SUFFIX = ".json";
const GIT_JOURNAL_COMPONENTS = ["quack", "canonical-mutations"] as const;
const RUNTIME_JOURNAL_COMPONENTS = [".quack", "cache", "canonical-mutations"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TASK_ID = /^(?:TASK-\d+|SAURUS-REM-\d{3})(?:-[A-Z]+)?$/;

interface EncodedBytes {
  sha256: string;
  base64: string;
}

interface CanonicalMutationJournal {
  version: 1;
  taskId: string;
  relativePath: string;
  original: EncodedBytes;
  target: EncodedBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(content: string): EncodedBytes {
  const bytes = Buffer.from(content, "utf-8");
  return { sha256: sha256(bytes), base64: bytes.toString("base64") };
}

function decode(value: unknown, label: string): Buffer {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["sha256", "base64"]) ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.base64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
  ) {
    throw new Error(`Malformed ${label} bytes in canonical mutation journal.`);
  }
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.toString("base64") !== value.base64 || sha256(bytes) !== value.sha256) {
    throw new Error(`Hash mismatch for ${label} bytes in canonical mutation journal.`);
  }
  return bytes;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function flushDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function safeDirectoryChain(
  root: string,
  components: readonly string[],
  create: boolean,
  label: string,
): Promise<string> {
  const realRoot = await fs.realpath(root);
  const rootStat = await fs.lstat(realRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Canonical mutation ${label} is not a real directory: ${root}`);
  }

  let current = realRoot;
  for (const component of components) {
    current = path.join(current, component);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
        await flushDirectory(path.dirname(current));
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Canonical mutation journal path is unsafe: ${current}`);
    }
    const realCurrent = await fs.realpath(current);
    if (!contained(realRoot, realCurrent)) {
      throw new Error(`Canonical mutation journal escapes the ${label}: ${current}`);
    }
  }
  return current;
}

async function resolveGitDirectory(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    if (!stdout.trim()) throw new Error("Git returned an empty repository directory.");
    return fs.realpath(stdout.trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: projectRoot,
        encoding: "utf-8",
      });
      if (stdout.trim() === "true") throw error;
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === "ENOENT") throw probeError;
      if (probeError === error) throw probeError;
    }
    return null;
  }
}

async function journalDirectory(projectRoot: string, create = false): Promise<string> {
  const resolvedProjectRoot = await fs.realpath(projectRoot);
  const gitDirectory = await resolveGitDirectory(resolvedProjectRoot);
  if (gitDirectory) {
    return safeDirectoryChain(gitDirectory, GIT_JOURNAL_COMPONENTS, create, "Git directory");
  }
  return safeDirectoryChain(
    resolvedProjectRoot,
    RUNTIME_JOURNAL_COMPONENTS,
    create,
    "project root",
  );
}

function journalName(taskId: string): string {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error(`Unsafe canonical mutation task ID: ${taskId}`);
  return `${JOURNAL_PREFIX}${taskId}${JOURNAL_SUFFIX}`;
}

function parseJournal(raw: unknown, journalPath: string): CanonicalMutationJournal {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["version", "taskId", "relativePath", "original", "target"]) ||
    raw.version !== JOURNAL_VERSION ||
    typeof raw.taskId !== "string" ||
    !SAFE_TASK_ID.test(raw.taskId) ||
    typeof raw.relativePath !== "string" ||
    path.posix.isAbsolute(raw.relativePath) ||
    path.posix.normalize(raw.relativePath) !== raw.relativePath ||
    raw.relativePath.startsWith("../")
  ) {
    throw new Error(`Malformed canonical mutation journal: ${journalPath}`);
  }
  const original = decode(raw.original, "original");
  const target = decode(raw.target, "target");
  return {
    version: JOURNAL_VERSION,
    taskId: raw.taskId,
    relativePath: raw.relativePath,
    original: { sha256: sha256(original), base64: original.toString("base64") },
    target: { sha256: sha256(target), base64: target.toString("base64") },
  };
}

async function writeJournal(journalPath: string, journal: CanonicalMutationJournal): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, "utf-8");
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("Canonical mutation journal is too large.");
  await writeDecompositionFileAtomicExclusive(journalPath, bytes, 0o600);
}

async function removeJournal(journalPath: string): Promise<void> {
  await unlinkDecompositionFileWithRetry(journalPath);
  await flushDirectory(path.dirname(journalPath));
}

export async function createCanonicalTaskMutationJournal(input: {
  adapter: ProjectAdapter;
  taskId: string;
  taskFilePath: string;
  originalContent: string;
  targetContent: string;
}): Promise<string> {
  const projectRoot = path.resolve(input.adapter.projectRoot);
  const taskDir = path.resolve(projectRoot, input.adapter.config.project.taskDir);
  const destination = path.resolve(input.taskFilePath);
  if (!contained(taskDir, destination) || path.dirname(destination) !== taskDir) {
    throw new Error("Canonical mutation journal target is outside the direct task directory.");
  }
  const relativePath = path.relative(projectRoot, destination).replace(/\\/g, "/");
  const directory = await journalDirectory(projectRoot, true);
  const journalPath = path.join(directory, journalName(input.taskId));
  const journal: CanonicalMutationJournal = {
    version: JOURNAL_VERSION,
    taskId: input.taskId,
    relativePath,
    original: encode(input.originalContent),
    target: encode(input.targetContent),
  };
  parseJournal(journal, journalPath);
  await writeJournal(journalPath, journal);
  return journalPath;
}

async function recoverJournal(adapter: ProjectAdapter, journalPath: string): Promise<void> {
  const stat = await fs.lstat(journalPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error(`Unsafe canonical mutation journal: ${journalPath}`);
  }
  const journal = parseJournal(JSON.parse(await fs.readFile(journalPath, "utf-8")), journalPath);
  const projectRoot = path.resolve(adapter.projectRoot);
  const taskDir = path.resolve(projectRoot, adapter.config.project.taskDir);
  const destination = path.resolve(projectRoot, ...journal.relativePath.split("/"));
  if (!contained(taskDir, destination) || path.dirname(destination) !== taskDir) {
    throw new Error(`Canonical mutation journal target escaped the task directory: ${journalPath}`);
  }
  const original = decode(journal.original, "original");
  const target = decode(journal.target, "target");
  await recoverDecompositionReplacementArtifacts(destination, { original, target });
  const current = await fs.readFile(destination);
  const currentHash = sha256(current);
  if (currentHash !== journal.original.sha256 && currentHash !== journal.target.sha256) {
    throw new Error(
      `Canonical mutation destination diverged for ${journal.relativePath}; journal retained.`,
    );
  }
  await removeJournal(journalPath);
}

export async function recoverPendingCanonicalTaskMutationsWithinReservation(
  adapter: ProjectAdapter,
): Promise<void> {
  let directory: string;
  try {
    directory = await journalDirectory(adapter.projectRoot, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await recoverDecompositionReplacementArtifactsInDirectory(directory);
  const names = (await fs.readdir(directory))
    .filter((name) => name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX))
    .sort();
  for (const name of names) await recoverJournal(adapter, path.join(directory, name));
}

/** Cheap startup probe that does not require loading a repository adapter. */
export async function hasPendingCanonicalTaskMutationJournals(
  projectRoot: string,
): Promise<boolean> {
  let directory: string;
  try {
    directory = await journalDirectory(projectRoot, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const names = await fs.readdir(directory);
  return names.some(
    (name) =>
      (name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX)) ||
      name.startsWith(`.${JOURNAL_PREFIX}`),
  );
}

export async function completeCanonicalTaskMutationJournal(journalPath: string): Promise<void> {
  await removeJournal(journalPath);
}
