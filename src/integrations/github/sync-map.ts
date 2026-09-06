/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
// ─── Sync Map ───────────────────────────────────────────────────────
// Bidirectional mapping between task IDs and GitHub issue numbers.
// Stored at .quack/sync/github-sync.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SyncMap, SyncEntry } from "./github-types.js";
import type { AdapterConfig } from "../../core/types.js";

// ─── Sync Map Class ─────────────────────────────────────────────────

export class GitHubSyncMap {
  private entries: Map<string, SyncEntry> = new Map();
  private syncFilePath: string;

  constructor(syncFilePath: string) {
    this.syncFilePath = syncFilePath;
  }

  /**
   * Load sync map from disk.
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.syncFilePath, "utf-8");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const data: SyncMap = JSON.parse(content);
      this.entries.clear();
      for (const entry of data.entries) {
        this.entries.set(entry.taskId, entry);
      }
    } catch (err: unknown) {
      // File doesn't exist yet — start with empty map
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries.clear();
        return;
      }
      throw err;
    }
  }

  /**
   * Save sync map to disk.
   */
  async save(): Promise<void> {
    const data: SyncMap = {
      entries: Array.from(this.entries.values()),
    };
    await fs.mkdir(path.dirname(this.syncFilePath), { recursive: true });
    await fs.writeFile(this.syncFilePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Add a new sync entry.
   */
  addEntry(entry: SyncEntry): void {
    this.entries.set(entry.taskId, entry);
  }

  /**
   * Get entry by task ID.
   */
  getEntryByTaskId(taskId: string): SyncEntry | undefined {
    return this.entries.get(taskId);
  }

  /**
   * Get entry by issue number.
   */
  getEntryByIssueNumber(issueNumber: number): SyncEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.issueNumber === issueNumber) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Check if a task ID is already mapped.
   */
  hasTask(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /**
   * Check if an issue number is already mapped.
   */
  hasIssue(issueNumber: number): boolean {
    return this.getEntryByIssueNumber(issueNumber) !== undefined;
  }

  /**
   * Get issue number for a task (if mapped).
   */
  getIssueForTask(taskId: string): number | undefined {
    const entry = this.entries.get(taskId);
    return entry?.issueNumber;
  }

  /**
   * Get task ID for an issue (if mapped).
   */
  getTaskForIssue(issueNumber: number): string | undefined {
    const entry = this.getEntryByIssueNumber(issueNumber);
    return entry?.taskId;
  }

  /**
   * Update sync timestamp for a task.
   */
  updateSyncTime(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      entry.lastSyncedAt = new Date().toISOString();
    }
  }

  /**
   * Update task status for a sync entry.
   */
  updateTaskStatus(taskId: string, status: string): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      entry.taskStatus = status;
      entry.lastSyncedAt = new Date().toISOString();
    }
  }

  /**
   * Update issue state for a sync entry.
   */
  updateIssueState(taskId: string, state: "open" | "closed"): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      entry.issueState = state;
      entry.lastSyncedAt = new Date().toISOString();
    }
  }

  /**
   * Get all entries.
   */
  getAllEntries(): SyncEntry[] {
    return Array.from(this.entries.values());
  }
}

// ─── Factory Function ───────────────────────────────────────────────

/**
 * Get or create a GitHubSyncMap instance for the given adapter config.
 */
export async function getSyncMap(config: AdapterConfig): Promise<GitHubSyncMap> {
  const syncFilePath = path.join(config.project.root, ".quack", "sync", "github-sync.json");
  const syncMap = new GitHubSyncMap(syncFilePath);
  await syncMap.load();
  return syncMap;
}
