/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
// ─── QuackDB — SQLite Single Source of Truth ──────────────────────
// Replaces scattered file-based state (markdown status, sessions.jsonl,
// verified.json, in-memory Maps) with a single SQLite database.
// Uses WAL mode for concurrent reads and better-sqlite3's sync API.

import { runMigrations } from "./migrations.js";
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
  VerifiedHistoryRow,
  QuackDbHealth,
} from "./types.js";

// Lazy-load better-sqlite3 to avoid crashing at module import time
// when the native addon is built for a different Node.js version.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Database: any;
function getDatabase(): new (path: string) => any {
  if (!_Database) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Database = require("better-sqlite3");
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return _Database;
}

export class QuackDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private closed = false;

  constructor(dbPath: string) {
    const Database = getDatabase();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    runMigrations(this.db);
  }

  // ─── Task Status ──────────────────────────────────────────────

  getStatus(taskId: string): TaskStatusRow | undefined {
    return this.db.prepare("SELECT * FROM task_status WHERE task_id = ?").get(taskId) as
      | TaskStatusRow
      | undefined;
  }

  setStatus(taskId: string, status: string, updatedBy: string): void {
    const now = new Date().toISOString();
    const existing = this.getStatus(taskId);
    this.db
      .prepare(
        `INSERT INTO task_status (task_id, status, updated_at, updated_by, previous_status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           previous_status = task_status.status`,
      )
      .run(taskId, status, now, updatedBy, existing?.status ?? null);
  }

  getAllStatuses(): TaskStatusRow[] {
    return this.db.prepare("SELECT * FROM task_status").all() as TaskStatusRow[];
  }

  /**
   * Conditionally transition status — only updates if current status matches `fromStatus`.
   * Returns true if the transition was applied.
   */
  transitionStatus(
    taskId: string,
    fromStatus: string,
    toStatus: string,
    updatedBy: string,
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE task_status
         SET status = ?, updated_at = ?, updated_by = ?, previous_status = status
         WHERE task_id = ? AND status = ?`,
      )
      .run(toStatus, now, updatedBy, taskId, fromStatus);
    return result.changes > 0;
  }

  // ─── Sessions ─────────────────────────────────────────────────

  upsertSession(entry: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, task_id, project, title, start_time, status, outcome, total_cost_usd, duration_ms, turns_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           status = excluded.status,
           outcome = excluded.outcome,
           total_cost_usd = excluded.total_cost_usd,
           duration_ms = excluded.duration_ms,
           turns_used = excluded.turns_used`,
      )
      .run(
        entry.session_id,
        entry.task_id,
        entry.project,
        entry.title,
        entry.start_time,
        entry.status,
        entry.outcome,
        entry.total_cost_usd,
        entry.duration_ms,
        entry.turns_used,
      );
  }

  getSessionsForTask(taskId: string): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY start_time DESC")
      .all(taskId) as SessionRow[];
  }

  getLatestSession(taskId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY start_time DESC LIMIT 1")
      .get(taskId) as SessionRow | undefined;
  }

  getAllSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY start_time DESC").all() as SessionRow[];
  }

  // ─── Dispatch Jobs ────────────────────────────────────────────

  upsertJob(job: DispatchJobRow): void {
    this.db
      .prepare(
        `INSERT INTO dispatch_jobs (task_id, session_id, pid, started_at, status, exit_code, worktree_path, container_id, key_id, output_tail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           session_id = excluded.session_id,
           pid = excluded.pid,
           started_at = excluded.started_at,
           status = excluded.status,
           exit_code = excluded.exit_code,
           worktree_path = excluded.worktree_path,
           container_id = excluded.container_id,
           key_id = excluded.key_id,
           output_tail = excluded.output_tail`,
      )
      .run(
        job.task_id,
        job.session_id,
        job.pid,
        job.started_at,
        job.status,
        job.exit_code,
        job.worktree_path,
        job.container_id,
        job.key_id,
        job.output_tail,
      );
  }

  getJob(taskId: string): DispatchJobRow | undefined {
    return this.db.prepare("SELECT * FROM dispatch_jobs WHERE task_id = ?").get(taskId) as
      | DispatchJobRow
      | undefined;
  }

  getActiveJobs(): DispatchJobRow[] {
    return this.db
      .prepare("SELECT * FROM dispatch_jobs WHERE status = 'running'")
      .all() as DispatchJobRow[];
  }

  getAllJobs(): DispatchJobRow[] {
    return this.db
      .prepare("SELECT * FROM dispatch_jobs ORDER BY started_at DESC")
      .all() as DispatchJobRow[];
  }

  removeJob(taskId: string): void {
    this.db.prepare("DELETE FROM dispatch_jobs WHERE task_id = ?").run(taskId);
  }

  // ─── Verified ─────────────────────────────────────────────────

  setVerified(entry: VerifiedRow): void {
    const updatedAt = entry.updated_at ?? entry.verified_at;

    // TASK-1321: append to the history BEFORE the overwrite, and read the
    // outgoing verdict first so the history row can name what it replaced.
    // Both statements run in one transaction: a history row without its
    // matching `verified` update (or the reverse) would be a worse audit
    // trail than none, because it would look authoritative while being
    // half-applied.
    const writeBoth = this.db.transaction((row: VerifiedRow, at: string) => {
      const previous = this.db
        .prepare("SELECT verdict FROM verified WHERE task_id = ?")
        .get(row.task_id) as { verdict?: string } | undefined;

      this.db
        .prepare(
          `INSERT INTO verified_history (task_id, verified_at, recorded_at, commit_sha, method, verdict, criteria_checked, criteria_passed, notes, previous_verdict)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.task_id,
          row.verified_at,
          at,
          row.commit_sha,
          row.method,
          row.verdict,
          row.criteria_checked,
          row.criteria_passed,
          row.notes,
          previous?.verdict ?? null,
        );

      this.writeLatestVerified(row, at);
    });

    writeBoth(entry, updatedAt);
  }

  /** The pre-TASK-1321 write, unchanged: `verified` remains the fast
   *  latest-verdict lookup and every existing reader is untouched. */
  private writeLatestVerified(entry: VerifiedRow, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO verified (task_id, verified_at, updated_at, commit_sha, method, verdict, criteria_checked, criteria_passed, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at,
           commit_sha = excluded.commit_sha,
           method = excluded.method,
           verdict = excluded.verdict,
           criteria_checked = excluded.criteria_checked,
           criteria_passed = excluded.criteria_passed,
           notes = excluded.notes`,
      )
      .run(
        entry.task_id,
        entry.verified_at,
        updatedAt,
        entry.commit_sha,
        entry.method,
        entry.verdict,
        entry.criteria_checked,
        entry.criteria_passed,
        entry.notes,
      );
  }

  /**
   * Every recorded verification for a task, oldest first (TASK-1321).
   *
   * The point of the table: `getVerified` answers "what is the verdict
   * now", and only this answers "was it ever different". A task that was
   * VERIFIED and later re-verified SOFT-VERIFIED shows both rows here and
   * one row there.
   *
   * Starts empty on an existing database. History overwritten before the
   * migration is gone and cannot be reconstructed.
   */
  getVerifiedHistory(taskId: string): VerifiedHistoryRow[] {
    return this.db
      .prepare(
        `SELECT id, task_id, verified_at, recorded_at, commit_sha, method, verdict,
                criteria_checked, criteria_passed, notes, previous_verdict
         FROM verified_history WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(taskId) as VerifiedHistoryRow[];
  }

  getVerified(taskId: string): VerifiedRow | undefined {
    return this.db.prepare("SELECT * FROM verified WHERE task_id = ?").get(taskId) as
      | VerifiedRow
      | undefined;
  }

  getAllVerified(): Map<string, VerifiedRow> {
    const rows = this.db.prepare("SELECT * FROM verified").all() as VerifiedRow[];
    const map = new Map<string, VerifiedRow>();
    for (const row of rows) {
      map.set(row.task_id, row);
    }
    return map;
  }

  getVerifiedSince(since?: string, limit = 250): VerifiedRow[] {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    if (since && since.trim().length > 0) {
      return this.db
        .prepare(
          `SELECT *
             FROM verified
            WHERE COALESCE(updated_at, verified_at) >= ?
            ORDER BY COALESCE(updated_at, verified_at) ASC, task_id ASC
            LIMIT ?`,
        )
        .all(since, safeLimit) as VerifiedRow[];
    }

    return this.db
      .prepare(
        `SELECT *
           FROM verified
          ORDER BY COALESCE(updated_at, verified_at) ASC, task_id ASC
          LIMIT ?`,
      )
      .all(safeLimit) as VerifiedRow[];
  }

  // ─── Checkpoints ──────────────────────────────────────────────

  saveCheckpoint(cp: CheckpointRow): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (task_id, session_id, completed_stages, branch_name, total_cost_usd, retries_used, started_at, updated_at, parent_task_id, shared_branch, agent_result, judge_result, gate_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           session_id = excluded.session_id,
           completed_stages = excluded.completed_stages,
           branch_name = excluded.branch_name,
           total_cost_usd = excluded.total_cost_usd,
           retries_used = excluded.retries_used,
           updated_at = excluded.updated_at,
           parent_task_id = excluded.parent_task_id,
           shared_branch = excluded.shared_branch,
           agent_result = excluded.agent_result,
           judge_result = excluded.judge_result,
           gate_result = excluded.gate_result`,
      )
      .run(
        cp.task_id,
        cp.session_id,
        cp.completed_stages,
        cp.branch_name,
        cp.total_cost_usd,
        cp.retries_used,
        cp.started_at,
        cp.updated_at,
        cp.parent_task_id,
        cp.shared_branch,
        cp.agent_result,
        cp.judge_result,
        cp.gate_result,
      );
  }

  loadCheckpoint(taskId: string): CheckpointRow | undefined {
    return this.db.prepare("SELECT * FROM checkpoints WHERE task_id = ?").get(taskId) as
      | CheckpointRow
      | undefined;
  }

  deleteCheckpoint(taskId: string): void {
    this.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskId);
  }

  listCheckpoints(): CheckpointRow[] {
    return this.db
      .prepare("SELECT * FROM checkpoints ORDER BY updated_at DESC")
      .all() as CheckpointRow[];
  }

  // ─── Prep Cache ───────────────────────────────────────────────

  getPrep(taskId: string): PrepCacheRow | undefined {
    return this.db.prepare("SELECT * FROM prep_cache WHERE task_id = ?").get(taskId) as
      | PrepCacheRow
      | undefined;
  }

  getPrepByHash(taskId: string, hash: string): PrepCacheRow | undefined {
    return this.db
      .prepare("SELECT * FROM prep_cache WHERE task_id = ? AND content_hash = ?")
      .get(taskId, hash) as PrepCacheRow | undefined;
  }

  setPrep(entry: PrepCacheRow): void {
    this.db
      .prepare(
        `INSERT INTO prep_cache (task_id, prepared_at, schema_valid, depth_score, depth_ready, deficiencies, outcome, content_hash, stale, preflight_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           prepared_at = excluded.prepared_at,
           schema_valid = excluded.schema_valid,
           depth_score = excluded.depth_score,
           depth_ready = excluded.depth_ready,
           deficiencies = excluded.deficiencies,
           outcome = excluded.outcome,
           content_hash = excluded.content_hash,
           stale = excluded.stale,
           preflight_data = excluded.preflight_data`,
      )
      .run(
        entry.task_id,
        entry.prepared_at,
        entry.schema_valid,
        entry.depth_score,
        entry.depth_ready,
        entry.deficiencies,
        entry.outcome,
        entry.content_hash,
        entry.stale,
        entry.preflight_data,
      );
  }

  invalidatePrep(taskId: string): void {
    this.db.prepare("DELETE FROM prep_cache WHERE task_id = ?").run(taskId);
  }

  getReadinessSnapshot(taskId: string, specHash: string): ReadinessSnapshotRow | undefined {
    return this.db
      .prepare("SELECT * FROM readiness_snapshots WHERE task_id = ? AND spec_hash = ?")
      .get(taskId, specHash) as ReadinessSnapshotRow | undefined;
  }

  listReadinessSnapshots(taskId: string): ReadinessSnapshotRow[] {
    return this.db
      .prepare("SELECT * FROM readiness_snapshots WHERE task_id = ? ORDER BY updated_at DESC")
      .all(taskId) as ReadinessSnapshotRow[];
  }

  upsertReadinessSnapshot(entry: ReadinessSnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO readiness_snapshots (
           task_id,
           spec_hash,
           base_spec_hash,
           created_at,
           updated_at,
           schema_valid,
           schema_errors,
           depth_score,
           depth_ready,
           deficiencies,
           outcome,
           prep_data,
           preflight_data,
           effective_spec_data,
           stale_reason,
           source,
           generator_version
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, spec_hash) DO UPDATE SET
           base_spec_hash = excluded.base_spec_hash,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           schema_valid = excluded.schema_valid,
           schema_errors = excluded.schema_errors,
           depth_score = excluded.depth_score,
           depth_ready = excluded.depth_ready,
           deficiencies = excluded.deficiencies,
           outcome = excluded.outcome,
           prep_data = excluded.prep_data,
           preflight_data = excluded.preflight_data,
           effective_spec_data = excluded.effective_spec_data,
           stale_reason = excluded.stale_reason,
           source = excluded.source,
           generator_version = excluded.generator_version`,
      )
      .run(
        entry.task_id,
        entry.spec_hash,
        entry.base_spec_hash,
        entry.created_at,
        entry.updated_at,
        entry.schema_valid,
        entry.schema_errors,
        entry.depth_score,
        entry.depth_ready,
        entry.deficiencies,
        entry.outcome,
        entry.prep_data,
        entry.preflight_data,
        entry.effective_spec_data,
        entry.stale_reason,
        entry.source,
        entry.generator_version,
      );
  }

  getEffectiveSpec(
    taskId: string,
    baseSpecHash: string,
    effectiveSpecHash: string,
  ): EffectiveSpecRow | undefined {
    return this.db
      .prepare(
        `SELECT *
           FROM effective_specs
          WHERE task_id = ? AND base_spec_hash = ? AND effective_spec_hash = ?`,
      )
      .get(taskId, baseSpecHash, effectiveSpecHash) as EffectiveSpecRow | undefined;
  }

  listEffectiveSpecs(taskId: string): EffectiveSpecRow[] {
    return this.db
      .prepare("SELECT * FROM effective_specs WHERE task_id = ? ORDER BY updated_at DESC")
      .all(taskId) as EffectiveSpecRow[];
  }

  upsertEffectiveSpec(entry: EffectiveSpecRow): void {
    this.db
      .prepare(
        `INSERT INTO effective_specs (
           task_id,
           base_spec_hash,
           effective_spec_hash,
           status,
           content,
           deficiencies,
           source,
           created_at,
           updated_at,
           commit_sha
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, base_spec_hash, effective_spec_hash) DO UPDATE SET
           status = excluded.status,
           content = excluded.content,
           deficiencies = excluded.deficiencies,
           source = excluded.source,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           commit_sha = COALESCE(excluded.commit_sha, effective_specs.commit_sha)`,
      )
      .run(
        entry.task_id,
        entry.base_spec_hash,
        entry.effective_spec_hash,
        entry.status,
        entry.content,
        entry.deficiencies,
        entry.source,
        entry.created_at,
        entry.updated_at,
        entry.commit_sha ?? null,
      );
  }

  // ─── Queue Items ──────────────────────────────────────────────

  upsertQueueItem(item: QueueItemRow): void {
    this.db
      .prepare(
        `INSERT INTO queue_items (task_id, status, priority, blocked_by, enqueued_at, started_at, completed_at, outcome, cost_usd, duration_ms, retry_count, error, dispatch_options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           status = excluded.status,
           priority = excluded.priority,
           blocked_by = excluded.blocked_by,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           outcome = excluded.outcome,
           cost_usd = excluded.cost_usd,
           duration_ms = excluded.duration_ms,
           retry_count = excluded.retry_count,
           error = excluded.error,
           dispatch_options = excluded.dispatch_options`,
      )
      .run(
        item.task_id,
        item.status,
        item.priority,
        item.blocked_by,
        item.enqueued_at,
        item.started_at,
        item.completed_at,
        item.outcome,
        item.cost_usd,
        item.duration_ms,
        item.retry_count,
        item.error,
        item.dispatch_options,
      );
  }

  getQueueItem(taskId: string): QueueItemRow | undefined {
    return this.db.prepare("SELECT * FROM queue_items WHERE task_id = ?").get(taskId) as
      | QueueItemRow
      | undefined;
  }

  getAllQueueItems(): QueueItemRow[] {
    return this.db
      .prepare("SELECT * FROM queue_items ORDER BY priority DESC, enqueued_at ASC")
      .all() as QueueItemRow[];
  }

  removeQueueItem(taskId: string): void {
    this.db.prepare("DELETE FROM queue_items WHERE task_id = ?").run(taskId);
  }

  clearQueue(): void {
    this.db.prepare("DELETE FROM queue_items").run();
  }

  // ─── Transactions ─────────────────────────────────────────────

  /**
   * Run a function inside a SQLite transaction.
   * If the function throws, the transaction is rolled back.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Get the underlying database for advanced queries (e.g. custom JOINs).
   * Prefer using typed methods above when possible.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw(): any {
    if (this.closed) {
      throw new Error("QuackDB is closed");
    }
    return this.db;
  }

  getHealth(): QuackDbHealth {
    if (this.closed) return { mode: "sqlite", available: false, reason: "QuackDB is closed" };
    try {
      this.db.prepare("SELECT task_id FROM verified LIMIT 1").get();
      return { mode: "sqlite", available: true };
    } catch (error: unknown) {
      return {
        mode: "sqlite",
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort: close must still release the handle if checkpointing fails.
    }
    this.db.close();
  }
}
