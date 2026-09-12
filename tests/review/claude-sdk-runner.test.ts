// ─── TASK-1305: claude-sdk review runner — mocked-SDK behavior matrix ─

import { _setQueryFn, runClaudeSdkReview } from "../../src/review/claude-sdk-runner";
import * as fs from "node:fs";
import * as path from "node:path";
import { ReviewerRunnerConfigSchema } from "../../src/review/reviewer-config";
import { REVIEW_SYSTEM_PROMPT } from "../../src/review/review-prompts";
import type { ReviewRequest } from "../../src/review/reviewer-types";

const CONFIG = ReviewerRunnerConfigSchema.parse({});
const PROJECT_ROOT = fs.realpathSync.native(process.cwd());
const GROUNDED_FILE = path.join(PROJECT_ROOT, "src/review/reviewer-types.ts");

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
  message?: {
    content?:
      | Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>
      | string;
  };
  [key: string]: unknown;
}

function makeGen(messages: FakeMessage[]): AsyncGenerator<FakeMessage, void> {
  return (async function* () {
    for (const m of messages) {
      yield await Promise.resolve(m);
    }
  })();
}

function groundedMessages(result: string = VERDICT_JSON): FakeMessage[] {
  return [
    { type: "system", subtype: "init", cwd: PROJECT_ROOT },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read-grounded-file",
            name: "Read",
            input: { file_path: GROUNDED_FILE },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-grounded-file",
            content: "export interface ReviewRequest",
          },
        ],
      },
    },
    { type: "result", subtype: "success", result },
  ];
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
        ...groundedMessages().slice(0, -1),
        { type: "result", subtype: "success", result: VERDICT_JSON, total_cost_usd: 0.42 },
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
    expect(result.groundingAudit).toMatchObject({
      cwdMatched: true,
      observedToolUses: 1,
      successfulGroundingToolUses: 1,
      ungroundedAnchors: [],
      violations: [],
    });
    expect(result.groundingAudit?.successfulReads[0]).toMatchObject({
      path: "src/review/reviewer-types.ts",
    });
    expect(result.groundingAudit?.successfulReads[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    // anchors audit attached because the finding cites a path (which exists)
    expect(result.anchorsAudit).toEqual({ total: 1, missing: [] });
  });

  it("survives a JSON round-trip (approval-file persistence contract)", async () => {
    _setQueryFn(() => makeGen(groundedMessages()));
    const result = await runClaudeSdkReview(request(), CONFIG);
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped).toEqual(result);
  });

  it("falls back to assistant text when the result payload is not the verdict", async () => {
    _setQueryFn(() =>
      makeGen([
        ...groundedMessages().slice(0, -1),
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
      return makeGen(groundedMessages());
    });

    const config = ReviewerRunnerConfigSchema.parse({ model: "claude-opus-4-6", maxTurns: 12 });
    await runClaudeSdkReview(request({ projectRoot: PROJECT_ROOT }), config);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(capturedOptions!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(capturedOptions!.disallowedTools).toEqual([
      "Edit",
      "Write",
      "Bash",
      "WebSearch",
      "WebFetch",
    ]);
    expect(capturedOptions!.cwd).toBe(PROJECT_ROOT);
    expect(capturedOptions!.systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
    expect(capturedOptions!.model).toBe("claude-opus-4-6");
    expect(capturedOptions!.maxTurns).toBe(12);
    // getSdkPermissionOptions() contributes a permissionMode on every platform
    expect(typeof capturedOptions!.permissionMode).toBe("string");
  });

  it("rejects a verdict whose anchor path is missing", async () => {
    const withGhost = JSON.stringify({
      verdict: "FIX_FIRST",
      summary: "bad anchor",
      findings: [{ severity: "blocking", summary: "x", anchors: ["src/does-not-exist-xyz.ts:5"] }],
    });
    _setQueryFn(() => makeGen(groundedMessages(withGhost)));

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("grounding_failed");
    expect(result.groundingAudit).toMatchObject({
      ungroundedAnchors: ["src/does-not-exist-xyz.ts:5"],
    });
  });

  it("rejects a verdict when SDK init reports a different cwd", async () => {
    const messages = groundedMessages();
    messages[0] = { type: "system", subtype: "init", cwd: path.dirname(PROJECT_ROOT) };
    _setQueryFn(() => makeGen(messages));

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("grounding_failed");
    expect(result.groundingAudit?.violations).toContain("sdk_init_cwd_mismatch");
  });

  it("rejects a verdict when an available Task tool bypasses direct grounding", async () => {
    _setQueryFn(() =>
      makeGen([
        { type: "system", subtype: "init", cwd: PROJECT_ROOT },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "delegated-read",
                name: "Task",
                input: { prompt: "read the repository" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "delegated-read",
                content: "invented repository contents",
              },
            ],
          },
        },
        { type: "result", subtype: "success", result: VERDICT_JSON },
      ]),
    );

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("grounding_failed");
    expect(result.groundingAudit?.violations).toEqual(
      expect.arrayContaining(["unexpected_tool:Task", "no_successful_direct_read"]),
    );
  });

  it("rejects an existing finding anchor that was not directly read", async () => {
    const anchoredElsewhere = JSON.stringify({
      verdict: "AMEND",
      summary: "wrong file was read",
      findings: [
        { severity: "should_fix", summary: "x", anchors: ["src/review/review-prompts.ts:1"] },
      ],
    });
    _setQueryFn(() => makeGen(groundedMessages(anchoredElsewhere)));

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("grounding_failed");
    expect(result.groundingAudit?.ungroundedAnchors).toEqual(["src/review/review-prompts.ts:1"]);
  });

  it("rejects findings without repository-file anchors", async () => {
    const anchorless = JSON.stringify({
      verdict: "AMEND",
      summary: "unsupported finding",
      findings: [{ severity: "should_fix", summary: "x" }],
    });
    _setQueryFn(() => makeGen(groundedMessages(anchorless)));

    const result = await runClaudeSdkReview(request(), CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("grounding_failed");
    expect(result.groundingAudit?.violations).toContain("finding_without_anchor");
  });
});
