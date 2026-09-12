// ─── Subtask Quality Gate ───────────────────────────────────────────
// Parses child draft markdown and runs a prep-score check before finalize.
// This gate must pass for every child draft before finalize is allowed.

import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type { QualityGateResult, SubtaskDefinition } from "./decompose-types.js";

/** Minimum prep score for a child draft to be considered ready */
export const PREP_THRESHOLD = 4.0;

/** Required H2 sections that every child draft must have */
const REQUIRED_SECTIONS = [
  "Problem Statement",
  "Current State",
  "Recommended Approach",
  "Files to Modify",
  "Success Criteria",
  "Testing Requirements",
  "Anti-Patterns",
  "Context References",
];

/** Banned generic stub patterns — any of these in the draft is a quality failure */
const BANNED_STUB_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /This subtask is part of TASK-\w+ decomposition/i,
    description: "Generic subtask stub: 'This subtask is part of TASK-NNN decomposition'",
  },
  {
    pattern: /At least \d+×2 new tests/i,
    description: "File-count heuristic test requirement: 'At least N×2 new tests'",
  },
  {
    pattern: /Follow the implementation patterns from the parent task['']s blueprint\./i,
    description:
      "Generic approach stub: 'Follow the implementation patterns from the parent task's blueprint.'",
  },
  {
    pattern: /Parent task TASK-\w+ was decomposed into multiple subtasks\./i,
    description: "Generic current state stub: 'Parent task TASK-NNN was decomposed...'",
  },
];

/**
 * Run quality gate checks on a child draft markdown string.
 * Parses the spec and scores it — no LLM calls, deterministic.
 *
 * @param subtaskId - The subtask ID for diagnostic messages
 * @param markdown - Full markdown content of the child draft
 * @returns QualityGateResult with prepScore, prepReady, sectionsPresent, deficiencies
 */
export function runChildQualityGate(subtaskId: string, markdown: string): QualityGateResult {
  const deficiencies: string[] = [];
  const sectionsPresent: string[] = [];
  let parseError: string | undefined;

  // Step 1: parse
  if (!markdown || markdown.trim().length === 0) {
    return {
      subtaskId,
      prepScore: 0,
      prepReady: false,
      sectionsPresent: [],
      deficiencies: ["Draft is empty"],
      parseError: "Empty draft",
    };
  }

  try {
    const parsed = parseTaskFile(markdown);
    if (parsed.id !== subtaskId) {
      parseError = `Draft declares ${parsed.id}; expected ${subtaskId}`;
      deficiencies.push(`Parse failure: ${parseError}`);
    }
  } catch (err) {
    parseError = err instanceof TaskParseError ? err.message : String(err);
    deficiencies.push(`Parse failure: ${parseError}`);
    // Continue checking sections even if parse fails partially
  }

  // Step 2: require exact H2 headings and meaningful section bodies. A
  // heading prefix (for example, "## Current State Notes") is not the
  // required section, and an empty/TBD body does not establish readiness.
  for (const section of REQUIRED_SECTIONS) {
    const sectionBody = extractSection(markdown, section);
    if (sectionBody === undefined) {
      deficiencies.push(`Missing required section: ## ${section}`);
      continue;
    }
    sectionsPresent.push(section);
    const contentDeficiency = validateRequiredSectionBody(section, sectionBody);
    if (contentDeficiency) {
      deficiencies.push(contentDeficiency);
    }
  }

  // Step 3: check for banned stub patterns
  for (const { pattern, description } of BANNED_STUB_PATTERNS) {
    if (pattern.test(markdown)) {
      deficiencies.push(`Generic stub detected: ${description}`);
    }
  }

  // Step 4: check Testing Requirements is not just build/lint checks
  const testingSection = extractSection(markdown, "Testing Requirements");
  if (testingSection) {
    const lines = testingSection.split("\n").filter((l) => l.trim().startsWith("- ["));
    if (lines.length < 2) {
      deficiencies.push("Testing Requirements has fewer than 2 test scenarios");
    }
    const hasOnlyGenericTests = lines.every(
      (l) => /npm run build/i.test(l) || /all tests.*pass/i.test(l) || /npm run lint/i.test(l),
    );
    if (hasOnlyGenericTests && lines.length > 0) {
      deficiencies.push(
        "Testing Requirements contains only generic build/lint checks — add scenario-based tests",
      );
    }
  }

  // Step 5: check Problem Statement is non-trivial
  const problemSection = extractSection(markdown, "Problem Statement");
  if (problemSection && problemSection.trim().split(/\s+/).length < 15) {
    deficiencies.push("Problem Statement is too short (fewer than 15 words)");
  }

  // Step 6: compute prep score (0-5)
  const sectionScore = (sectionsPresent.length / REQUIRED_SECTIONS.length) * 3.0;
  const stubPenalty = deficiencies.filter((d) => d.startsWith("Generic stub")).length * 0.5;
  const testingPenalty = deficiencies.some((d) => d.includes("Testing Requirements")) ? 0.5 : 0;
  const parsePenalty = parseError ? 1.5 : 0;
  const problemPenalty = deficiencies.some((d) => d.includes("Problem Statement")) ? 0.3 : 0;

  const rawScore =
    sectionScore + 2.0 - stubPenalty - testingPenalty - parsePenalty - problemPenalty;
  const prepScore = Math.max(0, Math.min(5, rawScore));
  // A numeric score is diagnostic, not authorization. Any deterministic
  // deficiency (missing section, generic stub, weak scenarios, etc.) blocks
  // finalization even when the weighted score remains above the threshold.
  const prepReady = prepScore >= PREP_THRESHOLD && !parseError && deficiencies.length === 0;

  return {
    subtaskId,
    prepScore: Math.round(prepScore * 10) / 10,
    prepReady,
    sectionsPresent,
    deficiencies,
    parseError,
  };
}

/**
 * Verify that a well-formed child draft still describes the topology node it
 * was materialized for. Section completeness alone cannot catch a provider
 * swapping file ownership, omitting criteria, or changing dependencies.
 */
export function validateChildDraftScope(subtask: SubtaskDefinition, markdown: string): string[] {
  let parsed;
  try {
    parsed = parseTaskFile(markdown);
  } catch (err) {
    return [`Draft scope could not be parsed: ${err instanceof Error ? err.message : String(err)}`];
  }

  const deficiencies: string[] = [];
  if (parsed.id !== subtask.id) {
    deficiencies.push(`Draft declares ${parsed.id}; expected ${subtask.id}`);
  }
  if (parsed.title !== subtask.title) {
    deficiencies.push(`Draft title mismatch: expected ${subtask.title}, got ${parsed.title}`);
  }
  if (parsed.status !== "READY") {
    deficiencies.push(`Draft status must be READY; got ${parsed.status}`);
  }

  const expectedFiles = new Map(subtask.filesToModify.map((file) => [file.path, file.action]));
  const actualFiles = new Map(parsed.filesToModify.map((file) => [file.path, file.action]));
  const expectedPathCounts = countValues(subtask.filesToModify.map((file) => file.path));
  const actualPathCounts = countValues(parsed.filesToModify.map((file) => file.path));
  const duplicateExpectedPaths = [...expectedPathCounts]
    .filter(([, count]) => count > 1)
    .map(([filePath]) => filePath);
  const duplicateActualPaths = [...actualPathCounts]
    .filter(([, count]) => count > 1)
    .map(([filePath]) => filePath);
  if (duplicateExpectedPaths.length > 0) {
    deficiencies.push(
      `Topology contains duplicate owned file paths: ${duplicateExpectedPaths.join(", ")}`,
    );
  }
  if (duplicateActualPaths.length > 0) {
    deficiencies.push(`Duplicate owned file rows: ${duplicateActualPaths.join(", ")}`);
  }
  const missingFiles = [...expectedFiles.keys()].filter((filePath) => !actualFiles.has(filePath));
  const unexpectedFiles = [...actualFiles.keys()].filter(
    (filePath) => !expectedFiles.has(filePath),
  );
  if (missingFiles.length > 0) {
    deficiencies.push(`Missing owned files: ${missingFiles.join(", ")}`);
  }
  if (unexpectedFiles.length > 0) {
    deficiencies.push(`Unexpected owned files: ${unexpectedFiles.join(", ")}`);
  }
  for (const file of parsed.filesToModify) {
    const expectedAction = expectedFiles.get(file.path);
    if (expectedAction && file.action !== expectedAction) {
      deficiencies.push(
        `Action mismatch for ${file.path}: expected ${expectedAction}, got ${file.action}`,
      );
    }
  }

  const expectedFileRows = countValues(
    subtask.filesToModify.map((file) => `${file.path}\u0000${file.action}`),
  );
  const actualFileRows = countValues(
    parsed.filesToModify.map((file) => `${file.path}\u0000${file.action}`),
  );
  const missingFileRows = expandCountDifference(expectedFileRows, actualFileRows);
  const unexpectedFileRows = expandCountDifference(actualFileRows, expectedFileRows);
  if (missingFileRows.length > 0) {
    deficiencies.push(
      `Missing exact file rows: ${missingFileRows.map(describeFileRow).join(", ")}`,
    );
  }
  if (unexpectedFileRows.length > 0) {
    deficiencies.push(
      `Unexpected exact file rows: ${unexpectedFileRows.map(describeFileRow).join(", ")}`,
    );
  }

  const expectedCriterionCounts = countValues(subtask.successCriteria);
  const actualCriterionCounts = countValues(parsed.successCriteria);
  const missingCriteria = expandCountDifference(expectedCriterionCounts, actualCriterionCounts);
  const unexpectedCriteria = expandCountDifference(actualCriterionCounts, expectedCriterionCounts);
  if (missingCriteria.length > 0) {
    deficiencies.push(`Missing assigned criteria: ${missingCriteria.join("; ")}`);
  }
  if (unexpectedCriteria.length > 0) {
    deficiencies.push(`Unexpected assigned criteria: ${unexpectedCriteria.join("; ")}`);
  }

  const expectedDependencies = [...subtask.dependsOn].sort();
  const actualDependencies = [...parsed.blockedBy].sort();
  const duplicateExpectedDependencies = repeatedValues(expectedDependencies);
  const duplicateActualDependencies = repeatedValues(actualDependencies);
  if (duplicateExpectedDependencies.length > 0) {
    deficiencies.push(
      `Topology contains duplicate dependencies: ${duplicateExpectedDependencies.join(", ")}`,
    );
  }
  if (duplicateActualDependencies.length > 0) {
    deficiencies.push(`Duplicate Blocked By entries: ${duplicateActualDependencies.join(", ")}`);
  }
  if (
    expectedDependencies.length !== actualDependencies.length ||
    expectedDependencies.some((dependency, index) => dependency !== actualDependencies[index])
  ) {
    deficiencies.push(
      `Blocked By mismatch: expected [${expectedDependencies.join(", ")}], got [${actualDependencies.join(", ")}]`,
    );
  }

  return deficiencies;
}

function repeatedValues(values: readonly string[]): string[] {
  return [...countValues(values)].filter(([, count]) => count > 1).map(([value]) => value);
}

function describeFileRow(row: string): string {
  const [filePath, action] = row.split("\u0000");
  return `${filePath} (${action})`;
}

function isPlaceholderText(value: string): boolean {
  const normalized = value
    .replace(/^[-*]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/[`_*|#]/g, "")
    .trim();
  return /^(?:tbd|todo|n\/?a|none|placeholder|to be determined|not applicable)(?:\b.*)?[.!]?$/i.test(
    normalized,
  );
}

function listEntries(sectionBody: string, checkbox: boolean): string[] {
  const pattern = checkbox ? /^\s*-\s*\[[ xX]\]\s+(.+)$/ : /^\s*-\s+(.+)$/;
  return sectionBody
    .split(/\r?\n/)
    .map((line) => pattern.exec(line)?.[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function validateRequiredSectionBody(section: string, sectionBody: string): string | null {
  if (sectionBody.trim().length === 0) {
    return `Required section ## ${section} is empty`;
  }

  if (section === "Files to Modify") {
    const dataRows = sectionBody.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || /^\|[\s:-]+\|/.test(trimmed)) return false;
      const cells = trimmed
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      return (
        cells.length >= 2 &&
        cells[0].toLowerCase() !== "file" &&
        !isPlaceholderText(cells[0]) &&
        !isPlaceholderText(cells[1])
      );
    });
    return dataRows.length > 0
      ? null
      : "Required section ## Files to Modify has no substantive file rows";
  }

  if (section === "Success Criteria" || section === "Testing Requirements") {
    const entries = listEntries(sectionBody, true);
    return entries.length > 0 && entries.every((entry) => !isPlaceholderText(entry))
      ? null
      : `Required section ## ${section} has no substantive checklist entries`;
  }

  if (section === "Anti-Patterns" || section === "Context References") {
    const entries = listEntries(sectionBody, false);
    return entries.length > 0 && entries.every((entry) => !isPlaceholderText(entry))
      ? null
      : `Required section ## ${section} has no substantive list entries`;
  }

  if (isPlaceholderText(sectionBody)) {
    return `Required section ## ${section} contains placeholder content`;
  }
  const wordCount = sectionBody.trim().split(/\s+/).filter(Boolean).length;
  const minimumWords = section === "Problem Statement" ? 15 : section === "Current State" ? 3 : 5;
  return wordCount >= minimumWords
    ? null
    : `Required section ## ${section} is too short (${wordCount}/${minimumWords} words)`;
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function expandCountDifference(
  actual: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
): string[] {
  const difference: string[] = [];
  for (const [value, count] of actual) {
    const extra = count - (expected.get(value) ?? 0);
    for (let index = 0; index < extra; index += 1) difference.push(value);
  }
  return difference;
}

/**
 * Extract the text content of a specific H2 section from markdown.
 */
function extractSection(markdown: string, sectionName: string): string | undefined {
  const heading = new RegExp(`^## ${sectionName}\\s*$`, "im").exec(markdown);
  if (!heading) return undefined;
  const sectionStart = heading.index + heading[0].length;
  const remainder = markdown.slice(sectionStart).replace(/^\r?\n/, "");
  const nextHeading = /^## /m.exec(remainder);
  return (nextHeading ? remainder.slice(0, nextHeading.index) : remainder).trim();
}
