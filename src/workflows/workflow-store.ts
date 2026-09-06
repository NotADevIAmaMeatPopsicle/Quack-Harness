import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { EvidenceBundle } from "../workflow/evidence-bundle.js";
import type { BlockReasonCode, WorkflowState } from "../workflow/workflow-state-types.js";

export type WorkflowKind = "verify" | "fix";
export type WorkflowStatus = "completed" | "blocked" | "failed";
export type WorkflowAttemptStatus = "passed" | "failed" | "blocked" | "fixed";

export interface WorkflowPhaseResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  summary?: string;
}

export interface WorkflowFindingRecord {
  title: string;
  severity: "P1" | "P2" | "P3";
  status: "open" | "resolved" | "waived";
  file?: string;
}

export interface WorkflowAttemptRecord {
  attempt: number;
  kind: WorkflowKind;
  status: WorkflowAttemptStatus;
  startedAt: string;
  completedAt: string;
  verdict: string;
  phaseResults: WorkflowPhaseResult[];
  findings: WorkflowFindingRecord[];
}

export interface ManualHandoffBundle {
  taskId: string;
  workflowId: string;
  blockReasonCode: BlockReasonCode;
  issues: string[];
  createdAt: string;
  summary: string;
}

export interface WorkflowRecord {
  workflowId: string;
  taskId: string;
  projectId?: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  state: WorkflowState;
  blockReasonCode?: BlockReasonCode;
  attempts: WorkflowAttemptRecord[];
  findings: WorkflowFindingRecord[];
  evidenceBundle: EvidenceBundle;
  handoffBundle?: ManualHandoffBundle;
  createdAt: string;
  updatedAt: string;
}

export function createWorkflowId(taskId: string, kind: WorkflowKind): string {
  const seed = `${taskId}:${kind}:${new Date().toISOString()}:${crypto.randomUUID()}`;
  const suffix = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `workflow-${taskId.toLowerCase()}-${kind}-${suffix}`;
}

export class WorkflowStore {
  private readonly workflowDir: string;
  private readonly recordsPath: string;

  constructor(projectRoot: string) {
    this.workflowDir = path.join(projectRoot, ".quack", "workflows");
    this.recordsPath = path.join(this.workflowDir, "records.jsonl");
  }

  async get(workflowId: string): Promise<WorkflowRecord | undefined> {
    try {
      const raw = await fs.readFile(this.recordPath(workflowId), "utf-8");
      return JSON.parse(raw) as WorkflowRecord;
    } catch {
      return undefined;
    }
  }

  async save(record: WorkflowRecord): Promise<WorkflowRecord> {
    await fs.mkdir(this.workflowDir, { recursive: true });
    await fs.writeFile(
      this.recordPath(record.workflowId),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
    await fs.appendFile(this.recordsPath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  private recordPath(workflowId: string): string {
    return path.join(this.workflowDir, `${workflowId}.json`);
  }
}
