// ─── Subtask Quality Gate ───────────────────────────────────────────
// Parses child draft markdown and runs a prep-score check before finalize.
// This gate must pass for every child draft before finalize is allowed.

import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type { QualityGateResult } from "./decompose-types.js";

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
    parseTaskFile(markdown);
  } catch (err) {
    parseError = err instanceof TaskParseError ? err.message : String(err);
    deficiencies.push(`Parse failure: ${parseError}`);
    // Continue checking sections even if parse fails partially
  }

  // Step 2: check required H2 sections
  for (const section of REQUIRED_SECTIONS) {
    const hasSection = new RegExp(`^## ${section}`, "im").test(markdown);
    if (hasSection) {
      sectionsPresent.push(section);
    } else {
      deficiencies.push(`Missing required section: ## ${section}`);
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
  const prepReady = prepScore >= PREP_THRESHOLD && !parseError;

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
 * Extract the text content of a specific H2 section from markdown.
 */
function extractSection(markdown: string, sectionName: string): string | undefined {
  const regex = new RegExp(`^## ${sectionName}\\s*\\n([\\s\\S]*?)(?=^## |$)`, "im");
  const match = markdown.match(regex);
  return match?.[1]?.trim();
}
