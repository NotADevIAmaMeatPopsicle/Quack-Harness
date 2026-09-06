// ─── Claude SDK Review Runner ───────────────────────────────────────
// In-process Agent SDK review session (TASK-1305). Mirrors the judge's
// session pattern: lazy ESM import, read-only tool set, systemPrompt for
// caching, 3-strategy output extraction.
//
// run() NEVER rejects: known failure classes map to their errorKind and a
// catch-all maps anything else to session_error.

import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import type { ReviewRequest, ReviewRunResult } from "./reviewer-types.js";
import type { ReviewerRunnerConfig } from "./reviewer-config.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from "./review-prompts.js";
import { auditFindingAnchors, extractReviewResult } from "./verdict-extract.js";

// ─── SDK type shims (local, avoids ESM/CJS import issues) ───────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface SDKMessage {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
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
      prompt: buildReviewPrompt(request),
      options: {
        model,
        maxTurns: config.maxTurns,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
        ...getSdkPermissionOptions(),
        cwd: request.projectRoot,
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

    const iterate = async (): Promise<void> => {
      for await (const message of queryResult) {
        if (message.type === "assistant" && message.message) {
          const blocks = message.message.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block.type === "text" && block.text) {
                assistantTexts.push(block.text);
              }
            }
          } else if (typeof blocks === "string") {
            assistantTexts.push(blocks);
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
        ? { anchorsAudit: auditFindingAnchors(extracted.findings, request.projectRoot) }
        : {}),
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
