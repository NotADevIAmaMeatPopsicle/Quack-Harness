import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

export interface DockerCleanupLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface DockerInspectRecord {
  Id?: unknown;
  Config?: {
    Labels?: Record<string, string> | null;
  };
  Mounts?: Array<{
    Source?: unknown;
  }>;
}

const SAFE_DOCKER_ENV_NAMES = [
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
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

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

function canonicalizePotentialPath(candidate: string): string {
  try {
    return realpathSync.native(path.resolve(candidate));
  } catch {
    return path.resolve(candidate);
  }
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  return (
    normalized === "" ||
    (normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized))
  );
}

function mutableRootsForWorktree(worktreePath: string): string[] {
  const roots = [worktreePath, process.cwd()];
  const worktreesDirectory = path.dirname(path.resolve(worktreePath));
  const quackDirectory = path.dirname(worktreesDirectory);
  if (
    path.basename(worktreesDirectory).toLowerCase() === "worktrees" &&
    path.basename(quackDirectory).toLowerCase() === ".quack"
  ) {
    roots.push(path.dirname(quackDirectory));
  }
  return [...new Set(roots.map(canonicalizePotentialPath))];
}

function dockerExecutableCandidates(environment: NodeJS.ProcessEnv): string[] {
  const pathValue = readEnvironmentValue(environment, "PATH")?.value ?? "";
  const directories = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  if (process.platform === "win32") {
    const programFiles = readEnvironmentValue(environment, "PROGRAMFILES")?.value;
    if (programFiles && path.win32.isAbsolute(programFiles)) {
      directories.push(path.join(programFiles, "Docker", "Docker", "resources", "bin"));
    }
  }
  const executableName = process.platform === "win32" ? "docker.exe" : "docker";
  return [...new Set(directories.map((directory) => path.join(directory, executableName)))];
}

let dockerExecutableOverrideForTests: string | undefined;

/** Test seam. The candidate still passes the production canonical-path checks. */
export function _setDockerExecutableForTests(candidate: string | undefined): void {
  dockerExecutableOverrideForTests = candidate;
}

/** Resolve Docker without allowing the OS to search a mutable project cwd. */
export function resolveTrustedDockerExecutable(
  mutableRoots: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const canonicalMutableRoots = mutableRoots.map(canonicalizePotentialPath);
  let lastError: unknown;
  const candidates = dockerExecutableOverrideForTests
    ? [dockerExecutableOverrideForTests]
    : dockerExecutableCandidates(environment);
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync.native(candidate);
      if (!statSync(canonical).isFile()) continue;
      if (process.platform === "win32" && path.extname(canonical).toLowerCase() !== ".exe") {
        continue;
      }
      accessSync(canonical, fsConstants.X_OK);
      if (canonicalMutableRoots.some((root) => isInsidePath(root, canonical))) {
        throw new Error(`Docker executable resolves inside a mutable project: ${canonical}`);
      }
      return canonical;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to resolve a trusted Docker executable outside mutable projects: ${
      lastError instanceof Error ? lastError.message : "no absolute PATH candidate"
    }`,
  );
}

export function trustedDockerEnvironment(
  dockerExecutable: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_DOCKER_ENV_NAMES) {
    const entry = readEnvironmentValue(source, name);
    if (entry) environment[entry.name] = entry.value;
  }
  const searchDirectories = [path.dirname(dockerExecutable)];
  const systemRoot =
    readEnvironmentValue(source, "SYSTEMROOT")?.value ??
    readEnvironmentValue(source, "WINDIR")?.value;
  if (process.platform === "win32" && systemRoot) {
    searchDirectories.push(path.join(systemRoot, "System32"));
  }
  environment.PATH = searchDirectories.join(path.delimiter);
  return environment;
}

function dockerExecOptions(
  executable: string,
  timeout: number,
): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd: path.dirname(executable),
    encoding: "utf8",
    env: trustedDockerEnvironment(executable),
    shell: false,
    stdio: "pipe",
    timeout,
    windowsHide: true,
  };
}

function logInfo(logger: DockerCleanupLogger | undefined, message: string): void {
  logger?.info?.(message);
}

function logWarn(logger: DockerCleanupLogger | undefined, message: string): void {
  logger?.warn?.(message);
}

function normalizeHostPath(value: string): string {
  let candidate = value.trim();
  if (process.platform === "win32") {
    const dockerDesktopPath = candidate.match(
      /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([A-Za-z])\/(.*)$/,
    );
    if (dockerDesktopPath) {
      candidate = `${dockerDesktopPath[1]}:/${dockerDesktopPath[2]}`;
    }
  }
  const absolute = path.resolve(candidate);
  const suffix: string[] = [];
  let existing = absolute;
  let normalized = absolute;
  while (existing.length > 0) {
    try {
      lstatSync(existing);
      normalized = path.join(realpathSync(existing), ...suffix);
      break;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  normalized = path.normalize(normalized);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathBelongsToRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeHostPath(candidate);
  const normalizedRoot = normalizeHostPath(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function parseInspectRecord(raw: string): DockerInspectRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object") {
    throw new Error("docker inspect returned an unexpected shape");
  }
  return parsed[0] as DockerInspectRecord;
}

function containerLabelsBelongToWorktree(
  record: DockerInspectRecord,
  worktreePath: string,
): boolean {
  const labels = record.Config?.Labels ?? {};
  const workingDirectory = labels["com.docker.compose.project.working_dir"];
  if (workingDirectory && pathBelongsToRoot(workingDirectory, worktreePath)) return true;

  const configFiles = labels["com.docker.compose.project.config_files"];
  if (configFiles) {
    for (const configFile of configFiles.split(",")) {
      const trimmed = configFile.trim();
      if (!trimmed) continue;
      const resolved = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(workingDirectory ?? worktreePath, trimmed);
      if (pathBelongsToRoot(resolved, worktreePath)) return true;
    }
  }

  return false;
}

interface WorktreeContainerInventory {
  removableIds: string[];
  broaderMountIds: string[];
}

function inspectWorktreeContainers(
  worktreePath: string,
  dockerExecutable: string,
): WorktreeContainerInventory {
  const rawIds = execFileSync(
    dockerExecutable,
    ["ps", "-aq", "--no-trunc"],
    dockerExecOptions(dockerExecutable, 10_000),
  );
  const ids = rawIds
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const removableIds: string[] = [];
  const broaderMountIds: string[] = [];
  for (const id of ids) {
    const raw = execFileSync(
      dockerExecutable,
      ["inspect", id],
      dockerExecOptions(dockerExecutable, 10_000),
    );
    const record = parseInspectRecord(raw);
    if (typeof record.Id !== "string" || record.Id.length === 0) {
      throw new Error(`docker inspect did not return an id for ${id}`);
    }
    const mountedInsideWorktree = (record.Mounts ?? []).some(
      (mount) => typeof mount.Source === "string" && pathBelongsToRoot(mount.Source, worktreePath),
    );
    const mountsWorktreeThroughAncestor = (record.Mounts ?? []).some(
      (mount) =>
        typeof mount.Source === "string" &&
        !pathBelongsToRoot(mount.Source, worktreePath) &&
        pathBelongsToRoot(worktreePath, mount.Source),
    );
    if (containerLabelsBelongToWorktree(record, worktreePath) || mountedInsideWorktree) {
      removableIds.push(record.Id);
    } else if (mountsWorktreeThroughAncestor) {
      // A container mounting the repository or worktree-parent can still write
      // this worktree, but that broad mount is not proof that the container is
      // owned by this run. Refuse recovery instead of deleting an unrelated
      // container.
      broaderMountIds.push(record.Id);
    }
  }
  return { removableIds, broaderMountIds };
}

/**
 * Remove containers whose immutable Docker metadata ties them to the exact
 * worktree, then prove no such containers remain. This avoids trusting a
 * Compose file that the stopped worker could have changed or deleted and also
 * supports custom Compose filenames.
 */
export function cleanupWorktreeContainers(
  worktreePath: string,
  logger?: DockerCleanupLogger,
): boolean {
  try {
    const dockerExecutable = resolveTrustedDockerExecutable(mutableRootsForWorktree(worktreePath));
    const initial = inspectWorktreeContainers(worktreePath, dockerExecutable);
    if (initial.broaderMountIds.length > 0) {
      logWarn(
        logger,
        `[docker-cleanup] Refusing cleanup because ${initial.broaderMountIds.length} container(s) ` +
          `mount a broader host path containing ${worktreePath}: ${initial.broaderMountIds.join(", ")}`,
      );
      return false;
    }
    if (initial.removableIds.length > 0) {
      execFileSync(
        dockerExecutable,
        ["rm", "--force", "--volumes", ...initial.removableIds],
        dockerExecOptions(dockerExecutable, 45_000),
      );
    }

    const survivors = inspectWorktreeContainers(worktreePath, dockerExecutable);
    if (survivors.broaderMountIds.length > 0) {
      logWarn(
        logger,
        `[docker-cleanup] ${survivors.broaderMountIds.length} container(s) still mount a broader ` +
          `host path containing ${worktreePath}: ${survivors.broaderMountIds.join(", ")}`,
      );
      return false;
    }
    if (survivors.removableIds.length > 0) {
      logWarn(
        logger,
        `[docker-cleanup] ${survivors.removableIds.length} worktree container(s) remain for ` +
          `${worktreePath}: ${survivors.removableIds.join(", ")}`,
      );
      return false;
    }

    logInfo(
      logger,
      initial.removableIds.length > 0
        ? `[docker-cleanup] Removed ${initial.removableIds.length} container(s) for ${worktreePath}`
        : `[docker-cleanup] Verified no containers are attached to ${worktreePath}`,
    );
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      logger,
      `[docker-cleanup] Could not verify container absence for ${worktreePath}: ${msg}`,
    );
    return false;
  }
}

/**
 * Detect stale task containers left behind from previous runs.
 * Matches names like task-691-postgres-1 or task-691-redis-1.
 */
export async function detectStaleContainers(logger?: DockerCleanupLogger): Promise<string[]> {
  await Promise.resolve();
  try {
    const dockerExecutable = resolveTrustedDockerExecutable([process.cwd()]);
    const out = execFileSync(
      dockerExecutable,
      ["ps", "--format", "{{.Names}}"],
      dockerExecOptions(dockerExecutable, 10_000),
    );
    const names = out
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter(Boolean);

    const stale = names.filter((name) => /^task-.*-(postgres|redis)-/i.test(name));

    if (stale.length > 0) {
      logWarn(
        logger,
        `[docker-cleanup] Detected ${stale.length} stale task containers: ${stale.join(", ")}`,
      );
    } else {
      logInfo(logger, "[docker-cleanup] No stale task containers detected");
    }

    return stale;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(logger, `[docker-cleanup] Unable to scan docker containers: ${msg}`);
    return [];
  }
}
