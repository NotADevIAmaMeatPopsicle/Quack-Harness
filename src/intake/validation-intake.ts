import { loadAdapter, type ProjectAdapter } from "../core/adapter-loader.js";

import { runEvidenceGate, type EvidenceGateResult } from "./evidence-gate.js";
import { runScopeHygieneGate, type ScopeHygieneResult } from "./scope-hygiene-gate.js";
import type { ValidationIntakePayload } from "./task-intake.js";

const DEFAULT_DRIFT_THRESHOLD = 5;

/**
 * Common shape returned from both the dry-run and persist paths. The two
 * gate results plus the driftThreshold actually applied. PASS only when
 * BOTH gates PASS — either REVISE composes to overall REVISE.
 */
export interface ValidationIntakeDryRunResult {
  verdict: "PASS" | "REVISE";
  scopeHygiene: ScopeHygieneResult;
  evidence: EvidenceGateResult;
  driftThreshold: number;
}

/**
 * Persist-path result extends the dry-run shape with the generated spec
 * artifacts when both gates passed. When the persist path runs against a
 * REVISE outcome, taskId/specPath/evidencePath are undefined and the caller
 * is expected to NOT write a record.
 */
export interface ValidationIntakePersistResult extends ValidationIntakeDryRunResult {
  taskId?: string;
  specPath?: string;
  evidencePath?: string;
}

export interface ValidationIntakeDryRunArgs {
  projectRoot: string;
  payload: ValidationIntakePayload;
}

export interface ValidationIntakePersistArgs {
  projectRoot: string;
  projectId: string;
  payload: ValidationIntakePayload;
  intakeRecordId: string;
}

/**
 * Resolve the project's configured drift threshold. Reads the adapter on
 * demand (per blueprint §3 + §11 — orchestrator owns the adapter load so
 * the gates stay pure). Falls back to DEFAULT_DRIFT_THRESHOLD = 5 when the
 * adapter does not declare a `validationIntake` block.
 *
 * Exported so tests can verify resolution behaviour without round-tripping
 * through the gates.
 */
export function resolveDriftThreshold(adapter: ProjectAdapter): number {
  const block = adapter.config.validationIntake;
  if (!block) return DEFAULT_DRIFT_THRESHOLD;
  if (typeof block.driftThreshold !== "number") return DEFAULT_DRIFT_THRESHOLD;
  return block.driftThreshold;
}

/**
 * Compose two gate verdicts into the final intake-level verdict. PASS only
 * when both gates PASS; otherwise REVISE.
 */
function composeVerdict(
  scopeHygiene: ScopeHygieneResult,
  evidence: EvidenceGateResult,
): "PASS" | "REVISE" {
  if (scopeHygiene.verdict === "REVISE") return "REVISE";
  if (evidence.verdict === "REVISE") return "REVISE";
  return "PASS";
}

/**
 * Dry-run entrypoint for `POST /v1/intake/tasks/validate` with intakeType="validation".
 *
 * Loads the project adapter (for the driftThreshold override), runs BOTH
 * gates against the payload, and returns the composed result. Does NOT
 * persist anything, does NOT write a spec. Suitable for the example-side
 * `/polish-handoff` pre-flight check.
 *
 * Throws when:
 *   - The adapter is not loadable (no `.quack/adapter.json`).
 *   - The scope-hygiene gate cannot resolve `commitRange` (the throw is
 *     surfaced as a 500 by the route layer — distinct from a 422 REVISE).
 */
export async function runValidationIntakeDryRun(
  args: ValidationIntakeDryRunArgs,
): Promise<ValidationIntakeDryRunResult> {
  const { projectRoot, payload } = args;

  const adapter = await loadAdapter(projectRoot);
  const driftThreshold = resolveDriftThreshold(adapter);

  const scopeHygiene = await runScopeHygieneGate(projectRoot, payload, driftThreshold);
  const evidence = await runEvidenceGate(projectRoot, payload);

  return {
    verdict: composeVerdict(scopeHygiene, evidence),
    scopeHygiene,
    evidence,
    driftThreshold,
  };
}

/**
 * Persist entrypoint for `POST /v1/intake/tasks` with intakeType="validation".
 *
 * Runs the SAME gates as the dry-run path. On PASS, the route handler is
 * responsible for invoking `generateValidationSpec()` (owned by
 * spec-gen-builder) and writing the IntakeStore record. We DO NOT generate
 * the spec here in MVP — keeping the orchestrator pure of file-system writes
 * lets the route layer compose the spec-gen + IntakeStore.create() steps in
 * the order that matches the existing forward-intake flow. The
 * `taskId / specPath / evidencePath` fields on the result are populated
 * AFTER the route layer calls the spec generator (route layer overwrites
 * these on success).
 *
 * For now, returns the gate result with the persist-path shape so the route
 * layer can branch consistently.
 */
export async function runValidationIntakePersist(
  args: ValidationIntakePersistArgs,
): Promise<ValidationIntakePersistResult> {
  const dryRun = await runValidationIntakeDryRun({
    projectRoot: args.projectRoot,
    payload: args.payload,
  });

  return dryRun;
}
