// Docker workers intentionally receive no writable authoritative Git metadata.
// A completed private result crosses into the host through this durable,
// restart-safe publication state machine. Every externally visible step is
// either confirmed or remains retryable from an exact sealed Git ref.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { loadAdapter, type ProjectAdapter } from "../core/adapter-loader.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { resolveTargetBranch } from "./branch-resolver.js";
import {
  buildBranchName,
  deleteAfterMerge,
  mergeBranchToTarget,
  updateTaskFileStatus,
} from "./branch-manager.js";
import type { DockerResumeGitBinding, DockerResumeSourceBinding } from "./docker-runtime-bridge.js";
import { createPullRequest } from "./pr-creator.js";

export interface DockerHostPublicationRecoveryInput {
  rootDir: string;
  publicationId: string;
  gitState: DockerResumeGitBinding;
  worktreePath: string;
  worktreeSessionId: string;
  worktreeOwnershipId: string;
  preserveWorktree: boolean;
  sourceResume?: DockerResumeSourceBinding;
}

export interface DockerHostPublicationOptions {
  skipPr?: boolean;
  mergeTargetBranch?: string;
  parentTaskId?: string;
  sharedBranchName?: string;
  recovery?: DockerHostPublicationRecoveryInput;
}

interface PublicationRequirements {
  push: boolean;
  pullRequest: boolean;
  merge: boolean;
  status: boolean;
  cleanup: boolean;
}

interface PublicationProgress {
  promotedAt?: string;
  pushedAt?: string;
  pullRequestAt?: string;
  prUrl?: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  statusAt?: string;
  cleanupLocalAt?: string;
  cleanupAt?: string;
  cleanupOutcome?: string;
}

export interface DockerPublicationJournal {
  version: 1;
  publicationId: string;
  taskId: string;
  projectRoot: string;
  branch: string;
  targetBranch: string;
  parentTaskId?: string;
  sharedBranchName?: string;
  gitState: DockerResumeGitBinding;
  worktreePath: string;
  worktreeSessionId: string;
  worktreeOwnershipId: string;
  preserveWorktree: boolean;
  sourceResume?: DockerResumeSourceBinding;
  requirements: PublicationRequirements;
  progress: PublicationProgress;
  state: "pending" | "complete";
  createdAt: string;
  updatedAt: string;
  lastError?: { step: DockerPublicationStep; detail: string; at: string };
}

export type DockerPublicationStep =
  | "validation"
  | "promotion"
  | "push"
  | "pull-request"
  | "merge"
  | "status"
  | "cleanup";

export class DockerPublicationIncompleteError extends Error {
  constructor(
    readonly step: DockerPublicationStep,
    readonly recoveryPath: string | undefined,
    detail: string,
  ) {
    super(`Docker host publication is incomplete at ${step}: ${detail}`);
    this.name = "DockerPublicationIncompleteError";
  }
}

export interface DockerHostPublicationResult {
  prUrl?: string;
  autoMerged?: boolean;
  mergeCommitSha?: string;
  warnings: string[];
  recoveryPath?: string;
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const HASH_PATTERN = /^[a-f0-9]{40,64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeBranchName(value: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);
  return (
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || forbidden.has(character);
    })
  );
}

function isSafeRef(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) && isSafeBranchName(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function publicationPath(rootDir: string, taskId: string, publicationId: string): string {
  return path.join(rootDir, `${safeTaskId(taskId)}-${publicationId}.json`);
}

function writeJsonAtomic(filePath: string, value: unknown, exclusive = false): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (exclusive) {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

function validateGitState(value: unknown): value is DockerResumeGitBinding {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) =>
      ["authoritativeRef", "baseHead", "candidateHead", "sealedRef"].includes(key),
    ) &&
    isSafeRef(value.authoritativeRef, "refs/heads/") &&
    isSafeRef(value.sealedRef, "refs/quack/docker-publication/") &&
    typeof value.baseHead === "string" &&
    HASH_PATTERN.test(value.baseHead) &&
    typeof value.candidateHead === "string" &&
    HASH_PATTERN.test(value.candidateHead) &&
    value.baseHead.length === value.candidateHead.length &&
    value.baseHead !== value.candidateHead
  );
}

function validateSourceResume(value: unknown): value is DockerResumeSourceBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.archiveName === "string" &&
    path.basename(value.archiveName) === value.archiveName &&
    typeof value.dispatchSessionId === "string" &&
    value.eventSessionId === value.dispatchSessionId &&
    isUuid(value.ownershipId) &&
    ["blueprint", "judge"].includes(String(value.approvedGate)) &&
    isRecord(value.gitState) &&
    isSafeRef(value.gitState.authoritativeRef, "refs/heads/") &&
    isSafeRef(value.gitState.sealedRef, "refs/quack/docker-resume/") &&
    typeof value.gitState.baseHead === "string" &&
    HASH_PATTERN.test(value.gitState.baseHead) &&
    typeof value.gitState.candidateHead === "string" &&
    HASH_PATTERN.test(value.gitState.candidateHead) &&
    (value.approvedDiffHash === undefined ||
      (value.approvedGate === "judge" &&
        typeof value.approvedDiffHash === "string" &&
        /^[a-f0-9]{64}$/i.test(value.approvedDiffHash)))
  );
}

function validateBooleanRecord(value: unknown): value is PublicationRequirements {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    ["push", "pullRequest", "merge", "status", "cleanup"].every(
      (key) => typeof value[key] === "boolean",
    )
  );
}

function validateProgress(value: unknown): value is PublicationProgress {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "promotedAt",
        "pushedAt",
        "pullRequestAt",
        "prUrl",
        "mergedAt",
        "mergeCommitSha",
        "statusAt",
        "cleanupLocalAt",
        "cleanupAt",
        "cleanupOutcome",
      ].includes(key),
    )
  ) {
    return false;
  }
  for (const key of [
    "promotedAt",
    "pushedAt",
    "pullRequestAt",
    "mergedAt",
    "statusAt",
    "cleanupLocalAt",
    "cleanupAt",
  ] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))
    ) {
      return false;
    }
  }
  return (
    (value.prUrl === undefined ||
      (typeof value.prUrl === "string" && /^https?:\/\//i.test(value.prUrl))) &&
    (value.mergeCommitSha === undefined ||
      (typeof value.mergeCommitSha === "string" && HASH_PATTERN.test(value.mergeCommitSha))) &&
    (value.cleanupOutcome === undefined ||
      (typeof value.cleanupOutcome === "string" && value.cleanupOutcome.length <= 1_000))
  );
}

function validateLastError(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.keys(value).every((key) => ["step", "detail", "at"].includes(key)) &&
      ["validation", "promotion", "push", "pull-request", "merge", "status", "cleanup"].includes(
        String(value.step),
      ) &&
      typeof value.detail === "string" &&
      value.detail.length <= 100_000 &&
      typeof value.at === "string" &&
      Number.isFinite(Date.parse(value.at)))
  );
}

function readJournal(filePath: string): DockerPublicationJournal {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256_000) {
    throw new Error("Docker publication recovery has an untrusted file identity");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let parsed: unknown;
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (before.ino !== 0 && opened.ino !== before.ino) ||
      (before.dev !== 0 && opened.dev !== before.dev)
    ) {
      throw new Error("Docker publication recovery changed identity");
    }
    parsed = JSON.parse(fs.readFileSync(fd, "utf-8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isUuid(parsed.publicationId) ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.projectRoot !== "string" ||
    typeof parsed.branch !== "string" ||
    !isSafeBranchName(parsed.branch) ||
    typeof parsed.targetBranch !== "string" ||
    !isSafeBranchName(parsed.targetBranch) ||
    !validateGitState(parsed.gitState) ||
    typeof parsed.worktreePath !== "string" ||
    typeof parsed.worktreeSessionId !== "string" ||
    !isUuid(parsed.worktreeOwnershipId) ||
    typeof parsed.preserveWorktree !== "boolean" ||
    !validateBooleanRecord(parsed.requirements) ||
    !validateProgress(parsed.progress) ||
    !["pending", "complete"].includes(String(parsed.state)) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    typeof parsed.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.updatedAt)) ||
    (parsed.sourceResume !== undefined && !validateSourceResume(parsed.sourceResume)) ||
    Boolean(parsed.parentTaskId) !== Boolean(parsed.sharedBranchName) ||
    (parsed.parentTaskId !== undefined && typeof parsed.parentTaskId !== "string") ||
    (parsed.sharedBranchName !== undefined &&
      (typeof parsed.sharedBranchName !== "string" ||
        !isSafeBranchName(parsed.sharedBranchName))) ||
    !validateLastError(parsed.lastError)
  ) {
    throw new Error("Docker publication recovery has an invalid schema");
  }
  const journal = parsed as unknown as DockerPublicationJournal;
  const requiredProgress: Array<[boolean, keyof PublicationProgress]> = [
    [true, "promotedAt"],
    [journal.requirements.push, "pushedAt"],
    [journal.requirements.pullRequest, "pullRequestAt"],
    [journal.requirements.merge, "mergedAt"],
    [journal.requirements.status, "statusAt"],
    [journal.requirements.cleanup, "cleanupAt"],
  ];
  if (
    journal.publicationId !== journal.worktreeOwnershipId ||
    journal.gitState.authoritativeRef !== `refs/heads/${journal.branch}` ||
    (journal.state === "complete" &&
      requiredProgress.some(
        ([required, key]) => required && journal.progress[key] === undefined,
      )) ||
    (journal.progress.pushedAt !== undefined && journal.progress.promotedAt === undefined) ||
    (journal.progress.pullRequestAt !== undefined &&
      journal.requirements.push &&
      journal.progress.pushedAt === undefined) ||
    (journal.progress.mergedAt !== undefined &&
      journal.requirements.pullRequest &&
      journal.progress.pullRequestAt === undefined) ||
    (journal.progress.statusAt !== undefined && journal.progress.mergedAt === undefined) ||
    (journal.progress.cleanupAt !== undefined && journal.progress.mergedAt === undefined)
  ) {
    throw new Error("Docker publication recovery has inconsistent progress or ownership");
  }
  if (path.basename(filePath) !== `${safeTaskId(journal.taskId)}-${journal.publicationId}.json`) {
    throw new Error("Docker publication recovery filename does not match its ownership");
  }
  return journal;
}

export function readDockerPublicationRecovery(filePath: string): DockerPublicationJournal {
  return readJournal(path.resolve(filePath));
}

export function findDockerPublicationRecovery(
  rootDir: string,
  taskId: string,
): { path: string; journal: DockerPublicationJournal } | undefined {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return undefined;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Docker publication recovery root is not a trusted directory");
  }
  const prefix = `${safeTaskId(taskId)}-`;
  const matches = fs
    .readdirSync(root)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(root, name);
      return { path: filePath, journal: readJournal(filePath) };
    })
    .filter(({ journal }) => journal.taskId === taskId);
  if (matches.length > 1) {
    throw new Error(
      `Multiple Docker publication recoveries exist for ${taskId}; reconcile explicitly`,
    );
  }
  return matches[0];
}

export function clearDockerPublicationRecovery(filePath: string, publicationId: string): boolean {
  try {
    const journal = readJournal(filePath);
    if (journal.publicationId !== publicationId || journal.state !== "complete") return false;
    fs.rmSync(filePath);
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function runGit(projectRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: projectRoot,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function readRef(projectRoot: string, ref: string): Promise<string> {
  const value = await runGit(projectRoot, ["rev-parse", "--verify", ref]);
  if (!HASH_PATTERN.test(value)) throw new Error(`Git ref ${ref} did not resolve to a commit`);
  return value;
}

async function readOptionalRef(projectRoot: string, ref: string): Promise<string | undefined> {
  try {
    const value = await runGit(projectRoot, ["show-ref", "--verify", "--hash", ref]);
    if (!HASH_PATTERN.test(value)) {
      throw new Error(`Git ref ${ref} returned an invalid commit id`);
    }
    return value;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code?: unknown }).code)
        : undefined;
    if (code === 1) return undefined;
    throw error;
  }
}

async function remoteBranchHead(projectRoot: string, branch: string): Promise<string | undefined> {
  const output = await runGit(projectRoot, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/(.+)$/i.exec(output);
  return match?.[2] === branch ? match[1] : undefined;
}

async function pushExactBranch(
  branch: string,
  candidateHead: string,
  projectRoot: string,
): Promise<void> {
  const existing = await remoteBranchHead(projectRoot, branch);
  if (existing === candidateHead) return;
  await runGit(projectRoot, ["push", "-u", "origin", `${candidateHead}:refs/heads/${branch}`]);
  const confirmed = await remoteBranchHead(projectRoot, branch);
  if (confirmed !== candidateHead) {
    throw new Error(`remote branch ${branch} was not confirmed at ${candidateHead}`);
  }
}

async function finishPartiallyDeletedBranch(
  journal: DockerPublicationJournal,
  recoveryPath: string,
): Promise<boolean> {
  const localHead = journal.progress.cleanupLocalAt
    ? undefined
    : await readOptionalRef(journal.projectRoot, journal.gitState.authoritativeRef);
  if (localHead !== undefined) return false;

  const remoteHead = await remoteBranchHead(journal.projectRoot, journal.branch);
  if (remoteHead !== undefined && remoteHead !== journal.gitState.candidateHead) {
    throw new Error(
      `remote branch ${journal.branch} changed after its local cleanup; refusing deletion`,
    );
  }
  if (remoteHead !== undefined) {
    await runGit(journal.projectRoot, ["push", "origin", "--delete", journal.branch]);
    if ((await remoteBranchHead(journal.projectRoot, journal.branch)) !== undefined) {
      throw new Error(`remote branch ${journal.branch} deletion was not confirmed`);
    }
  }
  recordProgress(recoveryPath, journal, {
    cleanupLocalAt: journal.progress.cleanupLocalAt ?? new Date().toISOString(),
    cleanupAt: new Date().toISOString(),
    cleanupOutcome: "deleted",
  });
  return true;
}

async function inspectMergedPullRequest(
  projectRoot: string,
  prUrl: string,
): Promise<{ merged: boolean; mergeCommitSha?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", prUrl, "--json", "state,mergeCommit"],
      { cwd: projectRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || parsed.state !== "MERGED") return { merged: false };
    const mergeCommit = parsed.mergeCommit;
    const oid =
      isRecord(mergeCommit) &&
      typeof mergeCommit.oid === "string" &&
      HASH_PATTERN.test(mergeCommit.oid)
        ? mergeCommit.oid
        : undefined;
    return { merged: true, ...(oid ? { mergeCommitSha: oid } : {}) };
  } catch {
    return { merged: false };
  }
}

function isFinalSharedSubtask(successCriteria: readonly string[]): boolean {
  return successCriteria.some((criterion) =>
    criterion.toLowerCase().includes("all parent task success criteria verified"),
  );
}

function publicationBody(taskId: string, rawTask: string): string {
  const criteria = rawTask.match(/## Success Criteria\s*\n([\s\S]*?)(?=\n##|\n*$)/)?.[1]?.trim();
  return [
    `## Task: ${taskId}`,
    "",
    "This branch was produced in a Docker-isolated Quack worktree. Git objects and the task ref were validated and promoted by the host before this pull request was created.",
    ...(criteria ? ["", "## Success Criteria", criteria] : []),
    "",
    "---",
    "*Generated by Quack Agent*",
  ].join("\n");
}

function requiredSteps(
  adapter: ProjectAdapter,
  sharedDispatch: boolean,
  finalSharedDispatch: boolean,
  skipPr: boolean,
): PublicationRequirements {
  const terminalShared = !sharedDispatch || finalSharedDispatch;
  const merge = terminalShared && adapter.config.git.autoMerge === true;
  return {
    push: adapter.config.git.autoPush !== false,
    pullRequest: terminalShared && adapter.config.git.autoCreatePr === true && !skipPr,
    merge,
    status: merge,
    cleanup: merge,
  };
}

function sameRequirements(left: PublicationRequirements, right: PublicationRequirements): boolean {
  return (Object.keys(left) as Array<keyof PublicationRequirements>).every(
    (key) => left[key] === right[key],
  );
}

function recordProgress(
  recoveryPath: string,
  journal: DockerPublicationJournal,
  patch: Partial<PublicationProgress>,
): void {
  journal.progress = { ...journal.progress, ...patch };
  journal.updatedAt = new Date().toISOString();
  delete journal.lastError;
  writeJsonAtomic(recoveryPath, journal);
}

function recordFailure(
  recoveryPath: string | undefined,
  journal: DockerPublicationJournal | undefined,
  step: DockerPublicationStep,
  error: unknown,
): DockerPublicationIncompleteError {
  const detail = error instanceof Error ? error.message : String(error);
  if (recoveryPath && journal) {
    journal.lastError = { step, detail, at: new Date().toISOString() };
    journal.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(recoveryPath, journal);
    } catch {
      return new DockerPublicationIncompleteError(
        step,
        recoveryPath,
        `${detail}; additionally failed to persist the retry error`,
      );
    }
  }
  return new DockerPublicationIncompleteError(step, recoveryPath, detail);
}

async function withRecoveryLock<T>(recoveryPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${recoveryPath}.lock`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "EEXIST") {
      throw new DockerPublicationIncompleteError(
        "validation",
        recoveryPath,
        "another publisher owns the durable recovery lock",
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.rmSync(lockPath);
    } catch {
      // A retained lock fails closed after an abnormal filesystem error.
    }
  }
}

async function resolvePublicationContext(
  taskId: string,
  projectRoot: string,
  branch: string,
  options: DockerHostPublicationOptions,
): Promise<{
  adapter: ProjectAdapter;
  targetBranch: string;
  requirements: PublicationRequirements;
  rawTask: string;
  title: string;
}> {
  const adapter = await loadAdapter(projectRoot);
  if (Boolean(options.parentTaskId) !== Boolean(options.sharedBranchName)) {
    throw new Error(
      `Docker host publication for ${taskId} requires paired parentTaskId and sharedBranchName`,
    );
  }
  const expectedBranch = options.parentTaskId
    ? buildBranchName(options.parentTaskId, adapter)
    : buildBranchName(taskId, adapter);
  if (options.sharedBranchName && options.sharedBranchName !== expectedBranch) {
    throw new Error(
      `Docker host publication refused shared branch ${options.sharedBranchName}; expected ${expectedBranch}`,
    );
  }
  if (branch !== expectedBranch || !isSafeBranchName(branch)) {
    throw new Error(`Docker host publication refused branch ${branch}; expected ${expectedBranch}`);
  }
  const taskPath = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const resolved = await resolveTaskFile(taskPath, taskId);
  if (!resolved || resolved.duplicateClaimants.length > 1) {
    throw new Error(`Docker host publication could not resolve one authoritative ${taskId} spec`);
  }
  const resolvedTarget = resolveTargetBranch(
    taskId,
    resolved.task?.targetBranch,
    adapter.config.git,
  );
  const targetBranch = options.mergeTargetBranch ?? resolvedTarget.autoMergeTarget;
  if (!isSafeBranchName(targetBranch))
    throw new Error("Docker publication target branch is unsafe");
  const sharedDispatch = Boolean(options.parentTaskId);
  const finalSharedDispatch = sharedDispatch
    ? isFinalSharedSubtask(resolved.task?.successCriteria ?? [])
    : false;
  return {
    adapter,
    targetBranch,
    requirements: requiredSteps(
      adapter,
      sharedDispatch,
      finalSharedDispatch,
      options.skipPr === true,
    ),
    rawTask: resolved.content,
    title: resolved.task?.title ?? taskId,
  };
}

function createOrReadJournal(
  taskId: string,
  projectRoot: string,
  branch: string,
  targetBranch: string,
  requirements: PublicationRequirements,
  options: DockerHostPublicationOptions,
): { recoveryPath?: string; journal?: DockerPublicationJournal } {
  if (!options.recovery) return {};
  const recovery = options.recovery;
  if (!isUuid(recovery.publicationId) || !validateGitState(recovery.gitState)) {
    throw new Error("Docker publication recovery identity is invalid");
  }
  if (recovery.worktreeOwnershipId !== recovery.publicationId) {
    throw new Error(
      "Docker publication recovery is not bound to the worktree ownership generation",
    );
  }
  const rootDir = path.resolve(recovery.rootDir);
  fs.mkdirSync(rootDir, { recursive: true });
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Docker publication recovery root is not a trusted directory");
  }
  const recoveryPath = publicationPath(rootDir, taskId, recovery.publicationId);
  if (fs.existsSync(recoveryPath)) {
    const existing = readJournal(recoveryPath);
    if (
      existing.taskId !== taskId ||
      existing.publicationId !== recovery.publicationId ||
      existing.projectRoot !== fs.realpathSync.native(projectRoot) ||
      existing.branch !== branch ||
      existing.targetBranch !== targetBranch ||
      existing.worktreePath !== fs.realpathSync.native(recovery.worktreePath) ||
      existing.worktreeSessionId !== recovery.worktreeSessionId ||
      existing.worktreeOwnershipId !== recovery.worktreeOwnershipId ||
      existing.preserveWorktree !== recovery.preserveWorktree ||
      existing.parentTaskId !== options.parentTaskId ||
      existing.sharedBranchName !== options.sharedBranchName ||
      !isDeepStrictEqual(existing.gitState, recovery.gitState) ||
      !isDeepStrictEqual(existing.sourceResume, recovery.sourceResume) ||
      !sameRequirements(existing.requirements, requirements)
    ) {
      throw new Error("Docker publication recovery already exists with different ownership");
    }
    return { recoveryPath, journal: existing };
  }
  const now = new Date().toISOString();
  const journal: DockerPublicationJournal = {
    version: 1,
    publicationId: recovery.publicationId,
    taskId,
    projectRoot: fs.realpathSync.native(projectRoot),
    branch,
    targetBranch,
    ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    ...(options.sharedBranchName ? { sharedBranchName: options.sharedBranchName } : {}),
    gitState: recovery.gitState,
    worktreePath: fs.realpathSync.native(recovery.worktreePath),
    worktreeSessionId: recovery.worktreeSessionId,
    worktreeOwnershipId: recovery.worktreeOwnershipId,
    preserveWorktree: recovery.preserveWorktree,
    ...(recovery.sourceResume ? { sourceResume: recovery.sourceResume } : {}),
    requirements,
    progress: {},
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(recoveryPath, journal, true);
  return { recoveryPath, journal };
}

async function executePublication(
  journal: DockerPublicationJournal,
  recoveryPath: string,
  context: Awaited<ReturnType<typeof resolvePublicationContext>>,
): Promise<DockerHostPublicationResult> {
  const { adapter, requirements, rawTask, title } = context;
  const projectRoot = fs.realpathSync.native(adapter.projectRoot);
  if (
    journal.projectRoot !== projectRoot ||
    journal.branch !== journal.gitState.authoritativeRef.slice("refs/heads/".length) ||
    journal.targetBranch !== context.targetBranch ||
    !sameRequirements(journal.requirements, requirements)
  ) {
    throw recordFailure(recoveryPath, journal, "validation", "publication contract changed");
  }
  if (journal.state === "complete") {
    return {
      ...(journal.progress.prUrl ? { prUrl: journal.progress.prUrl } : {}),
      ...(journal.progress.mergedAt ? { autoMerged: true } : {}),
      ...(journal.progress.mergeCommitSha
        ? { mergeCommitSha: journal.progress.mergeCommitSha }
        : {}),
      warnings: [],
      recoveryPath,
    };
  }

  if (!journal.progress.promotedAt) {
    try {
      const sealedHead = await readRef(projectRoot, journal.gitState.sealedRef);
      if (sealedHead !== journal.gitState.candidateHead) {
        throw new Error("sealed publication ref no longer matches the candidate commit");
      }
      await runGit(projectRoot, [
        "merge-base",
        "--is-ancestor",
        journal.gitState.baseHead,
        journal.gitState.candidateHead,
      ]);
      const current = await readRef(projectRoot, journal.gitState.authoritativeRef);
      if (current === journal.gitState.baseHead) {
        await runGit(projectRoot, [
          "update-ref",
          journal.gitState.authoritativeRef,
          journal.gitState.candidateHead,
          journal.gitState.baseHead,
        ]);
      } else if (current !== journal.gitState.candidateHead) {
        throw new Error("authoritative branch changed before publication promotion");
      }
      const confirmed = await readRef(projectRoot, journal.gitState.authoritativeRef);
      if (confirmed !== journal.gitState.candidateHead) {
        throw new Error("authoritative branch promotion was not confirmed");
      }
      recordProgress(recoveryPath, journal, { promotedAt: new Date().toISOString() });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "promotion", error);
    }
  }

  if (requirements.push && !journal.progress.pushedAt) {
    try {
      await pushExactBranch(journal.branch, journal.gitState.candidateHead, projectRoot);
      recordProgress(recoveryPath, journal, { pushedAt: new Date().toISOString() });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "push", error);
    }
  }

  if (requirements.pullRequest && !journal.progress.pullRequestAt) {
    try {
      const created = await createPullRequest(
        {
          taskId: journal.taskId,
          title: `[${journal.taskId}] ${title}`,
          body: publicationBody(journal.taskId, rawTask),
          baseBranch: journal.targetBranch,
          headBranch: journal.branch,
        },
        adapter,
      );
      if (!created.success || !created.prUrl) {
        throw new Error(
          created.error ?? `Pull request URL was not confirmed for ${journal.taskId}`,
        );
      }
      recordProgress(recoveryPath, journal, {
        pullRequestAt: new Date().toISOString(),
        prUrl: created.prUrl,
      });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "pull-request", error);
    }
  }

  if (requirements.merge && !journal.progress.mergedAt) {
    try {
      const alreadyMerged = journal.progress.prUrl
        ? await inspectMergedPullRequest(projectRoot, journal.progress.prUrl)
        : { merged: false as const };
      const merged = alreadyMerged.merged
        ? { success: true as const, mergeCommitSha: alreadyMerged.mergeCommitSha }
        : await mergeBranchToTarget(
            journal.taskId,
            adapter,
            journal.progress.prUrl,
            journal.targetBranch,
            undefined,
            journal.branch,
          );
      if (!merged.success) {
        throw new Error(merged.error ?? `Failed to auto-merge ${journal.branch}`);
      }
      recordProgress(recoveryPath, journal, {
        mergedAt: new Date().toISOString(),
        ...(merged.mergeCommitSha ? { mergeCommitSha: merged.mergeCommitSha } : {}),
      });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "merge", error);
    }
  }

  if (requirements.status && !journal.progress.statusAt) {
    try {
      const status = await updateTaskFileStatus(journal.taskId, adapter, journal.targetBranch);
      if (!status.success) {
        throw new Error(status.error ?? `Failed to update ${journal.taskId} status`);
      }
      recordProgress(recoveryPath, journal, { statusAt: new Date().toISOString() });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "status", error);
    }
  }

  const warnings: string[] = [];
  if (requirements.cleanup && !journal.progress.cleanupAt) {
    try {
      if (!(await finishPartiallyDeletedBranch(journal, recoveryPath))) {
        const cleanup = await deleteAfterMerge(journal.branch, adapter);
        if (cleanup.deleted && cleanup.localDeleted) {
          recordProgress(recoveryPath, journal, { cleanupLocalAt: new Date().toISOString() });
        }
        if (
          cleanup.reason === "delete-failed" ||
          (cleanup.deleted && cleanup.remoteDeleted === false)
        ) {
          throw new Error(cleanup.reason ?? `Failed to delete ${journal.branch} after merge`);
        }
        const outcome = cleanup.deleted ? "deleted" : (cleanup.reason ?? "policy-skipped");
        if (!cleanup.deleted) warnings.push(outcome);
        recordProgress(recoveryPath, journal, {
          cleanupAt: new Date().toISOString(),
          cleanupOutcome: outcome,
        });
      }
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "cleanup", error);
    }
  }

  try {
    journal.state = "complete";
    journal.updatedAt = new Date().toISOString();
    delete journal.lastError;
    writeJsonAtomic(recoveryPath, journal);
  } catch (error: unknown) {
    journal.state = "pending";
    throw recordFailure(recoveryPath, journal, "cleanup", error);
  }
  return {
    ...(journal.progress.prUrl ? { prUrl: journal.progress.prUrl } : {}),
    ...(journal.progress.mergedAt ? { autoMerged: true } : {}),
    ...(journal.progress.mergeCommitSha ? { mergeCommitSha: journal.progress.mergeCommitSha } : {}),
    warnings,
    recoveryPath,
  };
}

export async function resumeDockerPromotedResult(
  projectRoot: string,
  recoveryPath: string,
): Promise<DockerHostPublicationResult> {
  const resolvedPath = path.resolve(recoveryPath);
  return withRecoveryLock(resolvedPath, async () => {
    const journal = readJournal(resolvedPath);
    const options: DockerHostPublicationOptions = {
      ...(journal.parentTaskId ? { parentTaskId: journal.parentTaskId } : {}),
      ...(journal.sharedBranchName ? { sharedBranchName: journal.sharedBranchName } : {}),
      skipPr: !journal.requirements.pullRequest,
      mergeTargetBranch: journal.targetBranch,
    };
    let context: Awaited<ReturnType<typeof resolvePublicationContext>>;
    try {
      context = await resolvePublicationContext(
        journal.taskId,
        projectRoot,
        journal.branch,
        options,
      );
    } catch (error: unknown) {
      throw recordFailure(resolvedPath, journal, "validation", error);
    }
    return executePublication(journal, resolvedPath, context);
  });
}

export async function publishDockerPromotedResult(
  taskId: string,
  projectRoot: string,
  promotedBranch: string,
  options: DockerHostPublicationOptions = {},
): Promise<DockerHostPublicationResult> {
  if (!options.recovery) {
    throw new DockerPublicationIncompleteError(
      "validation",
      undefined,
      "durable recovery ownership is required before host publication",
    );
  }
  let context: Awaited<ReturnType<typeof resolvePublicationContext>>;
  try {
    context = await resolvePublicationContext(taskId, projectRoot, promotedBranch, options);
  } catch (error: unknown) {
    throw recordFailure(undefined, undefined, "validation", error);
  }

  const { recoveryPath, journal } = createOrReadJournal(
    taskId,
    projectRoot,
    promotedBranch,
    context.targetBranch,
    context.requirements,
    options,
  );
  if (recoveryPath && journal) {
    return withRecoveryLock(recoveryPath, () => executePublication(journal, recoveryPath, context));
  }
  // createOrReadJournal only omits these when no recovery binding was
  // supplied. That is rejected above; keep this fail-closed assertion so a
  // future refactor cannot silently reintroduce publication without a
  // durable retry pointer.
  throw new DockerPublicationIncompleteError(
    "validation",
    undefined,
    "durable Docker publication journal was not established",
  );
}
