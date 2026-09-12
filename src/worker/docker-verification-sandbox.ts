// Disposable Docker verification for worker-controlled source trees.
//
// Project bytes are copied into a named volume without a bind mount or image
// build. Dependency setup can reach only explicitly configured HTTPS registry
// origins through a fixed CONNECT proxy; verification itself has no network.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { DockerOfflineNativeRebuild, DockerVerificationSandboxConfig } from "../core/types.js";
import { scanForSecrets } from "../judgment/producers/secret-scan.js";
import { resolveTrustedExecutable } from "./trusted-executable.js";

const CONTAINER_UID = "65532:65532";
const MAX_STAGED_FILES = 100_000;
const MAX_SECRET_SCAN_FILE_BYTES = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 30_000;
const PROXY_PORT = 3128;
const NPM_USER_CONFIG = "/tmp/quack-npm-userconfig";
const NPM_GLOBAL_CONFIG = "/tmp/quack-npm-globalconfig";
const RESOURCE_LABEL = "com.quack.verification-session";
const OWNER_PID_LABEL = "com.quack.verification-owner-pid";
const CREATED_AT_LABEL = "com.quack.verification-created-at";
const STALE_RESOURCE_GRACE_MS = 2_000;
const CLEANUP_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000, 2_000, 2_000] as const;
const ACTIVE_SESSION_IDS = new Set<string>();
const TEMP_SESSION_PARENT = "quack-verification-sessions-v1";
const TEMP_SESSION_MANIFEST = ".quack-verification-session.json";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".jest-cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".temp",
  ".tmp",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "log",
  "logs",
  "node_modules",
  "out",
  "temp",
  "tmp",
  "worktrees",
]);

const PRIVATE_KEY_NAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const PRIVATE_KEY_EXTENSIONS = new Set([
  ".der",
  ".jks",
  ".key",
  ".keystore",
  ".kdbx",
  ".p12",
  ".pem",
  ".pfx",
  ".pkcs12",
  ".ppk",
]);
const BLOCKED_CONTAINER_ENV =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API[_-]?KEY|PRIVATE[_-]?KEY)/i;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const IMMUTABLE_NODE_IMAGE =
  /^(?:docker\.io\/library\/)?node(?::[A-Za-z0-9._-]+)?@sha256:[a-fA-F0-9]{64}$/;
const STRONG_INTEGRITY = /^(?:sha512|sha384|sha256)-[A-Za-z0-9+/]+={0,2}$/;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NORMALIZED_NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function isCanonicalSha512Sri(value: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

const NATIVE_REBUILD_ATTESTATION_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const packageName = process.argv[1];
const expectedVersion = process.argv[2];
const expectedInstall = process.argv[3];
const root = fs.realpathSync.native(process.cwd());
const packageRoot = path.resolve(root, "node_modules", ...packageName.split("/"));
const relative = path.relative(root, packageRoot);
if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
  throw new Error("native rebuild package path escapes its dependency root");
}
const rootStat = fs.lstatSync(packageRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("native rebuild package is not a regular directory");
}
const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
if (canonicalPackageRoot !== packageRoot) {
  throw new Error("native rebuild package directory is aliased");
}
const manifestPath = path.join(packageRoot, "package.json");
const manifestStat = fs.lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
  throw new Error("native rebuild package manifest is not a regular file");
}
if (fs.realpathSync.native(manifestPath) !== manifestPath) {
  throw new Error("native rebuild package manifest is aliased");
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.name !== packageName || manifest.version !== expectedVersion) {
  throw new Error("native rebuild package identity does not match its allowlist");
}
const scripts = manifest.scripts;
if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) || scripts.install !== expectedInstall) {
  throw new Error("native rebuild install script does not match its allowlist");
}
for (const name of ["preinstall", "postinstall", "prepare"]) {
  if (Object.prototype.hasOwnProperty.call(scripts, name)) {
    throw new Error("native rebuild package declares an unapproved " + name + " lifecycle script");
  }
}
`;

const REGISTRY_PROXY_SCRIPT = String.raw`
"use strict";
const net = require("node:net");
const allow = JSON.parse(process.env.QV_ALLOWED_REGISTRIES || "{}");
let nextAddress = 0;
const server = net.createServer((client) => {
  client.setTimeout(15000, () => client.destroy());
  client.once("data", (chunk) => {
    if (chunk.length > 8192) return client.destroy();
    const firstLine = chunk.toString("ascii").split("\r\n", 1)[0];
    const match = /^CONNECT ([A-Za-z0-9.-]+):(\d+) HTTP\/1\.[01]$/.exec(firstLine);
    if (!match || Number(match[2]) !== 443) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const addresses = allow[match[1].toLowerCase()];
    if (!Array.isArray(addresses) || addresses.length === 0) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const address = addresses[nextAddress++ % addresses.length];
    const upstream = net.connect({ host: address, port: 443 });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  });
});
server.listen(${PROXY_PORT}, "0.0.0.0");
`;

const PROXY_READY_SCRIPT = String.raw`
const net = require("node:net");
const socket = net.connect({ host: "127.0.0.1", port: ${PROXY_PORT} });
socket.setTimeout(1000, () => { socket.destroy(); process.exit(1); });
socket.once("connect", () => { socket.destroy(); process.exit(0); });
socket.once("error", () => process.exit(1));
`;

export interface DockerVerificationCommand {
  cwd: string;
  command?: string;
  executable?: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

export interface DockerVerificationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface DockerCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

type DockerCommandRunner = (
  executable: string,
  args: readonly string[],
  options: DockerCommandOptions,
) => Promise<DockerVerificationResult>;
type DockerExecutableResolver = (projectRoot: string) => string;
type RegistryDnsResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

let dockerCommandRunner: DockerCommandRunner = runDockerCommand;
let dockerExecutableResolver: DockerExecutableResolver = (projectRoot) =>
  resolveTrustedExecutable("docker", projectRoot, "Docker CLI");
let registryDnsResolver: RegistryDnsResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });
let dockerVerificationDelay = delay;

/** Test seam. Production always uses a canonical Docker executable and spawn. */
export function _setDockerVerificationCommandRunner(runner: DockerCommandRunner | undefined): void {
  dockerCommandRunner = runner ?? runDockerCommand;
}

/** Test seam for hosts without Docker installed. */
export function _setDockerVerificationExecutableResolver(
  resolver: DockerExecutableResolver | undefined,
): void {
  dockerExecutableResolver =
    resolver ?? ((projectRoot) => resolveTrustedExecutable("docker", projectRoot, "Docker CLI"));
}

/** Test seam. Production registry resolution always uses the trusted host resolver. */
export function _setDockerVerificationDnsResolver(resolver: RegistryDnsResolver | undefined): void {
  registryDnsResolver = resolver ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
}

/** Test seam for cleanup backoff; production waits between absence checks. */
export function _setDockerVerificationDelay(
  replacement: ((milliseconds: number) => Promise<void>) | undefined,
): void {
  dockerVerificationDelay = replacement ?? delay;
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  return (
    normalized === "" ||
    (normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized))
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env") ||
    lower === ".npmrc" ||
    lower === ".netrc" ||
    lower === ".yarnrc" ||
    lower === ".yarnrc.yml" ||
    lower === "credentials" ||
    lower === "credentials.json" ||
    PRIVATE_KEY_NAMES.has(lower) ||
    PRIVATE_KEY_EXTENSIONS.has(path.extname(lower))
  );
}

function normalizeDeniedPattern(value: unknown, index: number): string {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`Docker verification deniedPaths[${index}] is not a safe relative pattern`);
  }
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Docker verification deniedPaths[${index}] is not a safe relative pattern`);
  }
  if (process.platform === "win32") {
    for (const segment of normalized.split("/")) {
      if (segment.includes(":") || /[. ]$/.test(segment)) {
        throw new Error(`Docker verification deniedPaths[${index}] uses an unsafe Windows path`);
      }
      if (!segment.includes("*")) {
        const device = segment.split(".", 1)[0].toUpperCase();
        if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(device)) {
          throw new Error(`Docker verification deniedPaths[${index}] uses a Windows device path`);
        }
      }
    }
  }
  return normalized;
}

function deniedPatternRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}(?:/.*)?$`, process.platform === "win32" ? "i" : undefined);
}

interface DeniedPathPolicy {
  patterns: readonly string[];
  matchers: readonly RegExp[];
}

async function compileDeniedPathPolicy(
  canonicalWorktree: string,
  deniedPaths: readonly string[],
): Promise<DeniedPathPolicy> {
  const patterns = deniedPaths.map(normalizeDeniedPattern);
  const comparisonKeys = patterns.map((pattern) =>
    process.platform === "win32" ? pattern.toLowerCase() : pattern,
  );
  if (new Set(comparisonKeys).size !== comparisonKeys.length) {
    throw new Error("Docker verification deniedPaths contains duplicate patterns");
  }

  for (const pattern of patterns) {
    if (pattern.includes("*")) continue;
    const candidate = path.resolve(canonicalWorktree, ...pattern.split("/"));
    if (!isInsidePath(canonicalWorktree, candidate)) {
      throw new Error(`Docker verification denied path escapes the worktree: ${pattern}`);
    }
    try {
      const before = await fs.lstat(candidate);
      if (before.isSymbolicLink()) {
        throw new Error(`Docker verification denied path is aliased: ${pattern}`);
      }
      const canonical = await fs.realpath(candidate);
      if (!samePath(candidate, canonical) || !isInsidePath(canonicalWorktree, canonical)) {
        throw new Error(`Docker verification denied path is aliased: ${pattern}`);
      }
      if (!before.isDirectory() && !before.isFile()) {
        throw new Error(`Docker verification denied path is not regular: ${pattern}`);
      }
      if (before.isFile() && before.nlink > 1) {
        throw new Error(`Docker verification denied path is hard-linked: ${pattern}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { patterns, matchers: patterns.map(deniedPatternRegex) };
}

function shouldExcludeWorktreePath(
  relativePath: string,
  isDirectory: boolean,
  deniedPolicy: DeniedPathPolicy,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const name = segments.at(-1)?.toLowerCase() ?? "";
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return true;
  if (segments[0]?.toLowerCase() === ".quack") return true;
  if (isSecretFileName(name)) return true;
  if (deniedPolicy.matchers.some((matcher) => matcher.test(normalized))) return true;
  return isDirectory && EXCLUDED_DIRECTORY_NAMES.has(name);
}

function shouldIncludeAuthoritativeQuackPath(relativePath: string, isDirectory: boolean): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const first = segments[0]?.toLowerCase() ?? "";
  const name = segments.at(-1)?.toLowerCase() ?? "";
  if (isSecretFileName(name)) return false;
  if (first === "convention-checks" || first === "templates") return true;
  if (segments.length > 1 || isDirectory) return false;
  return (
    name === "adapter.json" ||
    name === "verify.js" ||
    name === "judge-criteria.md" ||
    name === "conventions.md" ||
    name.endsWith(".config.json") ||
    name.endsWith(".md")
  );
}

interface CopyBudget {
  bytes: number;
  files: number;
  maxBytes: number;
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function checkedBigIntNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Docker verification ${label} is not safely representable`);
  }
  return Number(value);
}

async function readAndScanStagingFile(
  filePath: string,
  relativePath: string,
  expected: BigIntStats,
): Promise<Buffer> {
  if (expected.size > BigInt(MAX_SECRET_SCAN_FILE_BYTES)) {
    throw new Error(
      `Docker verification staging refused file larger than the bounded secret-scan limit: ${relativePath}`,
    );
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const openedPath = await fs.lstat(filePath, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !openedPath.isFile() ||
      openedPath.isSymbolicLink() ||
      openedPath.nlink !== 1n ||
      !sameFileMetadata(expected, opened) ||
      !sameFileMetadata(opened, openedPath)
    ) {
      throw new Error(`Docker verification source changed during secure open: ${relativePath}`);
    }

    const expectedSize = checkedBigIntNumber(expected.size, `file size for ${relativePath}`);
    const buffer = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`Docker verification source changed during secret scan: ${relativePath}`);
      }
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, expectedSize);
    if (extraBytes !== 0) {
      throw new Error(`Docker verification source changed during secret scan: ${relativePath}`);
    }

    const finalOpened = await handle.stat({ bigint: true });
    const finalPath = await fs.lstat(filePath, { bigint: true });
    if (
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalPath.nlink !== 1n ||
      !sameFileMetadata(opened, finalOpened) ||
      !sameFileMetadata(finalOpened, finalPath)
    ) {
      throw new Error(`Docker verification source changed during secret scan: ${relativePath}`);
    }

    const repoRelativePath = relativePath.replace(/\\/g, "/");
    if (
      scanForSecrets([{ file: repoRelativePath, content: buffer.toString("utf8") }]).safetyCount > 0
    ) {
      throw new Error(
        `Docker verification staging refused safety-tier secret material: ${relativePath}`,
      );
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function copySafeTree(
  sourceRoot: string,
  destinationRoot: string,
  budget: CopyBudget,
  include: (relativePath: string, isDirectory: boolean) => boolean,
): Promise<void> {
  const canonicalSourceRoot = await fs.realpath(sourceRoot);
  await fs.mkdir(destinationRoot, { recursive: true });

  const visit = async (relativeDirectory: string): Promise<void> => {
    const sourceDirectory = path.join(canonicalSourceRoot, relativeDirectory);
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const sourcePath = path.join(canonicalSourceRoot, relativePath);
      const destinationPath = path.join(destinationRoot, relativePath);
      const before = await fs.lstat(sourcePath, { bigint: true });
      if (before.isSymbolicLink()) {
        throw new Error(`Docker verification staging refused filesystem alias: ${relativePath}`);
      }

      const isDirectory = before.isDirectory();
      const canonicalEntry = await fs.realpath(sourcePath);
      if (
        !isInsidePath(canonicalSourceRoot, canonicalEntry) ||
        !samePath(sourcePath, canonicalEntry)
      ) {
        throw new Error(`Docker verification staging refused reparse traversal: ${relativePath}`);
      }
      if (!isDirectory && !before.isFile()) {
        throw new Error(`Docker verification staging refused non-regular file: ${relativePath}`);
      }
      if (before.isFile() && before.nlink > 1n) {
        throw new Error(`Docker verification staging refused hard-linked file: ${relativePath}`);
      }
      if (!include(relativePath, isDirectory)) continue;

      if (isDirectory) {
        await fs.mkdir(destinationPath, { recursive: true });
        await visit(relativePath);
        continue;
      }
      const nextFileCount = budget.files + 1;
      const fileSize = checkedBigIntNumber(before.size, `file size for ${relativePath}`);
      const nextByteCount = budget.bytes + fileSize;
      if (nextFileCount > MAX_STAGED_FILES || nextByteCount > budget.maxBytes) {
        throw new Error(
          `Docker verification context exceeds limit (${nextFileCount} files, ${nextByteCount} bytes)`,
        );
      }
      // Copy exactly the bytes that were inspected, from a no-follow handle.
      // Reopening the worker path after scanning would allow a same-size swap
      // to stage different bytes from those approved by the scanner.
      const stagedContent = await readAndScanStagingFile(sourcePath, relativePath, before);

      budget.files = nextFileCount;
      budget.bytes = nextByteCount;
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      const fileMode = checkedBigIntNumber(before.mode & 0o777n, `file mode for ${relativePath}`);
      await fs.writeFile(destinationPath, stagedContent, { flag: "wx", mode: fileMode });
      await fs.chmod(destinationPath, fileMode);

      const after = await fs.lstat(sourcePath, { bigint: true });
      if (after.isSymbolicLink() || !sameFileMetadata(before, after)) {
        throw new Error(`Docker verification source changed during staging: ${relativePath}`);
      }
    }
  };

  await visit("");
}

function safeDependencyRoot(value: string): string {
  if (
    value === "." ||
    (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
      !value.split("/").some((segment) => segment === "." || segment === ".."))
  ) {
    return value;
  }
  throw new Error(`Docker verification dependency root is not a safe relative path: ${value}`);
}

function validateOfflineNativeRebuildEntry(
  entry: DockerOfflineNativeRebuild,
  dependencyRoots: ReadonlySet<string>,
): void {
  const dependencyRoot = safeDependencyRoot(entry.dependencyRoot);
  if (!dependencyRoots.has(dependencyRoot)) {
    throw new Error(
      `Docker verification native rebuild root is not configured for dependency setup: ${dependencyRoot}`,
    );
  }
  if (!NORMALIZED_NPM_PACKAGE.test(entry.packageName)) {
    throw new Error(
      `Docker verification native rebuild package name is unsafe: ${entry.packageName}`,
    );
  }
  if (!EXACT_SEMVER.test(entry.version)) {
    throw new Error(
      `Docker verification native rebuild version is not exact: ${entry.packageName}`,
    );
  }
  if (!isCanonicalSha512Sri(entry.integrity)) {
    throw new Error(
      `Docker verification native rebuild integrity is not an exact sha512 SRI: ${entry.packageName}`,
    );
  }
  if (
    typeof entry.installScript !== "string" ||
    entry.installScript.length === 0 ||
    entry.installScript.length > 512 ||
    /[\0\r\n]/.test(entry.installScript)
  ) {
    throw new Error(
      `Docker verification native rebuild install script is invalid: ${entry.packageName}`,
    );
  }
}

async function assertNoProjectNpmConfig(
  canonicalWorktree: string,
  dependencyRoots: readonly string[],
): Promise<void> {
  for (const relativeRoot of dependencyRoots) {
    const requested = path.resolve(
      canonicalWorktree,
      ...safeDependencyRoot(relativeRoot).split("/"),
    );
    const canonicalPackageRoot = await fs.realpath(requested);
    if (
      !isInsidePath(canonicalWorktree, canonicalPackageRoot) ||
      !samePath(requested, canonicalPackageRoot)
    ) {
      throw new Error(
        `Docker verification dependency root is aliased or outside the worktree: ${relativeRoot}`,
      );
    }
    const metadata = await fs.stat(canonicalPackageRoot);
    if (!metadata.isDirectory()) {
      throw new Error(`Docker verification dependency root is not a directory: ${relativeRoot}`);
    }
    let current = canonicalPackageRoot;
    while (isInsidePath(canonicalWorktree, current)) {
      try {
        await fs.lstat(path.join(current, ".npmrc"));
        throw new Error(
          `Docker verification refuses project .npmrc at ${path.relative(canonicalWorktree, current) || "."}`,
        );
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (samePath(current, canonicalWorktree)) break;
      current = path.dirname(current);
    }
  }
}

export interface StagedDockerVerificationContext {
  contextRoot: string;
  workspaceRoot: string;
  machineryRoot: string;
}

interface VerificationSessionIdentity {
  sessionId: string;
  ownerPid: number;
  createdAt: number;
}

/** Copy a filtered snapshot without following filesystem aliases. */
export async function stageDockerVerificationContext(input: {
  worktreeRoot: string;
  authoritativeRoot: string;
  config: DockerVerificationSandboxConfig;
  deniedPaths?: readonly string[];
  sessionIdentity?: VerificationSessionIdentity;
}): Promise<StagedDockerVerificationContext> {
  const canonicalWorktree = await fs.realpath(input.worktreeRoot);
  const canonicalAuthoritative = await fs.realpath(input.authoritativeRoot);
  const deniedPolicy = await compileDeniedPathPolicy(canonicalWorktree, input.deniedPaths ?? []);
  await assertNoProjectNpmConfig(canonicalWorktree, input.config.dependencyRoots);
  const canonicalTempParent = await canonicalVerificationTempParent(
    canonicalWorktree,
    canonicalAuthoritative,
  );
  const identity = input.sessionIdentity ?? {
    sessionId: randomUUID().replace(/-/g, "").toLowerCase(),
    ownerPid: process.pid,
    createdAt: Date.now(),
  };
  if (!/^[a-f0-9]{32}$/.test(identity.sessionId)) {
    throw new Error("Docker verification session id is invalid");
  }
  const contextRoot = path.join(canonicalTempParent, identity.sessionId);
  await fs.mkdir(contextRoot, { recursive: false, mode: 0o700 });
  const workspaceRoot = path.join(contextRoot, "workspace");
  const machineryRoot = path.join(contextRoot, "machinery");
  const budget: CopyBudget = { bytes: 0, files: 0, maxBytes: input.config.maxContextBytes };

  try {
    await fs.writeFile(
      path.join(contextRoot, TEMP_SESSION_MANIFEST),
      `${JSON.stringify({ version: 1, ...identity })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await copySafeTree(
      canonicalWorktree,
      workspaceRoot,
      budget,
      (relativePath, isDirectory) =>
        !shouldExcludeWorktreePath(relativePath, isDirectory, deniedPolicy),
    );
    await fs.mkdir(machineryRoot, { recursive: false });
    const authoritativeQuack = path.join(canonicalAuthoritative, ".quack");
    try {
      const authoritativeStat = await fs.lstat(authoritativeQuack);
      if (authoritativeStat.isSymbolicLink() || !authoritativeStat.isDirectory()) {
        throw new Error("authoritative .quack verification machinery is not a regular directory");
      }
      const canonicalQuack = await fs.realpath(authoritativeQuack);
      if (
        !isInsidePath(canonicalAuthoritative, canonicalQuack) ||
        !samePath(authoritativeQuack, canonicalQuack)
      ) {
        throw new Error("authoritative .quack verification machinery is aliased");
      }
      await copySafeTree(
        canonicalQuack,
        machineryRoot,
        budget,
        shouldIncludeAuthoritativeQuackPath,
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { contextRoot, workspaceRoot, machineryRoot };
  } catch (error) {
    try {
      await removeVerifiedTempDirectory(contextRoot, canonicalTempParent, identity);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function unsafeDependencySpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed.startsWith("npm:")) {
    const alias = trimmed.slice(4);
    const match =
      /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/i.exec(
        alias,
      );
    return !match || (match[1] !== undefined && /[:\\/\0\r\n]/.test(match[1]));
  }
  return (
    /^(?:[a-z][a-z0-9+.-]*:|git@|\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(trimmed) ||
    /[\\\0\r\n]/.test(trimmed) ||
    /^[^@\s/]+\/[^/\s]+(?:#.*)?$/.test(trimmed)
  );
}

function findUnsafeOverride(value: unknown, location = "overrides"): string | undefined {
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

function findUnsafeLockEntry(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
  location = "lockfile",
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findUnsafeLockEntry(value[index], allowedOrigins, `${location}[${index}]`);
      if (finding) return finding;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.link === true) {
    return `${location} uses a local link dependency`;
  }
  if (typeof record.version === "string" && unsafeDependencySpec(record.version)) {
    return `${location}.version uses an unsafe dependency spec`;
  }
  if ("resolved" in record) {
    if (typeof record.resolved !== "string") return `${location}.resolved is not a URL string`;
    try {
      const resolved = new URL(record.resolved);
      if (
        resolved.protocol !== "https:" ||
        resolved.username ||
        resolved.password ||
        !allowedOrigins.has(resolved.origin)
      ) {
        return `${location}.resolved is outside the configured registry origins`;
      }
    } catch {
      return `${location}.resolved is not an allowed HTTPS registry URL`;
    }
    if (typeof record.integrity !== "string" || !STRONG_INTEGRITY.test(record.integrity)) {
      return `${location}.integrity is missing or not a strong SRI digest`;
    }
  }
  for (const [key, child] of Object.entries(record)) {
    const finding = findUnsafeLockEntry(child, allowedOrigins, `${location}.${key}`);
    if (finding) return finding;
  }
  return undefined;
}

async function assertRegularContainedFile(
  canonicalRoot: string,
  filePath: string,
  label: string,
): Promise<void> {
  const metadata = await fs.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  const canonical = await fs.realpath(filePath);
  if (!isInsidePath(canonicalRoot, canonical) || !samePath(filePath, canonical)) {
    throw new Error(`${label} is aliased or outside the staged workspace`);
  }
}

/** Validate every manifest and lockfile that will drive dependency setup. */
export async function validateDockerDependencyMetadata(input: {
  workspaceRoot: string;
  dependencyRoots: readonly string[];
  allowedRegistryOrigins: readonly string[];
  offlineNativeRebuilds?: readonly DockerOfflineNativeRebuild[];
}): Promise<void> {
  const canonicalWorkspace = await fs.realpath(input.workspaceRoot);
  const allowedOrigins = new Set(input.allowedRegistryOrigins);
  const dependencyRoots = new Set(input.dependencyRoots.map(safeDependencyRoot));
  const offlineNativeRebuilds = input.offlineNativeRebuilds ?? [];
  const rebuildKeys = new Set<string>();
  for (const rebuild of offlineNativeRebuilds) {
    validateOfflineNativeRebuildEntry(rebuild, dependencyRoots);
    const key = `${rebuild.dependencyRoot}\0${rebuild.packageName}`;
    if (rebuildKeys.has(key)) {
      throw new Error(
        `Docker verification native rebuild is duplicated: ${rebuild.dependencyRoot}/${rebuild.packageName}`,
      );
    }
    rebuildKeys.add(key);
  }
  for (const rawRoot of input.dependencyRoots) {
    const relativeRoot = safeDependencyRoot(rawRoot);
    const rootRebuilds = offlineNativeRebuilds.filter(
      (rebuild) => rebuild.dependencyRoot === relativeRoot,
    );
    const packageRoot = path.resolve(canonicalWorkspace, ...relativeRoot.split("/"));
    const canonicalPackageRoot = await fs.realpath(packageRoot);
    if (
      !isInsidePath(canonicalWorkspace, canonicalPackageRoot) ||
      !samePath(packageRoot, canonicalPackageRoot)
    ) {
      throw new Error(
        `Docker verification dependency root is aliased or outside the staged workspace: ${relativeRoot}`,
      );
    }
    let ancestor = path.dirname(canonicalPackageRoot);
    while (isInsidePath(canonicalWorkspace, ancestor)) {
      const ancestorManifest = path.join(ancestor, "package.json");
      try {
        await assertRegularContainedFile(
          canonicalWorkspace,
          ancestorManifest,
          `${path.relative(canonicalWorkspace, ancestor) || "."}/package.json`,
        );
        const ancestorPackage = JSON.parse(await fs.readFile(ancestorManifest, "utf8")) as Record<
          string,
          unknown
        >;
        if (ancestorPackage.workspaces !== undefined) {
          throw new Error(
            `${path.relative(canonicalWorkspace, ancestor) || "."}/package.json cannot make ${relativeRoot} an implicit workspace`,
          );
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (samePath(ancestor, canonicalWorkspace)) break;
      ancestor = path.dirname(ancestor);
    }
    const packageJsonPath = path.join(canonicalPackageRoot, "package.json");
    await assertRegularContainedFile(
      canonicalWorkspace,
      packageJsonPath,
      `${relativeRoot}/package.json`,
    );
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (packageJson.workspaces !== undefined) {
      throw new Error(
        `${relativeRoot}/package.json workspaces are not allowed; configure each package root explicitly`,
      );
    }
    if (
      packageJson.packageManager !== undefined &&
      (typeof packageJson.packageManager !== "string" ||
        !/^npm@[0-9][A-Za-z0-9._+-]*$/.test(packageJson.packageManager))
    ) {
      throw new Error(`${relativeRoot}/package.json declares a non-npm or unsafe package manager`);
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = packageJson[field];
      if (dependencies === undefined) continue;
      if (
        typeof dependencies !== "object" ||
        dependencies === null ||
        Array.isArray(dependencies)
      ) {
        throw new Error(`${relativeRoot}/package.json has invalid ${field}`);
      }
      for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== "string" || unsafeDependencySpec(spec)) {
          throw new Error(`Unsafe ${field} spec for ${name} in ${relativeRoot}/package.json`);
        }
      }
    }
    if (packageJson.overrides !== undefined) {
      const finding = findUnsafeOverride(packageJson.overrides);
      if (finding) throw new Error(`${relativeRoot}/package.json ${finding}`);
    }

    let lockCount = 0;
    for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const lockPath = path.join(canonicalPackageRoot, lockName);
      try {
        await assertRegularContainedFile(
          canonicalWorkspace,
          lockPath,
          `${relativeRoot}/${lockName}`,
        );
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      lockCount += 1;
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
      if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
        throw new Error(`${relativeRoot}/${lockName} must use lockfileVersion 2 or 3`);
      }
      const finding = findUnsafeLockEntry(lock, allowedOrigins, `${relativeRoot}/${lockName}`);
      if (finding) throw new Error(finding);
      const packages = lock.packages;
      if (
        rootRebuilds.length > 0 &&
        (typeof packages !== "object" || packages === null || Array.isArray(packages))
      ) {
        throw new Error(`${relativeRoot}/${lockName} has no packages map for native rebuilds`);
      }
      for (const rebuild of rootRebuilds) {
        const key = `node_modules/${rebuild.packageName}`;
        const record = (packages as Record<string, unknown>)[key];
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
          throw new Error(
            `${relativeRoot}/${lockName} does not lock native rebuild package ${rebuild.packageName}`,
          );
        }
        const packageLock = record as Record<string, unknown>;
        if (
          packageLock.version !== rebuild.version ||
          packageLock.integrity !== rebuild.integrity ||
          packageLock.hasInstallScript !== true
        ) {
          throw new Error(
            `${relativeRoot}/${lockName} native rebuild package ${rebuild.packageName} does not match its exact version, integrity, and install-script lock attestation`,
          );
        }
      }
    }
    if (lockCount !== 1) {
      throw new Error(
        `${relativeRoot} must contain exactly one package-lock.json or npm-shrinkwrap.json`,
      );
    }
  }
}

function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    )
      return false;
    const [a, b, c] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isGloballyRoutableAddress(mapped[1]);
  const hextets = normalized.split(":");
  const first = Number.parseInt(hextets[0] || "0", 16);
  const second = Number.parseInt(hextets[1] || "0", 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  return !(
    (first === 0x2001 &&
      (second === 0 || second === 2 || second === 0x0db8 || (second >= 0x10 && second <= 0x2f))) ||
    first === 0x2002
  );
}

interface ResolvedRegistry {
  origin: string;
  hostname: string;
  addresses: string[];
}

async function resolveAllowedRegistries(origins: readonly string[]): Promise<ResolvedRegistry[]> {
  const normalized = new Set<string>();
  const result: ResolvedRegistry[] = [];
  for (const rawOrigin of origins) {
    let url: URL;
    try {
      url = new URL(rawOrigin);
    } catch {
      throw new Error(`Docker verification registry origin is not a URL: ${rawOrigin}`);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isIP(url.hostname) !== 0
    ) {
      throw new Error(
        `Docker verification registry must be a credential-free HTTPS hostname origin: ${rawOrigin}`,
      );
    }
    if (normalized.has(url.origin)) {
      throw new Error(`Docker verification registry origin is duplicated: ${url.origin}`);
    }
    normalized.add(url.origin);
    const answers = await registryDnsResolver(url.hostname);
    if (answers.length === 0)
      throw new Error(`Docker verification registry did not resolve: ${url.hostname}`);
    const addresses = [...new Set(answers.map((answer) => answer.address))];
    if (addresses.some((address) => !isGloballyRoutableAddress(address))) {
      throw new Error(
        `Docker verification registry resolved to a non-global address: ${url.hostname}`,
      );
    }
    result.push({ origin: url.origin, hostname: url.hostname.toLowerCase(), addresses });
  }
  return result;
}

function cleanHostEnvironment(dockerExecutable: string, isolatedHome: string): NodeJS.ProcessEnv {
  const isolatedTemp = path.join(isolatedHome, "tmp");
  const environment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    DOCKER_CONFIG: path.join(isolatedHome, ".docker"),
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
    TMPDIR: isolatedTemp,
  };
  for (const requested of ["SYSTEMROOT", "WINDIR"]) {
    const actual = Object.keys(process.env).find((name) => name.toUpperCase() === requested);
    if (actual && process.env[actual] !== undefined) environment[actual] = process.env[actual];
  }
  const search = [path.dirname(dockerExecutable)];
  const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR;
  if (process.platform === "win32" && systemRoot) search.push(path.join(systemRoot, "System32"));
  else search.push("/usr/bin", "/bin");
  environment.PATH = search.join(path.delimiter);
  return environment;
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): Buffer<ArrayBufferLike> {
  if (current.length >= limit) return current;
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

function sanitizeOutput(buffer: Buffer<ArrayBufferLike>, truncated: boolean): string {
  const value = buffer.toString("utf8").replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTER, "");
  return truncated ? `${value}\n... [docker verification output truncated]` : value;
}

function sanitizeTextOutput(value: string, limit: number): string {
  const buffer = Buffer.from(value, "utf8");
  return sanitizeOutput(buffer.subarray(0, limit), buffer.length > limit);
}

async function runDockerCommand(
  executable: string,
  args: readonly string[],
  options: DockerCommandOptions,
): Promise<DockerVerificationResult> {
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const finish = (result: DockerVerificationResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        exitCode: 1,
        stdout: "",
        stderr: `Docker spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (stdout.length + chunk.length > options.maxOutputBytes) stdoutTruncated = true;
      stdout = appendBounded(stdout, chunk, options.maxOutputBytes);
    });
    child.stderr?.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (stderr.length + chunk.length > options.maxOutputBytes) stderrTruncated = true;
      stderr = appendBounded(stderr, chunk, options.maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        exitCode: 1,
        stdout: sanitizeOutput(stdout, stdoutTruncated),
        stderr:
          sanitizeOutput(stderr, stderrTruncated) || `Docker execution failed: ${error.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exitCode: timedOut ? 1 : (code ?? 1),
        stdout: sanitizeOutput(stdout, stdoutTruncated),
        stderr: timedOut
          ? `Docker command timed out after ${options.timeoutMs}ms`
          : sanitizeOutput(stderr, stderrTruncated),
        timedOut,
      });
    });
  });
}

function validateContainerEnvironment(environment: Record<string, string> | undefined): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || BLOCKED_CONTAINER_ENV.test(name)) {
      throw new Error(`Docker verification refused sensitive environment variable ${name}`);
    }
    if (value.includes("\0") || /[\r\n]/.test(value)) {
      throw new Error(`Docker verification refused invalid environment value for ${name}`);
    }
    args.push("--env", `${name}=${value}`);
  }
  return args;
}

async function readTempSessionManifest(
  tempPath: string,
  tempParent: string,
): Promise<VerificationSessionIdentity> {
  const canonicalParent = await fs.realpath(tempParent);
  const resolvedTarget = path.resolve(tempPath);
  if (
    !samePath(path.dirname(resolvedTarget), canonicalParent) ||
    !/^[a-f0-9]{32}$/.test(path.basename(resolvedTarget))
  ) {
    throw new Error("Refusing Docker verification cleanup outside an exact session directory");
  }
  const targetMetadata = await fs.lstat(resolvedTarget);
  const canonicalTarget = await fs.realpath(resolvedTarget);
  if (
    targetMetadata.isSymbolicLink() ||
    !targetMetadata.isDirectory() ||
    !samePath(resolvedTarget, canonicalTarget) ||
    !isInsidePath(canonicalParent, canonicalTarget)
  ) {
    throw new Error("Refusing Docker verification cleanup of an aliased session directory");
  }
  const manifestPath = path.join(canonicalTarget, TEMP_SESSION_MANIFEST);
  const manifestMetadata = await fs.lstat(manifestPath);
  if (
    manifestMetadata.isSymbolicLink() ||
    !manifestMetadata.isFile() ||
    manifestMetadata.size > 4096 ||
    !samePath(manifestPath, await fs.realpath(manifestPath))
  ) {
    throw new Error("Docker verification temp manifest is not a bounded regular file");
  }
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Docker verification temp manifest is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "createdAt,ownerPid,sessionId,version" ||
    record.version !== 1 ||
    record.sessionId !== path.basename(canonicalTarget) ||
    !Number.isSafeInteger(record.ownerPid) ||
    Number(record.ownerPid) <= 0 ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) <= 0 ||
    Number(record.createdAt) > Date.now() + 60_000
  ) {
    throw new Error("Docker verification temp manifest has invalid ownership metadata");
  }
  return {
    sessionId: String(record.sessionId),
    ownerPid: Number(record.ownerPid),
    createdAt: Number(record.createdAt),
  };
}

async function removeVerifiedTempDirectory(
  tempPath: string,
  tempParent: string,
  expected: VerificationSessionIdentity,
): Promise<void> {
  const manifest = await readTempSessionManifest(tempPath, tempParent);
  if (
    manifest.sessionId !== expected.sessionId ||
    manifest.ownerPid !== expected.ownerPid ||
    manifest.createdAt !== expected.createdAt
  ) {
    throw new Error("Refusing Docker verification cleanup after temp manifest identity changed");
  }
  const resolvedTarget = path.resolve(tempPath);
  await fs.rm(resolvedTarget, { recursive: true, force: true });
  try {
    await fs.lstat(resolvedTarget);
    throw new Error(`Docker verification temp cleanup was incomplete: ${resolvedTarget}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function canonicalVerificationTempParent(
  canonicalWorktree: string,
  canonicalAuthoritative: string,
): Promise<string> {
  const canonicalSystemTemp = await fs.realpath(tmpdir());
  const requested = path.join(canonicalSystemTemp, TEMP_SESSION_PARENT);
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(requested);
  const canonical = await fs.realpath(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !samePath(requested, canonical)) {
    throw new Error("Docker verification temp parent is a filesystem alias");
  }
  if (
    isInsidePath(canonicalWorktree, canonical) ||
    isInsidePath(canonicalAuthoritative, canonical)
  ) {
    throw new Error("Docker verification temp directory is inside a mutable project root");
  }
  return canonical;
}

async function sweepStaleTempSessions(tempParent: string): Promise<void> {
  const entries = await fs.readdir(tempParent, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Docker verification found an aliased temp session entry");
    }
    const sessionPath = path.join(tempParent, entry.name);
    const manifest = await readTempSessionManifest(sessionPath, tempParent);
    if (ACTIVE_SESSION_IDS.has(manifest.sessionId)) continue;
    if (manifest.ownerPid !== process.pid && isProcessAlive(manifest.ownerPid)) continue;
    const age = Date.now() - manifest.createdAt;
    if (age < STALE_RESOURCE_GRACE_MS) {
      await dockerVerificationDelay(STALE_RESOURCE_GRACE_MS - age);
    }
    const confirmed = await readTempSessionManifest(sessionPath, tempParent);
    if (
      confirmed.sessionId !== manifest.sessionId ||
      confirmed.ownerPid !== manifest.ownerPid ||
      confirmed.createdAt !== manifest.createdAt
    ) {
      throw new Error("Docker verification temp manifest changed during stale-session recovery");
    }
    if (confirmed.ownerPid !== process.pid && isProcessAlive(confirmed.ownerPid)) continue;
    await removeVerifiedTempDirectory(sessionPath, tempParent, confirmed);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type DockerResourceKind = "container" | "volume" | "network";

interface DockerResourceSession {
  pid: number;
  createdAt: number;
}

export class DockerVerificationSession {
  private readonly dockerExecutable: string;
  private readonly dockerEnvironment: NodeJS.ProcessEnv;
  private readonly safeCwd: string;
  private readonly contextRoot: string;
  private readonly tempParent: string;
  private readonly worktreeRoot: string;
  private readonly authoritativeRoot: string;
  private readonly config: DockerVerificationSandboxConfig;
  private readonly sessionId: string;
  private readonly createdAt: number;
  private readonly verificationContainer: string;
  private readonly setupContainer: string;
  private readonly proxyContainer: string;
  private readonly workspaceVolume: string;
  private readonly machineryVolume: string;
  private readonly internalNetwork: string;
  private readonly egressNetwork: string;
  private verificationCreated = false;
  private setupCreated = false;
  private proxyCreated = false;
  private volumeCreated = false;
  private machineryVolumeCreated = false;
  private internalNetworkCreated = false;
  private egressNetworkCreated = false;
  private contextCreated = true;
  private disposed = false;
  private disposeStarted = false;
  private disposeInFlight?: Promise<void>;
  private cleanupRacePossible = false;

  private constructor(input: {
    dockerExecutable: string;
    dockerEnvironment: NodeJS.ProcessEnv;
    contextRoot: string;
    tempParent: string;
    worktreeRoot: string;
    authoritativeRoot: string;
    config: DockerVerificationSandboxConfig;
    sessionId: string;
    createdAt: number;
  }) {
    this.dockerExecutable = input.dockerExecutable;
    this.dockerEnvironment = input.dockerEnvironment;
    this.safeCwd = path.dirname(input.dockerExecutable);
    this.contextRoot = input.contextRoot;
    this.tempParent = input.tempParent;
    this.worktreeRoot = input.worktreeRoot;
    this.authoritativeRoot = input.authoritativeRoot;
    this.config = input.config;
    this.sessionId = input.sessionId;
    this.createdAt = input.createdAt;
    this.verificationContainer = `quack-verify-${input.sessionId}`;
    this.setupContainer = `quack-verify-${input.sessionId}-setup`;
    this.proxyContainer = `quack-verify-${input.sessionId}-proxy`;
    this.workspaceVolume = `quack-verify-${input.sessionId}-workspace`;
    this.machineryVolume = `quack-verify-${input.sessionId}-machinery`;
    this.internalNetwork = `quack-verify-${input.sessionId}-internal`;
    this.egressNetwork = `quack-verify-${input.sessionId}-egress`;
  }

  static async create(input: {
    worktreeRoot: string;
    authoritativeRoot: string;
    config: DockerVerificationSandboxConfig;
    deniedPaths: readonly string[];
    /** Already-canonical host Docker CLI selected by a trusted launcher. */
    dockerExecutable?: string;
  }): Promise<DockerVerificationSession> {
    DockerVerificationSession.validateConfig(input.config);
    const canonicalWorktree = await fs.realpath(input.worktreeRoot);
    const canonicalAuthoritative = await fs.realpath(input.authoritativeRoot);
    const canonicalHostCwd = await fs.realpath(process.cwd());
    const registries = await resolveAllowedRegistries(input.config.allowedRegistryOrigins);
    const configuredDocker = input.dockerExecutable ?? dockerExecutableResolver(canonicalWorktree);
    const dockerExecutable = await fs.realpath(configuredDocker);
    if (!(await fs.stat(dockerExecutable)).isFile()) {
      throw new Error("Docker verification executable is not a regular file");
    }
    for (const [label, mutableRoot] of [
      ["worktree", canonicalWorktree],
      ["authoritative project", canonicalAuthoritative],
      ["host working directory", canonicalHostCwd],
    ] as const) {
      if (isInsidePath(mutableRoot, dockerExecutable)) {
        throw new Error(`Docker verification executable resolves inside the ${label}`);
      }
    }

    const identity: VerificationSessionIdentity = {
      sessionId: randomUUID().replace(/-/g, "").toLowerCase(),
      ownerPid: process.pid,
      createdAt: Date.now(),
    };
    ACTIVE_SESSION_IDS.add(identity.sessionId);
    let staged: StagedDockerVerificationContext | undefined;
    let session: DockerVerificationSession | undefined;
    try {
      const tempParent = await canonicalVerificationTempParent(
        canonicalWorktree,
        canonicalAuthoritative,
      );
      await sweepStaleTempSessions(tempParent);
      staged = await stageDockerVerificationContext({
        worktreeRoot: canonicalWorktree,
        authoritativeRoot: canonicalAuthoritative,
        config: input.config,
        deniedPaths: input.deniedPaths,
        sessionIdentity: identity,
      });
      await validateDockerDependencyMetadata({
        workspaceRoot: staged.workspaceRoot,
        dependencyRoots: input.config.dependencyRoots,
        allowedRegistryOrigins: registries.map((registry) => registry.origin),
        offlineNativeRebuilds: input.config.offlineNativeRebuilds,
      });
      const isolatedHome = path.join(staged.contextRoot, "docker-home");
      await fs.mkdir(path.join(isolatedHome, ".docker"), { recursive: true });
      await fs.mkdir(path.join(isolatedHome, "tmp"), { recursive: true });
      session = new DockerVerificationSession({
        dockerExecutable,
        dockerEnvironment: cleanHostEnvironment(dockerExecutable, isolatedHome),
        contextRoot: staged.contextRoot,
        tempParent,
        worktreeRoot: canonicalWorktree,
        authoritativeRoot: canonicalAuthoritative,
        config: input.config,
        sessionId: identity.sessionId,
        createdAt: identity.createdAt,
      });
      await session.sweepStaleResources();
      await session.prepare(staged.workspaceRoot, staged.machineryRoot, registries);
      return session;
    } catch (error) {
      try {
        if (session) await session.dispose();
        else if (staged) {
          await removeVerifiedTempDirectory(
            staged.contextRoot,
            path.dirname(staged.contextRoot),
            identity,
          );
        }
      } catch (cleanupError) {
        ACTIVE_SESSION_IDS.delete(identity.sessionId);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      ACTIVE_SESSION_IDS.delete(identity.sessionId);
      throw error;
    }
  }

  private static validateConfig(config: DockerVerificationSandboxConfig): void {
    if (!IMMUTABLE_NODE_IMAGE.test(config.image)) {
      throw new Error("Docker verification requires an immutable official Node image digest");
    }
    const numeric = {
      pidsLimit: config.pidsLimit,
      memoryMb: config.memoryMb,
      cpus: config.cpus,
      tmpfsSizeMb: config.tmpfsSizeMb,
      setupTimeoutMs: config.setupTimeoutMs,
      maxContextBytes: config.maxContextBytes,
      maxOutputBytes: config.maxOutputBytes,
    };
    if (Object.entries(numeric).some(([, value]) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Docker verification resource limits must be positive and finite");
    }
    if (
      !Number.isInteger(config.pidsLimit) ||
      config.pidsLimit < 16 ||
      config.pidsLimit > 4096 ||
      !Number.isInteger(config.memoryMb) ||
      config.memoryMb < 128 ||
      config.memoryMb > 32768 ||
      config.cpus > 16 ||
      !Number.isInteger(config.tmpfsSizeMb) ||
      config.tmpfsSizeMb < 16 ||
      config.tmpfsSizeMb > 4096 ||
      config.setupTimeoutMs > 3_600_000 ||
      config.maxContextBytes > 2 * 1024 * 1024 * 1024 ||
      config.maxOutputBytes < 1024 ||
      config.maxOutputBytes > 10 * 1024 * 1024
    ) {
      throw new Error("Docker verification resource limits are outside the allowed range");
    }
    if (config.dependencyRoots.length === 0 || config.allowedRegistryOrigins.length === 0) {
      throw new Error("Docker verification requires dependency roots and registry origins");
    }
    config.dependencyRoots.forEach(safeDependencyRoot);
    if (new Set(config.dependencyRoots).size !== config.dependencyRoots.length) {
      throw new Error("Docker verification dependency roots must be unique");
    }
    const dependencyRoots = new Set(config.dependencyRoots);
    const rebuildKeys = new Set<string>();
    for (const rebuild of config.offlineNativeRebuilds ?? []) {
      validateOfflineNativeRebuildEntry(rebuild, dependencyRoots);
      const key = `${rebuild.dependencyRoot}\0${rebuild.packageName}`;
      if (rebuildKeys.has(key)) {
        throw new Error(
          `Docker verification native rebuild is duplicated: ${rebuild.dependencyRoot}/${rebuild.packageName}`,
        );
      }
      rebuildKeys.add(key);
    }
    if ((config.offlineNativeRebuilds?.length ?? 0) > 16) {
      throw new Error("Docker verification allows at most 16 native rebuild packages");
    }
  }

  private redact(value: string): string {
    let redacted = value;
    for (const [sensitive, replacement] of [
      [this.contextRoot, "[verification-context]"],
      [this.worktreeRoot, "[worktree]"],
      [this.authoritativeRoot, "[authoritative-project]"],
    ] as const) {
      redacted = redacted.split(sensitive).join(replacement);
    }
    return redacted;
  }

  private async docker(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes = this.config.maxOutputBytes,
  ): Promise<DockerVerificationResult> {
    try {
      const result = await dockerCommandRunner(this.dockerExecutable, args, {
        cwd: this.safeCwd,
        env: this.dockerEnvironment,
        timeoutMs,
        maxOutputBytes,
      });
      if (result.timedOut) this.cleanupRacePossible = true;
      return {
        ...result,
        stdout: this.redact(sanitizeTextOutput(result.stdout, maxOutputBytes)),
        stderr: this.redact(sanitizeTextOutput(result.stderr, maxOutputBytes)),
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: this.redact(
          sanitizeTextOutput(
            `Docker execution failed: ${error instanceof Error ? error.message : String(error)}`,
            maxOutputBytes,
          ),
        ),
        timedOut: false,
      };
    }
  }

  private async requireSuccess(
    operation: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<string> {
    const result = await this.docker(args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`${operation} failed: ${result.stderr || result.stdout || "unknown error"}`);
    }
    return result.stdout;
  }

  private async requireResourceCreation(
    operation: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<void> {
    const result = await this.docker(args, timeoutMs);
    if (result.exitCode !== 0) {
      this.cleanupRacePossible = true;
      throw new Error(`${operation} failed: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  private resourceLabels(): string[] {
    return [
      "--label",
      `${RESOURCE_LABEL}=${this.sessionId}`,
      "--label",
      `${OWNER_PID_LABEL}=${process.pid}`,
      "--label",
      `${CREATED_AT_LABEL}=${this.createdAt}`,
    ];
  }

  private resourceArgs(name: string, network: string, user: string): string[] {
    return [
      "--name",
      name,
      ...this.resourceLabels(),
      "--network",
      network,
      "--dns",
      "127.0.0.1",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(this.config.pidsLimit),
      "--memory",
      `${this.config.memoryMb}m`,
      "--cpus",
      String(this.config.cpus),
      "--user",
      user,
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,noexec,size=${this.config.tmpfsSizeMb}m`,
      "--env",
      "HOME=/tmp",
    ];
  }

  private async assertBaseImagePresent(): Promise<void> {
    const stdout = await this.requireSuccess(
      "Docker verification base image inspection",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", this.config.image],
      CLEANUP_TIMEOUT_MS,
    );
    let digests: unknown;
    try {
      digests = JSON.parse(stdout.trim());
    } catch {
      throw new Error("Docker verification base image inspection returned invalid digest metadata");
    }
    const expectedDigest = this.config.image
      .slice(this.config.image.indexOf("@") + 1)
      .toLowerCase();
    if (
      !Array.isArray(digests) ||
      !digests.some(
        (value) => typeof value === "string" && value.toLowerCase().endsWith(`@${expectedDigest}`),
      )
    ) {
      throw new Error(
        "Docker verification base image is not pre-provisioned at the configured digest",
      );
    }
  }

  private async listResourceValues(
    kind: DockerResourceKind,
    labelFilter: string,
    format: string,
  ): Promise<string[]> {
    const args = [kind, "ls"];
    if (kind === "container") args.push("--all");
    args.push("--filter", `label=${labelFilter}`, "--format", format);
    const result = await this.docker(args, CLEANUP_TIMEOUT_MS, 256 * 1024);
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker verification ${kind} inventory failed: ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private async collectResourceSessions(): Promise<Map<string, DockerResourceSession>> {
    const format = `{{.Label "${RESOURCE_LABEL}"}}|{{.Label "${OWNER_PID_LABEL}"}}|{{.Label "${CREATED_AT_LABEL}"}}`;
    const rows = (
      await Promise.all(
        (["container", "volume", "network"] as const).map((kind) =>
          this.listResourceValues(kind, RESOURCE_LABEL, format),
        ),
      )
    ).flat();
    const sessions = new Map<string, DockerResourceSession>();
    for (const row of rows) {
      const [sessionId, rawPid, rawCreatedAt] = row.split("|");
      const pid = Number(rawPid);
      const createdAt = Number(rawCreatedAt);
      if (
        !/^[a-f0-9]{32}$/.test(sessionId ?? "") ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !Number.isSafeInteger(createdAt) ||
        createdAt <= 0 ||
        createdAt > Date.now() + 60_000
      ) {
        throw new Error(
          "Docker verification found a labeled resource with invalid ownership metadata",
        );
      }
      const prior = sessions.get(sessionId);
      if (prior && (prior.pid !== pid || prior.createdAt !== createdAt)) {
        throw new Error(`Docker verification found conflicting metadata for session ${sessionId}`);
      }
      sessions.set(sessionId, { pid, createdAt });
    }
    return sessions;
  }

  private async listSessionResourceIds(
    kind: DockerResourceKind,
    sessionId: string,
  ): Promise<string[]> {
    const format = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
    const identifiers = await this.listResourceValues(
      kind,
      `${RESOURCE_LABEL}=${sessionId}`,
      format,
    );
    if (identifiers.some((identifier) => !/^[A-Za-z0-9_.:-]+$/.test(identifier))) {
      throw new Error(`Docker verification ${kind} inventory returned an unsafe identifier`);
    }
    return identifiers;
  }

  private async cleanupSessionByLabel(
    sessionId: string,
    protectAgainstLateCreate: boolean,
  ): Promise<void> {
    let consecutiveEmptyChecks = 0;
    const requiredEmptyChecks = protectAgainstLateCreate ? 7 : 1;
    for (const retryDelay of CLEANUP_RETRY_DELAYS_MS) {
      if (retryDelay > 0) await dockerVerificationDelay(retryDelay);
      const containers = await this.listSessionResourceIds("container", sessionId);
      if (containers.length > 0) {
        await this.docker(["rm", "-f", ...containers], CLEANUP_TIMEOUT_MS, 64 * 1024);
      }
      const networks = await this.listSessionResourceIds("network", sessionId);
      if (networks.length > 0) {
        await this.docker(["network", "rm", ...networks], CLEANUP_TIMEOUT_MS, 64 * 1024);
      }
      const volumes = await this.listSessionResourceIds("volume", sessionId);
      if (volumes.length > 0) {
        await this.docker(["volume", "rm", "-f", ...volumes], CLEANUP_TIMEOUT_MS, 64 * 1024);
      }
      const remaining = (
        await Promise.all(
          (["container", "network", "volume"] as const).map((kind) =>
            this.listSessionResourceIds(kind, sessionId),
          ),
        )
      ).flat();
      if (remaining.length === 0) {
        consecutiveEmptyChecks += 1;
        if (consecutiveEmptyChecks >= requiredEmptyChecks) return;
      } else {
        consecutiveEmptyChecks = 0;
      }
    }
    throw new Error(`Docker verification session ${sessionId} resources survived cleanup`);
  }

  private async sweepStaleResources(): Promise<void> {
    const sessions = await this.collectResourceSessions();
    for (const [sessionId, metadata] of sessions) {
      if (ACTIVE_SESSION_IDS.has(sessionId)) continue;
      if (metadata.pid !== process.pid && isProcessAlive(metadata.pid)) continue;
      const age = Date.now() - metadata.createdAt;
      if (age < STALE_RESOURCE_GRACE_MS)
        await dockerVerificationDelay(STALE_RESOURCE_GRACE_MS - age);
      if (metadata.pid !== process.pid && isProcessAlive(metadata.pid)) continue;
      await this.cleanupSessionByLabel(sessionId, true);
    }
  }

  private async waitForProxyReady(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await this.docker(
        [
          "exec",
          "--user",
          CONTAINER_UID,
          this.proxyContainer,
          "/usr/local/bin/node",
          "-e",
          PROXY_READY_SCRIPT,
        ],
        3_000,
      );
      if (result.exitCode === 0) return;
      await dockerVerificationDelay(100);
    }
    throw new Error("Docker verification registry proxy did not become ready");
  }

  private async prepare(
    workspaceRoot: string,
    machineryRoot: string,
    registries: readonly ResolvedRegistry[],
  ): Promise<void> {
    await this.assertBaseImagePresent();
    this.volumeCreated = true;
    await this.requireResourceCreation(
      "Docker verification volume creation",
      ["volume", "create", ...this.resourceLabels(), this.workspaceVolume],
      CLEANUP_TIMEOUT_MS,
    );
    this.machineryVolumeCreated = true;
    await this.requireResourceCreation(
      "Docker verification machinery volume creation",
      ["volume", "create", ...this.resourceLabels(), this.machineryVolume],
      CLEANUP_TIMEOUT_MS,
    );
    this.egressNetworkCreated = true;
    await this.requireResourceCreation(
      "Docker verification egress network creation",
      ["network", "create", ...this.resourceLabels(), this.egressNetwork],
      CLEANUP_TIMEOUT_MS,
    );
    this.internalNetworkCreated = true;
    await this.requireResourceCreation(
      "Docker verification internal network creation",
      ["network", "create", "--internal", ...this.resourceLabels(), this.internalNetwork],
      CLEANUP_TIMEOUT_MS,
    );

    const registryMap = Object.fromEntries(
      registries.map((registry) => [registry.hostname, registry.addresses]),
    );
    this.proxyCreated = true;
    await this.requireResourceCreation(
      "Docker verification registry proxy creation",
      [
        "create",
        ...this.resourceArgs(this.proxyContainer, this.egressNetwork, CONTAINER_UID),
        "--env",
        `QV_ALLOWED_REGISTRIES=${JSON.stringify(registryMap)}`,
        "--pull",
        "never",
        "--entrypoint",
        "/usr/local/bin/node",
        this.config.image,
        "-e",
        REGISTRY_PROXY_SCRIPT,
      ],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification registry proxy start",
      ["start", this.proxyContainer],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification registry proxy isolation",
      ["network", "connect", this.internalNetwork, this.proxyContainer],
      CLEANUP_TIMEOUT_MS,
    );
    await this.waitForProxyReady();
    const proxyAddress = (
      await this.requireSuccess(
        "Docker verification registry proxy address inspection",
        [
          "inspect",
          "--format",
          `{{with index .NetworkSettings.Networks "${this.internalNetwork}"}}{{.IPAddress}}{{end}}`,
          this.proxyContainer,
        ],
        CLEANUP_TIMEOUT_MS,
      )
    ).trim();
    if (isIP(proxyAddress) !== 4) {
      throw new Error("Docker verification registry proxy has no isolated IPv4 address");
    }

    this.setupCreated = true;
    await this.requireResourceCreation(
      "Docker verification setup container creation",
      [
        "create",
        ...this.resourceArgs(this.setupContainer, this.internalNetwork, "0:0"),
        "--mount",
        `type=volume,source=${this.workspaceVolume},target=/workspace`,
        "--mount",
        `type=volume,source=${this.machineryVolume},target=/quack-machinery`,
        "--env",
        "CI=1",
        "--env",
        "NPM_CONFIG_IGNORE_SCRIPTS=true",
        "--pull",
        "never",
        "--entrypoint",
        "/usr/bin/tail",
        this.config.image,
        "-f",
        "/dev/null",
      ],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification setup container start",
      ["start", this.setupContainer],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification source copy",
      ["cp", `${workspaceRoot}${path.sep}.`, `${this.setupContainer}:/workspace`],
      this.config.setupTimeoutMs,
    );
    await this.requireSuccess(
      "Docker verification machinery copy",
      ["cp", `${machineryRoot}${path.sep}.`, `${this.setupContainer}:/quack-machinery`],
      this.config.setupTimeoutMs,
    );
    await this.requireSuccess(
      "Docker verification workspace permission initialization",
      ["exec", "--user", "0:0", this.setupContainer, "/bin/chmod", "-R", "a+rwX", "/workspace"],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification machinery permission initialization",
      [
        "exec",
        "--user",
        "0:0",
        this.setupContainer,
        "/bin/chmod",
        "-R",
        "a+rX,go-w",
        "/quack-machinery",
      ],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification npm config isolation initialization",
      [
        "exec",
        "--user",
        CONTAINER_UID,
        this.setupContainer,
        "/usr/bin/touch",
        NPM_USER_CONFIG,
        NPM_GLOBAL_CONFIG,
      ],
      CLEANUP_TIMEOUT_MS,
    );

    const proxyUrl = `http://${proxyAddress}:${PROXY_PORT}`;
    for (const relativeRoot of this.config.dependencyRoots) {
      const workdir = relativeRoot === "." ? "/workspace" : `/workspace/${relativeRoot}`;
      await this.requireSuccess(
        `Docker verification dependency setup (${relativeRoot})`,
        [
          "exec",
          "--user",
          CONTAINER_UID,
          "--workdir",
          workdir,
          "--env",
          `HTTP_PROXY=${proxyUrl}`,
          "--env",
          `HTTPS_PROXY=${proxyUrl}`,
          "--env",
          `http_proxy=${proxyUrl}`,
          "--env",
          `https_proxy=${proxyUrl}`,
          "--env",
          "NO_PROXY=",
          "--env",
          "no_proxy=",
          "--env",
          `NPM_CONFIG_USERCONFIG=${NPM_USER_CONFIG}`,
          "--env",
          `NPM_CONFIG_GLOBALCONFIG=${NPM_GLOBAL_CONFIG}`,
          "--env",
          "NPM_CONFIG_IGNORE_SCRIPTS=true",
          "--env",
          "NPM_CONFIG_AUDIT=false",
          "--env",
          "NPM_CONFIG_FUND=false",
          "--env",
          "NPM_CONFIG_UPDATE_NOTIFIER=false",
          this.setupContainer,
          "/usr/local/bin/npm",
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--workspaces=false",
          "--include-workspace-root=false",
          `--registry=${registries[0].origin}/`,
          "--strict-ssl=true",
          "--cache=/tmp/npm-cache",
        ],
        this.config.setupTimeoutMs,
      );
    }

    const nativeRebuilds = this.config.offlineNativeRebuilds ?? [];
    if (nativeRebuilds.length > 0) {
      await this.removeDependencyEgress();
      for (const rebuild of nativeRebuilds) {
        await this.runOfflineNativeRebuild(rebuild);
      }
    }

    await this.removePreparationResources();
    this.verificationCreated = true;
    await this.requireResourceCreation(
      "Docker verification container creation",
      [
        "create",
        ...this.resourceArgs(this.verificationContainer, "none", CONTAINER_UID),
        "--mount",
        `type=volume,source=${this.workspaceVolume},target=/workspace`,
        "--mount",
        `type=volume,source=${this.machineryVolume},target=/workspace/.quack,readonly`,
        "--env",
        "CI=1",
        "--env",
        "NPM_CONFIG_IGNORE_SCRIPTS=true",
        "--pull",
        "never",
        "--entrypoint",
        "/usr/bin/tail",
        this.config.image,
        "-f",
        "/dev/null",
      ],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      "Docker verification container start",
      ["start", this.verificationContainer],
      CLEANUP_TIMEOUT_MS,
    );
  }

  private async removeNamedResource(
    created: boolean,
    removeArgs: readonly string[],
    listArgs: readonly string[],
    label: string,
  ): Promise<boolean> {
    if (!created) return false;
    await this.docker(removeArgs, CLEANUP_TIMEOUT_MS, 64 * 1024);
    const listing = await this.docker(listArgs, CLEANUP_TIMEOUT_MS, 64 * 1024);
    if (listing.exitCode !== 0) {
      throw new Error(
        `${label} cleanup could not be verified: ${listing.stderr || listing.stdout}`,
      );
    }
    if (listing.stdout.trim()) throw new Error(`${label} still exists after cleanup`);
    return false;
  }

  private async removeDependencyEgress(): Promise<void> {
    this.proxyCreated = await this.removeNamedResource(
      this.proxyCreated,
      ["rm", "-f", this.proxyContainer],
      [
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${this.proxyContainer}$`,
        "--format",
        "{{.Names}}",
      ],
      "registry proxy container",
    );
    if (this.setupCreated && this.internalNetworkCreated) {
      await this.requireSuccess(
        "Docker verification setup network disconnection",
        ["network", "disconnect", "--force", this.internalNetwork, this.setupContainer],
        CLEANUP_TIMEOUT_MS,
      );
    }
    this.internalNetworkCreated = await this.removeNamedResource(
      this.internalNetworkCreated,
      ["network", "rm", this.internalNetwork],
      ["network", "ls", "--filter", `name=^${this.internalNetwork}$`, "--format", "{{.Name}}"],
      "internal setup network",
    );
    this.egressNetworkCreated = await this.removeNamedResource(
      this.egressNetworkCreated,
      ["network", "rm", this.egressNetwork],
      ["network", "ls", "--filter", `name=^${this.egressNetwork}$`, "--format", "{{.Name}}"],
      "egress setup network",
    );
    const attachedNetworks = await this.requireSuccess(
      "Docker verification offline setup network inspection",
      [
        "container",
        "inspect",
        "--format",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
        this.setupContainer,
      ],
      CLEANUP_TIMEOUT_MS,
    );
    if (attachedNetworks.trim()) {
      throw new Error("Docker verification native rebuild container still has network access");
    }
  }

  private async runOfflineNativeRebuild(rebuild: DockerOfflineNativeRebuild): Promise<void> {
    const workdir =
      rebuild.dependencyRoot === "." ? "/workspace" : `/workspace/${rebuild.dependencyRoot}`;
    await this.requireSuccess(
      `Docker verification native package attestation (${rebuild.packageName})`,
      [
        "exec",
        "--user",
        CONTAINER_UID,
        "--workdir",
        workdir,
        this.setupContainer,
        "/usr/local/bin/node",
        "-e",
        NATIVE_REBUILD_ATTESTATION_SCRIPT,
        rebuild.packageName,
        rebuild.version,
        rebuild.installScript,
      ],
      CLEANUP_TIMEOUT_MS,
    );
    await this.requireSuccess(
      `Docker verification offline native rebuild (${rebuild.packageName})`,
      [
        "exec",
        "--user",
        CONTAINER_UID,
        "--workdir",
        workdir,
        "--env",
        "HTTP_PROXY=",
        "--env",
        "HTTPS_PROXY=",
        "--env",
        "http_proxy=",
        "--env",
        "https_proxy=",
        "--env",
        "NO_PROXY=*",
        "--env",
        "no_proxy=*",
        "--env",
        `NPM_CONFIG_USERCONFIG=${NPM_USER_CONFIG}`,
        "--env",
        `NPM_CONFIG_GLOBALCONFIG=${NPM_GLOBAL_CONFIG}`,
        "--env",
        "NPM_CONFIG_IGNORE_SCRIPTS=false",
        "--env",
        "NPM_CONFIG_OFFLINE=true",
        "--env",
        "NPM_CONFIG_BUILD_FROM_SOURCE=true",
        "--env",
        "NPM_CONFIG_NODEDIR=/usr/local",
        "--env",
        "NPM_CONFIG_AUDIT=false",
        "--env",
        "NPM_CONFIG_FUND=false",
        "--env",
        "NPM_CONFIG_UPDATE_NOTIFIER=false",
        this.setupContainer,
        "/usr/local/bin/npm",
        "rebuild",
        rebuild.packageName,
        "--foreground-scripts",
        "--ignore-scripts=false",
        "--offline",
        "--build-from-source",
        "--nodedir=/usr/local",
        "--workspaces=false",
        "--include-workspace-root=false",
        "--no-audit",
        "--no-fund",
        "--cache=/tmp/npm-cache",
      ],
      this.config.setupTimeoutMs,
    );
  }

  private async removePreparationResources(): Promise<void> {
    const errors: string[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    };
    await attempt(async () => {
      this.setupCreated = await this.removeNamedResource(
        this.setupCreated,
        ["rm", "-f", this.setupContainer],
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${this.setupContainer}$`,
          "--format",
          "{{.Names}}",
        ],
        "dependency setup container",
      );
    });
    await attempt(async () => {
      this.proxyCreated = await this.removeNamedResource(
        this.proxyCreated,
        ["rm", "-f", this.proxyContainer],
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${this.proxyContainer}$`,
          "--format",
          "{{.Names}}",
        ],
        "registry proxy container",
      );
    });
    await attempt(async () => {
      this.internalNetworkCreated = await this.removeNamedResource(
        this.internalNetworkCreated,
        ["network", "rm", this.internalNetwork],
        ["network", "ls", "--filter", `name=^${this.internalNetwork}$`, "--format", "{{.Name}}"],
        "internal setup network",
      );
    });
    await attempt(async () => {
      this.egressNetworkCreated = await this.removeNamedResource(
        this.egressNetworkCreated,
        ["network", "rm", this.egressNetwork],
        ["network", "ls", "--filter", `name=^${this.egressNetwork}$`, "--format", "{{.Name}}"],
        "egress setup network",
      );
    });
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  async run(
    command: DockerVerificationCommand,
    timeoutMs: number,
  ): Promise<DockerVerificationResult> {
    if (this.disposeStarted || this.disposed)
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Docker verification session is already disposing or disposed",
        timedOut: false,
      };
    const resolvedCwd = path.resolve(command.cwd);
    if (!isInsidePath(this.worktreeRoot, resolvedCwd)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Docker verification cwd escapes the worktree",
        timedOut: false,
      };
    }
    const relativeCwd = path.relative(this.worktreeRoot, resolvedCwd).replace(/\\/g, "/");
    const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
    let environmentArgs: string[];
    try {
      environmentArgs = validateContainerEnvironment(command.env);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }
    let invocation: string[];
    if (command.executable !== undefined) {
      if (!command.executable || command.command !== undefined) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Docker verification requires exactly one command representation",
          timedOut: false,
        };
      }
      invocation = [command.executable, ...(command.args ?? [])];
    } else if (command.command !== undefined) {
      invocation = ["/bin/sh", "-lc", command.command];
    } else {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Docker verification command is missing",
        timedOut: false,
      };
    }
    const result = await this.docker(
      [
        "exec",
        "--user",
        CONTAINER_UID,
        "--workdir",
        containerCwd,
        ...environmentArgs,
        this.verificationContainer,
        ...invocation,
      ],
      timeoutMs,
    );
    if (result.timedOut) {
      await this.docker(["rm", "-f", this.verificationContainer], CLEANUP_TIMEOUT_MS);
      const listing = await this.docker(
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${this.verificationContainer}$`,
          "--format",
          "{{.Names}}",
        ],
        CLEANUP_TIMEOUT_MS,
      );
      if (listing.exitCode !== 0 || listing.stdout.trim()) {
        return {
          ...result,
          stderr:
            `${result.stderr}\nTimed-out verification container removal could not be verified`.trim(),
        };
      }
      this.verificationCreated = false;
    }
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposeInFlight) return this.disposeInFlight;
    this.disposeStarted = true;

    const disposeAttempt = this.disposeOnce();
    this.disposeInFlight = disposeAttempt;
    try {
      await disposeAttempt;
    } finally {
      if (this.disposeInFlight === disposeAttempt) this.disposeInFlight = undefined;
      // Once disposal has begun this session can never execute again. Release
      // the in-process liveness marker even when cleanup fails so a subsequent
      // session's stale-resource sweep can recover the labeled artifacts. The
      // same object remains retryable because its resource flags are retained.
      ACTIVE_SESSION_IDS.delete(this.sessionId);
    }
  }

  private async disposeOnce(): Promise<void> {
    const errors: string[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    };
    try {
      await attempt(async () => {
        this.verificationCreated = await this.removeNamedResource(
          this.verificationCreated,
          ["rm", "-f", this.verificationContainer],
          [
            "container",
            "ls",
            "--all",
            "--filter",
            `name=^/${this.verificationContainer}$`,
            "--format",
            "{{.Names}}",
          ],
          "verification container",
        );
      });
      await attempt(() => this.removePreparationResources());
      await attempt(async () => {
        this.volumeCreated = await this.removeNamedResource(
          this.volumeCreated,
          ["volume", "rm", "-f", this.workspaceVolume],
          ["volume", "ls", "--filter", `name=^${this.workspaceVolume}$`, "--format", "{{.Name}}"],
          "verification workspace volume",
        );
      });
      await attempt(async () => {
        this.machineryVolumeCreated = await this.removeNamedResource(
          this.machineryVolumeCreated,
          ["volume", "rm", "-f", this.machineryVolume],
          ["volume", "ls", "--filter", `name=^${this.machineryVolume}$`, "--format", "{{.Name}}"],
          "verification machinery volume",
        );
      });
      await attempt(() => this.cleanupSessionByLabel(this.sessionId, this.cleanupRacePossible));
      await attempt(async () => {
        if (!this.contextCreated) return;
        await removeVerifiedTempDirectory(this.contextRoot, this.tempParent, {
          sessionId: this.sessionId,
          ownerPid: process.pid,
          createdAt: this.createdAt,
        });
        this.contextCreated = false;
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length > 0) {
      throw new Error(`Docker verification cleanup failed: ${errors.join("; ")}`);
    }
    this.disposed = true;
  }
}
