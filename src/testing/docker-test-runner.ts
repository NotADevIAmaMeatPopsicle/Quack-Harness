// ─── Docker Test Runner ────────────────────────────────────────────
// Handles test execution inside Docker Compose services.
// Supports warmup, run, scoped run, and teardown lifecycle.
// Gracefully falls back when Docker is unavailable.

import { execSync, spawnSync } from "node:child_process";
import { worktreeEnv } from "../utils/worktree-env.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface DockerRunOptions {
  composeFile: string;
  service: string;
  command: string;
  workDir: string;
  timeout: number;
  dependsOn?: string[];
}

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ─── Docker availability check ───────────────────────────────────────

/**
 * Check whether Docker is available and running on this host.
 * Returns false gracefully if Docker Desktop is not running or docker is not installed.
 */
export function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

// ─── Compose command helpers ──────────────────────────────────────────

/**
 * Build the base `docker compose` command with project-directory and file flags.
 */
function buildComposeBase(composeFile: string, workDir: string): string {
  return `docker compose -f "${composeFile}" --project-directory "${workDir}"`;
}

// ─── Warmup ──────────────────────────────────────────────────────────

/**
 * Start dependent services (e.g., postgres, redis) via `docker compose up -d`.
 * Waits for health checks by retrying until services are healthy or timeout expires.
 *
 * @param composeFile Path to the docker-compose file (absolute or relative to workDir)
 * @param dependsOn Services to start (e.g., ["postgres", "redis"])
 * @param workDir Git worktree path (used as --project-directory)
 * @param timeoutMs Maximum time to wait for services to become healthy
 */
export function warmUp(
  composeFile: string,
  dependsOn: string[],
  workDir: string,
  timeoutMs = 60_000,
): void {
  if (dependsOn.length === 0) return;

  const env = worktreeEnv(workDir);
  const base = buildComposeBase(composeFile, workDir);
  const services = dependsOn.join(" ");

  // Start services in detached mode
  execSync(`${base} up -d ${services}`, {
    cwd: workDir,
    env,
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for services to be healthy (poll every 2s up to timeoutMs)
  const deadline = Date.now() + timeoutMs;
  let healthy = false;

  while (Date.now() < deadline) {
    try {
      const result = execSync(`${base} ps --format json`, {
        cwd: workDir,
        env,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Check that all requested services are running/healthy
      const lines = result.trim().split("\n").filter(Boolean);
      const runningServices = new Set<string>();

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { Service?: string; State?: string; Health?: string };
          if (
            parsed.Service &&
            (parsed.State === "running" || parsed.State === "healthy") &&
            parsed.Health !== "starting"
          ) {
            runningServices.add(parsed.Service);
          }
        } catch {
          // Non-JSON line — ignore
        }
      }

      if (dependsOn.every((s) => runningServices.has(s))) {
        healthy = true;
        break;
      }
    } catch {
      // ps failed — keep polling
    }

    // Sleep 2s between polls (busy wait with short sleep)
    try {
      execSync('node -e "setTimeout(() => {}, 2000)"', {
        timeout: 3000,
        stdio: "ignore",
      });
    } catch {
      // Sleep failed — continue
    }
  }

  if (!healthy) {
    // Non-fatal: services may still work even without health confirmation
    // The caller (dispatcher) decides whether to abort based on subsequent failures
  }
}

// ─── Run ─────────────────────────────────────────────────────────────

/**
 * Run a command inside a Docker Compose service via `docker compose run --rm`.
 * Uses --project-directory so volume mounts resolve to the worktree path.
 */
export function run(opts: DockerRunOptions): DockerRunResult {
  const { composeFile, service, command, workDir, timeout } = opts;
  const env = worktreeEnv(workDir);
  const base = buildComposeBase(composeFile, workDir);

  const fullCommand = `${base} run --rm ${service} ${command}`;

  try {
    const output = execSync(fullCommand, {
      cwd: workDir,
      env,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      exitCode: 0,
      stdout: typeof output === "string" ? output : "",
      stderr: "",
      timedOut: false,
    };
  } catch (err: unknown) {
    if (isExecError(err)) {
      const timedOut = !!(err.killed || err.signal === "SIGTERM");
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout ?? "",
        stderr: timedOut ? `Command timed out after ${timeout}ms` : (err.stderr ?? ""),
        timedOut,
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
}

// ─── Scoped run ───────────────────────────────────────────────────────

/**
 * Run a scoped test command (--findRelatedTests) inside Docker Compose.
 * Appends the changed files list to the command so only related tests run.
 */
export function runScoped(opts: DockerRunOptions, changedFiles: string[]): DockerRunResult {
  if (changedFiles.length === 0) {
    // No changed files — run the full command
    return run(opts);
  }

  const fileList = changedFiles.map((f) => `"${f}"`).join(" ");
  const scopedCommand = `${opts.command} --findRelatedTests ${fileList}`;

  return run({ ...opts, command: scopedCommand });
}

// ─── Teardown ─────────────────────────────────────────────────────────

/**
 * Stop all services defined in the compose file via `docker compose down`.
 */
export function tearDown(composeFile: string, workDir: string, timeoutMs = 30_000): void {
  const env = worktreeEnv(workDir);
  const base = buildComposeBase(composeFile, workDir);

  try {
    execSync(`${base} down`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.warn(
      `[docker-teardown] down failed for ${composeFile} in ${workDir}: ${(err as Error).message}`,
    );
    // Non-fatal: services may already be stopped; worktree removal must still proceed
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────

interface ExecError {
  status?: number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null && ("status" in err || "killed" in err);
}
