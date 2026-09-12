import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
// ─── Task Decomposer ────────────────────────────────────────────────
// Main decomposition engine that breaks complex tasks into focused subtasks.
// Uses file clustering + LLM assistance to generate executable topology plans.
// Returns DecompositionTopology (subtasks + coverage report) — side-effect free.

import type { ParsedTask, FileModification } from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { Blueprint } from "../blueprint/blueprint-types.js";
import type { SubtaskDefinition, DecompositionTopology } from "./decompose-types.js";
import {
  buildDecompositionCoverageReport,
  computeDecompositionParentHash,
} from "./decomposition-plan-integrity.js";
export {
  buildDecompositionCoverageReport,
  computeDecompositionParentHash,
} from "./decomposition-plan-integrity.js";
import { buildDecomposePrompt } from "./decompose-prompt.js";
import { resolveModel } from "../dispatcher/model-router.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { runCodexStructuredEvaluation } from "../llm/codex-structured-evaluator.js";
import {
  buildTaskDecompositionOutputSchema,
  parseTaskDecompositionOutput,
  validateTaskDecompositionValue,
} from "./decomposition-provider-contract.js";
import { resolveEffectiveDecompositionMaxSubtasks } from "./decomposition-limits.js";

/**
 * Minimal SDK result message shape used for type narrowing.
 */
interface SDKSuccessResult {
  type: "result";
  subtype: "success";
  result: string;
}

/**
 * Minimal SDK message shape for the async generator.
 */
interface SDKMessage {
  type: string;
  subtype?: string;
}

/**
 * Type for the SDK query function.
 */
type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 */
let _queryFn: QueryFn | undefined;

/**
 * Dynamically imports the Claude Agent SDK's query function.
 */
async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 * @param fn - The replacement query function, or undefined to reset
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

/**
 * File cluster with associated files and criteria.
 */
interface FileCluster {
  title: string;
  files: FileModification[];
  criteria: string[];
  dependencies: string[]; // file paths this cluster depends on
}

/**
 * Decompose a complex task into 2..effectiveMax focused subtasks.
 * effectiveMax is the lower of the request/default and the adapter-owned
 * maxSubtasks ceiling (schema range 2-6, default 4).
 * Uses file clustering based on blueprint integration points, then
 * falls back to LLM-based decomposition if needed.
 * Returns a DecompositionTopology with coverage report — no side effects.
 *
 * @param task - The parent task to decompose
 * @param adapter - Project adapter with config
 * @param blueprint - Blueprint with file analyses and integration points
 * @param options - Optional configuration
 * @returns DecompositionTopology with ordered subtask definitions and coverage report
 */
export async function decomposeTask(
  task: ParsedTask,
  adapter: ProjectAdapter,
  blueprint: Blueprint,
  options?: { maxSubtasks?: number; preferConfiguredProvider?: boolean },
): Promise<DecompositionTopology> {
  const maxSubtasks = resolveEffectiveDecompositionMaxSubtasks(
    options?.maxSubtasks,
    adapter.config.preflight?.autoDecompose?.maxSubtasks,
  );
  const hasConfiguredProvider = Boolean(adapter.config.evaluationProviders?.taskDecomposition);

  // Try file clustering first (deterministic approach)
  const clusters = clusterFilesByDependencies(task, blueprint);

  let subtasks: SubtaskDefinition[];
  if (
    !(options?.preferConfiguredProvider && hasConfiguredProvider) &&
    clusters.length >= 2 &&
    clusters.length <= maxSubtasks
  ) {
    // File clustering worked — convert to subtasks
    subtasks = clustersToSubtasks(task.id, clusters, task.successCriteria).slice(0, maxSubtasks);
  } else {
    // Fall back to LLM-based decomposition
    const plan = await llmDecomposeTask(task, adapter, blueprint, maxSubtasks);
    subtasks = plan.subtasks;
  }

  const coverageReport = buildDecompositionCoverageReport(task, subtasks);
  return {
    parentTaskId: task.id,
    parentContentHash: computeDecompositionParentHash(task.rawContent),
    maxSubtasks,
    subtasks,
    coverageReport,
  };
}

/**
 * Cluster files by their dependencies using blueprint integration points.
 * Files that reference each other go into the same cluster.
 * Standalone files get their own clusters.
 *
 * @param task - Parent task with files to cluster
 * @param blueprint - Blueprint with file analyses
 * @returns Array of file clusters
 */
function clusterFilesByDependencies(task: ParsedTask, blueprint: Blueprint): FileCluster[] {
  const clusters: FileCluster[] = [];
  const assignedFiles = new Set<string>();

  // Build dependency map from blueprint
  const depMap = buildDependencyMap(blueprint);

  // First pass: group tightly coupled files (A depends on B, B depends on A)
  for (const file of task.filesToModify) {
    if (assignedFiles.has(file.path)) continue;

    const deps = depMap.get(file.path) ?? [];
    const relatedFiles = [file];
    assignedFiles.add(file.path);

    // Find files that depend on this file or that this file depends on
    for (const otherFile of task.filesToModify) {
      if (assignedFiles.has(otherFile.path)) continue;
      const otherDeps = depMap.get(otherFile.path) ?? [];

      // Check if they reference each other
      if (deps.includes(otherFile.path) || otherDeps.includes(file.path)) {
        relatedFiles.push(otherFile);
        assignedFiles.add(otherFile.path);
      }
    }

    // Map criteria to this cluster
    const clusterFiles = relatedFiles.map((f) => f.path);
    const criteria = mapCriteriaToCluster(task.successCriteria, clusterFiles);

    if (relatedFiles.length > 0) {
      clusters.push({
        title: deriveClusterTitle(relatedFiles),
        files: relatedFiles,
        criteria,
        dependencies: deps,
      });
    }
  }

  // Order clusters by dependencies (standalone first, integration last)
  return orderClustersByDependency(clusters);
}

/**
 * Build a dependency map from blueprint file analyses.
 * Maps file path → array of file paths it depends on.
 */
function buildDependencyMap(blueprint: Blueprint): Map<string, string[]> {
  const depMap = new Map<string, string[]>();

  for (const analysis of blueprint.fileAnalyses) {
    const deps: string[] = [];

    // Parse integration points for file references
    const fileRefRegex = /(?:^|\s)((?:src|tests?)\/[^\s:]+\.ts)/gi;
    let match;
    while ((match = fileRefRegex.exec(analysis.integrationPoints)) !== null) {
      const referencedFile = match[1];
      if (referencedFile !== analysis.filePath) {
        deps.push(referencedFile);
      }
    }

    if (deps.length > 0) {
      depMap.set(analysis.filePath, deps);
    }
  }

  return depMap;
}

/**
 * Map success criteria to a file cluster.
 * A criterion belongs to a cluster if it mentions any of the cluster's files.
 */
function mapCriteriaToCluster(criteria: string[], clusterFiles: string[]): string[] {
  const mapped: string[] = [];

  for (const criterion of criteria) {
    for (const file of clusterFiles) {
      const fileName = file.split("/").pop()?.replace(/\.ts$/, "");
      if (fileName && criterion.toLowerCase().includes(fileName.toLowerCase())) {
        mapped.push(criterion);
        break;
      }
    }
  }

  // If no criteria matched, assign generic criteria evenly
  if (mapped.length === 0 && criteria.length > 0) {
    mapped.push(criteria[0]);
  }

  return mapped;
}

/**
 * Derive a title for a file cluster based on its files.
 */
function deriveClusterTitle(files: FileModification[]): string {
  if (files.length === 1) {
    const fileName = files[0].path.split("/").pop()?.replace(/\.ts$/, "") ?? "file";
    return `Implement ${fileName}`;
  }

  const paths = files.map((f) => f.path);
  const commonPath = paths.reduce((prefix, p) => {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) {
      i++;
    }
    return prefix.slice(0, i);
  });

  const dir = commonPath.split("/").filter(Boolean).pop() ?? "module";
  return `Implement ${dir} module`;
}

/**
 * Order clusters by dependency — standalone clusters first, then those that depend on them.
 */
function orderClustersByDependency(clusters: FileCluster[]): FileCluster[] {
  const ordered: FileCluster[] = [];
  const remaining = [...clusters];
  const clusteredFiles = new Set(
    clusters.flatMap((cluster) => cluster.files.map((file) => file.path)),
  );

  while (remaining.length > 0) {
    const ready = remaining.filter((cluster) => {
      const orderedFiles = new Set(ordered.flatMap((c) => c.files.map((f) => f.path)));
      const ownFiles = new Set(cluster.files.map((file) => file.path));
      return cluster.dependencies.every(
        (dep) => ownFiles.has(dep) || orderedFiles.has(dep) || !clusteredFiles.has(dep),
      );
    });

    if (ready.length === 0) {
      ordered.push(...remaining);
      break;
    }

    for (const cluster of ready) {
      ordered.push(cluster);
      remaining.splice(remaining.indexOf(cluster), 1);
    }
  }

  return ordered;
}

/**
 * Convert file clusters to subtask definitions.
 */
function clustersToSubtasks(
  parentId: string,
  clusters: FileCluster[],
  parentCriteria: string[],
): SubtaskDefinition[] {
  const claimedCriteria = new Set(clusters.flatMap((cluster) => cluster.criteria));
  const unclaimedCriteria = parentCriteria.filter((criterion) => !claimedCriteria.has(criterion));
  const assignedCriteria = new Set<string>();
  return clusters.map((cluster, idx) => {
    const letter = String.fromCharCode(65 + idx); // A, B, C...
    const id = `${parentId}-${letter}`;
    const dependsOn = idx > 0 ? [`${parentId}-${String.fromCharCode(65 + idx - 1)}`] : [];
    const isFinal = idx === clusters.length - 1;
    const ownedCriteria = cluster.criteria.filter((criterion) => {
      if (assignedCriteria.has(criterion)) return false;
      assignedCriteria.add(criterion);
      return true;
    });

    return {
      id,
      title: cluster.title,
      filesToModify: cluster.files,
      successCriteria: isFinal
        ? [
            ...new Set([
              ...ownedCriteria,
              ...unclaimedCriteria,
              "All parent task success criteria verified",
            ]),
          ]
        : ownedCriteria,
      dependsOn,
      isFinal,
    };
  });
}

/**
 * Use LLM to plan topology when file clustering isn't sufficient.
 * Returns a SubtaskPlan (topology only — no prose content).
 */
async function llmDecomposeTask(
  task: ParsedTask,
  adapter: ProjectAdapter,
  blueprint: Blueprint,
  maxSubtasks: number,
): Promise<{ subtasks: SubtaskDefinition[] }> {
  const prompt = buildDecomposePrompt(task, blueprint, maxSubtasks);
  const evaluator = adapter.config.evaluationProviders?.taskDecomposition;
  const model =
    evaluator?.model ??
    resolveModel(adapter.config.modelRouting, adapter.config.agent, {
      stage: "plan",
    });
  const maxTurns = 15;

  if (evaluator?.runner === "codex-cli") {
    const result = await runCodexStructuredEvaluation(
      {
        projectRoot: adapter.projectRoot,
        model,
        systemPrompt:
          "Plan only the requested child-task topology. Inspect the repository read-only and return the required JSON object; do not modify files.",
        prompt,
        outputSchema: buildTaskDecompositionOutputSchema(maxSubtasks),
        parse: (rawText) => parseTaskDecompositionOutput(rawText, task.id, maxSubtasks),
      },
      evaluator,
    );
    if (result.status === "runner_error") {
      throw new Error(`Codex task decomposition ${result.errorKind}: ${result.message}`);
    }
    const validated = validateTaskDecompositionValue(result.value, task.id, maxSubtasks);
    if (!validated) {
      throw new Error(
        "Codex task decomposition parse_failed: evaluator returned an invalid or conflicting child topology",
      );
    }
    return validated;
  }

  const queryFn = await getQueryFn();

  const queryResult = queryFn({
    prompt,
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
      ...getSdkPermissionOptions(),
      env: getClaudeSdkEnvironment(adapter.config.agent.apiKeys),
      model,
      maxTurns,
      cwd: adapter.projectRoot,
    },
  });

  // Decomposer uses read-only tools (maxTurns: 15) — 5 min timeout
  const DECOMPOSE_TIMEOUT_MS = 300_000;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Task decomposition timed out after ${DECOMPOSE_TIMEOUT_MS / 1000}s`)),
      DECOMPOSE_TIMEOUT_MS,
    );
    timer.unref();
  });

  const iterateGenerator = async (): Promise<{ subtasks: SubtaskDefinition[] }> => {
    for await (const message of queryResult) {
      if (message.type === "result" && message.subtype === "success") {
        const result = (message as SDKSuccessResult).result;
        return parseTopologyResult(result, task.id, maxSubtasks);
      }
    }

    throw new Error(
      `Decomposition agent returned no success result.\n` +
        `Task: ${task.id}, Model: ${model}, maxTurns: ${maxTurns}`,
    );
  };

  return Promise.race([iterateGenerator(), timeoutPromise]);
}

/**
 * Parse the LLM result to extract topology JSON.
 */
function parseTopologyResult(
  result: string,
  parentId: string,
  maxSubtasks: number,
): { subtasks: SubtaskDefinition[] } {
  let jsonText = result;

  // Strategy 1: extract from code fence
  const codeFenceMatch = result.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1];
  }

  // Strategy 2: balanced brace walking
  if (!jsonText.trim().startsWith("{")) {
    const start = result.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < result.length; i++) {
        if (result[i] === "{") depth++;
        else if (result[i] === "}") {
          depth--;
          if (depth === 0) {
            jsonText = result.slice(start, i + 1);
            break;
          }
        }
      }
    }
  }

  try {
    const parsed: unknown = JSON.parse(jsonText);
    const validated = validateTaskDecompositionValue(parsed, parentId, maxSubtasks);
    if (!validated) {
      throw new Error("Response JSON failed the task decomposition contract");
    }
    return validated;
  } catch (err) {
    throw new Error(
      `Failed to parse topology result as JSON for ${parentId}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Result: ${result.slice(0, 500)}`,
    );
  }
}
