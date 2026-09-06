import { _setIntentJudgmentQueryFn } from "../../src/judgment/runner/claude-intent-judgment-runner";
import { createIntentJudgmentRunner } from "../../src/judgment/runner/intent-judgment-runner";
import type { IntentJudgmentRequest } from "../../src/judgment/judgment-types";

const request: IntentJudgmentRequest = {
  stage: "docs_review",
  taskId: "TASK-1311",
  taskIntent: "Ship intent.",
  successCriteria: [],
  scopeBoundaries: [],
  stageContext: {},
  signals: [
    {
      ref: "missing_wiki_artifacts#1",
      signal: {
        source: "docs_review",
        code: "missing_wiki_artifacts",
        disposition: "human_review",
        message: "missing",
        deterministic: true,
      },
    },
  ],
  contextMetadata: { presentSections: ["Intent"], missingSections: [] },
};

async function* messages(
  ...items: Array<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>, void> {
  await Promise.resolve();
  for (const item of items) yield item;
}

describe("IntentJudgmentRunner", () => {
  afterEach(() => _setIntentJudgmentQueryFn(undefined));

  it("strictly rejects unknown config keys", () => {
    expect(() => createIntentJudgmentRunner({ extraArgs: ["--danger"] })).toThrow();
  });

  it("uses a no-tool structured SDK session and stamps trusted provenance", async () => {
    let captured: Record<string, unknown> | undefined;
    _setIntentJudgmentQueryFn(((params: Record<string, unknown>) => {
      captured = params;
      return messages({
        type: "result",
        subtype: "success",
        session_id: "session-1",
        total_cost_usd: 0.25,
        num_turns: 2,
        structured_output: {
          action: "continue",
          rationale: ["intent satisfied"],
          consideredSignalRefs: ["missing_wiki_artifacts#1"],
        },
      });
    }) as never);
    const runner = createIntentJudgmentRunner({ timeoutMs: 1_000 });
    const result = await runner.run(request);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.judgment).toEqual({
      source: "intent_model",
      action: "continue",
      rationale: ["intent satisfied"],
    });
    expect(result.sessionId).toBe("session-1");
    const options = captured?.options as Record<string, unknown>;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.outputFormat).toEqual(expect.objectContaining({ type: "json_schema" }));
    expect(captured?.prompt).toContain("<untrusted_evidence>");
  });

  it("returns invalid_output for missing refs and fenced text", async () => {
    for (const resultMessage of [
      {
        type: "result",
        subtype: "success",
        structured_output: {
          action: "continue",
          rationale: ["intent satisfied"],
          consideredSignalRefs: [],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "```json\n{}\n```",
      },
    ]) {
      _setIntentJudgmentQueryFn((() => messages(resultMessage)) as never);
      const result = await createIntentJudgmentRunner({ timeoutMs: 1_000 }).run(request);
      expect(result).toEqual(
        expect.objectContaining({
          status: "runner_error",
          errorCode: "invalid_output",
        }),
      );
    }
  });

  it("uses SDK errors[] for a bounded non-content diagnostic", async () => {
    _setIntentJudgmentQueryFn((() =>
      messages({
        type: "result",
        subtype: "error_max_turns",
        errors: ["SECRET_TASK_CONTENT", "second"],
      })) as never);
    const result = await createIntentJudgmentRunner({ timeoutMs: 1_000 }).run(request);
    expect(result).toEqual(
      expect.objectContaining({
        status: "runner_error",
        errorCode: "sdk_error",
      }),
    );
    if (result.status !== "runner_error") throw new Error("expected runner error");
    expect(result.message).toContain("2 error(s)");
    expect(JSON.stringify(result)).not.toContain("SECRET_TASK_CONTENT");
  });

  it("returns no_result and never rejects on an SDK throw", async () => {
    _setIntentJudgmentQueryFn((() => messages({ type: "assistant" })) as never);
    await expect(createIntentJudgmentRunner({ timeoutMs: 1_000 }).run(request)).resolves.toEqual(
      expect.objectContaining({ errorCode: "no_result" }),
    );

    _setIntentJudgmentQueryFn((() => {
      throw new Error("SECRET_TASK_CONTENT");
    }) as never);
    const thrown = await createIntentJudgmentRunner({ timeoutMs: 1_000 }).run(request);
    expect(thrown).toEqual(expect.objectContaining({ errorCode: "sdk_error" }));
    expect(JSON.stringify(thrown)).not.toContain("SECRET_TASK_CONTENT");
  });

  it("times out and aborts a non-terminating SDK iterator", async () => {
    _setIntentJudgmentQueryFn(async function* () {
      await new Promise<void>(() => undefined);
      yield { type: "assistant" };
    } as never);
    const result = await createIntentJudgmentRunner({ timeoutMs: 10 }).run(request);
    expect(result).toEqual(
      expect.objectContaining({
        status: "runner_error",
        errorCode: "timeout",
      }),
    );
  });
});
