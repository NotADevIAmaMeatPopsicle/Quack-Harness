import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LaneClassification } from "./lane-classifier.js";
import {
  createRouteDecision,
  type IntakeRouteDecision,
  type RemoteTaskIntakeRequest,
  type TaskIntakeRecord,
  type ValidationIntakePayload,
} from "./task-intake.js";

export interface IntakeCreateResult {
  record: TaskIntakeRecord;
  replayed: boolean;
}

interface IdempotencyIndex {
  keys: Record<string, string>;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function intakeIdFor(input: RemoteTaskIntakeRequest, createdAt: string): string {
  const seed =
    input.idempotencyKey ??
    JSON.stringify({
      taskId: input.taskId,
      title: input.title,
      source: input.source,
      createdAt,
      nonce: crypto.randomUUID(),
    });
  return `intake-${sha256(seed).slice(0, 16)}`;
}

export class IntakeStore {
  private readonly intakeDir: string;
  private readonly indexPath: string;
  private readonly recordsPath: string;

  constructor(projectRoot: string) {
    this.intakeDir = path.join(projectRoot, ".quack", "intake");
    this.indexPath = path.join(this.intakeDir, "idempotency.json");
    this.recordsPath = path.join(this.intakeDir, "records.jsonl");
  }

  async create(
    input: RemoteTaskIntakeRequest,
    classification: LaneClassification,
    projectId?: string,
    /**
     * TASK-1106: Validation Intake payload to persist alongside the record.
     * Only meaningful when `input.intakeType === "validation"` — for forward
     * intake, this MUST be undefined.
     */
    validationPayload?: ValidationIntakePayload,
  ): Promise<IntakeCreateResult> {
    await fs.mkdir(this.intakeDir, { recursive: true });

    if (input.idempotencyKey) {
      const index = await this.readIndex();
      const existingId = index.keys[input.idempotencyKey];
      if (existingId) {
        const existing = await this.get(existingId);
        if (existing) {
          return { record: existing, replayed: true };
        }
      }
    }

    const createdAt = new Date().toISOString();
    const intakeId = intakeIdFor(input, createdAt);
    // TASK-1106: discriminator field. Default `"forward"` is enforced by the
    // Zod schema's `.default()` on remoteTaskIntakeSchema; we re-affirm it here
    // so the persisted record never has an undefined `intakeType` (older
    // records on disk MAY have undefined — readers default to "forward" then).
    const intakeType: "forward" | "validation" = input.intakeType ?? "forward";
    const record: TaskIntakeRecord = {
      intakeId,
      workflowId: `workflow-${intakeId}`,
      sessionId: `intake-${intakeId}`,
      status: "classified",
      taskId: input.taskId,
      source: input.source,
      title: input.title,
      description: input.description,
      priority: input.priority,
      tags: input.tags,
      files: input.files,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      requestedLane: input.requestedLane,
      metadata: input.metadata,
      classification,
      projectId,
      createdAt,
      updatedAt: createdAt,
      intakeType,
      // Only persist the validation payload when the caller actually
      // submitted one — keeps forward-intake records identical on disk to
      // their pre-TASK-1106 shape (plus the new `intakeType` field).
      ...(intakeType === "validation" && validationPayload ? { validationPayload } : {}),
    };

    await this.save(record);

    if (input.idempotencyKey) {
      const index = await this.readIndex();
      index.keys[input.idempotencyKey] = intakeId;
      await this.writeIndex(index);
    }

    return { record, replayed: false };
  }

  async get(intakeId: string): Promise<TaskIntakeRecord | undefined> {
    try {
      const raw = await fs.readFile(this.recordPath(intakeId), "utf-8");
      return JSON.parse(raw) as TaskIntakeRecord;
    } catch {
      return undefined;
    }
  }

  async route(
    intakeId: string,
    decision: IntakeRouteDecision,
  ): Promise<TaskIntakeRecord | undefined> {
    const record = await this.get(intakeId);
    if (!record) return undefined;

    const routedAt = new Date().toISOString();
    const route = createRouteDecision(decision, record.classification.riskLevel, routedAt);

    const updated: TaskIntakeRecord = {
      ...record,
      status: "routed",
      route,
      updatedAt: routedAt,
    };
    await this.save(updated);
    return updated;
  }

  private recordPath(intakeId: string): string {
    return path.join(this.intakeDir, `${intakeId}.json`);
  }

  private async save(record: TaskIntakeRecord): Promise<void> {
    await fs.mkdir(this.intakeDir, { recursive: true });
    await fs.writeFile(this.recordPath(record.intakeId), JSON.stringify(record, null, 2), "utf-8");
    await fs.appendFile(this.recordsPath, JSON.stringify(record) + "\n", "utf-8");
  }

  private async readIndex(): Promise<IdempotencyIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as IdempotencyIndex;
      return { keys: parsed.keys ?? {} };
    } catch {
      return { keys: {} };
    }
  }

  private async writeIndex(index: IdempotencyIndex): Promise<void> {
    await fs.mkdir(this.intakeDir, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
  }
}
