import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ParsedTask } from "../core/types.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface ExtractedPattern {
  filePath: string;
  exists: boolean;
  exports: string[];
  wrapperPattern: string | null;
  errorHandling: string[];
  importPatterns: string[];
  fieldNaming: "camelCase" | "snake_case" | "mixed" | "unknown";
  lineCount: number;
  snippet: string;
}

export interface PatternExtractionResult {
  patterns: ExtractedPattern[];
  siblingPatterns: ExtractedPattern[];
}

// ─── Constants ──────────────────────────────────────────────────────

const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const SNIPPET_LINES = 30;

// ─── Regex patterns ─────────────────────────────────────────────────

const WRAPPER_PATTERNS = [/(\w+Wrapper)\s*\(/g, /(\w+Wrapper)\s*</g];

const EXPORT_PATTERNS = [
  // CommonJS: module.exports = { foo, bar }
  /module\.exports\s*=\s*\{([^}]+)\}/g,
  // CommonJS: module.exports.foo = ...
  /module\.exports\.(\w+)\s*=/g,
  // CommonJS: exports.foo = ...
  /^exports\.(\w+)\s*=/gm,
  // ESM: export function foo
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  // ESM: export const foo
  /export\s+const\s+(\w+)/g,
  // ESM: export class foo
  /export\s+class\s+(\w+)/g,
  // ESM: export { foo, bar }
  /export\s*\{([^}]+)\}/g,
];

const ERROR_PATTERNS = [
  /(?:throw\s+new\s+|catch.*?)(\w*Error)\b/g,
  /(BadRequestError|ValidationError|NotFoundError|ConflictError|AuthenticationError|AuthorizationError|DatabaseError|AppError)/g,
];

const IMPORT_PATTERNS_RE = [
  // CommonJS: require('./foo')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // ESM: import ... from './foo'
  /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
  // ESM: import './foo'
  /^import\s+['"]([^'"]+)['"]/gm,
];

// ─── Field naming detection ─────────────────────────────────────────

function detectFieldNaming(content: string): ExtractedPattern["fieldNaming"] {
  // Focus on object keys and variable assignments in the first 200 lines
  const sample = content.split("\n").slice(0, 200).join("\n");
  const camelCount = (sample.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? []).length;
  const snakeCount = (sample.match(/\b[a-z]+_[a-z]+\b/g) ?? []).length;

  if (camelCount === 0 && snakeCount === 0) return "unknown";
  if (camelCount > 0 && snakeCount === 0) return "camelCase";
  if (snakeCount > 0 && camelCount === 0) return "snake_case";
  // Mixed: both present, dominant one wins if ratio > 3:1
  if (camelCount > snakeCount * 3) return "camelCase";
  if (snakeCount > camelCount * 3) return "snake_case";
  return "mixed";
}

// ─── Pattern extraction from file content ───────────────────────────

function extractFromContent(content: string, filePath: string): ExtractedPattern {
  const lines = content.split("\n");

  // Exports
  const exports = new Set<string>();
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const captured = match[1];
      // If it's a destructured list like "{ foo, bar }", split by comma
      if (captured.includes(",")) {
        captured.split(",").forEach((name) => {
          const trimmed = name.trim().split(/\s+/)[0]; // handle "foo as bar"
          if (trimmed && /^\w+$/.test(trimmed)) exports.add(trimmed);
        });
      } else {
        const trimmed = captured.trim();
        if (trimmed && /^\w+$/.test(trimmed)) exports.add(trimmed);
      }
    }
  }

  // Wrapper patterns
  const wrappers = new Set<string>();
  for (const pattern of WRAPPER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      wrappers.add(match[1]);
    }
  }

  // Error handling
  const errors = new Set<string>();
  for (const pattern of ERROR_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      errors.add(match[1]);
    }
  }

  // Import patterns (first 10 unique)
  const imports = new Set<string>();
  for (const pattern of IMPORT_PATTERNS_RE) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null && imports.size < 10) {
      imports.add(match[1]);
    }
  }

  return {
    filePath,
    exists: true,
    exports: [...exports].slice(0, 20),
    wrapperPattern: wrappers.size > 0 ? [...wrappers][0] : null,
    errorHandling: [...errors].slice(0, 10),
    importPatterns: [...imports],
    fieldNaming: detectFieldNaming(content),
    lineCount: lines.length,
    snippet: lines.slice(0, SNIPPET_LINES).join("\n"),
  };
}

function emptyPattern(filePath: string): ExtractedPattern {
  return {
    filePath,
    exists: false,
    exports: [],
    wrapperPattern: null,
    errorHandling: [],
    importPatterns: [],
    fieldNaming: "unknown",
    lineCount: 0,
    snippet: "",
  };
}

// ─── File reading helpers ───────────────────────────────────────────

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function findSiblingFiles(filePath: string, projectRoot: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const absDir = path.isAbsolute(dir) ? dir : path.resolve(projectRoot, dir);
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(ts|js|tsx|jsx)$/.test(e.name))
      .map((e) => path.join(absDir, e.name))
      .slice(0, 5); // Cap at 5 siblings
  } catch {
    return [];
  }
}

// ─── Main extraction function ───────────────────────────────────────

/**
 * Extracts structural patterns from files referenced in a task's filesToModify.
 * Purely deterministic — no LLM calls, just filesystem reads + regex.
 *
 * For "Modify" actions: reads the actual file and extracts patterns.
 * For "Reference" actions: reads the actual file and extracts patterns (like Modify — file exists on disk).
 * For "Create" actions: reads sibling files in the same directory to infer conventions.
 *
 * @param task - Parsed task with filesToModify
 * @param projectRoot - Absolute path to project root
 * @returns Extracted patterns for direct files and sibling inference
 */
export async function extractPatterns(
  task: ParsedTask,
  projectRoot: string,
): Promise<PatternExtractionResult> {
  const files = task.filesToModify.slice(0, MAX_FILES);
  const patterns: ExtractedPattern[] = [];
  const siblingPatterns: ExtractedPattern[] = [];
  const processedPaths = new Set<string>();

  for (const file of files) {
    const absPath = path.isAbsolute(file.path) ? file.path : path.resolve(projectRoot, file.path);

    // Reference files exist on disk like Modify files — read them for pattern mining.
    // Create entries are skipped (file does not exist yet).
    if (file.action === "Modify" || file.action === "Delete" || file.action === "Reference") {
      const content = await readFileSafe(absPath);
      if (content !== null) {
        patterns.push(extractFromContent(content, file.path));
      } else {
        patterns.push(emptyPattern(file.path));
      }
      processedPaths.add(absPath);
    } else if (file.action === "Create") {
      // For new files, scan siblings to infer conventions
      patterns.push(emptyPattern(file.path));
      const siblings = await findSiblingFiles(file.path, projectRoot);
      for (const sibling of siblings) {
        if (processedPaths.has(sibling)) continue;
        processedPaths.add(sibling);
        const content = await readFileSafe(sibling);
        if (content !== null) {
          siblingPatterns.push(extractFromContent(content, path.relative(projectRoot, sibling)));
        }
      }
    }
  }

  return { patterns, siblingPatterns };
}

// ─── Formatting for prompts ─────────────────────────────────────────

/**
 * Formats extracted patterns into a markdown section for the enrichment prompt.
 * Returns empty string if no meaningful patterns were extracted.
 */
export function formatPatternsForPrompt(result: PatternExtractionResult): string {
  const sections: string[] = [];

  const existingPatterns = result.patterns.filter((p) => p.exists);
  if (existingPatterns.length > 0) {
    sections.push("### Files to Modify (Existing)");
    for (const p of existingPatterns) {
      const lines: string[] = [];
      lines.push(`\n#### \`${p.filePath}\` (${p.lineCount} lines)`);
      if (p.exports.length > 0) lines.push(`- **Exports:** ${p.exports.join(", ")}`);
      if (p.wrapperPattern) lines.push(`- **Wrapper:** \`${p.wrapperPattern}\``);
      if (p.errorHandling.length > 0)
        lines.push(`- **Error handling:** ${p.errorHandling.join(", ")}`);
      if (p.importPatterns.length > 0) lines.push(`- **Imports:** ${p.importPatterns.join(", ")}`);
      lines.push(`- **Field naming:** ${p.fieldNaming}`);
      if (p.snippet) {
        lines.push(`- **First ${SNIPPET_LINES} lines:**`);
        lines.push("```");
        lines.push(p.snippet);
        lines.push("```");
      }
      sections.push(lines.join("\n"));
    }
  }

  if (result.siblingPatterns.length > 0) {
    sections.push("\n### Sibling Files (Convention Reference for New Files)");
    for (const p of result.siblingPatterns) {
      const lines: string[] = [];
      lines.push(`\n#### \`${p.filePath}\` (${p.lineCount} lines)`);
      if (p.exports.length > 0) lines.push(`- **Exports:** ${p.exports.join(", ")}`);
      if (p.wrapperPattern) lines.push(`- **Wrapper:** \`${p.wrapperPattern}\``);
      if (p.errorHandling.length > 0)
        lines.push(`- **Error handling:** ${p.errorHandling.join(", ")}`);
      lines.push(`- **Field naming:** ${p.fieldNaming}`);
      sections.push(lines.join("\n"));
    }
  }

  if (sections.length === 0) return "";

  return (
    `## Codebase Patterns (Pre-Extracted)\n` +
    `The following patterns were deterministically extracted from files referenced in this task.\n` +
    `Use these as ground truth when enriching the spec — do NOT contradict them.\n\n` +
    sections.join("\n")
  );
}
