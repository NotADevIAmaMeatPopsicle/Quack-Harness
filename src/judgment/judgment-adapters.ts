import type {
  DepthEvalResult,
  EnforcementDemotion,
  GateResult,
  JudgeResult,
  JudgeVerdict,
  PostJudgeResult,
  SchemaCheckResult,
} from "../core/types.js";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";
import { reduceJudgment } from "./judgment-reducer.js";
import type { JudgmentDecision, JudgmentSignal } from "./judgment-types.js";

interface DocsIssueLike {
  code: string;
  message: string;
  blocking: boolean;
  field?: string;
  blockReasonCode?: string;
}

export interface JudgePathAuditFacts {
  total: number;
  valid: string[];
  hallucinated: string[];
  hallucinationRate: number;
  overridden: boolean;
}

function isSchemaResult(
  details: SchemaCheckResult | DepthEvalResult,
): details is SchemaCheckResult {
  return "valid" in details && "missing" in details;
}

function verdictAction(verdict: JudgeVerdict): "continue" | "repair" | "human_review" {
  if (verdict === "APPROVE") return "continue";
  if (verdict === "REVISE") return "repair";
  return "human_review";
}

function evidence(values: Array<string | undefined>): string[] | undefined {
  const present = values.filter((value): value is string => Boolean(value?.trim()));
  return present.length > 0 ? present : undefined;
}

export function projectReadinessDecision(result: GateResult): JudgmentDecision {
  const signals: JudgmentSignal[] = [];
  const advisories = result.outcome === "rejected" ? [] : (result.advisories ?? []);
  for (const advisory of advisories) {
    signals.push({
      source: "readiness",
      code: advisory.startsWith("ADVISORY:") ? "depth_advisory" : "gate_advisory",
      disposition: "advisory",
      message: advisory,
      deterministic: false,
    });
  }

  let action: "continue" | "repair" | "human_review" = "continue";
  const rationale: string[] = [`legacy_readiness:${result.outcome}`];

  if (result.outcome === "enriched") {
    action = "human_review";
    signals.push({
      source: "readiness",
      code: "task_enriched",
      disposition: "human_review",
      message: "Task was enriched and awaits approval",
      deterministic: false,
    });
  } else if (result.outcome === "rejected") {
    if (isSchemaResult(result.details)) {
      action = "repair";
      signals.push({
        source: "readiness",
        code: "missing_required_schema",
        disposition: "safety",
        message: result.reason,
        deterministic: true,
        evidence: [...result.details.missing],
        safetyCode: "missing_required_schema",
      });
    } else {
      const blocking = result.details.deficiencies.filter((item) =>
        item.toUpperCase().startsWith("BLOCKING"),
      );
      action = blocking.length > 0 ? "human_review" : "repair";
      const deficiencies = blocking.length > 0 ? blocking : result.details.deficiencies;
      for (const deficiency of deficiencies) {
        signals.push({
          source: "readiness",
          code: blocking.length > 0 ? "depth_blocking_claim" : "depth_not_ready",
          disposition: blocking.length > 0 ? "human_review" : "repair",
          message: deficiency,
          deterministic: false,
        });
      }
    }
  }

  return reduceJudgment({
    stage: "readiness",
    signals,
    judgment: { source: "legacy_policy", action, rationale },
  });
}

export function projectDocsReviewDecision(
  issues: DocsIssueLike[],
  mergeReady: boolean,
): JudgmentDecision {
  const signals: JudgmentSignal[] = issues.map((issue) => ({
    source: "docs_review",
    code: issue.code,
    disposition: issue.blocking ? "human_review" : "advisory",
    message: issue.message,
    deterministic: true,
    evidence: evidence([issue.field, issue.blockReasonCode]),
  }));
  return reduceJudgment({
    stage: "docs_review",
    signals,
    judgment: {
      source: "legacy_policy",
      action: mergeReady ? "continue" : "human_review",
      rationale: [`legacy_merge_ready:${mergeReady}`],
    },
  });
}

export function projectLoopReviewDecision(
  stage: "loop_brief" | "loop_diff",
  result: ReviewRunResult,
  facts: LoopReviewGateFacts,
  extraSignals: JudgmentSignal[] = [],
): JudgmentDecision {
  const signals: JudgmentSignal[] = [...extraSignals];
  if (result.status === "runner_error") {
    signals.push({
      source: stage,
      code: "review_runner_error",
      disposition: "human_review",
      message: result.message,
      deterministic: false,
      evidence: [result.errorKind],
    });
  } else {
    if (result.verdict !== "SHIP") {
      signals.push({
        source: stage,
        code: "review_non_ship",
        disposition: "human_review",
        message: `Review verdict is ${result.verdict}`,
        deterministic: false,
      });
    }
    for (const missing of result.anchorsAudit?.missing ?? []) {
      signals.push({
        source: stage,
        code: "review_anchor_missing",
        disposition: "human_review",
        message: "Review evidence anchor is missing",
        deterministic: true,
        evidence: [missing],
      });
    }
    if (result.treeDirtyAfterReview) {
      signals.push({
        source: stage,
        code: "review_tree_dirty",
        disposition: "human_review",
        message: "Review left the project tree dirty",
        deterministic: true,
      });
    }
  }
  if (!facts.crossModelSatisfied) {
    signals.push({
      source: stage,
      code: "cross_model_unsatisfied",
      disposition: facts.eligibleForAutoApproval ? "advisory" : "human_review",
      message: "Configured review did not provide cross-model evidence",
      deterministic: true,
    });
  }
  return reduceJudgment({
    stage,
    signals,
    judgment: {
      source: "legacy_policy",
      action: facts.eligibleForAutoApproval ? "continue" : "human_review",
      rationale: [
        `legacy_auto_approval_eligible:${facts.eligibleForAutoApproval}`,
        ...facts.reasons,
      ],
    },
  });
}

function demotionSignal(demotion: EnforcementDemotion): JudgmentSignal {
  return {
    source: "judge",
    code: "enforcement_demotion",
    disposition: "repair",
    message: demotion.detail,
    deterministic: true,
    evidence: [demotion.criterion, demotion.rule, `${demotion.from}->${demotion.to}`],
  };
}

export function projectJudgeDecision(
  result: JudgeResult,
  options?: {
    phase?: "raw" | "enforcement" | "path_audit";
    pathAudit?: JudgePathAuditFacts;
    /** TASK-1313: producer-derived signals injected by the dispatcher. */
    extraSignals?: JudgmentSignal[];
  },
): JudgmentDecision {
  const signals: JudgmentSignal[] = [...(options?.extraSignals ?? [])];
  for (const demotion of result.enforcementDemotions ?? []) {
    signals.push(demotionSignal(demotion));
  }
  for (const violation of result.scopeViolations) {
    signals.push({
      source: "judge",
      code: "scope_violation",
      disposition: "human_review",
      message: violation,
      deterministic: false,
    });
  }
  for (const gap of result.criteriaGaps) {
    signals.push({
      source: "judge",
      code: "criteria_gap",
      disposition: "repair",
      message: gap,
      deterministic: false,
    });
  }
  for (const issue of result.qualityIssues) {
    signals.push({
      source: "judge",
      code: "quality_issue",
      disposition: "repair",
      message: issue,
      deterministic: false,
    });
  }
  if (options?.pathAudit) {
    signals.push({
      source: "judge",
      code: options.pathAudit.overridden ? "path_audit_override" : "path_audit",
      disposition: options.pathAudit.overridden ? "repair" : "advisory",
      message: options.pathAudit.overridden
        ? "Judge path citations exceeded the hallucination threshold"
        : "Judge path citations were audited",
      deterministic: true,
      evidence: [
        `total=${options.pathAudit.total}`,
        `valid=${options.pathAudit.valid.length}`,
        `hallucinated=${options.pathAudit.hallucinated.length}`,
        `rate=${options.pathAudit.hallucinationRate}`,
      ],
    });
  }
  const action = options?.pathAudit?.overridden ? "repair" : verdictAction(result.verdict);
  return reduceJudgment({
    stage: "judge",
    signals,
    judgment: {
      source: "legacy_policy",
      action,
      rationale: [
        `legacy_judge_verdict:${result.verdict}`,
        ...(options?.phase ? [`judge_trace_phase:${options.phase}`] : []),
      ],
    },
  });
}

export function projectPostJudgeDecision(
  result: PostJudgeResult,
  priorVerdict: JudgeVerdict = "APPROVE",
): JudgmentDecision {
  const signals: JudgmentSignal[] = result.findings.map((finding) => ({
    source: "post_judge",
    code: `verification_${finding.status}`,
    disposition:
      finding.status === "fail" ? (result.needsReview ? "human_review" : "repair") : "advisory",
    message: finding.criterion,
    deterministic: !result.needsReview,
    evidence: [finding.evidence],
  }));
  let action: "continue" | "repair" | "human_review";
  if (priorVerdict === "REJECT" || result.needsReview) action = "human_review";
  else if (!result.verified) action = "repair";
  else action = "continue";
  return reduceJudgment({
    stage: "post_judge",
    signals,
    judgment: {
      source: "legacy_policy",
      action,
      rationale: [
        `legacy_post_judge_verified:${result.verified}`,
        `legacy_judge_verdict:${priorVerdict}`,
      ],
    },
  });
}

export function projectPostJudgeErrorDecision(message: string): JudgmentDecision {
  return reduceJudgment({
    stage: "post_judge",
    signals: [
      {
        source: "post_judge",
        code: "post_judge_verification_error",
        disposition: "human_review",
        message,
        deterministic: false,
      },
    ],
    judgment: {
      source: "legacy_policy",
      action: "human_review",
      rationale: ["legacy_authority_inversion_fell_through_to_reject"],
    },
  });
}

export function stageForReviewKind(kind: "brief" | "diff"): "loop_brief" | "loop_diff" {
  return kind === "brief" ? "loop_brief" : "loop_diff";
}
