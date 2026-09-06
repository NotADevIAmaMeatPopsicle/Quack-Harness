import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { WorkflowProjectionRecord } from "./state-projector.js";

export class WorkflowProjectionStore {
  private readonly projectionDir: string;

  constructor(projectRoot: string) {
    this.projectionDir = path.join(projectRoot, ".quack", "workflow-projections");
  }

  private projectionPath(taskId: string): string {
    return path.join(this.projectionDir, `${taskId}.json`);
  }

  async get(taskId: string): Promise<WorkflowProjectionRecord | null> {
    try {
      const raw = await fs.readFile(this.projectionPath(taskId), "utf-8");
      return JSON.parse(raw) as WorkflowProjectionRecord;
    } catch {
      return null;
    }
  }

  async save(record: WorkflowProjectionRecord): Promise<string> {
    await fs.mkdir(this.projectionDir, { recursive: true });
    const filePath = this.projectionPath(record.taskId);
    await fs.writeFile(filePath, JSON.stringify(record, null, 2) + "\n", "utf-8");
    return filePath;
  }
}
