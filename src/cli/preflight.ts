// ─── Preflight Command ─────────────────────────────────────────────
// Runs the full pre-flight pipeline (gate + blueprint + context
// estimate + complexity evaluation) and prints the report.

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile, listDuplicateClaimants } from "../core/task-file-resolver.js";
import { runPreflight } from "../preflight/preflight-runner.js";
import { computeSchemaPolicyHash } from "../gate/schema-policy.js";
import { computeContentHash } from "../monitor/prep-cache.js";
import { EventWriter, type IEventWriter } from "../monitor/event-emitter.js";
import { FULL_PREFLIGHT_OUTPUT_LIMIT, preflightJobIdSchema, preflightHashSchema } from "../monitor/preflight-job-result.js";
import { formatDuplicateClaimantsMessage } from "../core/duplicate-claimants.js";

export interface PreflightCommandOptions {
  project?: string;
  json?: boolean;
  force?: boolean;
  mode?: "auto" | "deterministic";
  /** Supervisor-owned correlation and input fence. Not general CLI switches. */
  jobId?: string;
  projectId?: string;
  expectedContentHash?: string;
  expectedSchemaPolicyHash?: string;
  expectedReadinessMode?: "off" | "shadow" | "enforce";
}

async function writeJson(stream: NodeJS.WriteStream, value: unknown, limit?: number): Promise<void> {
  const text = JSON.stringify(value) + "\n";
  if (limit && Buffer.byteLength(text) > limit) throw new Error("Preflight output exceeds its bounded result size");
  // POSIX pipes are asynchronous: process.exit must follow the write callback.
  await new Promise<void>((resolve, reject) => stream.write(text, (error) => error ? reject(error) : resolve()));
}

class PreflightCommandFailure extends Error {
  constructor(readonly errorType: string, message: string, readonly claimants?: string[]) { super(message); }
}

export async function preflightCommand(
  taskId: string,
  options: PreflightCommandOptions,
): Promise<void> {
  const projectRoot = path.resolve(options.project ?? process.cwd());

  try {
    if (options.mode !== undefined && options.mode !== "auto" && options.mode !== "deterministic") {
      throw new PreflightCommandFailure("PREFLIGHT_INVALID_MODE", "Mode must be auto or deterministic");
    }
    if (options.jobId) {
      preflightJobIdSchema.parse(options.jobId);
      preflightHashSchema.parse(options.expectedContentHash);
      preflightHashSchema.parse(options.expectedSchemaPolicyHash);
      if (!options.json || !options.projectId || !["off", "shadow", "enforce"].includes(options.expectedReadinessMode ?? "")) {
        throw new PreflightCommandFailure("PREFLIGHT_INVALID_JOB_ARGUMENTS", "Job output requires JSON and complete input identity");
      }
    } else if (options.expectedContentHash || options.expectedSchemaPolicyHash || options.expectedReadinessMode || options.projectId) {
      throw new PreflightCommandFailure("PREFLIGHT_INVALID_JOB_ARGUMENTS", "Input identity switches require a job id");
    }
    const adapter = await loadAdapter(projectRoot);

    // Find and parse task file
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
    const resolved = await resolveTaskFile(taskDir, taskId);
    if (!resolved?.task) {
      throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
    }

    const { task } = resolved;

    let events: IEventWriter | undefined;
    if (options.jobId) {
      const claimants = await listDuplicateClaimants(taskDir, taskId);
      if (claimants.length > 1) {
        throw new PreflightCommandFailure("duplicate_claimants",
          formatDuplicateClaimantsMessage(taskId, claimants), claimants);
      }
      if (computeContentHash(task.rawContent) !== options.expectedContentHash ||
        computeSchemaPolicyHash(adapter.config.gate?.requiredSections) !== options.expectedSchemaPolicyHash ||
        (adapter.config.judgment?.stages.readiness.mode ?? "off") !== options.expectedReadinessMode) {
        throw new PreflightCommandFailure("PREFLIGHT_INPUT_CHANGED", "Task or readiness policy changed after preflight was accepted");
      }
      const writer = new EventWriter({ sessionId: "preflight", taskId,
        project: options.projectId!, logDir: path.resolve(projectRoot, adapter.config.logging.dir) });
      events = { sessionId: writer.sessionId, taskId, project: writer.project,
        emit: (stage, payload) => writer.emit(stage, { ...payload, jobId: options.jobId }),
        recordSession: (status, extra) => writer.recordSession(status, extra) };
    }

    const result = await runPreflight(task, adapter, {
      force: options.force, mode: options.mode, ...(events ? { events } : {}),
    });

    const refusal = result.decomposition?.refused;
    if (refusal?.errorType === "duplicate_claimants") {
      const message = formatDuplicateClaimantsMessage(taskId, refusal.claimants);
      if (options.jobId) {
        throw new PreflightCommandFailure("duplicate_claimants", message, refusal.claimants);
      }
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
      await writeJson(process.stdout, options.jobId ? { jobId: options.jobId, result } : result,
        options.jobId ? FULL_PREFLIGHT_OUTPUT_LIMIT : undefined);
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
    if (options.jobId) {
      await writeJson(process.stderr, { jobId: options.jobId,
        errorType: error instanceof PreflightCommandFailure ? error.errorType : "PREFLIGHT_CHILD_FAILED",
        message: msg, ...(error instanceof PreflightCommandFailure && error.claimants ? { claimants: error.claimants } : {}) });
    } else if (options.json) {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}
