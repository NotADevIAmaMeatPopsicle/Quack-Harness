/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
// ─── Sync Map ───────────────────────────────────────────────────────
// Bidirectional mapping between task IDs and GitHub issue numbers.
// Stored at .quack/sync/github-sync.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SyncMap, SyncEntry } from "./github-types.js";
import {
  FederatedJobLockBusyError,
  withOwnerFencedFileLock,
} from "../../monitor/federation/store.js";

export interface SyncMapLockOptions {
  lockRetryMs: number;
  lockTimeoutMs: number;
  staleLockMs: number;
}

const DEFAULT_LOCK_OPTIONS: SyncMapLockOptions = {
  lockRetryMs: 20,
  lockTimeoutMs: 60_000,
  staleLockMs: 30_000,
};

export class LegacyGitHubLockError extends Error {
  readonly code = "github_legacy_lock_requires_offline_recovery";

  constructor(public readonly lockPath: string) {
    super(
      `Legacy GitHub lock preserved: ${lockPath}. Stop every Quack process using this project, ` +
        "confirm no writer remains, then archive this lock offline before retrying. " +
        "Do not run old and new Quack writers concurrently.",
    );
    this.name = "LegacyGitHubLockError";
  }
}

type SyncMapMutation = { type: "upsert"; entry: SyncEntry } | { type: "delete"; taskId: string };

function cloneEntry(entry: SyncEntry): SyncEntry {
  return { ...entry };
}

function cloneEntries(entries: Map<string, SyncEntry>): Map<string, SyncEntry> {
  return new Map(Array.from(entries, ([taskId, entry]) => [taskId, cloneEntry(entry)]));
}

function entriesEqual(left: SyncEntry, right: SyncEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffEntries(
  baseline: Map<string, SyncEntry>,
  current: Map<string, SyncEntry>,
): SyncMapMutation[] {
  const mutations: SyncMapMutation[] = [];
  for (const taskId of baseline.keys()) {
    if (!current.has(taskId)) mutations.push({ type: "delete", taskId });
  }
  for (const [taskId, entry] of current) {
    const prior = baseline.get(taskId);
    if (!prior || !entriesEqual(prior, entry)) {
      mutations.push({ type: "upsert", entry: cloneEntry(entry) });
    }
  }
  return mutations;
}

function applyMutations(entries: Map<string, SyncEntry>, mutations: SyncMapMutation[]): void {
  for (const mutation of mutations) {
    if (mutation.type === "delete") entries.delete(mutation.taskId);
    else entries.set(mutation.entry.taskId, cloneEntry(mutation.entry));
  }
}

async function readEntries(syncFilePath: string): Promise<Map<string, SyncEntry>> {
  try {
    const content = await fs.readFile(syncFilePath, "utf-8");
    const data = JSON.parse(content) as SyncMap;
    return new Map(data.entries.map((entry) => [entry.taskId, cloneEntry(entry)]));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

async function refuseLegacyGitHubLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    let record: unknown;
    try {
      record = JSON.parse(await fs.readFile(lockPath, "utf-8")) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new LegacyGitHubLockError(lockPath);
      throw error;
    }
    if (
      typeof record !== "object" ||
      record === null ||
      !("version" in record) ||
      (record.version !== 1 && record.version !== 2)
    ) {
      // Old writers do not participate in the fenced reclaim protocol. Neither
      // age nor a dead PID makes it safe to unlink their lock during an upgrade.
      throw new LegacyGitHubLockError(lockPath);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

async function withSyncMapFileLock<T>(
  syncFilePath: string,
  options: SyncMapLockOptions,
  operation: () => Promise<T>,
  trustedBoundaryRoot: string,
): Promise<T> {
  const lockPath = `${syncFilePath}.lock`;
  await refuseLegacyGitHubLock(lockPath);
  try {
    return await withOwnerFencedFileLock(lockPath, trustedBoundaryRoot, operation, {
      retryMs: options.lockRetryMs,
      waitTimeoutMs: options.lockTimeoutMs,
      staleMs: options.staleLockMs,
    });
  } catch (error: unknown) {
    if (error instanceof FederatedJobLockBusyError) {
      throw new Error(`Timed out waiting for sync-map lock: ${lockPath}`, { cause: error });
    }
    throw error;
  }
}

async function writeEntriesAtomically(
  syncFilePath: string,
  entries: Map<string, SyncEntry>,
): Promise<void> {
  const tempPath = `${syncFilePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const data: SyncMap = { entries: Array.from(entries.values()) };
  await fs.mkdir(path.dirname(syncFilePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempPath, syncFilePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

// ─── Sync Map Class ─────────────────────────────────────────────────

export class GitHubSyncMap {
  private entries: Map<string, SyncEntry> = new Map();
  private baselineEntries: Map<string, SyncEntry> = new Map();
  private readonly syncFilePath: string;
  private readonly lockOptions: SyncMapLockOptions;
  private readonly trustedBoundaryRoot: string;

  constructor(
    syncFilePath: string,
    lockOptions: Partial<SyncMapLockOptions> = {},
    trustedBoundaryRoot = path.dirname(path.resolve(syncFilePath)),
  ) {
    this.syncFilePath = syncFilePath;
    this.lockOptions = { ...DEFAULT_LOCK_OPTIONS, ...lockOptions };
    this.trustedBoundaryRoot = trustedBoundaryRoot;
  }

  /**
   * Load sync map from disk.
   */
  async load(): Promise<void> {
    this.entries = await readEntries(this.syncFilePath);
    this.baselineEntries = cloneEntries(this.entries);
  }

  /**
   * Save sync map to disk.
   */
  async save(): Promise<void> {
    await withSyncMapFileLock(
      this.syncFilePath,
      this.lockOptions,
      async () => {
        await this.saveWhileLocked();
      },
      this.trustedBoundaryRoot,
    );
  }

  /**
   * Run a complete read/mutate/write cycle while holding the per-file lock.
   * The callback must not call save(); the successful result is persisted once.
   */
  async withTransaction<T>(operation: (syncMap: GitHubSyncMap) => Promise<T> | T): Promise<T> {
    return withSyncMapFileLock(
      this.syncFilePath,
      this.lockOptions,
      async () => {
        await this.load();
        const result = await operation(this);
        await this.saveWhileLocked();
        return result;
      },
      this.trustedBoundaryRoot,
    );
  }

  private async saveWhileLocked(): Promise<void> {
    const beforeSave = cloneEntries(this.entries);
    const mutations = diffEntries(this.baselineEntries, beforeSave);
    const persisted = await readEntries(this.syncFilePath);
    applyMutations(persisted, mutations);
    await writeEntriesAtomically(this.syncFilePath, persisted);

    const mutationsDuringSave = diffEntries(beforeSave, this.entries);
    this.baselineEntries = cloneEntries(persisted);
    this.entries = cloneEntries(persisted);
    applyMutations(this.entries, mutationsDuringSave);
  }

  /**
   * Add a new sync entry.
   */
  addEntry(entry: SyncEntry): void {
    this.entries.set(entry.taskId, entry);
  }

  /**
   * Remove an entry by task ID.
   */
  removeEntry(taskId: string): SyncEntry | undefined {
    const entry = this.entries.get(taskId);
    this.entries.delete(taskId);
    return entry;
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

/** Resolve the one sync-map file for an already loaded adapter. */
export function resolveGitHubSyncMapPath(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("GitHub sync-map project root must be absolute");
  }
  return path.join(projectRoot, ".quack", "sync", "github-sync.json");
}

/** Get a GitHubSyncMap using the loaded adapter's absolute root. */
export async function getSyncMap(projectRoot: string): Promise<GitHubSyncMap> {
  const syncFilePath = resolveGitHubSyncMapPath(projectRoot);
  const syncMap = new GitHubSyncMap(syncFilePath, {}, projectRoot);
  await syncMap.load();
  return syncMap;
}

/**
 * Serialize a complete sync-map transaction across processes.
 */
export async function withSyncMapTransaction<T>(
  projectRoot: string,
  operation: (syncMap: GitHubSyncMap) => Promise<T> | T,
  lockOptions: Partial<SyncMapLockOptions> = {},
): Promise<T> {
  const syncFilePath = resolveGitHubSyncMapPath(projectRoot);
  return new GitHubSyncMap(syncFilePath, lockOptions, projectRoot).withTransaction(operation);
}

/**
 * Serialize GitHub issue publication for one project across processes.
 *
 * This deliberately shares the sync map's durable lock implementation while
 * using a separate lock file so an issue reservation can span remote reads,
 * creation, and recovery without holding a sync-map transaction open.
 */
export async function withGitHubPublicationLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
  lockOptions: Partial<SyncMapLockOptions> = {},
): Promise<T> {
  const lockTargetPath = path.join(
    path.resolve(projectRoot),
    ".quack",
    "sync",
    "github-publication",
  );
  return withSyncMapFileLock(
    lockTargetPath,
    { ...DEFAULT_LOCK_OPTIONS, ...lockOptions },
    operation,
    projectRoot,
  );
}
