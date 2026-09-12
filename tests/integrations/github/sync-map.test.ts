// ─── Sync Map Tests ─────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  GitHubSyncMap,
  withGitHubPublicationLock,
} from "../../../src/integrations/github/sync-map";
import type { SyncEntry } from "../../../src/integrations/github/github-types";

function makeEntry(taskId: string, issueNumber: number): SyncEntry {
  return {
    taskId,
    issueNumber,
    direction: "imported",
    createdAt: "2026-09-08T00:00:00.000Z",
    lastSyncedAt: "2026-09-08T00:00:00.000Z",
    issueState: "open",
    taskStatus: "BACKLOG",
  };
}

function waitForChildMessage(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (message) => {
      if ((message as { type?: string }).type === "locked") resolve();
      else reject(new Error(`Unexpected child message: ${JSON.stringify(message)}`));
    });
  });
}

function waitForChildExit(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock-holder child exited ${String(code)}: ${stderr()}`));
    });
  });
}

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

  it("waits for a cross-process writer and preserves both updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-race-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const lockPath = `${syncPath}.lock`;
    const parentMap = new GitHubSyncMap(syncPath);
    await parentMap.load();
    parentMap.addEntry(makeEntry("TASK-PARENT", 101));

    const childEntry = makeEntry("TASK-CHILD", 202);
    const childSource = String.raw`
      const fs = require("node:fs/promises");
      const os = require("node:os");
      const path = require("node:path");
      const syncPath = process.argv[1];
      const entry = JSON.parse(process.argv[2]);
      const lockPath = syncPath + ".lock";
      (async () => {
        await fs.mkdir(path.dirname(syncPath), { recursive: true });
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({
          version: 2,
          ownerToken: "00000000-0000-4000-8000-000000000201",
          pid: process.pid,
          host: os.hostname(),
          acquiredAt: new Date().toISOString(),
          processIdentity: { bootId: "child-test-boot", startedAt: "1" },
        }));
        const current = JSON.parse(await fs.readFile(syncPath, "utf8").catch((error) => {
          if (error && error.code === "ENOENT") return "{\"entries\":[]}";
          throw error;
        }));
        current.entries.push(entry);
        const tempPath = syncPath + ".child.tmp";
        await fs.writeFile(tempPath, JSON.stringify(current, null, 2), "utf8");
        await fs.rename(tempPath, syncPath);
        if (process.send) process.send({ type: "locked" });
        await new Promise((resolve) => process.once("message", resolve));
        await handle.close();
        await fs.unlink(lockPath);
      })().then(() => process.exit(0)).catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const child = spawn(
      process.execPath,
      ["-e", childSource, syncPath, JSON.stringify(childEntry)],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let childStderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf-8");
    });

    try {
      await waitForChildMessage(child);
      let saveSettled = false;
      const savePromise = parentMap.save().finally(() => {
        saveSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      const saveWaitedForLock = !saveSettled;

      child.send("release");
      await Promise.all([savePromise, waitForChildExit(child, () => childStderr)]);

      const parsed = JSON.parse(await fs.readFile(syncPath, "utf-8")) as { entries: SyncEntry[] };
      expect(saveWaitedForLock).toBe(true);
      expect(parsed.entries.map((entry) => entry.taskId).sort()).toEqual([
        "TASK-CHILD",
        "TASK-PARENT",
      ]);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null) {
        child.send("release");
        child.kill();
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("serializes complete transactions for the same sync-map file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-transaction-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const firstMap = new GitHubSyncMap(syncPath);
    const secondMap = new GitHubSyncMap(syncPath);
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeTransactions = 0;
    let maxActiveTransactions = 0;
    let secondEntered = false;

    const first = firstMap.withTransaction(async (map) => {
      activeTransactions += 1;
      maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
      firstEntered?.();
      await releaseFirstPromise;
      map.addEntry(makeEntry("TASK-FIRST", 301));
      activeTransactions -= 1;
    });

    try {
      await firstEnteredPromise;
      const second = secondMap.withTransaction((map) => {
        secondEntered = true;
        activeTransactions += 1;
        maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
        map.addEntry(makeEntry("TASK-SECOND", 302));
        activeTransactions -= 1;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(secondEntered).toBe(false);
      releaseFirst?.();
      await Promise.all([first, second]);

      const persisted = new GitHubSyncMap(syncPath);
      await persisted.load();
      expect(maxActiveTransactions).toBe(1);
      expect(
        persisted
          .getAllEntries()
          .map((entry) => entry.taskId)
          .sort(),
      ).toEqual(["TASK-FIRST", "TASK-SECOND"]);
    } finally {
      releaseFirst?.();
      await first.catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("merges a stale delete with an unrelated concurrent addition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-delete-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const seed = new GitHubSyncMap(syncPath);
    seed.addEntry(makeEntry("TASK-DELETE", 351));
    seed.addEntry(makeEntry("TASK-KEEP", 352));
    await seed.save();

    try {
      const deletingMap = new GitHubSyncMap(syncPath);
      const addingMap = new GitHubSyncMap(syncPath);
      await Promise.all([deletingMap.load(), addingMap.load()]);

      deletingMap.removeEntry("TASK-DELETE");
      addingMap.addEntry(makeEntry("TASK-ADDED", 353));
      await addingMap.save();
      await deletingMap.save();

      const persisted = new GitHubSyncMap(syncPath);
      await persisted.load();
      expect(
        persisted
          .getAllEntries()
          .map((entry) => entry.taskId)
          .sort(),
      ).toEqual(["TASK-ADDED", "TASK-KEEP"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock left by a dead writer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-stale-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const lockPath = `${syncPath}.lock`;
    await fs.mkdir(path.dirname(syncPath), { recursive: true });
    const ownerArtifact = `${path.basename(lockPath)}.owner.dead-00000000-0000-4000-8000-000000000401`;
    const ownerPath = path.join(path.dirname(lockPath), ownerArtifact);
    await fs.writeFile(
      ownerPath,
      JSON.stringify({
        version: 2,
        ownerToken: "00000000-0000-4000-8000-000000000401",
        pid: 999_999_999,
        host: os.hostname(),
        acquiredAt: "2000-01-01T00:00:00.000Z",
        processIdentity: { bootId: "dead-test-boot", startedAt: "1" },
        ownerArtifact,
      }),
    );
    await fs.link(ownerPath, lockPath);
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, oldTime, oldTime);

    try {
      const map = new GitHubSyncMap(syncPath, {
        lockRetryMs: 5,
        lockTimeoutMs: 500,
        staleLockMs: 10,
      });
      map.addEntry(makeEntry("TASK-RECOVERED", 401));
      await map.save();

      const parsed = JSON.parse(await fs.readFile(syncPath, "utf-8")) as { entries: SyncEntry[] };
      expect(parsed.entries.map((entry) => entry.taskId)).toEqual(["TASK-RECOVERED"]);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims and releases a stale GitHub publication lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-publication-lock-stale-"));
    const lockPath = path.join(root, ".quack", "sync", "github-publication.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const ownerArtifact = `${path.basename(lockPath)}.owner.dead-00000000-0000-4000-8000-000000000402`;
    const ownerPath = path.join(path.dirname(lockPath), ownerArtifact);
    await fs.writeFile(
      ownerPath,
      JSON.stringify({
        version: 2,
        ownerToken: "00000000-0000-4000-8000-000000000402",
        pid: 999_999_999,
        host: os.hostname(),
        acquiredAt: "2000-01-01T00:00:00.000Z",
        processIdentity: { bootId: "dead-test-boot", startedAt: "1" },
        ownerArtifact,
      }),
    );
    await fs.link(ownerPath, lockPath);
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, oldTime, oldTime);

    try {
      await expect(
        withGitHubPublicationLock(root, () => Promise.resolve("acquired"), {
          lockRetryMs: 5,
          lockTimeoutMs: 500,
          staleLockMs: 10,
        }),
      ).resolves.toBe("acquired");
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("releases its lock after failed persistence so a retry can succeed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-failure-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const lockPath = `${syncPath}.lock`;
    await fs.mkdir(syncPath, { recursive: true });
    const map = new GitHubSyncMap(syncPath);
    map.addEntry(makeEntry("TASK-RETRY", 501));

    try {
      await expect(map.save()).rejects.toBeDefined();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.rm(syncPath, { recursive: true, force: true });
      await map.save();
      const parsed = JSON.parse(await fs.readFile(syncPath, "utf-8")) as { entries: SyncEntry[] };
      expect(parsed.entries.map((entry) => entry.taskId)).toEqual(["TASK-RETRY"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("releases its lock when a transaction callback fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-callback-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const lockPath = `${syncPath}.lock`;
    const map = new GitHubSyncMap(syncPath);

    try {
      await expect(
        map.withTransaction(() => {
          throw new Error("injected transaction failure");
        }),
      ).rejects.toThrow("injected transaction failure");
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

      await map.withTransaction((writableMap) => {
        writableMap.addEntry(makeEntry("TASK-AFTER-FAILURE", 551));
      });
      const parsed = JSON.parse(await fs.readFile(syncPath, "utf-8")) as { entries: SyncEntry[] };
      expect(parsed.entries.map((entry) => entry.taskId)).toEqual(["TASK-AFTER-FAILURE"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("times out on an active lock without deleting its owner record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-sync-map-timeout-"));
    const syncPath = path.join(root, "sync", "github-sync.json");
    const lockPath = `${syncPath}.lock`;
    await fs.mkdir(path.dirname(syncPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerToken: "00000000-0000-4000-8000-000000000601",
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
        processIdentity: { bootId: "active-test-boot", startedAt: "1" },
      }),
    );

    try {
      const map = new GitHubSyncMap(syncPath, {
        lockRetryMs: 5,
        lockTimeoutMs: 50,
        staleLockMs: 30_000,
      });
      map.addEntry(makeEntry("TASK-BLOCKED", 601));
      await expect(map.save()).rejects.toThrow(`Timed out waiting for sync-map lock: ${lockPath}`);
      await expect(fs.readFile(lockPath, "utf-8")).resolves.toContain(
        '"ownerToken":"00000000-0000-4000-8000-000000000601"',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
