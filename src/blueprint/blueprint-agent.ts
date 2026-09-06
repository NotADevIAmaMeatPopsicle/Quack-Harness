// ─── Blueprint Agent Runner ────────────────────────────────────────
// Runs a read-only agent session that analyzes the codebase and produces
// a structured Blueprint with code-level implementation details.
//
// This runs BEFORE the coding agent dispatches, reducing exploration time
// by pre-digesting integration points, patterns, and before/after examples.

import { execFileSync } from "node:child_process";
import type { ParsedTask } from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { Blueprint, BriefBaseValidation, BriefHandBackItem } from "./blueprint-types.js";
import { buildBlueprintPrompt } from "./blueprint-prompt.js";
import { stampBriefFidelity } from "./fidelity.js";
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

/** Default model for blueprint generation -- Sonnet is cost-effective */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Generates an implementation blueprint by running a read-only agent session
 * that scans the codebase and produces code-level integration details.
 *
 * This is the Blueprint Agent — it runs BEFORE the coding agent dispatches.
 * The agent has READ-ONLY access to the codebase (Read/Glob/Grep only).
 * It analyzes the code structure, integration points, and patterns, then
 * produces a structured Blueprint JSON object.
 *
 * @param task - The parsed task to generate a blueprint for
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional configuration (model, maxTurns overrides)
 * @returns A Blueprint object with implementation details
 * @throws Error if the SDK call fails or returns invalid JSON
 */
export async function generateBlueprint(
  task: ParsedTask,
  adapter: ProjectAdapter,
  options?: { model?: string; maxTurns?: number },
): Promise<Blueprint> {
  const prompt = buildBlueprintPrompt(task, adapter.conventionsDoc);

  const model = options?.model ?? adapter.config.agent.enrichModel ?? DEFAULT_MODEL;
  const maxTurns = options?.maxTurns ?? 25;

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

  // Blueprint agent uses read-only tools and can take longer (maxTurns up to 25).
  // 10 minutes for Opus on large-context projects (e.g. example-service with
  // 574-line conventions doc). 5 minutes was insufficient — Pattern 21 in retrospectives.
  const BLUEPRINT_TIMEOUT_MS = 600_000;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Blueprint generation timed out after ${BLUEPRINT_TIMEOUT_MS / 1000}s`)),
      BLUEPRINT_TIMEOUT_MS,
    );
    timer.unref();
  });

  const iterateGenerator = async (): Promise<Blueprint> => {
    for await (const message of queryResult) {
      messages.push({ ...message } as { type: string; subtype?: string; [key: string]: unknown });

      if (message.type === "result") {
        if (message.subtype === "success") {
          const resultText = (message as SDKSuccessResult).result;

          // Extract and validate the Blueprint JSON from the agent's response
          const blueprint = extractBlueprintJson(resultText);
          if (blueprint) {
            // TASK-1306: stamp brief provenance in code — only on a REAL
            // parse (the minimal fallback is not a brief).
            return stampBriefProvenance(blueprint, adapter.projectRoot);
          }

          console.warn(
            `Failed to extract blueprint JSON from agent response (${resultText.length} chars, starts with: "${resultText.slice(0, 60)}..."). Falling back to minimal blueprint.`,
          );
          return createMinimalBlueprint(task.id);
        }

        // Handle SDK error results explicitly
        const errMsg = message as unknown as {
          subtype: string;
          errors?: string[];
          total_cost_usd?: number;
          num_turns?: number;
          stop_reason?: string | null;
        };
        console.warn(
          `Blueprint agent SDK error: ${errMsg.subtype}. Falling back to minimal blueprint.`,
        );
        return createMinimalBlueprint(task.id);
      }
    }

    // No result received — fall back to minimal blueprint instead of throwing
    console.warn(`Blueprint agent returned no success result. Falling back to minimal blueprint.`);
    return createMinimalBlueprint(task.id);
  };

  try {
    // TASK-1324: EVERY fresh synthesis leaves through this seam with a
    // pipeline-stamped fidelity result — the success path and all four
    // fallback classes inside iterateGenerator (the empty stub audits as
    // fidelity: failed instead of laundering into a clean cache entry).
    return stampBriefFidelity(
      await Promise.race([iterateGenerator(), timeoutPromise]),
      adapter.projectRoot,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Blueprint generation failed: ${msg}. Falling back to minimal blueprint.`);
    return stampBriefFidelity(createMinimalBlueprint(task.id), adapter.projectRoot);
  }
}

/** Normalize an unknown value into a non-empty string array, or undefined. */
function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

/** Normalize hand-back entries; entries without a usable summary are dropped. */
function normalizeHandBack(raw: unknown): BriefHandBackItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: BriefHandBackItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (summary.length === 0) continue;
    const item: BriefHandBackItem = { summary };
    if (typeof obj.detail === "string" && obj.detail.trim().length > 0) {
      item.detail = obj.detail;
    }
    const anchors = normalizeStringArray(obj.anchors);
    if (anchors) item.anchors = anchors;
    items.push(item);
  }
  return items.length > 0 ? items : undefined;
}

/**
 * Normalize a baseValidation candidate. Stamp fields are carried when present
 * (the persisted-cache round-trip case); provenance stamping overwrites them
 * on fresh generations, so LLM-authored values never survive that path.
 * Returns undefined when the object carries no content at all.
 */
function normalizeBaseValidation(raw: unknown): BriefBaseValidation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const normalized: BriefBaseValidation = {
    baseBranch: str(obj.baseBranch),
    baseSha: str(obj.baseSha),
    validatedAt: str(obj.validatedAt),
    observations: normalizeStringArray(obj.observations) ?? [],
  };
  const hasContent =
    normalized.baseBranch.length > 0 ||
    normalized.baseSha.length > 0 ||
    normalized.validatedAt.length > 0 ||
    normalized.observations.length > 0;
  return hasContent ? normalized : undefined;
}

/**
 * Validates and normalizes a parsed object into a Blueprint.
 * Returns a Blueprint if the object has the required shape, or null.
 *
 * TASK-1306: carries the optional brief fields through with per-entry
 * normalization (junk is dropped, never fatal) — this is the single
 * normalizer, also used by resolveCachedBlueprint for persisted objects.
 * Exported for that reuse.
 */
export function validateBlueprint(obj: unknown): Blueprint | null {
  if (
    typeof obj !== "object" ||
    obj === null ||
    !("taskId" in obj) ||
    !Array.isArray((obj as Blueprint).fileAnalyses)
  ) {
    return null;
  }
  const bp = obj as Blueprint & Record<string, unknown>;

  const baseValidation = normalizeBaseValidation(bp.baseValidation);
  const handBack = normalizeHandBack(bp.handBack);
  const constraints = normalizeStringArray(bp.constraints);
  const testsToRebaseline = normalizeStringArray(bp.testsToRebaseline);
  const importsToUse = normalizeDirectives(bp.importsToUse, "symbol", "fromFile");
  const entryPoints = normalizeDirectives(bp.entryPoints, "symbol", "file");
  const specFacts = normalizeStringArray(bp.specFacts);
  const fidelity = normalizeFidelity(bp.fidelity);

  return {
    taskId: bp.taskId,
    fileAnalyses: bp.fileAnalyses ?? [],
    codeExamples: bp.codeExamples ?? [],
    verificationPatterns: bp.verificationPatterns ?? [],
    antiPatterns: bp.antiPatterns ?? [],
    preconditions: bp.preconditions ?? [],
    ...(typeof bp.briefSchemaVersion === "number"
      ? { briefSchemaVersion: bp.briefSchemaVersion }
      : {}),
    ...(typeof bp.generatedAt === "string" && bp.generatedAt.length > 0
      ? { generatedAt: bp.generatedAt }
      : {}),
    ...(baseValidation ? { baseValidation } : {}),
    ...(handBack ? { handBack } : {}),
    ...(constraints ? { constraints } : {}),
    ...(testsToRebaseline ? { testsToRebaseline } : {}),
    ...(importsToUse ? { importsToUse } : {}),
    ...(entryPoints ? { entryPoints } : {}),
    ...(specFacts ? { specFacts } : {}),
    ...(fidelity ? { fidelity } : {}),
  };
}

/**
 * TASK-1324: normalize a typed directive array. Junk entries (missing or
 * empty symbol/file strings) are dropped, never fatal — the single
 * normalizer's contract. Returns undefined when nothing valid remains,
 * so absent stays absent.
 */
function normalizeDirectives<K1 extends string, K2 extends string>(
  value: unknown,
  symbolKey: K1,
  fileKey: K2,
): Array<Record<K1 | K2, string> & { kind?: "value" | "type" }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned: Array<Record<K1 | K2, string> & { kind?: "value" | "type" }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const symbol = record[symbolKey];
    const file = record[fileKey];
    if (
      typeof symbol === "string" &&
      symbol.trim().length > 0 &&
      typeof file === "string" &&
      file.trim().length > 0
    ) {
      cleaned.push({
        [symbolKey]: symbol.trim(),
        [fileKey]: file.trim(),
        // Round-2 F3: the type-only marker survives normalization;
        // anything but the two known kinds is dropped (value default).
        ...(record.kind === "type" || record.kind === "value" ? { kind: record.kind } : {}),
      } as Record<K1 | K2, string> & { kind?: "value" | "type" });
    }
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * TASK-1324: carry a persisted fidelity result through tolerantly (the
 * cached rehydration path needs it). The GENERATION path overwrites the
 * field unconditionally after synthesis, so an LLM-authored value can
 * never impersonate the pipeline stamp (stampBriefProvenance pattern).
 */
function normalizeFidelity(value: unknown): Blueprint["fidelity"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== "ok" && record.status !== "failed") return undefined;
  if (!Array.isArray(record.violations)) return undefined;
  const violations = record.violations.filter(
    (
      v,
    ): v is {
      kind: "missing_file" | "unexported_symbol" | "type_only_export" | "empty_brief";
      detail: string;
      anchor?: string;
    } =>
      typeof v === "object" &&
      v !== null &&
      ["missing_file", "unexported_symbol", "type_only_export", "empty_brief"].includes(
        (v as Record<string, unknown>).kind as string,
      ) &&
      typeof (v as Record<string, unknown>).detail === "string",
  );
  return {
    status: record.status,
    violations,
    checkedAt: typeof record.checkedAt === "string" ? record.checkedAt : "",
    scope: "typed-surface+file-existence",
  };
}

/**
 * Stamp brief provenance in CODE after a successful parse (TASK-1306).
 * generatedAt/briefSchemaVersion always; baseBranch/baseSha/validatedAt from
 * `git rev-parse` in projectRoot (best-effort — the tree the agent READ).
 * LLM-authored values for the stamped fields are OVERWRITTEN unconditionally;
 * agent observations are preserved. Git failure degrades to absent provenance
 * (observations kept when present) and never throws.
 */
export function stampBriefProvenance(blueprint: Blueprint, projectRoot: string): Blueprint {
  const now = new Date().toISOString();
  const observations = blueprint.baseValidation?.observations ?? [];
  const stamped: Blueprint = {
    ...blueprint,
    briefSchemaVersion: 1,
    generatedAt: now,
  };

  try {
    const gitOut = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      }).trim();
    const baseBranch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
    const baseSha = gitOut(["rev-parse", "HEAD"]);
    stamped.baseValidation = {
      baseBranch,
      baseSha,
      validatedAt: now,
      observations,
    };
  } catch {
    // Provenance absent on git failure — never fabricate, never throw.
    if (observations.length > 0) {
      stamped.baseValidation = {
        baseBranch: "",
        baseSha: "",
        validatedAt: now,
        observations,
      };
    } else {
      delete stamped.baseValidation;
    }
  }

  return stamped;
}

/**
 * Attempts to extract a valid Blueprint JSON from text that may contain
 * markdown, prose, or multiple JSON-like blocks. Tries multiple strategies:
 * 1. Direct JSON.parse of the full text
 * 2. Extract from ```json code fences
 * 3. Find balanced brace blocks containing "taskId"
 *
 * This mirrors the 3-strategy approach used by the judge's extractJudgeJson().
 */
export function extractBlueprintJson(text: string): Blueprint | null {
  // Strategy 1: Direct parse (agent output pure JSON)
  try {
    return validateBlueprint(JSON.parse(text));
  } catch {
    /* continue */
  }

  // Strategy 2: Extract from ```json code fences
  const fenceMatches = text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g);
  for (const fenceMatch of fenceMatches) {
    try {
      const result = validateBlueprint(JSON.parse(fenceMatch[1].trim()));
      if (result) return result;
    } catch {
      /* continue */
    }
  }

  // Strategy 3: Find balanced JSON objects containing "taskId"
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    const end = findBalancedJsonObjectEnd(text, i);
    if (end === -1) continue;

    const candidate = text.slice(i, end + 1);
    if (!candidate.includes('"taskId"')) continue;

    try {
      const result = validateBlueprint(JSON.parse(candidate));
      if (result) return result;
    } catch {
      /* try next block */
    }
  }

  return null;
}

function findBalancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

/**
 * Creates a minimal empty blueprint when the agent fails or returns invalid JSON.
 * This allows dispatch to continue without blocking on blueprint failures.
 */
export function createMinimalBlueprint(taskId: string): Blueprint {
  return {
    taskId,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  };
}
