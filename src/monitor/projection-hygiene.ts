import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const GENERATED_PROJECTION_PATHS = [
  ".quack/verified.json",
  ".quack/reviews/latest-by-task.json",
] as const;

export type GeneratedProjectionPath = (typeof GENERATED_PROJECTION_PATHS)[number];

export type ProjectionHygieneStatus =
  | "ok"
  | "ignore_missing"
  | "migration_required"
  | "not_git_repository"
  | "git_unavailable";

export interface GeneratedProjectionFileHygiene {
  path: GeneratedProjectionPath;
  exists: boolean;
  tracked: boolean;
  ignored: boolean;
}

export interface ProjectionHygieneResult {
  status: ProjectionHygieneStatus;
  projectRoot: string;
  generatedFiles: GeneratedProjectionFileHygiene[];
  trackedGeneratedFiles: GeneratedProjectionPath[];
  missingGitignoreEntries: GeneratedProjectionPath[];
  recommendedCommand: string | null;
  message: string;
}

export interface ProjectionHygieneMigrationAction {
  kind: "append_gitignore" | "git_rm_cached";
  path: string;
  applied: boolean;
}

export interface ProjectionHygieneMigrationResult {
  before: ProjectionHygieneResult;
  after: ProjectionHygieneResult;
  dryRun: boolean;
  actions: ProjectionHygieneMigrationAction[];
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function outputToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : "";
}

function runGit(projectRoot: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const execError = err as {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    return {
      exitCode: execError.status ?? 1,
      stdout: outputToString(execError.stdout),
      stderr: outputToString(execError.stderr) || execError.message || "git command failed",
    };
  }
}

function isGitRepo(projectRoot: string): "yes" | "no" | "unavailable" {
  const result = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (result.exitCode === 0 && result.stdout.trim() === "true") return "yes";
  if (/not recognized|ENOENT|spawn git/i.test(result.stderr)) return "unavailable";
  return "no";
}

function normalizeProjectionPath(filePath: string): GeneratedProjectionPath {
  return filePath.replace(/\\/gu, "/") as GeneratedProjectionPath;
}

function isTracked(projectRoot: string, filePath: GeneratedProjectionPath): boolean {
  return runGit(projectRoot, ["ls-files", "--error-unmatch", "--", filePath]).exitCode === 0;
}

function isIgnored(projectRoot: string, filePath: GeneratedProjectionPath): boolean {
  return runGit(projectRoot, ["check-ignore", "--no-index", "-q", "--", filePath]).exitCode === 0;
}

function buildRecommendedCommand(projectRoot: string): string {
  return `quack repair-state --project "${projectRoot}" --migrate-generated-projections --dry-run`;
}

export function inspectGeneratedProjectionHygiene(
  projectRootInput: string,
): ProjectionHygieneResult {
  const projectRoot = path.resolve(projectRootInput);
  const repoStatus = isGitRepo(projectRoot);
  if (repoStatus === "unavailable") {
    return {
      status: "git_unavailable",
      projectRoot,
      generatedFiles: [],
      trackedGeneratedFiles: [],
      missingGitignoreEntries: [],
      recommendedCommand: null,
      message: "Git is unavailable, so generated projection hygiene could not be checked.",
    };
  }
  if (repoStatus === "no") {
    return {
      status: "not_git_repository",
      projectRoot,
      generatedFiles: [],
      trackedGeneratedFiles: [],
      missingGitignoreEntries: [],
      recommendedCommand: null,
      message: "Project root is not a git repository.",
    };
  }

  const generatedFiles = GENERATED_PROJECTION_PATHS.map((filePath) => ({
    path: filePath,
    exists: fs.existsSync(path.join(projectRoot, filePath)),
    tracked: isTracked(projectRoot, filePath),
    ignored: isIgnored(projectRoot, filePath),
  }));
  const trackedGeneratedFiles = generatedFiles
    .filter((file) => file.tracked)
    .map((file) => file.path);
  const missingGitignoreEntries = generatedFiles
    .filter((file) => !file.ignored)
    .map((file) => file.path);

  let status: ProjectionHygieneStatus = "ok";
  let message = "Generated Quack projections are untracked and ignored.";
  if (trackedGeneratedFiles.length > 0) {
    status = "migration_required";
    message = "Generated Quack projections are still tracked by git.";
  } else if (missingGitignoreEntries.length > 0) {
    status = "ignore_missing";
    message = "Generated Quack projections are untracked but not ignored for future regenerations.";
  }

  return {
    status,
    projectRoot,
    generatedFiles,
    trackedGeneratedFiles,
    missingGitignoreEntries,
    recommendedCommand: status === "ok" ? null : buildRecommendedCommand(projectRoot),
    message,
  };
}

function readGitignore(projectRoot: string): string {
  try {
    return fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf-8");
  } catch {
    return "";
  }
}

function appendGitignoreEntries(projectRoot: string, entries: GeneratedProjectionPath[]): void {
  if (entries.length === 0) return;
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const current = readGitignore(projectRoot);
  const prefix = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const section = ["# Quack generated projections", ...entries].join("\n");
  fs.appendFileSync(gitignorePath, `${prefix}${section}\n`, "utf-8");
}

export function migrateGeneratedProjectionHygiene(
  projectRootInput: string,
  options: { dryRun?: boolean } = {},
): ProjectionHygieneMigrationResult {
  const projectRoot = path.resolve(projectRootInput);
  const before = inspectGeneratedProjectionHygiene(projectRoot);
  const dryRun = options.dryRun !== false;
  const actions: ProjectionHygieneMigrationAction[] = [];

  if (before.status === "not_git_repository" || before.status === "git_unavailable") {
    return {
      before,
      after: before,
      dryRun,
      actions,
    };
  }

  for (const filePath of before.missingGitignoreEntries) {
    actions.push({
      kind: "append_gitignore",
      path: filePath,
      applied: !dryRun,
    });
  }
  if (!dryRun) {
    appendGitignoreEntries(projectRoot, before.missingGitignoreEntries);
  }

  for (const filePath of before.trackedGeneratedFiles.map(normalizeProjectionPath)) {
    actions.push({
      kind: "git_rm_cached",
      path: filePath,
      applied: !dryRun,
    });
    if (!dryRun) {
      const result = runGit(projectRoot, [
        "rm",
        "--cached",
        "-f",
        "--ignore-unmatch",
        "--",
        filePath,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `git rm --cached failed for ${filePath}: ${result.stderr || result.stdout}`,
        );
      }
    }
  }

  const after = dryRun ? before : inspectGeneratedProjectionHygiene(projectRoot);
  return {
    before,
    after,
    dryRun,
    actions,
  };
}
