// ─── CLI: quack revise ──────────────────────────────────────────────
// Re-dispatch a task with revision feedback from human or PR comments.
// Skips gate (spec hasn't changed), injects feedback, uses lower budget defaults.

import * as path from "node:path";
import { loadAdapter } from "../core/adapter-loader.js";
import { assertUncontestedClaimant } from "../core/duplicate-claimants.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";
import { dispatchTask } from "../dispatcher/dispatcher.js";
import {
  prepareRevisionState,
  resolveRevisionRuntimeContext,
  resolveRevisionTask,
} from "../dispatcher/revision-preparation.js";
import type { DispatchResult } from "../core/types.js";
import { EventReader } from "../monitor/event-reader.js";
import { withDecompositionAdmissionFence } from "../preflight/decomposition-transaction-journal.js";
import { runTrustedGitHubResult } from "../worker/trusted-executable.js";

function formatDispatchResult(result: DispatchResult): string {
  const lines: string[] = [];

  switch (result.outcome) {
    case "approved":
      lines.push(`Task ${result.taskId}: APPROVED (revision)`);
      if (result.prUrl) {
        lines.push(`  PR: ${result.prUrl}`);
      }
      if (result.branchName) {
        lines.push(`  Branch: ${result.branchName}`);
      }
      if (result.agentResult) {
        lines.push(`  Turns used: ${result.agentResult.turnsUsed}`);
        lines.push(`  Cost: $${result.agentResult.totalCostUsd.toFixed(2)}`);
      }
      if (result.judgeResult) {
        lines.push(`  Judge: ${result.judgeResult.verdict}`);
      }
      break;

    case "rejected":
      lines.push(`Task ${result.taskId}: REJECTED (revision)`);
      lines.push(`  Reason: ${result.error ?? "Unknown"}`);
      if (result.judgeResult) {
        lines.push(`  Judge verdict: ${result.judgeResult.verdict}`);
        lines.push(`  Judge feedback: ${result.judgeResult.feedback}`);
      }
      break;

    default:
      lines.push(`Task ${result.taskId}: ${result.outcome.toUpperCase()}`);
      if (result.error) {
        lines.push(`  Error: ${result.error}`);
      }
  }

  return lines.join("\n");
}

export async function reviseCommand(
  taskId: string,
  options: {
    feedback?: string;
    fromPr?: number;
    maxBudget?: number;
    maxTurns?: number;
    project?: string;
  },
): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  try {
    let adapter = await loadAdapter(projectPath);

    let feedback = options.feedback ?? "";

    // Extract PR comments if --from-pr provided
    if (options.fromPr) {
      try {
        // Get PR reviews and comments via gh CLI
        const prNumber = options.fromPr;
        const reviewResult = await runTrustedGitHubResult(
          adapter.projectRoot,
          ["pr", "view", String(prNumber), "--json", "reviews,comments"],
          {
            timeoutMs: 60_000,
            maxBuffer: 1024 * 1024,
            trustedBoundaryRoot: adapter.projectRoot,
          },
        );
        if (reviewResult.exitCode !== 0) {
          throw new Error(
            reviewResult.stderr.trim() ||
              reviewResult.stdout.trim() ||
              "GitHub pull-request feedback is unavailable",
          );
        }
        const prData = JSON.parse(reviewResult.stdout) as {
          reviews?: { body: string }[];
          comments?: { path: string; line: number; body: string }[];
        };

        feedback += `\n\n## PR Feedback (PR #${prNumber})\n\n`;

        // Add file-specific comments
        if (prData.comments && prData.comments.length > 0) {
          feedback += "### File-Specific Comments\n";
          for (const comment of prData.comments) {
            feedback += `- \`${comment.path}:${comment.line}\` — ${comment.body}\n`;
          }
          feedback += "\n";
        }

        // Add overall reviews
        if (prData.reviews && prData.reviews.length > 0) {
          feedback += "### Overall Reviews\n";
          for (const review of prData.reviews) {
            feedback += `${review.body}\n\n`;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Failed to extract PR comments: ${msg}`);
        console.error("Continuing with manual feedback only...\n");
      }
    }

    if (!feedback.trim()) {
      console.error("Error: No feedback provided. Use --feedback or --from-pr");
      process.exit(1);
      return;
    }

    // The CLI deliberately stays independent of the monitor. It resolves the
    // same reusable worktree and durable log state the HTTP route would use,
    // then the shared helper owns every revision-specific disk mutation.
    const configuredLogDir = path.resolve(
      adapter.projectRoot,
      adapter.config.logging?.dir ?? ".quack/logs",
    );
    const runtime = resolveRevisionRuntimeContext(adapter.projectRoot, taskId, configuredLogDir);
    if (runtime.projectRoot !== adapter.projectRoot) {
      adapter = await loadAdapter(runtime.projectRoot);
    }

    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
    const resolvedTask = await resolveRevisionTask(taskDir, taskId);
    assertUncontestedClaimant({
      taskId,
      claimants: await listDuplicateClaimants(taskDir, taskId),
    });

    const reader = new EventReader(runtime.logDir);
    const revision = await prepareRevisionState({
      taskId,
      resolvedTask,
      adapterExecutionMode: adapter.config.executionMode ?? "dispatch",
      runtimeLogDir: runtime.logDir,
      sessions: reader.getExecutionSessions(),
      getSessionEvents: (sessionId) => reader.getSessionEvents(sessionId),
      humanFeedback: feedback,
    });

    // Get revision defaults from adapter config
    const revisionConfig = adapter.config.revision;
    const maxBudget = options.maxBudget ?? revisionConfig?.maxBudget ?? 2.0;
    const maxTurns = options.maxTurns ?? revisionConfig?.maxTurns ?? 50;

    console.log(`\nRevising ${taskId}...\n`);
    console.log(`Project: ${adapter.config.project.name}`);
    console.log(`Root: ${adapter.projectRoot}`);
    console.log(`Max budget: $${maxBudget}`);
    console.log(`Max turns: ${maxTurns}\n`);

    // Override adapter limits with revision limits
    adapter.config.agent.maxBudgetPerTask = maxBudget;
    adapter.config.agent.maxTurns = maxTurns;

    const admission = await withDecompositionAdmissionFence(
      adapter,
      taskId,
      (snapshot) => snapshot,
    );
    const result = await dispatchTask(taskId, adapter, {
      skipGate: true,
      retryFeedback: revision.mergedFeedback,
      resumeFromCheckpoint: revision.resuming,
      admittedTaskContentHash: admission.contentHash,
    });

    console.log(formatDispatchResult(result));
    console.log();

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
