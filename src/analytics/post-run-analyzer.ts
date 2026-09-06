// ─── Post-Run Analyzer ─────────────────────────────────────────────
// Extracts structured RunAnalysis from completed task sessions.
// Called by dispatcher after every session completion.

import type { ParsedTask, AgentResult, JudgeResult } from "../core/types.js";
import type { RunAnalysis } from "./analytics-types.js";

export interface AnalyzeRunInput {
  sessionId: string;
  task: ParsedTask;
  agentResult?: AgentResult;
  judgeResult?: JudgeResult;
  outcome: "approved" | "rejected" | "error";
  totalCostUsd: number;
  durationMs: number;
  retriesUsed: number;
  gateScore?: number;
  blueprintMetrics?: { fileAnalyses: number; codeExamples: number };
}

/**
 * Extracts structured analytics data from a completed task run.
 *
 * This function consolidates data from the task spec, agent execution,
 * and judge verdict into a single RunAnalysis record for pattern detection.
 */
export function analyzeRun(input: AnalyzeRunInput): RunAnalysis {
  const {
    sessionId,
    task,
    agentResult,
    judgeResult,
    outcome,
    totalCostUsd,
    retriesUsed,
    gateScore,
    blueprintMetrics,
  } = input;

  // Extract criteria results from judge verdict (if available)
  const criteriaResults =
    judgeResult?.criteriaEvaluation?.map((c) => ({
      criterion: c.criterion,
      status: c.status,
    })) ?? [];

  // Extract feedback themes from judge feedback
  const feedbackThemes = extractFeedbackThemes(judgeResult?.feedback ?? "");

  // Classify complexity bucket
  const filesToModifyCount = task.filesToModify.length;
  const successCriteriaCount = task.successCriteria.length;

  return {
    taskId: task.id,
    sessionId,
    outcome,
    costUsd: totalCostUsd,
    turnsUsed: agentResult?.turnsUsed ?? 0,
    retriesUsed,
    taskTags: task.tags,
    targetFiles: task.filesToModify.map((f) => f.path),
    criteriaResults,
    feedbackThemes,
    gateScore: gateScore ?? 0,
    blueprintMetrics,
    complexity: {
      filesToModify: filesToModifyCount,
      successCriteria: successCriteriaCount,
    },
  };
}

/**
 * Extract recurring themes from judge feedback text.
 * Uses simple keyword matching for deterministic detection.
 */
export function extractFeedbackThemes(feedback: string): string[] {
  const themes: string[] = [];
  const lower = feedback.toLowerCase();

  // Common failure themes
  const themePatterns = [
    { keyword: "test", theme: "test_failures" },
    { keyword: "lint", theme: "lint_errors" },
    { keyword: "type", theme: "type_errors" },
    { keyword: "build", theme: "build_failures" },
    { keyword: "integration", theme: "integration_issues" },
    { keyword: "scope", theme: "scope_violations" },
    { keyword: "missing", theme: "incomplete_implementation" },
    { keyword: "stub", theme: "stubbed_code" },
    { keyword: "todo", theme: "incomplete_implementation" },
    { keyword: "error handling", theme: "error_handling_gaps" },
    { keyword: "edge case", theme: "edge_case_gaps" },
    { keyword: "documentation", theme: "missing_documentation" },
  ];

  for (const { keyword, theme } of themePatterns) {
    if (lower.includes(keyword) && !themes.includes(theme)) {
      themes.push(theme);
    }
  }

  return themes;
}
