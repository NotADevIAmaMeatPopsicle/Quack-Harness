import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  readTaskCreationClaimants,
  withTaskCreationReservation,
  type TaskCreationLockOptions,
} from "../core/task-creation-reservation.js";
import {
  DuplicateClaimantAdmissionError,
  normalizeClaimantTaskId,
} from "../core/duplicate-claimants.js";
import { isParentTaskFileName, resolveParsedTaskFile } from "../core/task-file-resolver.js";
import { parseTaskFile } from "../core/task-parser.js";
import type { PlannedSubtaskSpecWrite } from "./subtask-writer.js";
import { buildSubtaskSpecFileName } from "./subtask-writer.js";
import {
  assertSafeDecompositionTaskDirectory,
  decompositionReplacementBackupPath,
  decompositionTemporaryPath,
  listDecompositionReplacementBackupPaths,
  recoverDecompositionReplacementArtifactsInDirectory,
  unlinkDecompositionFileWithRetry,
  writeDecompositionFileAtomicExclusive,
  writeDecompositionFileAtomicReplace,
} from "./decomposition-file-io.js";

const execFileAsync = promisify(execFile);
const JOURNAL_VERSION = 2;
const JOURNAL_PREFIX = ".decompose-transaction-";
const JOURNAL_SUFFIX = ".json";
const STATUS_PROJECTION_PREFIX = ".decompose-status-projection-";
const STATUS_PROJECTION_SUFFIX = ".json";
const STATUS_PROJECTION_VERSION = 1;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{40,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TASK_ID_PATTERN = /^(?:TASK-\d+|SAURUS-REM-\d{3})(?:-[A-Z]+)?$/;
const JOURNAL_DIRECTORY_COMPONENTS = ["quack", "decomposition-transactions"] as const;

export type DecompositionTransactionPhase =
  | "prepared"
  | "parent_written"
  | "children_written"
  | "committing"
  | "committed";

interface EncodedBytes {
  sha256: string;
  base64: string;
}

interface GitEntry {
  mode: string;
  blob: string;
}

interface JournalPathEntry {
  relativePath: string;
  baseIndex: GitEntry | null;
  targetGitBlob: string;
  targetMode: string;
}

interface JournalParent extends JournalPathEntry {
  original: EncodedBytes;
  target: EncodedBytes;
}

interface JournalChild extends JournalPathEntry {
  taskId: string;
  target: EncodedBytes;
}

export interface DecompositionTransactionJournal {
  version: 2;
  parentTaskId: string;
  createdAt: string;
  phase: DecompositionTransactionPhase;
  baseHead: string;
  /** Exact symbolic branch ref, or null when the transaction began detached. */
  baseRef: string | null;
  /** Exact commit-tree object, persisted before the HEAD compare-and-swap. */
  commitSha: string | null;
  parent: JournalParent;
  children: JournalChild[];
}

export interface DecompositionRecoveryResult {
  parentTaskId: string;
  outcome: "rolled_back" | "committed_reconciled";
  journalPath: string;
  /** Exact durable DB-projection record created before a committed journal is removed. */
  statusProjectionId?: string;
}

interface DecompositionStatusProjectionOutbox {
  version: 1;
  projectionId: string;
  createdAt: string;
  status: "DECOMPOSED";
  journal: DecompositionTransactionJournal;
}

export interface DecompositionStatusProjection {
  projectionId: string;
  parentTaskId: string;
  commitSha: string;
  status: "DECOMPOSED";
  createdAt: string;
  source: string;
}

export interface DecompositionStatusProjectionStore {
  getStatus(taskId: string): { status: string; updated_by: string } | undefined;
  setStatus(taskId: string, status: string, updatedBy: string): void;
}

export interface DecompositionStatusProjectionResult extends DecompositionStatusProjection {
  outcome: "projected" | "already_projected";
  outboxPath: string;
}

export interface RecoverAndProjectDecompositionsResult {
  recoveries: DecompositionRecoveryResult[];
  projections: DecompositionStatusProjectionResult[];
}

export interface DecompositionDispatchAdmission {
  taskId: string;
  fileName: string;
  contentHash: string;
}

export class DecompositionRecoveryError extends Error {
  constructor(
    message: string,
    public readonly journalPath?: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DecompositionRecoveryError";
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeBytes(content: string): EncodedBytes {
  const bytes = Buffer.from(content, "utf-8");
  return { sha256: sha256(bytes), base64: bytes.toString("base64") };
}

function decodeBytes(encoded: EncodedBytes, label: string): Buffer {
  if (
    !encoded ||
    typeof encoded.base64 !== "string" ||
    typeof encoded.sha256 !== "string" ||
    !SHA256_PATTERN.test(encoded.sha256) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded.base64)
  ) {
    throw new DecompositionRecoveryError(`Malformed ${label} bytes in decomposition journal.`);
  }
  const bytes = Buffer.from(encoded.base64, "base64");
  if (bytes.toString("base64") !== encoded.base64 || sha256(bytes) !== encoded.sha256) {
    throw new DecompositionRecoveryError(
      `Hash mismatch for ${label} bytes in decomposition journal.`,
    );
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isGitEntry(value: unknown): value is GitEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["mode", "blob"]) &&
    typeof value.mode === "string" &&
    /^\d{6}$/.test(value.mode) &&
    typeof value.blob === "string" &&
    HASH_PATTERN.test(value.blob)
  );
}

function isEncodedBytes(value: unknown): value is EncodedBytes {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sha256", "base64"]) &&
    typeof value.sha256 === "string" &&
    typeof value.base64 === "string"
  );
}

function isSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.includes("\0") &&
    !relativePath.includes("\\") &&
    !path.posix.isAbsolute(relativePath) &&
    path.posix.normalize(relativePath) === relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith("../")
  );
}

function isSafeLocalBranchRef(ref: string): boolean {
  if (!ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) return false;
  if (
    [...ref].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
    }) ||
    ref.includes("..") ||
    ref.includes("@{")
  ) {
    return false;
  }
  if (ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
  return ref
    .slice("refs/heads/".length)
    .split("/")
    .every(
      (component) =>
        component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
    );
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function absoluteFromRelative(projectRoot: string, relativePath: string): string {
  return path.resolve(projectRoot, ...relativePath.split("/"));
}

async function git(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: projectRoot, encoding: "utf-8" });
  return stdout.trim();
}

export type DecompositionGitReader = (projectRoot: string, args: string[]) => Promise<string>;

async function gitOrNull(projectRoot: string, args: string[]): Promise<string | null> {
  try {
    return await git(projectRoot, args);
  } catch {
    return null;
  }
}

async function currentHeadRef(
  projectRoot: string,
  readGit: DecompositionGitReader = git,
): Promise<string | null> {
  // `symbolic-ref -q` uses the same non-zero channel for a legitimate detached
  // HEAD and for an unavailable Git probe. `rev-parse --symbolic-full-name`
  // keeps detached HEAD value-bearing ("HEAD") so observation failures throw
  // instead of being mistaken for a detached checkout.
  const ref = await readGit(projectRoot, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  if (ref === "HEAD" || ref === "") return null;
  if (!isSafeLocalBranchRef(ref)) {
    throw new DecompositionRecoveryError(`Git HEAD resolved to an unsafe symbolic ref: ${ref}.`);
  }
  return ref;
}

async function assertJournalHeadIdentity(
  projectRoot: string,
  journal: Pick<DecompositionTransactionJournal, "baseHead" | "baseRef">,
): Promise<void> {
  const [currentHead, currentRef] = await Promise.all([
    git(projectRoot, ["rev-parse", "HEAD"]),
    currentHeadRef(projectRoot),
  ]);
  if (currentHead !== journal.baseHead || currentRef !== journal.baseRef) {
    throw new DecompositionRecoveryError(
      `Git HEAD identity changed during decomposition (${journal.baseRef ?? "detached"}@${journal.baseHead} -> ${currentRef ?? "detached"}@${currentHead}); journal retained for recovery.`,
      undefined,
      {
        baseHead: journal.baseHead,
        baseRef: journal.baseRef,
        currentHead,
        currentRef,
      },
    );
  }
}

async function validateJournalDirectoryChain(
  realGitDirectory: string,
  requireComplete: boolean,
): Promise<string> {
  let current = realGitDirectory;
  for (const component of JOURNAL_DIRECTORY_COMPONENTS) {
    current = path.join(current, component);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !requireComplete) {
        return path.join(realGitDirectory, ...JOURNAL_DIRECTORY_COMPONENTS);
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DecompositionRecoveryError(
        `Git-private journal path component is not a real directory: ${current}.`,
      );
    }
    const realCurrent = await fs.realpath(current);
    if (!isPathContainedBy(realGitDirectory, realCurrent)) {
      throw new DecompositionRecoveryError(
        `Git-private journal directory resolves outside the worktree Git directory: ${current}.`,
      );
    }
  }

  const journalDir = path.join(realGitDirectory, ...JOURNAL_DIRECTORY_COMPONENTS);
  const realJournalDir = await fs.realpath(journalDir);
  if (!isPathContainedBy(realGitDirectory, realJournalDir)) {
    throw new DecompositionRecoveryError(
      "Git-private journal directory resolves outside the worktree Git directory.",
    );
  }
  return journalDir;
}

async function ensureJournalDirectory(realGitDirectory: string): Promise<string> {
  let current = realGitDirectory;
  for (const component of JOURNAL_DIRECTORY_COMPONENTS) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DecompositionRecoveryError(
        `Git-private journal path component is not a real directory: ${current}.`,
      );
    }
    const realCurrent = await fs.realpath(current);
    if (!isPathContainedBy(realGitDirectory, realCurrent)) {
      throw new DecompositionRecoveryError(
        `Git-private journal directory resolves outside the worktree Git directory: ${current}.`,
      );
    }
  }
  return validateJournalDirectoryChain(realGitDirectory, true);
}

async function journalDirectory(projectRoot: string, create = false): Promise<string> {
  const topLevel = path.resolve(await git(projectRoot, ["rev-parse", "--show-toplevel"]));
  const realProjectRoot = await fs.realpath(projectRoot);
  const realTopLevel = await fs.realpath(topLevel);
  if (realProjectRoot !== realTopLevel) {
    throw new DecompositionRecoveryError(
      "The configured project root is not the root of its Git worktree.",
    );
  }
  const absoluteGitDirectory = await git(projectRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!path.isAbsolute(absoluteGitDirectory)) {
    throw new DecompositionRecoveryError("Git returned a non-absolute worktree Git directory.");
  }
  const realGitDirectory = await fs.realpath(path.resolve(absoluteGitDirectory));
  const gitDirectoryStat = await fs.lstat(realGitDirectory);
  if (!gitDirectoryStat.isDirectory() || gitDirectoryStat.isSymbolicLink()) {
    throw new DecompositionRecoveryError("The worktree Git directory is not a real directory.");
  }
  if (create) return ensureJournalDirectory(realGitDirectory);
  return validateJournalDirectoryChain(realGitDirectory, false);
}

async function readIndexEntry(projectRoot: string, relativePath: string): Promise<GitEntry | null> {
  const output = await git(projectRoot, ["ls-files", "--stage", "--", relativePath]);
  if (!output) return null;
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new DecompositionRecoveryError(`Ambiguous index entry for ${relativePath}.`);
  }
  const match = /^(\d{6}) ([0-9a-f]{40,64}) 0\t/.exec(lines[0]);
  if (!match) throw new DecompositionRecoveryError(`Malformed index entry for ${relativePath}.`);
  return { mode: match[1], blob: match[2] };
}

async function canonicalGitBlobHash(
  projectRoot: string,
  relativePath: string,
  bytes: Buffer,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["hash-object", "-w", `--path=${relativePath}`, "--stdin"],
      { cwd: projectRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error("Git hash-object failed."));
          return;
        }
        const hash = stdout.trim();
        if (!HASH_PATTERN.test(hash)) {
          reject(new DecompositionRecoveryError(`Git returned an invalid blob hash: ${hash}.`));
          return;
        }
        resolve(hash);
      },
    );
    if (!child.stdin) {
      child.kill();
      reject(new DecompositionRecoveryError("Git hash-object stdin is unavailable."));
      return;
    }
    child.stdin.end(bytes);
  });
}

function sameGitEntry(left: GitEntry | null, right: GitEntry | null): boolean {
  return left?.mode === right?.mode && left?.blob === right?.blob;
}

function journalFileName(parentTaskId: string): string {
  if (!TASK_ID_PATTERN.test(parentTaskId)) {
    throw new DecompositionRecoveryError(`Unsafe decomposition parent id: ${parentTaskId}.`);
  }
  return `${JOURNAL_PREFIX}${parentTaskId}${JOURNAL_SUFFIX}`;
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

async function writeJournalAtomic(
  journalPath: string,
  journal: DecompositionTransactionJournal,
): Promise<void> {
  await writeDurableJsonAtomic(journalPath, journal, "Decomposition journal");
}

async function writeDurableJsonAtomic(
  destinationPath: string,
  value: unknown,
  label: string,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf-8");
  if (bytes.length > MAX_JOURNAL_BYTES) {
    throw new DecompositionRecoveryError(
      `${label} exceeds ${MAX_JOURNAL_BYTES} bytes.`,
      destinationPath,
    );
  }
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    try {
      await unlinkDecompositionFileWithRetry(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${label} write and temporary cleanup failed: ${destinationPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await fs.rename(temporaryPath, destinationPath);
    // Windows rejects fsync on a read-only handle even for a regular file.
    // Reopen read/write so the post-rename durability barrier is portable.
    const committed = await fs.open(destinationPath, "r+");
    try {
      await committed.sync();
    } finally {
      await committed.close();
    }
    await flushDirectory(path.dirname(destinationPath));
  } catch (error) {
    try {
      await unlinkDecompositionFileWithRetry(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${label} publication and temporary cleanup failed: ${destinationPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function parseJournal(raw: unknown, journalPath: string): DecompositionTransactionJournal {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "version",
      "parentTaskId",
      "createdAt",
      "phase",
      "baseHead",
      "baseRef",
      "commitSha",
      "parent",
      "children",
    ]) ||
    raw.version !== JOURNAL_VERSION ||
    typeof raw.parentTaskId !== "string" ||
    !TASK_ID_PATTERN.test(raw.parentTaskId) ||
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !["prepared", "parent_written", "children_written", "committing", "committed"].includes(
      String(raw.phase),
    ) ||
    typeof raw.baseHead !== "string" ||
    !HASH_PATTERN.test(raw.baseHead) ||
    (raw.baseRef !== null &&
      (typeof raw.baseRef !== "string" || !isSafeLocalBranchRef(raw.baseRef))) ||
    (raw.commitSha !== null &&
      (typeof raw.commitSha !== "string" || !HASH_PATTERN.test(raw.commitSha))) ||
    !isRecord(raw.parent) ||
    !Array.isArray(raw.children) ||
    raw.children.length < 2 ||
    raw.children.length > 6
  ) {
    throw new DecompositionRecoveryError("Malformed decomposition journal.", journalPath);
  }

  const parent = raw.parent;
  if (
    !hasExactKeys(parent, [
      "relativePath",
      "baseIndex",
      "targetGitBlob",
      "targetMode",
      "original",
      "target",
    ]) ||
    typeof parent.relativePath !== "string" ||
    !isSafeRelativePath(parent.relativePath) ||
    (parent.baseIndex !== null && !isGitEntry(parent.baseIndex)) ||
    typeof parent.targetGitBlob !== "string" ||
    !HASH_PATTERN.test(parent.targetGitBlob) ||
    typeof parent.targetMode !== "string" ||
    !/^\d{6}$/.test(parent.targetMode) ||
    !isEncodedBytes(parent.original) ||
    !isEncodedBytes(parent.target)
  ) {
    throw new DecompositionRecoveryError(
      "Malformed parent entry in decomposition journal.",
      journalPath,
    );
  }

  for (const child of raw.children) {
    if (
      !isRecord(child) ||
      !hasExactKeys(child, [
        "taskId",
        "relativePath",
        "baseIndex",
        "targetGitBlob",
        "targetMode",
        "target",
      ]) ||
      typeof child.taskId !== "string" ||
      !TASK_ID_PATTERN.test(child.taskId) ||
      typeof child.relativePath !== "string" ||
      !isSafeRelativePath(child.relativePath) ||
      (child.baseIndex !== null && !isGitEntry(child.baseIndex)) ||
      typeof child.targetGitBlob !== "string" ||
      !HASH_PATTERN.test(child.targetGitBlob) ||
      typeof child.targetMode !== "string" ||
      !/^\d{6}$/.test(child.targetMode) ||
      !isEncodedBytes(child.target)
    ) {
      throw new DecompositionRecoveryError(
        "Malformed child entry in decomposition journal.",
        journalPath,
      );
    }
  }
  return raw as unknown as DecompositionTransactionJournal;
}

async function readAndValidateJournal(
  adapter: ProjectAdapter,
  journalPath: string,
): Promise<DecompositionTransactionJournal> {
  const expectedJournalDir = await journalDirectory(adapter.projectRoot);
  if (
    path.relative(expectedJournalDir, path.dirname(path.resolve(journalPath))) !== "" ||
    path.relative(path.dirname(path.resolve(journalPath)), expectedJournalDir) !== ""
  ) {
    throw new DecompositionRecoveryError(
      "Decomposition journal path is outside the worktree-specific Git journal directory.",
      journalPath,
    );
  }
  const journalStat = await fs.lstat(journalPath);
  if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1) {
    throw new DecompositionRecoveryError(
      "Decomposition journal must be a single-link regular file.",
      journalPath,
    );
  }
  if (journalStat.size <= 0 || journalStat.size > MAX_JOURNAL_BYTES) {
    throw new DecompositionRecoveryError(
      `Decomposition journal size ${journalStat.size} is outside the allowed range.`,
      journalPath,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  } catch (error) {
    throw new DecompositionRecoveryError(
      `Unreadable decomposition journal: ${error instanceof Error ? error.message : String(error)}`,
      journalPath,
    );
  }
  const journal = parseJournal(raw, journalPath);
  if (path.basename(journalPath) !== journalFileName(journal.parentTaskId)) {
    throw new DecompositionRecoveryError(
      "Decomposition journal filename does not match its parent task id.",
      journalPath,
    );
  }

  const projectRoot = path.resolve(adapter.projectRoot);
  const taskDir = path.resolve(projectRoot, adapter.config.project.taskDir);
  const [realProjectRoot, realTaskDir] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(taskDir),
  ]);
  if (!isPathContainedBy(realProjectRoot, realTaskDir)) {
    throw new DecompositionRecoveryError(
      "Configured task directory resolves outside the project root.",
      journalPath,
    );
  }

  const allEntries: Array<JournalParent | JournalChild> = [journal.parent, ...journal.children];
  const relativePaths = allEntries.map((entry) => entry.relativePath);
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new DecompositionRecoveryError(
      "Journal contains duplicate transaction paths.",
      journalPath,
    );
  }
  for (const entry of allEntries) {
    const absolute = absoluteFromRelative(projectRoot, entry.relativePath);
    if (!isPathContainedBy(taskDir, absolute) || path.dirname(absolute) !== taskDir) {
      throw new DecompositionRecoveryError(
        `Journal path is outside the configured task directory: ${entry.relativePath}.`,
        journalPath,
      );
    }
  }

  const parentOriginal = decodeBytes(journal.parent.original, "parent original");
  const parentTarget = decodeBytes(journal.parent.target, "parent target");
  if (parentOriginal.length + parentTarget.length > MAX_JOURNAL_BYTES) {
    throw new DecompositionRecoveryError("Journal parent payload is too large.", journalPath);
  }
  const parsedOriginal = parseTaskFile(parentOriginal.toString("utf-8"));
  const parsedTarget = parseTaskFile(parentTarget.toString("utf-8"));
  if (
    parsedOriginal.id !== journal.parentTaskId ||
    parsedTarget.id !== journal.parentTaskId ||
    parsedTarget.status !== "DECOMPOSED" ||
    !isParentTaskFileName(journal.parentTaskId, path.basename(journal.parent.relativePath))
  ) {
    throw new DecompositionRecoveryError(
      "Journal parent identity, filename, or target status is invalid.",
      journalPath,
    );
  }

  let decodedSize = parentOriginal.length + parentTarget.length;
  for (let index = 0; index < journal.children.length; index += 1) {
    const child = journal.children[index];
    const expectedId = `${journal.parentTaskId}-${String.fromCharCode(65 + index)}`;
    const target = decodeBytes(child.target, `child ${child.taskId}`);
    decodedSize += target.length;
    const parsed = parseTaskFile(target.toString("utf-8"));
    if (
      child.taskId !== expectedId ||
      parsed.id !== child.taskId ||
      path.basename(child.relativePath) !== buildSubtaskSpecFileName(child.taskId, parsed.title)
    ) {
      throw new DecompositionRecoveryError(
        `Journal child identity or filename is invalid at index ${index}.`,
        journalPath,
      );
    }
  }
  if (decodedSize > MAX_JOURNAL_BYTES) {
    throw new DecompositionRecoveryError("Journal decoded payload is too large.", journalPath);
  }

  for (const entry of allEntries) {
    if (
      (await canonicalGitBlobHash(
        projectRoot,
        entry.relativePath,
        decodeBytes(entry.target, entry.relativePath),
      )) !== entry.targetGitBlob
    ) {
      throw new DecompositionRecoveryError(
        `Journal Git blob hash mismatch for ${entry.relativePath}.`,
        journalPath,
      );
    }
  }
  return journal;
}

async function validateProjectionJournalPayload(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  outboxPath: string,
): Promise<void> {
  const projectRoot = path.resolve(adapter.projectRoot);
  const taskDir = path.resolve(projectRoot, adapter.config.project.taskDir);
  const [realProjectRoot, realTaskDir] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(taskDir),
  ]);
  if (!isPathContainedBy(realProjectRoot, realTaskDir)) {
    throw new DecompositionRecoveryError(
      "Configured task directory resolves outside the project root.",
      outboxPath,
    );
  }

  const entries: Array<JournalParent | JournalChild> = [journal.parent, ...journal.children];
  const relativePaths = entries.map((entry) => entry.relativePath);
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new DecompositionRecoveryError(
      "Status projection contains duplicate transaction paths.",
      outboxPath,
    );
  }
  for (const entry of entries) {
    const absolute = absoluteFromRelative(projectRoot, entry.relativePath);
    if (!isPathContainedBy(taskDir, absolute) || path.dirname(absolute) !== taskDir) {
      throw new DecompositionRecoveryError(
        `Status projection path is outside the configured task directory: ${entry.relativePath}.`,
        outboxPath,
      );
    }
    if (
      (await canonicalGitBlobHash(
        projectRoot,
        entry.relativePath,
        decodeBytes(entry.target, entry.relativePath),
      )) !== entry.targetGitBlob
    ) {
      throw new DecompositionRecoveryError(
        `Status projection Git blob hash mismatch for ${entry.relativePath}.`,
        outboxPath,
      );
    }
  }

  const parentTarget = decodeBytes(journal.parent.target, "status projection parent target");
  const parsedParent = parseTaskFile(parentTarget.toString("utf-8"));
  if (
    parsedParent.id !== journal.parentTaskId ||
    parsedParent.status !== "DECOMPOSED" ||
    !isParentTaskFileName(journal.parentTaskId, path.basename(journal.parent.relativePath))
  ) {
    throw new DecompositionRecoveryError(
      "Status projection parent identity, filename, or target status is invalid.",
      outboxPath,
    );
  }
  for (let index = 0; index < journal.children.length; index += 1) {
    const child = journal.children[index];
    const expectedId = `${journal.parentTaskId}-${String.fromCharCode(65 + index)}`;
    const parsedChild = parseTaskFile(
      decodeBytes(child.target, `status projection child ${child.taskId}`).toString("utf-8"),
    );
    if (
      child.taskId !== expectedId ||
      parsedChild.id !== child.taskId ||
      path.basename(child.relativePath) !==
        buildSubtaskSpecFileName(child.taskId, parsedChild.title)
    ) {
      throw new DecompositionRecoveryError(
        `Status projection child identity or filename is invalid at index ${index}.`,
        outboxPath,
      );
    }
  }
}

function statusProjectionId(journal: DecompositionTransactionJournal): string {
  if (journal.phase !== "committed" || !journal.commitSha) {
    throw new DecompositionRecoveryError(
      `Cannot publish a status projection for an uncommitted decomposition of ${journal.parentTaskId}.`,
    );
  }
  return sha256(Buffer.from(JSON.stringify(journal), "utf-8"));
}

function statusProjectionFileName(projectionId: string): string {
  if (!SHA256_PATTERN.test(projectionId)) {
    throw new DecompositionRecoveryError(
      `Unsafe decomposition status projection id: ${projectionId}.`,
    );
  }
  return `${STATUS_PROJECTION_PREFIX}${projectionId}${STATUS_PROJECTION_SUFFIX}`;
}

function statusProjectionSource(projectionId: string): string {
  return `decomposition:${projectionId}`;
}

function projectionEvidence(
  outbox: DecompositionStatusProjectionOutbox,
): DecompositionStatusProjection {
  if (!outbox.journal.commitSha) {
    throw new DecompositionRecoveryError(
      `Status projection ${outbox.projectionId} has no committed transaction SHA.`,
    );
  }
  return {
    projectionId: outbox.projectionId,
    parentTaskId: outbox.journal.parentTaskId,
    commitSha: outbox.journal.commitSha,
    status: "DECOMPOSED",
    createdAt: outbox.createdAt,
    source: statusProjectionSource(outbox.projectionId),
  };
}

async function readAndValidateStatusProjection(
  adapter: ProjectAdapter,
  outboxPath: string,
): Promise<DecompositionStatusProjectionOutbox> {
  const expectedDirectory = await journalDirectory(adapter.projectRoot);
  if (
    path.relative(expectedDirectory, path.dirname(path.resolve(outboxPath))) !== "" ||
    path.relative(path.dirname(path.resolve(outboxPath)), expectedDirectory) !== ""
  ) {
    throw new DecompositionRecoveryError(
      "Decomposition status projection path is outside the worktree-specific Git journal directory.",
      outboxPath,
    );
  }
  const stat = await fs.lstat(outboxPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new DecompositionRecoveryError(
      "Decomposition status projection must be a single-link regular file.",
      outboxPath,
    );
  }
  if (stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
    throw new DecompositionRecoveryError(
      `Decomposition status projection size ${stat.size} is outside the allowed range.`,
      outboxPath,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(outboxPath, "utf-8"));
  } catch (error) {
    throw new DecompositionRecoveryError(
      `Unreadable decomposition status projection: ${error instanceof Error ? error.message : String(error)}`,
      outboxPath,
    );
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["version", "projectionId", "createdAt", "status", "journal"]) ||
    raw.version !== STATUS_PROJECTION_VERSION ||
    typeof raw.projectionId !== "string" ||
    !SHA256_PATTERN.test(raw.projectionId) ||
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    raw.status !== "DECOMPOSED"
  ) {
    throw new DecompositionRecoveryError("Malformed decomposition status projection.", outboxPath);
  }
  const journal = parseJournal(raw.journal, outboxPath);
  await validateProjectionJournalPayload(adapter, journal, outboxPath);
  const outbox = raw as unknown as DecompositionStatusProjectionOutbox;
  if (
    journal.phase !== "committed" ||
    journal.commitSha === null ||
    outbox.createdAt !== journal.createdAt ||
    outbox.projectionId !== statusProjectionId(journal) ||
    path.basename(outboxPath) !== statusProjectionFileName(outbox.projectionId)
  ) {
    throw new DecompositionRecoveryError(
      "Decomposition status projection is not bound to its exact committed transaction.",
      outboxPath,
    );
  }
  return { ...outbox, journal };
}

async function ensureStatusProjectionOutbox(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
): Promise<DecompositionStatusProjection> {
  const projectionId = statusProjectionId(journal);
  const journalDir = await journalDirectory(adapter.projectRoot, true);
  const outboxPath = path.join(journalDir, statusProjectionFileName(projectionId));
  const outbox: DecompositionStatusProjectionOutbox = {
    version: STATUS_PROJECTION_VERSION,
    projectionId,
    createdAt: journal.createdAt,
    status: "DECOMPOSED",
    journal,
  };
  try {
    const existing = await readAndValidateStatusProjection(adapter, outboxPath);
    if (existing.projectionId !== projectionId) {
      throw new DecompositionRecoveryError(
        "Existing decomposition status projection does not match the committed transaction.",
        outboxPath,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeDurableJsonAtomic(outboxPath, outbox, "Decomposition status projection outbox");
  }
  return projectionEvidence(outbox);
}

async function listPendingStatusProjectionPaths(adapter: ProjectAdapter): Promise<string[]> {
  let journalDir: string;
  try {
    journalDir = await journalDirectory(adapter.projectRoot);
  } catch (error) {
    if ((await gitOrNull(adapter.projectRoot, ["rev-parse", "--is-inside-work-tree"])) === "true") {
      throw error;
    }
    return [];
  }
  let names: string[];
  try {
    names = await fs.readdir(journalDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(
      (name) =>
        name.startsWith(STATUS_PROJECTION_PREFIX) && name.endsWith(STATUS_PROJECTION_SUFFIX),
    )
    .sort()
    .map((name) => path.join(journalDir, name));
}

async function readWorktreeHash(
  absolutePath: string,
  allowAdditionalHardLinks = false,
): Promise<string | null> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (!allowAdditionalHardLinks && stat.nlink !== 1)
    ) {
      throw new DecompositionRecoveryError(
        `Transaction path is not a single-link regular file: ${absolutePath}.`,
      );
    }
    return sha256(await fs.readFile(absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listDecompositionTemporaryPaths(destination: string): Promise<string[]> {
  const directory = path.dirname(destination);
  const baseName = path.basename(decompositionTemporaryPath(destination));
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => {
      if (name === baseName) return true;
      if (name.startsWith(`${baseName}-`)) {
        return /^\d+-[0-9a-f-]{36}(?:\.cleanup-\d+-[0-9a-f-]{36})*$/.test(
          name.slice(baseName.length + 1),
        );
      }
      if (name.startsWith(`${baseName}.cleanup-`)) {
        return /^(?:\.cleanup-\d+-[0-9a-f-]{36})+$/.test(name.slice(baseName.length));
      }
      return false;
    })
    .sort()
    .map((name) => path.join(directory, name));
}

async function validateTransactionTemporaryFiles(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
): Promise<{
  temporaryPaths: Array<{ filePath: string; dev: number; ino: number }>;
  linkedPublishedPaths: Set<string>;
}> {
  const projectRoot = path.resolve(adapter.projectRoot);
  const temporaryPaths: Array<{ filePath: string; dev: number; ino: number }> = [];
  const linkedPublishedPaths = new Set<string>();
  for (const entry of [journal.parent, ...journal.children]) {
    const destination = absoluteFromRelative(projectRoot, entry.relativePath);
    const candidatePaths = await listDecompositionTemporaryPaths(destination);
    const candidateStats = await Promise.all(
      candidatePaths.map(async (temporaryPath) => ({
        temporaryPath,
        stat: await fs.lstat(temporaryPath),
      })),
    );
    for (const { temporaryPath, stat: temporaryStat } of candidateStats) {
      if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
        throw new DecompositionRecoveryError(
          `Transaction temporary path is not a regular file: ${temporaryPath}.`,
        );
      }
      const isParent = entry === journal.parent;
      const destinationStat = await lstatOrNull(destination);
      const hasCleanupPeer = candidateStats.some(
        (candidate) =>
          candidate.temporaryPath !== temporaryPath &&
          candidate.stat.dev === temporaryStat.dev &&
          candidate.stat.ino === temporaryStat.ino &&
          candidate.stat.nlink === 2,
      );
      if (isParent) {
        if (
          destinationStat &&
          !destinationStat.isSymbolicLink() &&
          destinationStat.isFile() &&
          destinationStat.dev === temporaryStat.dev &&
          destinationStat.ino === temporaryStat.ino &&
          destinationStat.nlink === 2 &&
          temporaryStat.nlink === 2
        ) {
          linkedPublishedPaths.add(entry.relativePath);
        } else if (temporaryStat.nlink !== 1 && !(destinationStat === null && hasCleanupPeer)) {
          throw new DecompositionRecoveryError(
            `Parent transaction temporary file has unexpected link count: ${temporaryPath}.`,
          );
        }
      } else if (destinationStat) {
        if (
          destinationStat.isSymbolicLink() ||
          !destinationStat.isFile() ||
          destinationStat.dev !== temporaryStat.dev ||
          destinationStat.ino !== temporaryStat.ino ||
          destinationStat.nlink !== 2 ||
          temporaryStat.nlink !== 2
        ) {
          throw new DecompositionRecoveryError(
            `Child destination and transaction temporary file do not form the exact atomic-publish link pair for ${entry.relativePath}; journal retained.`,
          );
        }
        linkedPublishedPaths.add(entry.relativePath);
      } else if (temporaryStat.nlink !== 1 && !hasCleanupPeer) {
        throw new DecompositionRecoveryError(
          `Unpublished child transaction temporary file has unexpected link count: ${temporaryPath}.`,
        );
      }

      const temporaryHash = await readWorktreeHash(temporaryPath, true);
      if (temporaryHash !== entry.target.sha256) {
        throw new DecompositionRecoveryError(
          `Transaction temporary bytes diverged for ${entry.relativePath}; journal retained.`,
        );
      }
      temporaryPaths.push({
        filePath: temporaryPath,
        dev: temporaryStat.dev,
        ino: temporaryStat.ino,
      });
    }
  }
  return { temporaryPaths, linkedPublishedPaths };
}

async function removeTransactionTemporaryFiles(
  temporaryPaths: ReadonlyArray<{ filePath: string; dev: number; ino: number }>,
): Promise<void> {
  const directories = new Set<string>();
  for (const temporary of temporaryPaths) {
    const quarantinePath = `${temporary.filePath}.cleanup-${process.pid}-${randomUUID()}`;
    await fs.rename(temporary.filePath, quarantinePath);
    const quarantineStat = await fs.lstat(quarantinePath);
    if (
      quarantineStat.isSymbolicLink() ||
      !quarantineStat.isFile() ||
      quarantineStat.dev !== temporary.dev ||
      quarantineStat.ino !== temporary.ino
    ) {
      try {
        await fs.link(quarantinePath, temporary.filePath);
        await unlinkDecompositionFileWithRetry(quarantinePath);
      } catch (restoreError) {
        throw new DecompositionRecoveryError(
          `Transaction temporary path changed during cleanup and could not be restored: ${temporary.filePath}.`,
          undefined,
          {
            restoreError:
              restoreError instanceof Error ? restoreError.message : String(restoreError),
          },
        );
      }
      throw new DecompositionRecoveryError(
        `Transaction temporary path changed during cleanup: ${temporary.filePath}.`,
      );
    }
    await unlinkDecompositionFileWithRetry(quarantinePath);
    directories.add(path.dirname(temporary.filePath));
  }
  for (const directory of directories) await flushDirectory(directory);
}

interface ReplacementBackupState {
  filePath: string;
  hash: string;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
}

async function validateParentReplacementBackup(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
): Promise<ReplacementBackupState | undefined> {
  const parentPath = absoluteFromRelative(
    path.resolve(adapter.projectRoot),
    journal.parent.relativePath,
  );
  const backupPaths = await listDecompositionReplacementBackupPaths(parentPath);
  if (backupPaths.length > 1) {
    throw new DecompositionRecoveryError(
      `Multiple parent replacement backup artifacts exist for ${journal.parent.relativePath}; journal retained.`,
    );
  }
  const backupPath = backupPaths[0] ?? decompositionReplacementBackupPath(parentPath);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(backupPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || ![1n, 2n].includes(stat.nlink)) {
    throw new DecompositionRecoveryError(
      `Parent replacement backup is not a single-link regular file: ${backupPath}.`,
    );
  }
  const hash = await readWorktreeHash(backupPath, true);
  if (hash !== journal.parent.original.sha256 && hash !== journal.parent.target.sha256) {
    throw new DecompositionRecoveryError(
      `Parent replacement backup bytes diverged for ${journal.parent.relativePath}; journal retained.`,
    );
  }
  if (stat.nlink === 2n) {
    const parentPath = absoluteFromRelative(
      path.resolve(adapter.projectRoot),
      journal.parent.relativePath,
    );
    const parentStat = await fs.lstat(parentPath, { bigint: true });
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isFile() ||
      parentStat.nlink !== 2n ||
      parentStat.dev !== stat.dev ||
      parentStat.ino !== stat.ino
    ) {
      throw new DecompositionRecoveryError(
        `Parent replacement backup has an unowned second link: ${backupPath}; journal retained.`,
      );
    }
  }
  return { filePath: backupPath, hash, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

async function removeExactTransactionFile(
  filePath: string,
  expectedHash: string,
  label: string,
): Promise<boolean> {
  let initial: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    initial = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1n) {
    throw new DecompositionRecoveryError(
      `${label} is not a single-link regular file: ${filePath}; journal retained.`,
    );
  }
  if (sha256(await fs.readFile(filePath)) !== expectedHash) {
    throw new DecompositionRecoveryError(`${label} bytes diverged: ${filePath}; journal retained.`);
  }

  const quarantinePath = filePath.includes(".quack-decompose-backup")
    ? `${filePath}.cleanup-${process.pid}-${randomUUID()}`
    : `${decompositionTemporaryPath(filePath)}-${process.pid}-${randomUUID()}.cleanup-${process.pid}-${randomUUID()}`;
  await fs.rename(filePath, quarantinePath);
  await flushDirectory(path.dirname(filePath));
  let quarantine: Awaited<ReturnType<typeof fs.lstat>>;
  let quarantineHash: string;
  try {
    quarantine = await fs.lstat(quarantinePath, { bigint: true });
    quarantineHash = sha256(await fs.readFile(quarantinePath));
  } catch (error) {
    throw new DecompositionRecoveryError(
      `${label} disappeared during identity-bound cleanup: ${filePath}; journal retained.`,
      undefined,
      { cleanupError: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    quarantine.isSymbolicLink() ||
    !quarantine.isFile() ||
    quarantine.nlink !== 1n ||
    quarantine.dev !== initial.dev ||
    quarantine.ino !== initial.ino ||
    quarantineHash !== expectedHash
  ) {
    try {
      await fs.link(quarantinePath, filePath);
      await unlinkDecompositionFileWithRetry(quarantinePath);
      await flushDirectory(path.dirname(filePath));
    } catch (restoreError) {
      throw new DecompositionRecoveryError(
        `${label} changed during cleanup and could not be restored: ${filePath}; journal retained.`,
        undefined,
        {
          restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
        },
      );
    }
    throw new DecompositionRecoveryError(
      `${label} changed during identity-bound cleanup: ${filePath}; journal retained.`,
    );
  }
  await unlinkDecompositionFileWithRetry(quarantinePath);
  await flushDirectory(path.dirname(filePath));
  return true;
}

async function removeValidatedReplacementBackup(
  backup: ReplacementBackupState,
  parentPath: string,
): Promise<void> {
  if (backup.nlink === 1n) {
    await removeExactTransactionFile(backup.filePath, backup.hash, "Parent replacement backup");
    return;
  }
  const quarantinePath = `${backup.filePath}.cleanup-${process.pid}-${randomUUID()}`;
  await fs.rename(backup.filePath, quarantinePath);
  await flushDirectory(path.dirname(parentPath));
  const [quarantine, parent, quarantineHash] = await Promise.all([
    fs.lstat(quarantinePath, { bigint: true }),
    fs.lstat(parentPath, { bigint: true }),
    fs.readFile(quarantinePath).then(sha256),
  ]);
  if (
    quarantine.isSymbolicLink() ||
    !quarantine.isFile() ||
    quarantine.nlink !== 2n ||
    quarantine.dev !== backup.dev ||
    quarantine.ino !== backup.ino ||
    parent.dev !== backup.dev ||
    parent.ino !== backup.ino ||
    quarantineHash !== backup.hash
  ) {
    try {
      await fs.link(quarantinePath, backup.filePath);
      await unlinkDecompositionFileWithRetry(quarantinePath);
      await flushDirectory(path.dirname(parentPath));
    } catch (restoreError) {
      throw new DecompositionRecoveryError(
        `Parent replacement backup changed and could not be restored: ${backup.filePath}.`,
        undefined,
        {
          restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
        },
      );
    }
    throw new DecompositionRecoveryError(
      `Parent replacement backup changed during cleanup: ${backup.filePath}; journal retained.`,
    );
  }
  await unlinkDecompositionFileWithRetry(quarantinePath);
  await flushDirectory(path.dirname(parentPath));
}

async function reconcileParentReplacementBackup(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  committed: boolean,
  backup: ReplacementBackupState | undefined,
): Promise<void> {
  if (!backup) return;
  const parentPath = absoluteFromRelative(
    path.resolve(adapter.projectRoot),
    journal.parent.relativePath,
  );
  const desired = committed ? journal.parent.target : journal.parent.original;
  const alternate = committed ? journal.parent.original : journal.parent.target;
  const currentHash = await readWorktreeHash(parentPath, backup.nlink === 2n);

  if (currentHash === null) {
    // Recreate from the journal through a fresh inode so the backup remains a
    // single-link, identity-checkable recovery artifact until publication is
    // durable.
    await writeDecompositionFileAtomicExclusive(parentPath, decodeBytes(desired, "parent"));
  } else if (currentHash === alternate.sha256) {
    // Remove the known transaction backup before asking the CAS writer to
    // claim the current pathname. A crash here is safe: the journal still
    // identifies the exact alternate bytes on the canonical path.
    await removeValidatedReplacementBackup(backup, parentPath);
    await writeDecompositionFileAtomicReplace(
      parentPath,
      decodeBytes(desired, "parent"),
      decodeBytes(alternate, "parent alternate"),
    );
    return;
  } else if (currentHash !== desired.sha256) {
    throw new DecompositionRecoveryError(
      `Parent bytes diverged while reconciling replacement backup for ${journal.parent.relativePath}; journal retained.`,
    );
  }

  await removeValidatedReplacementBackup(backup, parentPath);
}

async function headEntry(
  projectRoot: string,
  ref: string,
  relativePath: string,
  readGit: DecompositionGitReader = git,
): Promise<GitEntry | null> {
  const output = await readGit(projectRoot, ["ls-tree", ref, "--", relativePath]);
  if (!output) return null;
  const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t/.exec(output);
  if (!match) throw new DecompositionRecoveryError(`Malformed Git tree entry for ${relativePath}.`);
  return { mode: match[1], blob: match[2] };
}

async function isCommittedTransaction(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  currentHead: string,
  readGit: DecompositionGitReader = git,
): Promise<boolean> {
  if (currentHead === journal.baseHead) return false;
  const transactionCommit = journal.commitSha ?? currentHead;
  if (journal.commitSha) {
    let mergeBase: string;
    try {
      // A value-bearing merge-base proves ancestry without treating a failed
      // Git probe as the same thing as a negative relation.
      mergeBase = await readGit(adapter.projectRoot, [
        "merge-base",
        journal.commitSha,
        currentHead,
      ]);
    } catch (error) {
      // Exit 1 is Git's documented "no merge base" result: that is a
      // confirmed unrelated tip. Spawn/transport failures remain unknown.
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
    if (mergeBase !== journal.commitSha) return false;
  }
  const parentHead = await readGit(adapter.projectRoot, ["rev-parse", `${transactionCommit}^`]);
  if (parentHead !== journal.baseHead) return false;
  const changed = (
    await readGit(adapter.projectRoot, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-z",
      "-r",
      transactionCommit,
    ])
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const expected = [
    journal.parent.relativePath,
    ...journal.children.map((child) => child.relativePath),
  ].sort();
  if (
    changed.length !== expected.length ||
    changed.some((entry, index) => entry !== expected[index])
  ) {
    return false;
  }
  for (const entry of [journal.parent, ...journal.children]) {
    const committed = await headEntry(
      adapter.projectRoot,
      transactionCommit,
      entry.relativePath,
      readGit,
    );
    if (committed?.blob !== entry.targetGitBlob || committed.mode !== entry.targetMode)
      return false;
  }
  return true;
}

async function observeDecompositionRefPublication(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  readGit: DecompositionGitReader = git,
): Promise<DecompositionRefPublicationObservation> {
  try {
    const [currentHead, currentRef] = await Promise.all([
      readGit(adapter.projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      currentHeadRef(adapter.projectRoot, readGit),
    ]);

    // A symbolic-ref change cannot prove whether the original ref was updated
    // before the checkout moved. Retain the journal and forbid a retry rather
    // than guessing either direction.
    if (currentRef !== journal.baseRef) {
      return {
        state: "unknown",
        error: new DecompositionRecoveryError(
          `Git HEAD symbolic identity changed while observing the decomposition ref (${journal.baseRef ?? "detached"} -> ${currentRef ?? "detached"}).`,
        ),
      };
    }

    if (currentHead === journal.baseHead) {
      return { state: "confirmed_not_committed", currentHead };
    }
    return (await isCommittedTransaction(adapter, journal, currentHead, readGit))
      ? { state: "confirmed_committed", currentHead }
      : { state: "confirmed_not_committed", currentHead };
  } catch (error) {
    return { state: "unknown", error };
  }
}

export async function assertCommittedDecompositionTransaction(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
): Promise<void> {
  const [currentHead, currentRef] = await Promise.all([
    git(adapter.projectRoot, ["rev-parse", "HEAD"]),
    currentHeadRef(adapter.projectRoot),
  ]);
  if (
    currentRef !== journal.baseRef ||
    !(await isCommittedTransaction(adapter, journal, currentHead))
  ) {
    throw new DecompositionRecoveryError(
      "Git reported a decomposition commit, but HEAD does not exactly match the journal transaction; journal retained.",
      undefined,
      {
        baseHead: journal.baseHead,
        baseRef: journal.baseRef,
        currentHead,
        currentRef,
        committedVerificationMismatch: true,
      },
    );
  }
}

async function validateIndexForRecovery(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  allowTarget: boolean,
): Promise<{ basePaths: string[]; targetPaths: string[] }> {
  const basePaths: string[] = [];
  const targetPaths: string[] = [];
  for (const entry of [journal.parent, ...journal.children]) {
    const current = await readIndexEntry(adapter.projectRoot, entry.relativePath);
    if (sameGitEntry(current, entry.baseIndex)) {
      basePaths.push(entry.relativePath);
      continue;
    }
    const target = { mode: entry.targetMode, blob: entry.targetGitBlob };
    if (allowTarget && sameGitEntry(current, target)) {
      targetPaths.push(entry.relativePath);
      continue;
    }
    throw new DecompositionRecoveryError(
      `Index entry diverged for ${entry.relativePath}; recovery left all bytes untouched.`,
      undefined,
      { relativePath: entry.relativePath, current, base: entry.baseIndex, target },
    );
  }
  return { basePaths, targetPaths };
}

async function validateWorktreeForRecovery(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  committed: boolean,
  linkedPublishedPaths: ReadonlySet<string> = new Set<string>(),
  parentReplacementBackup?: ReplacementBackupState,
): Promise<void> {
  const projectRoot = path.resolve(adapter.projectRoot);
  const parentPath = absoluteFromRelative(projectRoot, journal.parent.relativePath);
  const parentHash = await readWorktreeHash(
    parentPath,
    linkedPublishedPaths.has(journal.parent.relativePath) || parentReplacementBackup?.nlink === 2n,
  );
  if (
    parentHash !== journal.parent.original.sha256 &&
    parentHash !== journal.parent.target.sha256 &&
    !(parentHash === null && (committed || parentReplacementBackup))
  ) {
    throw new DecompositionRecoveryError(
      `Parent bytes diverged at ${journal.parent.relativePath}; recovery left all bytes untouched.`,
    );
  }
  for (const child of journal.children) {
    const childHash = await readWorktreeHash(
      absoluteFromRelative(projectRoot, child.relativePath),
      linkedPublishedPaths.has(child.relativePath),
    );
    if (childHash !== null && childHash !== child.target.sha256) {
      throw new DecompositionRecoveryError(
        `Child bytes diverged at ${child.relativePath}; recovery left all bytes untouched.`,
      );
    }
  }
}

async function removeJournal(journalPath: string): Promise<void> {
  await fs.unlink(journalPath);
  await flushDirectory(path.dirname(journalPath));
}

export async function createDecompositionTransactionJournal(input: {
  adapter: ProjectAdapter;
  parentTaskId: string;
  parentFilePath: string;
  parentOriginalContent: string;
  parentTargetContent: string;
  plannedWrites: PlannedSubtaskSpecWrite[];
}): Promise<{ journal: DecompositionTransactionJournal; journalPath: string }> {
  const projectRoot = path.resolve(input.adapter.projectRoot);
  const journalDir = await journalDirectory(projectRoot, true);
  const journalPath = path.join(journalDir, journalFileName(input.parentTaskId));
  const gitIndexPath = await resolveGitIndexPath(projectRoot);
  const indexArtifacts = [
    `${gitIndexPath}.lock`,
    transactionIndexCandidatePath(journalDir, input.parentTaskId),
    `${transactionIndexCandidatePath(journalDir, input.parentTaskId)}.lock`,
  ];
  for (const indexArtifact of indexArtifacts) {
    try {
      await fs.lstat(indexArtifact);
      throw new DecompositionRecoveryError(
        `Git index transaction artifact already exists: ${indexArtifact}; recover it before decomposition.`,
        journalPath,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await fs.lstat(journalPath);
    throw new DecompositionRecoveryError(
      `Pending decomposition journal already exists for ${input.parentTaskId}; recover it first.`,
      journalPath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const baseRef = await currentHeadRef(projectRoot);
  const baseHead = await git(projectRoot, ["rev-parse", "HEAD"]);
  if ((await currentHeadRef(projectRoot)) !== baseRef) {
    throw new DecompositionRecoveryError(
      "Git HEAD symbolic identity changed while preparing decomposition; no journal was written.",
      journalPath,
    );
  }
  if (baseRef && (await git(projectRoot, ["rev-parse", baseRef])) !== baseHead) {
    throw new DecompositionRecoveryError(
      "Git HEAD branch moved while preparing decomposition; no journal was written.",
      journalPath,
    );
  }
  const parentRelative = path.relative(projectRoot, input.parentFilePath).replace(/\\/g, "/");
  for (const destination of [
    input.parentFilePath,
    ...input.plannedWrites.map((item) => item.filePath),
  ]) {
    const temporaryPaths = await listDecompositionTemporaryPaths(destination);
    if (temporaryPaths.length > 0) {
      throw new DecompositionRecoveryError(
        `Decomposition transaction temporary destination already exists: ${temporaryPaths
          .map((temporaryPath) => path.relative(projectRoot, temporaryPath).replace(/\\/g, "/"))
          .join(", ")}.`,
        journalPath,
      );
    }
    const backupPaths = await listDecompositionReplacementBackupPaths(destination);
    if (backupPaths.length > 0) {
      throw new DecompositionRecoveryError(
        `Decomposition replacement backup already exists: ${backupPaths.join(", ")}.`,
        journalPath,
      );
    }
  }
  const parentOriginal = encodeBytes(input.parentOriginalContent);
  const parentTarget = encodeBytes(input.parentTargetContent);
  const parentBaseIndex = await readIndexEntry(projectRoot, parentRelative);
  const parentHead = await headEntry(projectRoot, baseHead, parentRelative);
  if (!sameGitEntry(parentBaseIndex, parentHead)) {
    throw new DecompositionRecoveryError(
      "The decomposition parent index does not match base HEAD.",
      journalPath,
    );
  }

  const children: JournalChild[] = [];
  for (const planned of input.plannedWrites) {
    const relativePath = path.relative(projectRoot, planned.filePath).replace(/\\/g, "/");
    const target = encodeBytes(planned.draft.markdown);
    const baseIndex = await readIndexEntry(projectRoot, relativePath);
    const baseTreeEntry = await headEntry(projectRoot, baseHead, relativePath);
    if (baseIndex || baseTreeEntry) {
      throw new DecompositionRecoveryError(
        `Child transaction path is already tracked: ${relativePath}.`,
        journalPath,
      );
    }
    try {
      await fs.lstat(planned.filePath);
      throw new DecompositionRecoveryError(
        `Child worktree destination already exists: ${relativePath}.`,
        journalPath,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    children.push({
      taskId: planned.declaredId,
      relativePath,
      baseIndex,
      targetGitBlob: await canonicalGitBlobHash(
        projectRoot,
        relativePath,
        Buffer.from(planned.draft.markdown, "utf-8"),
      ),
      targetMode: "100644",
      target,
    });
  }

  const journal: DecompositionTransactionJournal = {
    version: JOURNAL_VERSION,
    parentTaskId: input.parentTaskId,
    createdAt: new Date().toISOString(),
    phase: "prepared",
    baseHead,
    baseRef,
    commitSha: null,
    parent: {
      relativePath: parentRelative,
      baseIndex: parentBaseIndex,
      targetGitBlob: await canonicalGitBlobHash(
        projectRoot,
        parentRelative,
        Buffer.from(input.parentTargetContent, "utf-8"),
      ),
      targetMode: parentBaseIndex?.mode ?? "100644",
      original: parentOriginal,
      target: parentTarget,
    },
    children,
  };
  // Validate the exact object we are about to persist, including identity and
  // filename derivation, before the first mutation.
  parseJournal(journal, journalPath);
  await writeJournalAtomic(journalPath, journal);
  return { journal, journalPath };
}

export async function updateDecompositionTransactionJournal(
  journalPath: string,
  journal: DecompositionTransactionJournal,
  phase: DecompositionTransactionPhase,
): Promise<void> {
  journal.phase = phase;
  await writeJournalAtomic(journalPath, journal);
}

export async function assertDecompositionCommitBaseline(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
): Promise<void> {
  await assertJournalHeadIdentity(adapter.projectRoot, journal);
  await validateIndexForRecovery(adapter, journal, false);
}

export interface DecompositionCommitResult {
  committed: boolean;
  sha: string;
  staged: string[];
  /** Non-fatal diagnostics from deterministic reconciliation after ref publication. */
  warnings?: string[];
  /** True when post-CAS recovery already consumed the durable journal. */
  journalReconciled?: boolean;
  /**
   * The Git transaction is committed and must not be retried, but durable
   * journal recovery and/or its authoritative status projection still needs
   * to converge before scheduling is admitted.
   */
  recoveryPending?: boolean;
  /** Exact durable projection identity when recovery reached the outbox stage. */
  statusProjectionId?: string;
}

export type DecompositionPostCommitStep =
  | "ref_updated"
  | "commit_verified"
  | "index_published"
  | "index_directory_flushed"
  | "index_lock_removed"
  | "journal_directory_flushed";

export interface DecompositionCommitOptions {
  beforeRefUpdate?: () => void | Promise<void>;
  afterIndexLock?: () => void | Promise<void>;
  afterRefUpdate?: () => void | Promise<void>;
  afterIndexPublish?: () => void | Promise<void>;
  /** Narrow fault-injection hook for an update-ref process that fails after publishing the ref. */
  executeRefUpdate?: (projectRoot: string, args: readonly string[]) => void | Promise<void>;
  /** Narrow fault-injection hook for the read-only probe after an ambiguous update-ref failure. */
  readRefPublicationGit?: DecompositionGitReader;
  /** Narrow fault-injection/diagnostic hook at each irreversible post-CAS boundary. */
  afterPostCommitStep?: (step: DecompositionPostCommitStep) => void | Promise<void>;
}

interface IndexRecord {
  mode: string;
  blob: string;
  stage: string;
  path: string;
}

async function resolveGitIndexPath(projectRoot: string): Promise<string> {
  const raw = await git(projectRoot, ["rev-parse", "--git-path", "index"]);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
}

function transactionIndexCandidatePath(journalDir: string, parentTaskId: string): string {
  return path.join(journalDir, `.real-index-${parentTaskId}`);
}

type DecompositionRefPublicationObservation =
  | { state: "confirmed_committed"; currentHead: string }
  | { state: "confirmed_not_committed"; currentHead: string }
  | { state: "unknown"; error: unknown };

async function readIndexRecords(projectRoot: string, indexPath?: string): Promise<IndexRecord[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--stage", "-z"], {
    cwd: projectRoot,
    env: indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) throw new DecompositionRecoveryError("Malformed Git index record.");
      return { mode: match[1], blob: match[2], stage: match[3], path: match[4] };
    });
}

function expectedTransactionIndexRecords(
  base: readonly IndexRecord[],
  journal: DecompositionTransactionJournal,
): IndexRecord[] {
  const targets = new Map(
    [journal.parent, ...journal.children].map((entry) => [
      entry.relativePath,
      { mode: entry.targetMode, blob: entry.targetGitBlob, stage: "0", path: entry.relativePath },
    ]),
  );
  return [...base.filter((record) => !targets.has(record.path)), ...targets.values()].sort(
    (left, right) => `${left.path}\0${left.stage}`.localeCompare(`${right.path}\0${right.stage}`),
  );
}

function sameIndexRecords(left: readonly IndexRecord[], right: readonly IndexRecord[]): boolean {
  const normalize = (records: readonly IndexRecord[]) =>
    [...records]
      .sort((a, b) => `${a.path}\0${a.stage}`.localeCompare(`${b.path}\0${b.stage}`))
      .map((record) => `${record.mode} ${record.blob} ${record.stage}\t${record.path}`);
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((record, index) => record === b[index]);
}

function expectedTransactionBaseIndexRecords(
  current: readonly IndexRecord[],
  journal: DecompositionTransactionJournal,
): IndexRecord[] {
  const transactionPaths = new Set(
    [journal.parent, ...journal.children].map((entry) => entry.relativePath),
  );
  const baseRecords = [journal.parent, ...journal.children]
    .filter((entry) => entry.baseIndex !== null)
    .map((entry) => ({
      mode: entry.baseIndex!.mode,
      blob: entry.baseIndex!.blob,
      stage: "0",
      path: entry.relativePath,
    }));
  return [...current.filter((record) => !transactionPaths.has(record.path)), ...baseRecords].sort(
    (left, right) => `${left.path}\0${left.stage}`.localeCompare(`${right.path}\0${right.stage}`),
  );
}

function assertTransactionIndexBaseline(
  records: readonly IndexRecord[],
  journal: DecompositionTransactionJournal,
): void {
  if (!sameIndexRecords(records, expectedTransactionBaseIndexRecords(records, journal))) {
    throw new DecompositionRecoveryError(
      "A decomposition transaction path changed in the Git index; journal retained.",
    );
  }
}

async function acquireGitIndexSnapshotLock(indexPath: string): Promise<string> {
  const lockPath = `${indexPath}.lock`;
  const before = await fs.lstat(indexPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new DecompositionRecoveryError(
      "Git index is not a single-link regular file; refusing decomposition commit.",
    );
  }
  await fs.link(indexPath, lockPath);
  await flushDirectory(path.dirname(indexPath));
  try {
    const [current, lock] = await Promise.all([
      fs.lstat(indexPath, { bigint: true }),
      fs.lstat(lockPath, { bigint: true }),
    ]);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      lock.isSymbolicLink() ||
      !lock.isFile() ||
      current.dev !== lock.dev ||
      current.ino !== lock.ino ||
      current.nlink !== 2n ||
      lock.nlink !== 2n
    ) {
      throw new DecompositionRecoveryError(
        "Git index changed while acquiring the decomposition index lock.",
      );
    }
    return lockPath;
  } catch (error) {
    await unlinkDecompositionFileWithRetry(lockPath).catch(() => undefined);
    throw error;
  }
}

async function assertIndexStillMatchesLock(indexPath: string, lockPath: string): Promise<void> {
  const [current, lock] = await Promise.all([
    fs.lstat(indexPath, { bigint: true }),
    fs.lstat(lockPath, { bigint: true }),
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    lock.isSymbolicLink() ||
    !lock.isFile() ||
    current.dev !== lock.dev ||
    current.ino !== lock.ino
  ) {
    throw new DecompositionRecoveryError(
      "Git index changed despite the decomposition index lock; journal retained.",
    );
  }
}

async function buildTransactionIndexCandidate(
  projectRoot: string,
  sourceIndex: string,
  candidatePath: string,
  journal: DecompositionTransactionJournal,
  target: "base" | "target",
): Promise<IndexRecord[]> {
  await writeDurableIndexCandidate(sourceIndex, candidatePath);
  const candidateEnvironment = { ...process.env, GIT_INDEX_FILE: candidatePath };
  try {
    for (const entry of [journal.parent, ...journal.children]) {
      const desired =
        target === "target"
          ? { mode: entry.targetMode, blob: entry.targetGitBlob }
          : entry.baseIndex;
      if (desired) {
        await execFileAsync(
          "git",
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `${desired.mode},${desired.blob},${entry.relativePath}`,
          ],
          { cwd: projectRoot, env: candidateEnvironment },
        );
      } else {
        await execFileAsync("git", ["update-index", "--force-remove", "--", entry.relativePath], {
          cwd: projectRoot,
          env: candidateEnvironment,
        });
      }
    }
    const candidateHandle = await fs.open(candidatePath, "r+");
    try {
      await candidateHandle.sync();
    } finally {
      await candidateHandle.close();
    }
    const records = await readIndexRecords(projectRoot, candidatePath);
    const sourceRecords = await readIndexRecords(projectRoot, sourceIndex);
    const expected =
      target === "target"
        ? expectedTransactionIndexRecords(sourceRecords, journal)
        : expectedTransactionBaseIndexRecords(sourceRecords, journal);
    if (!sameIndexRecords(records, expected)) {
      throw new DecompositionRecoveryError(
        `Private decomposition index does not match the requested ${target} state.`,
      );
    }
    return records;
  } catch (error) {
    await unlinkDecompositionFileWithRetry(`${candidatePath}.lock`).catch(() => undefined);
    throw error;
  }
}

async function writeDurableIndexCandidate(source: string, destination: string): Promise<void> {
  const bytes = await fs.readFile(source);
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await flushDirectory(path.dirname(destination));
}

async function renameIndexWithRetry(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function reconcileTransactionIndexArtifacts(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  committed: boolean,
): Promise<void> {
  const projectRoot = path.resolve(adapter.projectRoot);
  const journalDir = await journalDirectory(projectRoot, true);
  const indexPath = await resolveGitIndexPath(projectRoot);
  const lockPath = `${indexPath}.lock`;
  const candidatePath = transactionIndexCandidatePath(journalDir, journal.parentTaskId);
  const candidateLockPath = `${candidatePath}.lock`;
  const [candidateStat, candidateLockStat, lockStat] = await Promise.all([
    lstatOrNull(candidatePath),
    lstatOrNull(candidateLockPath),
    lstatOrNull(lockPath),
  ]);
  if (!candidateStat && !candidateLockStat && !lockStat) return;
  for (const [label, stat] of [
    ["candidate", candidateStat],
    ["candidate lock", candidateLockStat],
    ["lock", lockStat],
  ] as const) {
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new DecompositionRecoveryError(
        `Decomposition index ${label} is unsafe; journal retained.`,
      );
    }
  }

  const realRecords = await readIndexRecords(projectRoot);
  if (!lockStat) {
    // A crash while building the private candidate happens before HEAD moves
    // and before the standard Git lock is acquired. The real index must still
    // contain the journal baseline; only then are these deterministic private
    // artifacts transaction-owned and safe to discard.
    if (
      committed ||
      !sameIndexRecords(realRecords, expectedTransactionBaseIndexRecords(realRecords, journal))
    ) {
      throw new DecompositionRecoveryError(
        "Decomposition index artifacts have no owned Git index lock; journal retained.",
      );
    }
    if (candidateLockStat) await unlinkDecompositionFileWithRetry(candidateLockPath);
    if (candidateStat) await unlinkDecompositionFileWithRetry(candidatePath);
    await flushDirectory(journalDir);
    return;
  }

  const lockRecords = await readIndexRecords(projectRoot, lockPath);
  if (!sameIndexRecords(lockRecords, expectedTransactionBaseIndexRecords(lockRecords, journal))) {
    throw new DecompositionRecoveryError(
      "Decomposition Git index lock does not contain the journal baseline; journal retained.",
    );
  }
  const targetRecords = expectedTransactionIndexRecords(lockRecords, journal);
  const [realIndexStat, ownedLockStat] = await Promise.all([
    fs.lstat(indexPath, { bigint: true }),
    fs.lstat(lockPath, { bigint: true }),
  ]);
  const lockSharesCurrentIndex =
    realIndexStat.isFile() &&
    !realIndexStat.isSymbolicLink() &&
    ownedLockStat.isFile() &&
    !ownedLockStat.isSymbolicLink() &&
    realIndexStat.dev === ownedLockStat.dev &&
    realIndexStat.ino === ownedLockStat.ino &&
    realIndexStat.nlink === 2n &&
    ownedLockStat.nlink === 2n;
  if (candidateStat && committed) {
    const candidateRecords = await readIndexRecords(projectRoot, candidatePath);
    if (!sameIndexRecords(candidateRecords, targetRecords)) {
      throw new DecompositionRecoveryError(
        `Decomposition index candidate diverged at ${candidatePath}; journal retained.`,
      );
    }
  }
  if (candidateLockStat) {
    if (committed) {
      throw new DecompositionRecoveryError(
        "Committed decomposition retained an incomplete private-index lock; journal retained.",
      );
    }
    await unlinkDecompositionFileWithRetry(candidateLockPath);
  }

  if (!committed) {
    if (!lockSharesCurrentIndex) {
      throw new DecompositionRecoveryError(
        "Uncommitted decomposition does not own the current Git index lock; journal retained.",
      );
    }
    const publishedBase = expectedTransactionBaseIndexRecords(lockRecords, journal);
    if (
      (candidateStat && !sameIndexRecords(realRecords, lockRecords)) ||
      (!candidateStat &&
        !sameIndexRecords(realRecords, lockRecords) &&
        !sameIndexRecords(realRecords, publishedBase))
    ) {
      throw new DecompositionRecoveryError(
        "Git index diverged from the uncommitted decomposition lock; journal retained.",
      );
    }
    if (candidateStat) await unlinkDecompositionFileWithRetry(candidatePath);
    await unlinkDecompositionFileWithRetry(lockPath);
    await flushDirectory(path.dirname(indexPath));
    await flushDirectory(journalDir);
    return;
  }

  if (candidateStat) {
    if (!lockSharesCurrentIndex || !sameIndexRecords(realRecords, lockRecords)) {
      throw new DecompositionRecoveryError(
        "Git index diverged before committed decomposition reconciliation; journal retained.",
      );
    }
    await renameIndexWithRetry(candidatePath, indexPath);
    await flushDirectory(path.dirname(indexPath));
    await unlinkDecompositionFileWithRetry(lockPath);
  } else if (sameIndexRecords(realRecords, targetRecords)) {
    await unlinkDecompositionFileWithRetry(lockPath);
  } else {
    throw new DecompositionRecoveryError(
      "Committed decomposition index is neither the locked baseline nor target; journal retained.",
    );
  }
  await flushDirectory(path.dirname(indexPath));
  await flushDirectory(journalDir);
}

function assertRecoverableTransactionIndexRecords(
  records: readonly IndexRecord[],
  journal: DecompositionTransactionJournal,
): void {
  for (const entry of [journal.parent, ...journal.children]) {
    const matches = records.filter((record) => record.path === entry.relativePath);
    const current =
      matches.length === 0
        ? null
        : matches.length === 1 && matches[0].stage === "0"
          ? { mode: matches[0].mode, blob: matches[0].blob }
          : undefined;
    const target = { mode: entry.targetMode, blob: entry.targetGitBlob };
    if (
      current === undefined ||
      (!sameGitEntry(current, entry.baseIndex) && !sameGitEntry(current, target))
    ) {
      throw new DecompositionRecoveryError(
        `Index entry diverged for ${entry.relativePath}; recovery left the index untouched.`,
      );
    }
  }
}

async function publishRecoveryIndexState(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  committed: boolean,
): Promise<void> {
  const projectRoot = path.resolve(adapter.projectRoot);
  const journalDir = await journalDirectory(projectRoot, true);
  const indexPath = await resolveGitIndexPath(projectRoot);
  const lockPath = await acquireGitIndexSnapshotLock(indexPath);
  const candidatePath = transactionIndexCandidatePath(journalDir, journal.parentTaskId);
  let published = false;
  try {
    const lockedRecords = await readIndexRecords(projectRoot, lockPath);
    assertRecoverableTransactionIndexRecords(lockedRecords, journal);
    const desiredRecords = committed
      ? expectedTransactionIndexRecords(lockedRecords, journal)
      : expectedTransactionBaseIndexRecords(lockedRecords, journal);
    if (!sameIndexRecords(lockedRecords, desiredRecords)) {
      await buildTransactionIndexCandidate(
        projectRoot,
        lockPath,
        candidatePath,
        journal,
        committed ? "target" : "base",
      );
      await assertIndexStillMatchesLock(indexPath, lockPath);
      if (committed) {
        await assertCommittedDecompositionTransaction(adapter, journal);
      } else {
        await assertJournalHeadIdentity(projectRoot, journal);
      }
      await renameIndexWithRetry(candidatePath, indexPath);
      published = true;
      await flushDirectory(path.dirname(indexPath));
    }
    await unlinkDecompositionFileWithRetry(lockPath);
    await flushDirectory(path.dirname(indexPath));
  } catch (error) {
    if (!published) {
      await unlinkDecompositionFileWithRetry(candidatePath).catch(() => undefined);
      await unlinkDecompositionFileWithRetry(`${candidatePath}.lock`).catch(() => undefined);
      await unlinkDecompositionFileWithRetry(lockPath).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Build the exact decomposition tree in a private index and advance HEAD with
 * an old-value compare-and-swap. The user's real index is neither a commit
 * input nor overwritten before the final baseline check, so unrelated staged
 * work cannot leak into the transaction and a concurrent HEAD advance wins
 * without being rewritten.
 */
export async function commitDecompositionTransaction(
  adapter: ProjectAdapter,
  journal: DecompositionTransactionJournal,
  options: DecompositionCommitOptions = {},
): Promise<DecompositionCommitResult> {
  await assertDecompositionCommitBaseline(adapter, journal);
  const projectRoot = path.resolve(adapter.projectRoot);
  const journalDir = await journalDirectory(projectRoot, true);
  const privateIndex = path.join(
    journalDir,
    `.decompose-index-${journal.parentTaskId}-${process.pid}-${randomUUID()}`,
  );
  const indexEnvironment = { ...process.env, GIT_INDEX_FILE: privateIndex };
  const transactionEntries = [journal.parent, ...journal.children];
  const relativePaths = transactionEntries.map((entry) => entry.relativePath);
  let commitSha: string;
  try {
    await execFileAsync("git", ["read-tree", journal.baseHead], {
      cwd: projectRoot,
      env: indexEnvironment,
    });
    for (const entry of transactionEntries) {
      await execFileAsync(
        "git",
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${entry.targetMode},${entry.targetGitBlob},${entry.relativePath}`,
        ],
        { cwd: projectRoot, env: indexEnvironment },
      );
    }
    const { stdout: treeStdout } = await execFileAsync("git", ["write-tree"], {
      cwd: projectRoot,
      env: indexEnvironment,
      encoding: "utf-8",
    });
    const tree = treeStdout.trim();
    if (!HASH_PATTERN.test(tree)) {
      throw new DecompositionRecoveryError(`Git returned an invalid decomposition tree: ${tree}.`);
    }
    const message = `docs(tasks): auto-commit subtasks for ${journal.parentTaskId}`;
    const { stdout: commitStdout } = await execFileAsync(
      "git",
      ["commit-tree", tree, "-p", journal.baseHead, "-m", message],
      { cwd: projectRoot, env: indexEnvironment, encoding: "utf-8" },
    );
    commitSha = commitStdout.trim();
    if (!HASH_PATTERN.test(commitSha)) {
      throw new DecompositionRecoveryError(
        `Git returned an invalid decomposition commit: ${commitSha}.`,
      );
    }
  } finally {
    await unlinkDecompositionFileWithRetry(privateIndex);
  }

  // Record the exact commit object durably before HEAD can move. Recovery can
  // then recognize this transaction even when later unrelated commits have
  // advanced HEAD beyond it.
  journal.commitSha = commitSha;
  const journalPath = await decompositionJournalPathForTask(adapter, journal.parentTaskId);
  await updateDecompositionTransactionJournal(journalPath, journal, "committing");

  const indexPath = await resolveGitIndexPath(projectRoot);
  const indexLockPath = `${indexPath}.lock`;
  const realIndexCandidate = transactionIndexCandidatePath(journalDir, journal.parentTaskId);
  // Let a concurrent conventional index writer finish before taking Git's
  // standard lock, then snapshot that exact index. Unrelated staged changes
  // are copied into the candidate; transaction-path changes are refused.
  await options.beforeRefUpdate?.();
  await assertDecompositionCommitBaseline(adapter, journal);
  await acquireGitIndexSnapshotLock(indexPath);
  let headUpdated = false;
  try {
    await options.afterIndexLock?.();
    const lockedRecords = await readIndexRecords(projectRoot, indexLockPath);
    assertTransactionIndexBaseline(lockedRecords, journal);
    await buildTransactionIndexCandidate(
      projectRoot,
      indexLockPath,
      realIndexCandidate,
      journal,
      "target",
    );
    await assertIndexStillMatchesLock(indexPath, indexLockPath);
    await assertJournalHeadIdentity(projectRoot, journal);
    const updateTarget = journal.baseRef ?? "HEAD";
    const updateRefArgs = [
      "update-ref",
      "-m",
      `quack decomposition ${journal.parentTaskId}`,
      ...(journal.baseRef === null ? ["--no-deref"] : []),
      updateTarget,
      commitSha,
      journal.baseHead,
    ];
    if (options.executeRefUpdate) {
      await options.executeRefUpdate(projectRoot, updateRefArgs);
    } else {
      await execFileAsync("git", updateRefArgs, { cwd: projectRoot });
    }
    headUpdated = true;
    await options.afterRefUpdate?.();
    await options.afterPostCommitStep?.("ref_updated");
    await assertCommittedDecompositionTransaction(adapter, journal);
    await options.afterPostCommitStep?.("commit_verified");
    await renameIndexWithRetry(realIndexCandidate, indexPath);
    await options.afterPostCommitStep?.("index_published");
    await flushDirectory(path.dirname(indexPath));
    await options.afterPostCommitStep?.("index_directory_flushed");
    await options.afterIndexPublish?.();
    await unlinkDecompositionFileWithRetry(indexLockPath);
    await options.afterPostCommitStep?.("index_lock_removed");
    await flushDirectory(journalDir);
    await options.afterPostCommitStep?.("journal_directory_flushed");
  } catch (error) {
    if (!headUpdated) {
      // Child-process errors are observationally ambiguous: Git can publish
      // the compare-and-swap, another writer can advance the same ref, and the
      // original process can still report failure. Only a positive exact
      // transaction proof or a later journal recovery may cross the commit
      // boundary. A negative proof may roll back; an unavailable probe may not.
      const observation = await observeDecompositionRefPublication(
        adapter,
        journal,
        options.readRefPublicationGit,
      );
      if (observation.state === "confirmed_not_committed") {
        await unlinkDecompositionFileWithRetry(indexLockPath).catch(() => undefined);
        await unlinkDecompositionFileWithRetry(realIndexCandidate).catch(() => undefined);
        await unlinkDecompositionFileWithRetry(`${realIndexCandidate}.lock`).catch(() => undefined);
        throw error;
      }

      try {
        const recovered = await recoverDecompositionJournalWithinReservation(adapter, journalPath);
        if (recovered.outcome === "rolled_back") {
          // The first probe was unavailable, but durable recovery subsequently
          // proved that the compare-and-swap did not publish. This is now a
          // genuine retryable failure, and the journal has already rolled back.
          throw new DecompositionRecoveryError(
            `Git ref publication failed and the decomposition transaction was rolled back: ${error instanceof Error ? error.message : String(error)}`,
            journalPath,
            { rollbackReconciled: true },
          );
        }
        return {
          committed: true,
          sha: commitSha.slice(0, 7),
          staged: relativePaths,
          journalReconciled: true,
          recoveryPending: true,
          statusProjectionId: recovered.statusProjectionId,
          warnings: [
            `Recovered committed decomposition after ambiguous ref-update failure: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      } catch (recoveryError) {
        if (
          recoveryError instanceof DecompositionRecoveryError &&
          recoveryError.details.rollbackReconciled === true
        ) {
          throw recoveryError;
        }
        if (observation.state === "unknown") {
          // Neither the read-only probe nor journal recovery established the
          // boundary. Do not claim a commit and do not expose a retryable write
          // failure: the durable journal remains the admission fence until a
          // later recovery can prove committed or rolled back.
          throw new DecompositionRecoveryError(
            `Decomposition ref publication is indeterminate; do not retry while durable recovery is pending: ${error instanceof Error ? error.message : String(error)}`,
            journalPath,
            {
              commitState: "unknown",
              recoveryPending: true,
              retryable: false,
              commitSha,
              observationError:
                observation.error instanceof Error
                  ? observation.error.message
                  : String(observation.error),
              recoveryError:
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
            },
          );
        }
        return {
          committed: true,
          sha: commitSha.slice(0, 7),
          staged: relativePaths,
          journalReconciled: false,
          recoveryPending: true,
          warnings: [
            `Decomposition commit ${commitSha.slice(0, 7)} was created, but immediate reconciliation failed; journal retained and scheduling remains fenced: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            `Original post-CAS failure: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    }

    // The exact ref CAS is the irreversible transaction boundary. Any later
    // failure is a recovery event, not a failed write: reconcile the durable
    // journal while the caller still owns the task-creation reservation and
    // return the already-created commit so preflight cannot retry/refuse it.
    try {
      const recovered = await recoverDecompositionJournalWithinReservation(adapter, journalPath);
      if (recovered.outcome !== "committed_reconciled") {
        throw new DecompositionRecoveryError(
          `Post-commit reconciliation returned ${recovered.outcome} for ${journal.parentTaskId}.`,
          journalPath,
          { committed: true, commitSha },
        );
      }
      return {
        committed: true,
        sha: commitSha.slice(0, 7),
        staged: relativePaths,
        journalReconciled: true,
        recoveryPending: true,
        statusProjectionId: recovered.statusProjectionId,
        warnings: [
          `Recovered committed decomposition after post-CAS failure: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    } catch (recoveryError) {
      return {
        committed: true,
        sha: commitSha.slice(0, 7),
        staged: relativePaths,
        journalReconciled: false,
        recoveryPending: true,
        warnings: [
          `Decomposition commit ${commitSha.slice(0, 7)} was created, but immediate reconciliation failed; journal retained and scheduling remains fenced: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          `Original post-CAS failure: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }
  return {
    committed: true,
    // The ref and index are already published. Never perform another fallible
    // Git operation here: an observation failure must not turn a real commit
    // into a reported transaction failure that callers could retry.
    sha: commitSha.slice(0, 7),
    staged: relativePaths,
  };
}

export async function completeDecompositionTransactionJournal(
  adapter: ProjectAdapter,
  journalPath: string,
  journal: DecompositionTransactionJournal,
): Promise<DecompositionStatusProjection> {
  await updateDecompositionTransactionJournal(journalPath, journal, "committed");
  // Keep the recovery record until the last possible moment, and re-check
  // after the journal phase flush. Publish the exact transaction-bound DB
  // projection outbox before removing the recovery journal, so a crash can
  // never leave a committed DECOMPOSED parent with no authoritative evidence.
  await assertCommittedDecompositionTransaction(adapter, journal);
  const projection = await ensureStatusProjectionOutbox(adapter, journal);
  await removeJournal(journalPath);
  return projection;
}

export async function recoverDecompositionJournalWithinReservation(
  adapter: ProjectAdapter,
  journalPath: string,
): Promise<DecompositionRecoveryResult> {
  const journal = await readAndValidateJournal(adapter, journalPath);
  const projectRoot = path.resolve(adapter.projectRoot);
  const [currentHead, currentRef] = await Promise.all([
    git(projectRoot, ["rev-parse", "HEAD"]),
    currentHeadRef(projectRoot),
  ]);
  if (currentRef !== journal.baseRef) {
    throw new DecompositionRecoveryError(
      `Git HEAD symbolic identity diverged from ${journal.baseRef ?? "detached"}; journal retained.`,
      journalPath,
      { baseRef: journal.baseRef, currentRef },
    );
  }
  const committed = await isCommittedTransaction(adapter, journal, currentHead);
  if (!committed && currentHead !== journal.baseHead) {
    throw new DecompositionRecoveryError(
      `Git HEAD diverged from decomposition base ${journal.baseHead}; journal retained.`,
      journalPath,
      { currentHead },
    );
  }

  await reconcileTransactionIndexArtifacts(adapter, journal, committed);

  const temporaryState = await validateTransactionTemporaryFiles(adapter, journal);
  const parentReplacementBackup = await validateParentReplacementBackup(adapter, journal);
  await validateWorktreeForRecovery(
    adapter,
    journal,
    committed,
    temporaryState.linkedPublishedPaths,
    parentReplacementBackup,
  );
  await validateIndexForRecovery(adapter, journal, true);
  await removeTransactionTemporaryFiles(temporaryState.temporaryPaths);
  await reconcileParentReplacementBackup(adapter, journal, committed, parentReplacementBackup);
  // No remaining transaction path may have an extra hard link. This second
  // pass happens before any parent/child/index reconciliation mutation.
  await validateWorktreeForRecovery(adapter, journal, committed);

  if (committed) {
    // Legacy/interrupted journals may predate the pre-CAS commitSha write. If
    // recovery proved the current HEAD is exactly the transaction tree, bind
    // the durable projection to that exact commit before publishing it.
    journal.commitSha ??= currentHead;
    const parentPath = absoluteFromRelative(projectRoot, journal.parent.relativePath);
    const parentHash = await readWorktreeHash(parentPath);
    if (parentHash === null) {
      await writeDecompositionFileAtomicExclusive(
        parentPath,
        decodeBytes(journal.parent.target, "parent target"),
      );
    } else if (parentHash === journal.parent.original.sha256) {
      await writeDecompositionFileAtomicReplace(
        parentPath,
        decodeBytes(journal.parent.target, "parent target"),
        decodeBytes(journal.parent.original, "parent original"),
      );
    }
    for (const child of journal.children) {
      const childPath = absoluteFromRelative(projectRoot, child.relativePath);
      if ((await readWorktreeHash(childPath)) === null) {
        await writeDecompositionFileAtomicExclusive(
          childPath,
          decodeBytes(child.target, `child ${child.taskId}`),
        );
      }
    }
    await publishRecoveryIndexState(adapter, journal, true);
    await updateDecompositionTransactionJournal(journalPath, journal, "committed");
    const projection = await ensureStatusProjectionOutbox(adapter, journal);
    await removeJournal(journalPath);
    return {
      parentTaskId: journal.parentTaskId,
      outcome: "committed_reconciled",
      journalPath,
      statusProjectionId: projection.projectionId,
    };
  }

  const parentPath = absoluteFromRelative(projectRoot, journal.parent.relativePath);
  if ((await readWorktreeHash(parentPath)) === journal.parent.target.sha256) {
    await writeDecompositionFileAtomicReplace(
      parentPath,
      decodeBytes(journal.parent.original, "parent original"),
      decodeBytes(journal.parent.target, "parent target"),
    );
  }
  for (const child of journal.children) {
    const childPath = absoluteFromRelative(projectRoot, child.relativePath);
    if ((await readWorktreeHash(childPath)) === child.target.sha256) {
      await removeExactTransactionFile(
        childPath,
        child.target.sha256,
        `Transaction child ${child.taskId}`,
      );
    }
  }
  await flushDirectory(path.dirname(parentPath));
  await publishRecoveryIndexState(adapter, journal, false);
  await removeJournal(journalPath);
  return { parentTaskId: journal.parentTaskId, outcome: "rolled_back", journalPath };
}

export async function recoverPendingDecompositionTransactions(
  adapter: ProjectAdapter,
  reservationOptions: Partial<TaskCreationLockOptions> = {},
): Promise<DecompositionRecoveryResult[]> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const pendingDecompositionJournals = await listPendingDecompositionJournalPaths(adapter);
  const { hasPendingCanonicalTaskMutationJournals } =
    await import("./canonical-task-mutation-journal.js");
  const hasPendingCanonicalJournal = await hasPendingCanonicalTaskMutationJournals(
    adapter.projectRoot,
  );
  try {
    await fs.lstat(taskDir);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      pendingDecompositionJournals.length === 0 &&
      !hasPendingCanonicalJournal
    ) {
      return [];
    }
    throw error;
  }
  await assertSafeDecompositionTaskDirectory(adapter.projectRoot, taskDir);
  return withTaskCreationReservation(
    taskDir,
    { creator: "decompose", requestedIds: [] },
    async () => {
      return recoverPendingTaskSpecMutationsWithinReservation(adapter);
    },
    { staleMs: 0, ...reservationOptions },
  );
}

async function listPendingDecompositionJournalPaths(adapter: ProjectAdapter): Promise<string[]> {
  let journalDir: string;
  try {
    journalDir = await journalDirectory(adapter.projectRoot);
  } catch (error) {
    // A project that is not a Git worktree cannot have a Git-private
    // decomposition journal. Finalization itself will still fail closed when
    // it tries to create a commit.
    if ((await gitOrNull(adapter.projectRoot, ["rev-parse", "--is-inside-work-tree"])) === "true") {
      throw error;
    }
    return [];
  }
  let names: string[];
  try {
    names = (await fs.readdir(journalDir))
      .filter((name) => name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return names.map((name) => path.join(journalDir, name));
}

export async function recoverPendingDecompositionTransactionsWithinReservation(
  adapter: ProjectAdapter,
): Promise<DecompositionRecoveryResult[]> {
  const journalPaths = await listPendingDecompositionJournalPaths(adapter);
  const results: DecompositionRecoveryResult[] = [];
  for (const journalPath of journalPaths) {
    results.push(await recoverDecompositionJournalWithinReservation(adapter, journalPath));
  }
  return results;
}

export async function recoverPendingTaskSpecMutationsWithinReservation(
  adapter: ProjectAdapter,
): Promise<DecompositionRecoveryResult[]> {
  const results = await recoverPendingDecompositionTransactionsWithinReservation(adapter);
  const { recoverPendingCanonicalTaskMutationsWithinReservation } =
    await import("./canonical-task-mutation-journal.js");
  await recoverPendingCanonicalTaskMutationsWithinReservation(adapter);
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await recoverDecompositionReplacementArtifactsInDirectory(taskDir);
  return results;
}

export interface DecompositionStatusProjectionDrainOptions {
  /** Narrow fault-injection hook for crash-after-DB-commit idempotency tests. */
  afterProjection?: (
    projection: DecompositionStatusProjection,
    outcome: "projected" | "already_projected",
  ) => void | Promise<void>;
}

export async function listPendingDecompositionStatusProjections(
  adapter: ProjectAdapter,
): Promise<DecompositionStatusProjection[]> {
  const paths = await listPendingStatusProjectionPaths(adapter);
  const projections: DecompositionStatusProjection[] = [];
  for (const outboxPath of paths) {
    projections.push(
      projectionEvidence(await readAndValidateStatusProjection(adapter, outboxPath)),
    );
  }
  return projections;
}

export async function drainPendingDecompositionStatusProjectionsWithinReservation(
  adapter: ProjectAdapter,
  store: DecompositionStatusProjectionStore,
  options: DecompositionStatusProjectionDrainOptions = {},
): Promise<DecompositionStatusProjectionResult[]> {
  const paths = await listPendingStatusProjectionPaths(adapter);
  const results: DecompositionStatusProjectionResult[] = [];
  for (const outboxPath of paths) {
    const outbox = await readAndValidateStatusProjection(adapter, outboxPath);
    await assertCommittedDecompositionTransaction(adapter, outbox.journal);
    const projection = projectionEvidence(outbox);
    const current = store.getStatus(projection.parentTaskId);
    let outcome: "projected" | "already_projected";
    if (current?.status === projection.status && current.updated_by === projection.source) {
      outcome = "already_projected";
    } else {
      store.setStatus(projection.parentTaskId, projection.status, projection.source);
      const confirmed = store.getStatus(projection.parentTaskId);
      if (confirmed?.status !== projection.status || confirmed.updated_by !== projection.source) {
        throw new DecompositionRecoveryError(
          `Authoritative status store did not confirm projection ${projection.projectionId}; outbox retained.`,
          outboxPath,
          { projectionId: projection.projectionId, parentTaskId: projection.parentTaskId },
        );
      }
      outcome = "projected";
    }
    await options.afterProjection?.(projection, outcome);
    await removeJournal(outboxPath);
    results.push({ ...projection, outcome, outboxPath });
  }
  return results;
}

export async function recoverAndProjectPendingDecompositionTransactions(
  adapter: ProjectAdapter,
  store: DecompositionStatusProjectionStore,
  reservationOptions: Partial<TaskCreationLockOptions> = {},
  projectionOptions: DecompositionStatusProjectionDrainOptions = {},
): Promise<RecoverAndProjectDecompositionsResult> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const pendingJournals = await listPendingDecompositionJournalPaths(adapter);
  const pendingProjections = await listPendingStatusProjectionPaths(adapter);
  const { hasPendingCanonicalTaskMutationJournals } =
    await import("./canonical-task-mutation-journal.js");
  const hasPendingCanonicalJournal = await hasPendingCanonicalTaskMutationJournals(
    adapter.projectRoot,
  );
  try {
    await fs.lstat(taskDir);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      pendingJournals.length === 0 &&
      pendingProjections.length === 0 &&
      !hasPendingCanonicalJournal
    ) {
      return { recoveries: [], projections: [] };
    }
    throw error;
  }
  await assertSafeDecompositionTaskDirectory(adapter.projectRoot, taskDir);
  return withTaskCreationReservation(
    taskDir,
    { creator: "decompose", requestedIds: [] },
    async () => {
      const recoveries = await recoverPendingTaskSpecMutationsWithinReservation(adapter);
      const projections = await drainPendingDecompositionStatusProjectionsWithinReservation(
        adapter,
        store,
        projectionOptions,
      );
      return { recoveries, projections };
    },
    { staleMs: 0, ...reservationOptions },
  );
}

/**
 * Hold the same task-creation reservation used by decomposition writers while
 * recovering any durable journal and admitting a dispatch. This closes the
 * gap where a writer could fsync a journal or rewrite the parent between a
 * recovery scan and DispatchManager.start().
 */
export async function withDecompositionAdmissionFence<T>(
  adapter: ProjectAdapter,
  taskId: string,
  operation: (admission: DecompositionDispatchAdmission) => T | Promise<T>,
  statusStore?: DecompositionStatusProjectionStore,
): Promise<T> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await assertSafeDecompositionTaskDirectory(adapter.projectRoot, taskDir);
  let releaseWarning: unknown;
  let operationStarted = false;
  let result: T;
  try {
    result = await withTaskCreationReservation(
      taskDir,
      { creator: "dispatch-admission", requestedIds: [taskId] },
      async () => {
        await recoverPendingTaskSpecMutationsWithinReservation(adapter);
        if (statusStore) {
          await drainPendingDecompositionStatusProjectionsWithinReservation(adapter, statusStore);
        } else if ((await listPendingStatusProjectionPaths(adapter)).length > 0) {
          throw new DecompositionRecoveryError(
            "Dispatch admission requires the monitor status store to acknowledge a committed decomposition projection.",
            undefined,
            { admissionDisposition: "recovery_required" },
          );
        }
        const current = await resolveParsedTaskFile(taskDir, taskId);
        if (!current?.task) {
          throw new DecompositionRecoveryError(
            `Dispatch admission cannot resolve one current parsed spec for ${taskId}.`,
          );
        }
        if (current.duplicateClaimants.length > 1) {
          throw new DuplicateClaimantAdmissionError({
            taskId,
            claimants: current.duplicateClaimants,
          });
        }
        const claimantIndex = await readTaskCreationClaimants(taskDir);
        const exactOwners = claimantIndex.get(normalizeClaimantTaskId(taskId)) ?? [];
        if (exactOwners.length !== 1 || exactOwners[0] !== current.fileName) {
          if (exactOwners.length > 1) {
            throw new DuplicateClaimantAdmissionError({ taskId, claimants: exactOwners });
          }
          throw new DecompositionRecoveryError(
            `Dispatch admission requires exactly one current claimant for ${taskId}; found ${exactOwners.join(", ") || "none"}.`,
            undefined,
            { admissionDisposition: "retryable", claimants: exactOwners },
          );
        }
        if (current.task.status === "DECOMPOSED") {
          throw new DecompositionRecoveryError(
            `Dispatch admission refused ${taskId} because its parent spec is DECOMPOSED.`,
            undefined,
            { admissionDisposition: "decomposed" },
          );
        }
        operationStarted = true;
        return operation({
          taskId,
          fileName: current.fileName,
          contentHash: sha256(Buffer.from(current.task.rawContent, "utf-8")),
        });
      },
      {
        onReleaseError: (error) => {
          releaseWarning = error;
        },
      },
    );
  } catch (error) {
    if (
      operationStarted ||
      error instanceof DecompositionRecoveryError ||
      error instanceof DuplicateClaimantAdmissionError
    ) {
      throw error;
    }
    throw new DecompositionRecoveryError(
      `Dispatch admission could not acquire or recover the task-creation reservation: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { admissionDisposition: "retryable" },
    );
  }
  if (releaseWarning) {
    const releaseMessage =
      releaseWarning instanceof Error
        ? releaseWarning.message
        : typeof releaseWarning === "string"
          ? releaseWarning
          : "unknown reservation release error";
    process.emitWarning(
      `Dispatch ${taskId} started after decomposition admission, but the task-creation reservation could not be released: ${releaseMessage}`,
    );
  }
  return result;
}

export async function decompositionJournalPathForTask(
  adapter: ProjectAdapter,
  parentTaskId: string,
): Promise<string> {
  return path.join(await journalDirectory(adapter.projectRoot), journalFileName(parentTaskId));
}
