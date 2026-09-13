/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { DEFAULT_SCHEMA_POLICY_HASH, matchesSchemaPolicy } from "../gate/schema-policy.js";
import { NoopDB, QuackDB } from "../db/index.js";
import type { EffectiveSpecRow, PrepCacheRow, ReadinessSnapshotRow } from "../db/types.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import { PrepCache, computeContentHash, type PrepResult } from "./prep-cache.js";
import { parsePrepGateResult } from "./prep-job-result.js";
import type { TaskService } from "./task-service.js";

const READINESS_GENERATOR_VERSION = "task-887-g-v1";

type ReadinessDb = QuackDB | NoopDB;

function hasValidPrepContract(prep: PrepResult | null): prep is PrepResult {
  try {
    parsePrepGateResult(prep);
    return true;
  } catch {
    return false;
  }
}

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
  /** Display projection; may be derived from preflight-only snapshot columns. */
  prep: PrepResult | null;
  /** Independent prep data or a current prep file, never display columns. */
  admissionPrep: PrepResult | null;
  prepEvidenceSource: "prep_record" | "snapshot_projection" | null;
  admissionPreflight: PreflightResult | null;
  preflight: PreflightResult | null;
  hasStalePrep: boolean;
  hasStalePreflight: boolean;
  staleReasons: string[];
  preflightStaleReasons: string[];
  dispatchBlockReason: string | null;
  snapshot: ReadinessSnapshotRow | null;
  currentEffectiveSpec: EffectiveSpecSummary | null;
  effectiveSpecs: EffectiveSpecSummary[];
}

/** Diagnostic selection never makes an old or projected result admission evidence. */
export function selectReadinessDiagnosticPrep(
  state: Pick<
    CurrentReadinessState,
    "admissionPrep" | "prep" | "prepEvidenceSource" | "snapshot" | "staleReasons"
  > | null,
): PrepResult | null {
  const hasLegacyBlob =
    Boolean(state?.snapshot?.prep_data) && state?.staleReasons.includes("legacy_prep_provenance");
  return (
    state?.admissionPrep ??
    (state?.prepEvidenceSource === "prep_record" || hasLegacyBlob ? (state?.prep ?? null) : null)
  );
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

/** Operator metadata describes storage origin, not dispatch permission. */
export type OperatorPrepResult = PrepResult & {
  evidenceSource: "prep_record" | "snapshot_projection";
};

export function toOperatorPrepResult(
  state: CurrentReadinessState | null,
): OperatorPrepResult | null {
  if (!state?.prep) return null;
  return {
    ...state.prep,
    evidenceSource: state.prepEvidenceSource ?? "snapshot_projection",
    stale: state.hasStalePrep || state.prep.stale,
  };
}

/** Diagnostics remain readable even when their policy or mode is stale. */
export function toOperatorPreflightResult(
  state: CurrentReadinessState | null,
): (PreflightResult & { stale: boolean; staleReasons: string[] }) | null {
  return state?.preflight
    ? {
        ...state.preflight,
        stale: state.hasStalePreflight,
        staleReasons: state.preflightStaleReasons,
      }
    : null;
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

function snapshotToPrepDiagnostics(
  snapshot: ReadinessSnapshotRow | undefined,
  specHash: string,
): PrepResult | null {
  if (!snapshot) return null;

  const parsed = parseJsonBlob<PrepResult>(snapshot.prep_data);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return {
      ...parsed,
      stale: false,
      contentHash: parsed.contentHash ?? specHash,
    };
  }

  return null;
}

function snapshotToIndependentPrepResult(
  snapshot: ReadinessSnapshotRow | undefined,
  specHash: string,
): PrepResult | null {
  const prep = snapshotToPrepDiagnostics(snapshot, specHash);
  // Migration v3 manufactured prep-shaped blobs from mixed preflight columns.
  // Later preflight writes replace the row's source labels but keep that blob.
  // A policy stamp is therefore necessary to establish independent DB origin;
  // whether that policy is CURRENT remains a separate admission check below.
  // The label is a defensive veto; existing migration blobs already fail the
  // stamp check, and later writers overwrite the label, so it cannot prove origin.
  if (
    !prep ||
    typeof prep.schemaPolicyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(prep.schemaPolicyHash) ||
    snapshot?.generator_version === "migration-v3"
  )
    return null;
  return prep;
}

function snapshotToPrepResult(
  snapshot: ReadinessSnapshotRow | undefined,
  specHash: string,
): PrepResult | null {
  if (!snapshot) return null;
  const diagnostics = snapshotToPrepDiagnostics(snapshot, specHash);
  if (diagnostics) return diagnostics;
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
      schemaPolicyHash?: string;
      readinessJudgmentMode?: "off" | "shadow" | "enforce";
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

    const dbPrep = snapshotToIndependentPrepResult(snapshot, current.specHash);
    const hasUnprovenDbPrep =
      snapshotToPrepDiagnostics(snapshot, current.specHash) !== null && !dbPrep;
    const dbPreflight = snapshotToPreflightResult(snapshot);
    const filePrep =
      (await this.deps.prepCache?.read(taskId, current.filePath, current.specHash)) ?? null;
    const filePreflight = (await this.deps.prepCache?.readPreflight(taskId)) ?? null;
    const prepCandidates = [filePrep, dbPrep].filter(
      (value): value is PrepResult => value !== null,
    );
    const preflightCandidates = [filePreflight, dbPreflight].filter(
      (value): value is PreflightResult => value !== null,
    );
    const admissionPrep =
      prepCandidates.find(
        (value) =>
          !value.stale && value.contentHash === current.specHash && this.policyMatches(value),
      ) ?? null;
    const admissionPreflight =
      preflightCandidates.find(
        (value) => value.contentHash === current.specHash && this.preflightMatches(value),
      ) ?? null;
    // Keep diagnostic records separate from their eligibility as authority.
    // A stale file cannot hide a current DB result (or vice versa).
    const independentPrep =
      admissionPrep ??
      prepCandidates.find(
        (value) => !value.stale && (!value.contentHash || value.contentHash === current.specHash),
      ) ??
      null;
    const prep = independentPrep ?? snapshotToPrepResult(snapshot, current.specHash);
    const prepEvidenceSource = independentPrep
      ? "prep_record"
      : prep
        ? "snapshot_projection"
        : null;
    const preflight =
      admissionPreflight ??
      preflightCandidates.find((value) => value.contentHash === current.specHash) ??
      null;
    const hasStalePrep =
      !admissionPrep &&
      (hasUnprovenDbPrep ||
        prepCandidates.length > 0 ||
        snapshots.some((row) => row.spec_hash !== current.specHash && Boolean(row.prep_data)));
    const hasStalePreflight =
      !admissionPreflight &&
      (preflightCandidates.length > 0 ||
        snapshots.some((row) => row.spec_hash !== current.specHash && Boolean(row.preflight_data)));
    const prepStaleReasons: string[] = hasStalePrep ? ["prep_stale"] : [];
    const preflightStaleReasons: string[] = hasStalePreflight ? ["preflight_stale"] : [];
    const hasUnprovenPrepDiagnostics = hasUnprovenDbPrep && !independentPrep;
    if (
      !admissionPrep &&
      (hasUnprovenPrepDiagnostics || prepCandidates.some((value) => !this.policyMatches(value)))
    ) {
      prepStaleReasons.push("schema_policy_stale");
    }
    if (!admissionPrep && hasUnprovenPrepDiagnostics)
      prepStaleReasons.push("legacy_prep_provenance");
    if (!admissionPreflight && preflightCandidates.some((value) => !this.policyMatches(value))) {
      preflightStaleReasons.push("schema_policy_stale");
    }
    if (!admissionPreflight && preflightCandidates.some((value) => !this.modeMatches(value))) {
      preflightStaleReasons.push("readiness_mode_stale");
    }
    const staleReasons = [...new Set([...prepStaleReasons, ...preflightStaleReasons])];
    const hasStaleAdmissionEvidence =
      hasStalePrep ||
      staleReasons.some(
        (reason) => reason === "schema_policy_stale" || reason === "readiness_mode_stale",
      );
    const diagnosticPrep = selectReadinessDiagnosticPrep({
      admissionPrep,
      prep,
      prepEvidenceSource,
      snapshot: snapshot ?? null,
      staleReasons,
    });

    return {
      taskId,
      currentSpecHash: current.specHash,
      taskFilePath: current.filePath,
      prep,
      admissionPrep,
      prepEvidenceSource,
      admissionPreflight,
      preflight,
      hasStalePrep,
      hasStalePreflight,
      staleReasons,
      preflightStaleReasons,
      dispatchBlockReason: this.computeDispatchBlockReason(
        admissionPrep,
        admissionPreflight,
        hasStaleAdmissionEvidence,
        diagnosticPrep,
      ),
      snapshot: snapshot ?? null,
      currentEffectiveSpec: currentEffectiveSpecRow
        ? toEffectiveSpecSummary(currentEffectiveSpecRow)
        : null,
      effectiveSpecs: effectiveSpecRows.map(toEffectiveSpecSummary),
    };
  }

  async isPrepCurrent(taskId: string): Promise<boolean> {
    return Boolean((await this.resolveCurrent(taskId))?.admissionPrep);
  }

  async isPreflightCurrent(taskId: string): Promise<boolean> {
    return Boolean((await this.resolveCurrent(taskId))?.admissionPreflight);
  }

  async isPrepCurrentForHash(
    taskId: string,
    specHash: string,
    taskFilePath?: string,
  ): Promise<boolean> {
    if (this.deps.prepCache) {
      const prep = await this.deps.prepCache.read(
        taskId,
        taskFilePath,
        specHash,
        this.expectedPolicyHash,
      );
      if (prep && !prep.stale && prep.contentHash === specHash) return true;
    }

    const prep = snapshotToIndependentPrepResult(
      this.getDb().getReadinessSnapshot(taskId, specHash),
      specHash,
    );
    return Boolean(prep && prep.contentHash === specHash && this.policyMatches(prep));
  }

  async isPreflightCurrentForHash(taskId: string, specHash: string): Promise<boolean> {
    if (this.deps.prepCache) {
      const preflight = await this.deps.prepCache.readPreflight(
        taskId,
        specHash,
        this.expectedReadinessMode,
        this.expectedPolicyHash,
      );
      if (preflight) return true;
    }

    const preflight = snapshotToPreflightResult(
      this.getDb().getReadinessSnapshot(taskId, specHash),
    );
    return Boolean(
      preflight && preflight.contentHash === specHash && this.preflightMatches(preflight),
    );
  }

  async getCurrentGateScore(taskId: string): Promise<number | null> {
    const readiness = await this.resolveCurrent(taskId);
    const gate = readiness?.admissionPreflight?.gate;
    const preflightScore = gate?.gateSkipped === true ? null : gate?.score;
    if (preflightScore != null) return preflightScore;
    const prep = readiness?.admissionPrep ?? null;
    return hasValidPrepContract(prep) ? prep.depthScore : null;
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

    // Qualify the raw identity before display helpers can fill a missing hash.
    // A policy-old but genuine prep still owns its independent schema observation;
    // current-policy admission remains a separate read-side decision.
    const rawPrep = parseJsonBlob<PrepResult>(existing?.prep_data);
    const independentPrep = snapshotToIndependentPrepResult(existing, specHash);
    const schemaPrep =
      rawPrep?.taskId === taskId &&
      rawPrep.contentHash === specHash &&
      hasValidPrepContract(independentPrep)
        ? independentPrep
        : null;
    const schemaErrors = normalized.gate.schemaErrors ?? [];
    const schemaProjection = schemaPrep
      ? {
          schema_valid: schemaPrep.schemaValid ? 1 : 0,
          schema_errors: JSON.stringify(schemaPrep.schemaErrors),
        }
      : normalized.gate.gateSkipped === true
        ? // Skipped checks contribute no new schema observation.
          {
            schema_valid: existing?.schema_valid ?? 1,
            schema_errors: existing?.schema_errors ?? "[]",
          }
        : {
            schema_valid: schemaErrors.length > 0 ? 0 : 1,
            schema_errors: JSON.stringify(schemaErrors),
          };

    const snapshot: ReadinessSnapshotRow = {
      task_id: taskId,
      spec_hash: specHash,
      base_spec_hash: effectiveSpec?.base_spec_hash ?? existing?.base_spec_hash ?? specHash,
      created_at: existing?.created_at ?? normalized.timestamp,
      updated_at: normalized.timestamp,
      ...schemaProjection,
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

  private get expectedPolicyHash(): string {
    return this.deps.schemaPolicyHash === undefined
      ? DEFAULT_SCHEMA_POLICY_HASH
      : this.deps.schemaPolicyHash;
  }

  private get expectedReadinessMode(): "off" | "shadow" | "enforce" {
    return this.deps.readinessJudgmentMode ?? "off";
  }

  private policyMatches(result: { schemaPolicyHash?: string }): boolean {
    return matchesSchemaPolicy(result.schemaPolicyHash, this.expectedPolicyHash);
  }

  private modeMatches(result: PreflightResult): boolean {
    return (result.gate?.readinessJudgmentMode ?? "off") === this.expectedReadinessMode;
  }

  private preflightMatches(result: PreflightResult): boolean {
    return this.policyMatches(result) && this.modeMatches(result);
  }

  private computeDispatchBlockReason(
    prep: PrepResult | null,
    preflight: PreflightResult | null,
    hasStaleEvidence: boolean,
    diagnosticPrep: PrepResult | null,
  ): string | null {
    const prepContractValid = hasValidPrepContract(prep);
    if (
      prepContractValid &&
      prep.schemaValid &&
      prep.depthReady &&
      prep.depthScore >= 4.7 &&
      prep.outcome !== "rejected"
    )
      return null;
    if (preflight && preflight.gate.gateSkipped !== true) {
      if (!preflight.gate.ready || preflight.gate.score < 4.7) {
        return "preflight_gate_failed";
      }
      return null;
    }

    if (diagnosticPrep && !hasValidPrepContract(diagnosticPrep)) return "preflight_gate_invalid";
    if (
      prep &&
      (!prep.schemaValid ||
        !prep.depthReady ||
        prep.depthScore < 4.7 ||
        prep.outcome === "rejected")
    ) {
      return "preflight_gate_failed";
    }
    if (hasStaleEvidence) return "preflight_gate_stale";
    if (!prep) return "preflight_gate_missing";
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
