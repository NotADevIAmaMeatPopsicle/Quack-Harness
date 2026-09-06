import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ParsedTask,
  TaskContext,
  TestPatternConfig,
  VerificationPattern,
} from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { generateRepoMap, formatRepoMap, parseExports } from "../context/repo-map.js";
import { estimateTokensForContext } from "../context/token-estimator.js";

// ─── Constants ────────────────────────────────────────────────────────

/** Maximum file size in bytes before truncation (50 KB) */
const MAX_FILE_SIZE_BYTES = 50 * 1024;

/** Maximum number of pattern files to include */
const MAX_PATTERN_FILES = 5;

/** Binary file extensions to skip */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

// ─── Helpers ──────────────────────────────────────────────────────────

function hasErrorCode(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isInNodeModules(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("node_modules/") || normalized.includes("node_modules\\");
}

async function readFileSafe(absolutePath: string, knownContent?: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      return null;
    }
    const content = knownContent ?? (await fs.readFile(absolutePath, "utf-8"));
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      const truncated = content.slice(0, MAX_FILE_SIZE_BYTES);
      return `${truncated}\n\n[truncated — file exceeds 50KB limit]`;
    }
    return content;
  } catch (err: unknown) {
    if (hasErrorCode(err) && (err.code === "ENOENT" || err.code === "EISDIR")) {
      return null;
    }
    throw err;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function assertTaskPathsInsideProject(task: ParsedTask, projectRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);
  const canonicalRoot = await fs.realpath(resolvedRoot);

  for (const file of task.filesToModify) {
    const suppliedPath = file.path.trim();
    if (!suppliedPath || path.isAbsolute(suppliedPath) || path.win32.isAbsolute(suppliedPath)) {
      throw new Error(`Unsafe task file path outside project root: ${file.path}`);
    }

    const resolvedPath = path.resolve(resolvedRoot, suppliedPath);
    if (!isPathInside(resolvedRoot, resolvedPath)) {
      throw new Error(`Unsafe task file path outside project root: ${file.path}`);
    }

    // Resolve the closest existing ancestor so paths beneath an in-repo symlink
    // cannot escape the project even when the final file will be created later.
    let existingAncestor = resolvedPath;
    while (existingAncestor !== resolvedRoot) {
      try {
        await fs.lstat(existingAncestor);
        break;
      } catch (err: unknown) {
        if (!hasErrorCode(err) || err.code !== "ENOENT") throw err;
        existingAncestor = path.dirname(existingAncestor);
      }
    }
    const canonicalAncestor = await fs.realpath(existingAncestor);
    if (!isPathInside(canonicalRoot, canonicalAncestor)) {
      throw new Error(`Unsafe task file path resolves outside project root: ${file.path}`);
    }
  }
}

// ─── Convention Loading ───────────────────────────────────────────────

async function loadConventions(
  conventionIds: string[],
  adapter: ProjectAdapter,
): Promise<Record<string, string>> {
  const conventions: Record<string, string> = {};
  const conventionsDir = path.resolve(adapter.projectRoot, adapter.config.project.conventionsDir);

  for (const conventionId of conventionIds) {
    // Try exact filename, then with .md extension
    const candidates = [
      path.join(conventionsDir, conventionId),
      path.join(conventionsDir, `${conventionId}.md`),
    ];

    let found = false;
    for (const candidate of candidates) {
      const content = await readFileSafe(candidate);
      if (content !== null) {
        conventions[conventionId] = content;
        found = true;
        break;
      }
    }

    if (!found) {
      conventions[conventionId] = `Convention not found: ${conventionId}`;
    }
  }

  return conventions;
}

// ─── Relevant Files Loading ───────────────────────────────────────────

async function loadRelevantFiles(task: ParsedTask, projectRoot: string): Promise<string[]> {
  const results: string[] = [];

  for (const fileMod of task.filesToModify) {
    if (isInNodeModules(fileMod.path)) {
      continue;
    }

    if (isBinaryFile(fileMod.path)) {
      continue;
    }

    const absolutePath = path.resolve(projectRoot, fileMod.path);

    if (fileMod.action === "Create") {
      results.push(`--- ${fileMod.path} ---\n[file to be created]`);
      continue;
    }

    // Modify or Delete — read existing file
    const content = await readFileSafe(absolutePath);
    if (content !== null) {
      results.push(`--- ${fileMod.path} ---\n${content}`);
    } else {
      results.push(`--- ${fileMod.path} ---\n[file not found: ${fileMod.path}]`);
    }
  }

  return results;
}

// ─── Related Patterns Discovery ───────────────────────────────────────

/**
 * Discover related sibling files using lazy loading.
 * Instead of including full file contents, includes only file path + exported
 * symbols summary. The agent can use Read/Grep tools to fetch full contents
 * when needed, reducing initial context by ~50%.
 */
async function discoverRelatedPatterns(task: ParsedTask, projectRoot: string): Promise<string[]> {
  const patterns: string[] = [];
  const seenDirs = new Set<string>();
  const taskFilePaths = new Set(task.filesToModify.map((f) => f.path));
  const normalizedTaskPaths = new Set([...taskFilePaths].map((p) => p.replace(/\\/g, "/")));

  for (const fileMod of task.filesToModify) {
    if (patterns.length >= MAX_PATTERN_FILES) {
      break;
    }

    const fileDir = path.dirname(fileMod.path);
    if (seenDirs.has(fileDir)) {
      continue;
    }
    seenDirs.add(fileDir);

    const absoluteDir = path.resolve(projectRoot, fileDir);
    const files = await listFiles(absoluteDir);

    for (const file of files) {
      if (patterns.length >= MAX_PATTERN_FILES) {
        break;
      }

      const relativePath = path.join(fileDir, file).replace(/\\/g, "/");

      // Skip files already included in filesToModify
      if (taskFilePaths.has(relativePath) || normalizedTaskPaths.has(relativePath)) {
        continue;
      }

      // Skip binary and node_modules
      if (isBinaryFile(file) || isInNodeModules(relativePath)) {
        continue;
      }

      // Lazy loading: include only file path + exported symbols summary
      const absolutePath = path.join(absoluteDir, file);
      const content = await readFileSafe(absolutePath);
      if (content !== null) {
        const exports = parseExports(content);
        const lineCount = content.split("\n").length;
        const exportsStr = exports.length > 0 ? exports.join(", ") : "(no exports)";
        patterns.push(`--- ${relativePath} (${lineCount} lines) ---\nExports: ${exportsStr}`);
      }
    }
  }

  return patterns;
}

// ─── Test File Discovery ──────────────────────────────────────────────

async function discoverTestFilesConfigurable(
  task: ParsedTask,
  projectRoot: string,
  testPatterns: TestPatternConfig,
): Promise<string[]> {
  const testFiles: string[] = [];
  const seen = new Set<string>();

  for (const fileMod of task.filesToModify) {
    const filePath = fileMod.path.replace(/\\/g, "/");

    // Check if file is under the configured source directory
    if (!filePath.startsWith(testPatterns.sourceDir)) {
      continue;
    }

    const relativePart = filePath.slice(testPatterns.sourceDir.length);
    const parsed = path.parse(relativePart);

    // Check suffix patterns (e.g., bar.test.ts)
    for (const suffix of testPatterns.suffixes) {
      const candidate = path
        .join(testPatterns.testDir, parsed.dir, `${parsed.name}${suffix}`)
        .replace(/\\/g, "/");

      if (seen.has(candidate)) continue;

      const absolutePath = path.resolve(projectRoot, candidate);
      const content = await readFileSafe(absolutePath);
      if (content !== null) {
        seen.add(candidate);
        testFiles.push(`--- ${candidate} ---\n${content}`);
      }
    }

    // Check prefix patterns (e.g., test_bar.py)
    for (const prefix of testPatterns.prefixes) {
      const candidate = path
        .join(testPatterns.testDir, parsed.dir, `${prefix}${parsed.name}${parsed.ext}`)
        .replace(/\\/g, "/");

      if (seen.has(candidate)) continue;

      const absolutePath = path.resolve(projectRoot, candidate);
      const content = await readFileSafe(absolutePath);
      if (content !== null) {
        seen.add(candidate);
        testFiles.push(`--- ${candidate} ---\n${content}`);
      }
    }

    // Also glob for test files in the corresponding test directory
    const testSubDir = path.resolve(projectRoot, testPatterns.testDir, parsed.dir);
    if (await directoryExists(testSubDir)) {
      const files = await listFiles(testSubDir);
      for (const file of files) {
        const isTestFile =
          testPatterns.suffixes.some((s) => file.endsWith(s)) ||
          testPatterns.prefixes.some((p) => file.startsWith(p));

        if (!isTestFile) continue;

        const testRelPath = path.join(testPatterns.testDir, parsed.dir, file).replace(/\\/g, "/");

        if (seen.has(testRelPath)) continue;

        const absoluteTestPath = path.join(testSubDir, file);
        const content = await readFileSafe(absoluteTestPath);
        if (content !== null) {
          seen.add(testRelPath);
          testFiles.push(`--- ${testRelPath} ---\n${content}`);
        }
      }
    }
  }

  return testFiles;
}

async function discoverTestFilesDefault(task: ParsedTask, projectRoot: string): Promise<string[]> {
  const testFiles: string[] = [];
  const seen = new Set<string>();

  for (const fileMod of task.filesToModify) {
    const filePath = fileMod.path.replace(/\\/g, "/");

    // Convention: src/foo/bar.ts -> tests/foo/bar.test.ts
    const srcMatch = filePath.match(/^src\/(.+)\.(ts|js|tsx|jsx)$/);
    if (srcMatch) {
      const relativePart = srcMatch[1];
      const ext = srcMatch[2];

      const testCandidates = [
        `tests/${relativePart}.test.${ext}`,
        `tests/${relativePart}.spec.${ext}`,
      ];

      for (const candidate of testCandidates) {
        if (seen.has(candidate)) continue;

        const absolutePath = path.resolve(projectRoot, candidate);
        const content = await readFileSafe(absolutePath);
        if (content !== null) {
          seen.add(candidate);
          testFiles.push(`--- ${candidate} ---\n${content}`);
        }
      }

      const testDir = path.resolve(projectRoot, "tests", path.dirname(relativePart));
      if (await directoryExists(testDir)) {
        const files = await listFiles(testDir);
        for (const file of files) {
          if (
            file.endsWith(".test.ts") ||
            file.endsWith(".spec.ts") ||
            file.endsWith(".test.js") ||
            file.endsWith(".spec.js")
          ) {
            const testRelPath = path
              .join("tests", path.dirname(relativePart), file)
              .replace(/\\/g, "/");

            if (seen.has(testRelPath)) continue;

            const absoluteTestPath = path.join(testDir, file);
            const content = await readFileSafe(absoluteTestPath);
            if (content !== null) {
              seen.add(testRelPath);
              testFiles.push(`--- ${testRelPath} ---\n${content}`);
            }
          }
        }
      }
    }
  }

  return testFiles;
}

async function discoverTestFiles(
  task: ParsedTask,
  projectRoot: string,
  testPatterns?: TestPatternConfig,
): Promise<string[]> {
  if (testPatterns) {
    return discoverTestFilesConfigurable(task, projectRoot, testPatterns);
  }
  return discoverTestFilesDefault(task, projectRoot);
}

// ─── Sibling Test Example Discovery ──────────────────────────────────

const MAX_SIBLING_TEST_EXAMPLES = 2;

async function discoverSiblingTestExamples(
  task: ParsedTask,
  projectRoot: string,
  testPatterns?: TestPatternConfig,
): Promise<string[]> {
  const examples: string[] = [];
  const testDir = testPatterns?.testDir ?? "tests/";
  const sourceDir = testPatterns?.sourceDir ?? "src/";

  for (const fileMod of task.filesToModify) {
    if (examples.length >= MAX_SIBLING_TEST_EXAMPLES) break;
    if (fileMod.action !== "Create") continue;

    const filePath = fileMod.path.replace(/\\/g, "/");
    if (!filePath.startsWith(sourceDir)) continue;

    const relativePart = filePath.slice(sourceDir.length);
    const subDir = path.dirname(relativePart);

    // Look for existing test files in the corresponding test directory
    const testSubDir = path.resolve(projectRoot, testDir, subDir);
    if (!(await directoryExists(testSubDir))) continue;

    const files = await listFiles(testSubDir);
    for (const file of files) {
      if (examples.length >= MAX_SIBLING_TEST_EXAMPLES) break;

      const isTestFile =
        file.includes(".test.") ||
        file.includes(".spec.") ||
        file.startsWith("test_") ||
        file.endsWith("_test.go");

      if (!isTestFile) continue;

      const absolutePath = path.join(testSubDir, file);
      const content = await readFileSafe(absolutePath);
      if (content !== null) {
        const relPath = path.join(testDir, subDir, file).replace(/\\/g, "/");
        examples.push(`--- ${relPath} [example test for reference] ---\n${content}`);
        break; // One example per directory is enough
      }
    }
  }

  return examples;
}

// ─── CLAUDE.md Discovery ─────────────────────────────────────────────

async function discoverClaudeMd(projectRoot: string): Promise<string[]> {
  const results: string[] = [];

  // Check project root
  const rootClaudeMd = path.join(projectRoot, "CLAUDE.md");
  const rootContent = await readFileSafe(rootClaudeMd);
  if (rootContent !== null) {
    results.push(`--- CLAUDE.md ---\n${rootContent}`);
  }

  // Check immediate subdirectories
  const subdirs = await listDirectories(projectRoot);
  for (const subdir of subdirs) {
    // Skip common non-project directories
    if (
      subdir === "node_modules" ||
      subdir === ".git" ||
      subdir === "dist" ||
      subdir === "coverage"
    ) {
      continue;
    }

    const subdirClaudeMd = path.join(projectRoot, subdir, "CLAUDE.md");
    const content = await readFileSafe(subdirClaudeMd);
    if (content !== null) {
      results.push(`--- ${subdir}/CLAUDE.md ---\n${content}`);
    }
  }

  return results;
}

// ─── Main Export ──────────────────────────────────────────────────────

export async function assembleContext(
  task: ParsedTask,
  adapter: ProjectAdapter,
  blueprint?: string,
  options?: { blueprintPatterns?: VerificationPattern[] },
): Promise<TaskContext> {
  await assertTaskPathsInsideProject(task, adapter.projectRoot);

  // Merge task conventions with auto-conventions from testPatterns
  const testPatterns = adapter.config.project.testPatterns;
  const autoConventions = testPatterns?.autoConventions ?? [];
  const allConventionIds = [...new Set([...task.conventions, ...autoConventions])];

  const [
    conventions,
    relevantFiles,
    relatedPatterns,
    existingTests,
    siblingTestExamples,
    claudeMd,
    repoMapEntries,
  ] = await Promise.all([
    loadConventions(allConventionIds, adapter),
    loadRelevantFiles(task, adapter.projectRoot),
    discoverRelatedPatterns(task, adapter.projectRoot),
    discoverTestFiles(task, adapter.projectRoot, testPatterns),
    discoverSiblingTestExamples(task, adapter.projectRoot, testPatterns),
    discoverClaudeMd(adapter.projectRoot),
    generateRepoMap(adapter.projectRoot, ["src/**/*.ts", "src/**/*.js"], {
      maxFiles: 200,
    }),
  ]);

  // Format repo map as compact string for context inclusion
  const repoMap = repoMapEntries.length > 0 ? formatRepoMap(repoMapEntries) : undefined;

  const blueprintPatterns = options?.blueprintPatterns;

  // Load template match for "Similar Completed Work" section
  let similarWork: TaskContext["similarWork"];
  try {
    const { loadRegistry } = await import("../templates/template-registry.js");
    const { findBestTemplate } = await import("../templates/template-matcher.js");
    const registry = await loadRegistry(adapter.projectRoot);
    const match = findBestTemplate(task, registry);

    if (match && match.score > 0.3) {
      const sourceTaskDir = path.join(adapter.projectRoot, adapter.config.project.taskDir);
      const resolvedSource = await resolveTaskFile(sourceTaskDir, match.template.sourceTaskId);
      const sourceSpec = resolvedSource
        ? ((await readFileSafe(resolvedSource.filePath, resolvedSource.content)) ?? "")
        : "";

      // Load completed diff (truncate to ~2000 chars at a line boundary)
      const diffPath = path.join(
        adapter.projectRoot,
        ".quack/logs",
        `${match.template.sourceTaskId}-final.diff`,
      );
      const fullDiff = (await readFileSafe(diffPath)) ?? "";
      let truncatedDiff = fullDiff;
      if (fullDiff.length > 2000) {
        // Find the last newline before the 2000 char limit to avoid cutting mid-line
        const cutPoint = fullDiff.lastIndexOf("\n", 2000);
        truncatedDiff = fullDiff.slice(0, cutPoint > 0 ? cutPoint : 2000) + "\n\n[truncated]";
      }

      similarWork = {
        taskId: match.template.sourceTaskId,
        category: match.template.category,
        spec: sourceSpec,
        diff: truncatedDiff,
        matchReasons: match.matchReasons,
      };
    }
  } catch {
    // Template matching is optional - continue without it
  }

  const allTests = [...existingTests, ...siblingTestExamples];

  const context: TaskContext = {
    taskSpec: task.rawContent,
    conventions,
    conventionsSummary: adapter.conventionsDoc,
    relevantFiles,
    relatedPatterns,
    existingTests: allTests,
    claudeMd,
    repoMap,
    blueprint,
    ...(blueprintPatterns ? { blueprintPatterns } : {}),
    ...(similarWork ? { similarWork } : {}),
  };

  // Compute token estimate and trim if over budget
  context.contextSizeEstimate = estimateTokensForContext(context);

  if (!context.contextSizeEstimate.withinBudget) {
    trimContextToBudget(context);
    context.contextSizeEstimate = estimateTokensForContext(context);
  }

  return context;
}

/**
 * Trim context sections to fit within the token budget.
 * Strategy: trim the largest sections first (existingTests, then relevantFiles).
 * Each test/file entry is kept whole or dropped — no mid-file truncation.
 */
function trimContextToBudget(context: TaskContext, budgetTokens = 30_000): void {
  const estimate = () => {
    const e = estimateTokensForContext(context, budgetTokens);
    return e.total;
  };

  // Phase 1: Trim existingTests — drop entries from the end until within budget
  while (context.existingTests.length > 0 && estimate() > budgetTokens) {
    context.existingTests.pop();
  }

  // Phase 2: If still over, trim relevantFiles — drop from the end
  while (context.relevantFiles.length > 0 && estimate() > budgetTokens) {
    context.relevantFiles.pop();
  }
}
