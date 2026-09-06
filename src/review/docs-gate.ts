import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CANONICAL_TASK_STATUSES,
  blockReasonForReviewGateIssue,
  type BlockReasonCode,
  type DocsImpact as CanonicalDocsImpact,
  type WikiAction as CanonicalWikiAction,
} from "../workflow/workflow-state-types.js";
import type { JudgmentConfig } from "../judgment/runner/intent-judgment-config.js";
import type {
  IntentJudgmentRequest,
  IntentJudgmentRunner,
  JudgmentDecision,
  JudgmentOrchestrationResult,
} from "../judgment/judgment-types.js";
import { projectDocsReviewDecision } from "../judgment/judgment-adapters.js";
import { containJudgmentProjection } from "../judgment/judgment-events.js";
import type { JudgmentProjectionFailure } from "../judgment/judgment-types.js";
import { reduceJudgment } from "../judgment/judgment-reducer.js";
import { orchestrateJudgment } from "../judgment/judgment-orchestrator.js";
import { createIntentJudgmentRunner } from "../judgment/runner/intent-judgment-runner.js";
import { assignIntentSignalRefs } from "../judgment/runner/intent-judgment-prompt.js";
import { extractIntentSections, extractSection, sectionItems } from "../judgment/intent-request.js";

export type DocsImpact = CanonicalDocsImpact;
export type WikiAction = CanonicalWikiAction;

export interface WikiArtifact {
  pagePath: string;
  commitSha: string;
  linkedTaskIds: string[];
  action?: WikiAction;
}

export interface SupportDocCandidate {
  title: string;
  summary: string;
  productArea?: string;
  linkedTaskIds?: string[];
  tags?: string[];
}

export interface ReviewFinding {
  title: string;
  severity: "P1" | "P2" | "P3";
  status?: "open" | "resolved" | "waived";
  file?: string;
}

export interface ReviewBundleInput {
  taskId: string;
  verdict: "VERIFIED" | "PARTIAL" | "FAILED";
  docsImpact: DocsImpact;
  requiredWikiActions?: WikiAction[];
  wikiArtifacts?: WikiArtifact[];
  supportDocCandidates?: SupportDocCandidate[];
  findings?: ReviewFinding[];
  summary?: string;
  reviewNotes?: string;
  reviewer?: string;
}

export interface GateIssue {
  code: string;
  message: string;
  blocking: boolean;
  field?: string;
  blockReasonCode?: BlockReasonCode;
}

export interface ReviewGateResult {
  mergeReady: boolean;
  requiredWikiActions: WikiAction[];
  missingWikiActions: WikiAction[];
  issues: GateIssue[];
  /** Additive Phase-2 projection; legacy readers may ignore it. */
  judgmentDecision?: JudgmentDecision;
  judgmentProjectionFailure?: JudgmentProjectionFailure;
  judgmentOrchestration?: JudgmentOrchestrationResult;
}

export interface PersistedReviewBundle extends ReviewBundleInput {
  reviewId: string;
  createdAt: string;
  gate: ReviewGateResult;
}

export interface DocsPipelineResult {
  changelogPath?: string;
  featureUpdatesPath?: string;
  supportContentPath?: string;
  emittedSupportRecords: number;
}

const CANONICAL_STATUSES = new Set<string>(CANONICAL_TASK_STATUSES);

const STATUS_ALIASES: Record<string, string> = {
  "ON-HOLD": "ON_HOLD",
  "ON HOLD": "ON_HOLD",
  INPROGRESS: "IN_PROGRESS",
  "IN PROGRESS": "IN_PROGRESS",
  "IN-PROGRESS": "IN_PROGRESS",
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Strict legacy shape, matched anywhere in the document.
const STRICT_STATUS_LINE_RE = /^\s*-\s*\*\*Status:\*\*\s*(.+?)\s*$/im;
// Tolerant shapes (optional bullet, optional bold), matched ONLY inside the
// ## Metadata section — scoping keeps line-start "Status:" text in prose,
// tables, and code fences elsewhere from being read as task metadata
// (TASK-1300 / v2 P0-5).
const TOLERANT_STATUS_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*Status:\*\*|Status:)\s*(.+?)\s*$/im;

function parseStatusLine(taskContent: string): string | null {
  const metadataSection = extractSection(taskContent, "Metadata");
  if (metadataSection.trim().length > 0) {
    const tolerant = metadataSection.match(TOLERANT_STATUS_LINE_RE);
    if (tolerant) return tolerant[1].trim();
  }
  const strict = taskContent.match(STRICT_STATUS_LINE_RE);
  return strict ? strict[1].trim() : null;
}

function normalizeStatus(rawStatus: string | null): string | null {
  if (!rawStatus) return null;
  const withSuffix = rawStatus.match(/^([A-Za-z0-9_\-\s]+)\s*\(([^)]*)\)\s*$/);
  const base = (withSuffix ? withSuffix[1] : rawStatus).trim().toUpperCase();
  return STATUS_ALIASES[base] ?? base;
}

// Conservative suggestions for the known non-canonical offenders. The gate
// suggests; it never rewrites — the operator decides (repair-specs philosophy).
const STATUS_SUGGESTIONS: Record<string, string> = {
  DONE: "COMPLETE",
  "READY FOR SCOPING": "BACKLOG",
};

function suggestCanonicalStatus(rawStatus: string): string {
  const withSuffix = rawStatus.match(/^([A-Za-z0-9_\-\s]+)\s*\(([^)]*)\)\s*$/);
  const base = (withSuffix ? withSuffix[1] : rawStatus).trim().toUpperCase();
  const suggestion = STATUS_SUGGESTIONS[base];
  if (suggestion) {
    return `Did you mean "${suggestion}"?`;
  }
  return `Use one of: ${[...CANONICAL_TASK_STATUSES].join(", ")}.`;
}

// Markdown checkboxes behind -, *, + bullets or numbered lists (1. / 1)),
// with or without an inner space and with or without trailing text spacing.
// The (?!\() lookahead keeps markdown links like "- [x](url)" out; inner
// content other than x/X/blank (e.g. "- [TASK-016] ...") is not a checkbox.
const MARKDOWN_CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s*\[([^\]\n]*)\](?!\()/gm;
const HTML_CHECKBOX_RE = /<input\b[^>]*type=["']checkbox["'][^>]*>/gi;

function countChecklist(sectionText: string): {
  checked: number;
  unchecked: number;
  total: number;
} {
  let checked = 0;
  let unchecked = 0;

  for (const match of sectionText.matchAll(MARKDOWN_CHECKBOX_RE)) {
    const inner = (match[1] ?? "").trim().toLowerCase();
    if (inner === "x") {
      checked++;
    } else if (inner === "") {
      unchecked++;
    }
  }

  for (const match of sectionText.matchAll(HTML_CHECKBOX_RE)) {
    if (/\bchecked\b/i.test(match[0])) {
      checked++;
    } else {
      unchecked++;
    }
  }

  return {
    checked,
    unchecked,
    total: checked + unchecked,
  };
}

function inferWikiActionFromPath(pagePath: string): WikiAction {
  if (/(changelog|release[-_\s]?notes?|changes?)/i.test(pagePath)) {
    return "changelog_entry";
  }
  if (/(support|help|faq|knowledge[-_\s]?base|kb)/i.test(pagePath)) {
    return "support_bundle";
  }
  return "feature_page_update";
}

function hasArtifactForAction(action: WikiAction, artifacts: WikiArtifact[]): boolean {
  return artifacts.some((artifact) => {
    const resolvedAction = artifact.action ?? inferWikiActionFromPath(artifact.pagePath);
    return resolvedAction === action;
  });
}

export function requiredActionsForDocsImpact(docsImpact: DocsImpact): WikiAction[] {
  switch (docsImpact) {
    case "none":
      return [];
    case "changelog_only":
      return ["changelog_entry"];
    case "feature_page_update":
      return ["changelog_entry", "feature_page_update"];
    case "support_bundle":
      return ["changelog_entry", "feature_page_update", "support_bundle"];
    default:
      return [];
  }
}

/**
 * TASK-1328: which blocking issues are DOCS DEBT, and which are INTEGRITY.
 *
 * The ledger decoupling says "a verification that happened is recorded even
 * when docs are outstanding". It does NOT say "record a VERIFIED claim the
 * gate just refuted". These two blocking classes are different in kind:
 *
 *   DOCS DEBT  - the work is done, the paperwork is not. Safe to record.
 *   INTEGRITY  - the claim itself is contradicted: the task's own success
 *                criteria are unchecked, or a P1/P2 finding is open, or the
 *                review linkage is broken. Recording VERIFIED here would
 *                persist a claim the gate exists to refuse.
 *
 * Found by running the existing suite rather than by reasoning: the test
 * "a checklist-mismatch VERIFIED claim still 422s and skips the bridge"
 * (TASK-1300) is CORRECT and must keep passing.
 */
const DOCS_DEBT_ISSUE_CODES = new Set([
  "invalid_wiki_artifact",
  "missing_wiki_artifacts",
  "missing_support_doc_candidates",
]);

/** Blocking issues that are NOT docs debt. */
export function integrityBlockers(gate: ReviewGateResult): GateIssue[] {
  return gate.issues.filter((issue) => issue.blocking && !DOCS_DEBT_ISSUE_CODES.has(issue.code));
}

/**
 * Is DOCS DEBT the only thing standing between this review and
 * merge-readiness? This is the ledger's admission test, and it is
 * deliberately not "no integrity blockers".
 *
 * Self-caught during the build, before the diff round returned: in ENFORCE
 * mode `evaluateReviewGateWithJudgment` sets `mergeReady` from the judgment's
 * action alone (see its return), and the enforce projection-failure path
 * returns `mergeReady: false` too — NEITHER adds a blocking issue to
 * `gate.issues`. So a review an intent judge had substantively refused would
 * present an EMPTY blocker list, and an "no integrity blockers" test would
 * have written a VERIFIED row on top of that refusal: exactly the class this
 * partition exists to prevent, arriving through the door the partition left
 * open. Latent today (no stage is in enforce), which is precisely why it
 * would have shipped unnoticed and surfaced at the cutover.
 *
 * The rule instead: merge-ready reviews always qualify; a NOT-merge-ready
 * review qualifies only when it carries blocking issues AND every one of
 * them is docs debt. A refusal we cannot attribute to paperwork is not
 * treated as paperwork.
 */
export function blockedOnlyByDocsDebt(gate: ReviewGateResult): boolean {
  if (gate.mergeReady) return true;
  const blocking = gate.issues.filter((issue) => issue.blocking);
  if (blocking.length === 0) return false;
  return blocking.every((issue) => DOCS_DEBT_ISSUE_CODES.has(issue.code));
}

export function evaluateReviewGate(
  review: ReviewBundleInput,
  taskContent?: string,
): ReviewGateResult {
  const issues: GateIssue[] = [];
  const pushIssue = (issue: Omit<GateIssue, "blockReasonCode">): void => {
    issues.push({
      ...issue,
      blockReasonCode: blockReasonForReviewGateIssue(issue.code),
    });
  };
  const artifacts = review.wikiArtifacts ?? [];
  const providedActions = review.requiredWikiActions ?? [];
  const requiredWikiActions = unique([
    ...requiredActionsForDocsImpact(review.docsImpact),
    ...providedActions,
  ]);

  if (taskContent) {
    const rawStatus = parseStatusLine(taskContent);
    const normalizedStatus = normalizeStatus(rawStatus);
    // Status format/enum problems are advisories (TASK-1300 / v2 P0-5): a
    // formatting artifact must not block mergeReady — and with it the
    // verified-ledger bridge. The VERIFIED/COMPLETE-with-unchecked-items
    // checks below stay blocking; they are integrity signals.
    if (!rawStatus) {
      pushIssue({
        code: "missing_status",
        message: "Task spec is missing a Status metadata line. Add one to the ## Metadata section.",
        blocking: false,
        field: "status",
      });
    } else if (!normalizedStatus || !CANONICAL_STATUSES.has(normalizedStatus)) {
      pushIssue({
        code: "non_canonical_status",
        message: `Task status "${rawStatus}" is non-canonical. ${suggestCanonicalStatus(rawStatus)}`,
        blocking: false,
        field: "status",
      });
    } else {
      const successText = extractSection(taskContent, "Success Criteria");
      const testingText = extractSection(taskContent, "Testing Requirements");
      const successChecklist = countChecklist(successText);
      const testingChecklist = countChecklist(testingText);
      const hasUnchecked = successChecklist.unchecked > 0 || testingChecklist.unchecked > 0;
      const claimsDone = normalizedStatus === "VERIFIED" || normalizedStatus === "COMPLETE";

      if (
        claimsDone &&
        successChecklist.total + testingChecklist.total === 0 &&
        (successText.trim().length > 0 || testingText.trim().length > 0)
      ) {
        pushIssue({
          code: "checklist_not_countable",
          message:
            "Task claims a done status but no checkboxes were recognized in Success Criteria/Testing Requirements — the unchecked-items check could not run.",
          blocking: false,
          field: "successCriteria",
        });
      }

      if (normalizedStatus === "VERIFIED" && hasUnchecked) {
        pushIssue({
          code: "verified_unchecked_checklists",
          message:
            "Task is marked VERIFIED while Success Criteria/Testing Requirements contain unchecked items.",
          blocking: true,
          field: "status",
        });
      }

      if (normalizedStatus === "COMPLETE" && hasUnchecked) {
        pushIssue({
          code: "complete_unchecked_checklists",
          message:
            "Task is marked COMPLETE while Success Criteria/Testing Requirements contain unchecked items.",
          blocking: true,
          field: "status",
        });
      }
    }
  }

  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact.pagePath?.trim()) {
      pushIssue({
        code: "invalid_wiki_artifact",
        message: `wikiArtifacts[${index}] is missing pagePath.`,
        blocking: true,
        field: `wikiArtifacts[${index}].pagePath`,
      });
    }
    if (!artifact.commitSha?.trim()) {
      pushIssue({
        code: "invalid_wiki_artifact",
        message: `wikiArtifacts[${index}] is missing commitSha.`,
        blocking: true,
        field: `wikiArtifacts[${index}].commitSha`,
      });
    }
    if (!Array.isArray(artifact.linkedTaskIds) || artifact.linkedTaskIds.length === 0) {
      pushIssue({
        code: "invalid_wiki_artifact",
        message: `wikiArtifacts[${index}] is missing linkedTaskIds.`,
        blocking: true,
        field: `wikiArtifacts[${index}].linkedTaskIds`,
      });
    }
  }

  const missingWikiActions = requiredWikiActions.filter(
    (action) => !hasArtifactForAction(action, artifacts),
  );
  if (missingWikiActions.length > 0) {
    pushIssue({
      code: "missing_wiki_artifacts",
      message: `Missing required wiki artifacts for actions: ${missingWikiActions.join(", ")}`,
      blocking: true,
      field: "wikiArtifacts",
    });
  }

  if (requiredWikiActions.includes("support_bundle")) {
    if (!review.supportDocCandidates || review.supportDocCandidates.length === 0) {
      pushIssue({
        code: "missing_support_doc_candidates",
        message: "support_bundle requires at least one supportDocCandidates entry.",
        blocking: true,
        field: "supportDocCandidates",
      });
    }
  }

  for (const finding of review.findings ?? []) {
    const status = finding.status ?? "open";
    if (
      (finding.severity === "P1" || finding.severity === "P2") &&
      status !== "resolved" &&
      status !== "waived"
    ) {
      pushIssue({
        code: "unresolved_high_severity_finding",
        message: `Unresolved ${finding.severity} finding: ${finding.title}`,
        blocking: true,
        field: "findings",
      });
    }
  }

  const mergeReady = !issues.some((issue) => issue.blocking);
  const judgmentProjection = containJudgmentProjection(() =>
    projectDocsReviewDecision(issues, mergeReady),
  );
  return {
    mergeReady,
    requiredWikiActions,
    missingWikiActions,
    issues,
    ...(judgmentProjection.decision
      ? { judgmentDecision: judgmentProjection.decision }
      : { judgmentProjectionFailure: judgmentProjection.failure }),
  };
}

export interface ReviewGateJudgmentOptions {
  config?: JudgmentConfig;
  runner?: IntentJudgmentRunner;
}

function buildDocsIntentRequest(
  review: ReviewBundleInput,
  taskContent: string | undefined,
  decision: JudgmentDecision,
): IntentJudgmentRequest | undefined {
  const content = taskContent ?? "";
  const sections = extractIntentSections(content);
  if (sections.empty) return undefined;
  const { intent, problem, success, scope, presentSections, missingSections } = sections;

  return {
    stage: "docs_review",
    taskId: review.taskId,
    taskIntent: [intent, problem].filter(Boolean).join("\n\n"),
    successCriteria: sectionItems(success),
    scopeBoundaries: sectionItems(scope),
    stageContext: {
      verdict: review.verdict,
      docsImpact: review.docsImpact,
      requiredWikiActions: review.requiredWikiActions ?? [],
      wikiArtifacts: review.wikiArtifacts ?? [],
      supportDocCandidates: review.supportDocCandidates ?? [],
      findings: review.findings ?? [],
      summary: review.summary,
      reviewNotes: review.reviewNotes,
      reviewer: review.reviewer,
    },
    signals: assignIntentSignalRefs(decision.signals),
    contextMetadata: {
      presentSections: [...presentSections],
      missingSections: [...missingSections],
    },
  };
}

/**
 * Async, adapter-opt-in docs-review authority wrapper. The synchronous gate
 * remains the sole deterministic issue producer and stays API-compatible.
 */
export async function evaluateReviewGateWithJudgment(
  review: ReviewBundleInput,
  taskContent?: string,
  options: ReviewGateJudgmentOptions = {},
): Promise<ReviewGateResult> {
  const gate = evaluateReviewGate(review, taskContent);
  const mode = options.config?.stages.docsReview.mode ?? "off";
  if (!gate.judgmentDecision) {
    if (mode === "enforce" && gate.judgmentProjectionFailure) {
      const fallbackDecision = reduceJudgment({
        stage: "docs_review",
        signals: [
          {
            source: "docs_review",
            code: "intent_runner_unavailable",
            disposition: "human_review",
            message: "Docs-review judgment projection failed; enforce mode requires human review.",
            deterministic: true,
            evidence: [`projection_failure:${gate.judgmentProjectionFailure.errorCode}`],
          },
        ],
        judgment: {
          source: "legacy_policy",
          action: "human_review",
          rationale: ["judgment_projection_failure"],
        },
      });
      const judgmentOrchestration: JudgmentOrchestrationResult = {
        mode,
        attempted: false,
        reason: "projection_failure",
        legacyDecision: fallbackDecision,
        activeDecision: fallbackDecision,
        projectionFailure: gate.judgmentProjectionFailure,
        diverged: false,
      };
      return {
        ...gate,
        mergeReady: false,
        judgmentDecision: fallbackDecision,
        judgmentOrchestration,
      };
    }
    return {
      ...gate,
    };
  }

  const request = buildDocsIntentRequest(review, taskContent, gate.judgmentDecision);
  const runner =
    options.runner ??
    (mode !== "off" && request ? createIntentJudgmentRunner(options.config?.runner) : undefined);
  const judgmentOrchestration = await orchestrateJudgment({
    mode,
    legacyDecision: gate.judgmentDecision,
    request,
    runner,
  });

  return {
    ...gate,
    mergeReady:
      mode === "enforce"
        ? judgmentOrchestration.activeDecision.action === "continue"
        : gate.mergeReady,
    judgmentDecision: judgmentOrchestration.activeDecision,
    judgmentOrchestration,
  };
}

export async function persistReviewBundle(
  projectRoot: string,
  review: PersistedReviewBundle,
): Promise<string> {
  const reviewsDir = path.join(projectRoot, ".quack", "reviews");
  await fs.mkdir(reviewsDir, { recursive: true });

  const reviewPath = path.join(reviewsDir, `${review.reviewId}.json`);
  await fs.writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n", "utf-8");

  await regenerateLatestByTaskIndex(projectRoot);

  return reviewPath;
}

export async function regenerateLatestByTaskIndex(
  projectRoot: string,
): Promise<Record<string, string>> {
  const reviewsDir = path.join(projectRoot, ".quack", "reviews");
  await fs.mkdir(reviewsDir, { recursive: true });

  const entries = await fs.readdir(reviewsDir, { withFileTypes: true });
  const reviewFiles = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.endsWith(".json") && entry.name !== "latest-by-task.json",
  );

  const latestByTask = new Map<string, { reviewId: string; sortKey: string }>();
  for (const entry of reviewFiles) {
    try {
      const raw = await fs.readFile(path.join(reviewsDir, entry.name), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
      if (!taskId) continue;
      const reviewId =
        typeof parsed.reviewId === "string" && parsed.reviewId.trim()
          ? parsed.reviewId.trim()
          : entry.name.replace(/\.json$/u, "");
      const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
      const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
      const sortKey = `${updatedAt || createdAt}|${reviewId}`;
      const existing = latestByTask.get(taskId);
      if (!existing || sortKey.localeCompare(existing.sortKey) > 0) {
        latestByTask.set(taskId, { reviewId, sortKey });
      }
    } catch {
      // Ignore malformed review bundles; this index is a projection.
    }
  }

  const latestByTaskPath = path.join(reviewsDir, "latest-by-task.json");
  const latestByTaskRecord: Record<string, string> = {};
  for (const taskId of Array.from(latestByTask.keys()).sort((a, b) => a.localeCompare(b))) {
    const latest = latestByTask.get(taskId);
    if (latest) latestByTaskRecord[taskId] = latest.reviewId;
  }
  await fs.writeFile(latestByTaskPath, JSON.stringify(latestByTaskRecord, null, 2) + "\n", "utf-8");
  return latestByTaskRecord;
}

export async function readLatestByTaskIndex(projectRoot: string): Promise<Record<string, string>> {
  const latestByTaskPath = path.join(projectRoot, ".quack", "reviews", "latest-by-task.json");
  try {
    const raw = await fs.readFile(latestByTaskPath, "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return regenerateLatestByTaskIndex(projectRoot);
  }
}

export async function loadLatestReviewBundleForTask(
  projectRoot: string,
  taskId: string,
): Promise<PersistedReviewBundle | undefined> {
  const latestByTask = await readLatestByTaskIndex(projectRoot);
  const reviewId = latestByTask[taskId];
  if (!reviewId) return undefined;
  try {
    const reviewRaw = await fs.readFile(
      path.join(projectRoot, ".quack", "reviews", `${reviewId}.json`),
      "utf-8",
    );
    return JSON.parse(reviewRaw) as PersistedReviewBundle;
  } catch {
    return undefined;
  }
}

function buildChangelogEntry(review: PersistedReviewBundle): string {
  return [
    `## ${new Date(review.createdAt).toISOString().split("T")[0]} - ${review.taskId}`,
    `- Review: \`${review.reviewId}\``,
    `- Verdict: ${review.verdict}`,
    `- Docs Impact: ${review.docsImpact}`,
    review.summary ? `- Summary: ${review.summary}` : "- Summary: n/a",
    review.reviewer ? `- Reviewer: ${review.reviewer}` : undefined,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFeatureUpdateEntry(review: PersistedReviewBundle): string {
  const artifactLines = (review.wikiArtifacts ?? [])
    .map((artifact) => {
      const action = artifact.action ?? inferWikiActionFromPath(artifact.pagePath);
      return `- ${artifact.pagePath} (${action}, ${artifact.commitSha})`;
    })
    .join("\n");
  return [
    `## ${new Date(review.createdAt).toISOString().split("T")[0]} - ${review.taskId}`,
    review.summary ? `Summary: ${review.summary}` : "Summary: n/a",
    artifactLines || "- No wiki artifacts attached",
    "",
  ].join("\n");
}

export async function runDocsPipeline(
  projectRoot: string,
  review: PersistedReviewBundle,
): Promise<DocsPipelineResult> {
  const pipelineDir = path.join(projectRoot, ".quack", "docs-pipeline");
  await fs.mkdir(pipelineDir, { recursive: true });

  const result: DocsPipelineResult = { emittedSupportRecords: 0 };
  if (review.verdict !== "VERIFIED") {
    return result;
  }

  const changelogPath = path.join(pipelineDir, "changelog.md");
  await fs.appendFile(changelogPath, buildChangelogEntry(review), "utf-8");
  result.changelogPath = changelogPath;

  const requiresFeatureUpdate =
    review.docsImpact === "feature_page_update" || review.docsImpact === "support_bundle";
  if (requiresFeatureUpdate) {
    const featureUpdatesPath = path.join(pipelineDir, "feature-updates.md");
    await fs.appendFile(featureUpdatesPath, buildFeatureUpdateEntry(review), "utf-8");
    result.featureUpdatesPath = featureUpdatesPath;
  }

  const supportCandidates = review.supportDocCandidates ?? [];
  if (supportCandidates.length > 0) {
    const supportContentPath = path.join(pipelineDir, "support-content.jsonl");
    const lines = supportCandidates.map((candidate, index) =>
      JSON.stringify({
        id: `support-${review.reviewId}-${index + 1}`,
        reviewId: review.reviewId,
        taskId: review.taskId,
        title: candidate.title,
        summary: candidate.summary,
        productArea: candidate.productArea ?? "general",
        linkedTaskIds: unique([review.taskId, ...(candidate.linkedTaskIds ?? [])]),
        tags: candidate.tags ?? [],
        wikiPages: (review.wikiArtifacts ?? []).map((artifact) => artifact.pagePath),
        generatedAt: new Date().toISOString(),
      }),
    );
    await fs.appendFile(supportContentPath, lines.join("\n") + "\n", "utf-8");
    result.supportContentPath = supportContentPath;
    result.emittedSupportRecords = lines.length;
  }

  return result;
}
