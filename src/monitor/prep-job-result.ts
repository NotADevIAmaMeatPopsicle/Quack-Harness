export interface PrepGateResult {
  schemaValid: boolean;
  schemaErrors: string[];
  depthScore: number;
  depthReady: boolean;
  deficiencies: string[];
  outcome: "pass" | "enriched" | "rejected";
  contentHash?: string;
}

/** A computed rejection is a valid result; a parseable error object is not. */
export function parsePrepGateResult(value: unknown): PrepGateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prep output must be a complete gate-result object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string")
    throw new Error(`Prep child reported an error: ${record.error}`);
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((item) => typeof item === "string");
  if (
    "error" in record ||
    typeof record.schemaValid !== "boolean" ||
    !strings(record.schemaErrors) ||
    typeof record.depthScore !== "number" ||
    !Number.isFinite(record.depthScore) ||
    record.depthScore < 0 ||
    record.depthScore > 5 ||
    typeof record.depthReady !== "boolean" ||
    !strings(record.deficiencies) ||
    typeof record.outcome !== "string" ||
    !["pass", "enriched", "rejected"].includes(record.outcome) ||
    (record.contentHash !== undefined &&
      (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(record.contentHash)))
  ) {
    throw new Error("Prep output does not match the gate-result contract");
  }
  const accepted = record.outcome !== "rejected";
  if (
    accepted !== (record.schemaValid && record.depthReady) ||
    (record.schemaValid && record.schemaErrors.length !== 0) ||
    (!record.schemaValid && record.depthReady)
  ) {
    throw new Error("Prep output contains inconsistent readiness and outcome fields");
  }
  return {
    schemaValid: record.schemaValid,
    schemaErrors: record.schemaErrors,
    depthScore: record.depthScore,
    depthReady: record.depthReady,
    deficiencies: record.deficiencies,
    outcome: record.outcome as PrepGateResult["outcome"],
    ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
  };
}
