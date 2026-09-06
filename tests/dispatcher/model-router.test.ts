// ─── Model Router Tests ─────────────────────────────────────────────

import { resolveModel, getNextTierModel, COMPLEX_TAGS } from "../../src/dispatcher/model-router.js";
import type { ModelRoutingConfig, AdapterAgentConfig } from "../../src/core/types.js";

describe("model-router", () => {
  // ─── Fixtures ────────────────────────────────────────────────────

  const defaultRouting: ModelRoutingConfig = {
    gateModel: "claude-haiku-4-5-20251001",
    enrichModel: "claude-haiku-4-5-20251001",
    plannerModel: "claude-haiku-4-5-20251001",
    workerModel: "claude-sonnet-4-6",
    workerComplexModel: "claude-opus-4-6",
    judgeModel: "claude-sonnet-4-6",
    retryEscalation: true,
  };

  const legacyAgent: AdapterAgentConfig = {
    model: "claude-opus-4-6",
    judgeModel: "claude-sonnet-4-6",
    enrichModel: "claude-sonnet-4-6",
    maxTurns: 50,
    maxBudgetPerTask: 5.0,
    maxRetries: 1,
  };

  // ─── resolveModel with routing config ────────────────────────────

  describe("resolveModel with routing config", () => {
    test("returns gateModel for gate stage", () => {
      const model = resolveModel(defaultRouting, legacyAgent, { stage: "gate" });
      expect(model).toBe("claude-haiku-4-5-20251001");
    });

    test("returns enrichModel for enrich stage", () => {
      const model = resolveModel(defaultRouting, legacyAgent, { stage: "enrich" });
      expect(model).toBe("claude-haiku-4-5-20251001");
    });

    test("returns plannerModel for plan stage", () => {
      const model = resolveModel(defaultRouting, legacyAgent, { stage: "plan" });
      expect(model).toBe("claude-haiku-4-5-20251001");
    });

    test("returns workerModel for worker stage without tags", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: [],
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("returns workerModel for worker stage with no tags", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("returns judgeModel for judge stage", () => {
      const model = resolveModel(defaultRouting, legacyAgent, { stage: "judge" });
      expect(model).toBe("claude-sonnet-4-6");
    });
  });

  // ─── Complexity tags ─────────────────────────────────────────────

  describe("complexity tags", () => {
    test("returns workerComplexModel when task has architecture tag", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["architecture"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("returns workerComplexModel when task has refactor tag", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["refactor"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("returns workerComplexModel when task has design tag", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["design"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("returns workerComplexModel when task has migration tag", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["migration"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("returns workerComplexModel for case-insensitive tag match", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["Architecture"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("returns workerModel when tags are non-complex", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["bugfix", "testing", "documentation"],
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("returns workerComplexModel when mixed tags contain a complex one", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["bugfix", "architecture", "testing"],
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("P0-CRITICAL priority alone does not auto-escalate (only tags do)", () => {
      // Priority is not passed as a tag by default - only explicit tags matter
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["P0-CRITICAL"],
      });
      expect(model).toBe("claude-sonnet-4-6");
    });
  });

  // ─── Retry escalation ───────────────────────────────────────────

  describe("retry escalation", () => {
    test("does not escalate on retryAttempt 0", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: [],
        retryAttempt: 0,
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("escalates Sonnet to Opus on retryAttempt 1", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: [],
        retryAttempt: 1,
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("escalates Haiku to Sonnet on retryAttempt 1", () => {
      const routing: ModelRoutingConfig = {
        ...defaultRouting,
        workerModel: "claude-haiku-4-5-20251001",
      };
      const model = resolveModel(routing, legacyAgent, {
        stage: "worker",
        taskTags: [],
        retryAttempt: 1,
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("stays at Opus when already at highest tier", () => {
      const routing: ModelRoutingConfig = {
        ...defaultRouting,
        workerModel: "claude-opus-4-6",
      };
      const model = resolveModel(routing, legacyAgent, {
        stage: "worker",
        taskTags: [],
        retryAttempt: 1,
      });
      expect(model).toBe("claude-opus-4-6");
    });

    test("does not escalate when retryEscalation is false", () => {
      const routing: ModelRoutingConfig = {
        ...defaultRouting,
        retryEscalation: false,
      };
      const model = resolveModel(routing, legacyAgent, {
        stage: "worker",
        taskTags: [],
        retryAttempt: 1,
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("does not escalate for non-worker stages", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "judge",
        retryAttempt: 1,
      });
      expect(model).toBe("claude-sonnet-4-6");
    });

    test("escalates complex model (Opus stays Opus)", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: ["architecture"],
        retryAttempt: 1,
      });
      // workerComplexModel is Opus, which is already top tier
      expect(model).toBe("claude-opus-4-6");
    });

    test("retryAttempt undefined does not escalate", () => {
      const model = resolveModel(defaultRouting, legacyAgent, {
        stage: "worker",
        taskTags: [],
      });
      expect(model).toBe("claude-sonnet-4-6");
    });
  });

  // ─── Legacy fallback (no routing config) ────────────────────────

  describe("legacy fallback (no routing config)", () => {
    test("returns legacy model for gate stage", () => {
      const model = resolveModel(undefined, legacyAgent, { stage: "gate" });
      expect(model).toBe(legacyAgent.model);
    });

    test("returns legacy enrichModel for enrich stage", () => {
      const model = resolveModel(undefined, legacyAgent, { stage: "enrich" });
      expect(model).toBe(legacyAgent.enrichModel);
    });

    test("returns legacy enrichModel for plan stage", () => {
      const model = resolveModel(undefined, legacyAgent, { stage: "plan" });
      expect(model).toBe(legacyAgent.enrichModel);
    });

    test("returns legacy model for worker stage", () => {
      const model = resolveModel(undefined, legacyAgent, { stage: "worker" });
      expect(model).toBe(legacyAgent.model);
    });

    test("returns legacy judgeModel for judge stage", () => {
      const model = resolveModel(undefined, legacyAgent, { stage: "judge" });
      expect(model).toBe(legacyAgent.judgeModel);
    });

    test("ignores taskTags and retryAttempt when no routing config", () => {
      const model = resolveModel(undefined, legacyAgent, {
        stage: "worker",
        taskTags: ["architecture"],
        retryAttempt: 2,
      });
      // Without routing, always returns legacy model regardless of tags/retries
      expect(model).toBe(legacyAgent.model);
    });
  });

  // ─── getNextTierModel ──────────────────────────────────────────

  describe("getNextTierModel", () => {
    test("escalates Haiku to Sonnet", () => {
      expect(getNextTierModel("claude-haiku-4-5-20251001")).toBe("claude-sonnet-4-6");
    });

    test("escalates Sonnet to Opus", () => {
      expect(getNextTierModel("claude-sonnet-4-6")).toBe("claude-opus-4-6");
    });

    test("returns same model when already at highest tier (Opus)", () => {
      expect(getNextTierModel("claude-opus-4-6")).toBe("claude-opus-4-6");
    });

    test("returns same model for unknown model identifier", () => {
      expect(getNextTierModel("custom-model-v1")).toBe("custom-model-v1");
    });
  });

  // ─── COMPLEX_TAGS export ────────────────────────────────────────

  describe("COMPLEX_TAGS", () => {
    test("includes expected tags", () => {
      expect(COMPLEX_TAGS).toContain("architecture");
      expect(COMPLEX_TAGS).toContain("refactor");
      expect(COMPLEX_TAGS).toContain("design");
      expect(COMPLEX_TAGS).toContain("migration");
    });

    test("has exactly 4 tags", () => {
      expect(COMPLEX_TAGS).toHaveLength(4);
    });
  });
});
