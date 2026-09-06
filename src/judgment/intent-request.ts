// ─── Shared intent-request extraction (TASK-1315) ───────────────────
// Moved LITERALLY from docs-gate (behavior byte-identical there) so the
// readiness cutover and the later loop/judge slices build their intent
// requests from one extraction contract instead of drifting copies.

import type { DepthEvalResult, GateResult, JudgeResult, ParsedTask } from "../core/types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import type { IntentJudgmentRequest, JudgmentDecision } from "./judgment-types.js";
import { assignIntentSignalRefs } from "./runner/intent-judgment-prompt.js";

export const INTENT_SECTION_NAMES = [
  "Intent",
  "Problem Statement",
  "Success Criteria",
  "Scope Boundaries",
] as const;

export function extractSection(content: string, sectionName: string): string {
  const re = new RegExp(`##\\s+${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = content.match(re);
  return match?.[1] ?? "";
}

export function sectionItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+] |\d+[.)] )/.test(line))
    .map((line) => line.replace(/^(?:[-*+] |\d+[.)] )/, "").trim())
    .filter(Boolean);
}

export interface ExtractedIntentSections {
  intent: string;
  problem: string;
  success: string;
  scope: string;
  presentSections: string[];
  missingSections: string[];
  empty: boolean;
}

/** The exact present/missing semantics the docs builder has used since 1311. */
export function extractIntentSections(content: string): ExtractedIntentSections {
  const intent = extractSection(content, "Intent").trim();
  const problem = extractSection(content, "Problem Statement").trim();
  const success = extractSection(content, "Success Criteria").trim();
  const scope = (
    extractSection(content, "Scope Boundaries") || extractSection(content, "Scope")
  ).trim();
  const values = [intent, problem, success, scope];
  const presentSections = INTENT_SECTION_NAMES.filter((_name, index) => values[index].length > 0);
  const missingSections = INTENT_SECTION_NAMES.filter((_name, index) => values[index].length === 0);
  return {
    intent,
    problem,
    success,
    scope,
    presentSections: [...presentSections],
    missingSections: [...missingSections],
    empty: presentSections.length === 0,
  };
}

/**
 * Deterministic gate evidence captured AS THE GATE RUNS (round-1 F4:
 * GateResult pass/enriched shapes discard these locals, so the cutover
 * cannot rebuild them from the result alone).
 */
export interface ReadinessGateEvidence {
  schemaWarnings: string[];
  advisorySuggestedMinScore: number;
  collisionDeficiencies: string[];
  /** Absent on skip-depth paths — honestly. */
  depthResult?: DepthEvalResult;
}

/**
 * Build the readiness intent request. Undefined when the spec carries no
 * intent sections (the orchestration then skips with
 * `intent_context_unavailable`, exactly like docs-review).
 */
export function buildReadinessIntentRequest(
  task: ParsedTask,
  legacyResult: GateResult,
  legacyDecision: JudgmentDecision,
  evidence: ReadinessGateEvidence,
): IntentJudgmentRequest | undefined {
  const sections = extractIntentSections(task.rawContent);
  if (sections.empty) return undefined;

  return {
    stage: "readiness",
    taskId: task.id,
    taskIntent: [sections.intent, sections.problem].filter(Boolean).join("\n\n"),
    successCriteria: sectionItems(sections.success),
    scopeBoundaries: sectionItems(sections.scope),
    stageContext: {
      outcome: legacyResult.outcome,
      reason: legacyResult.outcome === "rejected" ? legacyResult.reason : undefined,
      depthOverallScore: evidence.depthResult?.overallScore,
      depthDeficiencies: evidence.depthResult?.deficiencies ?? [],
      advisorySuggestedMinScore: evidence.advisorySuggestedMinScore,
      collisionDeficiencies: evidence.collisionDeficiencies,
      schemaWarnings: evidence.schemaWarnings,
      advisories:
        legacyResult.outcome === "rejected"
          ? (evidence.depthResult?.deficiencies ?? []).filter((deficiency) =>
              deficiency.startsWith("ADVISORY:"),
            )
          : (legacyResult.advisories ?? []),
    },
    signals: assignIntentSignalRefs(legacyDecision.signals),
    contextMetadata: {
      presentSections: sections.presentSections,
      missingSections: sections.missingSections,
    },
  };
}

// ─── TASK-1316: the loop + judge builders ───────────────────────────
// Both take the raw spec text rather than a ParsedTask because
// `evaluateLoopReview` only ever holds `ReviewRequest.taskSpec`; the
// judge builder matches that shape so the two stay symmetrical.
//
// The `signals` array is ALWAYS derived from `legacyDecision.signals`
// and never from a separately-passed injected-signal list: producer
// signals are already folded into the legacy projection (1313), the
// orchestrator re-reduces the candidate over exactly those signals, and
// its `hasExactSignalRefs` check compares the runner's
// `consideredSignalRefs` against `request.signals`. Any other source
// would double-count or fail closed as `invalid_output`.

/** Bound one free-text field; the prompt layer bounds the packet again. */
function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}[TRUNCATED]`;
}

/** Bound a list, keeping the count of what was dropped visible. */
function boundedItems(values: string[], maxItems: number): string[] {
  if (values.length <= maxItems) return values.map((v) => boundedText(v, 600));
  return [
    ...values.slice(0, maxItems).map((v) => boundedText(v, 600)),
    `[TRUNCATED:${values.length - maxItems}-more]`,
  ];
}

/**
 * Build the loop-review intent request (brief or diff — one shape, the
 * stage supplied by the caller from `stageForReviewKind`). Undefined
 * when the spec carries no intent sections, so the orchestration skips
 * with `intent_context_unavailable` exactly like readiness/docs-review.
 */
export function buildLoopIntentRequest(
  stage: "loop_brief" | "loop_diff",
  taskId: string,
  taskSpec: string,
  review: ReviewRunResult,
  facts: LoopReviewGateFacts,
  legacyDecision: JudgmentDecision,
): IntentJudgmentRequest | undefined {
  const sections = extractIntentSections(taskSpec);
  if (sections.empty) return undefined;

  const reviewContext =
    review.status === "completed"
      ? {
          reviewStatus: "completed",
          reviewVerdict: review.verdict,
          reviewSummary: boundedText(review.summary, 2_000),
          reviewConfidence: review.confidence,
          findingCount: review.findings.length,
          blockingFindingCount: review.findings.filter((finding) => finding.severity === "blocking")
            .length,
          findings: boundedItems(
            review.findings.map((finding) => `${finding.severity}: ${finding.summary}`),
            20,
          ),
          anchorsMissing: review.anchorsAudit?.missing ?? [],
          treeDirtyAfterReview: review.treeDirtyAfterReview === true,
        }
      : {
          reviewStatus: "runner_error",
          runnerErrorKind: review.errorKind,
          reviewSummary: boundedText(review.message, 2_000),
        };

  return {
    stage,
    taskId,
    taskIntent: [sections.intent, sections.problem].filter(Boolean).join("\n\n"),
    successCriteria: sectionItems(sections.success),
    scopeBoundaries: sectionItems(sections.scope),
    stageContext: {
      reviewKind: stage === "loop_brief" ? "brief" : "diff",
      reviewRunner: review.runner,
      ...reviewContext,
      // The deterministic gate's own conclusion. The intent model may
      // confirm or demote it; it can never widen it (the monotonic
      // outcome policy enforces that structurally, not by prompt).
      eligibleForAutoApproval: facts.eligibleForAutoApproval,
      crossModelSatisfied: facts.crossModelSatisfied,
      anchorAuditPassed: facts.anchorAuditPassed,
      treeClean: facts.treeClean,
      gateReasons: boundedItems(facts.reasons, 20),
    },
    signals: assignIntentSignalRefs(legacyDecision.signals),
    contextMetadata: {
      presentSections: sections.presentSections,
      missingSections: sections.missingSections,
    },
  };
}

/**
 * Build the judge-stage intent request from the FINAL judge result (the
 * post-enforcement, post-path-audit shape the dispatcher branches on).
 * Undefined when the spec carries no intent sections.
 */
export function buildJudgeIntentRequest(
  taskId: string,
  taskSpec: string,
  judge: JudgeResult,
  legacyDecision: JudgmentDecision,
): IntentJudgmentRequest | undefined {
  const sections = extractIntentSections(taskSpec);
  if (sections.empty) return undefined;

  return {
    stage: "judge",
    taskId,
    taskIntent: [sections.intent, sections.problem].filter(Boolean).join("\n\n"),
    successCriteria: sectionItems(sections.success),
    scopeBoundaries: sectionItems(sections.scope),
    stageContext: {
      verdict: judge.verdict,
      confidence: judge.confidence,
      feedback: boundedText(judge.feedback, 2_000),
      scopeViolations: boundedItems(judge.scopeViolations, 20),
      criteriaGaps: boundedItems(judge.criteriaGaps, 20),
      qualityIssues: boundedItems(judge.qualityIssues, 20),
      criteriaEvaluation: boundedItems(
        (judge.criteriaEvaluation ?? []).map(
          (evaluation) =>
            `${evaluation.status} [${evaluation.enforcement_type}] ${evaluation.criterion}`,
        ),
        30,
      ),
      // TASK-1200 demotions are upstream of this candidate and stay
      // un-undoable: the mapping at the call site never raises a verdict.
      enforcementDemotions: boundedItems(
        (judge.enforcementDemotions ?? []).map(
          (demotion) =>
            `${demotion.criterion}: ${demotion.from}->${demotion.to} (${demotion.rule})`,
        ),
        20,
      ),
    },
    signals: assignIntentSignalRefs(legacyDecision.signals),
    contextMetadata: {
      presentSections: sections.presentSections,
      missingSections: sections.missingSections,
    },
  };
}
