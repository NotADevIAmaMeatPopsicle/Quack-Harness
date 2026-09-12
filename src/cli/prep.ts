// ─── Prep Command ──────────────────────────────────────────────────
// Runs gate checks (schema validation + depth evaluation) for a task
// and writes the result to .quack/prep/{taskId}.json. This is used by
// the monitor API to prep tasks on demand.

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { validateTaskSchema } from "../gate/schema-validator.js";
import { evaluateTaskDepth } from "../gate/depth-evaluator.js";
import { PrepCache, computeContentHash } from "../monitor/prep-cache.js";
import { ReadinessService } from "../monitor/readiness-service.js";

export interface PrepOptions {
  project?: string;
}

export async function prepCommand(taskId: string, options: PrepOptions): Promise<void> {
  const projectRoot = path.resolve(options.project ?? process.cwd());

  try {
    // Load adapter
    const adapter = await loadAdapter(projectRoot);

    // Find and parse task file
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
    const resolved = await resolveTaskFile(taskDir, taskId);
    if (!resolved?.task) {
      throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
    }

    const { content, task } = resolved;
    const contentHash = computeContentHash(content);

    // Schema validation (fast, deterministic)
    const schemaResult = validateTaskSchema(task);

    let depthScore = 0;
    let depthReady = false;
    let deficiencies: string[] = [];
    let outcome: "pass" | "enriched" | "rejected" = "rejected";

    if (!schemaResult.valid) {
      // Schema failed — mark as rejected
      outcome = "rejected";
    } else {
      // Depth evaluation (slow, LLM-based)
      const depthEvaluator = adapter.config.evaluationProviders?.readinessDepth;
      const depthResult = await evaluateTaskDepth(task, adapter.conventionsDoc, {
        model: depthEvaluator?.model,
        evaluator: depthEvaluator,
        projectRoot: adapter.projectRoot,
        apiKeys: adapter.config.agent.apiKeys,
      });
      depthScore = depthResult.overallScore;
      depthReady = depthResult.ready;
      deficiencies = depthResult.deficiencies;
      outcome = depthResult.ready ? "pass" : "rejected";
    }

    // Write result to cache
    const cache = new PrepCache(projectRoot);
    await cache.write({
      taskId,
      preparedAt: new Date().toISOString(),
      schemaValid: schemaResult.valid,
      schemaErrors: schemaResult.missing,
      depthScore,
      depthReady,
      deficiencies,
      outcome,
      contentHash,
    });

    const readiness = new ReadinessService({
      projectRoot,
    });
    try {
      readiness.persistPrepResult(taskId, content, {
        taskId,
        preparedAt: new Date().toISOString(),
        schemaValid: schemaResult.valid,
        schemaErrors: schemaResult.missing,
        depthScore,
        depthReady,
        deficiencies,
        outcome,
        contentHash,
      });
    } finally {
      readiness.close();
    }

    // Output JSON result for parent process to parse
    const result = {
      schemaValid: schemaResult.valid,
      schemaErrors: schemaResult.missing,
      depthScore,
      depthReady,
      deficiencies,
      outcome,
      contentHash,
    };

    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: msg }));
    process.exit(1);
  }
}
