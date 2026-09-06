// ─── Sync Map Tests ─────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitHubSyncMap } from "../../../src/integrations/github/sync-map";
import type { SyncEntry } from "../../../src/integrations/github/github-types";

describe("GitHubSyncMap", () => {
  const testSyncPath = path.join(__dirname, ".test-sync-map.json");
  let syncMap: GitHubSyncMap;

  beforeEach(() => {
    syncMap = new GitHubSyncMap(testSyncPath);
  });

  afterEach(async () => {
    try {
      await fs.unlink(testSyncPath);
    } catch {
      // File might not exist
    }
  });

  it("should add and retrieve entries by task ID", () => {
    const entry: SyncEntry = {
      taskId: "TASK-001",
      issueNumber: 42,
      direction: "imported",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    };

    syncMap.addEntry(entry);

    expect(syncMap.getEntryByTaskId("TASK-001")).toEqual(entry);
    expect(syncMap.hasTask("TASK-001")).toBe(true);
    expect(syncMap.getIssueForTask("TASK-001")).toBe(42);
  });

  it("should retrieve entries by issue number", () => {
    const entry: SyncEntry = {
      taskId: "TASK-002",
      issueNumber: 99,
      direction: "published",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    };

    syncMap.addEntry(entry);

    expect(syncMap.getEntryByIssueNumber(99)).toEqual(entry);
    expect(syncMap.hasIssue(99)).toBe(true);
    expect(syncMap.getTaskForIssue(99)).toBe("TASK-002");
  });

  it("should detect duplicates", () => {
    const entry1: SyncEntry = {
      taskId: "TASK-003",
      issueNumber: 10,
      direction: "imported",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    };

    syncMap.addEntry(entry1);

    expect(syncMap.hasTask("TASK-003")).toBe(true);
    expect(syncMap.hasIssue(10)).toBe(true);
    expect(syncMap.hasTask("TASK-999")).toBe(false);
    expect(syncMap.hasIssue(999)).toBe(false);
  });

  it("should persist and load from file", async () => {
    const entry: SyncEntry = {
      taskId: "TASK-004",
      issueNumber: 20,
      direction: "imported",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    };

    syncMap.addEntry(entry);
    await syncMap.save();

    // Create new instance and load
    const newSyncMap = new GitHubSyncMap(testSyncPath);
    await newSyncMap.load();

    expect(newSyncMap.hasTask("TASK-004")).toBe(true);
    expect(newSyncMap.getIssueForTask("TASK-004")).toBe(20);
  });

  it("should update sync timestamps", () => {
    const entry: SyncEntry = {
      taskId: "TASK-005",
      issueNumber: 30,
      direction: "imported",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date("2024-01-01").toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    };

    syncMap.addEntry(entry);
    const oldTime = syncMap.getEntryByTaskId("TASK-005")!.lastSyncedAt;

    syncMap.updateSyncTime("TASK-005");
    const newTime = syncMap.getEntryByTaskId("TASK-005")!.lastSyncedAt;
    expect(newTime).not.toBe(oldTime);
  });

  it("should return all entries", () => {
    syncMap.addEntry({
      taskId: "TASK-006",
      issueNumber: 40,
      direction: "imported",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "BACKLOG",
    });

    syncMap.addEntry({
      taskId: "TASK-007",
      issueNumber: 41,
      direction: "published",
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      issueState: "open",
      taskStatus: "READY",
    });

    const entries = syncMap.getAllEntries();
    expect(entries.length).toBe(2);
  });
});
