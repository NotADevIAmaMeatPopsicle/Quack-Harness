import { ParsedTask } from "../core/types.js";
import { ProjectAdapter } from "../core/adapter-loader.js";
import { buildEnrichmentPrompt } from "./enrichment-prompt.js";
import { extractPatterns } from "./pattern-extractor.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";

/**
 * Strip LLM scaffolding from an enrichment response and return the spec body
 * starting at the first `# TASK-` heading. The enrichment LLM frequently
 * prefixes its output with prose like:
 *
 *   "Now I have all the information needed. Let me write the complete
 *    enriched task spec:\n\n---\n\n# TASK-NNN-X: ..."
 *
 * That prose must NOT be persisted to the spec file — the parser fails on
 * it and the file becomes unreadable.
 *
 * Returns null if the content has no `# TASK-` heading at all (caller should
 * treat that as "unparseable enrichment, do NOT clobber the existing spec").
 *
 * Exported so the HTTP handler can call it before writing the spec file.
 */
export function extractSpecBody(content: string): string | null {
  if (!content) return null;
  const match = content.match(/^# TASK-/m);
  if (!match || match.index === undefined) return null;
  return content.slice(match.index);
}

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

/** Default model for enrichment -- Sonnet is cost-effective for enrichment tasks */
const DEFAULT_MODEL = "claude-sonnet-4-6";
/** Default enrichment timeout: 20 minutes */
export const ENRICHMENT_TIMEOUT_MS = 1_200_000;
/** Default enrichment turn budget */
const DEFAULT_MAX_TURNS = 35;
/** Maximum focused files provided to the enrichment prompt */
const MAX_FOCUSED_FILES = 10;

function extractTableFilePaths(rawContent: string, sectionName: string): string[] {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionMatch = rawContent.match(
    new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  if (!sectionMatch) return [];

  const sectionText = sectionMatch[1];
  const files: string[] = [];
  for (const line of sectionText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|\s*-+/.test(trimmed)) continue;

    const cells = trimmed
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    if (cells.length === 0) continue;
    const filePath = cells[0].replace(/`/g, "").trim();
    if (!filePath || /^file$/i.test(filePath)) continue;
    files.push(filePath);
  }
  return files;
}

function buildFocusedFilePaths(task: ParsedTask): string[] {
  // Include ALL filesToModify paths regardless of action.
  // Reference entries are intentionally included: the enrichment LLM needs
  // their file content for pattern context, even though the agent won't modify them.
  const fromModify = task.filesToModify.map((f) => f.path.trim()).filter((p) => p.length > 0);
  const fromCreateSection = extractTableFilePaths(task.rawContent, "Files to Create");
  const fromModifySection = extractTableFilePaths(task.rawContent, "Files to Modify");

  const seen = new Set<string>();
  const ordered = [...fromModify, ...fromCreateSection, ...fromModifySection];
  const deduped: string[] = [];
  for (const filePath of ordered) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    deduped.push(filePath);
    if (deduped.length >= MAX_FOCUSED_FILES) break;
  }
  return deduped;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Enriches a task specification by running a read-only agent session
 * that scans the codebase and produces a more detailed task spec.
 *
 * This is Layer 3 of the Task Readiness Gate (auto-enrichment).
 * The agent has READ-ONLY access to the codebase -- it cannot modify anything.
 * It reads the code, understands the current state, and produces a better
 * task specification addressing the deficiencies found during depth evaluation.
 *
 * @param task - The parsed task to enrich
 * @param deficiencies - Specific deficiencies found during depth evaluation
 * @param suggestions - Enrichment suggestions from the depth evaluator
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional configuration (model, maxTurns overrides)
 * @returns The enriched task spec as a string
 * @throws Error if the SDK call fails or returns no result
 */
export async function enrichTask(
  task: ParsedTask,
  deficiencies: string[],
  suggestions: string[],
  adapter: ProjectAdapter,
  options?: { model?: string; maxTurns?: number },
): Promise<string> {
  // Pre-extract codebase patterns deterministically (no LLM, <2s)
  const extractedPatterns = await extractPatterns(task, adapter.projectRoot);
  const focusedFilePaths = buildFocusedFilePaths(task);

  const prompt = buildEnrichmentPrompt(task, deficiencies, suggestions, adapter.conventionsDoc, {
    extractedPatterns,
    adrDocs: adapter.adrDocs,
    focusedFilePaths,
  });

  const model = options?.model ?? adapter.config.agent.enrichModel ?? DEFAULT_MODEL;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;

  const queryFn = await getQueryFn();

  const messages: Array<{ type: string; subtype?: string; [key: string]: unknown }> = [];

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

  const deadline = Date.now() + ENRICHMENT_TIMEOUT_MS;
  const timeoutMessage = `Enrichment agent timed out after ${Math.floor(ENRICHMENT_TIMEOUT_MS / 1000)}s`;

  try {
    let done = false;
    while (!done) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(timeoutMessage);
      }

      const next = await withTimeout(queryResult.next(), remainingMs, timeoutMessage);
      if (next.done) {
        done = true;
        continue;
      }
      const message = next.value;
      messages.push({ ...message } as { type: string; subtype?: string; [key: string]: unknown });

      if (message.type === "result") {
        if (message.subtype === "success") {
          return (message as SDKSuccessResult).result;
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
          `Enrichment agent SDK error: ${errMsg.subtype}\n` +
            `Errors: ${JSON.stringify(errMsg.errors ?? [])}\n` +
            `Stop reason: ${errMsg.stop_reason ?? "none"}\n` +
            `Cost: $${errMsg.total_cost_usd ?? 0}, Turns: ${errMsg.num_turns ?? 0}`,
        );
      }
    }
  } catch (err) {
    try {
      await queryResult.return(undefined);
    } catch {
      // Best effort -- timeout/error already captured
    }
    throw err;
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
    `Enrichment agent returned no success result.\n` +
      `Model: ${model}, maxTurns: ${maxTurns}\n` +
      `Messages received (${messages.length}):\n${messageLog || "  (none)"}\n` +
      `Prompt length: ${prompt.length} chars`,
  );
}
