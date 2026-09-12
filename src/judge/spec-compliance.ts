// ─── Pre-Judge Deterministic Spec Compliance Checks ────────────────
// Checks whether success criteria have corresponding code patterns in
// the git diff before the LLM judge evaluates. Catches the "mentioned
// vs enforced" failure mode where criteria are discussed in comments
// but not actually implemented.
//
// Two-tier system:
// 1. Built-in pattern library (zero-config, universal patterns)
// 2. Adapter-configurable checks (project-specific patterns)

import type { ParsedTask, VerificationPattern } from "../core/types.js";
import { promises as fs } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A compliance pattern that maps criterion phrases to code patterns
 * that should exist in the implementation.
 */
export interface CompliancePattern {
  /** Phrases in success criteria that trigger this pattern */
  triggers: RegExp[];
  /** Code patterns to search for in the diff/changed files */
  codePatterns: RegExp[];
  /** Human-readable description of what's being checked */
  description: string;
  /** Severity if pattern is missing */
  severity: "warning" | "flag";
}

/**
 * Result of checking a single success criterion for compliance.
 */
export interface ComplianceCheckResult {
  /** The success criterion text */
  criterion: string;
  /**
   * TASK-1320: the criterion's position in `task.successCriteria`.
   *
   * OPTIONAL, and that is load-bearing (round-1 R1-6): compliance
   * objects created before this change carry no index, and cached or
   * replayed payloads and revise-loop reuse all surface them. Grouping
   * those under `undefined` would coalesce unrelated criteria or bypass
   * Rule B entirely, so absence means "use the legacy text grouping",
   * never "index 0".
   *
   * Assigned from the SOURCE `.entries()` iteration and never derived
   * from `results.length` or `indexOf` (round-1 R1-3): one criterion can
   * produce zero, one or many results, so results position is NOT
   * criterion position, and `indexOf` cannot tell duplicate criteria
   * apart.
   */
  criterionIndex?: number;
  /** Which pattern was matched (if any) */
  patternMatched: string;
  /** Whether code evidence was found */
  found: boolean;
  /** File:line references where pattern was found (or empty) */
  evidence: string[];
  /** What was checked */
  description: string;
  /** Severity level */
  severity: "warning" | "flag";
}

/**
 * Adapter-configurable deterministic check (from adapter.json).
 */
export interface DeterministicCheck {
  /** Name of the check */
  name: string;
  /** Criterion text substring to match (case-insensitive) */
  criterionMatch: string;
  /** Type of check to perform */
  type: "grep" | "grep_count" | "file_exists" | "file_not_exists";
  /** Pattern for grep, or path for file checks */
  pattern: string;
  /** Files to search (glob) — only for grep type */
  glob?: string;
  /** Exact zero when 0; minimum required count when positive. */
  expectedMatches?: number;
  /** Severity level */
  severity: "warning" | "flag";
}

// ─── Blueprint Conversion ───────────────────────────────────────────

/**
 * Maps VerificationPattern.checkType to DeterministicCheck.type.
 * grep_count remains distinct so zero-count assertions cannot silently
 * degrade into ordinary presence checks.
 */
function mapCheckType(
  checkType: "grep" | "grep_count" | "file_exists" | "file_not_exists",
): DeterministicCheck["type"] {
  return checkType;
}

/**
 * Convert Blueprint verification patterns into DeterministicCheck format.
 * Preserves grep_count and its threshold for deterministic enforcement.
 */
export function blueprintToChecks(
  verificationPatterns: VerificationPattern[],
): DeterministicCheck[] {
  return verificationPatterns.map((vp, i) => ({
    name: `blueprint-${i}: ${vp.criterion.slice(0, 60)}`,
    criterionMatch: vp.criterion,
    type: mapCheckType(vp.checkType),
    pattern: vp.pattern,
    glob: vp.fileGlob,
    ...(vp.expectedMatches !== undefined ? { expectedMatches: vp.expectedMatches } : {}),
    severity: "flag" as const,
  }));
}

// ─── Built-in Pattern Library ───────────────────────────────────────

/**
 * Universal compliance patterns that map common success criterion
 * phrases to expected code patterns. These run automatically for
 * every task.
 */
const BUILT_IN_PATTERNS: CompliancePattern[] = [
  {
    triggers: [/\benforces?\b/i, /\blimits?\b/i, /\bcaps?\b/i, /\bmax\w+/i, /\bmaximum\b/i],
    codePatterns: [
      /\.slice\(/,
      /Math\.min\(/,
      /Math\.max\(/,
      /\bif\s*\([^)]*[<>=]=?/,
      /\blength\s*[<>=]/,
      /\bcount\s*[<>=]/,
      /\bsize\s*[<>=]/,
    ],
    description: "Limit/cap enforcement (slice, Math.min/max, conditional checks)",
    severity: "flag",
  },
  {
    triggers: [/\bhandles?\s+error/i, /\berror\s+handling/i, /\bgraceful/i, /\brecovers?\s+from/i],
    codePatterns: [
      /\btry\s*\{/,
      /\bcatch\s*\(/,
      /\.catch\(/,
      /\bthrow\s+/,
      /\bError\(/,
      /instanceof\s+Error/,
    ],
    description: "Error handling (try/catch, .catch(), throw, Error checks)",
    severity: "flag",
  },
  {
    triggers: [
      /\bvalidates?\b/i,
      /\brejects?\s+invalid/i,
      /\bchecks?\s+\w+\s+is\s+valid/i,
      /\bensures?\s+valid/i,
    ],
    codePatterns: [
      /\bif\s*\(!/,
      /\bif\s*\([^)]*===?\s*null/,
      /\bif\s*\([^)]*===?\s*undefined/,
      /\bthrow\s+/,
      /\breturn\s+false/,
      /\.test\(/,
      /instanceof\s+/,
    ],
    description: "Validation logic (conditionals, null checks, throws, type checks)",
    severity: "flag",
  },
  {
    triggers: [/\bconcurrent/i, /\block\b/i, /\batomic/i, /\brace\s+condition/i, /\bmutex/i],
    codePatterns: [
      /flag:\s*["']wx["']/,
      /\.lock\b/,
      /\.unlock\b/,
      /Mutex/,
      /Semaphore/,
      /await\s+\w+\.acquire/,
    ],
    description: "Concurrency control (lock files, mutexes, atomic flags)",
    severity: "flag",
  },
  {
    triggers: [
      /\breferences?\b/i,
      /\bdependency\b/i,
      /\bcross-valid/i,
      /\bchecks?\s+\w+\s+exists?/i,
    ],
    codePatterns: [
      /\.has\(/,
      /\.includes?\(/,
      /\.get\(/,
      /\.find\(/,
      /\bMap\b/,
      /\bSet\b/,
      /\.some\(/,
    ],
    description: "Cross-reference checks (Set/Map operations, find, includes)",
    severity: "flag",
  },
  {
    triggers: [
      /\bpage\b/i,
      /component/i,
      /\bfrontend\b/i,
      /\bUI\b/,
      /\bform\b/i,
      /\bdashboard\b/i,
      /\bsidebar\b/i,
      /\bnavigation\b/i,
      /\.tsx\b/i,
      /\breact\b/i,
    ],
    codePatterns: [
      /\.tsx/,
      /\buseState\b/,
      /\buseEffect\b/,
      /\buseContext\b/,
      /\bimport\s+React\b/,
      /\bexport\s+(default\s+)?function\s+\w+Page\b/,
      /\bexport\s+(default\s+)?function\s+\w+Component\b/,
      /\breturn\s*\(/,
      /\bclassName=/,
      /\b<div\b/,
    ],
    description: "Frontend/React implementation (JSX, hooks, components, pages)",
    severity: "flag",
  },
];

// ─── Diff Parsing ───────────────────────────────────────────────────

/**
 * Extracts added lines from a git diff, with file:line references.
 * Only returns lines that were added (+ prefix), skipping deletions
 * and context.
 *
 * @param diff - The git diff string
 * @returns Array of { file, line, content } for each added line
 */
function extractAddedLines(diff: string): Array<{
  file: string;
  line: number;
  content: string;
}> {
  const lines = diff.split("\n");
  const added: Array<{ file: string; line: number; content: string }> = [];
  let currentFile = "";
  let currentLine = 0;

  for (const line of lines) {
    // Track current file from diff headers
    if (line.startsWith("diff --git ")) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "";
      currentLine = 0;
      continue;
    }

    // Track line number from hunk headers
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)/);
      currentLine = match ? parseInt(match[1], 10) : 0;
      continue;
    }

    // Only process added lines (not deletions or context)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1); // Remove the + prefix
      added.push({ file: currentFile, line: currentLine, content });
      currentLine++;
    } else if (!line.startsWith("-")) {
      // Context lines advance the line counter
      currentLine++;
    }
  }

  return added;
}

// ─── Pattern Matching ───────────────────────────────────────────────

/**
 * Check if a criterion triggers a pattern, and if so, whether the
 * pattern's code evidence exists in the added lines.
 *
 * @param criterion - The success criterion text
 * @param pattern - The compliance pattern to check
 * @param addedLines - Lines added by the agent (from diff)
 * @returns ComplianceCheckResult or null if pattern doesn't apply
 */
function checkPattern(
  criterion: string,
  pattern: CompliancePattern,
  addedLines: Array<{ file: string; line: number; content: string }>,
): ComplianceCheckResult | null {
  // Check if this criterion triggers this pattern
  const triggered = pattern.triggers.some((trigger) => trigger.test(criterion));
  if (!triggered) return null;

  const evidence: string[] = [];

  // Search for code patterns in added lines
  for (const { file, line, content } of addedLines) {
    for (const codePattern of pattern.codePatterns) {
      if (codePattern.test(content)) {
        evidence.push(`${file}:${line}`);
        break; // Only record one match per line
      }
    }
  }

  return {
    criterion,
    patternMatched: pattern.description,
    found: evidence.length > 0,
    evidence,
    description: pattern.description,
    severity: pattern.severity,
  };
}

// ─── Adapter Checks ─────────────────────────────────────────────────

/**
 * Run a single adapter-configured deterministic check.
 *
 * @param check - The deterministic check configuration
 * @param criterion - The criterion text
 * @param addedLines - Lines added by the agent
 * @param changedFiles - List of changed file paths
 * @param projectRoot - Absolute path to project root
 * @returns ComplianceCheckResult or null if check doesn't apply
 */
async function runAdapterCheck(
  check: DeterministicCheck,
  criterion: string,
  addedLines: Array<{ file: string; line: number; content: string }>,
  changedFiles: string[],
  projectRoot: string,
): Promise<ComplianceCheckResult | null> {
  // Check if this criterion matches
  if (!criterion.toLowerCase().includes(check.criterionMatch.toLowerCase())) {
    return null;
  }

  const evidence: string[] = [];
  let found = false;

  switch (check.type) {
    case "grep": {
      const pattern = new RegExp(check.pattern);
      // Filter by glob if specified
      let filesToSearch = addedLines;
      if (check.glob) {
        const globPattern = check.glob;
        filesToSearch = addedLines.filter((line) => {
          // Simple glob matching: convert * to .* and match
          const globRegex = new RegExp("^" + globPattern.replace(/\*/g, ".*") + "$");
          return globRegex.test(line.file);
        });
      }

      for (const { file, line, content } of filesToSearch) {
        if (pattern.test(content)) {
          evidence.push(`${file}:${line}`);
          found = true;
        }
      }
      break;
    }

    case "grep_count": {
      const candidateFiles = new Set([
        ...changedFiles,
        ...addedLines.map((line) => line.file).filter(Boolean),
      ]);
      const matchingFiles = [...candidateFiles].filter(
        (file) => !check.glob || matchesSimpleGlob(file, check.glob),
      );
      const fullFileLines = await readProjectFileLines(projectRoot, matchingFiles);
      const linesToSearch =
        fullFileLines.length > 0
          ? fullFileLines
          : addedLines.filter((line) => !check.glob || matchesSimpleGlob(line.file, check.glob));

      let matchCount = 0;
      for (const { file, line, content } of linesToSearch) {
        const lineMatches = countPatternMatches(content, check.pattern);
        matchCount += lineMatches;
        for (let occurrence = 0; occurrence < lineMatches; occurrence++) {
          evidence.push(`${file}:${line}`);
        }
      }

      const expectedMatches = check.expectedMatches ?? 1;
      found = expectedMatches === 0 ? matchCount === 0 : matchCount >= expectedMatches;
      if (found && expectedMatches === 0) {
        evidence.push(`0 matches across ${matchingFiles.length} changed file(s)`);
      }
      break;
    }

    case "file_exists": {
      const filePath = join(projectRoot, check.pattern);
      try {
        await fs.access(filePath);
        found = true;
        evidence.push(check.pattern);
      } catch {
        found = false;
      }
      break;
    }

    case "file_not_exists": {
      const filePath = join(projectRoot, check.pattern);
      try {
        await fs.access(filePath);
        found = false; // File exists when it shouldn't
      } catch {
        found = true; // File doesn't exist (as expected)
        evidence.push(`${check.pattern} (correctly absent)`);
      }
      break;
    }
  }

  return {
    criterion,
    patternMatched: check.name,
    found,
    evidence,
    description: `Adapter check: ${check.name}`,
    severity: check.severity,
  };
}

function matchesSimpleGlob(file: string, glob: string): boolean {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedGlob = glob.replace(/\\/g, "/");
  const globstarDirectory = "__QUACK_GLOBSTAR_DIRECTORY__";
  const globstar = "__QUACK_GLOBSTAR__";
  const wildcard = "__QUACK_WILDCARD__";
  const singleCharacter = "__QUACK_SINGLE_CHARACTER__";
  const tokenized = normalizedGlob
    .replace(/\*\*\//g, globstarDirectory)
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, wildcard)
    .replace(/\?/g, singleCharacter);
  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped
    .replaceAll(globstarDirectory, "(?:.*/)?")
    .replaceAll(globstar, ".*")
    .replaceAll(wildcard, "[^/]*")
    .replaceAll(singleCharacter, "[^/]");
  return new RegExp(`^${pattern}$`).test(normalizedFile);
}

async function readProjectFileLines(
  projectRoot: string,
  files: string[],
): Promise<Array<{ file: string; line: number; content: string }>> {
  const root = resolve(projectRoot);
  const lines: Array<{ file: string; line: number; content: string }> = [];

  for (const file of files) {
    const absolute = resolve(root, file);
    const withinRoot = relative(root, absolute);
    if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) continue;

    try {
      const content = await fs.readFile(absolute, "utf8");
      content.split(/\r?\n/).forEach((lineContent, index) => {
        lines.push({ file: file.replace(/\\/g, "/"), line: index + 1, content: lineContent });
      });
    } catch {
      // A deleted or unavailable changed file contributes no matches.
    }
  }

  return lines;
}

function countPatternMatches(content: string, source: string): number {
  const regex = new RegExp(source, "g");
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    count++;
    if (match[0].length === 0) regex.lastIndex++;
  }
  return count;
}

// ─── Main Checker ───────────────────────────────────────────────────

/**
 * Run spec compliance checks for all success criteria.
 * Combines built-in patterns and adapter-configured checks.
 *
 * @param task - The parsed task with success criteria
 * @param gitDiff - The git diff of agent changes
 * @param changedFiles - List of changed file paths
 * @param adapterChecks - Optional adapter-configured checks
 * @param projectRoot - Absolute path to project root (for file checks)
 * @returns Array of compliance check results
 */
export async function runSpecComplianceChecks(
  task: ParsedTask,
  gitDiff: string,
  changedFiles: string[],
  adapterChecks: DeterministicCheck[] = [],
  projectRoot = ".",
): Promise<ComplianceCheckResult[]> {
  const addedLines = extractAddedLines(gitDiff);
  const results: ComplianceCheckResult[] = [];

  // Run built-in patterns for each criterion. TASK-1320: the index comes
  // from THIS iteration, which is the only place it is a fact.
  for (const [criterionIndex, criterion] of task.successCriteria.entries()) {
    for (const pattern of BUILT_IN_PATTERNS) {
      const result = checkPattern(criterion, pattern, addedLines);
      if (result) {
        results.push({ ...result, criterionIndex });
      }
    }

    // Run adapter checks for this criterion
    for (const check of adapterChecks) {
      const result = await runAdapterCheck(check, criterion, addedLines, changedFiles, projectRoot);
      if (result) {
        results.push({ ...result, criterionIndex });
      }
    }
  }

  return results;
}
