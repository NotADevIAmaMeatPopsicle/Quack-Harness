// ─── Blueprint Prompt Builder ───────────────────────────────────────
// Builds prompts for the Blueprint Agent and formats blueprint output.

import type { ParsedTask } from "../core/types.js";
import type { Blueprint } from "./blueprint-types.js";

/**
 * Builds the prompt that instructs the Blueprint Agent to analyze the codebase
 * and produce a structured Blueprint JSON object with implementation details.
 *
 * The Blueprint Agent is a read-only agent that runs BEFORE the coding agent.
 * It reads the source files and produces code-level integration detail so the
 * coding agent doesn't waste turns exploring.
 *
 * @param task - The parsed task specification
 * @param conventionsDoc - The project conventions document
 * @returns The prompt string for the Blueprint Agent
 */
export function buildBlueprintPrompt(task: ParsedTask, conventionsDoc: string): string {
  const sections: string[] = [];

  sections.push(`# Blueprint Agent — Pre-Dispatch Implementation Planner

You are a read-only Blueprint Agent. Your job is to analyze the codebase and produce
a detailed implementation blueprint for the coding agent that will execute this task.

## Your Role

You run BEFORE the coding agent dispatches. The coding agent receives your blueprint
as part of its context, so it doesn't waste 15-30 turns exploring the codebase.
Instead, it can immediately start implementing based on your code-level guidance.

## Your Task

Analyze the codebase and produce a Blueprint JSON object with these fields:
- **fileAnalyses**: For each file in filesToModify, analyze its current structure,
  integration points (where new code connects to existing code), and existing
  patterns to follow (with file:line references).
- **codeExamples**: Before/after code snippets showing HOW to implement key changes.
  Include at least one example per file being modified. Show the exact integration.
- **verificationPatterns**: Deterministic checks (grep patterns, file existence checks)
  for each success criterion. These will be run before the LLM judge.
- **antiPatterns**: Explicit "do NOT" instructions based on common agent failure modes
  (stubbing, partial wiring, placeholder comments, shell implementations).
- **preconditions**: Things that must be true before starting (e.g., "existing tests
  must continue to pass", "adapter config has fleetBudget section").

## Available Tools

You have READ-ONLY access to the codebase:
- **Read**: Read file contents
- **Glob**: Find files by pattern
- **Grep**: Search for patterns in files

You CANNOT modify anything (no Edit, Write, or Bash).

## Output Format

You MUST output a valid JSON object matching the Blueprint interface. Do NOT include
any prose before or after the JSON. The JSON will be parsed programmatically.

Blueprint interface:
{
  "taskId": string,
  "fileAnalyses": [
    {
      "filePath": string,
      "action": "Create" | "Modify" | "Delete",
      "currentStructure": string,  // Key exports, classes, functions with line numbers
      "integrationPoints": string, // Where new code connects to existing code
      "patternToFollow": string    // Existing code pattern to mimic (file:line reference)
    }
  ],
  "codeExamples": [
    {
      "file": string,
      "description": string,
      "before": string,  // Current code snippet or "[new file]"
      "after": string    // Expected code snippet after changes
    }
  ],
  "verificationPatterns": [
    {
      "criterion": string,       // Success criterion text
      "checkType": "grep" | "grep_count" | "file_exists" | "file_not_exists",
      "pattern": string,         // Regex pattern or file path
      "fileGlob": string,        // Target file(s)
      "expectedMatches"?: number // Minimum match count (for grep_count only)
    }
  ],
  "antiPatterns": [string],   // "do NOT" instructions
  "preconditions": [string],  // Things that must be true before starting

  // ── Brief fields — ALL OPTIONAL. Omit or leave empty when there is
  // nothing real to report; do NOT pad these to look thorough. ──
  "baseValidation"?: {
    "observations": [string]  // What re-validating the spec against the CURRENT tree revealed:
                              // stale file:line anchors, moved/renamed files, spec claims the
                              // code contradicts. Empty when the spec matches the tree.
                              // (branch/sha/timestamp are stamped by the system — omit them.)
  },
  "handBack"?: [              // Adjacent issues you noticed OUTSIDE this task's scope.
    {                         // These are surfaced FOR THE OPERATOR — they are NOT part of
      "summary": string,      // this task and the coding agent will be told not to act on them.
      "detail"?: string,
      "anchors"?: [string]    // file or file:line citations
    }
  ],
  "constraints"?: [string],       // ADR/convention constraints this implementation must honor
  "testsToRebaseline"?: [string],  // Test files/suites whose current results should be captured before building

  // ── Directive surface (TASK-1324) — REQUIRED WHEN APPLICABLE. A
  // deterministic auditor verifies every entry against the real tree
  // (file exists, symbol is exported) BEFORE this brief can reach a
  // human gate. If your prose tells the builder to import or call
  // something, it MUST also appear here — an unexported or nonexistent
  // directive FAILS the whole brief. ──
  "importsToUse"?: [          // Every existing symbol the builder should import/call.
    {
      "symbol": string,       // The exported symbol name, exactly as declared
      "fromFile": string,     // Repo-relative file that EXPORTS it (verify with Read/Grep first)
      "kind"?: "value" | "type" // "type" ONLY for type-only imports (export type / interface).
                              // Omit for runtime symbols — a type-only export directed as a
                              // runtime symbol FAILS the audit.
    }
  ],
  "entryPoints"?: [           // Existing entry points the change wires into
    { "symbol": string, "file": string }
  ],
  "specFacts"?: [string]      // ONLY when the spec has a "## Decided Facts" section:
                              // restate each decided fact you honored, verbatim or near-verbatim.
                              // Contradicting a decided fact is a review-blocking defect.
}

## Instructions

1. Read the task spec below (especially filesToModify and success criteria)
2. **Validate file paths**: For each file in filesToModify, verify the path exists in the repo (for "Modify" actions) or that the parent directory is correct (for "Create" actions). If a path appears wrong (e.g., spec says \`src/types/foo.ts\` but the project uses \`frontends/app/src/types/foo.ts\`), use the CORRECTED path in your blueprint's fileAnalyses.filePath. Add a precondition noting the correction.
3. For each file in filesToModify where action is "Modify", use Read to load the current file
4. Analyze the current structure (exports, classes, functions) and identify integration points
5. Find existing patterns in the same file or sibling files that show HOW to implement similar functionality
6. Generate before/after code examples for key integration points
7. Generate verification patterns for each success criterion (prefer grep over file_exists)
8. List anti-patterns based on common failure modes (stubbing, incomplete wiring, placeholders)
9. **Emit your directives**: every existing symbol your plan tells the builder to import,
   call, or wire into MUST appear in importsToUse/entryPoints with the file that exports it.
   VERIFY the export exists (Read or Grep the file) before writing the directive — a
   deterministic auditor rejects the entire brief on an unexported or nonexistent directive.
   Never direct the builder at a symbol you have not confirmed is exported.
10. Output the Blueprint JSON object

---`);

  // Task specification
  sections.push(`## Task Specification

${task.rawContent}`);

  // TASK-1324 Tier S: the spec's decided facts as an explicit constraint
  // block. Sixteen live review rounds showed the synthesizer contradicting
  // decided facts buried in spec prose; restating them as first-class
  // constraints lowers the contradiction base rate at the source, and the
  // specFacts echo gives the gate a diffable fidelity surface.
  if (task.decidedFacts && task.decidedFacts.length > 0) {
    sections.push(`## DECIDED FACTS — BINDING CONSTRAINTS

The spec above contains a "Decided Facts" section. These are SETTLED
decisions; your blueprint must never direct the builder to contradict
one. Restate each fact you honored in the "specFacts" output field.

${task.decidedFacts.map((fact) => `- ${fact}`).join("\n")}`);
  }

  // Files to modify (explicitly list them for clarity)
  if (task.filesToModify.length > 0) {
    sections.push(`## Files to Modify

${task.filesToModify.map((f) => `- **${f.path}** (${f.action}): ${f.notes}`).join("\n")}`);
  }

  // Success criteria (explicitly list them)
  if (task.successCriteria.length > 0) {
    sections.push(`## Success Criteria

${task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }

  // Project conventions (so the blueprint aligns with project patterns)
  if (conventionsDoc.trim().length > 0) {
    sections.push(`## Project Conventions

${conventionsDoc}`);
  }

  // Contract sources directive for frontend tasks
  const hasFrontendFiles = task.filesToModify.some(
    (f) =>
      f.path.includes("frontends/") ||
      f.path.includes("frontend/") ||
      (/\.[jt]sx$/.test(f.path) && !f.path.includes("test")),
  );

  if (hasFrontendFiles) {
    sections.push(`## Contract Sources Directive

This task modifies FRONTEND files. The blueprint MUST include a "Contract Sources" subsection
in each relevant fileAnalysis.integrationPoints that lists the exact backend files the coding
agent must read BEFORE implementing frontend types:

For each frontend type/enum/API call, identify:
- **Model file** (for enum values): e.g., \`src/src/models/moderation-flag.model.js\` line 28
- **DTO file** (for field name transformations): e.g., \`src/src/dto/moderation-flag.dto.js\`
- **Route file** (for HTTP methods and endpoint paths): e.g., \`src/src/routes/admin-moderation.js\`

Include these as concrete file:line references in the fileAnalysis.integrationPoints field.
The coding agent will use these to ensure frontend types exactly match backend contracts.

CRITICAL: If a model defines enum values like ['content', 'behavior', 'billing'],
the blueprint code examples MUST use those exact values — never invented alternatives.`);
  }

  sections.push(`---

Now analyze the codebase and output the Blueprint JSON object. Remember:
- Read EVERY file in filesToModify where action is "Modify"
- Include at least one code example per modified file
- Generate verification patterns for EVERY success criterion
- Be specific: include file:line references, exact function names, exact patterns
- Output ONLY the JSON object, no prose before or after`);

  return sections.join("\n\n");
}

// ─── Blueprint Size Caps ─────────────────────────────────────────────

/** Maximum lines per before/after snippet in a code example */
const MAX_SNIPPET_LINES = 50;

/** Maximum number of code examples to include */
const MAX_CODE_EXAMPLES = 8;

/** Maximum number of anti-patterns to include */
const MAX_ANTI_PATTERNS = 15;

/** Maximum number of verification patterns to include */
const MAX_VERIFICATION_PATTERNS = 20;

/** Maximum total blueprint size in characters (~8K tokens × 4 chars/token) */
const MAX_BLUEPRINT_CHARS = 32_000;

/** Maximum hand-back items rendered (operator info, not work orders) */
const MAX_HAND_BACK_ITEMS = 8;

/**
 * Render the TASK-1306 brief sections (base validation, constraints, tests to
 * re-baseline, hand-back). Shared by both formatter paths so the truncation
 * rebuild cannot drift. Returns [] when no brief fields are present — legacy
 * blueprints render byte-identically.
 */
function renderBriefSections(blueprint: Blueprint): string[] {
  const sections: string[] = [];

  if (blueprint.baseValidation) {
    const bv = blueprint.baseValidation;
    sections.push(`### Base Validation`);
    const provenance =
      bv.baseBranch.length > 0 || bv.baseSha.length > 0
        ? `Generated against \`${bv.baseBranch || "?"}@${bv.baseSha ? bv.baseSha.slice(0, 12) : "?"}\`${bv.validatedAt ? ` at ${bv.validatedAt}` : ""}.`
        : `Generation-tree provenance unavailable.`;
    sections.push(provenance);
    if (bv.observations.length > 0) {
      sections.push(bv.observations.map((o) => `- ${o}`).join("\n"));
    }
  }

  if (blueprint.constraints && blueprint.constraints.length > 0) {
    sections.push(`### Constraints`);
    sections.push(blueprint.constraints.map((c) => `- ${c}`).join("\n"));
  }

  // TASK-1324: the directive surface and fidelity verdict render in the
  // brief artifact so builders and reviewers see the SAME audited plan.
  if (blueprint.importsToUse && blueprint.importsToUse.length > 0) {
    sections.push(`### Imports to Use (mechanically audited)`);
    sections.push(
      blueprint.importsToUse.map((d) => `- \`${d.symbol}\` from \`${d.fromFile}\``).join("\n"),
    );
  }
  if (blueprint.entryPoints && blueprint.entryPoints.length > 0) {
    sections.push(`### Entry Points (mechanically audited)`);
    sections.push(
      blueprint.entryPoints.map((d) => `- \`${d.symbol}\` in \`${d.file}\``).join("\n"),
    );
  }
  if (blueprint.specFacts && blueprint.specFacts.length > 0) {
    sections.push(`### Decided Facts Honored (echoed from the spec)`);
    sections.push(blueprint.specFacts.map((f) => `- ${f}`).join("\n"));
  }
  if (blueprint.fidelity) {
    sections.push(`### Fidelity Audit`);
    if (blueprint.fidelity.status === "ok") {
      sections.push(`Deterministic audit PASSED (${blueprint.fidelity.checkedAt}).`);
    } else {
      sections.push(
        [
          `Deterministic audit **FAILED** (${blueprint.fidelity.checkedAt}) — this brief is not auto-approvable:`,
          ...blueprint.fidelity.violations.map((v) => `- [${v.kind}] ${v.detail}`),
        ].join("\n"),
      );
    }
  }

  if (blueprint.testsToRebaseline && blueprint.testsToRebaseline.length > 0) {
    sections.push(`### Tests to Re-Baseline`);
    sections.push(blueprint.testsToRebaseline.map((t) => `- ${t}`).join("\n"));
  }

  if (blueprint.handBack && blueprint.handBack.length > 0) {
    sections.push(`### Hand-Back (surfaced for the operator — OUT OF SCOPE for this task)`);
    sections.push(
      `The following adjacent issues were noticed during investigation. Do NOT implement, fix, or expand scope to address them — they are recorded for the operator only.`,
    );
    const shown = Math.min(blueprint.handBack.length, MAX_HAND_BACK_ITEMS);
    const lines: string[] = [];
    for (let i = 0; i < shown; i++) {
      const item = blueprint.handBack[i];
      const anchors = item.anchors?.length ? ` (${item.anchors.join(", ")})` : "";
      lines.push(`- ${item.summary}${anchors}`);
    }
    sections.push(lines.join("\n"));
    if (blueprint.handBack.length > MAX_HAND_BACK_ITEMS) {
      const skipped = blueprint.handBack.length - MAX_HAND_BACK_ITEMS;
      sections.push(
        `*[${shown} of ${blueprint.handBack.length} hand-back items shown — ${skipped} omitted]*`,
      );
    }
  }

  return sections;
}

/**
 * Truncate a code snippet to a maximum number of lines, appending a note
 * if lines were removed.
 */
function truncateSnippet(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  const removed = lines.length - maxLines;
  return `${kept}\n[truncated — ${removed} more lines]`;
}

/**
 * Formats a Blueprint object into a human-readable markdown string for
 * inclusion in the coding agent's prompt.
 *
 * Applies size caps to prevent the blueprint from consuming too much context:
 * - Code example before/after snippets: 50 lines each
 * - Total code examples: 8
 * - Anti-patterns: 15
 * - Verification patterns: 20
 * - Total blueprint size: ~8K tokens (~32K chars)
 *
 * @param blueprint - The Blueprint object to format
 * @returns A formatted markdown string
 */
export function formatBlueprintForPrompt(blueprint: Blueprint): string {
  const sections: string[] = [];

  sections.push(`## Implementation Blueprint`);

  // File analyses
  if (blueprint.fileAnalyses.length > 0) {
    sections.push(`### File Analyses`);
    for (const analysis of blueprint.fileAnalyses) {
      sections.push(`#### ${analysis.filePath} (${analysis.action})`);
      if ((analysis.currentStructure ?? "").trim().length > 0) {
        sections.push(`**Current Structure:** ${analysis.currentStructure}`);
      }
      if ((analysis.integrationPoints ?? "").trim().length > 0) {
        sections.push(`**Integration Points:** ${analysis.integrationPoints}`);
      }
      if ((analysis.patternToFollow ?? "").trim().length > 0) {
        sections.push(`**Pattern to Follow:** ${analysis.patternToFollow}`);
      }
    }
  }

  // Code examples (capped at MAX_CODE_EXAMPLES, snippets capped at MAX_SNIPPET_LINES)
  if (blueprint.codeExamples.length > 0) {
    sections.push(`### Code Examples`);
    const examplesShown = Math.min(blueprint.codeExamples.length, MAX_CODE_EXAMPLES);
    for (let i = 0; i < examplesShown; i++) {
      const example = blueprint.codeExamples[i];
      const before = truncateSnippet(example.before, MAX_SNIPPET_LINES);
      const after = truncateSnippet(example.after, MAX_SNIPPET_LINES);
      sections.push(`#### ${example.file} — ${example.description}`);
      sections.push("```typescript");
      sections.push(`// BEFORE:\n${before}`);
      sections.push("");
      sections.push(`// AFTER:\n${after}`);
      sections.push("```");
    }
    if (blueprint.codeExamples.length > MAX_CODE_EXAMPLES) {
      const skipped = blueprint.codeExamples.length - MAX_CODE_EXAMPLES;
      sections.push(
        `*[${examplesShown} of ${blueprint.codeExamples.length} examples shown — ${skipped} omitted]*`,
      );
    }
  }

  // Verification patterns (capped at MAX_VERIFICATION_PATTERNS)
  if (blueprint.verificationPatterns.length > 0) {
    sections.push(`### Verification Patterns`);
    sections.push(`| Criterion | Check | Pattern | File | Expected |`);
    sections.push(`|-----------|-------|---------|------|----------|`);
    const patternsShown = Math.min(
      blueprint.verificationPatterns.length,
      MAX_VERIFICATION_PATTERNS,
    );
    for (let i = 0; i < patternsShown; i++) {
      const pattern = blueprint.verificationPatterns[i];
      const expected = pattern.expectedMatches !== undefined ? `${pattern.expectedMatches}+` : "-";
      sections.push(
        `| ${pattern.criterion.slice(0, 50)} | ${pattern.checkType} | \`${pattern.pattern}\` | ${pattern.fileGlob} | ${expected} |`,
      );
    }
    if (blueprint.verificationPatterns.length > MAX_VERIFICATION_PATTERNS) {
      const skipped = blueprint.verificationPatterns.length - MAX_VERIFICATION_PATTERNS;
      sections.push(
        `*[${patternsShown} of ${blueprint.verificationPatterns.length} patterns shown — ${skipped} omitted]*`,
      );
    }
  }

  // Anti-patterns (capped at MAX_ANTI_PATTERNS)
  if (blueprint.antiPatterns.length > 0) {
    sections.push(`### Anti-Patterns`);
    const shownCount = Math.min(blueprint.antiPatterns.length, MAX_ANTI_PATTERNS);
    for (let i = 0; i < shownCount; i++) {
      sections.push(`- ${blueprint.antiPatterns[i]}`);
    }
    if (blueprint.antiPatterns.length > MAX_ANTI_PATTERNS) {
      const skipped = blueprint.antiPatterns.length - MAX_ANTI_PATTERNS;
      sections.push(
        `*[${shownCount} of ${blueprint.antiPatterns.length} anti-patterns shown — ${skipped} omitted]*`,
      );
    }
  }

  // Preconditions (no cap — typically very few)
  if (blueprint.preconditions.length > 0) {
    sections.push(`### Preconditions`);
    for (const precondition of blueprint.preconditions) {
      sections.push(`- ${precondition}`);
    }
  }

  // Brief sections (TASK-1306) — empty for legacy blueprints
  sections.push(...renderBriefSections(blueprint));

  let result = sections.join("\n\n");

  // Total size cap: if the formatted blueprint exceeds ~8K tokens, truncate
  if (result.length > MAX_BLUEPRINT_CHARS) {
    result = truncateBlueprintToFit(blueprint);
  }

  return result;
}

/**
 * Rebuild the blueprint with progressively more aggressive truncation
 * to fit within the character budget. Strategy:
 * 1. Remove code examples beyond the first 4
 * 2. If still over, remove file analyses beyond the first 5
 */
function truncateBlueprintToFit(blueprint: Blueprint): string {
  // Step 1: Reduce code examples to 4
  const reducedExamples = Math.min(blueprint.codeExamples.length, 4);
  const reducedBlueprint: Blueprint = {
    ...blueprint,
    codeExamples: blueprint.codeExamples.slice(0, reducedExamples),
  };

  // Re-format with reduced examples
  let result = formatBlueprintWithCaps(
    reducedBlueprint,
    reducedExamples,
    blueprint.codeExamples.length,
  );
  if (result.length <= MAX_BLUEPRINT_CHARS) {
    return result;
  }

  // Step 2: Also reduce file analyses to 5
  const reducedAnalyses = Math.min(blueprint.fileAnalyses.length, 5);
  const furtherReduced: Blueprint = {
    ...reducedBlueprint,
    fileAnalyses: blueprint.fileAnalyses.slice(0, reducedAnalyses),
  };

  result = formatBlueprintWithCaps(
    furtherReduced,
    reducedExamples,
    blueprint.codeExamples.length,
    reducedAnalyses,
    blueprint.fileAnalyses.length,
  );

  // Hard truncate as last resort
  if (result.length > MAX_BLUEPRINT_CHARS) {
    result =
      result.slice(0, MAX_BLUEPRINT_CHARS) +
      `\n\n*[blueprint truncated — exceeded ~8K token budget]*`;
  }

  return result;
}

/**
 * Format a blueprint with explicit example/analysis counts for truncation notes.
 */
function formatBlueprintWithCaps(
  blueprint: Blueprint,
  examplesShown: number,
  totalExamples: number,
  analysesShown?: number,
  totalAnalyses?: number,
): string {
  const sections: string[] = [];

  sections.push(`## Implementation Blueprint`);

  // File analyses (possibly reduced)
  if (blueprint.fileAnalyses.length > 0) {
    sections.push(`### File Analyses`);
    for (const analysis of blueprint.fileAnalyses) {
      sections.push(`#### ${analysis.filePath} (${analysis.action})`);
      if ((analysis.currentStructure ?? "").trim().length > 0) {
        sections.push(`**Current Structure:** ${analysis.currentStructure}`);
      }
      if ((analysis.integrationPoints ?? "").trim().length > 0) {
        sections.push(`**Integration Points:** ${analysis.integrationPoints}`);
      }
      if ((analysis.patternToFollow ?? "").trim().length > 0) {
        sections.push(`**Pattern to Follow:** ${analysis.patternToFollow}`);
      }
    }
    if (
      analysesShown !== undefined &&
      totalAnalyses !== undefined &&
      totalAnalyses > analysesShown
    ) {
      const skipped = totalAnalyses - analysesShown;
      sections.push(
        `*[${analysesShown} of ${totalAnalyses} file analyses shown — ${skipped} omitted for size]*`,
      );
    }
  }

  // Code examples (reduced)
  if (blueprint.codeExamples.length > 0) {
    sections.push(`### Code Examples`);
    for (const example of blueprint.codeExamples) {
      const before = truncateSnippet(example.before, MAX_SNIPPET_LINES);
      const after = truncateSnippet(example.after, MAX_SNIPPET_LINES);
      sections.push(`#### ${example.file} — ${example.description}`);
      sections.push("```typescript");
      sections.push(`// BEFORE:\n${before}`);
      sections.push("");
      sections.push(`// AFTER:\n${after}`);
      sections.push("```");
    }
    if (totalExamples > examplesShown) {
      const skipped = totalExamples - examplesShown;
      sections.push(
        `*[${examplesShown} of ${totalExamples} examples shown — ${skipped} omitted for size]*`,
      );
    }
  }

  // Verification patterns
  if (blueprint.verificationPatterns.length > 0) {
    sections.push(`### Verification Patterns`);
    sections.push(`| Criterion | Check | Pattern | File | Expected |`);
    sections.push(`|-----------|-------|---------|------|----------|`);
    const patternsShown = Math.min(
      blueprint.verificationPatterns.length,
      MAX_VERIFICATION_PATTERNS,
    );
    for (let i = 0; i < patternsShown; i++) {
      const pattern = blueprint.verificationPatterns[i];
      const expected = pattern.expectedMatches !== undefined ? `${pattern.expectedMatches}+` : "-";
      sections.push(
        `| ${pattern.criterion.slice(0, 50)} | ${pattern.checkType} | \`${pattern.pattern}\` | ${pattern.fileGlob} | ${expected} |`,
      );
    }
    if (blueprint.verificationPatterns.length > MAX_VERIFICATION_PATTERNS) {
      const skipped = blueprint.verificationPatterns.length - MAX_VERIFICATION_PATTERNS;
      sections.push(
        `*[${patternsShown} of ${blueprint.verificationPatterns.length} patterns shown — ${skipped} omitted]*`,
      );
    }
  }

  // Anti-patterns
  if (blueprint.antiPatterns.length > 0) {
    sections.push(`### Anti-Patterns`);
    const shownCount = Math.min(blueprint.antiPatterns.length, MAX_ANTI_PATTERNS);
    for (let i = 0; i < shownCount; i++) {
      sections.push(`- ${blueprint.antiPatterns[i]}`);
    }
    if (blueprint.antiPatterns.length > MAX_ANTI_PATTERNS) {
      const skipped = blueprint.antiPatterns.length - MAX_ANTI_PATTERNS;
      sections.push(
        `*[${shownCount} of ${blueprint.antiPatterns.length} anti-patterns shown — ${skipped} omitted]*`,
      );
    }
  }

  // Preconditions
  if (blueprint.preconditions.length > 0) {
    sections.push(`### Preconditions`);
    for (const precondition of blueprint.preconditions) {
      sections.push(`- ${precondition}`);
    }
  }

  // Brief sections (TASK-1306) — shared renderer, no drift with the main path
  sections.push(...renderBriefSections(blueprint));

  return sections.join("\n\n");
}
