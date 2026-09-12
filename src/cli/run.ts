// ─── CLI: quack run ──────────────────────────────────────────────────
// Execute a single task through the full dispatch pipeline,
// or preview with --dry-run.

import * as fsSync from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { dispatchTask } from "../dispatcher/dispatcher.js";
import { assembleContext } from "../dispatcher/context-assembler.js";
import { runReadinessGate } from "../gate/gate.js";
import { validateTaskSchema } from "../gate/schema-validator.js";
import type { DispatchResult, GateResult, TaskContext } from "../core/types.js";
import { withDecompositionAdmissionFence } from "../preflight/decomposition-transaction-journal.js";
import { consumeDecompositionDispatchAdmission } from "../preflight/decomposition-dispatch-admission.js";

import * as fs from "node:fs/promises";

// ─── Formatting helpers ───────────────────────────────────────────

function formatGateResult(gateResult: GateResult): string {
  const lines: string[] = [];

  if (gateResult.outcome === "pass") {
    lines.push("  Gate: PASS");
  } else if (gateResult.outcome === "enriched") {
    lines.push("  Gate: ENRICHED (needs approval)");
    lines.push(`  Diff: ${gateResult.task.diff}`);
  } else {
    lines.push(`  Gate: REJECTED — ${gateResult.reason}`);
    if ("missing" in gateResult.details) {
      lines.push(`  Missing fields: ${gateResult.details.missing.join(", ")}`);
    }
    if ("deficiencies" in gateResult.details) {
      lines.push(`  Deficiencies: ${gateResult.details.deficiencies.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function formatContext(context: TaskContext): string {
  const lines: string[] = [];
  lines.push("  Context assembled:");
  lines.push(`    Conventions: ${Object.keys(context.conventions).length} loaded`);
  lines.push(`    Relevant files: ${context.relevantFiles.length}`);
  lines.push(`    Related patterns: ${context.relatedPatterns.length}`);
  lines.push(`    Existing tests: ${context.existingTests.length}`);
  lines.push(`    CLAUDE.md files: ${context.claudeMd.length}`);
  return lines.join("\n");
}

function formatDispatchResult(result: DispatchResult): string {
  const lines: string[] = [];

  switch (result.outcome) {
    case "approved":
      lines.push(`Task ${result.taskId}: APPROVED`);
      if (result.prUrl) {
        lines.push(`  PR: ${result.prUrl}`);
      }
      if (result.branchName) {
        lines.push(`  Branch: ${result.branchName}`);
      }
      if (result.agentResult) {
        lines.push(`  Turns used: ${result.agentResult.turnsUsed}`);
        lines.push(`  Cost: $${result.agentResult.totalCostUsd.toFixed(2)}`);
        lines.push(`  Files modified: ${result.agentResult.filesModified.join(", ") || "none"}`);
        lines.push(`  Files created: ${result.agentResult.filesCreated.join(", ") || "none"}`);
      }
      if (result.judgeResult) {
        lines.push(
          `  Judge: ${result.judgeResult.verdict} (confidence: ${Math.round(result.judgeResult.confidence * 100)}%)`,
        );
      }
      if (result.retriesUsed > 0) {
        lines.push(`  Retries used: ${result.retriesUsed}`);
      }
      break;

    case "rejected":
      lines.push(`Task ${result.taskId}: REJECTED`);
      lines.push(`  Reason: ${result.error ?? "Unknown"}`);
      if (result.judgeResult) {
        lines.push(`  Judge verdict: ${result.judgeResult.verdict}`);
        lines.push(`  Feedback: ${result.judgeResult.feedback}`);
      }
      break;

    case "spec_changed":
      // TASK-1332 (QPI-045, round-3 R3-5): without an explicit case this
      // fell through to an empty line, so the CLI user got a bare
      // non-zero exit and none of the recovery advice.
      return [
        `⛔ ${result.taskId}: REFUSED, not failed — the spec changed under this run`,
        result.error ? `   ${result.error}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "gate_failed":
      lines.push(`Task ${result.taskId}: GATE FAILED`);
      lines.push(`  Reason: ${result.error ?? "Unknown"}`);
      if (result.gateResult) {
        lines.push(formatGateResult(result.gateResult));
      }
      break;

    case "no_changes":
      lines.push(`Task ${result.taskId}: NO CHANGES`);
      lines.push("  Agent completed but produced no committed changes.");
      if (result.agentResult) {
        lines.push(`  Turns used: ${result.agentResult.turnsUsed}`);
        lines.push(`  Cost: $${result.agentResult.totalCostUsd.toFixed(2)}`);
      }
      if (result.branchName) {
        lines.push(`  Branch preserved: ${result.branchName}`);
      }
      break;

    case "agent_failed":
      lines.push(`Task ${result.taskId}: AGENT FAILED`);
      lines.push(`  Reason: ${result.error ?? "Unknown"}`);
      if (result.agentResult) {
        lines.push(`  Outcome: ${result.agentResult.outcome}`);
        lines.push(`  Turns used: ${result.agentResult.turnsUsed}`);
      }
      break;

    case "error":
      lines.push(`Task ${result.taskId}: ERROR`);
      lines.push(`  ${result.error ?? "Unknown error"}`);
      break;
  }

  return lines.join("\n");
}

// ─── Dry-run handler ──────────────────────────────────────────────

async function runDryRun(
  taskId: string,
  projectPath: string,
  skipGate = false,
  skipDepthOnly = false,
): Promise<void> {
  console.log(`\nDry run for ${taskId}\n${"=".repeat(40)}\n`);

  // Load adapter
  const adapter = await loadAdapter(projectPath);
  console.log(`Project: ${adapter.config.project.name}`);
  console.log(`Root: ${adapter.projectRoot}\n`);

  // Find and parse task file
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const resolved = await resolveTaskFile(taskDir, taskId);
  if (!resolved?.task) {
    throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
  }

  const { task } = resolved;

  console.log(`Task: ${task.id} — ${task.title}`);
  console.log(`Priority: ${task.priority}`);
  console.log(`Effort: ${task.effort}`);
  console.log(`Status: ${task.status}`);
  if (task.blockedBy.length > 0) {
    console.log(`Blocked by: ${task.blockedBy.join(", ")}`);
  }
  console.log();

  // Run gate (without enrichment to keep dry-run non-destructive)
  if (skipGate) {
    console.log("Readiness Gate: SKIPPED (--skip-gate)");
    const schemaResult = validateTaskSchema(task);
    if (schemaResult.missing.length > 0) {
      console.log(`  Schema missing: ${schemaResult.missing.join(", ")}`);
    }
    if (schemaResult.warnings.length > 0) {
      console.log(`  Schema warnings: ${schemaResult.warnings.join(", ")}`);
    }
    if (schemaResult.missing.length === 0 && schemaResult.warnings.length === 0) {
      console.log("  Schema: PASS (no errors or warnings)");
    }
  } else {
    console.log("Readiness Gate:");
    const gateResult = await runReadinessGate(
      task,
      adapter,
      skipDepthOnly ? { skipDepthOnly: true } : { skipEnrichment: true },
    );
    if (skipDepthOnly) {
      console.log("  Mode: SKIP DEPTH ONLY (--skip-depth-only)");
    }
    console.log(formatGateResult(gateResult));
  }
  console.log();

  // Assemble context
  console.log("Context Assembly:");
  const context = await assembleContext(task, adapter);
  console.log(formatContext(context));
  console.log();

  // Show files that would be modified
  if (task.filesToModify.length > 0) {
    console.log("Files to modify:");
    for (const file of task.filesToModify) {
      console.log(`  [${file.action}] ${file.path}${file.notes ? ` — ${file.notes}` : ""}`);
    }
    console.log();
  }

  // Show success criteria
  if (task.successCriteria.length > 0) {
    console.log("Success Criteria:");
    for (const criterion of task.successCriteria) {
      console.log(`  - ${criterion}`);
    }
    console.log();
  }

  console.log("Dry run complete. No changes were made.");
}

// ─── SDK unhandled rejection guard ─────────────────────────────────
// The Claude Agent SDK has a bug where handleControlRequest() is called
// without `await` in its readMessages() loop. When the transport closes
// after a session ends, the catch block in handleControlRequest tries
// to write an error response to the already-closed transport — and that
// second write has no try-catch around it, creating an unhandled
// promise rejection that crashes the Node.js process.
//
// This is benign: the session already completed, the result was consumed,
// and the agent's work is intact. We catch it here to prevent the
// dispatch process from crashing before the judge can run.
//
// SDK source: sdk.mjs handleControlRequest() catch block calls
// this.transport.write() without nested try-catch. Filed as known issue.

/**
 * Report a fatal error SYNCHRONOUSLY, then exit.
 *
 * ─── QPI-043, and the root of a whole family of silent deaths ───────
 *
 * The previous guard did `console.error(...)` then `process.exit(1)`.
 * That loses the message. `DispatchManager` spawns this child with
 * `stdio: ["ignore", "pipe", "pipe"]`, and when stderr is a PIPE rather
 * than a TTY, Node buffers writes ASYNCHRONOUSLY. `process.exit()` does
 * not drain that buffer: it terminates immediately and the queued bytes
 * are discarded before the parent ever reads them.
 *
 * So the child died with an exit code, an empty stderr capture, no
 * session_error in the event log, and a clean worktree. From every
 * surface an operator can see, it vanished for no reason. That is
 * exactly the TASK-1273 round-2 shape, and it is the same family as
 * QPI-037 (a failed prep recorded as completed) and QPI-041 (a healthy
 * pause reported as failure): a child can stop without any surface
 * carrying why.
 *
 * Two changes make the reason survive:
 *
 * 1. `fs.writeSync(2, ...)` instead of `console.error`. Synchronous,
 *    unbuffered, and complete before the next line runs, so it cannot be
 *    truncated by the exit that follows.
 * 2. The full stack, not just `.message`. A message alone rarely names
 *    the stage; the stack does, and this is the one moment where nobody
 *    gets a second chance to ask.
 */
function reportFatalSync(label: string, reason: unknown): void {
  const detail =
    reason instanceof Error
      ? (reason.stack ?? `${reason.name}: ${reason.message}`)
      : String(reason);
  const text = `[fatal] ${label} at ${new Date().toISOString()}\n${detail}\n`;
  try {
    // fd 2 directly: synchronous even when stderr is a pipe.
    fsSync.writeSync(2, text);
  } catch {
    // Nothing left to try. Never let the reporter mask the report.
  }
}

function installSdkRejectionGuard(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (
      msg.includes("ProcessTransport is not ready for writing") ||
      msg.includes("Cannot write to terminated process")
    ) {
      console.error(`[sdk-cleanup] Suppressed SDK transport race condition: ${msg}`);
      return;
    }
    reportFatalSync("unhandled rejection", reason);
    process.exit(1);
  });

  // An uncaught exception had NO handler at all, so it died on Node's
  // default path: a stack to stderr through the same async pipe, lost
  // the same way. Same treatment, and it must be registered here rather
  // than relying on the default.
  process.on("uncaughtException", (err: Error) => {
    reportFatalSync("uncaught exception", err);
    process.exit(1);
  });
}

// ─── Main run handler ──────────────────────────────────────────────

export async function runCommand(
  taskId: string,
  options: {
    dryRun?: boolean;
    skipGate?: boolean;
    skipDepthOnly?: boolean;
    project?: string;
    model?: string;
    maxTurns?: number;
    maxBudget?: number;
    outputFormat?: string;
    resume?: boolean;
    forceClean?: boolean;
    overridePausedRun?: boolean;
  },
): Promise<void> {
  installSdkRejectionGuard();
  const projectPath = options.project ?? process.cwd();

  try {
    if (options.dryRun) {
      await runDryRun(
        taskId,
        projectPath,
        options.skipGate ?? false,
        options.skipDepthOnly ?? false,
      );
      process.exit(0);
      return;
    }

    // Full dispatch
    console.log(`\nDispatching ${taskId}...\n`);

    const adapter = await loadAdapter(projectPath);
    // Monitor-spawned children receive the exact spec hash captured while the
    // writable owner held the decomposition reservation. Docker mounts are
    // intentionally read-only, so they validate that snapshot without trying
    // to create a lock inside /workspace. Standalone CLI runs capture the same
    // snapshot locally before the dispatcher reads the task.
    let admittedTaskContentHash = await consumeDecompositionDispatchAdmission(adapter, taskId);
    const managedDecompositionAdmission = admittedTaskContentHash !== undefined;
    if (!admittedTaskContentHash) {
      const admission = await withDecompositionAdmissionFence(adapter, taskId, (value) => value);
      admittedTaskContentHash = admission.contentHash;
    }

    // Apply CLI overrides to adapter config (capped to adapter limits)
    if (options.model) adapter.config.agent.model = options.model;
    if (options.maxTurns) {
      if (options.maxTurns > adapter.config.agent.maxTurns) {
        console.log(
          `Warning: --max-turns ${options.maxTurns} exceeds adapter limit ${adapter.config.agent.maxTurns}, capping`,
        );
        // Don't override — keep adapter limit
      } else {
        adapter.config.agent.maxTurns = options.maxTurns;
      }
    }
    if (options.maxBudget) {
      if (options.maxBudget > adapter.config.agent.maxBudgetPerTask) {
        console.log(
          `Warning: --max-budget $${options.maxBudget} exceeds adapter limit $${adapter.config.agent.maxBudgetPerTask}, capping`,
        );
        // Don't override — keep adapter limit
      } else {
        adapter.config.agent.maxBudgetPerTask = options.maxBudget;
      }
    }

    console.log(`Project: ${adapter.config.project.name}`);
    console.log(`Root: ${adapter.projectRoot}\n`);

    // Build the onEvent callback for stream-json output
    const streamJson = options.outputFormat === "stream-json";
    const onEvent = streamJson
      ? (stage: string, payload: Record<string, unknown>) => {
          const line = JSON.stringify({
            type: stage,
            timestamp: new Date().toISOString(),
            ...payload,
          });
          process.stdout.write(line + "\n");
        }
      : undefined;

    // Read retry feedback from env var if present (set by force-retry dispatch)
    let retryFeedback: string | undefined;
    if (process.env.QUACK_RETRY_FEEDBACK) {
      try {
        retryFeedback = (await fs.readFile(process.env.QUACK_RETRY_FEEDBACK, "utf-8")).trim();
        if (retryFeedback) {
          console.log("Injecting judge feedback from previous attempt\n");
        }
      } catch {
        // Feedback file missing — proceed without it
      }
    }

    const result = await dispatchTask(taskId, adapter, {
      skipGate: options.skipGate,
      skipDepthOnly: options.skipDepthOnly,
      onEvent,
      resumeFromCheckpoint: options.resume,
      retryFeedback,
      forceClean: options.forceClean,
      overridePausedRun: options.overridePausedRun,
      admittedTaskContentHash,
      managedDecompositionAdmission,
    });

    // QPI-043: the final result must be written SYNCHRONOUSLY. On POSIX,
    // stdout-to-a-pipe is asynchronous and process.exit() discards the
    // unflushed buffer, so `console.log` here loses the entire result
    // block — which is how an awaiting_approval exit read as a silent
    // failure. (On Windows pipe writes are synchronous, which is why the
    // earlier executed check on the laptop "refuted" this loss: it was
    // run on the one platform where the loss cannot happen.) Same
    // mechanism and remedy as reportFatalSync above, on the normal path.
    try {
      fsSync.writeSync(1, formatDispatchResult(result) + "\n\n");
    } catch {
      // A failed final print must never mask the outcome itself.
    }

    if (result.outcome === "approved") {
      process.exit(0);
    } else if (result.outcome === "rejected") {
      process.exit(2);
    } else {
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
