import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const SAFE_PROCESS_ENV_NAMES = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

const TRUSTED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", devNull],
  ["core.fsmonitor", "false"],
  ["core.attributesFile", devNull],
  ["core.excludesFile", devNull],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["protocol.ext.allow", "never"],
  ["fetch.recurseSubmodules", "false"],
  ["submodule.recurse", "false"],
  ["gc.auto", "0"],
] as const;

const UNSAFE_GIT_CONFIG_KEYS: readonly RegExp[] = [
  /^alias\./iu,
  /^core\.(?:alternaterefscommand|askpass|attributesfile|editor|excludesfile|fsmonitor|gitproxy|hookspath|pager|sshcommand|templatedir|worktree)$/iu,
  /^credential\.helper$/iu,
  /^credential\..+\.helper$/iu,
  /^bundle\..+\.uri$/iu,
  /^diff\.external$/iu,
  /^diff\..+\.(?:command|textconv)$/iu,
  /^difftool\..+\.cmd$/iu,
  /^filter\..+\.(?:clean|process|smudge)$/iu,
  /^fetch\.bundleuri$/iu,
  /^gpg\.program$/iu,
  /^gpg\..+\.program$/iu,
  /^imap\.tunnel$/iu,
  /^include\.path$/iu,
  /^includeif\..+\.path$/iu,
  /^init\.templatedir$/iu,
  /^interactive\.difffilter$/iu,
  /^man\..+\.cmd$/iu,
  /^merge\..+\.driver$/iu,
  /^mergetool\..+\.cmd$/iu,
  /^pager\./iu,
  /^protocol(?:\..+)?\.allow$/iu,
  /^extensions\.partialclone$/iu,
  /^remote\..+\.(?:partialclonefilter|promisor)$/iu,
  /^remote\..+\.(?:proxy|receivepack|uploadpack|vcs)$/iu,
  /^sequence\.editor$/iu,
  /^tar\..+\.command$/iu,
  /^uploadpack\.packobjects(?:hook)?$/iu,
  /^transfer\.bundleuri$/iu,
  /^url\..+\.(?:insteadof|pushinsteadof)$/iu,
];

const UNSAFE_GIT_ARGUMENTS = new Set([
  "--bundle-uri",
  "--config-env",
  "--exec",
  "--exec-path",
  "--ext-diff",
  "--git-dir",
  "--gpg-sign",
  "--html-path",
  "--multiple",
  "--namespace",
  "--receive-pack",
  "--recurse-submodules",
  "--recursive",
  "--shared",
  "--super-prefix",
  "--textconv",
  "--upload-pack",
  "--work-tree",
]);

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string,
): { name: string; value: string } | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toUpperCase() === requestedName.toUpperCase(),
  );
  const value = actualName ? environment[actualName] : undefined;
  return actualName && value !== undefined ? { name: actualName, value } : undefined;
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  return (
    normalized === "" ||
    (normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized))
  );
}

function executableCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (path.isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) {
    throw new Error(`trusted executable path must be absolute: ${command}`);
  }

  const pathEntry = readEnvironmentValue(environment, "PATH")?.value;
  if (!pathEntry) return [];
  const names =
    process.platform === "win32"
      ? path.extname(command).toLowerCase() === ".exe"
        ? [command]
        : [`${command}.exe`]
      : [command];
  const candidates: string[] = [];
  for (const rawDirectory of pathEntry.split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) candidates.push(path.join(directory, name));
  }
  return candidates;
}

/**
 * Resolve a native executable without Windows' implicit current-directory
 * search, then prove its final path is outside the model-writable project.
 */
export function resolveTrustedExecutable(
  command: string,
  projectRoot: string,
  description: string,
  environment: NodeJS.ProcessEnv = process.env,
  trustedBoundaryRoot: string | readonly string[] = projectRoot,
): string {
  const canonicalProjectRoot = realpathSync.native(path.resolve(projectRoot));
  const requestedRoots: readonly string[] =
    typeof trustedBoundaryRoot === "string" ? [trustedBoundaryRoot] : trustedBoundaryRoot;
  const mutableRoots = [canonicalProjectRoot, ...requestedRoots.map((root) => path.resolve(root))]
    .map((root) => realpathSync.native(root))
    .filter(
      (root, index, all) =>
        all.findIndex(
          (candidate) => isInsidePath(root, candidate) && isInsidePath(candidate, root),
        ) === index,
    );
  let lastError: unknown;
  for (const candidate of executableCandidates(command, environment)) {
    try {
      const canonical = realpathSync.native(candidate);
      if (!statSync(canonical).isFile()) continue;
      if (process.platform === "win32" && path.extname(canonical).toLowerCase() !== ".exe") {
        continue;
      }
      accessSync(canonical, fsConstants.X_OK);
      if (mutableRoots.some((root) => isInsidePath(root, canonical))) {
        throw new Error(
          `${description} resolves inside the mutable project boundary: ${canonical}`,
        );
      }
      return canonical;
    } catch (error: unknown) {
      lastError = error;
      if (path.isAbsolute(command)) break;
    }
  }
  throw new Error(
    `Cannot resolve a trusted ${description} executable outside ${mutableRoots.join(", ")}: ${
      lastError instanceof Error ? lastError.message : "no executable PATH candidate"
    }`,
  );
}

/** Environment for trusted Git inspection, excluding service credentials and Git overrides. */
export function buildTrustedGitEnvironment(
  gitExecutable: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_PROCESS_ENV_NAMES) {
    const entry = readEnvironmentValue(source, name);
    if (entry) environment[entry.name] = entry.value;
  }
  const searchDirectories = [path.dirname(gitExecutable)];
  const systemRoot =
    readEnvironmentValue(source, "SYSTEMROOT")?.value ??
    readEnvironmentValue(source, "WINDIR")?.value;
  if (process.platform === "win32" && systemRoot) {
    searchDirectories.push(path.join(systemRoot, "System32"));
  }
  environment.PATH = searchDirectories.join(path.delimiter);
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : devNull;
  environment.GIT_ATTR_NOSYSTEM = "1";
  return environment;
}

const SAFE_GITHUB_CLI_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
] as const;

export interface TrustedGitHubCli {
  executable: string;
  environment: NodeJS.ProcessEnv;
}

/**
 * Resolve GitHub CLI outside every model-writable checkout and give it only
 * the host credentials/network settings required for non-interactive use.
 * GitHub CLI may spawn Git internally, so its PATH contains only the already
 * resolved gh/Git directories plus Windows system tools.
 */
export function resolveTrustedGitHubCli(
  projectRoot: string,
  source: NodeJS.ProcessEnv = process.env,
  trustedBoundaryRoot: string | readonly string[] = projectRoot,
): TrustedGitHubCli {
  const requestedRoots =
    typeof trustedBoundaryRoot === "string" ? [trustedBoundaryRoot] : trustedBoundaryRoot;
  const mutableRoots = [resolveManagedProjectBoundary(projectRoot), ...requestedRoots];
  const executable = resolveTrustedExecutable(
    "gh",
    projectRoot,
    "GitHub CLI",
    source,
    mutableRoots,
  );
  const gitExecutable = resolveTrustedExecutable("git", projectRoot, "Git", source, mutableRoots);
  const environment = buildTrustedGitEnvironment(gitExecutable, source);
  for (const name of SAFE_GITHUB_CLI_ENV_NAMES) {
    const entry = readEnvironmentValue(source, name);
    if (entry) environment[name] = entry.value;
  }
  const searchDirectories = [
    path.dirname(executable),
    ...(environment.PATH?.split(path.delimiter).filter(Boolean) ?? []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex((other) =>
        process.platform === "win32"
          ? other.toLowerCase() === candidate.toLowerCase()
          : other === candidate,
      ) === index,
  );
  environment.PATH = searchDirectories.join(path.delimiter);
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_PAGER = "cat";
  environment.NO_COLOR = "1";
  return { executable, environment };
}

const trustedGitConfigFingerprints = new Map<string, string>();

interface TrustedGitRepository {
  canonicalProjectRoot: string;
  mutableRoots: string[];
  gitDirectory?: string;
  commonConfigPath?: string;
  worktreeConfigPath?: string;
  configPaths: string[];
}

export interface TrustedGitExecutionOptions {
  timeoutMs: number;
  maxBuffer: number;
  /**
   * The operator-owned project root. A managed worktree is mutable, but an
   * executable anywhere in its owning project must still be rejected.
   */
  trustedBoundaryRoot?: string | readonly string[];
  /**
   * Operator-provisioned absolute bare-repository paths that read-only Git
   * transport commands may use. Local publish transports remain forbidden.
   */
  trustedLocalReadRemotePaths?: readonly string[];
  /** Explicit dependency injection for executable-boundary regression tests. */
  environment?: NodeJS.ProcessEnv;
  /** Bind a push to one audited GitHub repository and freeze its effective URL. */
  expectedRepository?: TrustedGitHubRepository;
}

function resolveManagedProjectBoundary(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const parts = resolved.split(path.sep);
  let quackIndex = -1;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const quackPart = process.platform === "win32" ? parts[index]?.toLowerCase() : parts[index];
    const worktreesPart =
      process.platform === "win32" ? parts[index + 1]?.toLowerCase() : parts[index + 1];
    if (quackPart === ".quack" && worktreesPart === "worktrees") {
      quackIndex = index;
      break;
    }
  }
  if (quackIndex >= 0) {
    const candidate = parts.slice(0, quackIndex).join(path.sep) || path.parse(resolved).root;
    if (existsSync(candidate)) return realpathSync.native(candidate);
  }
  return realpathSync.native(resolved);
}

function samePath(left: string, right: string): boolean {
  return isInsidePath(left, right) && isInsidePath(right, left);
}

function assertRegularMetadataFile(filePath: string, description: string): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-regular ${description}: ${filePath}`);
  }
}

function readMetadataPointer(filePath: string, prefix: string, description: string): string {
  assertRegularMetadataFile(filePath, description);
  const raw = readFileSync(filePath, "utf8").trim();
  const value = prefix ? raw.match(new RegExp(`^${prefix}:\\s*(.+)$`, "iu"))?.[1] : raw;
  if (!value) throw new Error(`Malformed ${description}: ${filePath}`);
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(filePath), value);
}

function validateLinkedWorktreeRegistration(
  dotGitPath: string,
  gitDirectory: string,
  paths: string[],
): { commonDirectory: string; authoritativeRoot: string } {
  const commonPointer = path.join(gitDirectory, "commondir");
  if (!existsSync(commonPointer)) {
    throw new Error(
      `Linked-worktree Git metadata has no common-directory pointer: ${gitDirectory}`,
    );
  }
  const commonDirectory = realpathSync.native(
    readMetadataPointer(commonPointer, "", "Git common-directory pointer"),
  );
  paths.push(commonPointer);

  const worktreesDirectory = path.join(commonDirectory, "worktrees");
  if (
    !isInsidePath(worktreesDirectory, gitDirectory) ||
    samePath(worktreesDirectory, gitDirectory)
  ) {
    throw new Error(
      `Linked-worktree Git metadata is not registered under the common directory: ${gitDirectory}`,
    );
  }

  const backlinkPointer = path.join(gitDirectory, "gitdir");
  if (!existsSync(backlinkPointer)) {
    throw new Error(`Linked-worktree Git metadata has no checkout backlink: ${gitDirectory}`);
  }
  const backlinkTarget = realpathSync.native(
    readMetadataPointer(backlinkPointer, "", "Git worktree backlink"),
  );
  const canonicalDotGit = realpathSync.native(dotGitPath);
  if (!samePath(backlinkTarget, canonicalDotGit)) {
    throw new Error(
      `Linked-worktree Git metadata backlink does not identify this checkout: ${gitDirectory}`,
    );
  }
  paths.push(backlinkPointer);

  const authoritativeRoot =
    path.basename(commonDirectory).toLowerCase() === ".git"
      ? path.dirname(commonDirectory)
      : commonDirectory;
  return { commonDirectory, authoritativeRoot: realpathSync.native(authoritativeRoot) };
}

function resolveTrustedGitRepository(
  projectRoot: string,
  trustedBoundaryRoot?: string | readonly string[],
): TrustedGitRepository {
  const canonicalProjectRoot = realpathSync.native(path.resolve(projectRoot));
  const inferredBoundaryRoot = resolveManagedProjectBoundary(projectRoot);
  const requestedBoundaryRoots =
    trustedBoundaryRoot === undefined
      ? [inferredBoundaryRoot]
      : (typeof trustedBoundaryRoot === "string" ? [trustedBoundaryRoot] : trustedBoundaryRoot).map(
          (root) => realpathSync.native(path.resolve(root)),
        );
  const mutableRoots = [canonicalProjectRoot, inferredBoundaryRoot, ...requestedBoundaryRoots];
  const dotGitPath = path.join(canonicalProjectRoot, ".git");
  if (!existsSync(dotGitPath)) {
    return {
      canonicalProjectRoot,
      mutableRoots: [...new Set(mutableRoots)],
      configPaths: [],
    };
  }
  let gitDirectory: string;
  let commonDirectory: string;
  const paths: string[] = [];
  if (lstatSync(dotGitPath).isDirectory()) {
    gitDirectory = realpathSync.native(dotGitPath);
    if (!isInsidePath(canonicalProjectRoot, gitDirectory)) {
      throw new Error(`Git metadata resolves outside the trusted checkout: ${gitDirectory}`);
    }
    commonDirectory = gitDirectory;
  } else {
    assertRegularMetadataFile(dotGitPath, ".git metadata pointer");
    paths.push(dotGitPath);
    gitDirectory = realpathSync.native(
      readMetadataPointer(dotGitPath, "gitdir", ".git worktree pointer"),
    );
    const registration = validateLinkedWorktreeRegistration(dotGitPath, gitDirectory, paths);
    commonDirectory = registration.commonDirectory;
    mutableRoots.push(registration.authoritativeRoot);
  }
  paths.push(path.join(commonDirectory, "config"), path.join(gitDirectory, "config.worktree"));
  const commonConfigPath = path.join(commonDirectory, "config");
  const worktreeConfigPath = path.join(gitDirectory, "config.worktree");
  return {
    canonicalProjectRoot,
    mutableRoots: [...new Set(mutableRoots.map((root) => realpathSync.native(root)))],
    gitDirectory,
    commonConfigPath,
    worktreeConfigPath,
    configPaths: [...new Set(paths.map((candidate) => path.resolve(candidate)))],
  };
}

function configFingerprint(configPath: string): string {
  if (!existsSync(configPath)) return "missing";
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-regular Git configuration metadata: ${configPath}`);
  }
  return createHash("sha256").update(readFileSync(configPath)).digest("hex");
}

function readConfigEntries(
  executable: string,
  configPath: string,
  environment: NodeJS.ProcessEnv,
): Array<{ key: string; value: string }> {
  if (!existsSync(configPath)) return [];
  let output: string;
  try {
    output = execFileSync(
      executable,
      ["config", "--no-includes", "--file", configPath, "--null", "--list"],
      {
        cwd: path.dirname(executable),
        env: buildTrustedGitEnvironment(executable, environment),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error: unknown) {
    const detail =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Unable to audit Git configuration ${configPath}: ${detail}`);
  }
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      return separator < 0
        ? { key: entry, value: "" }
        : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
    });
}

function unsafeGitConfigReason(key: string, value: string): string | undefined {
  const normalizedKey = key.toLowerCase();
  if (UNSAFE_GIT_CONFIG_KEYS.some((pattern) => pattern.test(normalizedKey))) {
    return `unsafe Git configuration key "${key}"`;
  }
  if (/^remote\..+\.(?:url|pushurl)$/iu.test(normalizedKey) && /^\s*ext::/iu.test(value)) {
    return `unsafe external-transport URL in Git configuration key "${key}"`;
  }
  if (/^submodule\..+\.url$/iu.test(normalizedKey) && /^\s*ext::/iu.test(value)) {
    return `unsafe external-transport URL in Git configuration key "${key}"`;
  }
  if (/^submodule\..+\.update$/iu.test(normalizedKey) && /^\s*!/u.test(value)) {
    return `unsafe command update in Git configuration key "${key}"`;
  }
  return undefined;
}

function trustedGitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-c") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument.toLowerCase();
  }
  return undefined;
}

const TRANSPORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-b",
  "--branch",
  "-c",
  "--config",
  "--deepen",
  "--depth",
  "--filter",
  "-j",
  "--jobs",
  "--negotiation-tip",
  "-o",
  "--origin",
  "--push-option",
  "--reference",
  "--reference-if-able",
  "--refmap",
  "--separate-git-dir",
  "--server-option",
  "--shallow-exclude",
  "--shallow-since",
  "--sort",
  "-s",
  "--strategy",
  "-x",
  "--strategy-option",
  "--template",
] as const);

interface PositionedGitArgument {
  value: string;
  index: number;
}

function firstPositionalTransportArgument(
  args: readonly string[],
  startIndex: number,
): PositionedGitArgument | undefined {
  for (let index = startIndex; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--" || argument === "--repo") {
      const value = args[index + 1];
      return value === undefined ? undefined : { value, index: index + 1 };
    }
    if (argument.startsWith("--repo=")) {
      return { value: argument.slice("--repo=".length), index };
    }
    if (TRANSPORT_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return { value: argument, index };
  }
  return undefined;
}

/** @internal Exported for deterministic argument-policy regression coverage. */
export function directGitTransportTarget(args: readonly string[]): string | undefined {
  return directGitTransportTargetEntry(args)?.value;
}

function directGitTransportTargetEntry(args: readonly string[]): PositionedGitArgument | undefined {
  let commandIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-c") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    commandIndex = index;
    break;
  }
  if (commandIndex < 0) return undefined;
  const subcommand = args[commandIndex]?.toLowerCase();
  if (subcommand === "archive") {
    for (let index = commandIndex + 1; index < args.length; index += 1) {
      const argument = args[index] ?? "";
      if (argument === "--remote") {
        const value = args[index + 1];
        return value === undefined ? undefined : { value, index: index + 1 };
      }
      if (argument.startsWith("--remote=")) {
        return { value: argument.slice("--remote=".length), index };
      }
    }
    return undefined;
  }
  if (subcommand === "submodule") {
    const action = firstPositionalTransportArgument(args, commandIndex + 1);
    if (action?.value !== "add") return undefined;
    const actionIndex = action.index;
    return firstPositionalTransportArgument(args, actionIndex + 1);
  }
  if (
    !subcommand ||
    !new Set([
      "clone",
      "fetch",
      "fetch-pack",
      "http-fetch",
      "http-push",
      "ls-remote",
      "pull",
      "push",
      "send-pack",
    ]).has(subcommand)
  ) {
    return undefined;
  }
  return firstPositionalTransportArgument(args, commandIndex + 1);
}

function usesGitTransport(args: readonly string[]): boolean {
  const subcommand = trustedGitSubcommand(args);
  if (
    subcommand &&
    new Set([
      "clone",
      "fetch",
      "fetch-pack",
      "http-fetch",
      "http-push",
      "imap-send",
      "ls-remote",
      "pull",
      "push",
      "send-pack",
    ]).has(subcommand)
  ) {
    return true;
  }
  if (subcommand === "submodule") {
    return args.some((argument) => argument === "add" || argument === "update");
  }
  if (subcommand === "remote") return args.some((argument) => argument === "update");
  if (subcommand === "archive") {
    return args.some((argument) => argument === "--remote" || argument.startsWith("--remote="));
  }
  return false;
}

/** @internal Exported for deterministic policy regression coverage. */
export function isSupportedNetworkGitUrl(value: string): boolean {
  const candidate = value.trim();
  if (/^file:/iu.test(candidate)) return false;
  if (/^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\//iu.test(candidate)) return true;
  if (candidate.includes("://")) return false;
  if (/^[a-z]:/iu.test(candidate) || candidate.includes("::")) return false;
  return /^(?:[^/@:\s]+@)?(?:\[[^\]]+\]|[a-z0-9._-]+):[^\\\s].+$/iu.test(candidate);
}

function canonicalPhysicalDirectory(candidate: string, description: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${description} must be an absolute path: ${candidate}`);
  }
  const lexical = path.resolve(candidate);
  if (!existsSync(lexical)) throw new Error(`${description} does not exist: ${lexical}`);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${description} must be a physical directory: ${lexical}`);
  }
  const canonical = realpathSync.native(lexical);
  if (!samePath(lexical, canonical)) {
    throw new Error(`${description} must not traverse filesystem aliases: ${lexical}`);
  }
  return canonical;
}

function localGitTransportPath(value: string, cwd: string): string | undefined {
  const candidate = value.trim();
  if (isSupportedNetworkGitUrl(candidate)) return undefined;
  if (/^[a-z]:[^\\/]/iu.test(candidate)) {
    throw new Error(`Refusing drive-relative Git transport target: ${candidate}`);
  }
  let filePath = candidate;
  if (/^file:/iu.test(candidate)) {
    try {
      filePath = fileURLToPath(candidate);
    } catch {
      throw new Error(`Refusing malformed file Git transport target: ${candidate}`);
    }
  }
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

function assertPhysicalBareRemote(
  executable: string,
  repository: TrustedGitRepository,
  candidate: string,
  environment: NodeJS.ProcessEnv,
): string {
  const canonical = canonicalPhysicalDirectory(candidate, "Trusted local read remote");
  if (
    repository.mutableRoots.some(
      (root) => isInsidePath(root, canonical) || isInsidePath(canonical, root),
    )
  ) {
    throw new Error(`Trusted local read remote overlaps a mutable project boundary: ${canonical}`);
  }
  for (const directory of [path.join(canonical, "objects"), path.join(canonical, "refs")]) {
    canonicalPhysicalDirectory(directory, "Trusted local bare-repository metadata");
  }
  for (const file of [path.join(canonical, "HEAD"), path.join(canonical, "config")]) {
    assertRegularMetadataFile(file, "trusted local bare-repository metadata");
  }
  const configPath = path.join(canonical, "config");
  assertAndCaptureTrustedGitConfiguration(executable, [configPath], environment);
  if (!repository.configPaths.includes(configPath)) repository.configPaths.push(configPath);
  const bare = execFileSync(
    executable,
    [`--git-dir=${canonical}`, ...gitConfigArguments(), "rev-parse", "--is-bare-repository"],
    {
      cwd: path.dirname(executable),
      env: buildTrustedGitEnvironment(executable, environment),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  ).trim();
  if (bare !== "true") {
    throw new Error(`Trusted local read remote must be a bare repository: ${canonical}`);
  }
  return canonical;
}

function authorizeTrustedLocalReadRemote(
  executable: string,
  repository: TrustedGitRepository,
  candidate: string,
  configuredPaths: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const canonicalCandidate = canonicalPhysicalDirectory(candidate, "Selected local Git transport");
  const allowed = configuredPaths.map((configured) =>
    assertPhysicalBareRemote(executable, repository, configured, environment),
  );
  if (!allowed.some((configured) => samePath(configured, canonicalCandidate))) {
    throw new Error(`Refusing non-allowlisted local Git read transport: ${canonicalCandidate}`);
  }
  return assertPhysicalBareRemote(executable, repository, canonicalCandidate, environment);
}

function assertSafeTrustedGitTransport(
  executable: string,
  repository: TrustedGitRepository,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  trustedLocalReadRemotePaths: readonly string[],
  expectedRepository?: TrustedGitHubRepository,
): string[] {
  if (!usesGitTransport(args)) return [...args];
  const configuredRemotes = new Map<string, Array<{ key: string; value: string }>>();
  const configuredFetchRefspecs = new Map<string, string[]>();
  const subcommand = trustedGitSubcommand(args);
  const transportConfigPaths = [
    ...trustedGitConfigFiles(repository, executable, environment),
    ...(subcommand === "submodule"
      ? [path.join(repository.canonicalProjectRoot, ".gitmodules")]
      : []),
  ];
  for (const configPath of transportConfigPaths) {
    for (const entry of readConfigEntries(executable, configPath, environment)) {
      const remoteMatch = entry.key.match(/^remote\.(.+)\.(?:pushurl|url)$/iu);
      const fetchRefspecMatch = entry.key.match(/^remote\.(.+)\.fetch$/iu);
      const submoduleUrl = /^submodule\..+\.url$/iu.test(entry.key);
      if (remoteMatch) {
        const remoteName = remoteMatch[1] ?? "";
        const entries = configuredRemotes.get(remoteName) ?? [];
        entries.push(entry);
        configuredRemotes.set(remoteName, entries);
      }
      if (fetchRefspecMatch) {
        const remoteName = fetchRefspecMatch[1] ?? "";
        const refspecs = configuredFetchRefspecs.get(remoteName) ?? [];
        refspecs.push(entry.value);
        configuredFetchRefspecs.set(remoteName, refspecs);
      }
      if (submoduleUrl && !isSupportedNetworkGitUrl(entry.value)) {
        throw new Error(
          `Refusing local or helper-backed Git transport URL in "${entry.key}": ${entry.value}`,
        );
      }
    }
  }
  const target = directGitTransportTargetEntry(args);
  const matchingConfiguredEntries = target ? configuredRemotes.get(target.value) : undefined;
  const configuredEntries = matchingConfiguredEntries
    ? subcommand === "push"
      ? matchingConfiguredEntries.some((entry) => /\.pushurl$/iu.test(entry.key))
        ? matchingConfiguredEntries.filter((entry) => /\.pushurl$/iu.test(entry.key))
        : matchingConfiguredEntries.filter((entry) => /\.url$/iu.test(entry.key))
      : matchingConfiguredEntries.filter((entry) => /\.url$/iu.test(entry.key))
    : undefined;
  const candidateEntries =
    configuredEntries ??
    (target
      ? [{ key: "direct transport target", value: target.value }]
      : [...configuredRemotes.values()].flat());
  if (expectedRepository && subcommand === "push") {
    if (!target || candidateEntries.length !== 1) {
      throw new Error("Refusing Git push without one exact transport destination");
    }
    const selected = candidateEntries[0];
    if (!selected || !isSupportedNetworkGitUrl(selected.value)) {
      throw new Error("Refusing Git push to a non-network or ambiguous transport destination");
    }
    const actualRepository = parseTrustedGitHubRepository(selected.value);
    if (!sameGitHubRepository(actualRepository, expectedRepository)) {
      throw new Error(
        `Git push destination ${trustedGitHubRepositorySelector(actualRepository)} does not match expected repository ${trustedGitHubRepositorySelector(expectedRepository)}`,
      );
    }
    const rewritten = [...args];
    rewritten[target.index] = selected.value;
    return rewritten;
  }
  const localEntries = candidateEntries.filter((entry) => !isSupportedNetworkGitUrl(entry.value));
  if (localEntries.length === 0) return [...args];

  const readOnlyLocalTransport = ["clone", "fetch", "ls-remote"].includes(subcommand ?? "");
  if (!readOnlyLocalTransport || !target || localEntries.length !== 1) {
    const selected = localEntries[0];
    throw new Error(
      `Refusing local or helper-backed Git transport URL in "${selected?.key ?? "target"}": ${selected?.value ?? "unknown"}`,
    );
  }
  if (trustedLocalReadRemotePaths.length === 0) {
    const selected = localEntries[0];
    const source = configuredEntries ? ` URL in "${selected?.key ?? "target"}"` : " target";
    throw new Error(
      `Refusing local or helper-backed Git transport${source}: ${selected?.value ?? "unknown"}`,
    );
  }
  const localPath = localGitTransportPath(
    localEntries[0]?.value ?? "",
    repository.canonicalProjectRoot,
  );
  if (!localPath) return [...args];
  const canonical = authorizeTrustedLocalReadRemote(
    executable,
    repository,
    localPath,
    trustedLocalReadRemotePaths,
    environment,
  );
  const rewritten = [...args];
  const originalTargetArgument = args[target.index] ?? "";
  rewritten[target.index] = originalTargetArgument.startsWith("--repo=")
    ? `--repo=${canonical}`
    : originalTargetArgument.startsWith("--remote=")
      ? `--remote=${canonical}`
      : canonical;
  if (
    configuredEntries &&
    subcommand === "fetch" &&
    firstPositionalTransportArgument(args, target.index + 1) === undefined
  ) {
    const refspecs = configuredFetchRefspecs.get(target.value) ?? [];
    for (const refspec of refspecs) {
      if (!refspec || refspec.startsWith("-") || /[\0\r\n]/u.test(refspec)) {
        throw new Error(`Refusing unsafe fetch refspec for remote "${target.value}"`);
      }
    }
    // A URL operand does not inherit remote.<name>.fetch. Carry the already
    // audited refspecs explicitly so ordinary `fetch origin` keeps its remote
    // tracking behavior without reopening the mutable remote URL.
    rewritten.push(...refspecs);
  }
  return rewritten;
}

function auditConfigPath(
  executable: string,
  configPath: string,
  environment: NodeJS.ProcessEnv,
): string {
  const fingerprint = configFingerprint(configPath);
  const fileName = path.basename(configPath).toLowerCase();
  if (fileName !== "config" && fileName !== "config.worktree") return fingerprint;
  for (const entry of readConfigEntries(executable, configPath, environment)) {
    const reason = unsafeGitConfigReason(entry.key, entry.value);
    if (reason) throw new Error(`${reason}: ${configPath}`);
  }
  return fingerprint;
}

function assertAndCaptureTrustedGitConfiguration(
  executable: string,
  configPaths: string[],
  environment: NodeJS.ProcessEnv,
): void {
  for (const configPath of configPaths) {
    const fingerprint = auditConfigPath(executable, configPath, environment);
    const expected = trustedGitConfigFingerprints.get(configPath);
    if (expected !== undefined && expected !== fingerprint) {
      throw new Error(`Git configuration changed outside trusted Git execution: ${configPath}`);
    }
    trustedGitConfigFingerprints.set(configPath, fingerprint);
  }
}

function refreshTrustedGitConfiguration(
  executable: string,
  configPaths: string[],
  environment: NodeJS.ProcessEnv,
): void {
  for (const configPath of configPaths) {
    trustedGitConfigFingerprints.set(
      configPath,
      auditConfigPath(executable, configPath, environment),
    );
  }
}

function gitConfigArguments(): string[] {
  return TRUSTED_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function assertSafeTrustedGitArguments(args: readonly string[]): void {
  const subcommand = trustedGitSubcommand(args);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-C") {
      throw new Error(`Refusing unsafe trusted Git argument: ${argument}`);
    }
    if (argument === "-u" && ["clone", "fetch", "ls-remote"].includes(subcommand ?? "")) {
      throw new Error(`Refusing unsafe trusted Git argument: ${argument}`);
    }
    if (subcommand === "clone" && argument === "-s") {
      throw new Error(`Refusing unsafe trusted Git argument: ${argument}`);
    }
    const optionName = argument.split("=", 1)[0]?.toLowerCase() ?? "";
    if (UNSAFE_GIT_ARGUMENTS.has(optionName)) {
      throw new Error(`Refusing unsafe trusted Git argument: ${argument}`);
    }
    let configAssignment: string | undefined;
    if (argument === "-c") {
      configAssignment = args[index + 1];
      index += 1;
    } else if (argument.startsWith("-c") && argument.length > 2) {
      configAssignment = argument.slice(2);
    } else if (subcommand === "clone" && argument === "--config") {
      configAssignment = args[index + 1];
      if (configAssignment === undefined) {
        throw new Error("Refusing clone --config without a key=value assignment");
      }
      index += 1;
    } else if (subcommand === "clone" && argument.startsWith("--config=")) {
      configAssignment = argument.slice("--config=".length);
    }
    if (!configAssignment) continue;
    const equals = configAssignment.indexOf("=");
    const key = equals < 0 ? configAssignment : configAssignment.slice(0, equals);
    const value = equals < 0 ? "" : configAssignment.slice(equals + 1);
    const reason = unsafeGitConfigReason(key, value);
    if (reason) throw new Error(`Refusing ${reason} in trusted Git arguments`);
  }
}

interface PreparedTrustedGitInvocation {
  executable: string;
  commandArgs: string[];
  environment: NodeJS.ProcessEnv;
  repository: TrustedGitRepository;
}

function prepareTrustedGitInvocation(
  projectRoot: string,
  args: readonly string[],
  options: TrustedGitExecutionOptions,
): PreparedTrustedGitInvocation {
  assertSafeTrustedGitArguments(args);
  const repository = resolveTrustedGitRepository(projectRoot, options.trustedBoundaryRoot);
  const sourceEnvironment = options.environment ?? process.env;
  const executable = resolveTrustedExecutable(
    "git",
    repository.canonicalProjectRoot,
    "Git",
    sourceEnvironment,
    repository.mutableRoots,
  );
  repository.configPaths = [
    ...repository.configPaths.filter(
      (candidate) =>
        candidate !== repository.commonConfigPath && candidate !== repository.worktreeConfigPath,
    ),
    ...trustedGitConfigFiles(repository, executable, sourceEnvironment),
  ];
  assertAndCaptureTrustedGitConfiguration(executable, repository.configPaths, sourceEnvironment);
  const safeArgs = assertSafeTrustedGitTransport(
    executable,
    repository,
    args,
    sourceEnvironment,
    options.trustedLocalReadRemotePaths ?? [],
    options.expectedRepository,
  );
  const repositoryArgs = repository.gitDirectory
    ? [
        `--git-dir=${repository.gitDirectory}`,
        `--work-tree=${repository.canonicalProjectRoot}`,
        "-C",
        repository.canonicalProjectRoot,
      ]
    : ["-C", repository.canonicalProjectRoot];
  return {
    executable,
    commandArgs: [...repositoryArgs, ...gitConfigArguments(), ...safeArgs],
    environment: buildTrustedGitEnvironment(executable, sourceEnvironment),
    repository,
  };
}

interface TrustedCoreWorktreeEntry {
  configPath: string;
  value: string;
}

function parseGitBoolean(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for ${key}: ${value}`);
}

function trustedGitConfigFiles(
  repository: TrustedGitRepository,
  executable: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (!repository.commonConfigPath) return [];
  const configPaths = [repository.commonConfigPath];
  const worktreeConfigEnabled = readConfigEntries(
    executable,
    repository.commonConfigPath,
    environment,
  )
    .filter((entry) => entry.key.toLowerCase() === "extensions.worktreeconfig")
    .map((entry) => parseGitBoolean(entry.value, entry.key))
    .at(-1);
  if (worktreeConfigEnabled && repository.worktreeConfigPath) {
    configPaths.push(repository.worktreeConfigPath);
  }
  return [...new Set(configPaths.map((candidate) => path.resolve(candidate)))];
}

function prepareTrustedGitMetadataAccess(projectRoot: string): {
  executable: string;
  environment: NodeJS.ProcessEnv;
  repository: TrustedGitRepository;
} {
  const repository = resolveTrustedGitRepository(projectRoot);
  if (!repository.gitDirectory) {
    throw new Error(`Git metadata is unavailable for ${repository.canonicalProjectRoot}`);
  }
  const executable = resolveTrustedExecutable(
    "git",
    repository.canonicalProjectRoot,
    "Git",
    process.env,
    repository.mutableRoots,
  );
  return {
    executable,
    environment: buildTrustedGitEnvironment(executable),
    repository,
  };
}

function readCoreWorktreeEntries(projectRoot: string): {
  context: ReturnType<typeof prepareTrustedGitMetadataAccess>;
  entries: TrustedCoreWorktreeEntry[];
} {
  const context = prepareTrustedGitMetadataAccess(projectRoot);
  const entries: TrustedCoreWorktreeEntry[] = [];
  for (const configPath of trustedGitConfigFiles(
    context.repository,
    context.executable,
    context.environment,
  )) {
    if (!existsSync(configPath)) continue;
    let stdout: string;
    try {
      stdout = execFileSync(
        context.executable,
        ["config", "--no-includes", "--file", configPath, "--null", "--get-all", "core.worktree"],
        {
          cwd: path.dirname(context.executable),
          env: context.environment,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error: unknown) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status === 1) continue;
      throw error;
    }
    for (const value of stdout.split("\0").filter(Boolean)) {
      entries.push({ configPath, value });
    }
  }
  return { context, entries };
}

/** Read core.worktree without allowing repository config or cwd/PATH execution. */
export function readTrustedCoreWorktree(projectRoot: string): string | undefined {
  const entries = readCoreWorktreeEntries(projectRoot).entries;
  return entries[entries.length - 1]?.value;
}

/**
 * Remove only the value the caller just inspected. The direct --file form
 * avoids loading the unsafe repository config while repairing it.
 */
export function unsetTrustedCoreWorktree(projectRoot: string, expectedValue: string): boolean {
  const { context, entries } = readCoreWorktreeEntries(projectRoot);
  const matches = entries.filter((entry) => entry.value === expectedValue);
  if (matches.length === 0) return false;
  for (const entry of matches) {
    execFileSync(
      context.executable,
      [
        "config",
        "--no-includes",
        "--file",
        entry.configPath,
        "--fixed-value",
        "--unset-all",
        "core.worktree",
        expectedValue,
      ],
      {
        cwd: path.dirname(context.executable),
        env: context.environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    trustedGitConfigFingerprints.set(entry.configPath, configFingerprint(entry.configPath));
  }
  return readCoreWorktreeEntries(projectRoot).entries.every(
    (entry) => entry.value !== expectedValue,
  );
}

export interface TrustedGitResult {
  /** Git launch/termination failure without a native exit status is -1. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TrustedGitHubExecutionOptions {
  timeoutMs: number;
  maxBuffer: number;
  /** Optional UTF-8 payload written directly to the GitHub CLI process stdin. */
  input?: string;
  trustedBoundaryRoot?: string | readonly string[];
  environment?: NodeJS.ProcessEnv;
  /** Optional host-owned expectation checked against the audited origin URL. */
  expectedRepository?: {
    host?: string;
    owner: string;
    repo: string;
  };
}

export interface TrustedGitHubRepository {
  host: string;
  owner: string;
  repo: string;
}

export const GITHUB_ISSUE_PAGE_SIZE = 25;
export const GITHUB_ISSUE_PAGE_MAX_BUFFER = 8 * 1024 * 1024;

// Keep this query launcher-owned. Neither repository inputs nor a pagination
// cursor may choose another GraphQL operation, host, or repository.
const GITHUB_ISSUE_PAGE_QUERY = `query QuackIssuePage($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(first: ${GITHUB_ISSUE_PAGE_SIZE}, after: $after, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number url body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function validateGitHubRepositoryPart(value: string, description: string): string {
  if (
    value.length === 0 ||
    value.length > 100 ||
    value === "." ||
    value === ".." ||
    value.startsWith("-") ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new Error(`Refusing invalid GitHub ${description}: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateGitHubHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/u, "");
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/u.exec(host);
  const port = match?.[2] === undefined ? undefined : Number(match[2]);
  if (
    host.length === 0 ||
    host.length > 259 ||
    !match ||
    (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535))
  ) {
    throw new Error(`Refusing invalid GitHub host: ${JSON.stringify(value)}`);
  }
  return host;
}

/** Parse an audited Git remote URL into the exact GitHub CLI repository identity. */
export function parseTrustedGitHubRepository(value: string): TrustedGitHubRepository {
  const candidate = value.trim();
  if (!candidate || /[\0\r\n]/u.test(candidate)) {
    throw new Error("Git origin did not contain one valid GitHub repository URL");
  }

  let host: string;
  let repositoryPath: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate)) {
    let remote: URL;
    try {
      remote = new URL(candidate);
    } catch {
      throw new Error(`Git origin is not a valid GitHub URL: ${candidate}`);
    }
    if (!new Set(["https:", "ssh:", "git:"]).has(remote.protocol)) {
      throw new Error(`Git origin uses an unsupported GitHub protocol: ${remote.protocol}`);
    }
    if (
      remote.password ||
      (remote.protocol !== "ssh:" && remote.username) ||
      remote.search ||
      remote.hash
    ) {
      throw new Error("Git origin contains unsupported URL credentials, query, or fragment");
    }
    host = validateGitHubHost(remote.host);
    repositoryPath = remote.pathname.replace(/^\/+|\/+$/gu, "");
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):([^\s]+)$/u.exec(candidate);
    if (!scp?.[1] || !scp[2]) {
      throw new Error(`Git origin is not a supported GitHub URL: ${candidate}`);
    }
    host = validateGitHubHost(scp[1]);
    repositoryPath = scp[2].replace(/^\/+|\/+$/gu, "");
  }

  if (repositoryPath.endsWith(".git")) repositoryPath = repositoryPath.slice(0, -4);
  const segments = repositoryPath.split("/");
  if (segments.length !== 2) {
    throw new Error(`Git origin does not identify one owner/repository pair: ${candidate}`);
  }
  return {
    host,
    owner: validateGitHubRepositoryPart(segments[0] ?? "", "owner"),
    repo: validateGitHubRepositoryPart(segments[1] ?? "", "repository"),
  };
}

function sameGitHubRepository(
  left: TrustedGitHubRepository,
  right: { host?: string; owner: string; repo: string },
): boolean {
  return (
    (right.host === undefined || left.host === validateGitHubHost(right.host)) &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function trustedGitHubRepositorySelector(repository: TrustedGitHubRepository): string {
  return `${repository.host}/${repository.owner}/${repository.repo}`;
}

/**
 * Resolve repository identity through the trusted Git boundary before any
 * credential-bearing GitHub CLI process is started.
 */
export async function resolveTrustedGitHubRepository(
  projectRoot: string,
  options: TrustedGitHubExecutionOptions,
): Promise<TrustedGitHubRepository> {
  const sourceEnvironment = options.environment ?? process.env;
  const configuredHost = validateGitHubHost(
    readEnvironmentValue(sourceEnvironment, "GH_HOST")?.value ?? "github.com",
  );
  const result = await runTrustedGitResult(projectRoot, ["remote", "get-url", "origin"], {
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    ...(options.trustedBoundaryRoot ? { trustedBoundaryRoot: options.trustedBoundaryRoot } : {}),
    environment: sourceEnvironment,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Git origin repository is unavailable",
    );
  }
  const repository = parseTrustedGitHubRepository(result.stdout);
  if (repository.host !== configuredHost) {
    throw new Error(
      `Git origin host ${repository.host} does not match the trusted GitHub host ${configuredHost}`,
    );
  }
  if (options.expectedRepository) {
    const expected: TrustedGitHubRepository = {
      host: validateGitHubHost(options.expectedRepository.host ?? configuredHost),
      owner: validateGitHubRepositoryPart(options.expectedRepository.owner, "owner"),
      repo: validateGitHubRepositoryPart(options.expectedRepository.repo, "repository"),
    };
    if (!sameGitHubRepository(repository, expected)) {
      throw new Error(
        `Git origin ${trustedGitHubRepositorySelector(repository)} does not match expected repository ${trustedGitHubRepositorySelector(expected)}`,
      );
    }
  }
  return repository;
}

function assertGitHubArgumentsBoundToRepository(
  args: readonly string[],
  repository: TrustedGitHubRepository,
): void {
  for (const argument of args) {
    const option = argument.toLowerCase();
    if (option === "-r" || option === "--repo" || option.startsWith("--repo=")) {
      throw new Error("GitHub repository selection is owned by the trusted launcher");
    }
  }
  if (args[0] !== "pr" || !new Set(["view", "merge", "close"]).has(args[1] ?? "")) return;
  const pullRequestUrl = args[2];
  if (!pullRequestUrl?.startsWith("https://")) return;
  let parsed: URL;
  try {
    parsed = new URL(pullRequestUrl);
  } catch {
    throw new Error("Refusing malformed GitHub pull-request URL");
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/[1-9][0-9]*\/?$/u.exec(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !match
  ) {
    throw new Error("Refusing malformed GitHub pull-request URL");
  }
  const selected: TrustedGitHubRepository = {
    host: validateGitHubHost(parsed.host),
    owner: validateGitHubRepositoryPart(match[1] ?? "", "owner"),
    repo: validateGitHubRepositoryPart(match[2] ?? "", "repository"),
  };
  if (!sameGitHubRepository(repository, selected)) {
    throw new Error("GitHub pull-request URL does not match the audited repository");
  }
}

/** Execute GitHub CLI without repository cwd/PATH discovery or ambient secrets. */
export async function runTrustedGitHubResult(
  projectRoot: string,
  args: readonly string[],
  options: TrustedGitHubExecutionOptions,
): Promise<TrustedGitResult> {
  if (args.some((argument) => argument.includes("\0"))) {
    throw new Error("Refusing unsafe GitHub CLI argument");
  }
  return executeTrustedGitHubRequest(projectRoot, options, (repository) => {
    assertGitHubArgumentsBoundToRepository(args, repository);
    return {
      args: [...args, "--repo", trustedGitHubRepositorySelector(repository)],
      input: options.input,
    };
  });
}

/** Read one bounded issue page from the audited repository, without search indexing. */
export async function runTrustedGitHubIssuePageResult(
  projectRoot: string,
  after: string | undefined,
  options: TrustedGitHubExecutionOptions,
): Promise<TrustedGitResult> {
  if (after !== undefined && (!after || after.length > 1024 || /[\0\r\n]/u.test(after))) {
    throw new Error("Refusing invalid GitHub issue pagination cursor");
  }
  return executeTrustedGitHubRequest(
    projectRoot,
    { ...options, maxBuffer: Math.min(options.maxBuffer, GITHUB_ISSUE_PAGE_MAX_BUFFER) },
    (repository) => ({
      // gh api does not accept --repo. Bind repository variables in the fixed
      // query and let the audited launcher supply GH_HOST instead.
      args: ["api", "graphql", "--input", "-"],
      input: JSON.stringify({
        query: GITHUB_ISSUE_PAGE_QUERY,
        variables: { owner: repository.owner, name: repository.repo, after: after ?? null },
      }),
    }),
  );
}

async function executeTrustedGitHubRequest(
  projectRoot: string,
  options: TrustedGitHubExecutionOptions,
  requestForRepository: (repository: TrustedGitHubRepository) => {
    args: string[];
    input?: string;
  },
): Promise<TrustedGitResult> {
  const canonicalProjectRoot = realpathSync.native(path.resolve(projectRoot));
  const sourceEnvironment = options.environment ?? process.env;
  const repository = await resolveTrustedGitHubRepository(canonicalProjectRoot, options);
  const request = requestForRepository(repository);
  const invocation = resolveTrustedGitHubCli(
    canonicalProjectRoot,
    sourceEnvironment,
    options.trustedBoundaryRoot ?? canonicalProjectRoot,
  );
  invocation.environment.GH_HOST = repository.host;
  const neutralCwd = path.dirname(invocation.executable);
  invocation.environment.GIT_CEILING_DIRECTORIES = neutralCwd;
  return new Promise((resolve) => {
    const child = execFile(
      invocation.executable,
      request.args,
      {
        cwd: neutralCwd,
        env: invocation.environment,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        const rawExitCode = error ? (error as { code?: unknown }).code : undefined;
        resolve({
          exitCode: error ? (typeof rawExitCode === "number" ? rawExitCode : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
    if (request.input !== undefined) {
      // A consumer may exit before reading stdin (for example after argument
      // validation). The process result remains authoritative in that case;
      // suppress only the redundant pipe error so it cannot become an
      // unhandled event.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(request.input, "utf8");
    }
  });
}

export function runTrustedGitResult(
  projectRoot: string,
  args: readonly string[],
  options: TrustedGitExecutionOptions,
): Promise<TrustedGitResult> {
  const invocation = prepareTrustedGitInvocation(projectRoot, args, options);
  // This second attestation immediately before spawn narrows the unavoidable
  // audit-to-use window. Selected allowlisted local aliases are replaced with
  // the canonical URL operand (plus captured fetch refspecs), so a concurrent
  // remote-url edit cannot retarget that transport. Filesystems do not offer a portable cross-process read
  // lock here; the post-run attestation remains the final fail-closed signal.
  assertAndCaptureTrustedGitConfiguration(
    invocation.executable,
    invocation.repository.configPaths,
    options.environment ?? process.env,
  );
  return new Promise((resolve) => {
    execFile(
      invocation.executable,
      invocation.commandArgs,
      {
        cwd: path.dirname(invocation.executable),
        env: invocation.environment,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        try {
          refreshTrustedGitConfiguration(
            invocation.executable,
            invocation.repository.configPaths,
            options.environment ?? process.env,
          );
        } catch (refreshError: unknown) {
          resolve({
            exitCode: 1,
            stdout,
            stderr: refreshError instanceof Error ? refreshError.message : String(refreshError),
          });
          return;
        }
        const rawExitCode = error ? (error as { code?: unknown }).code : undefined;
        // Native status one means absence for some read commands. A timeout,
        // signal, spawn error or buffer failure must never masquerade as that.
        const exitCode = error
          ? typeof rawExitCode === "number" &&
            Number.isInteger(rawExitCode) &&
            rawExitCode > 0 &&
            error.killed !== true &&
            error.signal == null
            ? rawExitCode
            : -1
          : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

export interface TrustedGitSyncOptions extends Partial<TrustedGitExecutionOptions> {
  errorContext?: string;
}

/** Synchronous form used by dispatcher lifecycle code; shares the same policy. */
export function runTrustedGitSync(
  args: readonly string[],
  projectRoot: string,
  options: TrustedGitSyncOptions = {},
): string {
  const executionOptions: TrustedGitExecutionOptions = {
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    ...(options.trustedBoundaryRoot ? { trustedBoundaryRoot: options.trustedBoundaryRoot } : {}),
    ...(options.trustedLocalReadRemotePaths
      ? { trustedLocalReadRemotePaths: options.trustedLocalReadRemotePaths }
      : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.expectedRepository ? { expectedRepository: options.expectedRepository } : {}),
  };
  let invocation: PreparedTrustedGitInvocation | undefined;
  try {
    invocation = prepareTrustedGitInvocation(projectRoot, args, executionOptions);
    assertAndCaptureTrustedGitConfiguration(
      invocation.executable,
      invocation.repository.configPaths,
      executionOptions.environment ?? process.env,
    );
    const stdout = execFileSync(invocation.executable, invocation.commandArgs, {
      cwd: path.dirname(invocation.executable),
      env: invocation.environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: executionOptions.timeoutMs,
      maxBuffer: executionOptions.maxBuffer,
    });
    refreshTrustedGitConfiguration(
      invocation.executable,
      invocation.repository.configPaths,
      executionOptions.environment ?? process.env,
    );
    return stdout;
  } catch (error: unknown) {
    let finalError: unknown = error;
    if (invocation) {
      try {
        refreshTrustedGitConfiguration(
          invocation.executable,
          invocation.repository.configPaths,
          executionOptions.environment ?? process.env,
        );
      } catch (auditError: unknown) {
        finalError = auditError;
      }
    }
    if (!options.errorContext) throw finalError;
    const stderr =
      typeof finalError === "object" &&
      finalError !== null &&
      "stderr" in finalError &&
      typeof (finalError as { stderr?: unknown }).stderr === "string"
        ? (finalError as { stderr: string }).stderr.trim()
        : "";
    const stdout =
      typeof finalError === "object" &&
      finalError !== null &&
      "stdout" in finalError &&
      typeof (finalError as { stdout?: unknown }).stdout === "string"
        ? (finalError as { stdout: string }).stdout.trim()
        : "";
    const detail =
      stderr || stdout || (finalError instanceof Error ? finalError.message : String(finalError));
    throw new Error(`${options.errorContext}: ${detail}`);
  }
}

export async function runTrustedGit(
  projectRoot: string,
  args: string[],
  options: TrustedGitExecutionOptions & { errorContext: string },
): Promise<string> {
  let result: TrustedGitResult;
  try {
    result = await runTrustedGitResult(projectRoot, args, options);
  } catch (error: unknown) {
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
    throw new Error(`${options.errorContext}: ${detail}`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "git command failed";
    throw new Error(`${options.errorContext}: ${detail}`);
  }
  return result.stdout;
}
