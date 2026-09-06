import { spawn } from "node:child_process";

const MAX_BUFFER = 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;

export interface GhResult {
  stdout: string;
  stderr: string;
}

/** Run GitHub CLI without invoking a shell. Optional input is written to stdin. */
export function runGh(
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`GitHub CLI timed out after ${options.timeoutMs ?? GH_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? GH_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_BUFFER) {
        child.kill();
        fail(new Error("GitHub CLI stdout exceeded 1 MiB"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_BUFFER) {
        child.kill();
        fail(new Error("GitHub CLI stderr exceeded 1 MiB"));
      }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `GitHub CLI exited with code ${code ?? "unknown"}`));
      }
    });

    child.stdin.end(options.input);
  });
}
