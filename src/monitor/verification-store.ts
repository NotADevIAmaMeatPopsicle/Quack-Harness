// ─── Verification Store ────────────────────────────────────────────
// Single canonical writer for the `verified` table + the companion
// `.quack/verified.json` ledger. Resolves the drift bug surfaced by
// ISSUES-2026-04-29 §5/§8 and the production incident on 2026-04-29 where
// 18 tasks had verified.json saying VERIFIED but quack.db `task_status`
// stuck at IN_PROGRESS, blocking dependency resolution.
//
// Before this module, four callers wrote independently:
//   - dispatcher/lifecycle-manager.ts:599
//   - monitor/server.ts /api/tasks/:id/reject
//   - monitor/server.ts /api/tasks/:id/verified  (only wrote DB, NOT JSON — TASK-829)
//   - monitor/server.ts recordFederatedVerifiedTask
//
// All four now route through `recordVerification()`. The function:
//   - Writes the DB row (INSERT OR REPLACE).
//   - Updates the JSON ledger with deterministic key ordering and a
//     stable canonical entry shape, preserving any existing entries that
//     are not for this task.
//   - Updates task_status (COMPLETE on VERIFIED, REJECTED on REJECTED).
//
// The `regenerateProjection()` helper rebuilds the entire JSON document
// from the DB. Called on monitor startup (Phase 2) so a freshly-cloned host
// converges to the DB-as-truth view, and so the JSON file format is
// always deterministic for git diffs.
//
// Federation sync (Phase 3) lives in src/federation/verified-sync.ts and
// calls into this module via `recordVerification(..., { syncToPeers: false })`
// when applying a peer-pushed row.

import * as path from "node:path";
import { promises as fsPromises } from "node:fs";
import { randomUUID } from "node:crypto";

import type { VerifiedRow, QuackDbHealth } from "../db/types.js";
import { withOwnerFencedFileLock } from "./federation/store.js";
import { verificationEntrySchema } from "./verification-schema.js";
import {
  buildStrictDuplicateClaimantIndex,
  duplicateClaimantRefusalForIndex,
  type DuplicateClaimantIndex,
  type DuplicateClaimantRefusal,
} from "../core/duplicate-claimants.js";
import { listTaskClaimantDeclarations } from "../core/task-file-resolver.js";

/**
 * Minimal slice of `ResolvedProject` (defined inside createMonitorServer) that
 * the verification store needs. Defined locally so verification-store stays
 * importable by both server.ts and any tooling without circular deps.
 */
export interface VerificationStoreProject {
  projectRoot: string | undefined;
  taskDir?: string;
  db: {
    getHealth(): QuackDbHealth;
    setVerified(entry: VerifiedRow): void;
    getVerified(taskId: string): VerifiedRow | undefined;
    getAllVerified(): Map<string, VerifiedRow>;
    setStatus(taskId: string, status: string, source: string): void;
  };
}

type ResolvedProject = VerificationStoreProject;

// ─── Public API ────────────────────────────────────────────────────

export interface VerificationEntry {
  taskId: string;
  verdict: "VERIFIED" | "FAILED" | "REJECTED" | "SOFT-VERIFIED" | "CANNOT_VERIFY";
  commitSha: string;
  /** Free-text method label (e.g. "/verify-task", "api", "federated-orchestrator", "federation-sync"). */
  method: string;
  criteriaChecked: number;
  criteriaPassed: number;
  notes?: string | null;
  /** Defaults to today (YYYY-MM-DD) if omitted. */
  verifiedAt?: string;
  /** Monotonic sync cursor. Defaults to the current timestamp if omitted. */
  updatedAt?: string;
  /** Optional review-bundle id for cross-reference; stored in the JSON entry's notes. */
  reviewId?: string;
  /** Optional verification workflow id; stored in the JSON entry's notes. */
  workflowId?: string;
}

export interface RecordOptions {
  /**
   * When false, skip the federation push-on-write. Set by the receiving side of
   * federation sync to avoid push loops. Default: true.
   *
   * NOTE: actual push behavior is implemented in TASK-867 Phase 3
   * (`src/federation/verified-sync.ts`). For now this flag is plumbed through
   * but the push code is a no-op.
   */
  syncToPeers?: boolean;
  /**
   * When true, also call `db.setStatus()` to advance task_status. Default: true.
   * Set false when the caller has already updated status (e.g. lifecycle-manager
   * advances status itself with extra metadata).
   */
  updateTaskStatus?: boolean;
  /**
   * When set, skip the write entirely if an existing row's verdict is in this
   * list (returns `applied: false, skippedReason: "existing-verdict"`).
   * TASK-1201: lets low-assurance writers (on-merge scanner, backfill) never
   * downgrade a VERIFIED/SOFT-VERIFIED row. Evaluated in the same synchronous
   * better-sqlite3 tick as the write, so the guard is atomic in-process —
   * a caller-side read-then-write would race concurrent writes under the
   * write-recency precedence.
   */
  skipIfExistingVerdict?: string[];
  /**
   * Re-run status and JSON projection writes for an identical canonical row.
   * Journaled callers use this to finish a partially persisted compound effect.
   */
  replayIdenticalEffects?: boolean;
  /**
   * Internal deterministic crash seam for callers that journal a compound
   * verification effect. Each stage means that local sub-effect is durable.
   */
  afterLocalEffectForTest?: (
    stage:
      | "verification_row_persisted"
      | "verification_status_persisted"
      | "verification_projection_persisted",
  ) => void | Promise<void>;
  /** Internal deterministic seam used to hold one projection read in flight. */
  afterProjectionReadForTest?: (taskId: string) => void | Promise<void>;
  /** Internal deterministic crash seam for atomic projection publication. */
  afterProjectionPersistenceStageForTest?: (
    stage: VerificationProjectionPersistenceStage,
    taskId: string,
  ) => void | Promise<void>;
}

export type VerificationProjectionPersistenceStage =
  | "projection_temp_file_synced"
  | "projection_published"
  | "projection_published_file_synced"
  | "projection_directory_synced"
  | "projection_durability_acknowledged";

export interface NormalizedVerificationEntry extends VerificationEntry {
  verifiedAt: string;
  updatedAt: string;
  notes?: string | null;
}

export interface RecordVerificationResult {
  applied: boolean;
  skippedReason?:
    | "stale"
    | "identical"
    | "existing-verdict"
    | "duplicate-claimants"
    | "claimant-index-unavailable";
  row: VerifiedRow;
  refusal?: DuplicateClaimantRefusal;
}

type VerificationPeerSyncHandler = (
  p: ResolvedProject,
  entry: NormalizedVerificationEntry,
) => Promise<void>;

const verificationPeerSyncHandlers = new Map<string, VerificationPeerSyncHandler>();

export function setVerificationPeerSyncHandler(
  projectRoot: string | undefined,
  handler: VerificationPeerSyncHandler | undefined,
): void {
  if (!projectRoot) return;
  if (handler) {
    verificationPeerSyncHandlers.set(projectRoot, handler);
    return;
  }
  verificationPeerSyncHandlers.delete(projectRoot);
}

/**
 * Atomically record a verification: writes DB row, updates JSON ledger,
 * advances task_status. Idempotent — calling twice with the same taskId
 * updates in place; never duplicates.
 */
export async function recordVerification(
  p: ResolvedProject,
  entry: VerificationEntry,
  options: RecordOptions = {},
  claimantIndex?: DuplicateClaimantIndex,
): Promise<RecordVerificationResult> {
  const validated = verificationEntrySchema.parse(entry);
  assertVerificationDatabaseAvailable(p);
  const write = async (): Promise<RecordVerificationResult> => {
    assertVerificationDatabaseAvailable(p);
    const doc = p.projectRoot
      ? await readJsonOrDefault(path.join(p.projectRoot, ".quack", "verified.json"))
      : undefined;
    return recordVerificationLocked(p, validated, options, claimantIndex, doc);
  };
  return p.projectRoot ? withVerificationProjectionLock(p.projectRoot, write) : write();
}

async function recordVerificationLocked(
  p: ResolvedProject,
  entry: VerificationEntry,
  options: RecordOptions,
  claimantIndex: DuplicateClaimantIndex | undefined,
  projection: VerifiedJsonDocument | undefined,
): Promise<RecordVerificationResult> {
  const verifiedAt = entry.verifiedAt ?? todayIso();
  const updatedAt = entry.updatedAt ?? nowIso();
  const notes = composeNotes(entry);

  const row: VerifiedRow = {
    task_id: entry.taskId,
    verified_at: verifiedAt,
    updated_at: updatedAt,
    commit_sha: entry.commitSha,
    method: entry.method,
    verdict: entry.verdict,
    criteria_checked: entry.criteriaChecked,
    criteria_passed: entry.criteriaPassed,
    notes,
  };

  const existing = p.db.getVerified(entry.taskId);
  let identical = false;
  if (existing && options.skipIfExistingVerdict?.includes(existing.verdict)) {
    return { applied: false, skippedReason: "existing-verdict", row: existing };
  }
  if (existing) {
    const precedence = compareVerifiedRows(row, existing);
    if (precedence < 0) {
      return { applied: false, skippedReason: "stale", row: existing };
    }
    if (precedence === 0 && verifiedRowsEqual(row, existing)) {
      // An identical canonical row does not prove the later status and JSON
      // projection effects survived. Continue through those idempotent writes
      // so a journal replay converges every sub-effect after a crash.
      identical = true;
      if (options.replayIdenticalEffects !== true) {
        return { applied: false, skippedReason: "identical", row: existing };
      }
    }
  }

  if (
    !identical &&
    claimantIndex &&
    (entry.verdict === "VERIFIED" || entry.verdict === "SOFT-VERIFIED")
  ) {
    const refusal = duplicateClaimantRefusalForIndex(claimantIndex, entry.taskId);
    if (refusal) {
      return {
        applied: false,
        skippedReason:
          claimantIndex.status === "unavailable"
            ? "claimant-index-unavailable"
            : "duplicate-claimants",
        row,
        refusal,
      };
    }
  }

  // 1. DB write. On an identical replay the row is already durable, but the
  // same boundary is reported so deterministic crash tests exercise replay.
  if (!identical) p.db.setVerified(row);
  await options.afterLocalEffectForTest?.("verification_row_persisted");

  // 2. Task status update — caller can opt out if they advance status themselves.
  if (options.updateTaskStatus !== false) {
    if (entry.verdict === "VERIFIED" || entry.verdict === "SOFT-VERIFIED") {
      p.db.setStatus(entry.taskId, "COMPLETE", entry.method);
    } else if (entry.verdict === "REJECTED") {
      p.db.setStatus(entry.taskId, "REJECTED", entry.method);
    }
  }
  await options.afterLocalEffectForTest?.("verification_status_persisted");

  // 3. JSON ledger update — only when projectRoot is configured. The store
  // tolerates missing projectRoot for tests + non-disk monitors.
  if (p.projectRoot) {
    await upsertJsonEntryLocked(
      p.projectRoot,
      projection as VerifiedJsonDocument,
      entry.taskId,
      {
        verified: verifiedAt,
        commit: entry.commitSha,
        method: entry.method,
        verdict: entry.verdict,
        criteriaChecked: entry.criteriaChecked,
        criteriaPassed: entry.criteriaPassed,
        reviewId: entry.reviewId,
        workflowId: entry.workflowId,
        notes,
      },
      options.afterProjectionReadForTest,
      options.afterProjectionPersistenceStageForTest,
    );
  }
  await options.afterLocalEffectForTest?.("verification_projection_persisted");

  // 4. Push to peers (Phase 3 — currently a no-op stub).
  // Wired so future code can light up federation sync without touching
  // call sites. When implemented, push fire-and-forget; do not block the
  // local write on peer reachability.
  const peerSyncHandler = p.projectRoot
    ? verificationPeerSyncHandlers.get(p.projectRoot)
    : undefined;
  if (!identical && options.syncToPeers !== false && peerSyncHandler) {
    const normalizedEntry: NormalizedVerificationEntry = {
      ...entry,
      notes,
      verifiedAt,
      updatedAt,
    };
    void peerSyncHandler(p, normalizedEntry).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verification-store] peer sync push failed for ${entry.taskId}: ${msg}`);
    });
  }

  return identical
    ? { applied: false, skippedReason: "identical", row: existing ?? row }
    : { applied: true, row };
}

/**
 * Rebuild `.quack/verified.json` from the DB `verified` table. Deterministic:
 * same DB rows -> identical bytes. Used at monitor startup (Phase 2) and as a
 * recovery tool when the JSON gets out of sync.
 *
 * Preserves the JSON document's `_description` and `_schema` headers if they
 * already exist. DB rows win for their IDs; JSON-only evidence is retained
 * until it can be reconciled, including skipped or interrupted migrations.
 */
export async function regenerateProjection(p: ResolvedProject): Promise<{ entryCount: number }> {
  if (!p.projectRoot) return { entryCount: 0 };
  assertVerificationDatabaseAvailable(p);
  const projectRoot = p.projectRoot;
  return withVerificationProjectionLock(projectRoot, () =>
    regenerateProjectionLocked(p, projectRoot),
  );
}

async function regenerateProjectionLocked(
  p: ResolvedProject,
  projectRoot: string,
): Promise<{ entryCount: number }> {
  assertVerificationDatabaseAvailable(p);
  const allRows = p.db.getAllVerified();
  const jsonPath = path.join(projectRoot, ".quack", "verified.json");
  const existing = await readJsonOrDefault(jsonPath);
  const tasks: Record<string, unknown> = { ...existing.tasks };
  const sortedTaskIds = Array.from(allRows.keys()).sort((a, b) => a.localeCompare(b));
  for (const taskId of sortedTaskIds) {
    const row = allRows.get(taskId);
    if (!row) continue;
    tasks[taskId] = rowToLedgerEntry(row);
  }

  const doc: VerifiedJsonDocument = {
    ...existing,
    _description:
      existing._description ??
      "Post-completion verification index. Records which COMPLETE tasks have been independently verified. Regenerated from quack.db on monitor startup.",
    _schema: existing._schema ?? {
      taskId: "TASK-NNN",
      verified: "ISO date",
      method: "string",
      verdict: "string",
    },
    tasks: Object.fromEntries(Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b))),
  };

  await writeProjectionAtomically(jsonPath, doc, "__projection-regeneration__");
  return { entryCount: Object.keys(tasks).length };
}

/**
 * Detect rows present in the DB but missing from the JSON ledger (the
 * specific drift the production 2026-04-29 incident hit). Returns the missing
 * task IDs without writing anything. Caller chooses whether to run a full
 * `regenerateProjection` or surface the diagnostic.
 */
export async function findDbJsonDrift(p: ResolvedProject): Promise<{
  missingFromJson: string[];
  missingFromDb: string[];
}> {
  if (!p.projectRoot) return { missingFromJson: [], missingFromDb: [] };
  assertVerificationDatabaseAvailable(p);
  const dbRows = p.db.getAllVerified();
  const jsonPath = path.join(p.projectRoot, ".quack", "verified.json");
  const json = await readJsonOrDefault(jsonPath);
  const dbIds = new Set(dbRows.keys());
  const jsonIds = new Set(Object.keys(json.tasks ?? {}));

  const missingFromJson: string[] = [];
  for (const id of dbIds) if (!jsonIds.has(id)) missingFromJson.push(id);

  const missingFromDb: string[] = [];
  for (const id of jsonIds) if (!dbIds.has(id)) missingFromDb.push(id);

  return {
    missingFromJson: missingFromJson.sort(),
    missingFromDb: missingFromDb.sort(),
  };
}

export interface ReconcileResult {
  /** IDs added to DB from JSON (the production-2026-04-29 case). */
  jsonToDb: string[];
  /** IDs added to JSON from DB. */
  dbToJson: string[];
  /** IDs whose task_status was promoted (e.g. IN_PROGRESS → COMPLETE) to match a VERIFIED row. */
  taskStatusFixed: string[];
  promotionsSkipped: string[];
  unavailable?: string;
}

export interface ReconcileOptions {
  claimantIndex?: DuplicateClaimantIndex;
  taskDir?: string;
  log?: (message: string) => void;
}

/**
 * Reconcile drift between the DB `verified` table and `verified.json`. Catches
 * BOTH the production scenario (lifecycle-manager wrote JSON, DB stayed
 * IN_PROGRESS) and the legacy scenario (admin wrote DB via direct SQL, JSON
 * stayed empty).
 *
 * Direction policy:
 *   - JSON has entry, DB doesn't  -> write DB row from JSON entry, advance status.
 *   - DB has row, JSON doesn't    -> append JSON entry from DB row.
 *   - Both have entries           -> no-op (do not pick a winner — neither side
 *                                    has stronger guarantees, and a wrong
 *                                    overwrite is worse than transient drift).
 *
 * Always also walks DB rows with verdict=VERIFIED and ensures task_status is
 * COMPLETE — this is the specific fix for the 2026-04-29 incident where 18
 * tasks were VERIFIED in DB but task_status was stuck at IN_PROGRESS, which
 * blocked dependency resolution downstream.
 */
export async function reconcileVerifiedDrift(
  p: ResolvedProject,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (!p.projectRoot) {
    return { jsonToDb: [], dbToJson: [], taskStatusFixed: [], promotionsSkipped: [] };
  }
  assertVerificationDatabaseAvailable(p);
  const projectRoot = p.projectRoot;
  return withVerificationProjectionLock(projectRoot, () =>
    reconcileVerifiedDriftLocked(p, options, projectRoot),
  );
}

async function reconcileVerifiedDriftLocked(
  p: ResolvedProject,
  options: ReconcileOptions,
  projectRoot: string,
): Promise<ReconcileResult> {
  assertVerificationDatabaseAvailable(p);
  const dbRows = p.db.getAllVerified();
  const jsonPath = path.join(projectRoot, ".quack", "verified.json");
  const json = await readJsonOrDefault(jsonPath);

  const result: ReconcileResult = {
    jsonToDb: [],
    dbToJson: [],
    taskStatusFixed: [],
    promotionsSkipped: [],
  };
  const effectiveClaimantIndex =
    options.claimantIndex ??
    (options.taskDir
      ? await buildStrictDuplicateClaimantIndex(() =>
          listTaskClaimantDeclarations(options.taskDir as string),
        )
      : undefined);
  if (effectiveClaimantIndex?.status === "unavailable") {
    result.unavailable = effectiveClaimantIndex.reason;
  }
  const refusePromotion = (taskId: string): boolean => {
    if (!effectiveClaimantIndex) return false;
    const refusal = duplicateClaimantRefusalForIndex(effectiveClaimantIndex, taskId);
    if (!refusal) return false;
    if (!result.promotionsSkipped.includes(taskId)) result.promotionsSkipped.push(taskId);
    options.log?.(
      `[verification-store] positive promotion skipped for ${taskId}: ${refusal.message}`,
    );
    return true;
  };

  // 1. JSON entries missing from DB -> insert.
  for (const [taskId, rawEntry] of Object.entries(json.tasks ?? {})) {
    if (dbRows.has(taskId)) continue;
    const entry = parseReconcilableLedgerEntry(taskId, rawEntry);
    if (!entry) {
      options.log?.(
        `[verification-store] preserving unreconciled entry for ${taskId}: invalid verification evidence`,
      );
      continue;
    }
    if (
      (entry.verdict === "VERIFIED" || entry.verdict === "SOFT-VERIFIED") &&
      refusePromotion(taskId)
    ) {
      continue;
    }
    p.db.setVerified({
      task_id: taskId,
      verified_at: entry.verified,
      commit_sha: entry.commit,
      method: entry.method,
      verdict: entry.verdict,
      criteria_checked: entry.criteriaChecked,
      criteria_passed: entry.criteriaPassed,
      notes: appendReconcileMarker(entry.notes ?? null, "json->db"),
    });
    if (entry.verdict === "VERIFIED" || entry.verdict === "SOFT-VERIFIED") {
      p.db.setStatus(taskId, "COMPLETE", "reconcile");
    } else if (entry.verdict === "REJECTED") {
      p.db.setStatus(taskId, "REJECTED", "reconcile");
    }
    result.jsonToDb.push(taskId);
  }

  // 2. DB rows missing from JSON -> append.
  // Re-fetch dbRows since step 1 may have added entries.
  const dbRowsAfter = p.db.getAllVerified();
  let jsonDirty = false;
  for (const [taskId, row] of dbRowsAfter) {
    if (taskId in (json.tasks ?? {})) continue;
    if (!json.tasks) json.tasks = {};
    json.tasks[taskId] = {
      verified: row.verified_at,
      commit: row.commit_sha,
      method: row.method,
      verdict: row.verdict,
      criteriaChecked: row.criteria_checked,
      criteriaPassed: row.criteria_passed,
      reviewId: extractStructuredNoteValue(row.notes, "reviewId"),
      workflowId: extractStructuredNoteValue(row.notes, "workflowId"),
      notes: appendReconcileMarker(row.notes, "db->json"),
    };
    result.dbToJson.push(taskId);
    jsonDirty = true;
  }

  // 3. Status drift: VERIFIED in `verified` table but task_status not COMPLETE.
  // This is the specific bug the 2026-04-29 production incident surfaced —
  // 18 tasks had verified.json saying VERIFIED but task_status stuck at
  // IN_PROGRESS, which blocked dependency resolution.
  for (const [taskId, row] of dbRowsAfter) {
    if (row.verdict !== "VERIFIED" && row.verdict !== "SOFT-VERIFIED") continue;
    if (refusePromotion(taskId)) continue;
    // We can't easily peek at task_status without a getter; conservatively
    // re-call setStatus("COMPLETE") which is idempotent (INSERT OR REPLACE
    // shape). If the row was already COMPLETE this is a no-op write.
    p.db.setStatus(taskId, "COMPLETE", "reconcile");
    // We can't tell if the row was actually changed without a read-back;
    // record that we touched it so callers can log.
    result.taskStatusFixed.push(taskId);
  }

  if (jsonDirty) {
    // Sort task keys for deterministic git diffs.
    const sortedTasks: Record<string, unknown> = {};
    for (const k of Object.keys(json.tasks ?? {}).sort((a, b) => a.localeCompare(b))) {
      const v = (json.tasks ?? {})[k];
      sortedTasks[k] = v;
    }
    json.tasks = sortedTasks;
    await writeProjectionAtomically(jsonPath, json, "__projection-reconciliation__");
  }

  return result;
}

function parseReconcilableLedgerEntry(taskId: string, entry: unknown): JsonLedgerEntry | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const value = entry as Record<string, unknown>;
  const parsed = verificationEntrySchema.safeParse({
    taskId,
    verdict: value.verdict,
    commitSha: value.commit,
    method: value.method,
    criteriaChecked: value.criteriaChecked,
    criteriaPassed: value.criteriaPassed,
    verifiedAt: value.verified,
    notes: value.notes,
    reviewId: value.reviewId,
    workflowId: value.workflowId,
  });
  // A new verification may default to today, but a legacy record must carry
  // its actual historical date. Never invent that date during reconciliation.
  if (!parsed.success || parsed.data.verifiedAt === undefined) return undefined;
  const normalized = parsed.data;
  return {
    verified: parsed.data.verifiedAt,
    commit: normalized.commitSha,
    method: normalized.method,
    verdict: normalized.verdict,
    criteriaChecked: normalized.criteriaChecked,
    criteriaPassed: normalized.criteriaPassed,
    notes: normalized.notes ?? null,
    reviewId: normalized.reviewId,
    workflowId: normalized.workflowId,
  };
}

function appendReconcileMarker(notes: string | null, direction: string): string {
  const marker = `[reconciled-at-startup:${direction}]`;
  if (!notes) return marker;
  if (notes.includes(marker)) return notes; // idempotent
  return `${notes} ${marker}`;
}

// ─── Internal helpers ──────────────────────────────────────────────

interface JsonLedgerEntry {
  verified: string;
  commit: string;
  method: string;
  verdict: string;
  criteriaChecked: number;
  criteriaPassed: number;
  reviewId?: string;
  workflowId?: string;
  notes: string | null;
}

interface VerifiedJsonDocument {
  _description?: string;
  _schema?: Record<string, string>;
  tasks: Record<string, unknown>;
}

const verificationProjectionTails = new Map<string, Promise<void>>();

async function withVerificationProjectionLock<T>(
  projectRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(projectRoot);
  const predecessor = verificationProjectionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => current);
  verificationProjectionTails.set(key, tail);
  await predecessor;
  try {
    return await withOwnerFencedFileLock(
      path.join(key, ".quack", "verified.json.lock"),
      key,
      action,
    );
  } finally {
    release();
    if (verificationProjectionTails.get(key) === tail) {
      verificationProjectionTails.delete(key);
    }
  }
}

export function assertVerificationDatabaseAvailable(p: ResolvedProject): void {
  const health = p.db.getHealth();
  if (!health.available) throw new VerificationDatabaseUnavailableError(health.reason);
}

export class VerificationDatabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(`Verification database is unavailable: ${reason}`);
    this.name = "VerificationDatabaseUnavailableError";
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function composeNotes(entry: VerificationEntry): string | null {
  const fragments: string[] = [];
  if (entry.workflowId) fragments.push(`workflowId=${entry.workflowId}`);
  if (entry.reviewId) fragments.push(`reviewId=${entry.reviewId}`);
  if (entry.notes && entry.notes.trim().length > 0) fragments.push(entry.notes.trim());
  return fragments.length > 0 ? fragments.join("; ") : null;
}

function rowToLedgerEntry(row: VerifiedRow): JsonLedgerEntry {
  return {
    verified: row.verified_at,
    commit: row.commit_sha,
    method: row.method,
    verdict: row.verdict,
    criteriaChecked: row.criteria_checked,
    criteriaPassed: row.criteria_passed,
    reviewId: extractStructuredNoteValue(row.notes, "reviewId"),
    workflowId: extractStructuredNoteValue(row.notes, "workflowId"),
    notes: row.notes ?? null,
  };
}

function compareVerifiedRows(candidate: VerifiedRow, existing: VerifiedRow): number {
  // Precedence is by WRITE-RECENCY, not by lexical commit SHA (QPI-022). A commit SHA
  // is not a recency signal: a descendant commit can sort lexically below its ancestor,
  // and non-SHA placeholder strings ("zzzz-…", "probe", "x") would otherwise hijack
  // precedence and let a junk write permanently beat a real one. Rank by the monotonic
  // write timestamp (updated_at, an ISO-8601 datetime → lexical order == chronological),
  // then the verification date, and use commit_sha only as a final deterministic
  // tiebreaker when both timestamps are identical.
  const candidateUpdated = candidate.updated_at ?? candidate.verified_at;
  const existingUpdated = existing.updated_at ?? existing.verified_at;
  const updatedCmp = candidateUpdated.localeCompare(existingUpdated);
  if (updatedCmp !== 0) return updatedCmp;

  const verifiedCmp = candidate.verified_at.localeCompare(existing.verified_at);
  if (verifiedCmp !== 0) return verifiedCmp;

  return candidate.commit_sha.localeCompare(existing.commit_sha);
}

function verifiedRowsEqual(a: VerifiedRow, b: VerifiedRow): boolean {
  return (
    a.task_id === b.task_id &&
    a.verified_at === b.verified_at &&
    (a.updated_at ?? a.verified_at) === (b.updated_at ?? b.verified_at) &&
    a.commit_sha === b.commit_sha &&
    a.method === b.method &&
    a.verdict === b.verdict &&
    a.criteria_checked === b.criteria_checked &&
    a.criteria_passed === b.criteria_passed &&
    (a.notes ?? null) === (b.notes ?? null)
  );
}

function extractStructuredNoteValue(
  notes: string | null | undefined,
  key: "reviewId" | "workflowId",
): string | undefined {
  if (!notes) return undefined;
  const match = notes.match(new RegExp(`${key}=([^;\\s]+)`));
  return match?.[1];
}

async function upsertJsonEntryLocked(
  projectRoot: string,
  doc: VerifiedJsonDocument,
  taskId: string,
  entry: JsonLedgerEntry,
  afterReadForTest?: (taskId: string) => void | Promise<void>,
  afterPersistenceStageForTest?: (
    stage: VerificationProjectionPersistenceStage,
    taskId: string,
  ) => void | Promise<void>,
): Promise<void> {
  const jsonPath = path.join(projectRoot, ".quack", "verified.json");
  await afterReadForTest?.(taskId);
  doc.tasks[taskId] = entry;
  // Sort task keys for deterministic git diffs.
  const sortedTasks: Record<string, unknown> = {};
  for (const k of Object.keys(doc.tasks).sort((a, b) => a.localeCompare(b))) {
    const v = doc.tasks[k];
    sortedTasks[k] = v;
  }
  doc.tasks = sortedTasks;
  await writeProjectionAtomically(jsonPath, doc, taskId, afterPersistenceStageForTest);
}

async function syncProjectionDirectoryIfSupported(directory: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(directory, "r");
    await handle.sync();
    return true;
  } catch (error: unknown) {
    if (
      ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeProjectionAtomically(
  jsonPath: string,
  doc: VerifiedJsonDocument,
  taskId: string,
  afterStageForTest?: (
    stage: VerificationProjectionPersistenceStage,
    taskId: string,
  ) => void | Promise<void>,
): Promise<void> {
  const directory = path.dirname(jsonPath);
  await fsPromises.mkdir(directory, { recursive: true });
  const temporary = `${jsonPath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const temporaryHandle = await fsPromises.open(temporary, "wx", 0o600);
    try {
      await temporaryHandle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, "utf-8");
      await temporaryHandle.sync();
      await afterStageForTest?.("projection_temp_file_synced", taskId);
    } finally {
      await temporaryHandle.close();
    }
    await fsPromises.rename(temporary, jsonPath);
    renamed = true;
    await afterStageForTest?.("projection_published", taskId);
    const publishedHandle = await fsPromises.open(jsonPath, "r+");
    try {
      await publishedHandle.sync();
    } finally {
      await publishedHandle.close();
    }
    await afterStageForTest?.("projection_published_file_synced", taskId);
    if (await syncProjectionDirectoryIfSupported(directory)) {
      await afterStageForTest?.("projection_directory_synced", taskId);
    }
    await afterStageForTest?.("projection_durability_acknowledged", taskId);
  } finally {
    if (!renamed) {
      await fsPromises.unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

async function readJsonOrDefault(jsonPath: string): Promise<VerifiedJsonDocument> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(jsonPath, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      _description:
        "Post-completion verification index. Records which COMPLETE tasks have been independently verified. Regenerated from quack.db on monitor startup.",
      _schema: { taskId: "TASK-NNN", verified: "ISO date", method: "string", verdict: "string" },
      tasks: {},
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (cause: unknown) {
    throw new Error(`Verification projection is not valid JSON; preserve and repair ${jsonPath}`, {
      cause,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("tasks" in parsed) ||
    typeof parsed.tasks !== "object" ||
    parsed.tasks === null ||
    Array.isArray(parsed.tasks)
  ) {
    throw new Error(
      `Verification projection must contain an object tasks map; preserve and repair ${jsonPath}`,
    );
  }
  // Individual legacy/unreconciled entries remain opaque until validation in
  // reconciliation. Reading or regenerating must not discard their evidence.
  return parsed as VerifiedJsonDocument;
}
