import type { ParsedTask } from "../core/types.js";
import { runTrustedGitSync } from "../dispatcher/trusted-git.js";

function isTestFile(filePath: string): boolean {
  return /\.test\.|\.spec\.|(^|\/)tests\//i.test(filePath);
}

function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function validateBaseBranch(baseBranch: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) ||
    baseBranch.includes("..") ||
    baseBranch.includes("@{") ||
    baseBranch.endsWith("/") ||
    baseBranch.endsWith(".")
  ) {
    throw new Error(`Unsafe base branch name: ${baseBranch}`);
  }
  return baseBranch;
}

function resolveDiffBase(workDir: string, baseBranch: string): string {
  const validatedBaseBranch = validateBaseBranch(baseBranch);

  for (const ref of [`origin/${validatedBaseBranch}`, validatedBaseBranch]) {
    try {
      const mergeBase = runTrustedGitSync(["merge-base", ref, "HEAD"], workDir, {
        timeoutMs: 10_000,
        maxBuffer: 1024 * 1024,
      }).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // Try the next ref.
    }
  }

  return validatedBaseBranch;
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
    const diffBase = resolveDiffBase(workDir, baseBranch);
    const diffFiles = runTrustedGitSync(
      ["diff", "--name-only", "-z", `${diffBase}..HEAD`],
      workDir,
      {
        timeoutMs: 10_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    )
      .split("\0")
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
