// ─── Codex CLI Review Runner ────────────────────────────────────────
// Subprocess review runner (TASK-1305): shells out to headless
// `codex exec` with a read-only sandbox. The full prompt travels by
// request file (Windows argv limit); argv is fully runner-constructed —
// there is no caller-extensible argument surface by design.
//
// run() NEVER rejects: every failure path resolves to a typed
// runner_error. Timeout kills the PROCESS TREE (taskkill /t /f on
// Windows — the house pattern in runtime-validator.ts / verify.ts /
// command-validator.ts; a single-PID kill orphans codex's children).

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReviewRequest, ReviewRunResult } from "./reviewer-types.js";
import type { ReviewerRunnerConfig } from "./reviewer-config.js";
import { buildCodexBootstrapPrompt, buildCodexRequestFileContent } from "./review-prompts.js";
import { auditFindingAnchors, extractReviewResult } from "./verdict-extract.js";
import {
  buildCodexProcessEnv,
  codexShellEnvironmentPolicyArgs,
} from "../llm/codex-process-security.js";

/** Spawn function shape used by this runner (subset of child_process.spawn). */
export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: ["ignore", "pipe", "pipe"] | "ignore";
    windowsHide?: boolean;
  },
) => ChildProcess;

let _spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn;

/**
 * Override the spawn function used internally. Primarily for testing.
 * @param fn - The replacement spawn function, or undefined to reset
 */
export function _setSpawnFn(fn: SpawnFn | undefined): void {
  _spawnFn = fn ?? (nodeSpawn as unknown as SpawnFn);
}

/** Cap for captured stderr diagnostics. */
const STDERR_TAIL_CHARS = 2000;

/**
 * Build the complete codex argv. Pure and exported so tests can assert the
 * EXACT vector: `--sandbox read-only` is always pinned and nothing is
 * caller-extensible (round-1 amendment: escalation closed by construction).
 */
export function buildCodexArgs(
  config: ReviewerRunnerConfig,
  requestFilePath: string,
  projectRoot: string,
  outputFilePath?: string,
): string[] {
  return [
    "exec",
    "--sandbox",
    config.codex.sandbox, // z.literal("read-only") — no other value representable
    ...(config.codex.profile ? ["-p", config.codex.profile] : []),
    ...(config.codex.provider ? ["-c", `model_provider="${config.codex.provider}"`] : []),
    ...codexShellEnvironmentPolicyArgs(),
    ...(config.model ? ["-m", config.model] : []),
    "--cd",
    projectRoot,
    ...(outputFilePath ? ["--output-last-message", outputFilePath] : []),
    buildCodexBootstrapPrompt(requestFilePath),
  ];
}

/** Kill a child's whole process tree (house pattern; see module header). */
function treeKill(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* best effort */
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      // Routed through the spawn seam so tests never launch a real taskkill;
      // in production _spawnFn IS node's spawn.
      _spawnFn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      /* fall through to plain kill */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a group leader — fall through */
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    /* best effort */
  }
}

/** Sanitize a string for use in a filename. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Post-run read-only assertion: report (never revert) a dirty tree after a
 * supposedly read-only review. Routed through the spawn seam so tests can
 * fake `git status` output. Resolves to undefined when the check itself
 * fails (e.g. projectRoot is not a git repo) — absence of evidence, not a flag.
 */
async function captureTreeStatus(
  projectRoot: string,
  timeoutMs: number,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string[] | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ChildProcess;
    try {
      child = _spawnFn("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      settle(undefined);
      return;
    }

    // Bounded: a hung `git status` (index lock contention) must never block
    // the runner's settle path after a successful review (round-2 finding 2).
    const guardTimer = setTimeout(() => {
      settle(undefined);
      try {
        child.kill();
      } catch {
        /* best effort */
      }
    }, timeoutMs);
    if (typeof guardTimer.unref === "function") guardTimer.unref();

    let out = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(guardTimer);
      settle(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(guardTimer);
      if (code !== 0) {
        settle(undefined);
        return;
      }
      settle(
        out
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0)
          .sort(),
      );
    });
  });
}

/**
 * QPI-050: only dirt that APPEARED during the review is the reviewer's.
 * The pipeline's own adapter-freshness sync dirties fresh worktrees at
 * birth (a drifted root adapter overwrites the branch-tracked copy), and
 * the old absolute post-review check blamed the reviewer for it — every
 * AMEND round in the 2026-08 azure window carried "review left the
 * project tree dirty" as a false second refusal reason. Exported for
 * direct testing.
 */
export function newTreeDirt(before: string[], after: string[]): string[] {
  const baseline = new Set(before);
  return after.filter((line) => !baseline.has(line));
}

/** Bound for the post-run tree check: never longer than the review budget. */
function treeCheckBudgetMs(timeoutMs: number): number {
  return Math.min(10_000, timeoutMs);
}

/**
 * Run an adversarial review via a headless codex subprocess.
 * Resolves to a ReviewRunResult on every path; never rejects.
 */
export async function runCodexCliReview(
  request: ReviewRequest,
  config: ReviewerRunnerConfig,
): Promise<ReviewRunResult> {
  const startedAt = Date.now();

  try {
    // Write the request file (prompt-by-file, not argv). The random suffix
    // kills same-ms collisions across concurrent worktrees sharing the logs
    // junction; the file is the durable audit link (`requestFile`).
    const reviewsDir = path.join(request.projectRoot, ".quack", "logs", "reviews");
    await fs.mkdir(reviewsDir, { recursive: true });
    const rand = Math.random().toString(36).slice(2, 8);
    const baseName = `${sanitizeForFilename(request.taskId)}-${request.kind}-${Date.now()}-${rand}`;
    const requestFile = path.join(reviewsDir, `${baseName}.md`);
    const outputFile = path.join(reviewsDir, `${baseName}.last.txt`);
    await fs.writeFile(requestFile, buildCodexRequestFileContent(request), "utf-8");
    // QPI-050 (review finding): pre-create the runner-owned output file so
    // it is part of the tree-status BASELINE — codex writes it DURING the
    // review via --output-last-message, and in a repo where .quack/logs
    // is unignored it would otherwise read as reviewer dirt, the exact
    // self-inflicted false positive this fix exists to kill.
    await fs.writeFile(outputFile, "", "utf-8");

    const args = buildCodexArgs(config, requestFile, request.projectRoot, outputFile);
    const env = buildCodexProcessEnv(config.codex);

    // QPI-050: baseline BEFORE the reviewer runs — pre-existing dirt
    // (e.g. the pipeline's own adapter sync) is never the reviewer's.
    const treeStatusBefore = await captureTreeStatus(
      request.projectRoot,
      treeCheckBudgetMs(config.timeoutMs),
    );

    const spawnResult = await new Promise<ReviewRunResult>((resolve) => {
      let settled = false;
      const settle = (result: ReviewRunResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = _spawnFn(config.codex.binaryPath, args, {
          cwd: request.projectRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err: unknown) {
        settle({
          status: "runner_error",
          errorKind: "spawn_failed",
          message: err instanceof Error ? err.message : String(err),
          runner: "codex-cli",
          durationMs: Date.now() - startedAt,
          requestFile,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_TAIL_CHARS * 4) {
          stderr = stderr.slice(-STDERR_TAIL_CHARS * 2);
        }
      });

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        treeKill(child);
        settle({
          status: "runner_error",
          errorKind: "timeout",
          message: `codex review exceeded ${config.timeoutMs}ms and its process tree was killed (pid ${child.pid ?? "unknown"})`,
          runner: "codex-cli",
          durationMs: Date.now() - startedAt,
          requestFile,
        });
      }, config.timeoutMs);
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeoutTimer);
        const isMissing = err.code === "ENOENT";
        settle({
          status: "runner_error",
          errorKind: isMissing ? "unavailable" : "spawn_failed",
          message: isMissing
            ? `codex binary not found at "${config.codex.binaryPath}" (is the Codex CLI installed on this host?)`
            : err.message,
          runner: "codex-cli",
          durationMs: Date.now() - startedAt,
          requestFile,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeoutTimer);
        if (timedOut) return; // timeout already settled

        // The entire post-exit body is guarded: ANY throw inside it must
        // settle a typed runner_error, never leave run() pending forever
        // (round-2 finding 1 — the hang-instead-of-error class).
        void (async () => {
          try {
            if (code !== 0) {
              settle({
                status: "runner_error",
                errorKind: "session_error",
                message: `codex exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
                runner: "codex-cli",
                durationMs: Date.now() - startedAt,
                ...(code !== null ? { exitCode: code } : {}),
                ...(signal ? { signal } : {}),
                ...(stderr.trim().length > 0
                  ? { stderrTail: stderr.slice(-STDERR_TAIL_CHARS) }
                  : {}),
                requestFile,
              });
              return;
            }

            // Primary output source: --output-last-message file; stdout fallback.
            let lastMessage = "";
            try {
              lastMessage = (await fs.readFile(outputFile, "utf-8")).trim();
            } catch {
              /* fall back to stdout */
            }
            const rawText = lastMessage.length > 0 ? lastMessage : stdout;

            const extracted = extractReviewResult(lastMessage) ?? extractReviewResult(stdout);
            if (!extracted) {
              settle({
                status: "runner_error",
                errorKind: "parse_failed",
                message: `codex completed but produced no valid verdict JSON (${rawText.length} chars of output)`,
                rawText,
                runner: "codex-cli",
                durationMs: Date.now() - startedAt,
                exitCode: 0,
                requestFile,
              });
              return;
            }

            // QPI-050: attribute only NEW dirt to the reviewer. Both
            // captures must succeed to make the claim; a failed capture
            // on either side is absence of evidence, not a flag.
            const treeStatusAfter = await captureTreeStatus(
              request.projectRoot,
              treeCheckBudgetMs(config.timeoutMs),
            );
            const treeDirty =
              treeStatusBefore !== undefined && treeStatusAfter !== undefined
                ? newTreeDirt(treeStatusBefore, treeStatusAfter).length > 0
                : undefined;
            const hasAnchors = extracted.findings.some((f) => (f.anchors?.length ?? 0) > 0);

            settle({
              status: "completed",
              verdict: extracted.verdict,
              findings: extracted.findings,
              ...(extracted.confidence !== undefined ? { confidence: extracted.confidence } : {}),
              summary: extracted.summary,
              rawText,
              runner: "codex-cli",
              ...(config.model ? { model: config.model } : {}),
              durationMs: Date.now() - startedAt,
              ...(hasAnchors
                ? {
                    anchorsAudit: auditFindingAnchors(extracted.findings, request.projectRoot),
                  }
                : {}),
              ...(treeDirty !== undefined ? { treeDirtyAfterReview: treeDirty } : {}),
              requestFile,
            });
          } catch (err: unknown) {
            settle({
              status: "runner_error",
              errorKind: "session_error",
              message: `post-exit processing failed: ${err instanceof Error ? err.message : String(err)}`,
              runner: "codex-cli",
              durationMs: Date.now() - startedAt,
              requestFile,
            });
          }
        })();
      });
    });

    return spawnResult;
  } catch (err: unknown) {
    // Catch-all: fs errors, unexpected states. Environment failure, never a
    // verdict and never a rejection.
    return {
      status: "runner_error",
      errorKind: "session_error",
      message: err instanceof Error ? err.message : String(err),
      runner: "codex-cli",
      durationMs: Date.now() - startedAt,
    };
  }
}
