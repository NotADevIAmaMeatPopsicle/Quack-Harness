// ─── TASK-1305: claude-sdk review runner — mocked-SDK behavior matrix ─

import { _setQueryFn, runClaudeSdkReview } from "../../src/review/claude-sdk-runner";
import { ReviewerRunnerConfigSchema } from "../../src/review/reviewer-config";
import { REVIEW_SYSTEM_PROMPT } from "../../src/review/review-prompts";
import type { ReviewRequest } from "../../src/review/reviewer-types";

const CONFIG = ReviewerRunnerConfigSchema.parse({});

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    kind: "brief",
    taskId: "TASK-9001",
    taskSpec: "# TASK-9001: do the thing\n\ncriteria",
    artifact: "## Implementation Brief\n\nplan text",
    projectRoot: process.cwd(),
    ...overrides,
  };
}

interface FakeMessage {
  type: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string }> | string };
  [key: string]: unknown;
}

function makeGen(messages: FakeMessage[]): AsyncGenerator<FakeMessage, void> {
  return (async function* () {
    for (const m of messages) {
      yield await Promise.resolve(m);
    }
  })();
}

const VERDICT_JSON = JSON.stringify({
  verdict: "AMEND",
  summary: "one finding",
  confidence: 0.9,
  findings: [
    {
      severity: "should_fix",
      summary: "a finding",
      anchors: ["src/review/reviewer-types.ts:1"],
    },
  ],
});

afterEach(() => {
  _setQueryFn(undefined);
});

describe("runClaudeSdkReview", () => {
  it("completes on a success result with direct JSON, capturing cost and model", async () => {
    _setQueryFn(() =>
      makeGen([
        { type: "system", subtype: "init" },
        {
          type: "result",
          subtype: "success",
          result: VERDICT_JSON,
          total_cost_usd: 0.42,
        },
      ]),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.verdict).toBe("AMEND");
    expect(result.findings).toHaveLength(1);
    expect(result.costUsd).toBe(0.42);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.runner).toBe("claude-sdk");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // anchors audit attached because the finding cites a path (which exists)
    expect(result.anchorsAudit).toEqual({ total: 1, missing: [] });
  });

  it("survives a JSON round-trip (approval-file persistence contract)", async () => {
    _setQueryFn(() =>
      makeGen([{ type: "result", subtype: "success", result: VERDICT_JSON, total_cost_usd: 0.1 }]),
    );
    const result = await runClaudeSdkReview(request(), CONFIG);
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped).toEqual(result);
  });

  it("falls back to assistant text when the result payload is not the verdict", async () => {
    _setQueryFn(() =>
      makeGen([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: `review done\n\n\`\`\`json\n${VERDICT_JSON}\n\`\`\`` }],
          },
        },
        { type: "result", subtype: "success", result: "see above" },
      ]),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.verdict).toBe("AMEND");
  });

  it("maps unparseable output to parse_failed with rawText, never a verdict", async () => {
    _setQueryFn(() =>
      makeGen([{ type: "result", subtype: "success", result: "I think it looks fine!" }]),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("parse_failed");
    expect(result.rawText).toContain("looks fine");
  });

  it("maps an SDK error-subtype result to session_error and surfaces errors[]", async () => {
    _setQueryFn(() =>
      makeGen([
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["transport exploded"],
          total_cost_usd: 0.05,
        },
      ]),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
    expect(result.message).toContain("error_during_execution");
    expect(result.message).toContain("transport exploded");
  });

  it("maps a mid-iteration throw to session_error (catch-all; never rejects)", async () => {
    _setQueryFn(() =>
      (async function* (): AsyncGenerator<FakeMessage, void> {
        yield await Promise.resolve({ type: "system", subtype: "init" });
        throw new Error("socket reset from nowhere");
      })(),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
    expect(result.message).toContain("socket reset");
  });

  it("maps a synchronously-throwing queryFn to session_error (never rejects)", async () => {
    _setQueryFn(() => {
      throw new Error("spawn pressure");
    });

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
  });

  it("times out a hung session via the race and reports timeout", async () => {
    _setQueryFn(() =>
      (async function* (): AsyncGenerator<FakeMessage, void> {
        await new Promise(() => {
          /* never resolves */
        });
        yield { type: "unreachable" };
      })(),
    );

    const config = ReviewerRunnerConfigSchema.parse({ timeoutMs: 50 });
    const result = await runClaudeSdkReview(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("timeout");
    expect(result.message).toContain("50ms");
  });

  it("consumes a late iterator rejection after timeout (no unhandledRejection)", async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      _setQueryFn(() =>
        (async function* (): AsyncGenerator<FakeMessage, void> {
          await new Promise((resolve) => setTimeout(resolve, 120));
          throw new Error("late transport death after the race was lost");
          yield { type: "unreachable" };
        })(),
      );

      const config = ReviewerRunnerConfigSchema.parse({ timeoutMs: 30 });
      const result = await runClaudeSdkReview(request(), config);
      expect(result.status).toBe("runner_error");
      if (result.status !== "runner_error") return;
      expect(result.errorKind).toBe("timeout");

      // let the losing iterator reject and its guard consume it
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("opens a read-only session with the documented options", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    _setQueryFn((params) => {
      capturedOptions = params.options;
      return makeGen([{ type: "result", subtype: "success", result: VERDICT_JSON }]);
    });

    const config = ReviewerRunnerConfigSchema.parse({ model: "claude-opus-4-6", maxTurns: 12 });
    await runClaudeSdkReview(request({ projectRoot: "C:/some/project" }), config);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(capturedOptions!.disallowedTools).toEqual([
      "Edit",
      "Write",
      "Bash",
      "WebSearch",
      "WebFetch",
    ]);
    expect(capturedOptions!.cwd).toBe("C:/some/project");
    expect(capturedOptions!.systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
    expect(capturedOptions!.model).toBe("claude-opus-4-6");
    expect(capturedOptions!.maxTurns).toBe(12);
    // getSdkPermissionOptions() contributes a permissionMode on every platform
    expect(typeof capturedOptions!.permissionMode).toBe("string");
  });

  it("reports missing anchor paths in the audit", async () => {
    const withGhost = JSON.stringify({
      verdict: "FIX_FIRST",
      summary: "bad anchor",
      findings: [{ severity: "blocking", summary: "x", anchors: ["src/does-not-exist-xyz.ts:5"] }],
    });
    _setQueryFn(() => makeGen([{ type: "result", subtype: "success", result: withGhost }]));

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.anchorsAudit).toEqual({
      total: 1,
      missing: ["src/does-not-exist-xyz.ts"],
    });
  });
});
