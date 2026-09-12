import * as fs from "node:fs";
import * as path from "node:path";
import { parseTaskFile } from "../../src/core/task-parser";
import { evaluateTaskDepth, _setQueryFn } from "../../src/gate/depth-evaluator";

describe("direct readiness SDK credential boundary", () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      ANTHROPIC_API_KEY: "fixture-primary",
      ANTHROPIC_API_KEY_2: "fixture-second",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    };
  });
  afterEach(() => {
    _setQueryFn(undefined);
    process.env = originalEnvironment;
  });

  it("passes only the selected pool key to the actual query options", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    _setQueryFn((input) => {
      calls.push(input.options);
      return (async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            ready: true,
            overall_score: 5,
            scores: {
              clarity: 5,
              scope: 5,
              testability: 5,
              conventions: 5,
              implementation_specificity: 5,
              verification_clarity: 5,
              completeness: 5,
            },
            deficiencies: [],
            enrichment_suggestions: [],
          }),
        };
      })();
    });
    const filename = path.join(__dirname, "../fixtures/task-valid-full.md");
    const task = parseTaskFile(fs.readFileSync(filename, "utf8"), filename);
    const result = await evaluateTaskDepth(task, "fixture conventions", {
      apiKeys: { pool: ["env:ANTHROPIC_API_KEY_2"], strategy: "round-robin", cooldownMs: 1000 },
    });
    expect(result.ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({
      ANTHROPIC_API_KEY: "fixture-second",
      ANTHROPIC_API_KEY_2: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-primary");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-oauth");
  });

  it("refuses an unselected conflict before any provider call", async () => {
    const query = jest.fn(() => {
      throw new Error("Conflicting authentication must refuse before an SDK call");
    });
    _setQueryFn(query);
    const filename = path.join(__dirname, "../fixtures/task-valid-full.md");
    const task = parseTaskFile(fs.readFileSync(filename, "utf8"), filename);
    await expect(evaluateTaskDepth(task, "fixture conventions")).rejects.toThrow(
      "Both Anthropic API keys",
    );
    expect(query).not.toHaveBeenCalled();
  });
});
