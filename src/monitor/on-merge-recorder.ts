// ─── Record-on-merge Scanner (TASK-1201) ───────────────────────────
// Detects completion-shaped task references merged to the adapter's
// base branch and records them as SOFT-VERIFIED through the canonical
// verification store, so work built outside the dispatch pipeline stops
// being invisible to the ledger the moment it lands.
//
// Sharp edges, deliberately encoded (see the TASK-1201 spec):
//   - No-downgrade guard lives INSIDE the writer (RecordOptions.
//     skipIfExistingVerdict) — a scanner-side check-then-write would race
//     concurrent VERIFIED writes under write-recency precedence.
//   - First run records NOTHING: the cursor initializes at the branch tip.
//     Retroactive recording is the P0-2 backfill's controlled, sampled job.
//   - Cursor persists via temp-write + rename, only AFTER the tick's
//     ledger writes complete. Crash mid-tick re-scans the same range next
//     tick; re-records are no-ops thanks to the writer guard.
//   - Ticks are serialized: interval and scan-now never overlap.
//   - Unknown task ids emit an advisory event, never a ledger row.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DuplicateClaimantIndex } from "../core/duplicate-claimants.js";
import type { ClaimantDiagnostic } from "./claimant-diagnostic.js";

const execFileAsync = promisify(execFile);

// ─── Extraction ─────────────────────────────────────────────────────

const TASK_ID_PATTERN = "(?:TASK-\\d+(?:-[A-Z]+)?|SAURUS-REM-\\d{3})";

/** Merge-commit subjects referencing a quack task branch. */
const BRANCH_MERGE_RE = new RegExp(`quack/(${TASK_ID_PATTERN})`);

/** `[TASK-123] message` */
const BRACKET_LEAD_RE = new RegExp(`^\\[(${TASK_ID_PATTERN})\\]`);

/** `TASK-123: message` / `TASK-123 message` */
const ID_LEAD_RE = new RegExp(`^(${TASK_ID_PATTERN})(?::|\\s)`);

/** `type(scope): TASK-123 message` / `type: TASK-123 message` */
const CONVENTIONAL_LEAD_RE = new RegExp(
  `^([A-Za-z][A-Za-z0-9+_-]*)(?:\\(([^)]*)\\))?!?:\\s*(${TASK_ID_PATTERN})(?:\\b|:)`,
);

/**
 * Conventional types/scopes that are spec authoring or hygiene, not
 * completion evidence. Calibrated against a 500-commit empirical sample
 * of this repo's main (Codex review round 1): `spec: TASK-104/105/106 …`
 * and `fix(specs): TASK-899 …` would otherwise false-record.
 */
const EXCLUDED_TYPES = new Set(["docs", "chore", "spec"]);
const EXCLUDED_SCOPES = new Set(["specs", "tasks", "docs"]);

export interface MergeScanCandidate {
  taskId: string;
  commitSha: string;
  subject: string;
}

/** The two SSE stages the recorder emits (members of EventStage). */
export type OnMergeEventStage = "recording_on_merge" | "recording_unregistered_merge";

interface ParsedLogLine {
  sha: string;
  parents: string[];
  subject: string;
}

function parseLogLine(line: string): ParsedLogLine | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const sha = parts[0]?.trim();
  const parents = (parts[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const subject = parts.slice(2).join("\t").trim();
  if (!sha || subject.length === 0) return null;
  return { sha, parents, subject };
}

/**
 * Extract completion-shaped task references from `git log
 * --format=%H%x09%P%x09%s` lines. Newest-first input order is preserved;
 * the first (newest) occurrence of an id wins as evidence.
 */
export function extractMergeCandidates(logLines: string[]): MergeScanCandidate[] {
  const seen = new Set<string>();
  const candidates: MergeScanCandidate[] = [];

  for (const line of logLines) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    const { sha, parents, subject } = parsed;

    let taskId: string | undefined;

    // Rule 1: merge commits referencing a quack task branch.
    if (parents.length > 1) {
      taskId = BRANCH_MERGE_RE.exec(subject)?.[1];
    }

    // Rule 2: leading-position ids on any commit.
    if (!taskId) {
      taskId = BRACKET_LEAD_RE.exec(subject)?.[1] ?? ID_LEAD_RE.exec(subject)?.[1];
    }
    if (!taskId) {
      const conventional = CONVENTIONAL_LEAD_RE.exec(subject);
      if (conventional) {
        const type = (conventional[1] ?? "").toLowerCase();
        const scope = (conventional[2] ?? "").toLowerCase();
        if (!EXCLUDED_TYPES.has(type) && !EXCLUDED_SCOPES.has(scope)) {
          taskId = conventional[3];
        }
      }
    }

    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    candidates.push({ taskId, commitSha: sha, subject });
  }

  return candidates;
}

// ─── Cursor ─────────────────────────────────────────────────────────

export interface OnMergeCursor {
  lastScannedSha: string;
  baseBranch: string;
  projectRoot: string;
  updatedAt: string;
}

function cursorPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "on-merge-cursor.json");
}

export async function readCursor(projectRoot: string): Promise<OnMergeCursor | null> {
  try {
    const raw = await fs.readFile(cursorPath(projectRoot), "utf-8");
    const parsed = JSON.parse(raw) as OnMergeCursor;
    if (typeof parsed.lastScannedSha !== "string" || typeof parsed.baseBranch !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Temp-write + rename so a crash never leaves a torn cursor file. */
export async function writeCursor(projectRoot: string, cursor: OnMergeCursor): Promise<void> {
  const target = cursorPath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(cursor, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, target);
}

// ─── Scan ───────────────────────────────────────────────────────────

/** Minimal slice of RecordVerificationResult the scanner consumes. */
export interface OnMergeRecordResult {
  applied: boolean;
  skippedReason?: string;
}

export interface OnMergeScanDeps {
  projectRoot: string;
  baseBranch: string;
  /** Injected for tests; defaults to execFile("git", args, { cwd: projectRoot }). */
  runGit?: (args: string[]) => Promise<string>;
  /** True when the task id is known to the task service / backlog. */
  taskExists: (taskId: string) => Promise<boolean> | boolean;
  /** The canonical writer, pre-bound to the project. The scanner always
   *  passes the SOFT-VERIFIED entry; the callee must forward
   *  skipIfExistingVerdict to recordVerification (see server wiring). */
  record: (
    candidate: MergeScanCandidate,
    claimantIndex: DuplicateClaimantIndex,
  ) => Promise<OnMergeRecordResult>;
  /** One fresh full-directory snapshot per scan invocation. */
  claimantIndexProvider: () => Promise<DuplicateClaimantIndex>;
  /** Durable diagnostic writer. Resolves only after both event files verify. */
  persistClaimantDiagnostic: (diagnostic: ClaimantDiagnostic) => Promise<void>;
  scannerMethod: "on-merge" | "migration-scan";
  /** Fired once per APPLIED record (queue refresh hook). */
  onTaskRecorded?: (taskId: string) => void;
  /** SSE/event emitter, narrowed to the two recorder stages. */
  emit?: (stage: OnMergeEventStage, payload: Record<string, unknown>) => void;
  log?: (message: string) => void;
}

export interface OnMergeScanResult {
  recorded: string[];
  skippedExisting: string[];
  unregistered: string[];
  contested: string[];
  claimantIndexUnavailable: string[];
  cursorMovedTo: string | null;
  /** True when another tick was already in flight and this call did nothing. */
  busy?: boolean;
}

function defaultRunGit(projectRoot: string): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  };
}

/** Per-projectRoot in-flight flags so interval and scan-now never overlap. */
const inFlight = new Set<string>();

export async function runOnMergeScan(deps: OnMergeScanDeps): Promise<OnMergeScanResult> {
  const empty: OnMergeScanResult = {
    recorded: [],
    skippedExisting: [],
    unregistered: [],
    contested: [],
    claimantIndexUnavailable: [],
    cursorMovedTo: null,
  };

  if (inFlight.has(deps.projectRoot)) {
    return { ...empty, busy: true };
  }
  inFlight.add(deps.projectRoot);
  try {
    const claimantIndex = await deps.claimantIndexProvider();
    return await runOnMergeScanInner(deps, claimantIndex, empty);
  } finally {
    inFlight.delete(deps.projectRoot);
  }
}

async function runOnMergeScanInner(
  deps: OnMergeScanDeps,
  claimantIndex: DuplicateClaimantIndex,
  empty: OnMergeScanResult,
): Promise<OnMergeScanResult> {
  const log = deps.log ?? ((m: string) => console.log(`[on-merge] ${m}`));
  const runGit = deps.runGit ?? defaultRunGit(deps.projectRoot);

  const tip = (await runGit(["rev-parse", deps.baseBranch])).trim();
  if (!tip) return empty;

  const cursor = await readCursor(deps.projectRoot);
  const cursorValid =
    cursor !== null &&
    cursor.baseBranch === deps.baseBranch &&
    cursor.projectRoot === deps.projectRoot;

  const persistCursorAt = async (sha: string): Promise<void> => {
    await writeCursor(deps.projectRoot, {
      lastScannedSha: sha,
      baseBranch: deps.baseBranch,
      projectRoot: deps.projectRoot,
      updatedAt: new Date().toISOString(),
    });
  };

  if (!cursorValid) {
    // First run (or branch/root identity changed): initialize forward-only.
    // Recording history is the P0-2 backfill's job, never the scanner's.
    await persistCursorAt(tip);
    log(
      `cursor initialized at ${tip.slice(0, 9)} (${deps.baseBranch}); recorded nothing by design`,
    );
    return { ...empty, cursorMovedTo: tip };
  }

  if (cursor.lastScannedSha === tip) {
    return { ...empty, cursorMovedTo: tip };
  }

  let logOutput: string;
  try {
    logOutput = await runGit([
      "log",
      `${cursor.lastScannedSha}..${deps.baseBranch}`,
      "--format=%H%x09%P%x09%s",
    ]);
  } catch (err) {
    // Cursor SHA unreachable (rewritten history). Re-init at tip, record nothing.
    const msg = err instanceof Error ? err.message : String(err);
    log(
      `cursor ${cursor.lastScannedSha.slice(0, 9)} unreachable (${msg.split("\n")[0]}); re-initialized at tip, recorded nothing`,
    );
    await persistCursorAt(tip);
    return { ...empty, cursorMovedTo: tip };
  }

  const lines = logOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const candidates = extractMergeCandidates(lines);

  const result: OnMergeScanResult = {
    recorded: [],
    skippedExisting: [],
    unregistered: [],
    contested: [],
    claimantIndexUnavailable: [],
    cursorMovedTo: null,
  };

  for (const candidate of candidates) {
    const exists = await deps.taskExists(candidate.taskId);
    if (!exists) {
      result.unregistered.push(candidate.taskId);
      deps.emit?.("recording_unregistered_merge", {
        taskId: candidate.taskId,
        commitSha: candidate.commitSha,
        subject: candidate.subject,
      });
      continue;
    }

    if (claimantIndex.status === "unavailable") {
      const recordResult = await deps.record(candidate, claimantIndex);
      if (recordResult.applied) {
        throw new Error(
          `Claimant index unavailable for ${candidate.taskId}, but the writer applied it.`,
        );
      }
      await deps.persistClaimantDiagnostic({
        kind: "claimant-index-unavailable",
        taskId: candidate.taskId,
        commitSha: candidate.commitSha,
        claimants: [],
        scannerMethod: deps.scannerMethod,
        reason: claimantIndex.reason,
      });
      result.claimantIndexUnavailable.push(candidate.taskId);
      continue;
    }

    const claimants = claimantIndex.contested.get(candidate.taskId);
    if (claimants) {
      await deps.persistClaimantDiagnostic({
        kind: "duplicate-claimants",
        taskId: candidate.taskId,
        commitSha: candidate.commitSha,
        claimants,
        scannerMethod: deps.scannerMethod,
        reason: `Task ${candidate.taskId} has a contested id claimed by: ${claimants.join(", ")}.`,
      });
      result.contested.push(candidate.taskId);
      return result;
    }

    const recordResult = await deps.record(candidate, claimantIndex);
    if (recordResult.applied) {
      result.recorded.push(candidate.taskId);
      deps.emit?.("recording_on_merge", {
        taskId: candidate.taskId,
        commitSha: candidate.commitSha,
        subject: candidate.subject,
        verdict: "SOFT-VERIFIED",
        method: "on-merge",
      });
      deps.onTaskRecorded?.(candidate.taskId);
    } else if (recordResult.skippedReason === "existing-verdict") {
      result.skippedExisting.push(candidate.taskId);
    }
  }

  if (result.claimantIndexUnavailable.length > 0 || result.contested.length > 0) {
    return result;
  }

  // Cursor moves only after every write above has completed. A crash before
  // this line re-scans the same range next tick; the writer guard makes the
  // re-records no-ops.
  await persistCursorAt(tip);
  result.cursorMovedTo = tip;

  if (result.recorded.length > 0 || result.unregistered.length > 0) {
    log(
      `scan ${cursor.lastScannedSha.slice(0, 9)}..${tip.slice(0, 9)}: ` +
        `${result.recorded.length} recorded, ${result.skippedExisting.length} already-verified, ` +
        `${result.unregistered.length} unregistered`,
    );
  }

  return result;
}

// ─── Backfill (TASK-1204) ───────────────────────────────────────────
// Report-first, operator-gated historical scan. Never touches the live
// scanner's cursor; shares its extraction rules, deps, and per-project
// mutex. Dry-run by default; writes only on explicit apply, capped per
// invocation, idempotent via the writer guard.

export interface BackfillOptions {
  /** git --since bound (YYYY-MM-DD). Required: no unbounded scans. */
  since: string;
  /** Default false = dry-run. */
  apply?: boolean;
  /** Hard cap of ledger writes per invocation. Default 400. */
  maxWrites?: number;
  /** Stratified sample size per merge-month. Default 20. */
  samplePercent?: number;
}

export type BackfillDisposition =
  | "would-record"
  | "recorded"
  | "skipped-existing"
  | "unregistered"
  | "contested"
  | "claimant-index-unavailable"
  | "over-cap";

export interface BackfillCandidateReport {
  taskId: string;
  commitSha: string;
  subject: string;
  mergedAt: string;
  disposition: BackfillDisposition;
  sampleForUpgrade: boolean;
}

export interface BackfillResult {
  dryRun: boolean;
  commitsScanned: number;
  candidates: BackfillCandidateReport[];
  recorded: number;
  skippedExisting: number;
  unregistered: number;
  contested: number;
  claimantIndexUnavailable: number;
  overCap: number;
  /** Task ids flagged for the adversarial upgrade pass (stable across runs). */
  sample: string[];
  /** True when another scan (tick or backfill) held the project mutex. */
  busy?: boolean;
}

export interface BackfillDeps extends OnMergeScanDeps {
  /** True when the task already has a VERIFIED/SOFT-VERIFIED row — lets the
   *  dry-run report classify skipped-existing accurately without writing. */
  hasProtectedRow?: (taskId: string) => Promise<boolean> | boolean;
}

/** djb2 over the task id: a stable, dependency-free sampling order. */
function stableHash(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministic stratified sample: group by merge month, order each stratum
 * by stableHash(taskId) then id, take ceil(percent%) per stratum. Same
 * inputs always produce the same sample, independent of cap state.
 */
export function selectUpgradeSample(
  candidates: Array<{ taskId: string; mergedAt: string }>,
  samplePercent: number,
): Set<string> {
  const byMonth = new Map<string, Array<{ taskId: string; mergedAt: string }>>();
  for (const candidate of candidates) {
    const month = candidate.mergedAt.slice(0, 7) || "unknown";
    const bucket = byMonth.get(month) ?? [];
    bucket.push(candidate);
    byMonth.set(month, bucket);
  }

  const sample = new Set<string>();
  for (const bucket of byMonth.values()) {
    const ordered = [...bucket].sort((a, b) => {
      const ha = stableHash(a.taskId);
      const hb = stableHash(b.taskId);
      return ha - hb || a.taskId.localeCompare(b.taskId);
    });
    const take = Math.ceil((ordered.length * samplePercent) / 100);
    for (const candidate of ordered.slice(0, take)) {
      sample.add(candidate.taskId);
    }
  }
  return sample;
}

export async function runBackfillScan(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const empty: BackfillResult = {
    dryRun: options.apply !== true,
    commitsScanned: 0,
    candidates: [],
    recorded: 0,
    skippedExisting: 0,
    unregistered: 0,
    contested: 0,
    claimantIndexUnavailable: 0,
    overCap: 0,
    sample: [],
  };

  if (inFlight.has(deps.projectRoot)) {
    return { ...empty, busy: true };
  }
  inFlight.add(deps.projectRoot);
  try {
    const claimantIndex = await deps.claimantIndexProvider();
    return await runBackfillScanInner(deps, claimantIndex, options, empty);
  } finally {
    inFlight.delete(deps.projectRoot);
  }
}

async function runBackfillScanInner(
  deps: BackfillDeps,
  claimantIndex: DuplicateClaimantIndex,
  options: BackfillOptions,
  base: BackfillResult,
): Promise<BackfillResult> {
  const runGit = deps.runGit ?? defaultRunGit(deps.projectRoot);
  const apply = options.apply === true;
  const maxWrites = options.maxWrites ?? 400;
  const samplePercent = options.samplePercent ?? 20;

  const logOutput = await runGit([
    "log",
    deps.baseBranch,
    `--since=${options.since}`,
    "--format=%H%x09%P%x09%s%x09%cI",
  ]);
  const rawLines = logOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Pre-split %cI so the 3-field extraction contract stays untouched.
  // The subject may itself contain tabs: sha, parents, [subject...], cI.
  const mergedAtBySha = new Map<string, string>();
  const threeFieldLines: string[] = [];
  for (const line of rawLines) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const sha = parts[0] ?? "";
    const parents = parts[1] ?? "";
    const mergedAt = parts[parts.length - 1] ?? "";
    const subject = parts.slice(2, -1).join("\t");
    mergedAtBySha.set(sha, mergedAt);
    threeFieldLines.push(`${sha}\t${parents}\t${subject}`);
  }

  // Extraction dedupes per id keeping the NEWEST occurrence as evidence;
  // processing below is oldest-first so a capped apply leaves a
  // chronologically contiguous recorded prefix.
  const extracted = extractMergeCandidates(threeFieldLines)
    .map((candidate) => ({
      ...candidate,
      mergedAt: mergedAtBySha.get(candidate.commitSha) ?? "",
    }))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  const result: BackfillResult = { ...base, commitsScanned: rawLines.length };
  const knownForSample: Array<{ taskId: string; mergedAt: string }> = [];
  let writesUsed = 0;

  for (const candidate of extracted) {
    const exists = await deps.taskExists(candidate.taskId);
    if (!exists) {
      result.unregistered += 1;
      result.candidates.push({
        ...candidate,
        disposition: "unregistered",
        sampleForUpgrade: false,
      });
      if (apply) {
        // Advisories only on apply: a dry-run's only side effect is its report.
        deps.emit?.("recording_unregistered_merge", {
          taskId: candidate.taskId,
          commitSha: candidate.commitSha,
          subject: candidate.subject,
          method: "migration-scan",
        });
      }
      continue;
    }
    knownForSample.push({ taskId: candidate.taskId, mergedAt: candidate.mergedAt });

    let disposition: BackfillDisposition;
    if (claimantIndex.status === "unavailable") {
      disposition = "claimant-index-unavailable";
      result.claimantIndexUnavailable += 1;
      if (apply) {
        const recordResult = await deps.record(candidate, claimantIndex);
        if (recordResult.applied) {
          throw new Error(
            `Claimant index unavailable for ${candidate.taskId}, but the writer applied it.`,
          );
        }
        await deps.persistClaimantDiagnostic({
          kind: "claimant-index-unavailable",
          taskId: candidate.taskId,
          commitSha: candidate.commitSha,
          claimants: [],
          scannerMethod: "migration-scan",
          reason: claimantIndex.reason,
        });
      }
    } else if (claimantIndex.contested.has(candidate.taskId)) {
      const claimants = claimantIndex.contested.get(candidate.taskId) ?? [];
      disposition = "contested";
      result.contested += 1;
      if (apply) {
        await deps.persistClaimantDiagnostic({
          kind: "duplicate-claimants",
          taskId: candidate.taskId,
          commitSha: candidate.commitSha,
          claimants,
          scannerMethod: "migration-scan",
          reason: `Task ${candidate.taskId} has a contested id claimed by: ${claimants.join(", ")}.`,
        });
      }
    } else if (!apply) {
      const protectedRow = deps.hasProtectedRow
        ? await deps.hasProtectedRow(candidate.taskId)
        : false;
      disposition = protectedRow ? "skipped-existing" : "would-record";
      if (disposition === "skipped-existing") result.skippedExisting += 1;
    } else if (writesUsed >= maxWrites) {
      disposition = "over-cap";
      result.overCap += 1;
    } else {
      const recordResult = await deps.record(candidate, claimantIndex);
      if (recordResult.applied) {
        writesUsed += 1;
        disposition = "recorded";
        result.recorded += 1;
        deps.emit?.("recording_on_merge", {
          taskId: candidate.taskId,
          commitSha: candidate.commitSha,
          subject: candidate.subject,
          verdict: "SOFT-VERIFIED",
          method: "migration-scan",
        });
        deps.onTaskRecorded?.(candidate.taskId);
      } else {
        disposition = "skipped-existing";
        result.skippedExisting += 1;
      }
    }
    result.candidates.push({ ...candidate, disposition, sampleForUpgrade: false });
  }

  const sample = selectUpgradeSample(knownForSample, samplePercent);
  for (const candidate of result.candidates) {
    if (sample.has(candidate.taskId) && candidate.disposition !== "unregistered") {
      candidate.sampleForUpgrade = true;
    }
  }
  result.sample = [...sample].sort((a, b) => a.localeCompare(b));

  return result;
}

// ─── Lifecycle ──────────────────────────────────────────────────────

export interface OnMergeRecorderOptions extends OnMergeScanDeps {
  intervalMs?: number;
}

/**
 * Start the periodic scanner: one startup tick, then an interval. The timer
 * is unref()ed so it never keeps Jest workers or the process alive. Returns
 * a stop function.
 */
export function startOnMergeRecorder(opts: OnMergeRecorderOptions): () => void {
  const intervalMs = opts.intervalMs ?? 300_000;

  const tick = (): void => {
    void runOnMergeScan(opts).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      (opts.log ?? console.error)(`[on-merge] scan error (non-fatal): ${msg}`);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
