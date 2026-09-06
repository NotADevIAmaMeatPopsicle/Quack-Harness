import { ProjectAdapter } from "../core/adapter-loader.js";
import { buildPlannerPrompt } from "./planner-prompt.js";
import { writeTaskFilesWithResult } from "./task-writer.js";
import { resolveModel } from "../dispatcher/model-router.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";

/**
 * Minimal SDK result message shape used for type narrowing.
 * Defined locally to avoid ESM/CJS import issues with the SDK package.
 */
interface SDKSuccessResult {
  type: "result";
  subtype: "success";
  result: string;
}

/**
 * Minimal SDK message shape for the async generator.
 * Defined locally to avoid ESM/CJS import issues with the SDK package.
 */
interface SDKMessage {
  type: string;
  subtype?: string;
}

/**
 * Type for the SDK query function, defined locally to avoid importing
 * ESM-only SDK types from a CommonJS module context.
 */
type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 * Populated on first call via dynamic import() since the SDK is ESM-only.
 */
let _queryFn: QueryFn | undefined;

/**
 * Dynamically imports the Claude Agent SDK's query function.
 * Required because the SDK is an ES module and this project uses CommonJS.
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
 * Result of the planner agent execution.
 */
export interface PlannerResult {
  taskIds: string[];
  specs: string[];
  filePaths: string[];
}

/**
 * Options for the planner agent.
 */
export interface PlannerOptions {
  model?: string;
  maxTurns?: number;
  maxTasks?: number;
  dryRun?: boolean;
  startId?: number;
}

/**
 * Runs the planner agent to generate task specifications from a raw prompt.
 *
 * The planner is a read-only LLM agent that:
 * 1. Researches the target project (ADRs, architecture docs, conventions, existing code)
 * 2. Decomposes the prompt into 1-N discrete work units
 * 3. Generates valid TASK-NNN.md files with all required fields
 * 4. Validates each spec through schema validation
 * 5. Writes the task files to the project's taskDir (unless dryRun=true)
 *
 * @param prompt - Raw user prompt describing the feature/task to implement
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional configuration (model, maxTurns, maxTasks, dryRun, startId)
 * @returns PlannerResult with generated task IDs and spec content
 * @throws Error if the SDK call fails or returns no result
 */
export async function planTasks(
  prompt: string,
  adapter: ProjectAdapter,
  options?: PlannerOptions,
): Promise<PlannerResult> {
  const plannerPromptText = await buildPlannerPrompt(
    prompt,
    adapter,
    options?.maxTasks,
    options?.startId,
  );

  // Suggest template match during planning
  try {
    const { loadRegistry } = await import("../templates/template-registry.js");
    const { categorizeTask } = await import("../templates/task-categorizer.js");

    // Parse the prompt into a minimal task structure for categorization
    const mockTask = {
      tags: [],
      filesToModify: [],
      problemStatement: prompt,
      id: "",
      title: "",
      priority: "P2-MEDIUM" as const,
      effort: "",
      status: "BACKLOG" as const,
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      blockedBy: [],
      blocks: [],
      conventions: [],
      currentState: "",
      recommendedApproach: "",
      successCriteria: [],
      testingRequirements: [],
      contextReferences: [],
      rawContent: "",
    };

    const category = categorizeTask(mockTask);

    const registry = await loadRegistry(adapter.projectRoot);
    const categoryStats = registry.categoryStats[category];

    if (categoryStats && categoryStats.count > 0) {
      console.log(`[TEMPLATE HINT] Similar tasks in category "${category}"`);
      console.log(
        `  Success rate: ${(categoryStats.avgSuccessRate * 100).toFixed(0)}% | Avg cost: $${categoryStats.avgCostUsd.toFixed(2)}`,
      );
    }
  } catch {
    // Template matching is optional
  }

  const model =
    options?.model ??
    resolveModel(adapter.config.modelRouting, adapter.config.agent, { stage: "plan" });
  const maxTurns = options?.maxTurns ?? 25;

  const queryFn = await getQueryFn();

  const messages: Array<{ type: string; subtype?: string; [key: string]: unknown }> = [];

  const queryResult = queryFn({
    prompt: plannerPromptText,
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
      ...getSdkPermissionOptions(),
      model,
      maxTurns,
      cwd: adapter.projectRoot,
    },
  });

  for await (const message of queryResult) {
    messages.push({ ...message } as { type: string; subtype?: string; [key: string]: unknown });

    if (message.type === "result") {
      if (message.subtype === "success") {
        const result = (message as SDKSuccessResult).result;

        // Parse the result to extract task specs
        const allSpecs = parseTaskSpecs(result);

        // Enforce maxTasks limit — the LLM may return more than requested
        const maxTaskLimit = options?.maxTasks ?? 10;
        const taskSpecs = allSpecs.slice(0, maxTaskLimit);

        // Write task files (unless dry-run)
        if (options?.dryRun) {
          return {
            taskIds: taskSpecs.map((spec) => spec.id),
            specs: taskSpecs.map((spec) => spec.content),
            filePaths: [],
          };
        }

        const writeResult = await writeTaskFilesWithResult(taskSpecs, adapter);
        return {
          taskIds: writeResult.taskIds,
          specs: taskSpecs.map((spec) => spec.content),
          filePaths: writeResult.filePaths,
        };
      }

      // Handle SDK error results explicitly
      const errMsg = message as unknown as {
        subtype: string;
        errors?: string[];
        total_cost_usd?: number;
        num_turns?: number;
        stop_reason?: string | null;
      };
      throw new Error(
        `Planner agent SDK error: ${errMsg.subtype}\n` +
          `Errors: ${JSON.stringify(errMsg.errors ?? [])}\n` +
          `Stop reason: ${errMsg.stop_reason ?? "none"}\n` +
          `Cost: $${errMsg.total_cost_usd ?? 0}, Turns: ${errMsg.num_turns ?? 0}`,
      );
    }
  }

  // Build diagnostic summary
  const messageLog = messages
    .map((m, i) => {
      const summary: Record<string, unknown> = { type: m.type, subtype: m.subtype };
      if (m.type === "result") {
        summary.result = typeof m.result === "string" ? m.result.slice(0, 500) : m.result;
        summary.error = m.error;
        summary.total_cost_usd = m.total_cost_usd;
        summary.num_turns = m.num_turns;
      }
      return `  [${i}] ${JSON.stringify(summary)}`;
    })
    .join("\n");

  throw new Error(
    `Planner agent returned no success result.\n` +
      `Model: ${model}, maxTurns: ${maxTurns}\n` +
      `Messages received (${messages.length}):\n${messageLog || "  (none)"}\n` +
      `Prompt length: ${plannerPromptText.length} chars`,
  );
}

/**
 * Parsed task spec structure.
 */
interface ParsedTaskSpec {
  id: string;
  content: string;
}

/**
 * Parse task specifications from the planner agent result.
 * The agent returns task specs in markdown code blocks.
 */
function parseTaskSpecs(result: string): ParsedTaskSpec[] {
  const specs: ParsedTaskSpec[] = [];

  // Extract all markdown code blocks that contain task specs
  // Pattern: ```markdown\n# TASK-NNN: ... ```
  const codeBlockPattern = /```(?:markdown)?\s*\n(# TASK-\d+:[\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(result)) !== null) {
    const content = match[1].trim();
    // Extract task ID from the H1 heading
    const idMatch = content.match(/^# (TASK-\d+):/);
    if (idMatch) {
      specs.push({
        id: idMatch[1],
        content,
      });
    }
  }

  // If no code blocks found, try parsing the entire result as a single spec
  if (specs.length === 0) {
    const idMatch = result.match(/^# (TASK-\d+):/m);
    if (idMatch) {
      specs.push({
        id: idMatch[1],
        content: result.trim(),
      });
    }
  }

  return specs;
}
