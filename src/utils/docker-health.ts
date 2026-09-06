// ─── Docker Health Check ──────────────────────────────────────────
// Standalone utility to check Docker daemon availability before dispatch.
// Used by the monitor server to prevent dispatching tasks whose required
// verification commands need Docker when Docker Desktop isn't running.
//
// Separate from DockerManager (which requires DockerIsolationConfig)
// because projects may use Docker only in verification commands without
// configuring Docker isolation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerHealthResult {
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Check if Docker daemon is running and reachable.
 * Returns a result object — never throws.
 */
export async function checkDockerHealth(): Promise<DockerHealthResult> {
  try {
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 5000,
    });
    return { available: true, version: stdout.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, error: msg };
  }
}

/**
 * Check if any required verification commands need Docker.
 * Scans command strings (or structured cmd+args joined) for the "docker" keyword.
 *
 * Accepts either:
 *  - Legacy `{ command: string, required: boolean }`
 *  - Structured `{ cmd: string, args: string[], required: boolean }`
 */
export function requiresDocker(
  commands: Array<
    { command: string; required: boolean } | { cmd: string; args: string[]; required: boolean }
  >,
): boolean {
  return commands.some((c) => {
    if (!c.required) return false;
    const haystack = "command" in c ? c.command : `${c.cmd} ${(c.args ?? []).join(" ")}`;
    return /\bdocker\b/i.test(haystack);
  });
}
