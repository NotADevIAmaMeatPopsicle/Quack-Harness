/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { NoopDB, QuackDB } from "../db/index.js";
import type { EffectiveSpecRow, PrepCacheRow, ReadinessSnapshotRow } from "../db/types.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import { PrepCache, computeContentHash, type PrepResult } from "./prep-cache.js";
import type { TaskService } from "./task-service.js";

const READINESS_GENERATOR_VERSION = "task-887-g-v1";

type ReadinessDb = QuackDB | NoopDB;

export interface EffectiveSpecSummary {
  taskId: string;
  baseSpecHash: string;
  effectiveSpecHash: string;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  /**
   * TASK-922 follow-up: commit SHA when this effective spec was committed to
   * the canonical clone by enrichment auto-commit. Undefined when no commit
   * was created (autoCommit disabled, protected branch, dirty tree, preview
   * only) or for rows written before the column existed.
   */
  commitSha?: string;
}

export interface CurrentReadinessState {
  taskId: string;
  currentSpecHash: string;
  taskFilePath: string;
  prep: PrepResult | null;
  preflight: PreflightResult | null;
  hasStalePrep: boolean;
  hasStalePreflight: boolean;
  staleReasons: string[];
  dispatchBlockReason: string | null;
  snapshot: ReadinessSnapshotRow | null;
  currentEffectiveSpec: EffectiveSpecSummary | null;
  effectiveSpecs: EffectiveSpecSummary[];
}

export interface PersistEffectiveSpecInput {
  taskId: string;
  baseSpecContent: string;
  effectiveContent: string;
  status: "proposed" | "accepted" | "rejected";
  source: string;
  deficiencies?: string[];
  /**
   * TASK-922 / follow-up: when the enrichment auto-commit succeeded for this
   * spec, persist the resulting commit SHA on the effective_specs row so
   * future audit queries can correlate enrichments to dev commits.
   * Optional; omit when no commit was created (autoCommit off, skipped,
   * preview-only persist, etc.).
   */
  commitSha?: string;
}

export function openReadinessDb(projectRoot: string): ReadinessDb {
  try {
    return new QuackDB(path.resolve(projectRoot, ".quack", "quack.db"));
  } catch {
    return new NoopDB();
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonBlob<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function snapshotToPrepResult(
  snapshot: ReadinessSnapshotRow | undefined,
  specHash: string,
): PrepResult | null {
  if (!snapshot) return null;

  const parsed = parseJsonBlob<PrepResult>(snapshot.prep_data);
  if (parsed) {
    return {
      ...parsed,
      stale: false,
      contentHash: parsed.contentHash ?? specHash,
    };
  }

  return {
    taskId: snapshot.task_id,
    preparedAt: snapshot.updated_at,
    schemaValid: snapshot.schema_valid === 1,
    schemaErrors: parseJsonArray(snapshot.schema_errors),
    depthScore: snapshot.depth_score,
    depthReady: snapshot.depth_ready === 1,
    deficiencies: parseJsonArray(snapshot.deficiencies),
    outcome: snapshot.outcome as PrepResult["outcome"],
    stale: false,
    contentHash: specHash,
  };
}

function snapshotToPreflightResult(
  snapshot: ReadinessSnapshotRow | undefined,
): PreflightResult | null {
  return parseJsonBlob<PreflightResult>(snapshot?.preflight_data);
}

function toEffectiveSpecSummary(row: EffectiveSpecRow): EffectiveSpecSummary {
  return {
    taskId: row.task_id,
    baseSpecHash: row.base_spec_hash,
    effectiveSpecHash: row.effective_spec_hash,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commitSha: row.commit_sha ?? undefined,
  };
}

function toEffectiveSpecPayload(row: EffectiveSpecRow): Record<string, string> {
  return {
    taskId: row.task_id,
    baseSpecHash: row.base_spec_hash,
    effectiveSpecHash: row.effective_spec_hash,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReadinessService {
  private ownedDb: ReadinessDb | null = null;

  constructor(
    private readonly deps: {
      projectRoot: string;
      taskService?: TaskService | null;
      prepCache?: PrepCache | null;
      db?: ReadinessDb;
    },
  ) {}

  close(): void {
    if (!this.ownedDb) return;
    this.ownedDb.close();
    this.ownedDb = null;
  }

  async resolveCurrent(taskId: string): Promise<CurrentReadinessState | null> {
    const current = await this.readCurrentSpec(taskId);
    if (!current) return null;

    const db = this.getDb();
    const snapshots = db.listReadinessSnapshots(taskId);
    const snapshot = snapshots.find((row) => row.spec_hash === current.specHash);
    const effectiveSpecRows = db.listEffectiveSpecs(taskId);
    const currentEffectiveSpecRow = effectiveSpecRows.find(
      (row) => row.status === "accepted" && row.effective_spec_hash === current.specHash,
    );

    let prep: PrepResult | null = snapshotToPrepResult(snapshot, current.specHash);
    let preflight: PreflightResult | null = snapshotToPreflightResult(snapshot);
    let hasStalePrep = snapshots.some(
      (row) => row.spec_hash !== current.specHash && Boolean(row.prep_data),
    );
    let hasStalePreflight = snapshots.some(
      (row) => row.spec_hash !== current.specHash && Boolean(row.preflight_data),
    );

    if (this.deps.prepCache) {
      const prepCandidate = await this.deps.prepCache.read(
        taskId,
        current.filePath,
        current.specHash,
      );
      if (prepCandidate && !prepCandidate.stale) {
        prep = prepCandidate;
      } else if (prepCandidate?.stale) {
        hasStalePrep = true;
      }

      const currentPreflight = await this.deps.prepCache.readPreflight(taskId, current.specHash);
      if (currentPreflight) {
        preflight = currentPreflight;
      } else {
        const anyPreflight = await this.deps.prepCache.readPreflight(taskId);
        hasStalePreflight = Boolean(anyPreflight && anyPreflight.contentHash !== current.specHash);
      }
    }

    if (prep) {
      hasStalePrep = false;
    }
    if (preflight) {
      hasStalePreflight = false;
    }

    const staleReasons: string[] = [];
    if (hasStalePrep) staleReasons.push("prep_stale");
    if (hasStalePreflight) staleReasons.push("preflight_stale");

    return {
      taskId,
      currentSpecHash: current.specHash,
      taskFilePath: current.filePath,
      prep,
      preflight,
      hasStalePrep,
      hasStalePreflight,
      staleReasons,
      dispatchBlockReason: this.computeDispatchBlockReason(prep, preflight, hasStalePrep),
      snapshot: snapshot ?? null,
      currentEffectiveSpec: currentEffectiveSpecRow
        ? toEffectiveSpecSummary(currentEffectiveSpecRow)
        : null,
      effectiveSpecs: effectiveSpecRows.map(toEffectiveSpecSummary),
    };
  }

  async isPrepCurrent(taskId: string): Promise<boolean> {
    return Boolean((await this.resolveCurrent(taskId))?.prep);
  }

  async isPreflightCurrent(taskId: string): Promise<boolean> {
    return Boolean((await this.resolveCurrent(taskId))?.preflight);
  }

  async isPrepCurrentForHash(
    taskId: string,
    specHash: string,
    taskFilePath?: string,
  ): Promise<boolean> {
    if (this.deps.prepCache) {
      const prep = await this.deps.prepCache.read(taskId, taskFilePath, specHash);
      if (prep && !prep.stale) return true;
    }

    return Boolean(
      snapshotToPrepResult(this.getDb().getReadinessSnapshot(taskId, specHash), specHash),
    );
  }

  async isPreflightCurrentForHash(taskId: string, specHash: string): Promise<boolean> {
    if (this.deps.prepCache) {
      const preflight = await this.deps.prepCache.readPreflight(taskId, specHash);
      if (preflight) return true;
    }

    return Boolean(snapshotToPreflightResult(this.getDb().getReadinessSnapshot(taskId, specHash)));
  }

  async getCurrentGateScore(taskId: string): Promise<number | null> {
    const readiness = await this.resolveCurrent(taskId);
    return readiness?.preflight?.gate.score ?? readiness?.prep?.depthScore ?? null;
  }

  persistPrepResult(
    taskId: string,
    taskContent: string,
    result: Omit<PrepResult, "stale">,
    source = "prep",
  ): string {
    const specHash = computeContentHash(taskContent);
    const db = this.getDb();
    const existing = db.getReadinessSnapshot(taskId, specHash);
    const effectiveSpec = this.findAcceptedEffectiveSpec(taskId, specHash, db);
    const timestamp = result.preparedAt;
    const normalized: PrepResult = {
      ...result,
      stale: false,
      contentHash: specHash,
    };

    const snapshot: ReadinessSnapshotRow = {
      task_id: taskId,
      spec_hash: specHash,
      base_spec_hash: effectiveSpec?.base_spec_hash ?? existing?.base_spec_hash ?? specHash,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      schema_valid: normalized.schemaValid ? 1 : 0,
      schema_errors: JSON.stringify(normalized.schemaErrors ?? []),
      depth_score: normalized.depthScore,
      depth_ready: normalized.depthReady ? 1 : 0,
      deficiencies: JSON.stringify(normalized.deficiencies ?? []),
      outcome: normalized.outcome,
      prep_data: JSON.stringify(normalized),
      preflight_data: existing?.preflight_data ?? null,
      effective_spec_data: effectiveSpec
        ? JSON.stringify(toEffectiveSpecPayload(effectiveSpec))
        : (existing?.effective_spec_data ?? null),
      stale_reason: null,
      source,
      generator_version: READINESS_GENERATOR_VERSION,
    };

    const mirror: PrepCacheRow = {
      task_id: taskId,
      prepared_at: timestamp,
      schema_valid: normalized.schemaValid ? 1 : 0,
      depth_score: normalized.depthScore,
      depth_ready: normalized.depthReady ? 1 : 0,
      deficiencies: JSON.stringify(normalized.deficiencies ?? []),
      outcome: normalized.outcome,
      content_hash: specHash,
      stale: 0,
      preflight_data: existing?.preflight_data ?? null,
    };

    db.transaction(() => {
      db.upsertReadinessSnapshot(snapshot);
      db.setPrep(mirror);
    });

    return specHash;
  }

  persistPreflightResult(
    taskId: string,
    taskContent: string,
    result: PreflightResult,
    source = "preflight",
  ): string {
    const specHash = result.contentHash || computeContentHash(taskContent);
    const db = this.getDb();
    const existing = db.getReadinessSnapshot(taskId, specHash);
    const effectiveSpec = this.findAcceptedEffectiveSpec(taskId, specHash, db);
    const normalized: PreflightResult = {
      ...result,
      contentHash: specHash,
    };

    const snapshot: ReadinessSnapshotRow = {
      task_id: taskId,
      spec_hash: specHash,
      base_spec_hash: effectiveSpec?.base_spec_hash ?? existing?.base_spec_hash ?? specHash,
      created_at: existing?.created_at ?? normalized.timestamp,
      updated_at: normalized.timestamp,
      schema_valid: existing?.schema_valid ?? 1,
      schema_errors: existing?.schema_errors ?? "[]",
      depth_score: normalized.gate.score,
      depth_ready: normalized.gate.ready ? 1 : 0,
      deficiencies: existing?.deficiencies ?? "[]",
      outcome: normalized.gate.ready && normalized.gate.score >= 4.7 ? "pass" : "rejected",
      prep_data: existing?.prep_data ?? null,
      preflight_data: JSON.stringify(normalized),
      effective_spec_data: effectiveSpec
        ? JSON.stringify(toEffectiveSpecPayload(effectiveSpec))
        : (existing?.effective_spec_data ?? null),
      stale_reason: null,
      source,
      generator_version: READINESS_GENERATOR_VERSION,
    };

    const mirror: PrepCacheRow = {
      task_id: taskId,
      prepared_at: normalized.timestamp,
      schema_valid: snapshot.schema_valid,
      depth_score: normalized.gate.score,
      depth_ready: normalized.gate.ready ? 1 : 0,
      deficiencies: snapshot.deficiencies,
      outcome: snapshot.outcome,
      content_hash: specHash,
      stale: 0,
      preflight_data: JSON.stringify(normalized),
    };

    db.transaction(() => {
      db.upsertReadinessSnapshot(snapshot);
      db.setPrep(mirror);
    });

    return specHash;
  }

  persistEffectiveSpec(input: PersistEffectiveSpecInput): {
    baseSpecHash: string;
    effectiveSpecHash: string;
  } {
    const db = this.getDb();
    const baseSpecHash = computeContentHash(input.baseSpecContent);
    const effectiveSpecHash = computeContentHash(input.effectiveContent);
    const existing = db.getEffectiveSpec(input.taskId, baseSpecHash, effectiveSpecHash);
    const now = new Date().toISOString();

    db.upsertEffectiveSpec({
      task_id: input.taskId,
      base_spec_hash: baseSpecHash,
      effective_spec_hash: effectiveSpecHash,
      status: input.status,
      content: input.effectiveContent,
      deficiencies: JSON.stringify(input.deficiencies ?? []),
      source: input.source,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      commit_sha: input.commitSha ?? null,
    });

    return { baseSpecHash, effectiveSpecHash };
  }

  /**
   * Return the most-recent "proposed" effective spec record for a task,
   * or null if none exists. Used by `/enrich/approve` to pull cached
   * enrichment content without round-tripping it through the caller.
   * The DB orders by updated_at DESC, so the first match is freshest.
   */
  getLatestProposedEffectiveSpec(taskId: string): {
    content: string;
    baseSpecHash: string;
    effectiveSpecHash: string;
    source: string;
    updatedAt: string;
  } | null {
    const db = this.getDb();
    const rows = db.listEffectiveSpecs(taskId);
    const proposed = rows.find((row) => row.status === "proposed");
    if (!proposed) return null;
    return {
      content: proposed.content,
      baseSpecHash: proposed.base_spec_hash,
      effectiveSpecHash: proposed.effective_spec_hash,
      source: proposed.source,
      updatedAt: proposed.updated_at,
    };
  }

  private computeDispatchBlockReason(
    prep: PrepResult | null,
    preflight: PreflightResult | null,
    hasStalePrep: boolean,
  ): string | null {
    if (preflight) {
      if (!preflight.gate.ready || preflight.gate.score < 4.7) {
        return "preflight_gate_failed";
      }
      return null;
    }

    if (hasStalePrep) return "preflight_gate_stale";
    if (!prep) return "preflight_gate_missing";
    if (!prep.depthReady || prep.depthScore < 4.7 || prep.outcome === "rejected") {
      return "preflight_gate_failed";
    }
    return null;
  }

  private getDb(): ReadinessDb {
    if (this.deps.db) return this.deps.db;
    if (!this.ownedDb) {
      this.ownedDb = openReadinessDb(this.deps.projectRoot);
    }
    return this.ownedDb;
  }

  private async readCurrentSpec(taskId: string): Promise<{
    filePath: string;
    specHash: string;
  } | null> {
    if (!this.deps.taskService) return null;

    const filePath =
      (await this.deps.taskService.getTaskFilePath(taskId)) ??
      (await this.deps.taskService.getRawTaskFilePath(taskId));
    if (!filePath) return null;

    const taskContent = await fs.readFile(filePath, "utf-8");
    return {
      filePath,
      specHash: computeContentHash(taskContent),
    };
  }

  private findAcceptedEffectiveSpec(
    taskId: string,
    specHash: string,
    db: ReadinessDb,
  ): EffectiveSpecRow | undefined {
    return db
      .listEffectiveSpecs(taskId)
      .find((row) => row.status === "accepted" && row.effective_spec_hash === specHash);
  }
}
