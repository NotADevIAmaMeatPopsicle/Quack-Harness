import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ParsedTask } from "../core/types.js";
import { createEvidenceBundle } from "../workflow/evidence-bundle.js";
import type { BlockReasonCode } from "../workflow/workflow-state-types.js";
import {
  createWorkflowId,
  type WorkflowAttemptRecord,
  type WorkflowPhaseResult,
  type WorkflowRecord,
  WorkflowStore,
} from "./workflow-store.js";

export interface VerifyWorkflowInput {
  projectRoot: string;
  task: ParsedTask;
  projectId?: string;
  workflowId?: string;
  reviewId?: string;
  requireReview?: boolean;
  phaseResults?: WorkflowPhaseResult[];
  criteriaChecked?: number;
  criteriaPassed?: number;
  notes?: string;
}

export interface VerifyWorkflowResult {
  record: WorkflowRecord;
  verdict: "VERIFIED" | "FAILED" | "BLOCKED";
  statusCode: number;
}

interface ReviewCheckResult {
  ok: boolean;
  phase: WorkflowPhaseResult;
}

async function checkReviewLinkage(
  projectRoot: string,
  taskId: string,
  reviewId: string | undefined,
  requireReview: boolean,
): Promise<ReviewCheckResult> {
  if (!requireReview && !reviewId) {
    return {
      ok: true,
      phase: {
        name: "review_linkage",
        status: "skipped",
        summary: "Review linkage was not required.",
      },
    };
  }

  if (!reviewId) {
    return {
      ok: false,
      phase: {
        name: "review_linkage",
        status: "failed",
        summary: `Task ${taskId} requires a merge-ready reviewId.`,
      },
    };
  }

  const reviewPath = path.join(projectRoot, ".quack", "reviews", `${reviewId}.json`);
  try {
    const raw = await fs.readFile(reviewPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      gate?: { mergeReady?: boolean; issues?: Array<{ code?: string; message?: string }> };
    };
    if (parsed.gate?.mergeReady) {
      return {
        ok: true,
        phase: {
          name: "review_linkage",
          status: "passed",
          summary: `Review ${reviewId} is merge-ready.`,
        },
      };
    }
    return {
      ok: false,
      phase: {
        name: "review_linkage",
        status: "failed",
        summary: `Review ${reviewId} is not merge-ready.`,
      },
    };
  } catch {
    return {
      ok: false,
      phase: {
        name: "review_linkage",
        status: "failed",
        summary: `Review ${reviewId} was not found or could not be read.`,
      },
    };
  }
}

export async function runVerifyWorkflow(input: VerifyWorkflowInput): Promise<VerifyWorkflowResult> {
  const store = new WorkflowStore(input.projectRoot);
  const workflowId = input.workflowId ?? createWorkflowId(input.task.id, "verify");
  const startedAt = new Date().toISOString();
  const reviewCheck = await checkReviewLinkage(
    input.projectRoot,
    input.task.id,
    input.reviewId,
    input.requireReview === true,
  );

  const phaseResults = [
    reviewCheck.phase,
    ...(input.phaseResults ?? [
      {
        name: "success_criteria",
        status: "passed" as const,
        summary: `${input.task.successCriteria.length} success criteria present.`,
      },
    ]),
  ];
  const failedPhase = phaseResults.find((phase) => phase.status === "failed");
  const criteriaChecked = input.criteriaChecked ?? input.task.successCriteria.length;
  const criteriaPassed = input.criteriaPassed ?? (failedPhase ? 0 : criteriaChecked);
  const verified = reviewCheck.ok && !failedPhase && criteriaPassed >= criteriaChecked;
  const blockReasonCode: BlockReasonCode | undefined = reviewCheck.ok
    ? verified
      ? undefined
      : "pending_manual_handoff"
    : "review_linkage_required";
  const verdict: VerifyWorkflowResult["verdict"] = verified
    ? "VERIFIED"
    : reviewCheck.ok
      ? "FAILED"
      : "BLOCKED";
  const completedAt = new Date().toISOString();

  const attempt: WorkflowAttemptRecord = {
    attempt: 1,
    kind: "verify",
    status: verified ? "passed" : reviewCheck.ok ? "failed" : "blocked",
    startedAt,
    completedAt,
    verdict,
    phaseResults,
    findings: [],
  };

  const evidenceBundle = createEvidenceBundle({
    taskId: input.task.id,
    workflowId,
    workflowState: verified ? "verified" : "blocked",
    blockReasonCode,
    changedFiles: input.task.filesToModify.map((file) => file.path),
    verification: {
      verificationRecordId: `${workflowId}-verification`,
      verdict: verified ? "VERIFIED" : "REJECTED",
      criteriaChecked,
      criteriaPassed,
      verifiedAt: completedAt,
    },
    updatedAt: completedAt,
  });

  const record: WorkflowRecord = {
    workflowId,
    taskId: input.task.id,
    projectId: input.projectId,
    kind: "verify",
    status: verified ? "completed" : reviewCheck.ok ? "failed" : "blocked",
    state: verified ? "verified" : "blocked",
    blockReasonCode,
    attempts: [attempt],
    findings: [],
    evidenceBundle,
    createdAt: startedAt,
    updatedAt: completedAt,
  };

  await store.save(record);
  return {
    record,
    verdict,
    statusCode: verified ? 200 : reviewCheck.ok ? 422 : 409,
  };
}
