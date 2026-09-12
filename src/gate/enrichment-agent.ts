import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
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

export type GroundingToolName = "Read" | "Grep" | "Glob";

export interface GroundingToolUse {
  name: GroundingToolName;
  input: Record<string, unknown>;
}

export type GroundingWarning =
  | "concrete_claims_without_grounded_by_footer"
  | "grounding_evidence_without_observed_tool_use"
  | "grounding_evidence_not_observed"
  | "unsupported_concrete_claims";

export interface EnrichmentGroundingObservation {
  hasGroundedByFooter: boolean;
  concreteClaims: string[];
  observedTools: GroundingToolUse[];
  footerEvidence: string[];
  unsupportedEvidence: string[];
  unsupportedClaims: string[];
  warnings: GroundingWarning[];
}

export interface EnrichmentOptions {
  model?: string;
  maxTurns?: number;
  /** Structured, informational grounding result. It never vetoes enrichment. */
  onGroundingObservation?: (observation: EnrichmentGroundingObservation) => void;
  /** Warning sink, injectable for callers/tests. Defaults to console.warn. */
  warn?: (message: string) => void;
}

interface GroundingEvidence {
  name: GroundingToolName;
  detail: string;
  line: string;
}

const GROUNDING_TOOL_NAMES = new Set<GroundingToolName>(["Read", "Grep", "Glob"]);

function isGroundingToolName(value: string): value is GroundingToolName {
  return GROUNDING_TOOL_NAMES.has(value as GroundingToolName);
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/[`'"]/g, "").replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase();
}

function sectionRange(content: string, heading: string): { start: number; end: number } | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*$`, "im").exec(content);
  if (!match || match.index === undefined) return null;
  const remainderStart = match.index + match[0].length;
  const nextHeading = /^##\s+/m.exec(content.slice(remainderStart));
  return {
    start: match.index,
    end: nextHeading?.index === undefined ? content.length : remainderStart + nextHeading.index,
  };
}

function parseGroundingEvidence(content: string): {
  hasFooter: boolean;
  bodyWithoutFooter: string;
  evidence: GroundingEvidence[];
} {
  const range = sectionRange(content, "Grounded By");
  if (!range) {
    return { hasFooter: false, bodyWithoutFooter: content, evidence: [] };
  }

  const footer = content.slice(range.start, range.end);
  const evidence: GroundingEvidence[] = [];
  for (const line of footer.split(/\r?\n/)) {
    const match = /^\s*-\s*(Read|Grep|Glob)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const canonicalName = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}`;
    if (!isGroundingToolName(canonicalName)) continue;
    evidence.push({ name: canonicalName, detail: match[2], line: line.trim() });
  }

  return {
    hasFooter: true,
    bodyWithoutFooter: `${content.slice(0, range.start)}${content.slice(range.end)}`,
    evidence,
  };
}

function isConcreteTechnicalClaim(value: string): boolean {
  const claim = value.trim();
  if (claim.length < 3 || claim.length > 180) return false;
  if (/^(?:TASK|ADR)-\d+(?:-[A-Z0-9]+)*$/i.test(claim)) return false;

  const looksLikePath =
    /(?:^|[./\\])[^\s]+\.[a-z0-9*{}-]{1,12}$/i.test(claim) ||
    /^(?:\.\.?[/\\]|@[^/\\]+[/\\])/.test(claim);
  const looksLikeSignature = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^\r\n]*\)$/.test(claim);
  const looksLikeEnvironmentVariable = /^[A-Z][A-Z0-9_]{2,}$/.test(claim);
  const looksLikeSchemaIdentifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(claim);
  const looksLikeMigration = /^\d{8,}[-_][A-Za-z0-9_.-]+$/.test(claim);
  return (
    looksLikePath ||
    looksLikeSignature ||
    looksLikeEnvironmentVariable ||
    looksLikeSchemaIdentifier ||
    looksLikeMigration
  );
}

function extractConcreteClaims(originalContent: string, enrichedBody: string): string[] {
  const original = normalizeEvidenceText(originalContent);
  const claims: string[] = [];
  const seen = new Set<string>();
  const isOperatorConfirmation = (index: number): boolean => {
    const lineStart = enrichedBody.lastIndexOf("\n", index) + 1;
    const nextBreak = enrichedBody.indexOf("\n", index);
    const lineEnd = nextBreak === -1 ? enrichedBody.length : nextBreak;
    return /needs operator confirmation/i.test(enrichedBody.slice(lineStart, lineEnd));
  };

  for (const match of enrichedBody.matchAll(/`([^`\r\n]+)`/g)) {
    const claim = match[1].trim();
    const normalized = normalizeEvidenceText(claim);
    if (
      isOperatorConfirmation(match.index ?? 0) ||
      !isConcreteTechnicalClaim(claim) ||
      original.includes(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    claims.push(claim);
  }

  // Migration IDs are frequently written as plain prose rather than code.
  for (const match of enrichedBody.matchAll(/\b(\d{12,}[-_][A-Za-z0-9_.-]+)\b/g)) {
    const claim = match[1];
    const normalized = normalizeEvidenceText(claim);
    if (
      isOperatorConfirmation(match.index ?? 0) ||
      original.includes(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    claims.push(claim);
  }

  return claims;
}

function stringInputs(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, normalizeEvidenceText(value)]),
  );
}

function pathMatchesEvidence(pathValue: string, detail: string): boolean {
  if (!pathValue) return false;
  if (detail.includes(pathValue)) return true;
  const pathSegments = pathValue.split("/").filter(Boolean);
  for (let start = 0; start < pathSegments.length; start++) {
    const suffix = pathSegments.slice(start).join("/");
    if (suffix.includes("/") && detail.includes(suffix)) return true;
  }
  return false;
}

function evidenceWasObserved(
  evidence: GroundingEvidence,
  observedTools: readonly GroundingToolUse[],
): boolean {
  const detail = normalizeEvidenceText(evidence.detail);
  return observedTools.some((tool) => {
    if (tool.name !== evidence.name) return false;
    const input = stringInputs(tool.input);
    if (tool.name === "Read") {
      return pathMatchesEvidence(input.file_path ?? input.path ?? "", detail);
    }
    if (tool.name === "Glob") {
      const pattern = input.pattern ?? input.glob ?? "";
      return Boolean(pattern) && detail.includes(pattern);
    }

    const pattern = input.pattern ?? input.query ?? "";
    if (!pattern || !detail.includes(pattern)) return false;
    const searchPath = input.path ?? "";
    return !searchPath || pathMatchesEvidence(searchPath, detail);
  });
}

/**
 * Produce claim-level, non-blocking grounding observability. This deliberately
 * does not try to prove the whole spec correct: it only recognizes narrow,
 * concrete claim shapes and checks that footer rows correspond to real SDK
 * Read/Grep/Glob calls. Warnings are review signals, never gate vetoes.
 */
export function analyzeEnrichmentGrounding(
  originalContent: string,
  enrichedContent: string,
  observedTools: readonly GroundingToolUse[],
): EnrichmentGroundingObservation {
  const parsed = parseGroundingEvidence(enrichedContent);
  const concreteClaims = extractConcreteClaims(originalContent, parsed.bodyWithoutFooter);
  const verifiedEvidence = parsed.evidence.filter((entry) =>
    evidenceWasObserved(entry, observedTools),
  );
  const unsupportedEvidence = parsed.evidence
    .filter((entry) => !evidenceWasObserved(entry, observedTools))
    .map((entry) => entry.line);
  const unsupportedClaims = concreteClaims.filter((claim) => {
    const normalizedClaim = normalizeEvidenceText(claim);
    return !verifiedEvidence.some((entry) =>
      normalizeEvidenceText(entry.detail).includes(normalizedClaim),
    );
  });
  const warnings: GroundingWarning[] = [];

  if (concreteClaims.length > 0 && !parsed.hasFooter) {
    warnings.push("concrete_claims_without_grounded_by_footer");
  }
  if (parsed.evidence.length > 0 && observedTools.length === 0) {
    warnings.push("grounding_evidence_without_observed_tool_use");
  }
  if (unsupportedEvidence.length > 0) {
    warnings.push("grounding_evidence_not_observed");
  }
  if (unsupportedClaims.length > 0) {
    warnings.push("unsupported_concrete_claims");
  }

  return {
    hasGroundedByFooter: parsed.hasFooter,
    concreteClaims,
    observedTools: [...observedTools],
    footerEvidence: parsed.evidence.map((entry) => entry.line),
    unsupportedEvidence,
    unsupportedClaims,
    warnings,
  };
}

function groundingWarningMessage(
  taskId: string,
  observation: EnrichmentGroundingObservation,
): string {
  const unsupported =
    observation.unsupportedClaims.length > 0
      ? observation.unsupportedClaims.map((claim) => `\`${claim}\``).join(", ")
      : "none identified";
  return (
    `[TASK-923] Enrichment grounding observation for ${taskId}: ` +
    `${observation.warnings.join(", ")}; unsupported concrete claims: ${unsupported}. ` +
    "Informational only; enrichment was not blocked."
  );
}

function collectGroundingToolUses(message: SDKMessage): GroundingToolUse[] {
  if (message.type !== "assistant") return [];
  const assistant = message as {
    message?: {
      content?:
        | Array<{
            type?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>
        | string;
    };
  };
  if (!Array.isArray(assistant.message?.content)) return [];

  const uses: GroundingToolUse[] = [];
  for (const block of assistant.message.content) {
    if (
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      isGroundingToolName(block.name)
    ) {
      uses.push({ name: block.name, input: block.input ?? {} });
    }
  }
  return uses;
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
  options?: EnrichmentOptions,
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
  const groundingToolUses: GroundingToolUse[] = [];

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
      groundingToolUses.push(...collectGroundingToolUses(message));

      if (message.type === "result") {
        if (message.subtype === "success") {
          const result = (message as unknown as SDKSuccessResult).result;
          const grounding = analyzeEnrichmentGrounding(task.rawContent, result, groundingToolUses);
          options?.onGroundingObservation?.(grounding);
          if (grounding.warnings.length > 0) {
            const warn = options?.warn ?? ((warning: string) => console.warn(warning));
            warn(groundingWarningMessage(task.id, grounding));
          }
          return result;
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
