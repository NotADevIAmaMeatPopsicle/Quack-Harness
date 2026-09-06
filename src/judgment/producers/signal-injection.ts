// ─── Signal Injection Layer (TASK-1313) ─────────────────────────────
// Converts TASK-1312 producer facts into judgment-plane signals for the
// loop_diff and judge stages, honoring the safetyFloor.signals mode:
//
//   off     — nothing injected (today's behavior; absent config = off).
//   report  — facts injected as VISIBLE, NON-BLOCKING signals: safety-
//             tier facts are DEMOTED to human_review disposition. The
//             reducer never sees a safety disposition from this layer.
//   enforce — safety-tier facts (those carrying a candidateSafetyCode)
//             inject with `safety` disposition + that code; the TASK-1310
//             reducer forces `stop` and the dispatcher's control
//             transitions (TASK-1313 S2) end the dispatch.
//
// PRECISION INVARIANT (the 1312 Intent governs): a fact WITHOUT a
// candidateSafetyCode can NEVER acquire safety disposition here, in any
// mode. Tier-R conformance and shape-only deploy facts map to advisory;
// denied-path / outside-writable / human_review-tier secret findings map
// to human_review. Evidence carries only the masked/truncated fact
// fields the producers already emit.

import type { JudgmentSignal, JudgmentStage } from "../judgment-types.js";
import type { SafetySignalsMode } from "../runner/intent-judgment-config.js";
import type { BranchMutationFact } from "./branch-mutation.js";
import type { DeployFact } from "./deploy-classifier.js";
import type { SealConformanceFact, SealConformanceSummary } from "./seal-conformance.js";
import type { SecretFinding, SecretScanSummary } from "./secret-scan.js";

export type InjectableFact = SealConformanceFact | SecretFinding | BranchMutationFact | DeployFact;

export interface InjectionInput {
  sealConformance?: SealConformanceSummary;
  secretScan?: SecretScanSummary;
  workerFacts?: Array<BranchMutationFact | DeployFact>;
}

function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function dispositionFor(
  fact: InjectableFact,
  mode: SafetySignalsMode,
): JudgmentSignal["disposition"] {
  const hasSafetyCode = "candidateSafetyCode" in fact && fact.candidateSafetyCode !== undefined;
  if (hasSafetyCode) {
    return mode === "enforce" ? "safety" : "human_review";
  }
  // Non-candidate facts keep the producers' tiering.
  if (fact.kind === "seal_conformance_path") {
    return fact.classification === "verification_tier_r" ? "advisory" : "human_review";
  }
  if (fact.kind === "secret") {
    // Safety-tier secrets always carry the candidate code (1312), so a
    // code-less secret finding is human_review-tier by construction.
    return "human_review";
  }
  if (fact.kind === "deploy") {
    return fact.tier === "shape_only" ? "advisory" : "human_review";
  }
  // branch_mutation without a candidate code (plain write attempts).
  return "advisory";
}

function signalFor(
  stage: JudgmentStage,
  fact: InjectableFact,
  mode: SafetySignalsMode,
): JudgmentSignal {
  const disposition = dispositionFor(fact, mode);
  const safetyCode =
    disposition === "safety" && "candidateSafetyCode" in fact
      ? fact.candidateSafetyCode
      : undefined;

  if (fact.kind === "seal_conformance_path") {
    return {
      source: stage,
      code: `seal_${fact.classification}`,
      disposition,
      message: `Sealed change-set path classified ${fact.classification}: ${fact.path}`,
      deterministic: true,
      evidence: [fact.path, `status=${fact.status}`],
      ...(safetyCode ? { safetyCode } : {}),
    };
  }
  if (fact.kind === "secret") {
    return {
      source: stage,
      code: `secret_${fact.patternId}`,
      disposition,
      message: `Secret scan ${fact.tier}-tier finding (${fact.patternId}) in ${fact.file}`,
      deterministic: true,
      evidence: [
        fact.file,
        ...(fact.line !== undefined ? [`line=${fact.line}`] : []),
        fact.maskedExcerpt,
        ...(fact.demotedBy ? [`demoted=${fact.demotedBy}`] : []),
      ],
      ...(safetyCode ? { safetyCode } : {}),
    };
  }
  if (fact.kind === "branch_mutation") {
    return {
      source: stage,
      code: `attempt_${fact.mutationClass}`,
      disposition,
      message: `Worker attempted a denied git ${fact.mutationClass} (${fact.verb})`,
      deterministic: true,
      evidence: [truncate(fact.segment), ...(fact.targetRef ? [`target=${fact.targetRef}`] : [])],
      ...(safetyCode ? { safetyCode } : {}),
    };
  }
  return {
    source: stage,
    code: `deploy_${fact.tier}`,
    disposition,
    message: `Deploy-shaped command observed (${fact.verb}, ${fact.tier})`,
    deterministic: true,
    evidence: [truncate(fact.segment), ...(fact.marker ? [`marker=${fact.marker}`] : [])],
    ...(safetyCode ? { safetyCode } : {}),
  };
}

/**
 * Convert producer facts into stage signals per the mode. Pure. Returns
 * an empty array in off mode (or for empty inputs) so call sites can
 * unconditionally spread the result.
 */
export function factsToSignals(
  stage: JudgmentStage,
  input: InjectionInput,
  mode: SafetySignalsMode,
): JudgmentSignal[] {
  if (mode === "off") return [];
  const facts: InjectableFact[] = [
    ...(input.sealConformance?.facts ?? []),
    ...(input.secretScan?.findings ?? []),
    ...(input.workerFacts ?? []),
  ];
  return facts.map((fact) => signalFor(stage, fact, mode));
}
