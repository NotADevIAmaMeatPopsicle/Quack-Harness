import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type { ParsedTask } from "../core/types.js";

export interface EnrichmentCandidateQualitySummary {
  parseValid: boolean;
  parseError?: string;
  taskId?: string;
  title?: string;
  priority?: string;
  status?: string;
  successCriteria: number;
  testingRequirements: number;
  filesToModify: number;
  blockedBy: string[];
  blocks: string[];
  tags: string[];
  materialScore: number;
}

export interface EnrichmentCandidateDecision {
  accepted: boolean;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  score: {
    current: number;
    candidate: number;
    delta: number;
  };
  current: EnrichmentCandidateQualitySummary;
  candidate: EnrichmentCandidateQualitySummary;
}

interface ParsedSummary {
  task: ParsedTask | null;
  summary: EnrichmentCandidateQualitySummary;
}

const RISK_TAG_PATTERN =
  /(security|tenant|auth|privacy|compliance|risk|secret|credential|aws|infra)/iu;
const COMMAND_PATTERN =
  /\b(npm|pnpm|yarn|jest|vitest|playwright|tsc|eslint|docker|curl|bash|pwsh|pytest)\b/iu;
const PATH_PATTERN = /(?:^|[\s`])(?:[\w.-]+\/)+[\w.-]+/u;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_()[\].,:;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeList(values: string[]): string[] {
  return values.map(normalizeText).filter(Boolean);
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/gu, "/")
    .replace(/^\.?\//u, "")
    .toLowerCase();
}

function missingValues(current: string[], candidate: string[]): string[] {
  const candidateSet = new Set(normalizeList(candidate));
  return current.filter((value) => !candidateSet.has(normalizeText(value)));
}

function missingPaths(current: ParsedTask, candidate: ParsedTask): string[] {
  const candidatePaths = new Set(candidate.filesToModify.map((file) => normalizePath(file.path)));
  return current.filesToModify
    .map((file) => file.path)
    .filter((filePath) => !candidatePaths.has(normalizePath(filePath)));
}

function riskTags(task: ParsedTask): string[] {
  return task.tags.filter((tag) => RISK_TAG_PATTERN.test(tag));
}

function countWords(value: string): number {
  const words = value.match(/\b[\w-]+\b/gu);
  return words?.length ?? 0;
}

function specificityScore(items: string[]): number {
  return items.reduce((score, item) => {
    let itemScore = Math.min(2, Math.floor(countWords(item) / 8));
    if (PATH_PATTERN.test(item)) itemScore += 1;
    if (COMMAND_PATTERN.test(item)) itemScore += 1;
    return score + itemScore;
  }, 0);
}

function computeMaterialScore(task: ParsedTask): number {
  const sectionDetailScore = Math.min(
    12,
    Math.floor((countWords(task.currentState) + countWords(task.recommendedApproach)) / 35),
  );

  const riskMetadataScore = riskTags(task).length * 2;

  return (
    task.successCriteria.length * 3 +
    specificityScore(task.successCriteria) +
    task.testingRequirements.length * 4 +
    specificityScore(task.testingRequirements) +
    task.filesToModify.length * 2 +
    task.filesToModify.filter((file) => file.notes.trim().length > 10).length +
    task.blockedBy.length +
    task.blocks.length +
    sectionDetailScore +
    riskMetadataScore
  );
}

function summarizeTask(task: ParsedTask): EnrichmentCandidateQualitySummary {
  return {
    parseValid: true,
    taskId: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    successCriteria: task.successCriteria.length,
    testingRequirements: task.testingRequirements.length,
    filesToModify: task.filesToModify.length,
    blockedBy: [...task.blockedBy],
    blocks: [...task.blocks],
    tags: [...task.tags],
    materialScore: computeMaterialScore(task),
  };
}

function parseForGate(content: string, label: string): ParsedSummary {
  try {
    const task = parseTaskFile(content, label);
    return {
      task,
      summary: summarizeTask(task),
    };
  } catch (err: unknown) {
    const parseError =
      err instanceof TaskParseError || err instanceof Error ? err.message : String(err);
    return {
      task: null,
      summary: {
        parseValid: false,
        parseError,
        successCriteria: 0,
        testingRequirements: 0,
        filesToModify: 0,
        blockedBy: [],
        blocks: [],
        tags: [],
        materialScore: 0,
      },
    };
  }
}

function pushMissingBlockers(blockers: string[], code: string, missing: string[]): void {
  if (missing.length > 0 && !blockers.includes(code)) {
    blockers.push(code);
  }
}

export function evaluateEnrichmentCandidate(
  currentContent: string,
  candidateContent: string,
): EnrichmentCandidateDecision {
  const current = parseForGate(currentContent, "current task spec");
  const candidate = parseForGate(candidateContent, "candidate task spec");
  const blockers: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  if (!current.task) blockers.push("current_schema_invalid");
  if (!candidate.task) blockers.push("candidate_schema_invalid");

  if (current.task && candidate.task) {
    if (candidate.task.id !== current.task.id) blockers.push("task_id_mismatch");
    if (candidate.task.priority !== current.task.priority) blockers.push("priority_changed");
    if (candidate.task.status !== current.task.status) blockers.push("status_regression");
    if (normalizeText(candidate.task.title) !== normalizeText(current.task.title)) {
      blockers.push("scope_title_changed");
    }

    pushMissingBlockers(
      blockers,
      "deleted_success_criterion",
      missingValues(current.task.successCriteria, candidate.task.successCriteria),
    );
    pushMissingBlockers(
      blockers,
      "deleted_testing_requirement",
      missingValues(current.task.testingRequirements, candidate.task.testingRequirements),
    );
    pushMissingBlockers(
      blockers,
      "deleted_file_reference",
      missingPaths(current.task, candidate.task),
    );
    pushMissingBlockers(
      blockers,
      "deleted_blocker",
      missingValues(current.task.blockedBy, candidate.task.blockedBy),
    );
    pushMissingBlockers(
      blockers,
      "deleted_blocks_relationship",
      missingValues(current.task.blocks, candidate.task.blocks),
    );
    pushMissingBlockers(
      blockers,
      "deleted_risk_tag",
      missingValues(riskTags(current.task), candidate.task.tags),
    );

    if (candidate.task.successCriteria.length > current.task.successCriteria.length) {
      reasons.push("adds_success_criteria");
    }
    if (candidate.task.testingRequirements.length > current.task.testingRequirements.length) {
      reasons.push("adds_testing_requirements");
    }
    if (candidate.task.filesToModify.length > current.task.filesToModify.length) {
      reasons.push("adds_file_level_integration_points");
    }
    if (
      countWords(candidate.task.recommendedApproach) > countWords(current.task.recommendedApproach)
    ) {
      reasons.push("expands_recommended_approach");
    }
    if (countWords(candidate.task.currentState) > countWords(current.task.currentState)) {
      reasons.push("expands_current_state");
    }

    const delta = candidate.summary.materialScore - current.summary.materialScore;
    if (delta <= 0) {
      blockers.push("not_materially_better");
    } else if (delta < 3) {
      warnings.push("small_material_delta");
    }
  }

  const score = {
    current: current.summary.materialScore,
    candidate: candidate.summary.materialScore,
    delta: candidate.summary.materialScore - current.summary.materialScore,
  };

  return {
    accepted: blockers.length === 0 && score.delta > 0,
    reasons,
    blockers,
    warnings,
    score,
    current: current.summary,
    candidate: candidate.summary,
  };
}
