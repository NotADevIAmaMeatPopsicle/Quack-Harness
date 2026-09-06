import type { IEventWriter } from "../monitor/event-emitter.js";
import { JudgmentContractError } from "./judgment-reducer.js";
import type {
  JudgmentDecision,
  JudgmentProjectionFailure,
  JudgmentStage,
} from "./judgment-types.js";

const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface JudgmentEventIdentity {
  taskId: string;
  stage: JudgmentStage;
  attempt?: number;
  sequence?: number;
  final?: boolean;
}

export type ContainedJudgmentProjection =
  | { decision: JudgmentDecision; failure?: never }
  | { decision?: never; failure: JudgmentProjectionFailure };

export function containJudgmentProjection(
  project: () => JudgmentDecision,
): ContainedJudgmentProjection {
  try {
    return { decision: project() };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: {
        errorCode:
          error instanceof JudgmentContractError ? error.code : "unexpected_projection_error",
        message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      },
    };
  }
}

/**
 * Run one additive projection without allowing projection defects to alter the
 * legacy pipeline. Contract errors remain visible as typed failure events.
 */
export function emitJudgmentProjection(
  events: IEventWriter | undefined,
  identity: JudgmentEventIdentity,
  project: () => JudgmentDecision,
): JudgmentDecision | undefined {
  const projected = containJudgmentProjection(project);
  if (projected.decision) {
    const { decision } = projected;
    events?.emit("judgment_decision", {
      ...identity,
      decision,
    });
    return decision;
  }
  events?.emit("judgment_projection_failed", {
    taskId: identity.taskId,
    stage: identity.stage,
    ...projected.failure,
    ...(identity.attempt === undefined ? {} : { attempt: identity.attempt }),
    ...(identity.sequence === undefined ? {} : { sequence: identity.sequence }),
  });
  return undefined;
}
