// ─── Residual ledger reconcile (TASK-1303) ──────────────────────────
// List-based closure of the recall gap the commit-shape backfill
// (TASK-1204) cannot see. Evidence-proportional by contract:
//  - Class A: a persisted gate-passing VERIFIED review bundle (pre-1203
//    reviews) is first-class verification evidence → VERIFIED write.
//  - Class B: task_status says done with no verification artifact →
//    report-only (dependents already unblock via effective status).
//  - Class C: spec-file Status says done, nothing else → report-only.
// Spec-less class-A ids (the closure-store-registered Saurus series)
// write only under an exact-id operator allowlist.

export interface ResidualBundleEvidence {
  taskId: string;
  verdict: string;
  mergeReady: boolean | null;
  reviewId: string;
  createdAt?: string;
  updatedAt?: string;
  commitSha?: string;
}

export interface ResidualCandidate {
  taskId: string;
  class: "A" | "B" | "C";
  disposition:
    | "would-record"
    | "recorded"
    | "skipped-existing"
    | "unregistered-advisory"
    | "report-only";
  reviewId?: string;
  commitSha?: string;
  evidence: string;
}

export interface ResidualRecordRequest {
  taskId: string;
  verdict: "VERIFIED";
  commitSha: string;
  method: "v1-review";
  reviewId: string;
  notes: string;
  /** NOT NULL ledger columns; 0/0 mirrors the 1203 bridge's own writes
   *  (review bundles carry findings, not criteria counts). */
  criteriaChecked: number;
  criteriaPassed: number;
}

export interface ResidualRecordOptions {
  skipIfExistingVerdict: string[];
}

export interface ResidualReconcileDeps {
  /** Task ids that already have a verified-ledger row (any verdict). */
  ledgerIds: () => Set<string>;
  /** All persisted review bundles (every file, not latest-per-task). */
  readBundles: () => ResidualBundleEvidence[];
  /** task_status rows as [taskId, status]. */
  statuses: () => Array<[string, string]>;
  /** Task ids whose spec-file Status reads COMPLETE/VERIFIED (class C source). */
  specDoneIds: () => string[];
  /** True when the task has a spec file in the canonical task dir. */
  taskExists: (taskId: string) => boolean;
  /** Ledger writer; the module always passes the trust-REJECTED guard. */
  record: (
    request: ResidualRecordRequest,
    options: ResidualRecordOptions,
  ) => Promise<{ applied: boolean; skippedReason?: string }>;
  log: (message: string) => void;
}

export interface ResidualReconcileOptions {
  apply?: boolean;
  /** Exact task ids allowed to write without a spec file (no patterns). */
  allowUnregisteredIds?: Set<string>;
}

export interface ResidualReconcileResult {
  dryRun: boolean;
  candidates: ResidualCandidate[];
  recorded: number;
  skippedExisting: number;
  unregisteredAdvisories: number;
  reportOnly: number;
}

// The trust-REJECTED rule made mechanical: class A's not-in-ledger
// definition already excludes rowed tasks, but the explicit guard
// protects against classification drift (round-1 HIGH).
export const RESIDUAL_WRITE_GUARD: ResidualRecordOptions = {
  skipIfExistingVerdict: ["VERIFIED", "REJECTED"],
};

// Canonical task id from a spec filename: TASK- plus segments that are
// all caps/digits (949, 949-C, BS-01, SAURUS-REM-001); the slug starts
// at the first segment containing lowercase. Round-2 fix: a lazy-regex
// version truncated multi-segment ids (TASK-SAURUS-REM-001 → TASK-SAURUS).
export function canonicalIdFromSpecFilename(name: string): string | undefined {
  if (!name.toLowerCase().endsWith(".md")) return undefined;
  const base = name.slice(0, -3);
  const segments = base.split("-");
  if (segments[0] !== "TASK" || segments.length < 2) return undefined;
  const idSegments = ["TASK"];
  for (const segment of segments.slice(1)) {
    if (/^[A-Z0-9]+$/.test(segment)) {
      idSegments.push(segment);
    } else {
      break;
    }
  }
  return idSegments.length >= 2 ? idSegments.join("-") : undefined;
}

// Deterministic recency: updatedAt over createdAt, UTC-ISO string order;
// malformed/missing timestamps rank OLDEST so a broken bundle can never
// win; reviewId breaks exact ties (round-1 comparator finding).
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function bundleRecencyKey(bundle: ResidualBundleEvidence): string {
  const stamp = bundle.updatedAt ?? bundle.createdAt ?? "";
  return UTC_ISO_RE.test(stamp) ? stamp : "";
}

export function selectLatestBundle(
  bundles: ResidualBundleEvidence[],
): ResidualBundleEvidence | undefined {
  let latest: ResidualBundleEvidence | undefined;
  for (const bundle of bundles) {
    if (!latest) {
      latest = bundle;
      continue;
    }
    const byStamp = bundleRecencyKey(bundle).localeCompare(bundleRecencyKey(latest));
    if (byStamp > 0 || (byStamp === 0 && bundle.reviewId.localeCompare(latest.reviewId) > 0)) {
      latest = bundle;
    }
  }
  return latest;
}

export async function runResidualReconcile(
  deps: ResidualReconcileDeps,
  options: ResidualReconcileOptions = {},
): Promise<ResidualReconcileResult> {
  const apply = options.apply === true;
  const allowIds = options.allowUnregisteredIds ?? new Set<string>();
  const ledger = deps.ledgerIds();
  const candidates: ResidualCandidate[] = [];
  let recorded = 0;
  let skippedExisting = 0;
  let unregisteredAdvisories = 0;
  let reportOnly = 0;

  // ── Class A: latest bundle per task, VERIFIED + mergeReady, no row ──
  const byTask = new Map<string, ResidualBundleEvidence[]>();
  for (const bundle of deps.readBundles()) {
    if (!bundle.taskId || ledger.has(bundle.taskId)) continue;
    const list = byTask.get(bundle.taskId) ?? [];
    list.push(bundle);
    byTask.set(bundle.taskId, list);
  }

  const classATaskIds = new Set<string>();
  for (const [taskId, bundles] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const latest = selectLatestBundle(bundles);
    if (!latest || latest.verdict !== "VERIFIED" || latest.mergeReady !== true) continue;
    classATaskIds.add(taskId);

    const registered = deps.taskExists(taskId);
    if (!registered && !allowIds.has(taskId)) {
      unregisteredAdvisories++;
      candidates.push({
        taskId,
        class: "A",
        disposition: "unregistered-advisory",
        reviewId: latest.reviewId,
        evidence: `closure-store bundle ${latest.reviewId} (VERIFIED, mergeReady); no spec file; not in the operator allowlist`,
      });
      continue;
    }

    const commitSha = latest.commitSha?.trim() || "unknown";
    const allowlisted = !registered;
    if (!apply) {
      candidates.push({
        taskId,
        class: "A",
        disposition: "would-record",
        reviewId: latest.reviewId,
        commitSha,
        evidence: `closure-store bundle ${latest.reviewId} (VERIFIED, mergeReady)${allowlisted ? "; operator allowlist" : ""}`,
      });
      continue;
    }

    const result = await deps.record(
      {
        taskId,
        verdict: "VERIFIED",
        commitSha,
        method: "v1-review",
        reviewId: latest.reviewId,
        notes:
          `residual-reconcile: closure-store bundle ${latest.reviewId}` +
          (allowlisted ? "; registry: closure-store (operator allowlist)" : ""),
        criteriaChecked: 0,
        criteriaPassed: 0,
      },
      RESIDUAL_WRITE_GUARD,
    );
    if (result.applied) {
      recorded++;
      candidates.push({
        taskId,
        class: "A",
        disposition: "recorded",
        reviewId: latest.reviewId,
        commitSha,
        evidence: `closure-store bundle ${latest.reviewId}${allowlisted ? "; operator allowlist" : ""}`,
      });
    } else {
      skippedExisting++;
      candidates.push({
        taskId,
        class: "A",
        disposition: "skipped-existing",
        reviewId: latest.reviewId,
        commitSha,
        evidence: `writer guard: ${result.skippedReason ?? "skipped"}`,
      });
    }
  }

  // ── Class B: status-done, no row, no qualifying bundle — report only ──
  const classBTaskIds = new Set<string>();
  for (const [taskId, status] of deps.statuses()) {
    if (status !== "COMPLETE" && status !== "VERIFIED") continue;
    if (ledger.has(taskId) || classATaskIds.has(taskId)) continue;
    classBTaskIds.add(taskId);
    reportOnly++;
    candidates.push({
      taskId,
      class: "B",
      disposition: "report-only",
      evidence: `task_status=${status}; no verification artifact — example-lane triage (verify or demote)`,
    });
  }

  // ── Class C: spec-file-only done claims — report only ──
  for (const taskId of deps.specDoneIds()) {
    if (ledger.has(taskId) || classATaskIds.has(taskId) || classBTaskIds.has(taskId)) continue;
    reportOnly++;
    candidates.push({
      taskId,
      class: "C",
      disposition: "report-only",
      evidence:
        "spec-file Status claims done; no runtime or verification evidence — example-lane triage",
    });
  }

  deps.log(
    `residual-reconcile ${apply ? "APPLY" : "dry-run"}: A=${classATaskIds.size} recorded=${recorded} skipped=${skippedExisting} advisories=${unregisteredAdvisories} reportOnly=${reportOnly}`,
  );

  return {
    dryRun: !apply,
    candidates,
    recorded,
    skippedExisting,
    unregisteredAdvisories,
    reportOnly,
  };
}
