// ─── Database Row Types ────────────────────────────────────────────
// TypeScript types matching SQLite table columns.
// All JSON blob columns are stored as TEXT and parsed on read.

export interface TaskStatusRow {
  task_id: string;
  status: string;
  updated_at: string;
  updated_by: string;
  previous_status: string | null;
}

export interface SessionRow {
  session_id: string;
  task_id: string;
  project: string;
  title: string | null;
  start_time: string;
  status: string;
  outcome: string | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  turns_used: number | null;
}

export interface DispatchJobRow {
  task_id: string;
  session_id: string;
  pid: number;
  started_at: string;
  status: string;
  exit_code: number | null;
  worktree_path: string | null;
  container_id: string | null;
  key_id: string | null;
  output_tail: string | null; // JSON array
}

export interface VerifiedRow {
  task_id: string;
  verified_at: string;
  updated_at?: string;
  commit_sha: string;
  method: string;
  verdict: string;
  criteria_checked: number;
  criteria_passed: number;
  notes: string | null;
}

export interface CheckpointRow {
  task_id: string;
  session_id: string;
  completed_stages: string; // JSON array
  branch_name: string | null;
  total_cost_usd: number;
  retries_used: number;
  started_at: string;
  updated_at: string;
  parent_task_id: string | null;
  shared_branch: string | null;
  agent_result: string | null; // JSON blob
  judge_result: string | null; // JSON blob
  gate_result: string | null; // JSON blob
}

export interface PrepCacheRow {
  task_id: string;
  prepared_at: string;
  schema_valid: number; // 0 or 1
  depth_score: number;
  depth_ready: number; // 0 or 1
  deficiencies: string; // JSON array
  outcome: string;
  content_hash: string | null;
  stale: number; // 0 or 1
  preflight_data: string | null; // JSON blob
}

export interface ReadinessSnapshotRow {
  task_id: string;
  spec_hash: string;
  base_spec_hash: string | null;
  created_at: string;
  updated_at: string;
  schema_valid: number; // 0 or 1
  schema_errors: string; // JSON array
  depth_score: number;
  depth_ready: number; // 0 or 1
  deficiencies: string; // JSON array
  outcome: string;
  prep_data: string | null; // JSON blob
  preflight_data: string | null; // JSON blob
  effective_spec_data: string | null; // JSON blob
  stale_reason: string | null;
  source: string | null;
  generator_version: string | null;
}

export interface EffectiveSpecRow {
  task_id: string;
  base_spec_hash: string;
  effective_spec_hash: string;
  status: string;
  content: string;
  deficiencies: string; // JSON array
  source: string;
  created_at: string;
  updated_at: string;
  /**
   * TASK-922 / follow-up: commit SHA when this effective spec was committed
   * to the canonical clone by enrichment auto-commit. Null when the commit
   * was skipped (e.g. autoCommit disabled, protected branch, dirty tree)
   * or for legacy rows written before the column existed.
   */
  commit_sha?: string | null;
}

export interface QueueItemRow {
  task_id: string;
  status: string;
  priority: number;
  blocked_by: string; // JSON array
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  outcome: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  retry_count: number;
  error: string | null;
  dispatch_options: string | null; // JSON blob
}

/** One recorded verification write (TASK-1321). Append-only: unlike
 *  `VerifiedRow`, which holds only the latest verdict per task, every
 *  write lands here as a new row. */
export interface VerifiedHistoryRow {
  id: number;
  task_id: string;
  verified_at: string;
  recorded_at: string;
  commit_sha: string;
  method: string;
  verdict: string;
  criteria_checked: number;
  criteria_passed: number;
  notes: string | null;
  /** The verdict this write replaced; null on the first write for a task. */
  previous_verdict: string | null;
}
