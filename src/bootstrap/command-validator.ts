import { spawn } from "node:child_process";
import type { CommandValidation } from "./intake-types.js";
import { analyzeTestOutput, isTestCommand } from "../testing/test-output-analysis.js";

// ─── Command Validation ────────────────────────────────────────────

export async function validateCommands(
  projectPath: string,
  commands: Array<{ name: string; command: string }>,
): Promise<CommandValidation[]> {
  const results: CommandValidation[] = [];

  for (const cmd of commands) {
    const result = await validateCommand(projectPath, cmd.name, cmd.command);
    results.push(result);
  }

  return results;
}

async function validateCommand(
  projectPath: string,
  name: string,
  command: string,
): Promise<CommandValidation> {
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let status: "pass" | "fail" | "timeout" | "skipped" = "skipped";
  let testCount: number | undefined = undefined;

  try {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const isWin = process.platform === "win32";
        const [shellCmd, ...args] = command.split(" ");
        const child = spawn(shellCmd, args, {
          cwd: projectPath,
          shell: true,
          env: { ...process.env, CI: "true" },
          ...(isWin ? {} : { detached: true }),
        });

        const timer = setTimeout(() => {
          try {
            if (isWin) {
              // On Windows, use taskkill to kill the process tree
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
            } else if (child.pid) {
              // On Unix, kill the process group
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            child.kill("SIGKILL");
          }
          reject(new Error("timeout"));
        }, 30000);

        child.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 0, stdout, stderr });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    exitCode = result.exitCode;
    stdout = result.stdout;
    stderr = result.stderr;
    status = exitCode === 0 ? "pass" : "fail";

    // Parse test count from output. A command that explicitly reports zero
    // tests is not a healthy verification command, even if the runner exits 0
    // because of flags such as --passWithNoTests.
    const parsedTests = analyzeTestOutput(stdout, stderr);
    testCount = parsedTests.count;
    if (status === "pass" && isTestCommand(name, command) && parsedTests.explicitNoTests) {
      status = "fail";
      stderr += "\nVerification command reported zero tests.";
    }
  } catch (err) {
    if (err instanceof Error && err.message === "timeout") {
      status = "timeout";
    } else {
      status = "fail";
      stderr += err instanceof Error ? err.message : String(err);
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    name,
    command,
    exitCode,
    durationMs,
    stdout: truncate(stdout, 2000),
    stderr: truncate(stderr, 2000),
    testCount,
    status,
  };
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + "... [truncated]";
}
