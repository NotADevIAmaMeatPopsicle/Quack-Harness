import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
// ─── Claude SDK Review Runner ───────────────────────────────────────
// In-process Agent SDK review session (TASK-1305). Mirrors the judge's
// session pattern: lazy ESM import, read-only tool set, systemPrompt for
// caching, 3-strategy output extraction.
//
// run() NEVER rejects: known failure classes map to their errorKind and a
// catch-all maps anything else to session_error.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import type { ReviewGroundingAudit, ReviewRequest, ReviewRunResult } from "./reviewer-types.js";
import type { ReviewerRunnerConfig } from "./reviewer-config.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from "./review-prompts.js";
import { auditFindingAnchors, extractReviewResult } from "./verdict-extract.js";

// ─── SDK type shims (local, avoids ESM/CJS import issues) ───────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface SDKMessage {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  cwd?: string;
  [key: string]: unknown;
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

// ─── Lazy SDK loading ───────────────────────────────────────────────

let _queryFn: QueryFn | undefined;

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

/** Default review model — Sonnet, judge parity. */
const DEFAULT_MODEL = "claude-sonnet-4-6";
const GROUNDING_TOOLS = ["Read", "Glob", "Grep"] as const;
const GROUNDING_TOOL_SET = new Set<string>(GROUNDING_TOOLS);

interface ObservedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  target?: string;
  targetRelative?: string;
  targetValid: boolean;
  succeeded: boolean;
}

function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalExistingPath(value: string): string | undefined {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return undefined;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function resolveToolTarget(
  projectRoot: string,
  name: string,
  input: Record<string, unknown>,
): { target?: string; targetRelative?: string; targetValid: boolean } {
  const raw = name === "Read" ? (input.file_path ?? input.path) : (input.path ?? ".");
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { targetValid: false };
  }

  const resolved = path.resolve(projectRoot, raw);
  const canonical = canonicalExistingPath(resolved);
  if (!canonical || !isInsideRoot(projectRoot, canonical)) {
    return { target: resolved, targetValid: false };
  }

  try {
    const stat = fs.statSync(canonical);
    if (name === "Read" && !stat.isFile()) {
      return { target: canonical, targetValid: false };
    }
  } catch {
    return { target: canonical, targetValid: false };
  }

  return {
    target: canonical,
    targetRelative: path.relative(projectRoot, canonical).replace(/\\/g, "/") || ".",
    targetValid: true,
  };
}

function toolResultSucceeded(block: ContentBlock): boolean {
  if (block.is_error === true) return false;
  if (typeof block.content === "string") {
    return !/(?:<tool_use_error>|file does not exist|permission denied)/i.test(block.content);
  }
  return true;
}

function anchorFile(
  anchor: string,
  projectRoot: string,
): {
  relative?: string;
  canonical?: string;
} {
  const filePart = anchor.trim().replace(/:\d+(?:-\d+)?$/, "");
  if (!filePart || path.isAbsolute(filePart) || /^[A-Za-z]:[\\/]/.test(filePart)) {
    return {};
  }
  const canonical = canonicalExistingPath(path.resolve(projectRoot, filePart));
  if (!canonical || !isInsideRoot(projectRoot, canonical)) return {};
  try {
    if (!fs.statSync(canonical).isFile()) return {};
  } catch {
    return {};
  }
  return {
    relative: path.relative(projectRoot, canonical).replace(/\\/g, "/"),
    canonical,
  };
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildGroundingAudit(
  requestedProjectRoot: string,
  initializedCwd: string | undefined,
  observed: readonly ObservedToolUse[],
  anchors: readonly string[],
): ReviewGroundingAudit {
  const violations: string[] = [];
  const cwdMatched =
    initializedCwd !== undefined &&
    normalizeComparablePath(initializedCwd) === normalizeComparablePath(requestedProjectRoot);
  if (!initializedCwd) violations.push("missing_sdk_init_cwd");
  else if (!cwdMatched) violations.push("sdk_init_cwd_mismatch");

  const unexpected = [
    ...new Set(
      observed.filter((tool) => !GROUNDING_TOOL_SET.has(tool.name)).map((tool) => tool.name),
    ),
  ];
  for (const name of unexpected) violations.push(`unexpected_tool:${name}`);

  const successfulGrounding = observed.filter(
    (tool) => GROUNDING_TOOL_SET.has(tool.name) && tool.targetValid && tool.succeeded,
  );
  const successfulReads = successfulGrounding.filter(
    (tool) => tool.name === "Read" && tool.target && tool.targetRelative,
  );
  if (successfulReads.length === 0) violations.push("no_successful_direct_read");

  const readPaths = new Set(successfulReads.map((tool) => normalizeComparablePath(tool.target!)));
  const ungroundedAnchors: string[] = [];
  for (const anchor of anchors) {
    const resolved = anchorFile(anchor, requestedProjectRoot);
    if (!resolved.canonical || !readPaths.has(normalizeComparablePath(resolved.canonical))) {
      ungroundedAnchors.push(anchor);
    }
  }
  if (ungroundedAnchors.length > 0) violations.push("finding_anchors_not_directly_read");

  const distinctReads = new Map<string, string>();
  for (const read of successfulReads) {
    if (!read.target || !read.targetRelative || distinctReads.has(read.targetRelative)) continue;
    try {
      distinctReads.set(read.targetRelative, sha256File(read.target));
    } catch {
      violations.push(`read_digest_failed:${read.targetRelative}`);
    }
  }

  return {
    requestedProjectRoot,
    ...(initializedCwd ? { initializedCwd } : {}),
    cwdMatched,
    observedToolUses: observed.length,
    successfulGroundingToolUses: successfulGrounding.length,
    successfulReads: [...distinctReads].map(([readPath, sha256]) => ({
      path: readPath,
      sha256,
    })),
    ungroundedAnchors,
    violations,
  };
}

/** Sentinel for the timeout race. */
interface TimeoutSentinel {
  __reviewTimeout: true;
}

/**
 * Run an adversarial review in a read-only Claude Agent SDK session.
 * Resolves to a ReviewRunResult on every path; never rejects.
 */
export async function runClaudeSdkReview(
  request: ReviewRequest,
  config: ReviewerRunnerConfig,
): Promise<ReviewRunResult> {
  const startedAt = Date.now();
  const model = config.model ?? DEFAULT_MODEL;
  const canonicalProjectRoot = canonicalExistingPath(request.projectRoot);
  if (!canonicalProjectRoot) {
    const groundingAudit: ReviewGroundingAudit = {
      requestedProjectRoot: path.resolve(request.projectRoot),
      cwdMatched: false,
      observedToolUses: 0,
      successfulGroundingToolUses: 0,
      successfulReads: [],
      ungroundedAnchors: [],
      violations: ["project_root_unavailable"],
    };
    return {
      status: "runner_error",
      errorKind: "grounding_failed",
      message: `Review project root is unavailable: ${groundingAudit.requestedProjectRoot}`,
      runner: "claude-sdk",
      durationMs: Date.now() - startedAt,
      groundingAudit,
    };
  }
  try {
    if (!fs.statSync(canonicalProjectRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    const groundingAudit: ReviewGroundingAudit = {
      requestedProjectRoot: canonicalProjectRoot,
      cwdMatched: false,
      observedToolUses: 0,
      successfulGroundingToolUses: 0,
      successfulReads: [],
      ungroundedAnchors: [],
      violations: ["project_root_not_directory"],
    };
    return {
      status: "runner_error",
      errorKind: "grounding_failed",
      message: `Review project root is not a directory: ${canonicalProjectRoot}`,
      runner: "claude-sdk",
      durationMs: Date.now() - startedAt,
      groundingAudit,
    };
  }

  let queryFn: QueryFn;
  try {
    queryFn = await getQueryFn();
  } catch (err: unknown) {
    return {
      status: "runner_error",
      errorKind: "unavailable",
      message: `Claude Agent SDK could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      runner: "claude-sdk",
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const queryResult = queryFn({
      prompt: buildReviewPrompt({ ...request, projectRoot: canonicalProjectRoot }),
      options: {
        model,
        maxTurns: config.maxTurns,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        // `allowedTools` only bypasses permission prompts. `tools` is the
        // actual availability boundary; omitting it exposes Task/subagents and
        // every other Claude Code tool (the TASK-008-C grounding defect).
        tools: [...GROUNDING_TOOLS],
        allowedTools: [...GROUNDING_TOOLS],
        disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
        ...getSdkPermissionOptions(),
        env: getClaudeSdkEnvironment(),
        cwd: canonicalProjectRoot,
      },
    });

    const timeoutSentinel: TimeoutSentinel = { __reviewTimeout: true };
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<TimeoutSentinel>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(timeoutSentinel), config.timeoutMs);
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
    });

    const assistantTexts: string[] = [];
    let resultText = "";
    let costUsd: number | undefined;
    let sawErrorResult: { subtype: string; errors?: string[] } | undefined;
    let initializedCwd: string | undefined;
    const observedTools: ObservedToolUse[] = [];
    const toolsById = new Map<string, ObservedToolUse>();

    const iterate = async (): Promise<void> => {
      for await (const message of queryResult) {
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          typeof message.cwd === "string"
        ) {
          initializedCwd = canonicalExistingPath(message.cwd) ?? path.resolve(message.cwd);
        }

        if (message.type === "assistant" && message.message) {
          const blocks = message.message.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block.type === "text" && block.text) {
                assistantTexts.push(block.text);
              } else if (
                block.type === "tool_use" &&
                typeof block.id === "string" &&
                typeof block.name === "string"
              ) {
                const input = block.input ?? {};
                const target = GROUNDING_TOOL_SET.has(block.name)
                  ? resolveToolTarget(canonicalProjectRoot, block.name, input)
                  : { targetValid: false };
                const observed: ObservedToolUse = {
                  id: block.id,
                  name: block.name,
                  input,
                  ...target,
                  succeeded: false,
                };
                observedTools.push(observed);
                toolsById.set(block.id, observed);
              }
            }
          } else if (typeof blocks === "string") {
            assistantTexts.push(blocks);
          }
        }

        if (message.type === "user" && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) {
            if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
              continue;
            }
            const observed = toolsById.get(block.tool_use_id);
            if (observed) observed.succeeded = observed.targetValid && toolResultSucceeded(block);
          }
        }

        if (message.type === "result") {
          const cost = (message as Record<string, unknown>).total_cost_usd;
          if (typeof cost === "number") costUsd = cost;

          if (message.subtype === "success") {
            const r = (message as Record<string, unknown>).result;
            if (typeof r === "string") resultText = r;
          } else {
            sawErrorResult = {
              subtype: message.subtype ?? "unknown",
              errors: Array.isArray((message as Record<string, unknown>).errors)
                ? ((message as Record<string, unknown>).errors as string[])
                : undefined,
            };
          }
          // The result message is the final meaningful message; break so a
          // non-terminating generator cannot hang the review (agent-worker
          // pattern).
          break;
        }
      }
    };

    // Hold the iteration promise and attach a no-op rejection consumer BEFORE
    // racing: if the timeout wins and the iterator rejects later, that late
    // rejection must not surface as an unhandledRejection (round-2 finding 3).
    // The race still sees the original promise, so a rejection that happens
    // FIRST propagates to the outer catch as before.
    const iterationPromise = iterate();
    iterationPromise.catch(() => undefined);
    const raced = await Promise.race([iterationPromise, timeoutPromise]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    if (raced && typeof raced === "object" && raced.__reviewTimeout) {
      return {
        status: "runner_error",
        errorKind: "timeout",
        message: `Review session exceeded ${config.timeoutMs}ms`,
        runner: "claude-sdk",
        durationMs: Date.now() - startedAt,
      };
    }

    if (sawErrorResult) {
      const errList = sawErrorResult.errors?.length
        ? ` — errors: ${sawErrorResult.errors.join("; ")}`
        : "";
      return {
        status: "runner_error",
        errorKind: "session_error",
        message: `SDK session ended with result subtype "${sawErrorResult.subtype}"${errList}`,
        runner: "claude-sdk",
        durationMs: Date.now() - startedAt,
      };
    }

    const rawText = resultText || assistantTexts.join("\n");
    const extracted =
      extractReviewResult(resultText) ?? extractReviewResult(assistantTexts.join("\n"));

    if (!extracted) {
      return {
        status: "runner_error",
        errorKind: "parse_failed",
        message: `Review session produced no valid verdict JSON (${rawText.length} chars of output)`,
        rawText,
        runner: "claude-sdk",
        durationMs: Date.now() - startedAt,
      };
    }

    const hasAnchors = extracted.findings.some((f) => (f.anchors?.length ?? 0) > 0);
    const allFindingsAnchored = extracted.findings.every(
      (finding) => (finding.anchors?.length ?? 0) > 0,
    );
    const anchors = extracted.findings.flatMap((finding) => finding.anchors ?? []);
    const groundingAudit = buildGroundingAudit(
      canonicalProjectRoot,
      initializedCwd,
      observedTools,
      anchors,
    );
    if (!allFindingsAnchored) {
      groundingAudit.violations.push("finding_without_anchor");
    }
    if (groundingAudit.violations.length > 0) {
      return {
        status: "runner_error",
        errorKind: "grounding_failed",
        message: `Review verdict rejected because source grounding failed: ${groundingAudit.violations.join(", ")}`,
        rawText,
        runner: "claude-sdk",
        durationMs: Date.now() - startedAt,
        groundingAudit,
      };
    }

    return {
      status: "completed",
      verdict: extracted.verdict,
      findings: extracted.findings,
      ...(extracted.confidence !== undefined ? { confidence: extracted.confidence } : {}),
      summary: extracted.summary,
      rawText,
      runner: "claude-sdk",
      model,
      durationMs: Date.now() - startedAt,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(hasAnchors
        ? { anchorsAudit: auditFindingAnchors(extracted.findings, canonicalProjectRoot) }
        : {}),
      groundingAudit,
    };
  } catch (err: unknown) {
    // Catch-all: anything unexpected from the SDK/transport layers is an
    // environment failure, not a verdict and not a rejection.
    return {
      status: "runner_error",
      errorKind: "session_error",
      message: err instanceof Error ? err.message : String(err),
      runner: "claude-sdk",
      durationMs: Date.now() - startedAt,
    };
  }
}
