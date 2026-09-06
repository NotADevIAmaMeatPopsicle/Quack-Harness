import type { IEventWriter } from "../../src/monitor/event-emitter.js";
import type {
  EventPayload,
  EventStage,
  JudgmentDecisionPayload,
  JudgmentProjectionFailedPayload,
} from "../../src/monitor/event-types.js";
import { emitJudgmentProjection } from "../../src/judgment/judgment-events.js";
import { JudgmentContractError } from "../../src/judgment/judgment-reducer.js";
import { reduceJudgment } from "../../src/judgment/judgment-reducer.js";

function writer(): {
  events: Array<{ stage: EventStage; payload: EventPayload }>;
  value: IEventWriter;
} {
  const events: Array<{ stage: EventStage; payload: EventPayload }> = [];
  return {
    events,
    value: {
      sessionId: "session",
      taskId: "TASK-1310",
      project: "quack",
      emit(stage, payload) {
        events.push({ stage, payload });
      },
      recordSession() {},
    },
  };
}

describe("emitJudgmentProjection", () => {
  it("emits a JSON-safe decision with explicit ordering identity", () => {
    const target = writer();
    const decision = emitJudgmentProjection(
      target.value,
      {
        taskId: "TASK-1310",
        stage: "judge",
        attempt: 2,
        sequence: 3,
        final: true,
      },
      () =>
        reduceJudgment({
          stage: "judge",
          signals: [],
          judgment: {
            source: "legacy_policy",
            action: "continue",
            rationale: ["approved"],
          },
        }),
    );

    expect(decision?.action).toBe("continue");
    expect(target.events).toHaveLength(1);
    expect(target.events[0].stage).toBe("judgment_decision");
    const payload = target.events[0].payload as JudgmentDecisionPayload;
    expect(payload).toMatchObject({
      taskId: "TASK-1310",
      stage: "judge",
      attempt: 2,
      sequence: 3,
      final: true,
    });
    expect(() => JSON.stringify(target.events[0])).not.toThrow();
  });

  it("contains contract errors and preserves their stable code", () => {
    const target = writer();
    const decision = emitJudgmentProjection(
      target.value,
      {
        taskId: "TASK-1310",
        stage: "readiness",
      },
      () => {
        throw new JudgmentContractError("safety_code_required", "bad signal");
      },
    );
    expect(decision).toBeUndefined();
    expect(target.events).toHaveLength(1);
    expect(target.events[0].stage).toBe("judgment_projection_failed");
    const payload = target.events[0].payload as JudgmentProjectionFailedPayload;
    expect(payload.errorCode).toBe("safety_code_required");
    expect(payload.message).toBe("bad signal");
  });

  it("bounds unexpected error text", () => {
    const target = writer();
    emitJudgmentProjection(
      target.value,
      {
        taskId: "TASK-1310",
        stage: "docs_review",
      },
      () => {
        throw new Error("x".repeat(1_000));
      },
    );
    const payload = target.events[0].payload as { errorCode: string; message: string };
    expect(payload.errorCode).toBe("unexpected_projection_error");
    expect(payload.message).toHaveLength(500);
  });
});
