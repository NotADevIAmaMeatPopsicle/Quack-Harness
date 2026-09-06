import { execSync } from "node:child_process";
import type { ParsedTask } from "../core/types.js";
import { worktreeEnv } from "../utils/worktree-env.js";

function isTestFile(filePath: string): boolean {
  return /\.test\.|\.spec\.|(^|\/)tests\//i.test(filePath);
}

function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function resolveDiffBase(workDir: string, baseBranch: string): string {
  const env = worktreeEnv(workDir);

  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const mergeBase = execSync(`git merge-base ${ref} HEAD`, {
        cwd: workDir,
        env,
        encoding: "utf-8",
      }).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // Try the next ref.
    }
  }

  return baseBranch;
}

export function collectScopedTestFiles(
  task: ParsedTask | undefined,
  workDir: string,
  baseBranch: string,
): string[] {
  const testFileSet = new Set<string>();

  for (const file of task?.filesToModify ?? []) {
    if (isTestFile(file.path)) {
      testFileSet.add(file.path);
    }
  }

  try {
    const env = worktreeEnv(workDir);
    const diffBase = resolveDiffBase(workDir, baseBranch);
    const diffFiles = execSync(`git diff --name-only ${diffBase}..HEAD`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
      timeout: 10_000,
    })
      .trim()
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);

    for (const file of diffFiles) {
      if (isTestFile(file)) {
        testFileSet.add(file);
      }
    }
  } catch {
    // Keep the planned task files as the best available scoped set.
  }

  return [...testFileSet];
}

export function buildScopedTestCommand(
  originalCommand: string,
  testFiles: string[],
): string | undefined {
  if (testFiles.length === 0) return undefined;

  const frontendMatch = testFiles
    .map((file) => file.match(/^frontends\/([^/]+)\//))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  const frontendNames = new Set(frontendMatch.map((match) => match[1]));

  if (frontendMatch.length === testFiles.length && frontendNames.size === 1) {
    const frontendName = [...frontendNames][0];
    const frontendRoot = `frontends/${frontendName}`;
    const args = testFiles
      .map((file) => file.slice(frontendRoot.length + 1))
      .map(quoteArg)
      .join(" ");
    return `npm --prefix ${frontendRoot} test -- ${args}`;
  }

  if (testFiles.every((file) => file.startsWith("src/"))) {
    const args = testFiles
      .map((file) => file.slice("src/".length))
      .map(quoteArg)
      .join(" ");
    return `npm --prefix src test -- ${args}`;
  }

  const args = testFiles.map(quoteArg).join(" ");
  return `${originalCommand} -- ${args}`;
}
