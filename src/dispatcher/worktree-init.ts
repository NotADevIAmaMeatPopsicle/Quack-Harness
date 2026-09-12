// Runs dependency initialization after an isolated worktree is selected and
// before worker/context execution. Omitted config safely auto-discovers npm
// packages; an explicit empty list disables initialization.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { WorktreeInitResult, WorktreeInitStep } from "../core/types.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import {
  runContainedWorktreeInitCommand,
  type ContainedWorktreeInitInput,
  type ContainedWorktreeInitResult,
} from "./worktree-init-process.js";

const MAX_BUFFER = 10 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DISCOVERY_DEPTH = 3;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const DEPENDENCY_MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);
const FORCED_SAFE_NPM_ENV: NodeJS.ProcessEnv = {
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
};
const CAPTURED_NODE_EXECUTABLE = process.execPath;
const CAPTURED_NPM_EXECUTABLE = process.env.npm_execpath;
const RESERVED_STEP_ENV_NAMES = new Set([
  "APPDATA",
  "BASH_ENV",
  "COMSPEC",
  "ENV",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "ZDOTDIR",
]);
const RESERVED_STEP_ENV_PREFIXES = ["DYLD_", "GIT_CONFIG_", "NODE_", "NPM_"];

/** One-shot monitor-to-dispatch attestation for a newly created isolated worktree. */
export const WORKTREE_INIT_FRESH_ENV = "QUACK_WORKTREE_INIT_FRESH";

interface WorktreeInitExecutionOptions {
  /** Replace, rather than extend, process.env for this invocation. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Distinguishes initial setup from the post-worker dependency refresh. */
  phase?: "initial" | "post_worker_refresh";
  /** Internally generated structured steps; never adapter/model supplied. */
  preparedSteps?: PreparedStep[];
  /** Existing/model-mutated branches may run only Quack-generated argv steps. */
  allowShellSteps?: boolean;
  /** Validate npm metadata before executing steps from a model-mutated branch. */
  validateNpmMetadata?: boolean;
  /** Let a surrounding transaction publish the authoritative completion event. */
  emitCompletion?: boolean;
}

type WorktreeInitCommandRunner = (
  input: ContainedWorktreeInitInput,
) => Promise<ContainedWorktreeInitResult>;

type WorktreeInitEnvironmentCleanup = (cleanupRoot: string) => Promise<void>;
type AtomicFilePublisher = (pendingPath: string, finalPath: string) => Promise<void>;
type DependencyRefreshRename = (source: string, destination: string) => Promise<void>;
type DependencyRefreshDirectorySync = (directory: string) => Promise<void>;

let commandRunner: WorktreeInitCommandRunner = runContainedWorktreeInitCommand;
let environmentCleanup: WorktreeInitEnvironmentCleanup = async (cleanupRoot) => {
  await fs.rm(cleanupRoot, { recursive: true, force: true });
};
let atomicFilePublisher: AtomicFilePublisher = async (pendingPath, finalPath) => {
  await fs.link(pendingPath, finalPath);
};
let dependencyRefreshRename: DependencyRefreshRename = async (source, destination) => {
  await fs.rename(source, destination);
};
let dependencyRefreshDirectorySync: DependencyRefreshDirectorySync;

/** Test seam; production callers must use the contained default runner. */
export function _setWorktreeInitCommandRunner(runner: WorktreeInitCommandRunner | undefined): void {
  commandRunner = runner ?? runContainedWorktreeInitCommand;
}

/** Test seam; production callers use recursive physical removal. */
export function _setWorktreeInitEnvironmentCleanup(
  cleanup: WorktreeInitEnvironmentCleanup | undefined,
): void {
  environmentCleanup =
    cleanup ??
    (async (cleanupRoot) => {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    });
}

/** Test seam for failures at the atomic file-publication boundary. */
export function _setWorktreeInitAtomicFilePublisher(
  publisher: AtomicFilePublisher | undefined,
): void {
  atomicFilePublisher =
    publisher ??
    (async (pendingPath, finalPath) => {
      await fs.link(pendingPath, finalPath);
    });
}

/** Test seam for failures at a dependency-directory rename boundary. */
export function _setWorktreeInitDependencyRefreshRename(
  rename: DependencyRefreshRename | undefined,
): void {
  dependencyRefreshRename =
    rename ??
    (async (source, destination) => {
      await fs.rename(source, destination);
    });
}

/** Test seam for asserting durable ordering of dependency-directory mutations. */
export function _setWorktreeInitDependencyRefreshDirectorySync(
  sync: DependencyRefreshDirectorySync | undefined,
): void {
  dependencyRefreshDirectorySync = sync ?? syncDirectory;
}

function emitBestEffort(
  events: IEventWriter | undefined,
  stage: Parameters<IEventWriter["emit"]>[0],
  payload: Parameters<IEventWriter["emit"]>[1],
): void {
  try {
    events?.emit(stage, payload);
  } catch {
    // The structured result remains authoritative if the event sink is down.
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Resolve a directory and reject lexical or filesystem-alias escapes. */
async function resolveContainedDirectory(
  canonicalRoot: string,
  worktreePath: string,
  configuredCwd: string,
): Promise<string> {
  if (path.isAbsolute(configuredCwd) || path.win32.isAbsolute(configuredCwd)) {
    throw new Error(`Configured cwd must be worktree-relative: ${configuredCwd}`);
  }
  const lexicalRoot = path.resolve(worktreePath);
  const lexical = path.resolve(lexicalRoot, configuredCwd);
  if (!isContainedPath(lexicalRoot, lexical)) {
    throw new Error(`Configured cwd escapes the worktree: ${configuredCwd}`);
  }

  const canonical = await fs.realpath(lexical);
  if (!isContainedPath(canonicalRoot, canonical)) {
    throw new Error(`Configured cwd resolves outside the worktree: ${configuredCwd}`);
  }
  if (!(await fs.stat(canonical)).isDirectory()) {
    throw new Error(`Configured cwd is not a directory: ${configuredCwd}`);
  }
  return canonical;
}

async function resolveUnaliasedPackageDirectory(
  canonicalRoot: string,
  worktreePath: string,
  configuredCwd: string,
): Promise<string> {
  const canonical = await resolveContainedDirectory(canonicalRoot, worktreePath, configuredCwd);
  const expectedCanonical = path.resolve(canonicalRoot, configuredCwd);
  if (!sameCanonicalPath(canonical, expectedCanonical)) {
    throw new Error(
      `Changed dependency manifest directory uses a filesystem alias: ${configuredCwd}`,
    );
  }
  return canonical;
}

async function resolveOptionalUnaliasedPackageDirectory(
  canonicalRoot: string,
  worktreePath: string,
  configuredCwd: string,
): Promise<string | undefined> {
  if (path.isAbsolute(configuredCwd) || path.win32.isAbsolute(configuredCwd)) {
    throw new Error(`Changed dependency manifest directory must be relative: ${configuredCwd}`);
  }
  const lexicalRoot = path.resolve(worktreePath);
  const lexical = path.resolve(lexicalRoot, configuredCwd);
  if (!isContainedPath(lexicalRoot, lexical)) {
    throw new Error(`Changed dependency manifest directory escapes the worktree: ${configuredCwd}`);
  }
  try {
    const metadata = await fs.lstat(lexical);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Changed dependency manifest directory uses a filesystem alias: ${configuredCwd}`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `Changed dependency manifest directory must be a physical directory: ${configuredCwd}`,
      );
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return resolveUnaliasedPackageDirectory(canonicalRoot, worktreePath, configuredCwd);
}

function normalizedManifestPath(candidate: string): string | undefined {
  if (!candidate || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate))
    return undefined;
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()))) return undefined;
  return DEPENDENCY_MANIFEST_NAMES.has(path.posix.basename(normalized)) ? normalized : undefined;
}

/** Return changed npm dependency manifests, normalized to worktree-relative paths. */
export function changedDependencyManifestPaths(changedPaths: string[]): string[] {
  return [
    ...new Set(
      changedPaths
        .map(normalizedManifestPath)
        .filter((candidate): candidate is string => candidate !== undefined),
    ),
  ].sort();
}

function sanitizedExecutionEnvironment(
  tempRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"]);
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  env.HOME = tempRoot;
  env.USERPROFILE = tempRoot;
  env.APPDATA = tempRoot;
  env.LOCALAPPDATA = tempRoot;
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  env.TMPDIR = tempRoot;
  env.CI = "true";
  env.NPM_CONFIG_USERCONFIG = path.join(tempRoot, "user.npmrc");
  env.NPM_CONFIG_GLOBALCONFIG = path.join(tempRoot, "global.npmrc");
  env.NPM_CONFIG_CACHE = path.join(tempRoot, "cache");
  env.NPM_CONFIG_PREFIX = path.join(tempRoot, "prefix");
  env.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
  env.NPM_CONFIG_PROXY = "";
  env.NPM_CONFIG_HTTPS_PROXY = "";
  env.NPM_CONFIG_STRICT_SSL = "true";
  return { ...env, ...FORCED_SAFE_NPM_ENV };
}

async function prepareExecutionEnvironment(
  configured?: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; cleanupRoot?: string }> {
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-init-env-"));
  try {
    await Promise.all([
      fs.writeFile(path.join(cleanupRoot, "user.npmrc"), "ignore-scripts=true\n", "utf8"),
      fs.writeFile(path.join(cleanupRoot, "global.npmrc"), "ignore-scripts=true\n", "utf8"),
    ]);
  } catch (error: unknown) {
    try {
      await environmentCleanup(cleanupRoot);
    } catch (cleanupError: unknown) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; temporary npm environment cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
  return { env: sanitizedExecutionEnvironment(cleanupRoot, configured), cleanupRoot };
}

function assertSafeStepEnvironment(environment: Record<string, string>): void {
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalized)) {
      throw new Error(`Invalid worktree-init environment variable name: ${name}`);
    }
    if (
      RESERVED_STEP_ENV_NAMES.has(normalized) ||
      RESERVED_STEP_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      throw new Error(`Reserved worktree-init environment variable cannot be overridden: ${name}`);
    }
  }
}

async function execStep(
  invocation: PreparedStep["invocation"],
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  stepEnv?: Record<string, string>,
): Promise<ContainedWorktreeInitResult> {
  try {
    return await commandRunner({
      ...invocation,
      cwd,
      env: { ...baseEnv, ...stepEnv, ...FORCED_SAFE_NPM_ENV },
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER,
    });
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
      timedOut: false,
      descendantsContained: false,
    };
  }
}

/** Find package manifests without following symlink/junction aliases. */
async function discoverPackageJsonFiles(dir: string, depth: number = 0): Promise<string[]> {
  if (depth > MAX_DISCOVERY_DEPTH) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const results: string[] = [];
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    results.push(path.join(dir, "package.json"));
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      EXCLUDED_DIRS.has(entry.name.toLowerCase())
    )
      continue;
    results.push(...(await discoverPackageJsonFiles(path.join(dir, entry.name), depth + 1)));
  }
  return results;
}

interface PreparedStep {
  invocation: { command: string } | { executable: string; args: string[] };
  cwd: string;
  label: string;
  env?: Record<string, string>;
}

interface TrustedNpmInvocation {
  executable: string;
  npmCliPath: string;
}

const SAFE_NPM_INSTALL_FLAGS = new Set(["--ignore-scripts", "--no-audit", "--no-fund", "--silent"]);

function parseRecognizedNpmInstall(command: string): string[] | undefined {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() !== "npm") return undefined;
  if (tokens[1] !== "ci" && tokens[1] !== "install") return undefined;
  if (tokens.slice(2).some((token) => !SAFE_NPM_INSTALL_FLAGS.has(token))) return undefined;
  return [
    tokens[1],
    ...tokens.slice(2),
    ...["--ignore-scripts", "--no-audit", "--no-fund"].filter(
      (required) => !tokens.includes(required),
    ),
  ];
}

async function resolveTrustedNpmInvocation(canonicalRoot: string): Promise<TrustedNpmInvocation> {
  const nodeExecutable = await fs.realpath(CAPTURED_NODE_EXECUTABLE);
  if (isContainedPath(canonicalRoot, nodeExecutable)) {
    throw new Error("Trusted Node executable resolves inside the mutable worktree");
  }
  const nodeDirectory = path.dirname(nodeExecutable);
  const candidates = [
    CAPTURED_NPM_EXECUTABLE,
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of [...new Set(candidates)]) {
    try {
      const npmCliPath = await fs.realpath(candidate);
      if (isContainedPath(canonicalRoot, npmCliPath)) continue;
      if ((await fs.stat(npmCliPath)).isFile()) return { executable: nodeExecutable, npmCliPath };
    } catch {
      // Try the next captured, host-owned npm CLI location.
    }
  }
  throw new Error("Unable to resolve a trusted npm CLI outside the mutable worktree");
}

async function prepareSteps(
  canonicalRoot: string,
  explicitSteps: Array<string | WorktreeInitStep> | undefined,
  internalSteps?: PreparedStep[],
  allowShellSteps: boolean = true,
): Promise<PreparedStep[]> {
  if (internalSteps) return internalSteps;
  if (explicitSteps !== undefined) {
    const commands = explicitSteps.map((step) => (typeof step === "string" ? step : step.command));
    const needsNpm = commands.some((command) => parseRecognizedNpmInstall(command));
    const npm = needsNpm ? await resolveTrustedNpmInvocation(canonicalRoot) : undefined;
    return explicitSteps.map((step) => {
      const command = typeof step === "string" ? step : step.command;
      if (typeof step !== "string" && step.env) assertSafeStepEnvironment(step.env);
      const npmArgs = parseRecognizedNpmInstall(command);
      if (!npmArgs && !allowShellSteps) {
        throw new Error(
          `Refusing shell worktree-init step on an existing or resumed branch: ${command}`,
        );
      }
      const invocation =
        npmArgs && npm
          ? { executable: npm.executable, args: [npm.npmCliPath, ...npmArgs] }
          : { command };
      if (typeof step === "string") return { invocation, cwd: ".", label: step };
      return {
        invocation,
        cwd: step.cwd ?? ".",
        label: step.label ?? step.command,
        ...(step.env ? { env: step.env } : {}),
      };
    });
  }

  const packageJsonFiles = await discoverPackageJsonFiles(canonicalRoot);
  const npm =
    packageJsonFiles.length > 0 ? await resolveTrustedNpmInvocation(canonicalRoot) : undefined;
  const steps: PreparedStep[] = [];
  for (const packageJsonPath of packageJsonFiles) {
    const packageDirectory = path.dirname(packageJsonPath);
    const [hasPackageLock, hasShrinkwrap] = await Promise.all([
      fs
        .access(path.join(packageDirectory, "package-lock.json"))
        .then(() => true)
        .catch(() => false),
      fs
        .access(path.join(packageDirectory, "npm-shrinkwrap.json"))
        .then(() => true)
        .catch(() => false),
    ]);
    const install = hasPackageLock || hasShrinkwrap ? "npm ci" : "npm install";
    const relativeDirectory = path.relative(canonicalRoot, packageDirectory) || ".";
    steps.push({
      invocation: {
        executable: npm!.executable,
        args: [
          npm!.npmCliPath,
          hasPackageLock || hasShrinkwrap ? "ci" : "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
      },
      cwd: relativeDirectory,
      label: `${install} (${relativeDirectory})`,
    });
  }
  return steps;
}

function failureResult(step: string, error: unknown): WorktreeInitResult {
  return {
    success: false,
    stepsRun: 0,
    errors: [{ step, message: error instanceof Error ? error.message : String(error) }],
  };
}

const DEPENDENCY_REFRESH_RUNTIME_ROOT = path.join(os.tmpdir(), "quack-dependency-refresh");
const DEPENDENCY_REFRESH_OWNER_FILE = "owner.json";
const DEPENDENCY_REFRESH_JOURNAL_FILE = "transaction.json";
const DEPENDENCY_REFRESH_COMMITTED_FILE = "COMMITTED";
const DEPENDENCY_REFRESH_ABANDONED_FILE = "ABANDONED";
const DEPENDENCY_REFRESH_RECOVERY_CLAIM_SUFFIX = ".recovery-claim";
const DEPENDENCY_REFRESH_LEASE_PREFIX = "LEASE-";
const DEPENDENCY_REFRESH_OWNER_LEASE_MS = 10 * 60 * 1000;
const DEPENDENCY_REFRESH_HEARTBEAT_MS = 60 * 1000;
const DEPENDENCY_REFRESH_ARTIFACT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEPENDENCY_REFRESH_PROCESS_NONCE = randomUUID();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu;
const activeDependencyRefreshOperations = new Set<string>();

interface DependencyRefreshOwnerV1 {
  version: 1;
  pid: number;
  canonicalRoot: string;
  createdAtMs: number;
  leaseExpiresAtMs: number;
}

interface DependencyRefreshOwnerV2 {
  version: 2;
  pid: number;
  processNonce: string;
  operationNonce: string;
  canonicalRoot: string;
  createdAtMs: number;
  leaseExpiresAtMs: number;
}

type DependencyRefreshOwner = DependencyRefreshOwnerV1 | DependencyRefreshOwnerV2;

interface DependencyRefreshAbandonedRecord {
  version: 1;
  canonicalRoot: string;
  processNonce: string;
  operationNonce: string;
  abandonedAtMs: number;
}

interface DependencyRefreshLeaseRecord {
  version: 1;
  canonicalRoot: string;
  processNonce: string;
  operationNonce: string;
  renewedAtMs: number;
  leaseExpiresAtMs: number;
}

interface DependencyRefreshLeaseController {
  stopped: boolean;
  timer?: NodeJS.Timeout;
  pending: Promise<void>;
  error?: Error;
}

const dependencyRefreshLeaseControllers = new Map<string, DependencyRefreshLeaseController>();

interface DependencyRefreshJournalItem {
  cwd: string;
  packageDirectory: string;
  stagingDirectory: string;
  stagedNodeModules: string;
  targetNodeModules: string;
  backupNodeModules: string;
  hadTarget: boolean;
  requiresNodeModules: boolean;
  operation?: "install" | "remove";
}

interface DependencyRefreshJournal {
  version: 1;
  transactionId: string;
  canonicalRoot: string;
  items: DependencyRefreshJournalItem[];
}

interface DependencyRefreshLock {
  directory: string;
  journalPath: string;
  committedPath: string;
  abandonedPath: string;
  owner: DependencyRefreshOwnerV2;
}

interface DependencyRefreshRecoveryClaim {
  directory: string;
  owner: DependencyRefreshOwnerV2;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs
    .lstat(candidate)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathContainsExcludedDirectory(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "." && segment !== "")
    .some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()));
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith(`..${path.sep}`) &&
      leftToRight !== ".." &&
      !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${path.sep}`) &&
      rightToLeft !== ".." &&
      !path.isAbsolute(rightToLeft))
  );
}

function assertNonOverlappingDependencyRefreshItems(items: DependencyRefreshJournalItem[]): void {
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex];
    if (!left) continue;
    const leftPaths = [left.stagingDirectory, left.targetNodeModules, left.backupNodeModules];
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex];
      if (!right) continue;
      const rightPaths = [right.stagingDirectory, right.targetNodeModules, right.backupNodeModules];
      if (
        leftPaths.some((leftPath) =>
          rightPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)),
        )
      ) {
        throw new Error(
          `Dependency refresh transaction paths overlap for ${left.cwd} and ${right.cwd}`,
        );
      }
    }
  }
}

async function readSmallPhysicalJson(filePath: string, label: string): Promise<unknown> {
  const metadata = await fs.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1024 * 1024) {
    throw new Error(`${label} must be a small physical file`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function writeDurableNewFile(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening a directory for fsync through Node. The
  // file itself is still flushed before its final hard-link is published.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

dependencyRefreshDirectorySync = syncDirectory;

/** Publish a complete file without ever exposing a partially written final path. */
async function writeDurableNewFileAtomically(filePath: string, content: string): Promise<void> {
  const pendingPath = `${filePath}.pending-${randomUUID()}`;
  let pendingCreated = false;
  try {
    const handle = await fs.open(pendingPath, "wx", 0o600);
    pendingCreated = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    // A hard link is an atomic no-replace publication on every supported host.
    await atomicFilePublisher(pendingPath, filePath);
    await syncDirectory(path.dirname(filePath));
    await fs.unlink(pendingPath);
    pendingCreated = false;
    await syncDirectory(path.dirname(filePath));
  } catch (error: unknown) {
    if (pendingCreated) {
      try {
        await fs.unlink(pendingPath);
      } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; atomic publication cleanup failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
            { cause: error },
          );
        }
      }
    }
    throw error;
  }
}

async function physicalContainedDirectoryExists(
  canonicalRoot: string,
  candidate: string,
  label: string,
): Promise<boolean> {
  let metadata;
  try {
    metadata = await fs.lstat(candidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a physical directory`);
  }
  const canonical = await fs.realpath(candidate);
  if (!isContainedPath(canonicalRoot, canonical)) {
    throw new Error(`${label} resolves outside the worktree`);
  }
  if (!sameCanonicalPath(canonical, path.resolve(candidate))) {
    throw new Error(`${label} uses a filesystem alias`);
  }
  return true;
}

async function removePhysicalContainedTree(
  canonicalRoot: string,
  candidate: string,
  label: string,
): Promise<void> {
  if (!(await physicalContainedDirectoryExists(canonicalRoot, candidate, label))) return;
  await fs.rm(candidate, { recursive: true, force: true });
}

function dependencyRefreshLockKey(canonicalRoot: string): string {
  const identity = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return createHash("sha256").update(identity).digest("hex");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseDependencyRefreshJournal(
  value: unknown,
  canonicalRoot: string,
): DependencyRefreshJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Dependency refresh journal is not an object");
  }
  const candidate = value as Partial<DependencyRefreshJournal>;
  if (
    candidate.version !== 1 ||
    typeof candidate.transactionId !== "string" ||
    !UUID_PATTERN.test(candidate.transactionId) ||
    typeof candidate.canonicalRoot !== "string" ||
    !sameCanonicalPath(candidate.canonicalRoot, canonicalRoot) ||
    !Array.isArray(candidate.items)
  ) {
    throw new Error("Dependency refresh journal identity is invalid");
  }
  const items = candidate.items.map((raw, index): DependencyRefreshJournalItem => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Dependency refresh journal item ${index} is invalid`);
    }
    const item = raw as Partial<DependencyRefreshJournalItem>;
    if (
      typeof item.cwd !== "string" ||
      typeof item.packageDirectory !== "string" ||
      typeof item.stagingDirectory !== "string" ||
      typeof item.stagedNodeModules !== "string" ||
      typeof item.targetNodeModules !== "string" ||
      typeof item.backupNodeModules !== "string" ||
      typeof item.hadTarget !== "boolean" ||
      typeof item.requiresNodeModules !== "boolean" ||
      (item.operation !== undefined && item.operation !== "install" && item.operation !== "remove")
    ) {
      throw new Error(`Dependency refresh journal item ${index} is incomplete`);
    }
    const expectedPackageDirectory = path.resolve(canonicalRoot, item.cwd);
    const expectedStagingDirectory = path.join(
      expectedPackageDirectory,
      `.quack-dependency-refresh-${candidate.transactionId}-${index}`,
    );
    const expectedTarget = path.join(expectedPackageDirectory, "node_modules");
    const expectedBackup = path.join(
      expectedPackageDirectory,
      `.quack-node-modules-backup-${candidate.transactionId}-${index}`,
    );
    if (
      path.isAbsolute(item.cwd) ||
      path.win32.isAbsolute(item.cwd) ||
      pathContainsExcludedDirectory(item.cwd) ||
      !isContainedPath(canonicalRoot, expectedPackageDirectory) ||
      !sameCanonicalPath(item.packageDirectory, expectedPackageDirectory) ||
      !sameCanonicalPath(item.stagingDirectory, expectedStagingDirectory) ||
      !sameCanonicalPath(
        item.stagedNodeModules,
        path.join(expectedStagingDirectory, "node_modules"),
      ) ||
      !sameCanonicalPath(item.targetNodeModules, expectedTarget) ||
      !sameCanonicalPath(item.backupNodeModules, expectedBackup)
    ) {
      throw new Error(`Dependency refresh journal item ${index} contains unsafe paths`);
    }
    return { ...item, operation: item.operation ?? "install" } as DependencyRefreshJournalItem;
  });
  assertNonOverlappingDependencyRefreshItems(items);
  return { ...candidate, items } as DependencyRefreshJournal;
}

async function dependencyRefreshIsCommitted(
  transactionDirectory: string,
  transactionId: string,
): Promise<boolean> {
  const markerPath = path.join(transactionDirectory, DEPENDENCY_REFRESH_COMMITTED_FILE);
  let metadata;
  try {
    metadata = await fs.lstat(markerPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 128) {
    throw new Error("Dependency refresh commit marker must be a small physical file");
  }
  const content = await fs.readFile(markerPath, "utf8");
  if (content !== `${transactionId}\n`) {
    throw new Error("Dependency refresh commit marker does not match its transaction");
  }
  return true;
}

async function recoverDependencyRefreshTransaction(
  canonicalRoot: string,
  transactionDirectory: string,
): Promise<void> {
  const journalPath = path.join(transactionDirectory, DEPENDENCY_REFRESH_JOURNAL_FILE);
  if (!(await pathExists(journalPath))) {
    await fs.rm(transactionDirectory, { recursive: true, force: true });
    return;
  }
  const journal = parseDependencyRefreshJournal(
    await readSmallPhysicalJson(journalPath, "dependency refresh journal"),
    canonicalRoot,
  );
  const committed = await dependencyRefreshIsCommitted(transactionDirectory, journal.transactionId);

  if (committed) {
    for (const item of journal.items) {
      const targetExists = await physicalContainedDirectoryExists(
        canonicalRoot,
        item.targetNodeModules,
        "committed dependencies",
      );
      if (item.operation === "remove" && targetExists) {
        throw new Error(`Committed dependency removal still has node_modules for ${item.cwd}`);
      }
      if (item.operation !== "remove" && item.requiresNodeModules && !targetExists) {
        throw new Error(`Committed dependency refresh is missing node_modules for ${item.cwd}`);
      }
      await removePhysicalContainedTree(canonicalRoot, item.backupNodeModules, "dependency backup");
      await removePhysicalContainedTree(canonicalRoot, item.stagingDirectory, "dependency staging");
      await dependencyRefreshDirectorySync(item.packageDirectory);
    }
  } else {
    for (const item of [...journal.items].reverse()) {
      const backupExists = await physicalContainedDirectoryExists(
        canonicalRoot,
        item.backupNodeModules,
        "dependency backup",
      );
      const targetExists = await physicalContainedDirectoryExists(
        canonicalRoot,
        item.targetNodeModules,
        "dependency target",
      );
      if (item.hadTarget) {
        if (backupExists) {
          await removePhysicalContainedTree(
            canonicalRoot,
            item.targetNodeModules,
            "new dependencies",
          );
          await dependencyRefreshRename(item.backupNodeModules, item.targetNodeModules);
        } else if (!targetExists) {
          throw new Error(`Cannot recover the prior dependency tree for ${item.cwd}`);
        }
      } else {
        if (backupExists) {
          throw new Error(`Unexpected dependency backup exists for ${item.cwd}`);
        }
        await removePhysicalContainedTree(
          canonicalRoot,
          item.targetNodeModules,
          "new dependencies",
        );
      }
      await removePhysicalContainedTree(canonicalRoot, item.stagingDirectory, "dependency staging");
      await dependencyRefreshDirectorySync(item.packageDirectory);
    }
  }
  await fs.rm(transactionDirectory, { recursive: true, force: true });
  await dependencyRefreshDirectorySync(path.dirname(transactionDirectory));
}

function createDependencyRefreshOwner(canonicalRoot: string): DependencyRefreshOwnerV2 {
  const createdAtMs = Date.now();
  const owner: DependencyRefreshOwnerV2 = {
    version: 2,
    pid: process.pid,
    processNonce: DEPENDENCY_REFRESH_PROCESS_NONCE,
    operationNonce: randomUUID(),
    canonicalRoot,
    createdAtMs,
    leaseExpiresAtMs: createdAtMs + DEPENDENCY_REFRESH_OWNER_LEASE_MS,
  };
  activeDependencyRefreshOperations.add(owner.operationNonce);
  return owner;
}

async function publishDependencyRefreshLease(
  directory: string,
  owner: DependencyRefreshOwnerV2,
): Promise<void> {
  const renewedAtMs = Date.now();
  const lease: DependencyRefreshLeaseRecord = {
    version: 1,
    canonicalRoot: owner.canonicalRoot,
    processNonce: owner.processNonce,
    operationNonce: owner.operationNonce,
    renewedAtMs,
    leaseExpiresAtMs: renewedAtMs + DEPENDENCY_REFRESH_OWNER_LEASE_MS,
  };
  await writeDurableNewFile(
    path.join(
      directory,
      `${DEPENDENCY_REFRESH_LEASE_PREFIX}${owner.operationNonce}-${randomUUID()}.json`,
    ),
    JSON.stringify(lease),
  );
  await dependencyRefreshDirectorySync(directory);
}

function startDependencyRefreshLease(directory: string, owner: DependencyRefreshOwnerV2): void {
  const controller: DependencyRefreshLeaseController = {
    stopped: false,
    pending: Promise.resolve(),
  };
  controller.timer = setInterval(() => {
    if (controller.stopped) return;
    controller.pending = controller.pending
      .then(async () => {
        if (controller.stopped) return;
        await publishDependencyRefreshLease(directory, owner);
        controller.error = undefined;
      })
      .catch((error: unknown) => {
        controller.error = error instanceof Error ? error : new Error(String(error));
      });
  }, DEPENDENCY_REFRESH_HEARTBEAT_MS);
  controller.timer.unref();
  dependencyRefreshLeaseControllers.set(owner.operationNonce, controller);
}

function assertDependencyRefreshLeaseHealthy(owner: DependencyRefreshOwnerV2): void {
  const error = dependencyRefreshLeaseControllers.get(owner.operationNonce)?.error;
  if (error) {
    throw new Error(`Dependency refresh lease renewal failed: ${error.message}`, { cause: error });
  }
}

async function releaseDependencyRefreshOwner(owner: DependencyRefreshOwnerV2): Promise<void> {
  const controller = dependencyRefreshLeaseControllers.get(owner.operationNonce);
  if (controller) {
    controller.stopped = true;
    if (controller.timer) clearInterval(controller.timer);
    await controller.pending;
    dependencyRefreshLeaseControllers.delete(owner.operationNonce);
  }
  activeDependencyRefreshOperations.delete(owner.operationNonce);
}

async function readDependencyRefreshLeaseExpiry(
  directory: string,
  owner: DependencyRefreshOwnerV2,
): Promise<number> {
  let leaseExpiresAtMs = owner.leaseExpiresAtMs;
  const expectedPrefix = `${DEPENDENCY_REFRESH_LEASE_PREFIX}${owner.operationNonce}-`;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(expectedPrefix)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Dependency refresh lease must be a small physical file");
    }
    const lease = (await readSmallPhysicalJson(
      path.join(directory, entry.name),
      "dependency refresh lease",
    )) as Partial<DependencyRefreshLeaseRecord>;
    if (
      lease.version !== 1 ||
      typeof lease.canonicalRoot !== "string" ||
      !sameCanonicalPath(lease.canonicalRoot, owner.canonicalRoot) ||
      lease.processNonce !== owner.processNonce ||
      lease.operationNonce !== owner.operationNonce ||
      typeof lease.renewedAtMs !== "number" ||
      !Number.isSafeInteger(lease.renewedAtMs) ||
      typeof lease.leaseExpiresAtMs !== "number" ||
      !Number.isSafeInteger(lease.leaseExpiresAtMs) ||
      lease.leaseExpiresAtMs < lease.renewedAtMs ||
      lease.leaseExpiresAtMs - lease.renewedAtMs > DEPENDENCY_REFRESH_OWNER_LEASE_MS + 1_000 ||
      lease.renewedAtMs > Date.now() + DEPENDENCY_REFRESH_HEARTBEAT_MS
    ) {
      throw new Error("Dependency refresh lease does not match its owner");
    }
    leaseExpiresAtMs = Math.max(leaseExpiresAtMs, lease.leaseExpiresAtMs);
  }
  return leaseExpiresAtMs;
}

async function readDependencyRefreshOwner(
  directory: string,
  canonicalRoot: string,
  label: string,
): Promise<DependencyRefreshOwner> {
  const ownerPath = path.join(directory, DEPENDENCY_REFRESH_OWNER_FILE);
  const metadata = await fs.lstat(ownerPath);
  const owner = (await readSmallPhysicalJson(ownerPath, label)) as {
    version?: unknown;
    pid?: unknown;
    processNonce?: unknown;
    operationNonce?: unknown;
    canonicalRoot?: unknown;
    createdAtMs?: unknown;
    leaseExpiresAtMs?: unknown;
  };
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.canonicalRoot !== "string" ||
    !sameCanonicalPath(owner.canonicalRoot, canonicalRoot)
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (owner.version === 1) {
    return {
      version: 1,
      pid: owner.pid as number,
      canonicalRoot: owner.canonicalRoot,
      createdAtMs: metadata.mtimeMs,
      leaseExpiresAtMs: metadata.mtimeMs + DEPENDENCY_REFRESH_OWNER_LEASE_MS,
    };
  }
  if (
    owner.version !== 2 ||
    typeof owner.processNonce !== "string" ||
    !UUID_PATTERN.test(owner.processNonce) ||
    typeof owner.operationNonce !== "string" ||
    !UUID_PATTERN.test(owner.operationNonce) ||
    typeof owner.createdAtMs !== "number" ||
    !Number.isSafeInteger(owner.createdAtMs) ||
    typeof owner.leaseExpiresAtMs !== "number" ||
    !Number.isSafeInteger(owner.leaseExpiresAtMs) ||
    owner.leaseExpiresAtMs < owner.createdAtMs
  ) {
    throw new Error(`${label} is invalid`);
  }
  const validatedOwner = owner as DependencyRefreshOwnerV2;
  if (
    validatedOwner.createdAtMs > Date.now() + DEPENDENCY_REFRESH_HEARTBEAT_MS ||
    validatedOwner.leaseExpiresAtMs - validatedOwner.createdAtMs >
      DEPENDENCY_REFRESH_OWNER_LEASE_MS + 1_000
  ) {
    throw new Error(`${label} lease is invalid`);
  }
  validatedOwner.leaseExpiresAtMs = await readDependencyRefreshLeaseExpiry(
    directory,
    validatedOwner,
  );
  return validatedOwner;
}

function dependencyRefreshOwnerIsActive(owner: DependencyRefreshOwner): boolean {
  if (owner.pid === process.pid) {
    if (owner.version === 1) return Date.now() <= owner.leaseExpiresAtMs;
    return (
      owner.processNonce === DEPENDENCY_REFRESH_PROCESS_NONCE &&
      activeDependencyRefreshOperations.has(owner.operationNonce)
    );
  }
  return processIsAlive(owner.pid) && Date.now() <= owner.leaseExpiresAtMs;
}

async function dependencyRefreshIsAbandoned(
  lockDirectory: string,
  owner: DependencyRefreshOwner,
): Promise<boolean> {
  const markerPath = path.join(lockDirectory, DEPENDENCY_REFRESH_ABANDONED_FILE);
  let metadata;
  try {
    metadata = await fs.lstat(markerPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1024 * 1024) {
    throw new Error("Dependency refresh abandonment marker must be a small physical file");
  }
  if (owner.version === 1) {
    if ((await fs.readFile(markerPath, "utf8")) !== "recovery required\n") {
      throw new Error("Legacy dependency refresh abandonment marker is invalid");
    }
    if (dependencyRefreshOwnerIsActive(owner)) {
      throw new Error("Legacy dependency refresh abandonment marker cannot bypass a live owner");
    }
    return true;
  }
  const marker = (await readSmallPhysicalJson(
    markerPath,
    "dependency refresh abandonment marker",
  )) as Partial<DependencyRefreshAbandonedRecord>;
  if (
    marker.version !== 1 ||
    typeof marker.canonicalRoot !== "string" ||
    !sameCanonicalPath(marker.canonicalRoot, owner.canonicalRoot) ||
    marker.processNonce !== owner.processNonce ||
    marker.operationNonce !== owner.operationNonce ||
    typeof marker.abandonedAtMs !== "number" ||
    !Number.isSafeInteger(marker.abandonedAtMs)
  ) {
    throw new Error("Dependency refresh abandonment marker does not match its owner");
  }
  return true;
}

async function assertDependencyRefreshLockRecoverable(
  lockDirectory: string,
  canonicalRoot: string,
): Promise<void> {
  const owner = await readDependencyRefreshOwner(
    lockDirectory,
    canonicalRoot,
    "dependency refresh owner",
  );
  const abandoned = await dependencyRefreshIsAbandoned(lockDirectory, owner);
  if (!abandoned && dependencyRefreshOwnerIsActive(owner)) {
    throw new Error(`Another dependency refresh is active for this worktree (PID ${owner.pid})`);
  }
}

async function scavengeDependencyRefreshArtifacts(
  runtimeRoot: string,
  key: string,
  canonicalRoot: string,
): Promise<void> {
  const artifactPattern = new RegExp(
    `^${key}\\.(?:candidate-[a-z0-9_-]+|recovery-claim\\.(?:candidate-[a-z0-9_-]+|stale-[0-9a-f-]+))$`,
    "iu",
  );
  const now = Date.now();
  for (const entry of await fs.readdir(runtimeRoot, { withFileTypes: true })) {
    if (!artifactPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    const artifactPath = path.join(runtimeRoot, entry.name);
    let metadata;
    let owner: DependencyRefreshOwner;
    try {
      metadata = await fs.lstat(artifactPath);
      owner = await readDependencyRefreshOwner(
        artifactPath,
        canonicalRoot,
        "stale dependency refresh artifact owner",
      );
    } catch {
      // Invalid, aliased, or wrong-project artifacts are retained for manual review.
      continue;
    }
    const ageReference = Math.max(metadata.mtimeMs, owner.createdAtMs);
    if (
      now - ageReference < DEPENDENCY_REFRESH_ARTIFACT_GRACE_MS ||
      dependencyRefreshOwnerIsActive(owner)
    ) {
      continue;
    }
    const quarantinedPath = path.join(
      runtimeRoot,
      `${key}${DEPENDENCY_REFRESH_RECOVERY_CLAIM_SUFFIX}.stale-${randomUUID()}`,
    );
    try {
      await fs.rename(artifactPath, quarantinedPath);
      await dependencyRefreshDirectorySync(runtimeRoot);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await removePhysicalContainedTree(
      runtimeRoot,
      quarantinedPath,
      "stale dependency refresh artifact",
    );
  }
}

async function acquireDependencyRefreshRecoveryClaim(
  runtimeRoot: string,
  key: string,
  canonicalRoot: string,
): Promise<DependencyRefreshRecoveryClaim> {
  const claimDirectory = path.join(
    runtimeRoot,
    `${key}${DEPENDENCY_REFRESH_RECOVERY_CLAIM_SUFFIX}`,
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await fs.mkdtemp(
      path.join(runtimeRoot, `${key}${DEPENDENCY_REFRESH_RECOVERY_CLAIM_SUFFIX}.candidate-`),
    );
    const owner = createDependencyRefreshOwner(canonicalRoot);
    try {
      await writeDurableNewFile(
        path.join(candidate, DEPENDENCY_REFRESH_OWNER_FILE),
        JSON.stringify(owner),
      );
      await dependencyRefreshDirectorySync(candidate);
      await fs.rename(candidate, claimDirectory);
      await dependencyRefreshDirectorySync(runtimeRoot);
      startDependencyRefreshLease(claimDirectory, owner);
      return { directory: claimDirectory, owner };
    } catch (error: unknown) {
      await releaseDependencyRefreshOwner(owner);
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      if (
        !(["EEXIST", "ENOTEMPTY", "EPERM"] as Array<string | undefined>).includes(
          (error as NodeJS.ErrnoException).code,
        )
      ) {
        throw error;
      }
    }

    const existingOwner = await readDependencyRefreshOwner(
      claimDirectory,
      canonicalRoot,
      "dependency refresh recovery owner",
    );
    if (dependencyRefreshOwnerIsActive(existingOwner)) {
      throw new Error(
        `Another dependency refresh recovery is active for this worktree (PID ${existingOwner.pid})`,
      );
    }

    const staleClaim = path.join(
      runtimeRoot,
      `${key}${DEPENDENCY_REFRESH_RECOVERY_CLAIM_SUFFIX}.stale-${randomUUID()}`,
    );
    try {
      await fs.rename(claimDirectory, staleClaim);
      await dependencyRefreshDirectorySync(runtimeRoot);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await removePhysicalContainedTree(runtimeRoot, staleClaim, "stale dependency recovery claim");
  }
  throw new Error("Could not acquire dependency refresh recovery claim");
}

async function legacyDependencyRefreshRecoveryDirectory(
  runtimeRoot: string,
  key: string,
): Promise<string | undefined> {
  const legacyPattern = new RegExp(
    `^${key}\\.recovery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    "iu",
  );
  const matches = (await fs.readdir(runtimeRoot, { withFileTypes: true })).filter((entry) =>
    legacyPattern.test(entry.name),
  );
  if (matches.length > 1) {
    throw new Error("Multiple legacy dependency refresh recovery barriers require manual review");
  }
  const match = matches[0];
  if (!match) return undefined;
  if (!match.isDirectory() || match.isSymbolicLink()) {
    throw new Error("Legacy dependency refresh recovery barrier must be a physical directory");
  }
  return path.join(runtimeRoot, match.name);
}

async function recoverDependencyRefreshWithClaim(
  runtimeRoot: string,
  key: string,
  canonicalRoot: string,
  lockDirectory: string,
  legacyRecoveryDirectory?: string,
): Promise<void> {
  const recoveryClaim = await acquireDependencyRefreshRecoveryClaim(
    runtimeRoot,
    key,
    canonicalRoot,
  );
  let recoveryError: unknown;
  try {
    assertDependencyRefreshLeaseHealthy(recoveryClaim.owner);
    if (legacyRecoveryDirectory) {
      if (await pathExists(lockDirectory)) {
        throw new Error("Canonical and legacy dependency recovery barriers both exist");
      }
      // Restore the old implementation's orphan to the canonical path before
      // touching any transaction state. Subsequent crashes remain fenced.
      await fs.rename(legacyRecoveryDirectory, lockDirectory);
      await dependencyRefreshDirectorySync(runtimeRoot);
    }
    if (await pathExists(lockDirectory)) {
      await assertDependencyRefreshLockRecoverable(lockDirectory, canonicalRoot);
      await recoverDependencyRefreshTransaction(canonicalRoot, lockDirectory);
    }
  } catch (error: unknown) {
    recoveryError = error;
  }
  let claimCleanupError: unknown;
  try {
    await removePhysicalContainedTree(
      runtimeRoot,
      recoveryClaim.directory,
      "dependency recovery claim",
    );
    await dependencyRefreshDirectorySync(runtimeRoot);
  } catch (error: unknown) {
    claimCleanupError = error;
  } finally {
    // Retained claims no longer identify a live operation after this attempt.
    // A same-process retry can therefore quarantine and replace them.
    await releaseDependencyRefreshOwner(recoveryClaim.owner);
  }
  if (recoveryError || claimCleanupError) {
    const primary = recoveryError ?? claimCleanupError;
    const suffix =
      recoveryError && claimCleanupError
        ? `; recovery claim cleanup failed: ${
            claimCleanupError instanceof Error
              ? claimCleanupError.message
              : typeof claimCleanupError === "string"
                ? claimCleanupError
                : "unknown recovery claim cleanup error"
          }`
        : "";
    throw new Error(`${primary instanceof Error ? primary.message : String(primary)}${suffix}`, {
      cause: primary,
    });
  }
}

async function acquireDependencyRefreshLock(canonicalRoot: string): Promise<DependencyRefreshLock> {
  await fs.mkdir(DEPENDENCY_REFRESH_RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  const runtimeMetadata = await fs.lstat(DEPENDENCY_REFRESH_RUNTIME_ROOT);
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) {
    throw new Error("Dependency refresh runtime root must be a physical directory");
  }
  const runtimeRoot = await fs.realpath(DEPENDENCY_REFRESH_RUNTIME_ROOT);
  const key = dependencyRefreshLockKey(canonicalRoot);
  const lockDirectory = path.join(runtimeRoot, key);
  await scavengeDependencyRefreshArtifacts(runtimeRoot, key, canonicalRoot);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const legacyRecoveryDirectory = await legacyDependencyRefreshRecoveryDirectory(
      runtimeRoot,
      key,
    );
    if (legacyRecoveryDirectory) {
      await recoverDependencyRefreshWithClaim(
        runtimeRoot,
        key,
        canonicalRoot,
        lockDirectory,
        legacyRecoveryDirectory,
      );
      continue;
    }

    const candidate = await fs.mkdtemp(path.join(runtimeRoot, `${key}.candidate-`));
    const owner = createDependencyRefreshOwner(canonicalRoot);
    try {
      await writeDurableNewFile(
        path.join(candidate, DEPENDENCY_REFRESH_OWNER_FILE),
        JSON.stringify(owner),
      );
      await dependencyRefreshDirectorySync(candidate);
      await fs.rename(candidate, lockDirectory);
      await dependencyRefreshDirectorySync(runtimeRoot);
      startDependencyRefreshLease(lockDirectory, owner);
      return {
        directory: lockDirectory,
        journalPath: path.join(lockDirectory, DEPENDENCY_REFRESH_JOURNAL_FILE),
        committedPath: path.join(lockDirectory, DEPENDENCY_REFRESH_COMMITTED_FILE),
        abandonedPath: path.join(lockDirectory, DEPENDENCY_REFRESH_ABANDONED_FILE),
        owner,
      };
    } catch (error: unknown) {
      await releaseDependencyRefreshOwner(owner);
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      if (
        !(["EEXIST", "ENOTEMPTY", "EPERM"] as Array<string | undefined>).includes(
          (error as NodeJS.ErrnoException).code,
        )
      ) {
        throw error;
      }
    }

    await assertDependencyRefreshLockRecoverable(lockDirectory, canonicalRoot);
    // Keep the canonical transaction directory in place for the entire
    // recovery. If this process also crashes, the next owner sees the same
    // journal and can retry instead of bypassing an orphaned random path.
    await recoverDependencyRefreshWithClaim(runtimeRoot, key, canonicalRoot, lockDirectory);
  }
  throw new Error("Could not acquire dependency refresh transaction lock");
}

function unsafeDependencySpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed.startsWith("npm:")) {
    const alias = trimmed.slice(4);
    const packageAndRange =
      /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/i.exec(
        alias,
      );
    if (!packageAndRange) return true;
    const range = packageAndRange[1];
    return range !== undefined && /[:\\/\0\r\n]/.test(range);
  }
  return (
    /^(?:[a-z][a-z0-9+.-]*:|git@|\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(trimmed) ||
    /[\\\0\r\n]/.test(trimmed) ||
    /^[^@\s/]+\/[^/\s]+(?:#.*)?$/.test(trimmed)
  );
}

async function assertContainedRegularFile(
  canonicalRoot: string,
  filePath: string,
  label: string,
): Promise<void> {
  const metadata = await fs.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a filesystem alias`);
  }
  const canonicalFile = await fs.realpath(filePath);
  if (!isContainedPath(canonicalRoot, canonicalFile)) {
    throw new Error(`${label} resolves outside the worktree`);
  }
}

function findUnsafeResolvedUrl(value: unknown, location: string = "lockfile"): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findUnsafeResolvedUrl(value[index], `${location}[${index}]`);
      if (finding) return finding;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === "resolved" && typeof child === "string") {
      try {
        const resolved = new URL(child);
        if (resolved.protocol !== "https:" || resolved.hostname !== "registry.npmjs.org") {
          return `${childLocation} uses non-public-registry URL ${child}`;
        }
      } catch {
        return `${childLocation} uses non-URL or local resolution ${child}`;
      }
    }
    const finding = findUnsafeResolvedUrl(child, childLocation);
    if (finding) return finding;
  }
  return undefined;
}

function findUnsafeOverride(value: unknown, location: string = "overrides"): string | undefined {
  if (typeof value === "string") {
    return value !== "." && unsafeDependencySpec(value)
      ? `${location} uses unsafe dependency spec ${value}`
      : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${location} has an invalid override value`;
  }
  for (const [key, child] of Object.entries(value)) {
    const finding = findUnsafeOverride(child, `${location}.${key}`);
    if (finding) return finding;
  }
  return undefined;
}

async function validatePostWorkerPackageMetadata(
  canonicalRoot: string,
  packageDirectory: string,
): Promise<void> {
  let current = packageDirectory;
  while (isContainedPath(canonicalRoot, current)) {
    const hasProjectNpmrc = await fs
      .access(path.join(current, ".npmrc"))
      .then(() => true)
      .catch(() => false);
    if (hasProjectNpmrc) {
      throw new Error(`Project .npmrc is not allowed during safe dependency refresh: ${current}`);
    }
    if (current === canonicalRoot) break;
    current = path.dirname(current);
  }

  const packageJsonPath = path.join(packageDirectory, "package.json");
  await assertContainedRegularFile(canonicalRoot, packageJsonPath, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (packageJson.workspaces !== undefined) {
    throw new Error("package.json workspaces are not allowed during safe dependency refresh");
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = packageJson[field];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
      continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || unsafeDependencySpec(spec)) {
        throw new Error(`Unsafe ${field} spec for ${name}: ${String(spec)}`);
      }
    }
  }
  if (packageJson.overrides !== undefined) {
    const finding = findUnsafeOverride(packageJson.overrides);
    if (finding) throw new Error(finding);
  }

  for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lockPath = path.join(packageDirectory, lockName);
    let text: string;
    try {
      await assertContainedRegularFile(canonicalRoot, lockPath, lockName);
      text = await fs.readFile(lockPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const finding = findUnsafeResolvedUrl(JSON.parse(text) as unknown, lockName);
    if (finding) throw new Error(finding);
  }
}

async function packageManifestRequiresNodeModules(packageDirectory: string): Promise<boolean> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = packageJson[field];
    if (
      typeof dependencies === "object" &&
      dependencies !== null &&
      !Array.isArray(dependencies) &&
      Object.keys(dependencies).length > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Run initialization after worktree selection.
 *
 * - `undefined`: auto-discover npm packages up to three levels deep.
 * - non-empty array: run only the configured steps, in order.
 * - `[]`: disable initialization explicitly.
 *
 * Every cwd must remain under the canonical worktree even through filesystem
 * aliases. Commands receive a stripped environment and npm lifecycle scripts
 * are disabled. Errors are returned as structured evidence.
 */
export async function runWorktreeInit(
  worktreePath: string,
  explicitSteps?: Array<string | WorktreeInitStep>,
  events?: IEventWriter,
  executionOptions: WorktreeInitExecutionOptions = {},
): Promise<WorktreeInitResult> {
  const mode = executionOptions.preparedSteps
    ? "explicit"
    : explicitSteps === undefined
      ? "auto"
      : explicitSteps.length === 0
        ? "disabled"
        : "explicit";
  const phase = executionOptions.phase ?? "initial";
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(path.resolve(worktreePath));
    if (!(await fs.stat(canonicalRoot)).isDirectory())
      throw new Error("worktree root is not a directory");
  } catch (error: unknown) {
    const result = failureResult("worktree root", error);
    if (executionOptions.emitCompletion !== false) {
      emitBestEffort(
        events,
        "worktree_init_complete" as Parameters<IEventWriter["emit"]>[0],
        {
          success: false,
          stepsRun: 0,
          errorCount: 1,
          mode,
          phase,
        } as Parameters<IEventWriter["emit"]>[1],
      );
    }
    return result;
  }

  if (
    !executionOptions.preparedSteps &&
    explicitSteps !== undefined &&
    explicitSteps.length === 0
  ) {
    emitBestEffort(
      events,
      "worktree_init_start" as Parameters<IEventWriter["emit"]>[0],
      {
        worktreePath: canonicalRoot,
        mode,
        phase,
        stepCount: 0,
      } as Parameters<IEventWriter["emit"]>[1],
    );
    if (executionOptions.emitCompletion !== false) {
      emitBestEffort(
        events,
        "worktree_init_complete" as Parameters<IEventWriter["emit"]>[0],
        {
          success: true,
          stepsRun: 0,
          errorCount: 0,
          mode,
          phase,
        } as Parameters<IEventWriter["emit"]>[1],
      );
    }
    return { success: true, stepsRun: 0, errors: [] };
  }

  let preparedEnvironment: { env: NodeJS.ProcessEnv; cleanupRoot?: string } | undefined;
  let initResult: WorktreeInitResult;
  try {
    const steps = await prepareSteps(
      canonicalRoot,
      explicitSteps,
      executionOptions.preparedSteps,
      executionOptions.allowShellSteps ?? true,
    );
    emitBestEffort(
      events,
      "worktree_init_start" as Parameters<IEventWriter["emit"]>[0],
      {
        worktreePath: canonicalRoot,
        mode,
        phase,
        stepCount: steps.length,
      } as Parameters<IEventWriter["emit"]>[1],
    );

    preparedEnvironment = await prepareExecutionEnvironment(executionOptions.baseEnv);
    const errors: WorktreeInitResult["errors"] = [];
    let stepsRun = 0;
    for (const step of steps) {
      let cwd: string;
      try {
        cwd = await resolveContainedDirectory(canonicalRoot, worktreePath, step.cwd);
        if (executionOptions.validateNpmMetadata && "executable" in step.invocation) {
          await validatePostWorkerPackageMetadata(canonicalRoot, cwd);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        stepsRun += 1;
        errors.push({ step: step.label, message });
        emitBestEffort(
          events,
          "worktree_init_step_failed" as Parameters<IEventWriter["emit"]>[0],
          {
            step: step.label,
            stderr: message,
            durationMs: 0,
            phase,
          } as Parameters<IEventWriter["emit"]>[1],
        );
        continue;
      }

      stepsRun += 1;
      const startedAt = Date.now();
      const result = await execStep(step.invocation, cwd, preparedEnvironment.env, step.env);
      const durationMs = Date.now() - startedAt;
      if (result.exitCode === 0 && result.descendantsContained) {
        emitBestEffort(
          events,
          "worktree_init_step_complete" as Parameters<IEventWriter["emit"]>[0],
          {
            step: step.label,
            durationMs,
            phase,
          } as Parameters<IEventWriter["emit"]>[1],
        );
        continue;
      }

      const message =
        result.stderr ||
        (result.descendantsContained
          ? `Command exited with code ${result.exitCode}`
          : "Process-tree containment could not be verified");
      errors.push({ step: step.label, message, exitCode: result.exitCode });
      emitBestEffort(
        events,
        "worktree_init_step_failed" as Parameters<IEventWriter["emit"]>[0],
        {
          step: step.label,
          exitCode: result.exitCode,
          stderr: message,
          durationMs,
          phase,
          timedOut: result.timedOut,
          descendantsContained: result.descendantsContained,
        } as Parameters<IEventWriter["emit"]>[1],
      );
      if (!result.descendantsContained) break;
    }

    initResult = { success: errors.length === 0, stepsRun, errors };
  } catch (error: unknown) {
    initResult = failureResult("worktree initialization", error);
  }

  if (preparedEnvironment?.cleanupRoot) {
    try {
      await environmentCleanup(preparedEnvironment.cleanupRoot);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      initResult = {
        success: false,
        stepsRun: initResult.stepsRun,
        errors: [...initResult.errors, { step: "temporary npm environment cleanup", message }],
      };
      emitBestEffort(
        events,
        "worktree_init_step_failed" as Parameters<IEventWriter["emit"]>[0],
        {
          step: "temporary npm environment cleanup",
          stderr: message,
          durationMs: 0,
          phase,
        } as Parameters<IEventWriter["emit"]>[1],
      );
    }
  }

  if (executionOptions.emitCompletion !== false) {
    emitBestEffort(
      events,
      "worktree_init_complete" as Parameters<IEventWriter["emit"]>[0],
      {
        success: initResult.success,
        stepsRun: initResult.stepsRun,
        errorCount: initResult.errors.length,
        mode,
        phase,
      } as Parameters<IEventWriter["emit"]>[1],
    );
  }
  return initResult;
}

/**
 * Rehydrate dependencies after the worker changed npm manifests. This runs
 * after the disposable dependency mirror was discarded and before mandatory
 * verification. It never trusts worker-mutated node_modules, runs no package
 * lifecycle scripts, and receives no ambient service credentials.
 */
export async function runPostWorkerDependencyRefresh(
  worktreePath: string,
  changedPaths: string[],
  events?: IEventWriter,
): Promise<WorktreeInitResult> {
  const manifests = changedDependencyManifestPaths(changedPaths);
  const finish = (result: WorktreeInitResult): WorktreeInitResult => {
    emitBestEffort(
      events,
      "worktree_init_complete" as Parameters<IEventWriter["emit"]>[0],
      {
        success: result.success,
        stepsRun: result.stepsRun,
        errorCount: result.errors.length,
        mode: "explicit",
        phase: "post_worker_refresh",
      } as Parameters<IEventWriter["emit"]>[1],
    );
    return result;
  };
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(path.resolve(worktreePath));
  } catch (error: unknown) {
    return finish(failureResult("dependency refresh root", error));
  }

  let lock: DependencyRefreshLock;
  try {
    // Acquiring the lock first also recovers a transaction abandoned by a
    // terminated prior Quack process, even when this run has no new manifests.
    lock = await acquireDependencyRefreshLock(canonicalRoot);
  } catch (error: unknown) {
    return finish(failureResult("dependency refresh lock", error));
  }
  let transactionSettled = false;
  let installStepsRun = 0;
  const abandonLock = async (): Promise<void> => {
    if (await pathExists(lock.abandonedPath)) {
      await dependencyRefreshIsAbandoned(lock.directory, lock.owner);
      return;
    }
    const abandoned: DependencyRefreshAbandonedRecord = {
      version: 1,
      canonicalRoot,
      processNonce: lock.owner.processNonce,
      operationNonce: lock.owner.operationNonce,
      abandonedAtMs: Date.now(),
    };
    await writeDurableNewFileAtomically(lock.abandonedPath, JSON.stringify(abandoned));
  };
  const settle = async (): Promise<void> => {
    await recoverDependencyRefreshTransaction(canonicalRoot, lock.directory);
    transactionSettled = true;
  };
  let activeTransactionId: string | undefined;

  try {
    if (manifests.length === 0) {
      await fs.rm(lock.directory, { recursive: true, force: true });
      await dependencyRefreshDirectorySync(path.dirname(lock.directory));
      transactionSettled = true;
      return finish({ success: true, stepsRun: 0, errors: [] });
    }

    const packageDirectories = [
      ...new Set(manifests.map((manifest) => path.posix.dirname(manifest))),
    ];
    const transactionId = randomUUID();
    activeTransactionId = transactionId;
    const stagedRefreshes: DependencyRefreshJournalItem[] = [];
    const stepKinds = new Map<string, "ci" | "install">();
    const seenPackageDirectories = new Set<string>();

    for (const cwd of packageDirectories) {
      const directory = await resolveOptionalUnaliasedPackageDirectory(
        canonicalRoot,
        worktreePath,
        cwd,
      );
      // Deleting the whole package directory already removes its dependency
      // tree, so there is no remaining trusted state to transact.
      if (!directory) continue;
      const directoryIdentity = process.platform === "win32" ? directory.toLowerCase() : directory;
      if (seenPackageDirectories.has(directoryIdentity)) continue;
      seenPackageDirectories.add(directoryIdentity);
      const [hasPackageManifest, hasPackageLock, hasShrinkwrap] = await Promise.all([
        pathExists(path.join(directory, "package.json")),
        pathExists(path.join(directory, "package-lock.json")),
        pathExists(path.join(directory, "npm-shrinkwrap.json")),
      ]);
      if (!hasPackageManifest && (hasPackageLock || hasShrinkwrap)) {
        throw new Error(
          `Changed dependency manifest directory has lock metadata without package.json: ${cwd}`,
        );
      }
      if (hasPackageManifest) await validatePostWorkerPackageMetadata(canonicalRoot, directory);
      const requiresNodeModules = hasPackageManifest
        ? await packageManifestRequiresNodeModules(directory)
        : false;
      const targetNodeModules = path.join(directory, "node_modules");
      let hadTarget = false;
      try {
        const targetMetadata = await fs.lstat(targetNodeModules);
        if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) {
          throw new Error(`Restored node_modules for ${cwd} must be a physical directory`);
        }
        const canonicalTarget = await fs.realpath(targetNodeModules);
        if (!isContainedPath(canonicalRoot, canonicalTarget)) {
          throw new Error(`Restored node_modules for ${cwd} resolves outside the worktree`);
        }
        hadTarget = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // A fully deleted package with no dependency tree is already in its
      // desired state and does not need a journal item.
      if (!hasPackageManifest && !hadTarget) continue;
      const index = stagedRefreshes.length;
      const stagingDirectory = path.join(
        directory,
        `.quack-dependency-refresh-${transactionId}-${index}`,
      );
      const backupNodeModules = path.join(
        directory,
        `.quack-node-modules-backup-${transactionId}-${index}`,
      );
      if ((await pathExists(stagingDirectory)) || (await pathExists(backupNodeModules))) {
        throw new Error(`Dependency transaction path collision for ${cwd}`);
      }
      stagedRefreshes.push({
        cwd,
        packageDirectory: directory,
        stagingDirectory,
        stagedNodeModules: path.join(stagingDirectory, "node_modules"),
        targetNodeModules,
        backupNodeModules,
        hadTarget,
        requiresNodeModules,
        operation: hasPackageManifest ? "install" : "remove",
      });
      if (hasPackageManifest) {
        stepKinds.set(stagingDirectory, hasPackageLock || hasShrinkwrap ? "ci" : "install");
      }
    }

    assertNonOverlappingDependencyRefreshItems(stagedRefreshes);
    if (stagedRefreshes.length === 0) {
      await fs.rm(lock.directory, { recursive: true, force: true });
      await dependencyRefreshDirectorySync(path.dirname(lock.directory));
      transactionSettled = true;
      return finish({ success: true, stepsRun: 0, errors: [] });
    }
    const hasInstall = stagedRefreshes.some((refresh) => refresh.operation !== "remove");
    const npm = hasInstall ? await resolveTrustedNpmInvocation(canonicalRoot) : undefined;

    const journal: DependencyRefreshJournal = {
      version: 1,
      transactionId,
      canonicalRoot,
      items: stagedRefreshes,
    };
    await writeDurableNewFileAtomically(lock.journalPath, JSON.stringify(journal));

    const steps: PreparedStep[] = [];
    for (const refresh of stagedRefreshes) {
      if (refresh.operation === "remove") continue;
      await fs.mkdir(refresh.stagingDirectory);
      for (const manifestName of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
        const source = path.join(refresh.packageDirectory, manifestName);
        try {
          await assertContainedRegularFile(canonicalRoot, source, manifestName);
          await fs.copyFile(source, path.join(refresh.stagingDirectory, manifestName));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      steps.push({
        invocation: {
          executable: npm!.executable,
          args: [
            npm!.npmCliPath,
            stepKinds.get(refresh.stagingDirectory)!,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ],
        },
        cwd: path.relative(canonicalRoot, refresh.stagingDirectory) || ".",
        label: `Safe dependency refresh (${refresh.cwd})`,
      });
    }

    const installResult =
      steps.length > 0
        ? await runWorktreeInit(worktreePath, undefined, events, {
            phase: "post_worker_refresh",
            preparedSteps: steps,
            emitCompletion: false,
          })
        : { success: true, stepsRun: 0, errors: [] };
    installStepsRun = installResult.stepsRun;
    if (!installResult.success) {
      await settle();
      return finish(installResult);
    }
    assertDependencyRefreshLeaseHealthy(lock.owner);

    // Validate every swap target before moving anything. npm executes only in
    // the staging directories, so an install failure or malformed output leaves
    // every restored trusted dependency tree byte-for-byte untouched.
    for (const refresh of stagedRefreshes) {
      if (refresh.operation === "remove") continue;
      try {
        const stagedMetadata = await fs.lstat(refresh.stagedNodeModules);
        if (stagedMetadata.isSymbolicLink() || !stagedMetadata.isDirectory()) {
          throw new Error("staged node_modules must be a physical directory");
        }
        const canonicalStaged = await fs.realpath(refresh.stagedNodeModules);
        if (!isContainedPath(refresh.stagingDirectory, canonicalStaged)) {
          throw new Error("staged node_modules resolves outside its transaction directory");
        }
        if (
          refresh.requiresNodeModules &&
          (await fs.readdir(refresh.stagedNodeModules)).length === 0
        ) {
          throw new Error(
            `Staged install produced an empty node_modules for non-empty package ${refresh.cwd}`,
          );
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (refresh.requiresNodeModules) {
            throw new Error(
              `Staged install produced no node_modules for non-empty package ${refresh.cwd}`,
            );
          }
        } else {
          throw error;
        }
      }
    }

    for (const refresh of stagedRefreshes) {
      if (refresh.hadTarget) {
        await dependencyRefreshRename(refresh.targetNodeModules, refresh.backupNodeModules);
      }
      if (refresh.operation !== "remove" && (await pathExists(refresh.stagedNodeModules))) {
        await dependencyRefreshRename(refresh.stagedNodeModules, refresh.targetNodeModules);
      }
    }
    for (const directory of new Set(stagedRefreshes.map((refresh) => refresh.packageDirectory))) {
      await dependencyRefreshDirectorySync(directory);
    }
    assertDependencyRefreshLeaseHealthy(lock.owner);
    await writeDurableNewFileAtomically(lock.committedPath, `${transactionId}\n`);
    await settle();
    return finish(installResult);
  } catch (error: unknown) {
    let recoveryError: unknown;
    let transactionCommitted = false;
    try {
      transactionCommitted =
        activeTransactionId !== undefined && (await pathExists(lock.directory))
          ? await dependencyRefreshIsCommitted(lock.directory, activeTransactionId)
          : false;
      if (await pathExists(lock.directory)) await settle();
    } catch (settleError: unknown) {
      recoveryError = settleError;
      try {
        await abandonLock();
      } catch (abandonError: unknown) {
        recoveryError = new Error(
          `${settleError instanceof Error ? settleError.message : String(settleError)}; ` +
            `abandonment publication failed: ${
              abandonError instanceof Error ? abandonError.message : String(abandonError)
            }`,
          { cause: settleError },
        );
      }
    }
    if (transactionCommitted && !recoveryError) {
      return finish({ success: true, stepsRun: installStepsRun, errors: [] });
    }
    return finish({
      success: false,
      stepsRun: installStepsRun,
      errors: [
        {
          step: "dependency refresh transaction",
          message: `${error instanceof Error ? error.message : String(error)}${
            recoveryError
              ? `; durable recovery remains required: ${
                  recoveryError instanceof Error
                    ? recoveryError.message
                    : typeof recoveryError === "string"
                      ? recoveryError
                      : "unknown recovery error"
                }`
              : transactionCommitted
                ? "; committed dependency trees retained"
                : "; original dependency trees restored"
          }`,
        },
      ],
    });
  } finally {
    if (!transactionSettled && !(await pathExists(lock.journalPath).catch(() => false))) {
      await fs.rm(lock.directory, { recursive: true, force: true }).catch(() => undefined);
    }
    await releaseDependencyRefreshOwner(lock.owner);
  }
}
