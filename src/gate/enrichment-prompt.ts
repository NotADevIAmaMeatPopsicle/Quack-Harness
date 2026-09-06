import type { ParsedTask } from "../core/types.js";
import type { PatternExtractionResult } from "./pattern-extractor.js";
import { formatPatternsForPrompt } from "./pattern-extractor.js";

// ─── ADR relevance mapping ──────────────────────────────────────────

/** Maps task tags/keywords to ADR names for relevance filtering */
const ADR_TAG_MAP: Record<string, string[]> = {
  repository: ["ADR-013", "ADR-006"],
  controller: ["ADR-012", "ADR-014"],
  service: ["ADR-012", "ADR-014"],
  route: ["ADR-012"],
  api: ["ADR-001", "ADR-002", "ADR-004", "ADR-007", "ADR-008"],
  backend: ["ADR-001", "ADR-002", "ADR-012"],
  frontend: ["ADR-002"],
  migration: ["ADR-030"],
  test: ["ADR-010", "ADR-011", "ADR-016"],
  testing: ["ADR-010", "ADR-011", "ADR-016"],
  webhook: ["ADR-029"],
  payment: ["ADR-023", "ADR-029"],
  auth: ["ADR-005", "ADR-028"],
  checkout: ["ADR-001", "ADR-012"],
  dto: ["ADR-002"],
};

const MAX_ADR_DOCS = 8;
const MAX_ADR_CHARS = 2000;

/**
 * Selects relevant ADRs based on task conventions, tags, and file paths.
 */
function selectRelevantAdrs(
  task: ParsedTask,
  adrDocs: Record<string, string>,
): Array<{ key: string; content: string }> {
  const relevantKeys = new Set<string>();

  // 1. ADRs explicitly referenced in task.conventions
  for (const conv of task.conventions) {
    const key = conv.replace(/\.md$/, "");
    if (adrDocs[key]) relevantKeys.add(key);
  }

  // 2. ADRs matching task tags
  for (const tag of task.tags) {
    const mapped = ADR_TAG_MAP[tag.toLowerCase()];
    if (mapped) {
      for (const adrName of mapped) {
        // Find matching key (case-insensitive prefix match)
        for (const key of Object.keys(adrDocs)) {
          if (key.toUpperCase().startsWith(adrName)) {
            relevantKeys.add(key);
          }
        }
      }
    }
  }

  // 3. ADRs matching file path keywords
  for (const file of task.filesToModify) {
    const pathLower = file.path.toLowerCase();
    for (const [keyword, adrNames] of Object.entries(ADR_TAG_MAP)) {
      if (pathLower.includes(keyword)) {
        for (const adrName of adrNames) {
          for (const key of Object.keys(adrDocs)) {
            if (key.toUpperCase().startsWith(adrName)) {
              relevantKeys.add(key);
            }
          }
        }
      }
    }
  }

  // Sort and cap
  const selected = [...relevantKeys]
    .sort()
    .slice(0, MAX_ADR_DOCS)
    .map((key) => ({
      key,
      content:
        adrDocs[key].length > MAX_ADR_CHARS
          ? adrDocs[key].slice(0, MAX_ADR_CHARS) + "\n\n[... truncated]"
          : adrDocs[key],
    }));

  return selected;
}

/**
 * Formats selected ADR docs into a prompt section.
 */
function formatAdrSection(adrs: Array<{ key: string; content: string }>): string {
  if (adrs.length === 0) return "";

  const sections = adrs.map((adr) => `### ${adr.key}\n${adr.content}`);

  return (
    `## ADR Compliance Requirements\n` +
    `The following ADRs/conventions are relevant to this task. The enriched spec MUST\n` +
    `include specific compliance notes for each applicable ADR in its Recommended Approach.\n\n` +
    sections.join("\n\n")
  );
}

// ─── Options type ───────────────────────────────────────────────────

export interface EnrichmentPromptOptions {
  extractedPatterns?: PatternExtractionResult;
  adrDocs?: Record<string, string>;
  focusedFilePaths?: string[];
}

// ─── Main prompt builder ────────────────────────────────────────────

/**
 * Builds the enrichment prompt for the auto-enrichment agent.
 * This prompt instructs a read-only agent session to scan the codebase
 * and produce a more detailed task specification, addressing the
 * deficiencies found during depth evaluation.
 *
 * When codebase patterns and ADR docs are provided (via options),
 * the prompt includes pre-extracted pattern data and relevant ADR
 * compliance requirements, enabling the agent to produce specs that
 * match actual codebase conventions.
 *
 * @param task - The parsed task that needs enrichment
 * @param deficiencies - Specific deficiencies found during depth evaluation
 * @param suggestions - Enrichment suggestions from the depth evaluator
 * @param conventionsDoc - Project conventions document content
 * @param options - Optional codebase patterns and ADR docs
 * @returns The fully interpolated enrichment prompt string
 */
export function buildEnrichmentPrompt(
  task: ParsedTask,
  deficiencies: string[],
  suggestions: string[],
  conventionsDoc: string,
  options?: EnrichmentPromptOptions,
): string {
  const deficiencyList =
    deficiencies.length > 0 ? deficiencies.map((d) => `- ${d}`).join("\n") : "- None specified";

  const suggestionList =
    suggestions.length > 0 ? suggestions.map((s) => `- ${s}`).join("\n") : "- None specified";

  // Build optional codebase-aware sections
  const patternsSection = options?.extractedPatterns
    ? formatPatternsForPrompt(options.extractedPatterns)
    : "";

  const adrSection =
    options?.adrDocs && Object.keys(options.adrDocs).length > 0
      ? formatAdrSection(selectRelevantAdrs(task, options.adrDocs))
      : "";

  const focusedFilePaths = options?.focusedFilePaths ?? [];
  const focusedFilesSection =
    focusedFilePaths.length > 0
      ? [
          "## Focused Reading List (Max 10 Files)",
          "Read these files first and avoid broad exploration.",
          "If a listed file does not exist yet, infer integration points from nearby modules.",
          ...focusedFilePaths.map((filePath, idx) => `${idx + 1}. ${filePath}`),
        ].join("\n")
      : "";

  // Enhanced directives when codebase context is available
  const enhancedDirectives =
    patternsSection || adrSection
      ? `
7. Validate that any code examples in the spec match the ACTUAL patterns shown in the Codebase Patterns section above. If the spec shows a wrapper, import, or error handling pattern that does not match reality, correct it.
8. For each ADR listed in the ADR Compliance Requirements section, ensure the spec's Recommended Approach explains HOW the implementation should comply (specific wrapper to use, field naming convention, error types to throw, etc.)
9. Resolve any external references in the spec (e.g., "see TASK-NNN", "per parent task") by reading the referenced task file and inlining the relevant content directly.
10. Check for contradictions between spec sections (e.g., success criteria that conflict with recommended approach, test examples with wrong math).
11. Ensure error handling is specified per failure mode — not just "handle errors gracefully" but what happens when each specific dependency fails (e.g., "if client profile fetch fails, skip that appointment from queue").
12. For test examples in Testing Requirements, verify the math and logic are correct against the algorithm described in Recommended Approach.`
      : "";

  return `You are enriching a task specification to make it implementation-ready for a
background coding agent. The task was flagged as insufficiently detailed.

Your primary deliverable is the COMPLETE enriched task spec.
Start writing it immediately and use targeted reads only to fill missing implementation detail.

## Original Task
${task.rawContent}

## Deficiencies Found
${deficiencyList}

## Enrichment Suggestions
${suggestionList}

## Project Conventions
${conventionsDoc}
${patternsSection ? "\n" + patternsSection : ""}
${adrSection ? "\n" + adrSection : ""}
${focusedFilesSection ? "\n" + focusedFilesSection : ""}

## Instructions
1. Draft the COMPLETE enriched task spec immediately using the original task, deficiencies, and suggestions as structure.
2. Use the focused reading list first; cap reads to 10 files unless one additional file is strictly required for integration details.
3. Fill in missing details (current state, specific file paths, code patterns to follow).
4. Make success criteria specific and testable.
5. Add relevant convention/ADR references.
6. Identify integration points: if the task creates new files, specify which existing files must import or register them, what line/section needs modification, and what the integration code looks like.
6.5. **Ground concrete technical claims in real reads (TASK-923).** Any specific column name, file path, function or class signature, migration ID, table name, environment variable, or import path you introduce into the enriched spec MUST be verified by a Read or Grep call against the actual codebase. If a fact cannot be verified by reading the source — for example, because it depends on an external system or a runtime probe — say "needs operator confirmation: <what to check>" rather than producing a confident-sounding guess. Examples of facts that require a Read/Grep before stating them: database column names (verify against the migration file or schema), function/class signatures (verify in the actual source), file paths and module structure (verify with Glob), test command names and arguments (verify in package.json or runner script), environment variable names (verify in config/env loaders), SQL table schemas (verify in init-scripts/migrations). Examples that are OK to assert from context without re-reading: general architectural patterns already described in the focused-files list, convention guidance already in the conventions doc, cross-references between two specs both visible in the prompt.
7. Output only the COMPLETE enriched task spec in the standardized format.${enhancedDirectives}

## Required Section Format (the parser is strict)
Every section heading must be \`## <Name>\` (H2). Two sections are required to contain at least one parseable list item — checkbox (\`- [ ] text\`), bullet (\`- text\`), or numbered (\`1. text\`):

- **## Success Criteria** — at least one item.
- **## Testing Requirements** — at least one item, BEFORE any prose or per-file breakdown. If you want to elaborate (per-file detail, code examples, sub-headings), put a checkbox-list summary at the top of the section first, then the elaboration after. Subheadings (\`### ...\`) and prose alone do NOT satisfy the parser.

Example of a valid Testing Requirements section:
\`\`\`
## Testing Requirements

- [ ] At least 6 new tests across the touched test files
- [ ] \`tests/foo/bar.test.ts\` covers the new behavior
- [ ] \`npm run build\` passes; \`npm test\` passes for modified suites

### Detailed test plan (optional)
... per-file breakdowns or code examples below ...
\`\`\`

## Grounded By footer (TASK-923, required when concrete claims are introduced)

If the enriched spec introduces any specific column name, file path, function signature, migration ID, table name, environment variable, or import path that did NOT already appear verbatim in the original task, append a \`## Grounded By\` section at the end of the spec listing the Read/Grep calls that verified each fact. Use this shape:

\`\`\`
## Grounded By

This enrichment's concrete file paths, column names, and signatures were verified by:
- Read: src/migrations/20260506150000-add-per-tier-external-provider-markers.js (columns: last_appointments_delta_at, ...)
- Read: src/src/services/external-provider/external-provider-config.js (env vars: PROVIDER_API_BASE)
- Grep: 'CREATE TABLE.*external-provider_credentials' in src/init-scripts/

Claims marked "needs operator confirmation":
- The deploy SHA currently running on staging (requires staging probe).
\`\`\`

This section is informational and is part of the spec body — \`extractSpecBody\` preserves it. Its purpose is to make hallucinated content obvious in review: if the enriched spec claims a specific column name and the Grounded By footer has no Read entry for the migration that defines it, the verifier should treat that claim as suspect.

## Integration Context
If this task creates new files, identify the "wiring files" — existing files that must import or register the new modules. For each new file, specify:
- Which existing file imports/calls it
- What line or section needs modification
- What the import/registration looks like

Add an "Integration Points" section to the task spec's Recommended Approach.

Do NOT change the task's intent or scope. Only add detail and specificity.`;
}
