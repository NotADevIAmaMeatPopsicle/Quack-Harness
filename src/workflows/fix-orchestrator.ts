import type { ParsedTask } from "../core/types.js";
import { createEvidenceBundle } from "../workflow/evidence-bundle.js";
import {
  createWorkflowId,
  type ManualHandoffBundle,
  type WorkflowAttemptRecord,
  type WorkflowFindingRecord,
  type WorkflowRecord,
  WorkflowStore,
} from "./workflow-store.js";

export interface FixWorkflowInput {
  projectRoot: string;
  task: ParsedTask;
  projectId?: string;
  workflowId?: string;
  issues: string[];
  fixed?: boolean;
  maxAttempts?: number;
}

export interface FixWorkflowResult {
  record: WorkflowRecord;
  statusCode: number;
  exhausted: boolean;
}

function findingsFromIssues(issues: string[]): WorkflowFindingRecord[] {
  return issues.map((issue) => ({
    title: issue,
    severity: "P2",
    status: "open",
  }));
}

function createHandoffBundle(
  taskId: string,
  workflowId: string,
  issues: string[],
  createdAt: string,
): ManualHandoffBundle {
  return {
    taskId,
    workflowId,
    blockReasonCode: "workflow_attempts_exhausted",
    issues,
    createdAt,
    summary: `Auto-fix attempts exhausted for ${taskId}; manual intervention is required.`,
  };
}

export async function runFixWorkflow(input: FixWorkflowInput): Promise<FixWorkflowResult> {
  const store = new WorkflowStore(input.projectRoot);
  const workflowId = input.workflowId ?? createWorkflowId(input.task.id, "fix");
  const existing = await store.get(workflowId);
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  const startedAt = new Date().toISOString();
  const attemptNumber = existing
    ? existing.attempts.filter((attempt) => attempt.kind === "fix").length + 1
    : 1;
  const fixed = input.fixed === true;
  const exhausted = !fixed && attemptNumber >= maxAttempts;
  const completedAt = new Date().toISOString();
  const findings = fixed ? [] : findingsFromIssues(input.issues);
  const attempt: WorkflowAttemptRecord = {
    attempt: attemptNumber,
    kind: "fix",
    status: fixed ? "fixed" : exhausted ? "blocked" : "failed",
    startedAt,
    completedAt,
    verdict: fixed ? "FIXED" : exhausted ? "EXHAUSTED" : "NEEDS_RETRY",
    phaseResults: [
      {
        name: "fix_attempt",
        status: fixed ? "passed" : "failed",
        summary: fixed
          ? `Fix attempt ${attemptNumber} completed.`
          : `Fix attempt ${attemptNumber} did not resolve all issues.`,
      },
    ],
    findings,
  };

  const handoffBundle = exhausted
    ? createHandoffBundle(input.task.id, workflowId, input.issues, completedAt)
    : existing?.handoffBundle;
  const state = exhausted ? "blocked" : "verify_fix";
  const blockReasonCode = exhausted ? "workflow_attempts_exhausted" : undefined;

  const evidenceBundle = createEvidenceBundle({
    taskId: input.task.id,
    workflowId,
    workflowState: state,
    blockReasonCode,
    changedFiles: input.task.filesToModify.map((file) => file.path),
    findings,
    updatedAt: completedAt,
  });

  const record: WorkflowRecord = {
    workflowId,
    taskId: input.task.id,
    projectId: input.projectId,
    kind: "fix",
    status: exhausted ? "blocked" : fixed ? "completed" : "failed",
    state,
    blockReasonCode,
    attempts: [...(existing?.attempts ?? []), attempt],
    findings,
    evidenceBundle,
    handoffBundle,
    createdAt: existing?.createdAt ?? startedAt,
    updatedAt: completedAt,
  };

  await store.save(record);
  return {
    record,
    exhausted,
    statusCode: exhausted ? 409 : fixed ? 200 : 202,
  };
}
