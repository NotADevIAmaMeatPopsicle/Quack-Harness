import { estimateTokens, estimateTokensForContext } from "../../src/context/token-estimator";
import type { ContextSizeEstimate } from "../../src/context/token-estimator";
import type { TaskContext } from "../../src/core/types";

describe("token-estimator", () => {
  describe("estimateTokens", () => {
    it("should return 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("should return 0 for null/undefined-ish input", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("should estimate ~1 token per 4 characters", () => {
      // 100 chars → 25 tokens
      const text = "a".repeat(100);
      expect(estimateTokens(text)).toBe(25);
    });

    it("should round up for non-divisible lengths", () => {
      // 5 chars → ceil(5/4) = 2 tokens
      expect(estimateTokens("hello")).toBe(2);
    });

    it("should handle a single character", () => {
      // 1 char → ceil(1/4) = 1 token
      expect(estimateTokens("x")).toBe(1);
    });

    it("should handle a realistic code snippet", () => {
      const code = `function hello(name: string): string {\n  return \`Hello, \${name}!\`;\n}`;
      const expected = Math.ceil(code.length / 4);
      expect(estimateTokens(code)).toBe(expected);
    });

    it("should scale linearly with text length", () => {
      const short = "a".repeat(400);
      const long = "a".repeat(4000);
      expect(estimateTokens(long)).toBe(estimateTokens(short) * 10);
    });
  });

  describe("estimateTokensForContext", () => {
    function makeMinimalContext(overrides?: Partial<TaskContext>): TaskContext {
      return {
        taskSpec: "",
        conventions: {},
        conventionsSummary: "",
        relevantFiles: [],
        relatedPatterns: [],
        existingTests: [],
        claudeMd: [],
        ...overrides,
      };
    }

    it("should return all zeros for empty context", () => {
      const ctx = makeMinimalContext();
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.taskSpec).toBe(0);
      expect(estimate.blueprint).toBe(0);
      expect(estimate.repoMap).toBe(0);
      expect(estimate.relevantFiles).toBe(0);
      expect(estimate.relatedPatterns).toBe(0);
      expect(estimate.existingTests).toBe(0);
      expect(estimate.conventions).toBe(0);
      expect(estimate.claudeMd).toBe(0);
      expect(estimate.total).toBe(0);
      expect(estimate.withinBudget).toBe(true);
    });

    it("should estimate taskSpec tokens correctly", () => {
      const taskSpec = "a".repeat(400); // 100 tokens
      const ctx = makeMinimalContext({ taskSpec });
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.taskSpec).toBe(100);
      expect(estimate.total).toBe(100);
    });

    it("should estimate blueprint tokens from optional field", () => {
      const ctx = makeMinimalContext({ blueprint: "b".repeat(200) }); // 50 tokens
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.blueprint).toBe(50);
    });

    it("should estimate repoMap tokens from optional field", () => {
      const ctx = makeMinimalContext({ repoMap: "r".repeat(800) }); // 200 tokens
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.repoMap).toBe(200);
    });

    it("should sum array sections (relevantFiles, relatedPatterns, existingTests)", () => {
      const ctx = makeMinimalContext({
        relevantFiles: ["a".repeat(100), "b".repeat(100)], // joined = 201 chars → 51 tokens
        relatedPatterns: ["c".repeat(40)], // 10 tokens
        existingTests: ["d".repeat(80)], // 20 tokens
      });
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.relevantFiles).toBe(Math.ceil(201 / 4)); // 51
      expect(estimate.relatedPatterns).toBe(10);
      expect(estimate.existingTests).toBe(20);
    });

    it("should include conventions summary and individual docs", () => {
      const ctx = makeMinimalContext({
        conventionsSummary: "s".repeat(40), // 10 tokens alone
        conventions: {
          "STYLE-001": "c".repeat(80), // 20 tokens alone
        },
      });
      const estimate = estimateTokensForContext(ctx);

      // Summary + doc joined by newline: 40 + 1 + 80 = 121 chars → 31 tokens
      expect(estimate.conventions).toBe(Math.ceil(121 / 4));
    });

    it("should compute total as sum of all sections", () => {
      const ctx = makeMinimalContext({
        taskSpec: "a".repeat(400), // 100
        blueprint: "b".repeat(200), // 50
        repoMap: "r".repeat(40), // 10
        relevantFiles: ["f".repeat(80)], // 20
        relatedPatterns: ["p".repeat(40)], // 10
        existingTests: ["t".repeat(40)], // 10
        conventionsSummary: "s".repeat(40), // 10
        claudeMd: ["m".repeat(40)], // 10
      });
      const estimate = estimateTokensForContext(ctx);

      const expectedTotal =
        estimate.taskSpec +
        estimate.blueprint +
        estimate.repoMap +
        estimate.relevantFiles +
        estimate.relatedPatterns +
        estimate.existingTests +
        estimate.conventions +
        estimate.claudeMd;

      expect(estimate.total).toBe(expectedTotal);
    });

    it("should report withinBudget=false when over default budget", () => {
      // Default budget is 30K tokens → ~120K chars
      const ctx = makeMinimalContext({
        taskSpec: "x".repeat(130_000), // 32,500 tokens > 30K
      });
      const estimate = estimateTokensForContext(ctx);

      expect(estimate.withinBudget).toBe(false);
    });

    it("should support custom budget parameter", () => {
      const ctx = makeMinimalContext({
        taskSpec: "x".repeat(400), // 100 tokens
      });

      const withinBudget = estimateTokensForContext(ctx, 200);
      expect(withinBudget.withinBudget).toBe(true);

      const overBudget = estimateTokensForContext(ctx, 50);
      expect(overBudget.withinBudget).toBe(false);
    });

    it("should return proper ContextSizeEstimate shape", () => {
      const ctx = makeMinimalContext({ taskSpec: "hello world" });
      const estimate: ContextSizeEstimate = estimateTokensForContext(ctx);

      expect(typeof estimate.taskSpec).toBe("number");
      expect(typeof estimate.blueprint).toBe("number");
      expect(typeof estimate.repoMap).toBe("number");
      expect(typeof estimate.relevantFiles).toBe("number");
      expect(typeof estimate.relatedPatterns).toBe("number");
      expect(typeof estimate.existingTests).toBe("number");
      expect(typeof estimate.conventions).toBe("number");
      expect(typeof estimate.claudeMd).toBe("number");
      expect(typeof estimate.total).toBe("number");
      expect(typeof estimate.withinBudget).toBe("boolean");
    });
  });
});
