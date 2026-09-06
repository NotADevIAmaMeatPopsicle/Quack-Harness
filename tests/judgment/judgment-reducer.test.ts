import { JudgmentContractError, reduceJudgment } from "../../src/judgment/judgment-reducer.js";
import {
  SAFETY_FLOOR_CODES,
  type IntentJudgmentAction,
  type JudgmentSignal,
} from "../../src/judgment/judgment-types.js";

const baseSignal: JudgmentSignal = {
  source: "readiness",
  code: "ordinary_finding",
  disposition: "advisory",
  message: "ordinary",
  deterministic: true,
};

describe("reduceJudgment", () => {
  it.each(["continue", "repair", "human_review"] as const)(
    "preserves non-safety action %s",
    (action) => {
      const decision = reduceJudgment({
        stage: "readiness",
        signals: [baseSignal],
        judgment: { source: "legacy_policy", action, rationale: [action] },
      });
      expect(decision.action).toBe(action);
      expect(decision.safetyFloor).toEqual({ passed: true, blockers: [] });
    },
  );

  it.each(SAFETY_FLOOR_CODES)("forces stop for %s", (safetyCode) => {
    const decision = reduceJudgment({
      stage: "readiness",
      signals: [
        {
          ...baseSignal,
          code: safetyCode,
          disposition: "safety",
          safetyCode,
        },
      ],
      judgment: {
        source: "legacy_policy",
        action: "continue",
        rationale: ["would continue"],
      },
    });
    expect(decision.action).toBe("stop");
    expect(decision.safetyFloor.passed).toBe(false);
    expect(decision.rationale).toEqual([`safety_floor:${safetyCode}`]);
  });

  it("keeps multiple blockers in input order", () => {
    const safetyCodes = SAFETY_FLOOR_CODES.slice(0, 2);
    const decision = reduceJudgment({
      stage: "readiness",
      signals: safetyCodes.map((safetyCode) => ({
        ...baseSignal,
        code: safetyCode,
        disposition: "safety" as const,
        safetyCode,
      })),
      judgment: { source: "legacy_policy", action: "repair", rationale: [] },
    });
    expect(decision.safetyFloor.blockers.map((item) => item.safetyCode)).toEqual(safetyCodes);
  });

  it("rejects malformed safety claims", () => {
    const captureCode = (run: () => unknown): string | undefined => {
      try {
        run();
        return undefined;
      } catch (error) {
        return error instanceof JudgmentContractError ? error.code : undefined;
      }
    };

    expect(
      captureCode(() =>
        reduceJudgment({
          stage: "readiness",
          signals: [{ ...baseSignal, disposition: "safety" }],
          judgment: { source: "legacy_policy", action: "continue", rationale: [] },
        }),
      ),
    ).toBe("safety_code_required");

    expect(
      captureCode(() =>
        reduceJudgment({
          stage: "readiness",
          signals: [{ ...baseSignal, safetyCode: "secret_exposure" }],
          judgment: { source: "legacy_policy", action: "continue", rationale: [] },
        }),
      ),
    ).toBe("safety_code_forbidden");
  });

  it("does not mutate nested input arrays", () => {
    const signal = { ...baseSignal, evidence: ["before"] };
    const rationale = ["before"];
    const decision = reduceJudgment({
      stage: "readiness",
      signals: [signal],
      judgment: { source: "legacy_policy", action: "continue", rationale },
    });
    decision.signals[0].evidence?.push("after");
    decision.judgment.rationale.push("after");
    expect(signal.evidence).toEqual(["before"]);
    expect(rationale).toEqual(["before"]);
  });

  it("uses the typed contract error", () => {
    try {
      reduceJudgment({
        stage: "readiness",
        signals: [{ ...baseSignal, code: "" }],
        judgment: { source: "legacy_policy", action: "continue", rationale: [] },
      });
      throw new Error("expected reduceJudgment to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(JudgmentContractError);
      expect(error).toMatchObject({ code: "invalid_signal_code" });
    }
  });

  it("rejects stop when it is smuggled into the intent judgment", () => {
    try {
      reduceJudgment({
        stage: "judge",
        signals: [],
        judgment: {
          source: "legacy_policy",
          action: "stop" as IntentJudgmentAction,
          rationale: [],
        },
      });
      throw new Error("expected reduceJudgment to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(JudgmentContractError);
      expect(error).toMatchObject({ code: "invalid_judgment_action" });
    }
  });
});
