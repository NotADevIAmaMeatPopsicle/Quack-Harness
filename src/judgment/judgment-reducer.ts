import {
  JUDGMENT_SCHEMA_VERSION,
  JUDGMENT_SIGNAL_DISPOSITIONS,
  JUDGMENT_STAGES,
  INTENT_JUDGMENT_ACTIONS,
  SAFETY_FLOOR_CODES,
  type IntentJudgment,
  type JudgmentContractErrorCode,
  type JudgmentDecision,
  type JudgmentSignal,
  type JudgmentStage,
} from "./judgment-types.js";

export class JudgmentContractError extends Error {
  constructor(
    readonly code: JudgmentContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JudgmentContractError";
  }
}

export interface ReduceJudgmentInput {
  stage: JudgmentStage;
  signals: JudgmentSignal[];
  judgment: IntentJudgment;
}

function copySignal(signal: JudgmentSignal): JudgmentSignal {
  return {
    ...signal,
    ...(signal.evidence ? { evidence: [...signal.evidence] } : {}),
  };
}

function validateSignal(signal: JudgmentSignal, index: number): void {
  if (!(JUDGMENT_STAGES as readonly string[]).includes(signal.source)) {
    throw new JudgmentContractError(
      "invalid_stage",
      `signals[${index}].source is not a canonical judgment stage`,
    );
  }
  if (!signal.code.trim()) {
    throw new JudgmentContractError(
      "invalid_signal_code",
      `signals[${index}].code must not be empty`,
    );
  }
  if (!signal.message.trim()) {
    throw new JudgmentContractError(
      "invalid_signal_message",
      `signals[${index}].message must not be empty`,
    );
  }
  if (!(JUDGMENT_SIGNAL_DISPOSITIONS as readonly string[]).includes(signal.disposition)) {
    throw new JudgmentContractError(
      "invalid_signal_disposition",
      `signals[${index}].disposition is not canonical`,
    );
  }

  if (signal.disposition === "safety") {
    if (!signal.safetyCode) {
      throw new JudgmentContractError(
        "safety_code_required",
        `signals[${index}] is safety-dispositioned but has no safetyCode`,
      );
    }
    if (!(SAFETY_FLOOR_CODES as readonly string[]).includes(signal.safetyCode)) {
      throw new JudgmentContractError(
        "invalid_safety_code",
        `signals[${index}].safetyCode is not canonical`,
      );
    }
  } else if (signal.safetyCode !== undefined) {
    throw new JudgmentContractError(
      "safety_code_forbidden",
      `signals[${index}] has safetyCode without safety disposition`,
    );
  }
}

/**
 * Resolve one normalized judgment. Safety signals are the only input capable
 * of producing stop; ordinary policy findings preserve the intent action.
 */
export function reduceJudgment(input: ReduceJudgmentInput): JudgmentDecision {
  if (!(JUDGMENT_STAGES as readonly string[]).includes(input.stage)) {
    throw new JudgmentContractError("invalid_stage", `stage "${input.stage}" is not canonical`);
  }

  if (!["legacy_policy", "intent_model", "operator"].includes(input.judgment.source)) {
    throw new JudgmentContractError("invalid_judgment_source", "judgment.source is not canonical");
  }
  if (!(INTENT_JUDGMENT_ACTIONS as readonly string[]).includes(input.judgment.action)) {
    throw new JudgmentContractError(
      "invalid_judgment_action",
      "judgment.action cannot request stop or an unknown action",
    );
  }

  input.signals.forEach(validateSignal);
  const signals = input.signals.map(copySignal);
  const blockers = signals.filter((signal) => signal.disposition === "safety");
  const judgment: IntentJudgment = {
    ...input.judgment,
    rationale: [...input.judgment.rationale],
  };
  const safetyRationale = blockers.map((signal) => `safety_floor:${signal.safetyCode as string}`);

  return {
    schemaVersion: JUDGMENT_SCHEMA_VERSION,
    stage: input.stage,
    signals,
    judgment,
    safetyFloor: {
      passed: blockers.length === 0,
      blockers,
    },
    action: blockers.length > 0 ? "stop" : judgment.action,
    rationale: blockers.length > 0 ? safetyRationale : [...judgment.rationale],
  };
}
