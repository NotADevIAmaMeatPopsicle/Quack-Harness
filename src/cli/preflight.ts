// ─── Preflight Command ─────────────────────────────────────────────
// Runs the full pre-flight pipeline (gate + blueprint + context
// estimate + complexity evaluation) and prints the report.

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { runPreflight } from "../preflight/preflight-runner.js";
import { formatDuplicateClaimantsMessage } from "../core/duplicate-claimants.js";

export interface PreflightCommandOptions {
  project?: string;
  json?: boolean;
  force?: boolean;
}

export async function preflightCommand(
  taskId: string,
  options: PreflightCommandOptions,
): Promise<void> {
  const projectRoot = path.resolve(options.project ?? process.cwd());

  try {
    const adapter = await loadAdapter(projectRoot);

    // Find and parse task file
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
    const resolved = await resolveTaskFile(taskDir, taskId);
    if (!resolved?.task) {
      throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
    }

    const { task } = resolved;

    // Run pre-flight pipeline
    const result = await runPreflight(task, adapter, {
      force: options.force,
    });

    const refusal = result.decomposition?.refused;
    if (refusal?.errorType === "duplicate_claimants") {
      const message = formatDuplicateClaimantsMessage(taskId, refusal.claimants);
      if (options.json) {
        console.error(
          JSON.stringify({
            error: "duplicate_claimants",
            taskId,
            claimants: refusal.claimants,
            message,
          }),
        );
      } else {
        console.error(message);
      }
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Human-readable output
      console.log(`\n── Pre-Flight Report: ${taskId} ──\n`);

      // Gate
      console.log(`Gate: ${result.gate.ready ? "PASS" : "FAIL"} (score: ${result.gate.score})`);
      if (Object.keys(result.gate.dimensions).length > 0) {
        for (const [dim, score] of Object.entries(result.gate.dimensions)) {
          console.log(`  ${dim}: ${score}`);
        }
      }

      // Blueprint
      console.log(`\nBlueprint:`);
      console.log(`  File analyses: ${result.blueprint.fileAnalyses}`);
      console.log(`  Code examples: ${result.blueprint.codeExamples}`);
      console.log(`  Verification patterns: ${result.blueprint.verificationPatterns}`);
      console.log(`  Anti-patterns: ${result.blueprint.antiPatterns}`);

      // Context estimate
      console.log(`\nContext Estimate (tokens):`);
      console.log(`  Task spec: ${result.contextEstimate.taskSpec}`);
      console.log(`  Blueprint: ${result.contextEstimate.blueprint}`);
      console.log(`  Repo map: ${result.contextEstimate.repoMap}`);
      console.log(`  Relevant files: ${result.contextEstimate.relevantFiles}`);
      console.log(`  Related patterns: ${result.contextEstimate.relatedPatterns}`);
      console.log(`  Existing tests: ${result.contextEstimate.existingTests}`);
      console.log(`  Conventions: ${result.contextEstimate.conventions}`);
      console.log(`  CLAUDE.md: ${result.contextEstimate.claudeMd}`);
      console.log(`  Total: ${result.contextEstimate.total}`);
      console.log(`  Within budget: ${result.contextEstimate.withinBudget}`);

      // Complexity
      console.log(`\nComplexity:`);
      console.log(`  Files to modify: ${result.complexity.filesToModify}`);
      console.log(`  Success criteria: ${result.complexity.successCriteria}`);
      console.log(`  Est. context tokens: ${result.complexity.estimatedContextTokens}`);
      console.log(`  Recommend decomposition: ${result.complexity.recommendDecomposition}`);
      console.log(`  Reason: ${result.complexity.reason}`);

      console.log(`\nCached at: ${result.timestamp}`);
      console.log(`Content hash: ${result.contentHash.slice(0, 12)}...`);
    }

    process.exit(0);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}
