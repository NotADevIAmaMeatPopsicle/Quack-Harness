/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
// ─── NoopDB — Fallback when SQLite is unavailable ──────────────────
// Used when the better-sqlite3 native module can't load (e.g., Node
// version mismatch). All methods return empty/undefined — the system
// falls back to the existing file-based state derivation.

import type {
  TaskStatusRow,
  SessionRow,
  DispatchJobRow,
  VerifiedRow,
  CheckpointRow,
  PrepCacheRow,
  ReadinessSnapshotRow,
  EffectiveSpecRow,
  QueueItemRow,
} from "./types.js";

export class NoopDB {
  getStatus(): TaskStatusRow | undefined {
    return undefined;
  }
  setStatus(): void {
    /* noop */
  }
  getAllStatuses(): TaskStatusRow[] {
    return [];
  }
  transitionStatus(): boolean {
    return false;
  }

  upsertSession(): void {
    /* noop */
  }
  getSessionsForTask(): SessionRow[] {
    return [];
  }
  getLatestSession(): SessionRow | undefined {
    return undefined;
  }
  getAllSessions(): SessionRow[] {
    return [];
  }

  upsertJob(): void {
    /* noop */
  }
  getJob(): DispatchJobRow | undefined {
    return undefined;
  }
  getActiveJobs(): DispatchJobRow[] {
    return [];
  }
  getAllJobs(): DispatchJobRow[] {
    return [];
  }
  removeJob(): void {
    /* noop */
  }

  setVerified(): void {
    /* noop */
  }
  getVerified(): VerifiedRow | undefined {
    return undefined;
  }
  getAllVerified(): Map<string, VerifiedRow> {
    return new Map();
  }
  getVerifiedSince(): VerifiedRow[] {
    return [];
  }

  saveCheckpoint(): void {
    /* noop */
  }
  loadCheckpoint(): CheckpointRow | undefined {
    return undefined;
  }
  deleteCheckpoint(): void {
    /* noop */
  }
  listCheckpoints(): CheckpointRow[] {
    return [];
  }

  getPrep(): PrepCacheRow | undefined {
    return undefined;
  }
  getPrepByHash(): PrepCacheRow | undefined {
    return undefined;
  }
  setPrep(): void {
    /* noop */
  }
  invalidatePrep(): void {
    /* noop */
  }
  getReadinessSnapshot(): ReadinessSnapshotRow | undefined {
    return undefined;
  }
  listReadinessSnapshots(): ReadinessSnapshotRow[] {
    return [];
  }
  upsertReadinessSnapshot(): void {
    /* noop */
  }
  getEffectiveSpec(): EffectiveSpecRow | undefined {
    return undefined;
  }
  listEffectiveSpecs(): EffectiveSpecRow[] {
    return [];
  }
  upsertEffectiveSpec(): void {
    /* noop */
  }

  upsertQueueItem(): void {
    /* noop */
  }
  getQueueItem(): QueueItemRow | undefined {
    return undefined;
  }
  getAllQueueItems(): QueueItemRow[] {
    return [];
  }
  removeQueueItem(): void {
    /* noop */
  }
  clearQueue(): void {
    /* noop */
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw(): any {
    return null;
  }
  close(): void {
    /* noop */
  }
}
