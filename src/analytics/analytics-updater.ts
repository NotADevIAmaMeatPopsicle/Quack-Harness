// ─── Analytics Updater ─────────────────────────────────────────────
// Updates failure pattern database after each task run.
// Uses deterministic pattern detection (no LLM).

import * as fs from "node:fs";
import * as path from "node:path";

import type { RunAnalysis, FailurePatternDB } from "./analytics-types.js";
import { createEmptyPatternDB } from "./analytics-types.js";
import type { EventReader } from "../monitor/event-reader.js";
import { resolveParsedTaskFileSync, type ResolvedTaskFile } from "../core/task-file-resolver.js";
import { extractFeedbackThemes } from "./post-run-analyzer.js";

/**
 * Update the failure pattern database with a new run analysis.
 *
 * This function:
 * 1. Loads the existing pattern DB (or creates a new one)
 * 2. Updates counters and success rates
 * 3. Detects new patterns using deterministic heuristics
 * 4. Writes the updated DB back to disk
 */
export function updateAnalytics(analysis: RunAnalysis, projectRoot: string): void {
  const analyticsDir = path.join(projectRoot, ".quack", "analytics");
  const dbPath = path.join(analyticsDir, "failure-patterns.json");

  // Ensure analytics directory exists
  if (!fs.existsSync(analyticsDir)) {
    fs.mkdirSync(analyticsDir, { recursive: true });
  }

  // Load existing DB or create new one
  let db: FailurePatternDB;
  if (fs.existsSync(dbPath)) {
    try {
      db = JSON.parse(fs.readFileSync(dbPath, "utf-8")) as FailurePatternDB;
    } catch {
      db = createEmptyPatternDB();
    }
  } else {
    db = createEmptyPatternDB();
  }

  // Update overall counters
  db.totalRuns++;
  if (analysis.outcome === "approved") {
    db.totalApproved++;
  } else if (analysis.outcome === "rejected") {
    db.totalRejected++;
  } else {
    db.totalErrors++;
  }

  // Update by-tag stats
  for (const tag of analysis.taskTags) {
    if (!db.byTag[tag]) {
      db.byTag[tag] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
    }
    db.byTag[tag].runs++;
    if (analysis.outcome === "approved") {
      db.byTag[tag].approved++;
    } else if (analysis.outcome === "rejected") {
      db.byTag[tag].rejected++;
    }
    db.byTag[tag].rate = db.byTag[tag].approved / db.byTag[tag].runs;
  }

  // Update by-file stats
  for (const file of analysis.targetFiles) {
    if (!db.byFile[file]) {
      db.byFile[file] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
    }
    db.byFile[file].runs++;
    if (analysis.outcome === "approved") {
      db.byFile[file].approved++;
    } else if (analysis.outcome === "rejected") {
      db.byFile[file].rejected++;
    }
    db.byFile[file].rate = db.byFile[file].approved / db.byFile[file].runs;
  }

  // Update by-complexity stats
  const complexityBucket = classifyComplexity(
    analysis.complexity.filesToModify,
    analysis.complexity.successCriteria,
  );
  db.byComplexity[complexityBucket].runs++;
  if (analysis.outcome === "approved") {
    db.byComplexity[complexityBucket].approved++;
  } else if (analysis.outcome === "rejected") {
    db.byComplexity[complexityBucket].rejected++;
  }
  db.byComplexity[complexityBucket].rate =
    db.byComplexity[complexityBucket].approved / db.byComplexity[complexityBucket].runs;

  // Update by-gate-score stats
  const scoreBucket = classifyGateScore(analysis.gateScore);
  if (!db.byGateScore[scoreBucket]) {
    db.byGateScore[scoreBucket] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
  }
  db.byGateScore[scoreBucket].runs++;
  if (analysis.outcome === "approved") {
    db.byGateScore[scoreBucket].approved++;
  } else if (analysis.outcome === "rejected") {
    db.byGateScore[scoreBucket].rejected++;
  }
  db.byGateScore[scoreBucket].rate =
    db.byGateScore[scoreBucket].approved / db.byGateScore[scoreBucket].runs;

  // Update feedback themes
  for (const theme of analysis.feedbackThemes) {
    const existing = db.topFeedbackThemes.find((t) => t.theme === theme);
    if (existing) {
      existing.count++;
    } else {
      db.topFeedbackThemes.push({ theme, count: 1 });
    }
  }
  // Sort by count descending
  db.topFeedbackThemes.sort((a, b) => b.count - a.count);

  // Detect new patterns (deterministic)
  detectPatterns(db, analysis);

  // Update timestamp
  db.updatedAt = new Date().toISOString();

  // Write back to disk
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
}

/**
 * Classify complexity bucket based on file count and criteria count.
 */
function classifyComplexity(
  filesToModify: number,
  successCriteria: number,
): "simple" | "medium" | "complex" {
  if (filesToModify <= 2 && successCriteria <= 5) {
    return "simple";
  } else if (filesToModify <= 5 && successCriteria <= 10) {
    return "medium";
  } else {
    return "complex";
  }
}

/**
 * Classify gate score into buckets for comparison.
 */
function classifyGateScore(score: number): string {
  if (score < 3.0) return "<3.0";
  if (score < 3.5) return "3.0-3.5";
  if (score < 4.0) return "3.5-4.0";
  if (score < 4.5) return "4.0-4.5";
  return "4.5+";
}

/**
 * Detect patterns using deterministic heuristics.
 */
function detectPatterns(db: FailurePatternDB, _analysis: RunAnalysis): void {
  const now = new Date().toISOString();

  // Pattern 1: File hot spots (3+ rejected runs specifically)
  for (const [file, stats] of Object.entries(db.byFile)) {
    const rejected = stats.rejected ?? 0;
    if (rejected >= 3) {
      updateOrAddPattern(
        db,
        `file_hotspot:${file}`,
        `File ${file} has ${rejected} rejected runs in ${stats.runs} total runs (${(stats.rate * 100).toFixed(1)}% success rate)`,
        now,
        `Review integration points in ${file}. Consider adding more context or examples in task specs targeting this file.`,
      );
    }
  }

  // Pattern 2: Tag failure clusters (<50% success rate)
  for (const [tag, stats] of Object.entries(db.byTag)) {
    if (stats.runs >= 3 && stats.rate < 0.5) {
      updateOrAddPattern(
        db,
        `tag_cluster:${tag}`,
        `Tasks tagged "${tag}" have ${stats.approved} successes in ${stats.runs} runs (${(stats.rate * 100).toFixed(1)}% success rate)`,
        now,
        `Consider enriching task specs for "${tag}" tasks with more detailed examples and integration guidance.`,
      );
    }
  }

  // Pattern 3: Gate score threshold drift
  // If low-score tasks fail frequently but high-score tasks succeed, suggest raising threshold
  const lowScores = ["<3.0", "3.0-3.5"];
  const highScores = ["4.0-4.5", "4.5+"];
  const lowRate =
    lowScores
      .map((s) => db.byGateScore[s])
      .filter((s) => s && s.runs >= 2)
      .reduce((sum, s) => sum + s.rate * s.runs, 0) /
    lowScores.map((s) => db.byGateScore[s]?.runs ?? 0).reduce((sum, n) => sum + n, 0);
  const highRate =
    highScores
      .map((s) => db.byGateScore[s])
      .filter((s) => s && s.runs >= 2)
      .reduce((sum, s) => sum + s.rate * s.runs, 0) /
    highScores.map((s) => db.byGateScore[s]?.runs ?? 0).reduce((sum, n) => sum + n, 0);

  if (!isNaN(lowRate) && !isNaN(highRate) && lowRate < 0.4 && highRate > 0.7) {
    updateOrAddPattern(
      db,
      "gate_threshold_drift",
      `Tasks with gate scores <3.5 have ${(lowRate * 100).toFixed(1)}% success rate, while scores 4.0+ have ${(highRate * 100).toFixed(1)}% success rate`,
      now,
      "Consider raising the gate threshold to 3.5 or 4.0 to reduce low-quality task dispatches.",
    );
  }

  // Pattern 4: Recurring feedback themes (3+ occurrences)
  for (const { theme, count } of db.topFeedbackThemes) {
    if (count >= 3) {
      updateOrAddPattern(
        db,
        `feedback_theme:${theme}`,
        `Judge feedback mentions "${theme}" in ${count} runs`,
        now,
        `Add verification checks or conventions guidance specifically for ${theme.replace(/_/g, " ")}.`,
      );
    }
  }
}

/**
 * Update an existing pattern or add a new one.
 */
function updateOrAddPattern(
  db: FailurePatternDB,
  pattern: string,
  description: string,
  now: string,
  suggestion: string,
): void {
  const existing = db.knownPatterns.find((p) => p.pattern === pattern);
  if (existing) {
    existing.occurrences++;
    existing.lastSeen = now;
    existing.description = description; // Update description with latest stats
  } else {
    db.knownPatterns.push({
      pattern,
      description,
      occurrences: 1,
      firstSeen: now,
      lastSeen: now,
      suggestion,
    });
  }
}

/**
 * Try to load and parse a task spec file for a given taskId.
 * Returns parsed task data or null if the task file cannot be found/parsed.
 */
export function summarizeResolvedTaskSpec(resolved: ResolvedTaskFile): {
  tags: string[];
  targetFiles: string[];
  filesToModify: number;
  successCriteria: number;
} | null {
  const parsed = resolved.task;
  if (!parsed) return null;
  return {
    tags: parsed.tags,
    targetFiles: parsed.filesToModify.map((f) => f.path),
    filesToModify: parsed.filesToModify.length,
    successCriteria: parsed.successCriteria.length,
  };
}

function tryLoadTaskSpec(
  taskId: string,
  projectRoot: string,
): {
  tags: string[];
  targetFiles: string[];
  filesToModify: number;
  successCriteria: number;
} | null {
  try {
    // Look for task files in the default docs/tasks directory
    const possibleDirs = [
      path.join(projectRoot, "docs", "tasks"),
      path.join(projectRoot, ".quack", "tasks"),
    ];

    for (const taskDir of possibleDirs) {
      if (!fs.existsSync(taskDir)) continue;
      const resolved = resolveParsedTaskFileSync(taskDir, taskId);
      if (resolved) {
        return summarizeResolvedTaskSpec(resolved);
      }
    }
  } catch {
    // Task spec parsing is best-effort during rebuild
  }
  return null;
}

/**
 * Rebuild the entire analytics database from all historical sessions.
 * Used by the /api/analytics/rebuild endpoint.
 */
export function rebuildAnalyticsDB(reader: EventReader, projectRoot: string): void {
  const analyticsDir = path.join(projectRoot, ".quack", "analytics");
  const dbPath = path.join(analyticsDir, "failure-patterns.json");

  // Start with empty DB
  const db = createEmptyPatternDB();

  // Get all sessions
  const sessions = reader.getExecutionSessions();

  // Cache task specs to avoid re-parsing for same taskId
  const taskSpecCache = new Map<string, ReturnType<typeof tryLoadTaskSpec>>();

  // Process each session as a RunAnalysis
  for (const session of sessions) {
    // Skip active sessions
    if (session.status === "active" || !session.outcome) continue;
    // TASK-1332 round-5 (R5-6): a spec-identity refusal is not a RUN.
    // No agent turn, no judge, no diff, no criteria, the dispatcher
    // stopped before any of it deliberately. The normalization below
    // collapses every non-approved/rejected outcome to "error", so
    // leaving it in would file every correct refusal as a failure and
    // poison the failure-pattern history this DB exists to build.
    if (session.outcome === "spec_changed") continue;

    // Read session events to extract more details
    const events = reader.getSessionEvents(session.sessionId);
    const gateDepthEvent = events.find((e) => e.stage === "gate_depth");
    const blueprintEvent = events.find((e) => e.stage === "blueprint_generated");
    // Find the last judge result event (there may be multiple from retries)
    const judgeEvents = events.filter((e) => e.stage === "judge_result");
    const lastJudge = judgeEvents.length > 0 ? judgeEvents[judgeEvents.length - 1] : null;

    // Try to load task spec for tags and target files
    if (!taskSpecCache.has(session.taskId)) {
      taskSpecCache.set(session.taskId, tryLoadTaskSpec(session.taskId, projectRoot));
    }
    const taskSpec = taskSpecCache.get(session.taskId) ?? null;

    // Extract judge feedback for theme analysis
    const judgeFeedback = lastJudge
      ? ((lastJudge.payload as { feedback?: string })?.feedback ?? "")
      : "";
    const feedbackThemes = extractFeedbackThemes(judgeFeedback);

    // Extract criteria results from judge event
    const judgePayload = lastJudge?.payload as
      | { criteriaGaps?: string[]; scopeViolations?: string[] }
      | undefined;
    const criteriaResults: Array<{ criterion: string; status: "PASS" | "PARTIAL" | "FAIL" }> = [];
    // Criteria gaps and scope violations from judge payload indicate failures
    if (judgePayload?.criteriaGaps) {
      for (const gap of judgePayload.criteriaGaps) {
        criteriaResults.push({ criterion: gap, status: "FAIL" });
      }
    }

    // Build RunAnalysis from session data + task spec
    // Normalize outcome: only "approved" and "rejected" are specific; everything else is "error"
    const rawOutcome = session.outcome ?? "error";
    const normalizedOutcome: "approved" | "rejected" | "error" =
      rawOutcome === "approved" ? "approved" : rawOutcome === "rejected" ? "rejected" : "error";

    // Count retries: number of judge events - 1 (first attempt isn't a retry)
    const retriesUsed = Math.max(0, judgeEvents.length - 1);

    const analysis: RunAnalysis = {
      taskId: session.taskId,
      sessionId: session.sessionId,
      outcome: normalizedOutcome,
      costUsd: session.totalCostUsd ?? 0,
      turnsUsed: session.turnsUsed ?? 0,
      retriesUsed,
      taskTags: taskSpec?.tags ?? [],
      targetFiles: taskSpec?.targetFiles ?? [],
      criteriaResults,
      feedbackThemes,
      gateScore: (gateDepthEvent?.payload as { overallScore?: number })?.overallScore ?? 0,
      blueprintMetrics: blueprintEvent
        ? {
            fileAnalyses: (blueprintEvent.payload as { fileAnalyses?: number })?.fileAnalyses ?? 0,
            codeExamples: (blueprintEvent.payload as { codeExamples?: number })?.codeExamples ?? 0,
          }
        : undefined,
      complexity: {
        filesToModify: taskSpec?.filesToModify ?? 0,
        successCriteria: taskSpec?.successCriteria ?? 0,
      },
    };

    // Update DB using the standard updateAnalytics flow inline
    db.totalRuns++;
    if (analysis.outcome === "approved") {
      db.totalApproved++;
    } else if (analysis.outcome === "rejected") {
      db.totalRejected++;
    } else {
      db.totalErrors++;
    }

    // Update by-tag stats
    for (const tag of analysis.taskTags) {
      if (!db.byTag[tag]) {
        db.byTag[tag] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
      }
      db.byTag[tag].runs++;
      if (analysis.outcome === "approved") {
        db.byTag[tag].approved++;
      } else if (analysis.outcome === "rejected") {
        db.byTag[tag].rejected++;
      }
      db.byTag[tag].rate = db.byTag[tag].approved / db.byTag[tag].runs;
    }

    // Update by-file stats
    for (const file of analysis.targetFiles) {
      if (!db.byFile[file]) {
        db.byFile[file] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
      }
      db.byFile[file].runs++;
      if (analysis.outcome === "approved") {
        db.byFile[file].approved++;
      } else if (analysis.outcome === "rejected") {
        db.byFile[file].rejected++;
      }
      db.byFile[file].rate = db.byFile[file].approved / db.byFile[file].runs;
    }

    // Update by-complexity stats
    const complexityBucket = classifyComplexity(
      analysis.complexity.filesToModify,
      analysis.complexity.successCriteria,
    );
    db.byComplexity[complexityBucket].runs++;
    if (analysis.outcome === "approved") {
      db.byComplexity[complexityBucket].approved++;
    } else if (analysis.outcome === "rejected") {
      db.byComplexity[complexityBucket].rejected++;
    }
    db.byComplexity[complexityBucket].rate =
      db.byComplexity[complexityBucket].approved / db.byComplexity[complexityBucket].runs;

    // Update by-gate-score stats
    const scoreBucket = classifyGateScore(analysis.gateScore);
    if (!db.byGateScore[scoreBucket]) {
      db.byGateScore[scoreBucket] = { runs: 0, approved: 0, rejected: 0, rate: 0 };
    }
    db.byGateScore[scoreBucket].runs++;
    if (analysis.outcome === "approved") {
      db.byGateScore[scoreBucket].approved++;
    } else if (analysis.outcome === "rejected") {
      db.byGateScore[scoreBucket].rejected++;
    }
    db.byGateScore[scoreBucket].rate =
      db.byGateScore[scoreBucket].approved / db.byGateScore[scoreBucket].runs;

    // Update feedback themes
    for (const theme of analysis.feedbackThemes) {
      const existing = db.topFeedbackThemes.find((t) => t.theme === theme);
      if (existing) {
        existing.count++;
      } else {
        db.topFeedbackThemes.push({ theme, count: 1 });
      }
    }
  }

  // Sort feedback themes by count descending
  db.topFeedbackThemes.sort((a, b) => b.count - a.count);

  // Detect patterns
  detectPatterns(db, {} as RunAnalysis);

  // Update timestamp
  db.updatedAt = new Date().toISOString();

  // Ensure directory exists
  if (!fs.existsSync(analyticsDir)) {
    fs.mkdirSync(analyticsDir, { recursive: true });
  }

  // Write to disk
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
}
