// ─── Spec Repair Agent ──────────────────────────────────────────────
// Attempts to fix incomplete task specs by filling in missing required
// sections. Uses a read-only agent session similar to the enrichment
// agent, but works from raw markdown content (since the spec failed
// to parse into a ParsedTask).

import { buildSpecRepairPrompt } from "./spec-repair-prompt.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";

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
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

/** Default model for spec repair — Haiku is fast and cheap for structural repair */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Attempts to repair a task spec that failed to parse.
 *
 * Runs a read-only agent session that reads the raw markdown, understands
 * the parse error, and fills in the missing required sections.
 *
 * @param rawContent - The raw markdown content of the task file
 * @param filePath - Path to the task file
 * @param parseError - The parse error message
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional configuration (model, maxTurns overrides)
 * @returns The repaired markdown content
 * @throws Error if the SDK call fails or returns no result
 */
export async function repairTaskSpec(
  rawContent: string,
  filePath: string,
  parseError: string,
  adapter: ProjectAdapter,
  options?: { model?: string; maxTurns?: number },
): Promise<string> {
  const prompt = buildSpecRepairPrompt(rawContent, filePath, parseError, adapter.conventionsDoc);

  const model = options?.model ?? DEFAULT_MODEL;
  const maxTurns = options?.maxTurns ?? 10;

  const queryFn = await getQueryFn();

  const queryResult = queryFn({
    prompt,
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
    if (message.type === "result") {
      if (message.subtype === "success") {
        return (message as SDKSuccessResult).result;
      }

      const errMsg = message as unknown as {
        subtype: string;
        errors?: string[];
        total_cost_usd?: number;
        num_turns?: number;
      };
      throw new Error(
        `Spec repair agent SDK error: ${errMsg.subtype}\n` +
          `Errors: ${JSON.stringify(errMsg.errors ?? [])}\n` +
          `Cost: $${errMsg.total_cost_usd ?? 0}, Turns: ${errMsg.num_turns ?? 0}`,
      );
    }
  }

  throw new Error(
    `Spec repair agent returned no success result.\n` + `Model: ${model}, maxTurns: ${maxTurns}`,
  );
}
