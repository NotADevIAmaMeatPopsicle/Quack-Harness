// ─── Test Mapper ──────────────────────────────────────────────────
// Maps changed source files to their corresponding test files using
// project conventions. Supports both backend and frontend patterns.
//
// Backend conventions:
//   src/src/services/foo.service.js     → src/tests/unit/services/foo.service.test.js
//   src/src/controllers/foo.controller.js → src/tests/unit/controllers/foo.controller.test.js
//   src/src/middleware/foo.js           → src/tests/unit/middleware/foo.test.js
//
// Frontend conventions:
//   frontends/X/src/hooks/useFoo.ts     → frontends/X/src/hooks/__tests__/useFoo.test.ts
//   frontends/X/src/components/Foo.tsx  → frontends/X/src/components/__tests__/Foo.test.tsx
//   frontends/X/src/services/foo.service.ts → frontends/X/src/services/__tests__/foo.service.test.ts
//   frontends/X/src/pages/Y/Foo.tsx     → frontends/X/src/pages/Y/__tests__/Foo.test.tsx

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, extname, relative } from "node:path";

/**
 * Map changed source files to their corresponding unit test files.
 * Returns only test files that actually exist on disk.
 *
 * @param diffFiles - Relative file paths from git diff
 * @param projectRoot - Absolute path to the project root
 * @returns Array of relative test file paths that exist
 */
export function mapChangedFilesToTests(diffFiles: string[], projectRoot: string): string[] {
  const testFiles = new Set<string>();

  for (const file of diffFiles) {
    // Skip non-source files
    if (!isSourceFile(file)) continue;

    // Skip files that are already test files
    if (isTestFile(file)) continue;

    const candidates = generateTestCandidates(file);

    for (const candidate of candidates) {
      const absPath = join(projectRoot, candidate);
      if (existsSync(absPath)) {
        testFiles.add(candidate);
      }
    }
  }

  return [...testFiles];
}

/**
 * Map changed source files to all tests in their module directories
 * plus integration tests matching changed module names.
 * Returns only test files that actually exist on disk.
 * Results are deduplicated against any Tier 1 results.
 *
 * @param diffFiles - Relative file paths from git diff
 * @param projectRoot - Absolute path to the project root
 * @returns Array of relative test file paths that exist
 */
export function mapChangedFilesToModuleTests(
  diffFiles: string[],
  projectRoot: string,
  excludeFiles?: string[],
): string[] {
  const testFiles = new Set<string>();
  const excludeSet = new Set(excludeFiles ?? []);

  // Collect unique module directories from changed files
  const moduleDirs = new Set<string>();
  const moduleNames = new Set<string>();

  for (const file of diffFiles) {
    if (!isSourceFile(file)) continue;

    // Extract the module directory
    const moduleDir = extractModuleDir(file);
    if (moduleDir) {
      moduleDirs.add(moduleDir);
    }

    // Extract module name for integration test matching
    const moduleName = extractModuleName(file);
    if (moduleName) {
      moduleNames.add(moduleName);
    }
  }

  // Find all test files in module directories
  for (const moduleDir of moduleDirs) {
    const testDir = resolveTestDir(moduleDir);
    if (testDir) {
      const absTestDir = join(projectRoot, testDir);
      if (existsSync(absTestDir)) {
        const tests = findTestFilesRecursive(absTestDir);
        for (const testFile of tests) {
          testFiles.add(relative(projectRoot, testFile));
        }
      }
    }

    // For frontend, also check __tests__ directories
    const frontendTestDir = resolveFrontendTestDir(moduleDir);
    if (frontendTestDir) {
      const absTestDir = join(projectRoot, frontendTestDir);
      if (existsSync(absTestDir)) {
        const tests = findTestFilesRecursive(absTestDir);
        for (const testFile of tests) {
          testFiles.add(relative(projectRoot, testFile));
        }
      }
    }
  }

  // Find integration tests matching module names
  for (const moduleName of moduleNames) {
    const integrationDir = findIntegrationTestDir(projectRoot, diffFiles);
    if (integrationDir) {
      const absDir = join(projectRoot, integrationDir);
      if (existsSync(absDir)) {
        const tests = findTestFilesRecursive(absDir);
        for (const testFile of tests) {
          const relPath = relative(projectRoot, testFile);
          const lowerPath = relPath.toLowerCase();
          // Include integration tests that match the module name
          if (lowerPath.includes(moduleName.toLowerCase())) {
            testFiles.add(relPath);
          }
        }
      }
    }
  }

  // Filter out any files that should be excluded (e.g. Tier 1 files)
  if (excludeSet.size > 0) {
    return [...testFiles].filter((f) => !excludeSet.has(f));
  }

  return [...testFiles];
}

// ─── Internal helpers ──────────────────────────────────────────────

function isSourceFile(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext);
}

function isTestFile(file: string): boolean {
  const name = basename(file);
  return name.includes(".test.") || name.includes(".spec.") || file.includes("__tests__");
}

/**
 * Generate candidate test file paths for a given source file.
 */
function generateTestCandidates(sourceFile: string): string[] {
  const candidates: string[] = [];
  const ext = extname(sourceFile);
  const base = basename(sourceFile, ext);

  // ── Backend convention ──
  // src/src/services/foo.service.js → src/tests/unit/services/foo.service.test.js
  const backendMatch = sourceFile.match(/^(.*?)src\/src\/(.+)$/);
  if (backendMatch) {
    const prefix = backendMatch[1]; // e.g. "" or "some/path/"
    const rest = backendMatch[2]; // e.g. "services/foo.service.js"
    const dir = dirname(rest); // e.g. "services"
    const fileName = basename(rest, ext); // e.g. "foo.service"

    candidates.push(`${prefix}src/tests/unit/${dir}/${fileName}.test${ext}`);
    // Also try without "unit/"
    candidates.push(`${prefix}src/tests/${dir}/${fileName}.test${ext}`);
  }

  // ── Frontend convention ──
  // frontends/X/src/hooks/useFoo.ts → frontends/X/src/hooks/__tests__/useFoo.test.ts
  // frontends/X/src/components/Foo.tsx → frontends/X/src/components/__tests__/Foo.test.tsx
  // frontends/X/src/pages/Y/Foo.tsx → frontends/X/src/pages/Y/__tests__/Foo.test.tsx
  const frontendMatch = sourceFile.match(/^(frontends\/[^/]+\/src\/)(.+)$/);
  if (frontendMatch) {
    const frontendPrefix = frontendMatch[1]; // e.g. "frontends/admin-portal/src/"
    const rest = frontendMatch[2]; // e.g. "hooks/useFoo.ts"
    const dir = dirname(rest); // e.g. "hooks"
    const fileName = basename(rest, ext); // e.g. "useFoo"

    // __tests__ in same directory
    candidates.push(`${frontendPrefix}${dir}/__tests__/${fileName}.test${ext}`);

    // Also try .tsx for .ts files and vice versa
    if (ext === ".ts") {
      candidates.push(`${frontendPrefix}${dir}/__tests__/${fileName}.test.tsx`);
    } else if (ext === ".tsx") {
      candidates.push(`${frontendPrefix}${dir}/__tests__/${fileName}.test.ts`);
    }
  }

  // ── Generic convention (co-located tests) ──
  // src/foo.ts → src/foo.test.ts
  const dir = dirname(sourceFile);
  candidates.push(`${dir}/${base}.test${ext}`);
  // tests/ mirror
  candidates.push(`tests/${dir}/${base}.test${ext}`);

  return candidates;
}

/**
 * Extract the module directory from a source file path.
 * For backend: "src/src/services/foo.service.js" → "services"
 * For frontend: "frontends/X/src/hooks/useFoo.ts" → "hooks"
 */
function extractModuleDir(file: string): string | null {
  // Backend: src/src/<module>/...
  const backendMatch = file.match(/^(.*?)src\/src\/([^/]+)/);
  if (backendMatch) {
    return backendMatch[2];
  }

  // Frontend: frontends/X/src/<module>/...
  const frontendMatch = file.match(/^(frontends\/[^/]+\/src\/)([^/]+)/);
  if (frontendMatch) {
    return frontendMatch[2];
  }

  return null;
}

/**
 * Extract a module name from a file path for integration test matching.
 */
function extractModuleName(file: string): string | null {
  const base = basename(file, extname(file));
  // Strip common suffixes: .service, .controller, .middleware
  const cleaned = base
    .replace(/\.(service|controller|middleware|routes?|model|utils?)$/i, "")
    .replace(/^use/, ""); // Strip React hook prefix
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Resolve a backend module directory to its test directory.
 * "services" → "src/tests/unit/services"
 */
function resolveTestDir(moduleDir: string): string | null {
  return `src/tests/unit/${moduleDir}`;
}

/**
 * Resolve a frontend module directory to its __tests__ directory path.
 */
function resolveFrontendTestDir(_moduleDir: string): string | null {
  // This returns a generic pattern; actual usage filters by diffFiles
  return null; // Frontend __tests__ dirs are handled inline
}

/**
 * Find the integration test directory based on changed file paths.
 */
function findIntegrationTestDir(projectRoot: string, _diffFiles: string[]): string | null {
  // Check common integration test locations
  const candidates = ["src/tests/integration", "tests/integration"];
  for (const dir of candidates) {
    if (existsSync(join(projectRoot, dir))) {
      return dir;
    }
  }
  return null;
}

/**
 * Recursively find all test files in a directory.
 */
function findTestFilesRecursive(dir: string): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findTestFilesRecursive(fullPath));
        } else if (isTestFile(entry)) {
          results.push(fullPath);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return results;
}
