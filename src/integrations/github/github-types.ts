// ─── GitHub Integration Types ───────────────────────────────────────

/**
 * GitHub issue fetched from gh CLI.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
  referencedFiles: string[];
  linkedPRs: string[];
  state: "open" | "closed";
  url: string;
}

/**
 * GitHub integration configuration (part of adapter config).
 */
export interface GitHubConfig {
  owner: string;
  repo: string;
  importLabel?: string;
  publishLabel?: string;
  pollEnabled?: boolean;
  pollIntervalMs?: number;
  statusSyncIntervalMs?: number;
  reportBack?: boolean;
  closeOnMerge?: boolean;
  labels?: {
    ready?: string;
    inProgress?: string;
    approved?: string;
    rejected?: string;
    task?: string;
  };
}

/**
 * Bidirectional task↔issue mapping entry.
 */
export interface SyncEntry {
  taskId: string;
  issueNumber: number;
  direction: "imported" | "published";
  createdAt: string;
  lastSyncedAt: string;
  issueState: "open" | "closed";
  taskStatus: string;
}

/**
 * Persistent sync map stored at .quack/sync/github-sync.json.
 */
export interface SyncMap {
  entries: SyncEntry[];
}

/**
 * Sync event types for lifecycle tracking.
 */
export type SyncEventType =
  | "task_created"
  | "gate_passed"
  | "gate_failed"
  | "dispatch_started"
  | "dispatch_complete"
  | "pr_created";

/**
 * Sync event payload for lifecycle comments.
 */
export interface SyncEvent {
  type: SyncEventType;
  taskId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
