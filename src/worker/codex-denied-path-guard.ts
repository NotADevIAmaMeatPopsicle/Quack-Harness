// Preventive denied-path isolation for the mutable Codex worker.
//
// Git status cannot see ignored files, so postflight-only enforcement misses
// paths such as node_modules/ and .env. This guard inventories every concrete
// denied path plus ignored paths outside writable roots, quarantines them
// outside the workspace for the model turn, then removes model-created
// replacements and restores the original bytes.

import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AdapterSandboxConfig } from "../core/types.js";
import { checkWritePath } from "../hooks/bash-guard.js";
import { runTrustedGit } from "./trusted-executable.js";

export interface DeniedPathInventoryEntry {
  kind: "file" | "directory" | "symlink";
  digest: string;
}

export interface DeniedPathInventory {
  entries: Record<string, DeniedPathInventoryEntry>;
}

export interface DeniedPathGuardResult {
  violations: string[];
  restored: boolean;
}

export interface CodexDeniedPathQuarantineInspection {
  status: "valid_for_project" | "other_project" | "invalid";
  projectRoot?: string;
  reason?: string;
}

export interface CodexDeniedPathRecoveryOptions {
  /**
   * Used only to improve the fail-closed diagnostic for a stale owner.
   * Existing locks are never reclaimed automatically because portable Node
   * filesystem APIs do not provide an atomic compare-and-swap for lock files.
   */
  reclaimRecoveryLockForPid?: number;
}

export interface CodexDeniedPathGuard {
  finish(): Promise<DeniedPathGuardResult>;
}

const QUARANTINE_PREFIX = ".quack-codex-denied-";
const QUARANTINE_MANIFEST = "manifest.json";
const QUARANTINE_RECOVERY_LOCK = "recovery.lock";
const QUARANTINE_MANIFEST_VERSION = 2;

interface DeniedPathRecoveryPolicy {
  writablePaths: string[];
  deniedPaths: string[];
  disposablePaths: string[];
}

interface DeniedPathQuarantineItem {
  relativePath: string;
  backupName: string;
  mode: "move" | "copy";
}

interface DeniedPathQuarantineManifest {
  version: typeof QUARANTINE_MANIFEST_VERSION;
  projectRoot: string;
  policy: DeniedPathRecoveryPolicy;
  before: DeniedPathInventory;
  items: DeniedPathQuarantineItem[];
}

interface ValidatedQuarantineItem extends DeniedPathQuarantineItem {
  destination: string;
  backupPath: string;
}

interface ValidatedQuarantineManifest {
  projectRoot: string;
  quarantineRoot: string;
  policy: AdapterSandboxConfig;
  before: DeniedPathInventory;
  items: ValidatedQuarantineItem[];
}

const activeRecoveries = new Map<string, Promise<DeniedPathGuardResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalDirectory(directory: string): Promise<string> {
  return path.normalize(await fs.realpath(path.resolve(directory)));
}

function normalizePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function assertNoWindowsPathAliases(value: string, label: string): void {
  if (process.platform !== "win32") return;
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment.includes(":")) {
      throw new Error(`Invalid Codex denied-path quarantine manifest: unsafe ${label}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`Invalid Codex denied-path quarantine manifest: unsafe ${label}`);
    }
    if (segment.includes("*")) continue;
    const deviceBase = segment.split(".", 1)[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(deviceBase)) {
      throw new Error(`Invalid Codex denied-path quarantine manifest: unsafe ${label}`);
    }
  }
}

function safePolicyPattern(value: unknown, label: string, denyProjectRoot: boolean): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Invalid Codex denied-path quarantine manifest: ${label} must be safe text`);
  }
  const normalized = normalizePattern(value);
  if (
    !normalized ||
    (denyProjectRoot && normalized === ".") ||
    path.isAbsolute(value) ||
    (normalized !== "." &&
      normalized.split("/").some((segment) => segment === "." || segment === ".."))
  ) {
    throw new Error(`Invalid Codex denied-path quarantine manifest: unsafe ${label}`);
  }
  assertNoWindowsPathAliases(normalized, label);
  return value;
}

function safeDisposablePolicyPath(value: unknown, label: string): string {
  const normalized = normalizePattern(safePolicyPattern(value, label, true));
  if (normalized.includes("*")) {
    throw new Error(
      `Invalid Codex denied-path quarantine manifest: ${label} must name an exact path`,
    );
  }
  return normalized;
}

function pathComparisonKey(value: string): string {
  const normalized = normalizePattern(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateRecoveryPolicy(value: unknown): AdapterSandboxConfig {
  const disposablePathsValue = isRecord(value) ? (value.disposablePaths ?? []) : undefined;
  if (
    !isRecord(value) ||
    !Array.isArray(value.writablePaths) ||
    !Array.isArray(value.deniedPaths) ||
    !Array.isArray(disposablePathsValue)
  ) {
    throw new Error("Invalid Codex denied-path quarantine manifest: invalid recovery policy");
  }
  const disposablePaths = disposablePathsValue.map((entry, index) =>
    safeDisposablePolicyPath(entry, `disposablePaths[${index}]`),
  );
  const disposableKeys = new Set(disposablePaths.map(pathComparisonKey));
  if (disposableKeys.size !== disposablePaths.length) {
    throw new Error(
      "Invalid Codex denied-path quarantine manifest: duplicate disposablePaths entry",
    );
  }
  return {
    writablePaths: value.writablePaths.map((entry, index) =>
      safePolicyPattern(entry, `writablePaths[${index}]`, false),
    ),
    deniedPaths: value.deniedPaths.map((entry, index) =>
      safePolicyPattern(entry, `deniedPaths[${index}]`, true),
    ),
    disposablePaths,
    allowedBashPatterns: [],
    deniedBashPatterns: [],
  };
}

function recoveryPolicyFromSandbox(sandbox: AdapterSandboxConfig): DeniedPathRecoveryPolicy {
  const validated = validateRecoveryPolicy({
    writablePaths: [...sandbox.writablePaths],
    deniedPaths: [...sandbox.deniedPaths],
    disposablePaths: [...(sandbox.disposablePaths ?? [])],
  });
  return {
    writablePaths: validated.writablePaths,
    deniedPaths: validated.deniedPaths,
    disposablePaths: validated.disposablePaths ?? [],
  };
}

function patternRegex(pattern: string): RegExp {
  const normalized = normalizePattern(pattern);
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

function assertInsideProject(projectRoot: string, relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Denied path escapes the Codex worktree: ${relativePath}`);
  }
  return absolute;
}

async function pathKind(
  absolutePath: string,
): Promise<DeniedPathInventoryEntry["kind"] | undefined> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return undefined;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function walk(
  projectRoot: string,
  relativePath: string,
  visit: (relativePath: string, kind: DeniedPathInventoryEntry["kind"]) => Promise<void> | void,
): Promise<void> {
  const absolute = assertInsideProject(projectRoot, relativePath);
  const kind = await pathKind(absolute);
  if (!kind) return;
  await visit(relativePath.replace(/\\/g, "/"), kind);
  if (kind !== "directory") return;
  const children = await fs.readdir(absolute, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    await walk(projectRoot, path.join(relativePath, child.name), visit);
  }
}

async function walkToDepth(
  projectRoot: string,
  relativePath: string,
  remainingDepth: number,
  visit: (relativePath: string, kind: DeniedPathInventoryEntry["kind"]) => Promise<void> | void,
): Promise<void> {
  const absolute = assertInsideProject(projectRoot, relativePath);
  const kind = await pathKind(absolute);
  if (!kind) return;
  await visit(relativePath.replace(/\\/g, "/"), kind);
  if (kind !== "directory" || remainingDepth <= 0) return;
  const children = await fs.readdir(absolute, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    await walkToDepth(projectRoot, path.join(relativePath, child.name), remainingDepth - 1, visit);
  }
}

async function discoverDeniedRoots(
  projectRoot: string,
  deniedPatterns: string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const rawPattern of deniedPatterns) {
    const pattern = normalizePattern(rawPattern);
    if (!pattern) continue;
    assertInsideProject(projectRoot, pattern.replace(/\*/g, "placeholder"));
    if (!pattern.includes("*")) {
      if (await pathKind(path.resolve(projectRoot, pattern))) candidates.add(pattern);
      continue;
    }

    const wildcardAt = pattern.indexOf("*");
    const slashAt = pattern.lastIndexOf("/", wildcardAt);
    const scanRoot = slashAt >= 0 ? pattern.slice(0, slashAt) : "";
    const remainder = slashAt >= 0 ? pattern.slice(slashAt + 1) : pattern;
    const scanDepth = remainder.split("/").length;
    const matcher = patternRegex(pattern);
    await walkToDepth(projectRoot, scanRoot || ".", scanDepth, (relativePath) => {
      const normalized = relativePath === "." ? "" : relativePath;
      if (normalized && matcher.test(normalized)) candidates.add(normalized);
    });
  }

  return [...candidates]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .filter(
      (candidate, index, all) =>
        !all.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)),
    );
}

async function discoverIgnoredRoots(projectRoot: string): Promise<string[]> {
  const output = await runTrustedGit(
    projectRoot,
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ],
    {
      timeoutMs: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      errorContext: "Cannot inventory git-ignored paths before Codex launch",
    },
  );
  return output
    .split("\0")
    .map(normalizePattern)
    .filter(Boolean)
    .filter((relativePath) => {
      assertInsideProject(projectRoot, relativePath);
      return true;
    });
}

/**
 * Repository ignore rules are part of the recovery policy. A model could
 * otherwise remove a non-writable .gitignore rule, create bytes that the
 * original rule would have hidden, and make post-run rediscovery miss them.
 * Copy-backing these files lets recovery restore the original rules before it
 * asks Git for the ignored-path set again.
 */
async function discoverGitIgnoreRuleRoots(projectRoot: string): Promise<string[]> {
  const output = await runTrustedGit(
    projectRoot,
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".gitignore",
      ":(glob)**/.gitignore",
    ],
    {
      timeoutMs: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      errorContext: "Cannot inventory repository ignore rules before Codex launch",
    },
  );
  return output
    .split("\0")
    .map(normalizePattern)
    .filter(Boolean)
    .filter((relativePath) => {
      assertInsideProject(projectRoot, relativePath);
      return isGitIgnoreRule(relativePath);
    });
}

async function discoverProtectedRoots(
  projectRoot: string,
  sandbox: AdapterSandboxConfig,
): Promise<string[]> {
  const explicit = await discoverDeniedRoots(projectRoot, sandbox.deniedPaths);
  const writableOnlySandbox: AdapterSandboxConfig = {
    ...sandbox,
    deniedPaths: [],
  };
  const ignoredOutsideWritable = (await discoverIgnoredRoots(projectRoot)).filter(
    (relativePath) => !checkWritePath(relativePath, writableOnlySandbox, projectRoot).allowed,
  );
  const immutableIgnoreRules = (await discoverGitIgnoreRuleRoots(projectRoot)).filter(
    (relativePath) => !checkWritePath(relativePath, writableOnlySandbox, projectRoot).allowed,
  );
  const candidates = [
    ...new Set([...explicit, ...ignoredOutsideWritable, ...immutableIgnoreRules]),
  ];
  return candidates
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .filter(
      (candidate, index, all) =>
        !all.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)),
    );
}

function bindDisposableRoots(configuredPaths: string[], protectedRoots: string[]): string[] {
  const protectedByKey = new Map(
    protectedRoots.map((relativePath) => [pathComparisonKey(relativePath), relativePath]),
  );
  return configuredPaths.map((configuredPath) => {
    const protectedRoot = protectedByKey.get(pathComparisonKey(configuredPath));
    if (!protectedRoot) {
      throw new Error(
        `Codex implementation refused: disposable path ${configuredPath} must name an existing exact denied or ignored root`,
      );
    }
    return protectedRoot;
  });
}

async function digestProtectedFile(filePath: string, relativePath: string): Promise<string> {
  const before = await fs.lstat(filePath);
  if (!before.isFile()) {
    throw new Error(`Codex implementation refused: protected path ${relativePath} changed type`);
  }
  if (before.nlink !== 1) {
    throw new Error(
      `Codex implementation refused: protected path ${relativePath} is a hard-linked file`,
    );
  }

  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error(
        `Codex implementation refused: protected path ${relativePath} is not an independent regular file`,
      );
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(
        `Codex implementation refused: protected path ${relativePath} changed during inventory`,
      );
    }

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = handle.createReadStream({ autoClose: false });
      stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const [after, pathAfter] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (
      after.nlink !== 1 ||
      pathAfter.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(
        `Codex implementation refused: protected path ${relativePath} changed during inventory`,
      );
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function inventoryRoots(projectRoot: string, roots: string[]): Promise<DeniedPathInventory> {
  const entries = Object.create(null) as Record<string, DeniedPathInventoryEntry>;
  for (const root of roots) {
    await walk(projectRoot, root, async (relativePath, kind) => {
      const absolute = assertInsideProject(projectRoot, relativePath);
      entries[relativePath] = {
        kind,
        digest:
          kind === "file"
            ? await digestProtectedFile(absolute, relativePath)
            : kind === "symlink"
              ? createHash("sha256")
                  .update(await fs.readlink(absolute))
                  .digest("hex")
              : "directory",
      };
    });
  }
  return { entries };
}

export async function captureDeniedPathInventory(
  projectRoot: string,
  sandbox: AdapterSandboxConfig,
): Promise<DeniedPathInventory> {
  const canonicalProjectRoot = await canonicalDirectory(projectRoot);
  const roots = await discoverProtectedRoots(canonicalProjectRoot, sandbox);
  await validateDiscoveredRoots(canonicalProjectRoot, roots);
  return inventoryRoots(canonicalProjectRoot, roots);
}

function inventoryEqual(left: DeniedPathInventory, right: DeniedPathInventory): boolean {
  const ordered = (inventory: DeniedPathInventory): Array<[string, DeniedPathInventoryEntry]> =>
    Object.keys(inventory.entries)
      .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath))
      .map((entryPath) => [entryPath, inventory.entries[entryPath]]);
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function isGitMetadataRoot(relativePath: string): boolean {
  return relativePath.toLowerCase() === ".git";
}

function isGitIgnoreRule(relativePath: string): boolean {
  return path.posix.basename(relativePath.replace(/\\/g, "/")).toLowerCase() === ".gitignore";
}

function isCopyBackedRoot(relativePath: string): boolean {
  return isGitMetadataRoot(relativePath) || isGitIgnoreRule(relativePath);
}

function subtreeInventory(
  inventory: DeniedPathInventory,
  relativeRoot: string,
): DeniedPathInventory {
  return {
    entries: Object.fromEntries(
      Object.entries(inventory.entries).filter(
        ([entryPath]) => entryPath === relativeRoot || entryPath.startsWith(`${relativeRoot}/`),
      ),
    ),
  };
}

async function inventoryBackup(
  quarantineRoot: string,
  item: DeniedPathQuarantineItem,
): Promise<DeniedPathInventory> {
  const raw = await inventoryRoots(quarantineRoot, [item.backupName]);
  const entries = Object.create(null) as DeniedPathInventory["entries"];
  for (const [entryPath, entry] of Object.entries(raw.entries)) {
    if (entryPath !== item.backupName && !entryPath.startsWith(`${item.backupName}/`)) {
      throw new Error(`Quarantine backup escaped its declared root: ${entryPath}`);
    }
    entries[`${item.relativePath}${entryPath.slice(item.backupName.length)}`] = entry;
  }
  return { entries };
}

function safeManifestRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Invalid Codex denied-path quarantine manifest: ${label} must be a string`);
  }
  const normalized = normalizePattern(value);
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized === "." ||
    normalized !== value ||
    path.posix.normalize(normalized) !== normalized ||
    path.isAbsolute(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid Codex denied-path quarantine manifest: unsafe ${label}`);
  }
  assertNoWindowsPathAliases(normalized, label);
  return normalized;
}

async function assertDestinationParentInsideRoot(
  projectRoot: string,
  destination: string,
): Promise<void> {
  const destinationParent = path.dirname(destination);
  if (!isInsidePath(projectRoot, destinationParent)) {
    throw new Error(
      "Invalid Codex denied-path quarantine manifest: destination parent escapes project root",
    );
  }
  const relativeParent = path.relative(projectRoot, destinationParent);
  let candidate = projectRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(
          "Invalid Codex denied-path quarantine manifest: destination parent contains a filesystem alias",
        );
      }
      const canonicalParent = await fs.realpath(candidate);
      if (!pathsEqual(candidate, canonicalParent)) {
        throw new Error(
          "Invalid Codex denied-path quarantine manifest: destination parent contains a filesystem alias",
        );
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        // Once a lexical parent is absent, no deeper path can exist without a
        // concurrent filesystem mutation. Recovery will create the remainder.
        return;
      }
      throw error;
    }
  }
}

function assertDestinationParentInsideRootSync(projectRoot: string, destination: string): void {
  const destinationParent = path.dirname(destination);
  if (!isInsidePath(projectRoot, destinationParent)) {
    throw new Error(
      "Invalid Codex denied-path quarantine manifest: destination parent escapes project root",
    );
  }
  const relativeParent = path.relative(projectRoot, destinationParent);
  let candidate = projectRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    try {
      const stat = fsSync.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(
          "Invalid Codex denied-path quarantine manifest: destination parent contains a filesystem alias",
        );
      }
      const canonicalParent = fsSync.realpathSync(candidate);
      if (!pathsEqual(candidate, canonicalParent)) {
        throw new Error(
          "Invalid Codex denied-path quarantine manifest: destination parent contains a filesystem alias",
        );
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

async function validateDiscoveredRoots(projectRoot: string, roots: string[]): Promise<void> {
  for (const root of roots) {
    const relativePath = safeManifestRelativePath(root, "discovered root");
    const destination = assertInsideProject(projectRoot, relativePath);
    if (pathsEqual(destination, projectRoot)) {
      throw new Error("Denied-path isolation refused to target the project root");
    }
    await assertDestinationParentInsideRoot(projectRoot, destination);
    try {
      if (pathsEqual(await fs.realpath(destination), projectRoot)) {
        throw new Error("Denied-path isolation refused a root that resolves to the project root");
      }
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}

async function writeManifest(
  quarantineRoot: string,
  manifest: DeniedPathQuarantineManifest,
): Promise<void> {
  const manifestPath = path.join(quarantineRoot, QUARANTINE_MANIFEST);
  const temporaryPath = `${manifestPath}.tmp`;
  const handle = await fs.open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, manifestPath);
}

interface ValidatedQuarantineLocation {
  projectRoot: string;
  quarantineRoot: string;
}

function canonicalDirectorySync(directory: string): string {
  return path.normalize(fsSync.realpathSync(path.resolve(directory)));
}

function validateQuarantineLocationSync(
  requestedProjectRoot: string,
  requestedQuarantineRoot: string,
): ValidatedQuarantineLocation {
  const projectRoot = canonicalDirectorySync(requestedProjectRoot);
  const quarantineRoot = canonicalDirectorySync(requestedQuarantineRoot);
  const projectParent = canonicalDirectorySync(path.dirname(projectRoot));
  if (
    !pathsEqual(path.dirname(quarantineRoot), projectParent) ||
    !/^\.quack-codex-denied-[A-Za-z0-9_-]+$/.test(path.basename(quarantineRoot))
  ) {
    throw new Error(
      "Invalid Codex denied-path quarantine: recovery directory is not an exact project sibling",
    );
  }
  return { projectRoot, quarantineRoot };
}

function inspectQuarantineLocationSync(
  requestedProjectRoot: string,
  requestedQuarantineRoot: string,
): ValidatedQuarantineLocation {
  const requestedAbsolute = path.resolve(requestedProjectRoot);
  const projectParent = canonicalDirectorySync(path.dirname(requestedAbsolute));
  const quarantineRoot = canonicalDirectorySync(requestedQuarantineRoot);
  const projectRoot = fsSync.existsSync(requestedAbsolute)
    ? canonicalDirectorySync(requestedAbsolute)
    : path.normalize(path.join(projectParent, path.basename(requestedAbsolute)));
  if (
    !pathsEqual(path.dirname(quarantineRoot), projectParent) ||
    !/^\.quack-codex-denied-[A-Za-z0-9_-]+$/.test(path.basename(quarantineRoot))
  ) {
    throw new Error(
      "Invalid Codex denied-path quarantine: recovery directory is not an exact project sibling",
    );
  }
  return { projectRoot, quarantineRoot };
}

function validateQuarantineLocation(
  requestedProjectRoot: string,
  requestedQuarantineRoot: string,
): Promise<ValidatedQuarantineLocation> {
  return Promise.resolve(
    validateQuarantineLocationSync(requestedProjectRoot, requestedQuarantineRoot),
  );
}

function validateQuarantineManifestSync(
  requestedProjectRoot: string,
  requestedQuarantineRoot: string,
): ValidatedQuarantineManifest {
  const { projectRoot, quarantineRoot } = validateQuarantineLocationSync(
    requestedProjectRoot,
    requestedQuarantineRoot,
  );

  const manifestPath = path.join(quarantineRoot, QUARANTINE_MANIFEST);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
  } catch (error: unknown) {
    throw new Error(
      `Invalid Codex denied-path quarantine manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== QUARANTINE_MANIFEST_VERSION ||
    typeof parsed.projectRoot !== "string" ||
    !isRecord(parsed.policy) ||
    !isRecord(parsed.before) ||
    !isRecord(parsed.before.entries) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0
  ) {
    throw new Error("Invalid Codex denied-path quarantine manifest: unsupported shape");
  }

  let manifestProjectRoot: string;
  try {
    manifestProjectRoot = canonicalDirectorySync(parsed.projectRoot);
  } catch (error: unknown) {
    throw new Error(
      `Invalid Codex denied-path quarantine manifest projectRoot: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!pathsEqual(projectRoot, manifestProjectRoot)) {
    throw new Error(
      "Invalid Codex denied-path quarantine manifest: canonical projectRoot mismatch",
    );
  }
  const policy = validateRecoveryPolicy(parsed.policy);

  const items: ValidatedQuarantineItem[] = [];
  const relativePaths = new Set<string>();
  const relativePathKeys = new Set<string>();
  const backupNames = new Set<string>();
  for (const [index, rawItem] of parsed.items.entries()) {
    if (
      !isRecord(rawItem) ||
      (rawItem.mode !== "move" && rawItem.mode !== "copy") ||
      typeof rawItem.backupName !== "string" ||
      rawItem.backupName !== String(index)
    ) {
      throw new Error(`Invalid Codex denied-path quarantine manifest: invalid item ${index}`);
    }
    const relativePath = safeManifestRelativePath(
      rawItem.relativePath,
      `item ${index} destination`,
    );
    const relativePathKey =
      process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (relativePathKeys.has(relativePathKey) || backupNames.has(rawItem.backupName)) {
      throw new Error(
        "Invalid Codex denied-path quarantine manifest: duplicate destination or backup",
      );
    }
    if (
      (rawItem.mode === "copy" && !isCopyBackedRoot(relativePath)) ||
      (rawItem.mode === "move" && isCopyBackedRoot(relativePath))
    ) {
      throw new Error(
        "Invalid Codex denied-path quarantine manifest: unsupported restoration mode",
      );
    }
    const destination = assertInsideProject(projectRoot, relativePath);
    if (pathsEqual(destination, projectRoot)) {
      throw new Error(
        "Invalid Codex denied-path quarantine manifest: project root cannot be a destination",
      );
    }
    assertDestinationParentInsideRootSync(projectRoot, destination);
    const backupPath = path.resolve(quarantineRoot, rawItem.backupName);
    if (
      !isInsidePath(quarantineRoot, backupPath) ||
      !pathsEqual(path.dirname(backupPath), quarantineRoot)
    ) {
      throw new Error(
        "Invalid Codex denied-path quarantine manifest: backup escapes quarantine root",
      );
    }
    relativePaths.add(relativePath);
    relativePathKeys.add(relativePathKey);
    backupNames.add(rawItem.backupName);
    items.push({
      relativePath,
      backupName: rawItem.backupName,
      mode: rawItem.mode,
      destination,
      backupPath,
    });
  }

  const sortedRoots = [...relativePaths].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  for (let index = 0; index < sortedRoots.length; index += 1) {
    const parent =
      process.platform === "win32" ? sortedRoots[index].toLowerCase() : sortedRoots[index];
    for (const candidateValue of sortedRoots.slice(index + 1)) {
      const candidate =
        process.platform === "win32" ? candidateValue.toLowerCase() : candidateValue;
      if (candidate.startsWith(`${parent}/`)) {
        throw new Error("Invalid Codex denied-path quarantine manifest: destinations overlap");
      }
    }
  }

  const beforeEntries = Object.create(null) as DeniedPathInventory["entries"];
  for (const [entryPathValue, rawEntry] of Object.entries(parsed.before.entries)) {
    const entryPath = safeManifestRelativePath(entryPathValue, "inventory path");
    if (
      !isRecord(rawEntry) ||
      (rawEntry.kind !== "file" && rawEntry.kind !== "directory" && rawEntry.kind !== "symlink") ||
      typeof rawEntry.digest !== "string"
    ) {
      throw new Error(
        `Invalid Codex denied-path quarantine manifest: invalid inventory entry ${entryPath}`,
      );
    }
    if (
      !items.some(
        (item) => entryPath === item.relativePath || entryPath.startsWith(`${item.relativePath}/`),
      )
    ) {
      throw new Error(
        `Invalid Codex denied-path quarantine manifest: orphan inventory entry ${entryPath}`,
      );
    }
    beforeEntries[entryPath] = { kind: rawEntry.kind, digest: rawEntry.digest };
  }
  for (const item of items) {
    const rootEntry = beforeEntries[item.relativePath];
    if (!rootEntry || (item.mode === "copy" && rootEntry.kind !== "file")) {
      throw new Error(
        `Invalid Codex denied-path quarantine manifest: missing root inventory for ${item.relativePath}`,
      );
    }
  }
  for (const disposablePath of policy.disposablePaths ?? []) {
    const item = items.find((candidate) => pathsEqual(candidate.relativePath, disposablePath));
    const rootEntry = item ? beforeEntries[item.relativePath] : undefined;
    if (
      !item ||
      item.mode !== "move" ||
      rootEntry?.kind !== "directory" ||
      looksSecretBearing(item.relativePath)
    ) {
      throw new Error(
        `Invalid Codex denied-path quarantine manifest: disposable path ${disposablePath} is not a safe moved directory root`,
      );
    }
  }

  const allowedChildren = new Set([
    QUARANTINE_MANIFEST,
    QUARANTINE_RECOVERY_LOCK,
    ...items.map((item) => item.backupName),
  ]);
  const unexpectedChildren = fsSync
    .readdirSync(quarantineRoot)
    .filter((child) => !allowedChildren.has(child));
  if (unexpectedChildren.length > 0) {
    throw new Error(
      `Invalid Codex denied-path quarantine: unexpected recovery data ${unexpectedChildren.join(", ")}`,
    );
  }

  return {
    projectRoot,
    quarantineRoot,
    policy,
    before: { entries: beforeEntries },
    items,
  };
}

function validateQuarantineManifest(
  requestedProjectRoot: string,
  requestedQuarantineRoot: string,
): Promise<ValidatedQuarantineManifest> {
  return Promise.resolve(
    validateQuarantineManifestSync(requestedProjectRoot, requestedQuarantineRoot),
  );
}

function looksSecretBearing(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    if (/^\.env\.(?:example|sample|template|dist)$/i.test(segment)) return false;
    return /^(?:\.env(?:\..*)?|.*(?:secret|credential|password|token|private[-_.]?key|api[-_.]?key).*)$/i.test(
      segment,
    );
  });
}

async function assertDisposableRootSelfContained(
  projectRoot: string,
  relativeRoot: string,
  before: DeniedPathInventory,
): Promise<void> {
  const rootEntry = before.entries[relativeRoot];
  if (rootEntry?.kind !== "directory") {
    throw new Error(
      `Codex implementation refused: disposable path ${relativeRoot} must be a regular directory`,
    );
  }
  const rootPath = assertInsideProject(projectRoot, relativeRoot);
  const canonicalRoot = await fs.realpath(rootPath);
  if (!pathsEqual(rootPath, canonicalRoot)) {
    throw new Error(
      `Codex implementation refused: disposable path ${relativeRoot} cannot be a filesystem alias`,
    );
  }

  for (const [entryPath, entry] of Object.entries(before.entries)) {
    if (
      entry.kind !== "symlink" ||
      (entryPath !== relativeRoot && !entryPath.startsWith(`${relativeRoot}/`))
    ) {
      continue;
    }
    const linkPath = assertInsideProject(projectRoot, entryPath);
    const rawTarget = await fs.readlink(linkPath);
    const lexicalTarget = path.resolve(path.dirname(linkPath), rawTarget);
    let canonicalTarget: string;
    try {
      canonicalTarget = await fs.realpath(linkPath);
    } catch (error: unknown) {
      throw new Error(
        `Codex implementation refused: disposable path ${relativeRoot} contains an unresolved filesystem alias at ${entryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isInsidePath(rootPath, lexicalTarget) || !isInsidePath(canonicalRoot, canonicalTarget)) {
      throw new Error(
        `Codex implementation refused: disposable path ${relativeRoot} contains an alias that escapes the disposable root at ${entryPath}`,
      );
    }
  }
}

async function materializeDisposableMirror(
  projectRoot: string,
  quarantineRoot: string,
  item: DeniedPathQuarantineItem,
  before: DeniedPathInventory,
): Promise<void> {
  const destination = assertInsideProject(projectRoot, item.relativePath);
  const backupPath = path.join(quarantineRoot, item.backupName);
  await assertDestinationParentInsideRoot(projectRoot, destination);
  const pendingLinks: Array<{ source: string; destination: string }> = [];
  const copyTree = async (sourceRoot: string, destinationRoot: string): Promise<void> => {
    const sourceStat = await fs.lstat(sourceRoot);
    if (sourceStat.isSymbolicLink()) {
      pendingLinks.push({ source: sourceRoot, destination: destinationRoot });
      return;
    }
    if (sourceStat.isDirectory()) {
      await fs.mkdir(destinationRoot, { mode: sourceStat.mode });
      const children = await fs.readdir(sourceRoot, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        await copyTree(path.join(sourceRoot, child.name), path.join(destinationRoot, child.name));
      }
      return;
    }
    if (sourceStat.isFile()) {
      if (sourceStat.nlink !== 1) {
        throw new Error(
          `Codex implementation refused: disposable path ${item.relativePath} contains a hard-linked file`,
        );
      }
      await fs.copyFile(sourceRoot, destinationRoot, fsSync.constants.COPYFILE_EXCL);
      return;
    }
    throw new Error(`unsupported dependency entry while copying ${item.relativePath}`);
  };
  await copyTree(backupPath, destination);
  for (const link of pendingLinks) {
    const rawTarget = await fs.readlink(link.source);
    if (process.platform === "win32") {
      const targetStat = await fs.stat(link.source);
      const target = targetStat.isDirectory()
        ? path.resolve(path.dirname(link.destination), rawTarget)
        : rawTarget;
      await fs.symlink(target, link.destination, targetStat.isDirectory() ? "junction" : "file");
    } else {
      await fs.symlink(rawTarget, link.destination);
    }
  }

  const expected = subtreeInventory(before, item.relativePath);
  const [backup, mirror] = await Promise.all([
    inventoryBackup(quarantineRoot, item),
    inventoryRoots(projectRoot, [item.relativePath]),
  ]);
  if (!inventoryEqual(expected, backup) || !inventoryEqual(expected, mirror)) {
    throw new Error(
      `Codex implementation refused: disposable mirror verification failed for ${item.relativePath}`,
    );
  }
}

function isDisposableEntry(policy: AdapterSandboxConfig, relativePath: string): boolean {
  const entryKey = pathComparisonKey(relativePath);
  return (policy.disposablePaths ?? []).some(
    (disposablePath) => pathComparisonKey(disposablePath) === entryKey,
  );
}

function isWithinDisposablePath(policy: AdapterSandboxConfig, relativePath: string): boolean {
  const entryKey = pathComparisonKey(relativePath);
  return (policy.disposablePaths ?? []).some((disposablePath) => {
    const disposableKey = pathComparisonKey(disposablePath);
    return entryKey === disposableKey || entryKey.startsWith(`${disposableKey}/`);
  });
}

interface RestorationItemState {
  item: ValidatedQuarantineItem;
  restoreFromBackup: boolean;
  preserveDestination: boolean;
}

async function validateRestorationState(
  manifest: ValidatedQuarantineManifest,
): Promise<RestorationItemState[]> {
  const states: RestorationItemState[] = [];
  for (const item of manifest.items) {
    const expected = subtreeInventory(manifest.before, item.relativePath);
    const backupPresent = (await pathKind(item.backupPath)) !== undefined;
    let backupValid = false;
    if (backupPresent) {
      try {
        const backup = await inventoryBackup(manifest.quarantineRoot, item);
        backupValid = inventoryEqual(expected, backup);
      } catch {
        backupValid = false;
      }
    }
    if (!backupValid) {
      const destinationInventory = await inventoryRoots(manifest.projectRoot, [item.relativePath]);
      if (!inventoryEqual(expected, destinationInventory)) {
        const reason = backupPresent
          ? `backup inventory mismatch for ${item.relativePath}`
          : `${item.relativePath} has neither a valid backup nor its original inventory`;
        throw new Error(`Codex denied-path recovery refused: ${reason}`);
      }
    }
    states.push({
      item,
      restoreFromBackup: backupValid,
      preserveDestination: !backupValid,
    });
  }
  return states;
}

function mergeInventories(
  first: DeniedPathInventory,
  second: DeniedPathInventory,
): DeniedPathInventory {
  return {
    entries: Object.assign(
      Object.create(null) as DeniedPathInventory["entries"],
      first.entries,
      second.entries,
    ),
  };
}

function collectViolations(
  manifest: ValidatedQuarantineManifest,
  observed: DeniedPathInventory,
): string[] {
  const copiedBefore = new Set(
    manifest.items
      .filter((item) => item.mode === "copy")
      .flatMap((item) =>
        Object.keys(manifest.before.entries).filter(
          (entry) => entry === item.relativePath || entry.startsWith(`${item.relativePath}/`),
        ),
      ),
  );
  const candidates = new Set([...Object.keys(observed.entries), ...copiedBefore]);
  return [...candidates]
    .filter((entry) => {
      if (isWithinDisposablePath(manifest.policy, entry)) return false;
      if (!copiedBefore.has(entry)) return true;
      const prior = manifest.before.entries[entry];
      const current = observed.entries[entry];
      return !current || prior.kind !== current.kind || prior.digest !== current.digest;
    })
    .sort();
}

async function restoreValidatedQuarantine(
  manifest: ValidatedQuarantineManifest,
  options?: {
    observed?: DeniedPathInventory;
    assertRecoveryOwnership?: () => Promise<void>;
  },
): Promise<DeniedPathGuardResult> {
  // Validate the complete recovery plan and every backup before deleting a
  // destination. A malformed or cross-project manifest must be inert.
  const states = await validateRestorationState(manifest);
  let observed =
    options?.observed ??
    (await inventoryRoots(
      manifest.projectRoot,
      manifest.items.map((item) => item.relativePath),
    ));

  // `.git` is copied rather than moved. Restore it first so the trusted,
  // in-process finish path can safely ask git which ignored paths appeared.
  // Non-writable .gitignore files are copy-backed for the same reason: the
  // post-run query must use the policy that existed before the model turn.
  for (const { item, restoreFromBackup } of states) {
    if (item.mode !== "copy" || !restoreFromBackup) continue;
    await options?.assertRecoveryOwnership?.();
    await assertDestinationParentInsideRoot(manifest.projectRoot, item.destination);
    await fs.rm(item.destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(item.destination), { recursive: true });
    await assertDestinationParentInsideRoot(manifest.projectRoot, item.destination);
    await fs.copyFile(item.backupPath, item.destination);
  }

  // The recovery policy is bound into the validated manifest so recovery
  // never depends on mutable adapter files in the worktree. Restore `.git`
  // first, then use that policy to rediscover ignored roots created during
  // the interrupted run.
  const currentRoots = await discoverProtectedRoots(manifest.projectRoot, manifest.policy);
  await validateDiscoveredRoots(manifest.projectRoot, currentRoots);
  observed = mergeInventories(await inventoryRoots(manifest.projectRoot, currentRoots), observed);
  const preservedRoots = new Set(
    states
      .filter(({ item, preserveDestination }) => item.mode === "copy" || preserveDestination)
      .map(({ item }) => item.relativePath),
  );
  const removableRoots = currentRoots.filter((relativePath) => !preservedRoots.has(relativePath));
  for (const relativePath of removableRoots.sort((left, right) => right.length - left.length)) {
    const destination = assertInsideProject(manifest.projectRoot, relativePath);
    await options?.assertRecoveryOwnership?.();
    await assertDestinationParentInsideRoot(manifest.projectRoot, destination);
    await fs.rm(destination, {
      recursive: true,
      force: true,
    });
  }

  for (const { item, restoreFromBackup } of states) {
    if (item.mode !== "move" || !restoreFromBackup) continue;
    await options?.assertRecoveryOwnership?.();
    await assertDestinationParentInsideRoot(manifest.projectRoot, item.destination);
    await fs.rm(item.destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(item.destination), { recursive: true });
    await assertDestinationParentInsideRoot(manifest.projectRoot, item.destination);
    await fs.rename(item.backupPath, item.destination);
  }

  const restored = await captureDeniedPathInventory(manifest.projectRoot, manifest.policy);
  if (!inventoryEqual(manifest.before, restored)) {
    throw new Error("Denied-path restoration did not reproduce the pre-run inventory");
  }

  // The manifest and any protected-file copies are recovery evidence. They
  // are deleted only after the restored project inventory is exact.
  await options?.assertRecoveryOwnership?.();
  await fs.rm(manifest.quarantineRoot, { recursive: true, force: true });
  return {
    violations: collectViolations(manifest, observed),
    restored: true,
  };
}

/** Inspect one explicitly named quarantine without mutating it. */
export function inspectCodexDeniedPathQuarantineSync(
  projectRoot: string,
  quarantineRoot: string,
): CodexDeniedPathQuarantineInspection {
  let location: ValidatedQuarantineLocation;
  try {
    location = inspectQuarantineLocationSync(projectRoot, quarantineRoot);
  } catch (error: unknown) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fsSync.readFileSync(path.join(location.quarantineRoot, QUARANTINE_MANIFEST), "utf8"),
    );
  } catch (error: unknown) {
    return {
      status: "invalid",
      reason: `Invalid Codex denied-path quarantine manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (isRecord(parsed) && typeof parsed.projectRoot === "string") {
    try {
      const declaredProjectRoot = canonicalDirectorySync(parsed.projectRoot);
      if (!pathsEqual(location.projectRoot, declaredProjectRoot)) {
        try {
          validateQuarantineManifestSync(declaredProjectRoot, location.quarantineRoot);
          return {
            status: "other_project",
            projectRoot: declaredProjectRoot,
          };
        } catch (error: unknown) {
          return {
            status: "invalid",
            projectRoot: declaredProjectRoot,
            reason:
              "Quarantine declares another project but does not validate for that project: " +
              (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    } catch {
      // A missing or otherwise non-canonical owner cannot be excluded as this
      // project's damaged evidence, so classify it as invalid and fail closed.
    }
  }

  try {
    validateQuarantineManifestSync(location.projectRoot, location.quarantineRoot);
    return {
      status: "valid_for_project",
      projectRoot: location.projectRoot,
    };
  } catch (error: unknown) {
    return {
      status: "invalid",
      projectRoot: location.projectRoot,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function inspectCodexDeniedPathQuarantine(
  projectRoot: string,
  quarantineRoot: string,
): Promise<CodexDeniedPathQuarantineInspection> {
  return Promise.resolve(inspectCodexDeniedPathQuarantineSync(projectRoot, quarantineRoot));
}

function recoveryKey(projectRoot: string, quarantineRoot: string): string {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return `${normalize(projectRoot)}\0${normalize(quarantineRoot)}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    );
  }
}

interface RecoveryLockClaim {
  lockPath: string;
  token: string;
}

function recoveryLockPayload(pid: number, token: string): string {
  return `${JSON.stringify({ pid, token })}\n`;
}

async function readRecoveryLock(
  lockPath: string,
): Promise<{ pid?: number; token?: string } | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : undefined,
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : undefined,
    };
  } catch {
    return undefined;
  }
}

async function writeRecoveryLock(lockPath: string, token: string): Promise<void> {
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(recoveryLockPayload(process.pid, token), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRecoveryLockOwned(claim: RecoveryLockClaim): Promise<void> {
  const current = await readRecoveryLock(claim.lockPath);
  if (current?.pid !== process.pid || current.token !== claim.token) {
    throw new Error("Codex denied-path quarantine recovery claim was lost");
  }
}

async function releaseRecoveryLock(claim: RecoveryLockClaim): Promise<void> {
  const current = await readRecoveryLock(claim.lockPath);
  if (current?.pid === process.pid && current.token === claim.token) {
    await fs.rm(claim.lockPath, { force: true });
  }
}

async function acquireRecoveryLock(
  quarantineRoot: string,
  options?: CodexDeniedPathRecoveryOptions,
): Promise<RecoveryLockClaim> {
  const lockPath = path.join(quarantineRoot, QUARANTINE_RECOVERY_LOCK);
  const token = randomUUID();
  try {
    await writeRecoveryLock(lockPath, token);
    return { lockPath, token };
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: string }).code !== "EEXIST"
    ) {
      throw error;
    }
    const expectedPid = options?.reclaimRecoveryLockForPid;
    const current = await readRecoveryLock(lockPath);
    if (expectedPid && current?.pid === expectedPid && !processIsAlive(expectedPid)) {
      throw new Error(
        `Codex denied-path quarantine has a stale recovery claim for confirmed-dead pid ${expectedPid}; ` +
          "automatic reclaim is unsafe, so preserve the evidence and clear the lock manually",
      );
    }
    throw new Error("Codex denied-path quarantine recovery is already claimed");
  }
}

function beginQuarantineRecovery(
  projectRoot: string,
  quarantineRoot: string,
  observed?: DeniedPathInventory,
  options?: CodexDeniedPathRecoveryOptions,
): Promise<DeniedPathGuardResult> {
  const key = recoveryKey(projectRoot, quarantineRoot);
  const active = activeRecoveries.get(key);
  if (active) return active;

  const recovery = (async (): Promise<DeniedPathGuardResult> => {
    const location = await validateQuarantineLocation(projectRoot, quarantineRoot);
    let claim: RecoveryLockClaim | undefined;
    try {
      claim = await acquireRecoveryLock(location.quarantineRoot, options);
      const manifest = await validateQuarantineManifest(
        location.projectRoot,
        location.quarantineRoot,
      );
      await assertRecoveryLockOwned(claim);
      return await restoreValidatedQuarantine(manifest, {
        observed,
        assertRecoveryOwnership: () => assertRecoveryLockOwned(claim!),
      });
    } catch (error: unknown) {
      if (claim) await releaseRecoveryLock(claim);
      throw error;
    }
  })();
  activeRecoveries.set(key, recovery);
  void recovery.then(
    () => {
      if (activeRecoveries.get(key) === recovery) activeRecoveries.delete(key);
    },
    () => {
      if (activeRecoveries.get(key) === recovery) activeRecoveries.delete(key);
    },
  );
  return recovery;
}

export function recoverCodexDeniedPathQuarantine(
  projectRoot: string,
  quarantineRoot: string,
  options?: CodexDeniedPathRecoveryOptions,
): Promise<DeniedPathGuardResult> {
  return beginQuarantineRecovery(projectRoot, quarantineRoot, undefined, options);
}

/**
 * Prepare a denied-path quarantine. A real git worktree has a small `.git`
 * pointer file; it remains present so Codex recognizes the repository, but is
 * byte-backed and restored. Non-writable `.gitignore` files are copy-backed so
 * recovery can rediscover model-created ignored paths under the original rule
 * set. A full `.git` directory is refused because it is not the disposable-
 * worktree topology this mutation runner requires.
 */
export async function prepareCodexDeniedPathGuard(
  projectRoot: string,
  sandbox: AdapterSandboxConfig,
): Promise<CodexDeniedPathGuard> {
  const canonicalProjectRoot = await canonicalDirectory(projectRoot);
  const policy = recoveryPolicyFromSandbox(sandbox);
  const discoverySandbox: AdapterSandboxConfig = {
    ...policy,
    allowedBashPatterns: [],
    deniedBashPatterns: [],
  };
  const roots = await discoverProtectedRoots(canonicalProjectRoot, discoverySandbox);
  await validateDiscoveredRoots(canonicalProjectRoot, roots);
  policy.disposablePaths = bindDisposableRoots(policy.disposablePaths, roots);
  const recoverySandbox: AdapterSandboxConfig = {
    ...policy,
    allowedBashPatterns: [],
    deniedBashPatterns: [],
  };
  const secretRoots = roots.filter(looksSecretBearing);
  if (secretRoots.length > 0) {
    throw new Error(
      `Codex implementation refused: secret-bearing denied path${secretRoots.length === 1 ? "" : "s"} ${secretRoots.join(
        ", ",
      )} cannot be guaranteed unreadable by the workspace-write sandbox`,
    );
  }
  const before = await inventoryRoots(canonicalProjectRoot, roots);
  for (const disposablePath of policy.disposablePaths) {
    await assertDisposableRootSelfContained(canonicalProjectRoot, disposablePath, before);
  }
  const items: DeniedPathQuarantineItem[] = [];
  for (const relativePath of roots) {
    const rootEntry = before.entries[relativePath];
    if (!rootEntry) {
      throw new Error(`Denied-path inventory omitted its root: ${relativePath}`);
    }
    if (isGitMetadataRoot(relativePath) && rootEntry.kind !== "file") {
      throw new Error(
        "Codex implementation requires a disposable git worktree (.git must be a worktree pointer file)",
      );
    }
    items.push({
      relativePath,
      backupName: String(items.length),
      mode: isCopyBackedRoot(relativePath) ? "copy" : "move",
    });
  }
  if (items.length === 0) {
    const result = Promise.resolve<DeniedPathGuardResult>({
      violations: [],
      restored: true,
    });
    return { finish: () => result };
  }
  const tempRoot = await fs.mkdtemp(
    path.join(path.dirname(canonicalProjectRoot), QUARANTINE_PREFIX),
  );
  const manifest: DeniedPathQuarantineManifest = {
    version: QUARANTINE_MANIFEST_VERSION,
    projectRoot: canonicalProjectRoot,
    policy,
    before,
    items,
  };
  let manifestWritten = false;
  const movedItems: DeniedPathQuarantineItem[] = [];

  try {
    // This is the recovery commit point: every destination/backup mapping is
    // durable before the first original path is moved out of the worktree.
    await writeManifest(tempRoot, manifest);
    manifestWritten = true;
    for (const item of items) {
      const source = assertInsideProject(canonicalProjectRoot, item.relativePath);
      const kind = await pathKind(source);
      if (!kind) {
        throw new Error(`Denied path changed during quarantine preparation: ${item.relativePath}`);
      }
      const backupPath = path.join(tempRoot, item.backupName);
      if (item.mode === "copy") {
        if (kind !== "file") {
          throw new Error(
            `Codex implementation requires copy-backed policy source ${item.relativePath} to be a regular file`,
          );
        }
        await fs.copyFile(source, backupPath);
        continue;
      }
      try {
        await fs.rename(source, backupPath);
        movedItems.push(item);
      } catch (error: unknown) {
        const secretNote = looksSecretBearing(item.relativePath)
          ? " Secret-bearing denied content cannot be proven unreadable."
          : "";
        throw new Error(
          `Cannot quarantine denied path ${item.relativePath}.${secretNote} ${
            error instanceof Error ? error.message : String(error)
          }`.trim(),
        );
      }
    }
    for (const item of items) {
      if (!isDisposableEntry(recoverySandbox, item.relativePath)) continue;
      await materializeDisposableMirror(canonicalProjectRoot, tempRoot, item, before);
    }
  } catch (error: unknown) {
    try {
      if (manifestWritten) {
        // Rollback is deliberately stricter than post-run recovery. If a
        // destination was recreated while preparation was still in flight,
        // retain both that data and the quarantined original for diagnosis.
        for (const item of [...movedItems].reverse()) {
          const destination = assertInsideProject(canonicalProjectRoot, item.relativePath);
          if ((await pathKind(destination)) !== undefined) {
            throw new Error(
              `denied destination ${item.relativePath} was recreated; recovery evidence retained at ${tempRoot}`,
            );
          }
        }
        for (const item of [...movedItems].reverse()) {
          const destination = assertInsideProject(canonicalProjectRoot, item.relativePath);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.rename(path.join(tempRoot, item.backupName), destination);
        }
        const restored = await inventoryRoots(canonicalProjectRoot, roots);
        if (!inventoryEqual(before, restored)) {
          throw new Error(
            `preparation rollback did not reproduce the original inventory; recovery evidence retained at ${tempRoot}`,
          );
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      } else {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    } catch (rollbackError: unknown) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; quarantine rollback failed: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
      );
    }
    throw error;
  }

  let finishPromise: Promise<DeniedPathGuardResult> | undefined;
  return {
    finish(): Promise<DeniedPathGuardResult> {
      if (!finishPromise) {
        finishPromise = (async () => {
          let observed: DeniedPathInventory = { entries: {} };
          let observeError: unknown;
          try {
            observed = await captureDeniedPathInventory(canonicalProjectRoot, recoverySandbox);
          } catch (error: unknown) {
            observeError = error;
            observed = await inventoryRoots(canonicalProjectRoot, roots).catch(() => ({
              entries: {},
            }));
          }
          const result = await beginQuarantineRecovery(canonicalProjectRoot, tempRoot, observed);
          if (observeError) {
            if (observeError instanceof Error) throw observeError;
            const message =
              typeof observeError === "string"
                ? observeError
                : typeof observeError === "object" &&
                    observeError !== null &&
                    "message" in observeError &&
                    typeof (observeError as { message?: unknown }).message === "string"
                  ? (observeError as { message: string }).message
                  : "unknown non-Error failure";
            throw new Error(`Denied-path observation failed: ${message}`);
          }
          return result;
        })();
      }
      return finishPromise;
    },
  };
}
