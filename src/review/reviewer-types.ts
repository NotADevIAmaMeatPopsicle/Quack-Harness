// ─── ReviewerRunner Types ───────────────────────────────────────────
// Contract for cross-model adversarial review runners (TASK-1305, P1-2a).
// Loop mode inserts these reviews at the existing brief gate (blueprint
// approval) and diff gate (judge review) — that wiring is TASK-1307.
//
// The load-bearing property: runner-environment failures surface as their
// own typed state (`runner_error`) and are NEVER converted into verdicts,
// in either direction. `run()` never rejects; the only throwing surface in
// the module is construction-time config validation.

/** What is being reviewed: a pre-build brief or a post-build diff. */
export type ReviewKind = "brief" | "diff";

/** Which runner implementation performed (or attempted) the review. */
export type ReviewerRunnerKind = "claude-sdk" | "codex-cli";

/**
 * Verdict vocabulary of the manual cross-model loop, deliberately:
 * SHIP (proceed), AMEND (fold findings, then proceed), FIX_FIRST
 * (blocking issues; do not proceed).
 */
export type ReviewVerdict = "SHIP" | "AMEND" | "FIX_FIRST";

/** A single reviewer finding with evidence anchors. */
export interface ReviewerFinding {
  severity: "blocking" | "should_fix" | "nit";
  summary: string;
  detail?: string;
  /** file or file:line citations the finding rests on */
  anchors?: string[];
}

/** Input to a review run. The artifact is plain text by design. */
export interface ReviewRequest {
  kind: ReviewKind;
  taskId: string;
  /** Full task spec markdown (the contract being reviewed against) */
  taskSpec: string;
  /** The artifact under review: brief/blueprint markdown (kind=brief) or git diff (kind=diff) */
  artifact: string;
  /** Optional formatted verification summary (diff reviews) */
  verification?: string;
  /** Optional conventions/constraints extract */
  constraints?: string;
  projectRoot: string;
}

/** Findings' file anchors checked against disk (spark-paraphrase hazard). */
export interface ReviewAnchorsAudit {
  total: number;
  missing: string[];
}

/**
 * Environment-failure classification. Gates branch on
 * `completed` vs `runner_error`; the kind is for human triage.
 */
export type ReviewRunnerErrorKind =
  | "unavailable" // binary/SDK not present or not loadable
  | "spawn_failed" // process failed to start (the 0xC0000142 class)
  | "timeout" // exceeded timeoutMs and was killed / raced out
  | "session_error" // ran but exited non-zero / SDK error-subtype result / unexpected throw
  | "parse_failed"; // ran to completion but produced no valid verdict JSON

/** A completed review with a verdict. */
export interface ReviewCompleted {
  status: "completed";
  verdict: ReviewVerdict;
  findings: ReviewerFinding[];
  /** reviewer's stated confidence 0-1 when provided */
  confidence?: number;
  summary: string;
  rawText: string;
  runner: ReviewerRunnerKind;
  model?: string;
  durationMs: number;
  costUsd?: number;
  /** findings' file anchors checked against disk */
  anchorsAudit?: ReviewAnchorsAudit;
  /** codex-cli only: git tree was dirty after a supposedly read-only review */
  treeDirtyAfterReview?: boolean;
  /** codex-cli only: path of the persisted review-request file (audit link) */
  requestFile?: string;
}

/** A runner-environment failure. Never a judgment about the artifact. */
export interface ReviewRunnerError {
  status: "runner_error";
  errorKind: ReviewRunnerErrorKind;
  message: string;
  rawText?: string;
  runner: ReviewerRunnerKind;
  durationMs: number;
  /** subprocess diagnostics when applicable (codex-cli) */
  exitCode?: number;
  signal?: string;
  stderrTail?: string;
  requestFile?: string;
}

/**
 * Result of a review run. Plain JSON data by contract — the approval-file
 * persistence path (TASK-1307) depends on results surviving a JSON round-trip.
 */
export type ReviewRunResult = ReviewCompleted | ReviewRunnerError;

/** The runner abstraction. `run()` never rejects. */
export interface ReviewerRunner {
  readonly kind: ReviewerRunnerKind;
  run(request: ReviewRequest): Promise<ReviewRunResult>;
}
