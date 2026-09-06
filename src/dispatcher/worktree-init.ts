// ─── Worktree Init ───────────────────────────────────────────────────
// Runs dependency installation steps after a worktree is created.
// Auto-discovers package.json files and runs npm ci (falling back to
// npm install when no package-lock.json exists) unless explicit steps
// are configured in the adapter's dispatch.worktreeInit config.

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { IEventWriter } from "../monitor/event-emitter.js";
import type { WorktreeInitResult, WorktreeInitStep } from "../core/types.js";

const execAsync = promisify(exec);

/** Maximum shell output buffer: 10MB */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Timeout for each install step in milliseconds (5 minutes) */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum directory recursion depth for package.json discovery */
const MAX_DISCOVERY_DEPTH = 3;

/** Directories to exclude from package.json discovery */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/**
 * Executes a single shell command and returns exit code + stderr + stdout.
 */
async function execStep(
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stderr: stderr ?? "", stdout: stdout ?? "" };
  } catch (err) {
    const e = err as {
      code?: number;
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stderr: e.stderr ?? e.message ?? String(err),
      stdout: e.stdout ?? "",
    };
  }
}

/**
 * Finds package.json files under `dir`, excluding:
 *   - node_modules/   (anywhere in path)
 *   - .git/           (anywhere in path)
 *   - dist/           (anywhere in path)
 *   - build/          (anywhere in path)
 * Recursion depth capped at MAX_DISCOVERY_DEPTH (3).
 *
 * Returns absolute paths to discovered package.json files.
 */
async function discoverPackageJsonFiles(dir: string, depth: number = 0): Promise<string[]> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    return [];
  }

  const results: string[] = [];

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  // Check for package.json at current level
  const hasPackageJson = entries.some((e) => e.isFile() && e.name === "package.json");
  if (hasPackageJson) {
    results.push(path.join(dir, "package.json"));
  }

  // Recurse into subdirectories (excluding EXCLUDED_DIRS)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const subDir = path.join(dir, entry.name);
    const nested = await discoverPackageJsonFiles(subDir, depth + 1);
    results.push(...nested);
  }

  return results;
}

/**
 * Runs worktree initialization steps after a branch/worktree is created.
 *
 * Behavior:
 * - If `explicitSteps` is provided and non-empty: runs ONLY those steps,
 *   in order, with no auto-discovery.
 * - If `explicitSteps` is omitted or empty: auto-discovers package.json
 *   files under `worktreePath` (excluding node_modules/, .git/, dist/,
 *   build/, up to MAX_DISCOVERY_DEPTH=3 levels) and runs npm ci for each.
 *   Falls back to npm install if no package-lock.json exists alongside
 *   the discovered package.json.
 *
 * Never throws — all errors are captured in WorktreeInitResult.errors[].
 * The caller (dispatcher.ts) decides whether to abort on failure.
 *
 * @param worktreePath  Absolute path to the worktree root
 * @param explicitSteps Optional array of explicit steps from adapter config.
 *                      Each entry is either a plain shell command string or
 *                      a structured WorktreeInitStep object.
 * @param events        Optional IEventWriter for progress emission. Works
 *                      correctly when undefined (no-op, per convention).
 */
export async function runWorktreeInit(
  worktreePath: string,
  explicitSteps?: Array<string | WorktreeInitStep>,
  events?: IEventWriter,
): Promise<WorktreeInitResult> {
  const errors: WorktreeInitResult["errors"] = [];
  let stepsRun = 0;

  const useExplicit = explicitSteps !== undefined && explicitSteps.length > 0;
  const mode = useExplicit ? "explicit" : "auto";

  if (useExplicit) {
    // ── Explicit-config mode ───────────────────────────────────────
    const stepCount = explicitSteps.length;

    events?.emit(
      "worktree_init_start" as Parameters<IEventWriter["emit"]>[0],
      {
        worktreePath,
        mode,
        stepCount,
      } as Parameters<IEventWriter["emit"]>[1],
    );

    for (const stepDef of explicitSteps) {
      const isString = typeof stepDef === "string";
      const command = isString ? stepDef : stepDef.command;
      const label = isString ? command : (stepDef.label ?? command);
      const cwd = isString ? worktreePath : path.resolve(worktreePath, stepDef.cwd ?? ".");
      const env = isString ? undefined : stepDef.env;

      stepsRun++;
      const startMs = Date.now();
      const result = await execStep(command, cwd, env);
      const durationMs = Date.now() - startMs;

      if (result.exitCode === 0) {
        events?.emit(
          "worktree_init_step_complete" as Parameters<IEventWriter["emit"]>[0],
          { step: label, durationMs } as Parameters<IEventWriter["emit"]>[1],
        );
      } else {
        errors.push({
          step: label,
          message: result.stderr || `Command exited with code ${result.exitCode}`,
          exitCode: result.exitCode,
        });
        events?.emit(
          "worktree_init_step_failed" as Parameters<IEventWriter["emit"]>[0],
          {
            step: label,
            exitCode: result.exitCode,
            stderr: result.stderr,
            durationMs,
          } as Parameters<IEventWriter["emit"]>[1],
        );
      }
    }
  } else {
    // ── Auto-discovery mode ────────────────────────────────────────
    const packageJsonFiles = await discoverPackageJsonFiles(worktreePath, 0);
    const stepCount = packageJsonFiles.length;

    events?.emit(
      "worktree_init_start" as Parameters<IEventWriter["emit"]>[0],
      {
        worktreePath,
        mode,
        stepCount,
      } as Parameters<IEventWriter["emit"]>[1],
    );

    for (const pkgJsonPath of packageJsonFiles) {
      const pkgDir = path.dirname(pkgJsonPath);
      const relativeDir = path.relative(worktreePath, pkgDir);
      const lockfilePath = path.join(pkgDir, "package-lock.json");
      const hasLockfile = await fs
        .access(lockfilePath)
        .then(() => true)
        .catch(() => false);

      const command = hasLockfile ? "npm ci" : "npm install";
      const label = relativeDir === "" ? command : `${command} ${relativeDir}`;

      stepsRun++;
      const startMs = Date.now();
      const result = await execStep(command, pkgDir);
      const durationMs = Date.now() - startMs;

      if (result.exitCode === 0) {
        events?.emit(
          "worktree_init_step_complete" as Parameters<IEventWriter["emit"]>[0],
          { step: label, durationMs } as Parameters<IEventWriter["emit"]>[1],
        );
      } else {
        errors.push({
          step: label,
          message: result.stderr || `Command exited with code ${result.exitCode}`,
          exitCode: result.exitCode,
        });
        events?.emit(
          "worktree_init_step_failed" as Parameters<IEventWriter["emit"]>[0],
          {
            step: label,
            exitCode: result.exitCode,
            stderr: result.stderr,
            durationMs,
          } as Parameters<IEventWriter["emit"]>[1],
        );
      }
    }
  }

  const success = errors.length === 0;

  events?.emit(
    "worktree_init_complete" as Parameters<IEventWriter["emit"]>[0],
    {
      success,
      stepsRun,
      errorCount: errors.length,
    } as Parameters<IEventWriter["emit"]>[1],
  );

  return { success, stepsRun, errors };
}
