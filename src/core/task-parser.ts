import type {
  ParsedTask,
  TaskPriority,
  TaskStatus,
  FileModification,
  ExecutionMode,
} from "./types.js";
import {
  TASK_STATUSES,
  TASK_STATUS_ALIASES,
  TASK_STATUS_SET,
  normalizeTaskStatus,
  stripTaskStatusAnnotation,
} from "./task-status.js";

// ─── Constants ────────────────────────────────────────────────────

const VALID_PRIORITIES: ReadonlySet<string> = new Set([
  "P0-CRITICAL",
  "P1-HIGH",
  "P2-MEDIUM",
  "P3-LOW",
]);

const VALID_FILE_ACTIONS: ReadonlySet<string> = new Set([
  "Create",
  "Modify",
  "Delete",
  "Reference",
]);

// ─── Error Types ──────────────────────────────────────────────────

export class TaskParseError extends Error {
  constructor(
    message: string,
    public readonly filePath?: string,
  ) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = "TaskParseError";
  }
}

// ─── Parser ───────────────────────────────────────────────────────

/**
 * Parse a TASK-*.md file into a structured ParsedTask object.
 *
 * Required fields (throws TaskParseError if missing):
 *   - title (from H1 heading)
 *   - priority
 *   - effort
 *   - status
 *   - problemStatement
 *   - successCriteria (at least one)
 *   - testingRequirements (at least one)
 *
 * Optional fields (returns empty string/array if missing):
 *   - blockedBy, blocks, conventions, tags
 *   - currentState, recommendedApproach
 *   - filesToModify, contextReferences, decidedFacts, mandatedChecks
 */
export function parseTaskFile(content: string, filePath?: string): ParsedTask {
  const rawContent = content;
  const parseWarnings: string[] = [];
  const lines = content.split(/\r?\n/);

  // Extract task ID and title from H1 heading
  const { id, title } = parseH1(lines, filePath);

  // Extract sections keyed by H2 heading name
  const sections = extractSections(lines);

  // Parse metadata fields
  const metadataSection = sections.get("metadata") ?? "";
  const priority = parseRequiredMetadataField(metadataSection, "Priority", filePath);
  validatePriority(priority, filePath);

  const effort = parseRequiredMetadataField(metadataSection, "Effort", filePath);

  const rawStatus = parseRequiredMetadataField(metadataSection, "Status", filePath);
  const status = normalizeStatus(rawStatus, parseWarnings, filePath);
  const targetBranch = parseOptionalMetadataField(metadataSection, "Target Branch") ?? undefined;
  const executionMode = parseExecutionMode(metadataSection, filePath);
  const supersededBy = parseOptionalBracketList(metadataSection, "Superseded By");
  const supersedes = parseOptionalBracketList(metadataSection, "Supersedes");

  const blockedBy = parseOptionalBracketList(metadataSection, "Blocked By");
  const blocks = parseOptionalBracketList(metadataSection, "Blocks");
  const conventions = parseOptionalBracketList(metadataSection, "Conventions");
  const tags = parseOptionalBracketList(metadataSection, "Tags");

  // Parse text sections
  const problemStatement = requireNonEmptySection(
    sections,
    "problem statement",
    "Problem Statement",
    filePath,
  );
  const currentState = getSectionText(sections, "current state");
  const relevanceReview =
    parseOptionalMetadataField(metadataSection, "Relevance Review") ??
    getSectionText(sections, "relevance review");
  const recommendedApproach = getSectionText(sections, "recommended approach");

  // Parse structured sections
  const filesToModify = parseFilesToModifyTable(
    sections.get("files to modify") ?? "",
    parseWarnings,
  );

  const successCriteria = parseCheckboxList(sections.get("success criteria") ?? "");
  if (successCriteria.length === 0) {
    throw new TaskParseError(
      "Missing required field: Success Criteria (at least one criterion required)",
      filePath,
    );
  }

  const testingRequirements = parseCheckboxList(sections.get("testing requirements") ?? "");
  if (testingRequirements.length === 0) {
    throw new TaskParseError(
      "Missing required field: Testing Requirements (at least one requirement required)",
      filePath,
    );
  }

  const contextReferences = parseBulletList(sections.get("context references") ?? "");

  // TASK-1324: decided facts are the machine-readable fidelity surface —
  // only an explicit `## Decided Facts` section counts (no prose scrape).
  const decidedFacts = parseBulletList(sections.get("decided facts") ?? "");

  // TASK-1325 decision: mandated checks use the same bullet-text grammar
  // as Decided Facts. Fenced blocks are intentionally not scraped: only
  // an explicit `- ...` entry creates an exact fidelity claim.
  const mandatedChecks = parseBulletList(sections.get("mandated checks") ?? "");

  return {
    id,
    title,
    priority: priority as TaskPriority,
    effort,
    status,
    targetBranch,
    executionMode,
    parseWarnings,
    supersededBy,
    supersedes,
    relevanceReview,
    blockedBy,
    blocks,
    conventions,
    tags,
    problemStatement,
    currentState,
    recommendedApproach,
    filesToModify,
    successCriteria,
    testingRequirements,
    contextReferences,
    ...(decidedFacts.length > 0 ? { decidedFacts } : {}),
    ...(mandatedChecks.length > 0 ? { mandatedChecks } : {}),
    rawContent,
  };
}

function parseExecutionMode(metadataSection: string, filePath?: string): ExecutionMode | undefined {
  const value = parseOptionalMetadataField(metadataSection, "Execution Mode");
  if (value === null) {
    return undefined;
  }

  if (value === "dispatch" || value === "loop") {
    return value;
  }

  throw new TaskParseError(
    `Invalid Execution Mode: "${value}". Must be one of: dispatch, loop`,
    filePath,
  );
}

// ─── Internal Parsing Helpers ─────────────────────────────────────

/**
 * The single producer of the H1 grammar rule: "TASK-NNN: Title" (any of the
 * separator characters), or a bare "TASK-NNN". Exported (TASK-1334 round 2,
 * R2-2) because the replacement-identity guard must accept EXACTLY what this
 * parser accepts: the guard's first copy of the rule was looser
 * (case-insensitive, bare separator lookahead), so `/enrich/approve` could
 * persist headings this parser then threw on, turning a live spec into a
 * parse-error file. Any change here changes both the parser and the guard,
 * which is the point.
 *
 * The separator class is [colon, em dash, en dash, hyphen]; the dashes are
 * written as escapes so a dash sweep cannot narrow heading parity.
 */
export function matchTaskHeading(heading: string): { id: string; title: string } | null {
  // Match a complete bare ID before considering '-' as a title separator.
  // Otherwise TASK-1402-A backtracks to TASK-1402 with the title "A".
  const idOnly = heading.match(/^((?:TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3}))\s*$/);
  if (idOnly) {
    return { id: idOnly[1], title: "" };
  }

  // Match "TASK-NNN: Title" or "TASK-NNN-A: Title" (subtasks) or "TASK-NNN - Title"
  const match = heading.match(
    /^((?:TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3}))\s*[:\u2014\u2013-]\s*(.+)$/,
  );
  if (match) {
    return { id: match[1], title: match[2].trim() };
  }

  return null;
}

/**
 * Parse the H1 heading to extract task ID and title.
 * Expected format: "# TASK-{number}: {title}"
 */
function parseH1(lines: string[], filePath?: string): { id: string; title: string } {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const heading = trimmed.slice(2).trim();

      const matched = matchTaskHeading(heading);
      if (matched) {
        return matched;
      }

      // H1 exists but doesn't match TASK pattern
      throw new TaskParseError(
        `H1 heading does not match expected format "# TASK-{number}: {title}" or "# SAURUS-REM-NNN: {title}". Got: "${trimmed}"`,
        filePath,
      );
    }
  }

  throw new TaskParseError(
    "Missing required H1 heading (e.g., # TASK-001: Title or # SAURUS-REM-001: Title)",
    filePath,
  );
}

/**
 * Extract all H2 sections into a Map keyed by lowercase section name.
 * The value is the text content between this H2 and the next H2 (or EOF).
 */
function extractSections(lines: string[]): Map<string, string> {
  const sections = new Map<string, string>();
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  const saveCurrentSection = (): void => {
    if (currentSection === null) return;
    const content = currentLines.join("\n").trim();
    const existing = sections.get(currentSection);
    sections.set(
      currentSection,
      existing && content ? `${existing}\n${content}` : (existing ?? content),
    );
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      saveCurrentSection();
      currentSection = normalizeSectionHeading(trimmed.slice(3));
      currentLines = [];
    } else if (currentSection !== null) {
      currentLines.push(line);
    }
  }

  saveCurrentSection();

  return sections;
}

const CANONICAL_SECTION_HEADINGS = [
  "metadata",
  "problem statement",
  "current state",
  "relevance review",
  "recommended approach",
  "files to modify",
  "success criteria",
  "testing requirements",
  "context references",
  "decided facts",
  "mandated checks",
];

const SECTION_HEADING_ALIASES: ReadonlyArray<{
  canonical: string;
  aliases: string[];
}> = [
  {
    canonical: "relevance review",
    aliases: ["backlog relevance review"],
  },
];

/**
 * Normalize harmless H2 qualifiers while keeping non-canonical headings intact.
 *
 * Examples:
 * - "Success Criteria (umbrella)" -> "success criteria"
 * - "Testing Requirements - applies to each subtask" -> "testing requirements"
 */
function normalizeSectionHeading(rawHeading: string): string {
  const normalized = rawHeading.trim().toLowerCase().replace(/\s+/g, " ");

  for (const { canonical, aliases } of SECTION_HEADING_ALIASES) {
    for (const alias of aliases) {
      if (
        normalized === alias ||
        normalized.startsWith(`${alias} (`) ||
        normalized.startsWith(`${alias} -`) ||
        normalized.startsWith(`${alias} â€“`) ||
        normalized.startsWith(`${alias} â€”`) ||
        normalized.startsWith(`${alias}:`)
      ) {
        return canonical;
      }
    }
  }

  for (const canonical of CANONICAL_SECTION_HEADINGS) {
    if (normalized === canonical) return canonical;
    if (
      normalized.startsWith(`${canonical} (`) ||
      normalized.startsWith(`${canonical} -`) ||
      normalized.startsWith(`${canonical} –`) ||
      normalized.startsWith(`${canonical} —`) ||
      normalized.startsWith(`${canonical}:`)
    ) {
      return canonical;
    }
  }

  return normalized;
}

/**
 * Parse a required metadata field from the metadata section.
 * Metadata lines look like: "- **FieldName:** value"
 */
function parseRequiredMetadataField(
  metadataSection: string,
  fieldName: string,
  filePath?: string,
): string {
  const value = parseOptionalMetadataField(metadataSection, fieldName);
  if (value === null) {
    throw new TaskParseError(`Missing required metadata field: ${fieldName}`, filePath);
  }
  return value;
}

/**
 * Parse an optional metadata field. Returns null if not found.
 */
function parseOptionalMetadataField(metadataSection: string, fieldName: string): string | null {
  // Match "- **FieldName:** value" with flexible whitespace
  const pattern = new RegExp(`^\\s*-\\s*\\*\\*${escapeRegex(fieldName)}:\\*\\*\\s*(.+)$`, "mi");
  const match = metadataSection.match(pattern);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

/**
 * Parse a bracket list from a metadata field.
 * Formats: "[TASK-001, TASK-003]", "[tag1, tag2]", "[]", or missing entirely.
 */
function parseOptionalBracketList(metadataSection: string, fieldName: string): string[] {
  const value = parseOptionalMetadataField(metadataSection, fieldName);
  if (value === null) {
    return [];
  }
  return parseBracketListValue(value);
}

/**
 * Parse a bracket-delimited list value like "[TASK-001, TASK-003]" into an array.
 */
function parseBracketListValue(value: string): string[] {
  const trimmed = value.trim();

  // Handle bracket-wrapped lists: [TASK-001, TASK-003]
  const bracketMatch = trimmed.match(/^\[(.*)]\s*$/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    if (inner === "") {
      return [];
    }
    return inner
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  // Handle entries like "[TASK-704] (description)" or "[TASK-704, TASK-705] (notes)"
  // where brackets contain task IDs followed by parenthetical descriptions.
  // Extract all TASK-NNN(-X) IDs from the string.
  const taskIdMatches = trimmed.match(/\b(?:TASK-\d+(?:-[A-Z]+)?|SAURUS-REM-\d{3})\b/g);
  if (taskIdMatches && taskIdMatches.length > 0) {
    return taskIdMatches;
  }

  // Handle bare comma-separated values (no brackets)
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return [];
  }
  return trimmed
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Validate that a priority value is one of the allowed values.
 */
function validatePriority(value: string, filePath?: string): void {
  if (!VALID_PRIORITIES.has(value)) {
    throw new TaskParseError(
      `Invalid priority value: "${value}". Must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
      filePath,
    );
  }
}

/**
 * Validate that a status value is one of the allowed values.
 */
function validateStatus(value: string, filePath?: string): void {
  if (!TASK_STATUS_SET.has(value)) {
    throw new TaskParseError(
      `Invalid status value: "${value}". Must be one of: ${TASK_STATUSES.join(", ")}`,
      filePath,
    );
  }
}

function normalizeStatus(rawValue: string, warnings: string[], filePath?: string): TaskStatus {
  const trimmed = rawValue.trim();
  const normalizedBase = stripTaskStatusAnnotation(trimmed);
  const candidate = normalizeTaskStatus(trimmed);
  if (!candidate) {
    validateStatus(normalizedBase, filePath);
    throw new TaskParseError(
      `Invalid status value: "${trimmed}". Must be one of: ${TASK_STATUSES.join(", ")}`,
      filePath,
    );
  }

  if (TASK_STATUS_ALIASES[normalizedBase]) {
    warnings.push(`Status normalized from "${trimmed}" to "${candidate}"`);
  } else if (normalizedBase !== trimmed.toUpperCase()) {
    // Preserve warning when we strip decoration but keep the same semantic status.
    warnings.push(`Status annotation "${trimmed}" normalized to "${candidate}"`);
  }

  validateStatus(candidate, filePath);
  return candidate;
}

/**
 * Get the text content of a section, returning empty string if missing.
 */
function getSectionText(sections: Map<string, string>, name: string): string {
  return sections.get(name)?.trim() ?? "";
}

/**
 * Require that a section exists and is non-empty.
 */
function requireNonEmptySection(
  sections: Map<string, string>,
  sectionKey: string,
  displayName: string,
  filePath?: string,
): string {
  const text = getSectionText(sections, sectionKey);
  if (text === "") {
    throw new TaskParseError(`Missing required section: ${displayName}`, filePath);
  }
  return text;
}

/**
 * Parse a checkbox list section into an array of strings.
 * Lines like "- [ ] criterion text" or "- [x] criterion text" become "criterion text".
 * Also handles plain bullet items "- item text".
 */
function parseCheckboxList(sectionText: string): string[] {
  if (sectionText.trim() === "") {
    return [];
  }

  const results: string[] = [];
  for (const line of sectionText.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Match "- [ ] text" or "- [x] text" or "- [X] text"
    const checkboxMatch = trimmed.match(/^-\s*\[[ xX]]\s*(.+)$/);
    if (checkboxMatch) {
      results.push(checkboxMatch[1].trim());
      continue;
    }

    // Match plain bullet "- text"
    const bulletMatch = trimmed.match(/^-\s+(.+)$/);
    if (bulletMatch) {
      results.push(bulletMatch[1].trim());
      continue;
    }

    // Match numbered items like "1. Test it" or "1) Test it".
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      results.push(numberedMatch[1].trim());
    }
  }

  return results;
}

/**
 * Parse a plain bullet list into an array of strings.
 * Lines like "- reference text" become "reference text".
 */
function parseBulletList(sectionText: string): string[] {
  if (sectionText.trim() === "") {
    return [];
  }

  const results: string[] = [];
  for (const line of sectionText.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^-\s+(.+)$/);
    if (match) {
      results.push(match[1].trim());
    }
  }

  return results;
}

/**
 * Parse the "Files to Modify" markdown table into FileModification objects.
 *
 * Expected format:
 * | File | Action | Notes |
 * |------|--------|-------|
 * | path/to/file.ts | Create | Description |
 */
function parseFilesToModifyTable(sectionText: string, parseWarnings: string[]): FileModification[] {
  if (sectionText.trim() === "") {
    return [];
  }

  const results: FileModification[] = [];
  const lines = sectionText.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, header row, and separator row
    if (trimmed === "" || trimmed.startsWith("|--") || trimmed.startsWith("| --")) {
      continue;
    }

    // Skip the separator line (e.g., "|------|--------|-------|")
    if (/^\|[\s-]+\|[\s-]+\|[\s-]+\|$/.test(trimmed)) {
      continue;
    }

    // Parse table row: | col1 | col2 | col3 |
    if (trimmed.startsWith("|")) {
      const cells = trimmed
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");

      if (cells.length < 2) {
        continue;
      }

      const path = cells[0].replace(/`/g, "");
      const action = cells[1];
      const notes = cells.length >= 3 ? cells[2] : "";

      // Skip the header row (look for common header names)
      if (path.toLowerCase() === "file" && action.toLowerCase() === "action") {
        continue;
      }

      // Validate the action
      const normalizedAction = normalizeAction(action);
      if (normalizedAction === null) {
        parseWarnings.push(`Unknown file action "${action}" in Files to Modify table; row skipped`);
        continue; // Skip rows with unrecognized actions
      }

      results.push({
        path,
        action: normalizedAction,
        notes,
      });
    }
  }

  return results;
}

/**
 * Normalize a file action string to a valid FileModification action.
 */
function normalizeAction(action: string): FileModification["action"] | null {
  const lower = action.toLowerCase().trim();
  if (lower === "create") return "Create";
  if (lower === "add") return "Create";
  if (lower === "new") return "Create";
  if (lower === "modify") return "Modify";
  if (lower === "delete") return "Delete";
  // Reference aliases — read-only, context-only, or do-not-modify signals
  if (lower === "reference") return "Reference";
  if (lower === "verify") return "Reference";
  if (lower === "read-only") return "Reference";
  if (lower === "read-only reference") return "Reference";
  if (lower === "optional") return "Reference";
  if (lower === "do not modify") return "Reference";
  if (lower === "do-not-modify") return "Reference";
  if (lower === "review") return "Reference";

  // Check if it starts with a valid action (handle typos with extra text)
  for (const valid of VALID_FILE_ACTIONS) {
    if (lower.startsWith(valid.toLowerCase())) {
      return valid as FileModification["action"];
    }
  }

  return null;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
