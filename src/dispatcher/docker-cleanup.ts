import { execSync } from "node:child_process";

export interface DockerCleanupLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function logInfo(logger: DockerCleanupLogger | undefined, message: string): void {
  logger?.info?.(message);
}

function logWarn(logger: DockerCleanupLogger | undefined, message: string): void {
  logger?.warn?.(message);
}

/**
 * Best-effort cleanup of docker compose services started from a worktree.
 * Never throws -- failures are logged and ignored.
 */
export function cleanupWorktreeContainers(
  worktreePath: string,
  logger?: DockerCleanupLogger,
): boolean {
  const cmd =
    `docker compose --project-directory ${quoteArg(worktreePath)} ` +
    "down --volumes --remove-orphans";
  try {
    execSync(cmd, {
      stdio: "pipe",
      timeout: 45_000,
    });
    logInfo(logger, `[docker-cleanup] Stopped containers for ${worktreePath}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(logger, `[docker-cleanup] Non-fatal cleanup failure for ${worktreePath}: ${msg}`);
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
    const out = execSync('docker ps --format "{{.Names}}"', {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    });
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
