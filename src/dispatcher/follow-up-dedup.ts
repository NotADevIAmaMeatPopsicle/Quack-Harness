// ─── Follow-Up Task Deduplication ───────────────────────────────────
// Prevents duplicate follow-up task specs from being created when the
// judge emits similar follow_up_items across multiple related task runs.
//
// Uses Levenshtein distance + Jaccard token overlap to detect near-duplicate
// titles. Does NOT use embeddings or LLM calls — fast and cheap.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import { parseTaskFile } from "../core/task-parser.js";
import { withCanonicalTaskSpecMutationFence } from "../preflight/canonical-task-spec-mutation.js";

export interface BacklogEntry {
  taskId: string;
  title: string;
  tags: string[];
  filePath: string;
}

/** Default similarity threshold for considering two titles as duplicates */
const DEFAULT_THRESHOLD = 0.7;

/** Maximum number of backlog entries to load for dedup checks */
const MAX_BACKLOG_ENTRIES = 30;

/**
 * Compute Levenshtein distance between two strings.
 * Returns 0.0 (completely different) to 1.0 (identical).
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1.0;
  if (al.length === 0 || bl.length === 0) return 0.0;
  const m = al.length;
  const n = bl.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        al[i - 1] === bl[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

/**
 * Token overlap similarity: Jaccard index of word sets.
 * Returns 0.0 to 1.0.
 */
export function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/**
 * Combined similarity: max of Levenshtein and token overlap.
 * Using max rather than average means either strong method alone can flag a match.
 */
export function combinedSimilarity(a: string, b: string): number {
  return Math.max(levenshteinSimilarity(a, b), tokenOverlap(a, b));
}

/**
 * Find a similar existing task in the backlog.
 * Returns the first BacklogEntry whose title has combinedSimilarity >= threshold
 * with the given title, or null if no match found.
 *
 * Also checks the ignored patterns list — if the title matches an ignored pattern
 * at >= threshold similarity, returns null (suppressed without match).
 *
 * @param title - The follow-up item title to check
 * @param backlogTasks - Existing backlog entries to compare against
 * @param ignoredPatterns - Operator-defined patterns to suppress (from follow-up-ignored.json)
 * @param threshold - Minimum similarity score to count as a duplicate (default 0.7)
 */
export function findSimilarTask(
  title: string,
  backlogTasks: BacklogEntry[],
  ignoredPatterns?: string[],
  threshold: number = DEFAULT_THRESHOLD,
): BacklogEntry | null {
  // Check if the title matches an ignored pattern first
  if (ignoredPatterns && ignoredPatterns.length > 0) {
    for (const pattern of ignoredPatterns) {
      if (combinedSimilarity(title, pattern) >= threshold) {
        return null;
      }
    }
  }

  for (const entry of backlogTasks) {
    if (combinedSimilarity(title, entry.title) >= threshold) {
      return entry;
    }
  }

  return null;
}

/**
 * Load recent BACKLOG/READY task entries from the task directory.
 * Reads TASK-*.md files, parses title and tags, and returns up to
 * MAX_BACKLOG_ENTRIES entries sorted by task ID descending (newest first).
 */
export async function loadBacklogEntries(taskDir: string): Promise<BacklogEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(taskDir);
  } catch {
    return [];
  }

  const taskFiles = files.filter((file) => /\.md$/i.test(file));

  const entries: BacklogEntry[] = [];

  for (const file of taskFiles) {
    const filePath = path.join(taskDir, file);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    try {
      const task = parseTaskFile(content, filePath);
      if (task.status !== "BACKLOG" && task.status !== "READY") continue;
      entries.push({ taskId: task.id, title: task.title, tags: task.tags, filePath });
    } catch {
      // A malformed document cannot safely serve as a canonical dedup target.
    }
  }

  return entries
    .sort(
      (a, b) =>
        b.taskId.localeCompare(a.taskId, "en", { numeric: true }) ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_BACKLOG_ENTRIES);
}

/** The compact judge summary uses exactly the same declared-ID window as dedup. */
export async function loadRecentBacklogSummary(taskDir: string): Promise<string | undefined> {
  const entries = await loadBacklogEntries(taskDir);
  if (entries.length === 0) return undefined;
  return entries
    .map(
      (entry) =>
        `- ${entry.taskId}: ${entry.title}${entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""}`,
    )
    .join("\n");
}

/**
 * Load the operator ignore list from .quack/follow-up-ignored.json.
 * Returns [] if the file is absent or unparseable.
 */
export async function loadIgnoreList(projectRoot: string): Promise<string[]> {
  const ignorePath = path.join(projectRoot, ".quack", "follow-up-ignored.json");
  try {
    const raw = await fs.readFile(ignorePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Append a "Also flagged by judge run for TASK-NNN" comment to an existing
 * task spec file. Uses a HTML comment so it doesn't affect rendered markdown.
 * Idempotent: won't add duplicate references.
 */
export async function appendLinkedFromComment(
  taskFilePath: string,
  targetTaskId: string,
  fromTaskId: string,
  adapter: ProjectAdapter,
  beforeMutation?: () => Promise<boolean>,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(taskFilePath, "utf-8");
  } catch {
    return;
  }

  const marker = `<!-- Also flagged by judge run for ${fromTaskId} -->`;

  // Idempotency: don't append if already present
  if (content.includes(marker)) {
    return;
  }

  const updated = content.trimEnd() + "\n" + marker + "\n";
  await withCanonicalTaskSpecMutationFence({
    adapter,
    taskId: targetTaskId,
    taskFilePath,
    expectedContent: content,
    replacementContent: updated,
    authorize: beforeMutation,
  });
}
