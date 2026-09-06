import type { RuntimeStateAuthority } from "../core/worker-protocol.js";
import type { SessionCompletePayload } from "./event-types.js";
import {
  recordVerification,
  type RecordVerificationResult,
  type VerificationStoreProject,
} from "./verification-store.js";
import type { DuplicateClaimantIndex } from "../core/duplicate-claimants.js";

export type LoopFinalizeSkipReason =
  | "non-canonical-authority"
  | "missing-project-root"
  | "not-loop"
  | "recording-disabled"
  | "lifecycle-not-verified"
  | "not-auto-merged"
  | "missing-merge-sha";

export type LoopFinalizeResult =
  | { attempted: false; reason: LoopFinalizeSkipReason }
  | { attempted: true; commit: string; record: RecordVerificationResult };

export interface LoopFinalizeDependencies {
  project: VerificationStoreProject;
  getCriteriaCount(taskId: string): Promise<number>;
  recorder?: typeof recordVerification;
  claimantIndex?: DuplicateClaimantIndex;
}

/** Canonical, fail-closed loop finalization writer. */
export async function recordLoopFinalization(
  stateAuthority: RuntimeStateAuthority,
  taskId: string,
  payload: SessionCompletePayload,
  dependencies: LoopFinalizeDependencies,
): Promise<LoopFinalizeResult> {
  if (stateAuthority !== "canonical") {
    return { attempted: false, reason: "non-canonical-authority" };
  }
  if (!dependencies.project.projectRoot) {
    return { attempted: false, reason: "missing-project-root" };
  }
  if (payload.executionMode !== "loop") {
    return { attempted: false, reason: "not-loop" };
  }
  if (payload.recordOnFinalize !== true) {
    return { attempted: false, reason: "recording-disabled" };
  }
  if (payload.lifecycleVerified !== true) {
    return { attempted: false, reason: "lifecycle-not-verified" };
  }
  if (payload.autoMerged !== true) {
    return { attempted: false, reason: "not-auto-merged" };
  }
  if (typeof payload.mergeCommitSha !== "string" || payload.mergeCommitSha.trim() === "") {
    return { attempted: false, reason: "missing-merge-sha" };
  }

  const criteriaCount = await dependencies.getCriteriaCount(taskId);
  const recorder = dependencies.recorder ?? recordVerification;
  const entry = {
    taskId,
    verdict: "SOFT-VERIFIED" as const,
    commitSha: payload.mergeCommitSha,
    method: "loop-finalize",
    criteriaChecked: criteriaCount,
    criteriaPassed: criteriaCount,
    notes: "loop-finalize: lifecycle verified and auto-merged",
  };
  const options = { skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"] };
  const record = dependencies.claimantIndex
    ? await recorder(dependencies.project, entry, options, dependencies.claimantIndex)
    : await recorder(dependencies.project, entry, options);

  return { attempted: true, commit: payload.mergeCommitSha, record };
}
