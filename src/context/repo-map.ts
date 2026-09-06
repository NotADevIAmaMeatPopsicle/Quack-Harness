// ─── Repository Map Generator ─────────────────────────────────────
// Generates a lightweight signature map of a codebase by parsing
// TypeScript/JavaScript files for export declarations. The map gives
// agents a structural overview (~2-5K tokens) without loading full
// file contents, significantly reducing initial context size.

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface RepoMapEntry {
  /** Relative path from project root */
  file: string;
  /** Exported function/class/interface/type/const names */
  exports: string[];
  /** Total line count of the file */
  lineCount: number;
}

export interface RepoMapOptions {
  /** Maximum number of files to include (default: 200) */
  maxFiles?: number;
  /** Glob patterns to exclude (e.g., ["**\/*.test.ts"]) */
  excludePatterns?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 200;

const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.test.tsx",
  "**/*.test.jsx",
  "**/*.d.ts",
];

/** Extensions we parse for exports */
const PARSEABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

// ─── Simple Glob Matching ────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: *, **, ?, and character classes.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any path segment(s)
        if (pattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === ".") {
      regex += "\\.";
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const re = globToRegex(pattern);
    if (re.test(filePath)) {
      return true;
    }
  }
  return false;
}

// ─── Export Parsing ──────────────────────────────────────────────────

// Regex patterns for detecting exports in TypeScript/JavaScript files.
// Uses simple line-by-line regex rather than AST parsing for speed.
const EXPORT_PATTERNS: RegExp[] = [
  // export function NAME / export async function NAME
  /^export\s+(?:async\s+)?function\s+(\w+)/,
  // export class NAME / export abstract class NAME
  /^export\s+(?:abstract\s+)?class\s+(\w+)/,
  // export interface NAME
  /^export\s+interface\s+(\w+)/,
  // export type NAME
  /^export\s+type\s+(\w+)\s*[=<{]/,
  // export const NAME / export let NAME / export var NAME
  /^export\s+(?:const|let|var)\s+(\w+)/,
  // export enum NAME
  /^export\s+enum\s+(\w+)/,
  // export default class NAME / export default function NAME
  /^export\s+default\s+(?:class|function)\s+(\w+)/,
  // export default (anonymous)
  /^export\s+default\s+(?!class|function|abstract)/,
];

// Named re-exports: export { NAME1, NAME2 } or export { NAME1, NAME2 } from "..."
const NAMED_EXPORT_RE = /^export\s*\{([^}]+)\}/;

/**
 * Extract export names from a single line of source code.
 */
function extractExportsFromLine(line: string): string[] {
  const trimmed = line.trim();
  const exports: string[] = [];

  // Check named re-exports first
  const namedMatch = trimmed.match(NAMED_EXPORT_RE);
  if (namedMatch) {
    const names = namedMatch[1].split(",").map((n) => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    });
    exports.push(...names.filter((n) => n.length > 0));
    return exports;
  }

  // Check individual export patterns
  for (const pattern of EXPORT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      if (match[1]) {
        exports.push(match[1]);
      } else {
        exports.push("default");
      }
      break;
    }
  }

  return exports;
}

/**
 * Parse a file's content and extract all exported names.
 */
export function parseExports(content: string): string[] {
  const lines = content.split("\n");
  const exports: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const lineExports = extractExportsFromLine(line);
    for (const exp of lineExports) {
      if (!seen.has(exp)) {
        seen.add(exp);
        exports.push(exp);
      }
    }
  }

  return exports;
}

// ─── File Discovery ──────────────────────────────────────────────────

/**
 * Recursively find files matching the given glob patterns.
 * Uses fs.readdir with recursive option (Node 18.17+).
 */
async function findFiles(
  projectRoot: string,
  patterns: string[],
  excludePatterns: string[],
): Promise<string[]> {
  const allFiles: string[] = [];

  try {
    const entries = await fs.readdir(projectRoot, {
      recursive: true,
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Build the relative path using forward slashes
      const parentPath = entry.parentPath ?? (entry as unknown as { path: string }).path ?? "";
      const absoluteParent = parentPath;
      const relativePath = path
        .relative(projectRoot, path.join(absoluteParent, entry.name))
        .replace(/\\/g, "/");

      // Check extension
      const ext = path.extname(entry.name).toLowerCase();
      if (!PARSEABLE_EXTENSIONS.has(ext)) continue;

      // Check exclude patterns
      if (matchesAnyPattern(relativePath, excludePatterns)) continue;

      // Check include patterns
      if (matchesAnyPattern(relativePath, patterns)) {
        allFiles.push(relativePath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return allFiles.sort();
}

// ─── Repo Map Generation ─────────────────────────────────────────────

/**
 * Generate a lightweight signature map of the codebase.
 * Parses TypeScript/JavaScript files for export declarations.
 *
 * @param projectRoot - Absolute path to the project root
 * @param patterns - Glob patterns like ["src/**\/*.ts"]
 * @param options - Optional configuration
 * @returns Array of RepoMapEntry sorted by file path
 */
export async function generateRepoMap(
  projectRoot: string,
  patterns: string[],
  options?: RepoMapOptions,
): Promise<RepoMapEntry[]> {
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const excludePatterns = options?.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;

  const files = await findFiles(projectRoot, patterns, excludePatterns);
  const filesToProcess = files.slice(0, maxFiles);

  // Parse each file for exports
  const entries: RepoMapEntry[] = [];
  for (const file of filesToProcess) {
    const absolutePath = path.resolve(projectRoot, file);
    try {
      const content = await fs.readFile(absolutePath, "utf-8");
      const exports = parseExports(content);
      const lineCount = content.split("\n").length;

      entries.push({
        file,
        exports,
        lineCount,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return entries;
}

// ─── Formatting ──────────────────────────────────────────────────────

/**
 * Format repo map entries as a compact string for context inclusion.
 * Target: ~2-5K tokens for a typical project.
 *
 * Output format:
 * ```
 * ## Repository Map
 * src/core/types.ts (428 lines): ParsedTask, TaskContext, AgentResult, ...
 * src/worker/agent-worker.ts (394 lines): runAgent, RunAgentOptions
 * ```
 */
export function formatRepoMap(entries: RepoMapEntry[]): string {
  if (entries.length === 0) {
    return "## Repository Map\n(empty)";
  }

  const lines = entries.map((entry) => {
    const exportsStr = entry.exports.length > 0 ? entry.exports.join(", ") : "(no exports)";
    return `${entry.file} (${entry.lineCount} lines): ${exportsStr}`;
  });

  return `## Repository Map\n${lines.join("\n")}`;
}
