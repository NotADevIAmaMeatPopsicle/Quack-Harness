// ─── Task Selector ──────────────────────────────────────────────────
// Filters eligible tasks and sorts them by priority (P0 > P1 > P2 > P3),
// then by effort (lower first). Produces a sorted TaskSelection[] array
// for the dispatcher to process.

import type { TaskSelection, TaskPriority, AgentFit } from "../core/types.js";
import type { TaskSummary } from "./dependency-resolver.js";

// ─── Constants ──────────────────────────────────────────────────────

/** Priority ordering: lower number = higher priority */
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  "P0-CRITICAL": 0,
  "P1-HIGH": 1,
  "P2-MEDIUM": 2,
  "P3-LOW": 3,
};

// ─── Effort parsing ─────────────────────────────────────────────────

/**
 * Parse an effort string like "4-6 hours" or "2 hours" into a numeric value.
 * Uses the lower bound for ranges. Returns Infinity if unparseable.
 */
export function parseEffort(effort: string): number {
  // Match patterns like "4-6 hours", "4-6", "4 hours", "4h"
  const rangeMatch = effort.match(/(\d+)\s*-\s*(\d+)/);
  if (rangeMatch) {
    return parseInt(rangeMatch[1], 10);
  }

  const singleMatch = effort.match(/(\d+)/);
  if (singleMatch) {
    return parseInt(singleMatch[1], 10);
  }

  return Infinity;
}

// ─── Agent fit estimation ───────────────────────────────────────────

/**
 * Estimate how well-suited a task is for agent execution based on
 * convention density and test criteria availability.
 */
export function estimateAgentFit(task: TaskSummary): AgentFit {
  let score = 0;

  // Convention references improve agent reliability
  if (task.task.conventions.length > 0) {
    score += 2;
  }

  // Test requirements help verification
  if (task.task.testingRequirements.length > 0) {
    score += 2;
  }

  // Files-to-modify provides scope clarity
  if (task.task.filesToModify.length > 0) {
    score += 1;
  }

  // Effort under 8 hours is agent-friendly
  const effortHours = parseEffort(task.task.effort);
  if (effortHours <= 8) {
    score += 1;
  }

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

// ─── Readiness scoring ──────────────────────────────────────────────

/**
 * Compute a readiness score (0-100) for a task based on how
 * complete and well-specified it is.
 */
export function computeReadinessScore(task: TaskSummary): number {
  let score = 0;

  // Required fields present (should always be true for parsed tasks)
  if (task.task.problemStatement) score += 15;
  if (task.task.successCriteria.length > 0) score += 15;
  if (task.task.testingRequirements.length > 0) score += 15;

  // Recommended fields
  if (task.task.currentState) score += 10;
  if (task.task.recommendedApproach) score += 10;
  if (task.task.filesToModify.length > 0) score += 15;

  // Bonus for convention references
  if (task.task.conventions.length > 0) score += 10;

  // Bonus for context references
  if (task.task.contextReferences.length > 0) score += 5;

  // Bonus for multiple success criteria (more specific)
  if (task.task.successCriteria.length >= 3) score += 5;

  return Math.min(score, 100);
}

// ─── Main selector ──────────────────────────────────────────────────

/**
 * Convert a TaskSummary into a TaskSelection with computed scores.
 */
export function toTaskSelection(task: TaskSummary): TaskSelection {
  return {
    taskId: task.id,
    priority: task.task.priority,
    effort: task.task.effort,
    blockedBy: task.blockedBy,
    conventions: task.task.conventions,
    hasTestCriteria: task.task.testingRequirements.length > 0,
    readinessScore: computeReadinessScore(task),
    estimatedAgentFit: estimateAgentFit(task),
  };
}

/**
 * Sort eligible tasks by priority (P0 > P1 > P2 > P3), then by
 * effort (lower first), then by readiness score (higher first).
 *
 * @param eligible - List of tasks that passed dependency resolution
 * @returns Sorted array of TaskSelection objects
 */
export function selectTasks(eligible: TaskSummary[]): TaskSelection[] {
  const selections = eligible.map(toTaskSelection);

  selections.sort((a, b) => {
    // 1. Priority ordering (lower number = higher priority)
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;

    // 2. Effort ordering (lower effort first)
    const effortDiff = parseEffort(a.effort) - parseEffort(b.effort);
    if (effortDiff !== 0) return effortDiff;

    // 3. Readiness score (higher first)
    return b.readinessScore - a.readinessScore;
  });

  return selections;
}
