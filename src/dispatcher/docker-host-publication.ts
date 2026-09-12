// Docker workers intentionally receive no writable authoritative Git metadata.
// A completed private result crosses into the host through this durable,
// restart-safe publication state machine. Every externally visible step is
// either confirmed or remains retryable from an exact sealed Git ref.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import {
  findDockerPublicationRecovery as findDurableDockerPublicationRecovery,
  reconcileDockerPublicationRecoveryArtifacts,
} from "./docker-publication-recovery.js";
import {
  ensureDirectoryDurably,
  removeFileDurably,
  trustedWindowsPowerShellPath,
  writeJsonAtomicDurable,
} from "./durable-json-file.js";
import {
  isGitOriginBinding,
  persistentOriginRepositoryBinding,
  resolveBoundOriginRepository,
  resolveOriginRepository,
  type GitOriginBinding,
} from "./github-repository.js";
import {
  createPullRequest,
  recoverPullRequestCandidate,
  type PullRequestBinding,
  type PullRequestCandidate,
} from "./pr-creator.js";
import { runTrustedGitResult, type TrustedGitHubRepository } from "../worker/trusted-executable.js";

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
  pullRequestCandidate?: PullRequestCandidate & { recordedAt: string };
  pullRequestAt?: string;
  prUrl?: string;
  preparedMerge?: DockerPreparedTargetMerge & { preparedAt: string };
  mergedAt?: string;
  mergeCommitSha?: string;
  statusAt?: string;
  cleanupLocalAt?: string;
  cleanupAt?: string;
  cleanupOutcome?: string;
}

/** Durable no-PR merge preparation contract consumed by branch-manager integration. */
export interface DockerPreparedTargetMerge {
  strategy: "merge" | "rebase" | "squash";
  candidateHead: string;
  targetHead: string;
  resultHead: string;
  preparedRef: string;
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
  /** Exact origin identity persisted without credential-bearing URL text. */
  repository?: GitOriginBinding;
  gitState: DockerResumeGitBinding;
  worktreePath: string;
  worktreeSessionId: string;
  worktreeOwnershipId: string;
  preserveWorktree: boolean;
  sourceResume?: DockerResumeSourceBinding;
  requirements: PublicationRequirements;
  progress: PublicationProgress;
  state: "pending" | "complete";
  generation?: number;
  previousDigest?: string;
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
  const forbidden = new Set([
    "~",
    "^",
    ":",
    "?",
    "*",
    "[",
    "]",
    "\\",
    ";",
    "&",
    "|",
    "<",
    ">",
    "`",
    "$",
    "!",
    "'",
    '"',
    "(",
    ")",
    "{",
    "}",
  ]);
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

function preparedPublicationRef(sealedRef: string): string {
  return sealedRef.replace(
    "refs/quack/docker-publication/",
    "refs/quack/docker-publication-prepared/",
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function writeJsonAtomic(filePath: string, value: unknown, exclusive = false): void {
  writeJsonAtomicDurable(filePath, value, exclusive);
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
        "pullRequestCandidate",
        "pullRequestAt",
        "prUrl",
        "preparedMerge",
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
    (value.pullRequestCandidate === undefined ||
      validatePullRequestCandidate(value.pullRequestCandidate)) &&
    (value.prUrl === undefined ||
      (typeof value.prUrl === "string" && /^https?:\/\//i.test(value.prUrl))) &&
    (value.preparedMerge === undefined || validatePreparedMerge(value.preparedMerge)) &&
    (value.mergeCommitSha === undefined ||
      (typeof value.mergeCommitSha === "string" && HASH_PATTERN.test(value.mergeCommitSha))) &&
    (value.cleanupOutcome === undefined ||
      (typeof value.cleanupOutcome === "string" && value.cleanupOutcome.length <= 1_000))
  );
}

function validatePullRequestCandidate(
  value: unknown,
): value is PullRequestCandidate & { recordedAt: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !Object.keys(value).every((key) =>
      ["url", "ownershipMarker", "state", "recordedAt"].includes(key),
    ) ||
    typeof value.url !== "string" ||
    typeof value.ownershipMarker !== "string" ||
    !["pending", "accepted", "closed"].includes(String(value.state)) ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function validatePreparedMerge(
  value: unknown,
): value is DockerPreparedTargetMerge & { preparedAt: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 6 &&
    Object.keys(value).every((key) =>
      [
        "strategy",
        "candidateHead",
        "targetHead",
        "resultHead",
        "preparedRef",
        "preparedAt",
      ].includes(key),
    ) &&
    ["merge", "rebase", "squash"].includes(String(value.strategy)) &&
    typeof value.candidateHead === "string" &&
    HASH_PATTERN.test(value.candidateHead) &&
    typeof value.targetHead === "string" &&
    HASH_PATTERN.test(value.targetHead) &&
    typeof value.resultHead === "string" &&
    HASH_PATTERN.test(value.resultHead) &&
    isSafeRef(value.preparedRef, "refs/quack/docker-publication-prepared/") &&
    value.candidateHead.length === value.targetHead.length &&
    value.candidateHead.length === value.resultHead.length &&
    value.targetHead !== value.resultHead &&
    typeof value.preparedAt === "string" &&
    Number.isFinite(Date.parse(value.preparedAt))
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
  reconcileDockerPublicationRecoveryArtifacts(filePath);
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
    (parsed.generation !== undefined &&
      (!Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0)) ||
    (parsed.previousDigest !== undefined &&
      (typeof parsed.previousDigest !== "string" ||
        !/^[a-f0-9]{64}$/iu.test(parsed.previousDigest))) ||
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
  const requiresRemote = Object.values(journal.requirements).some(Boolean);
  const generation = journal.generation ?? 0;
  const requiredProgress: Array<[boolean, keyof PublicationProgress]> = [
    [true, "promotedAt"],
    [journal.requirements.push, "pushedAt"],
    [journal.requirements.pullRequest, "pullRequestAt"],
    [journal.requirements.merge, "mergedAt"],
    [journal.requirements.status, "statusAt"],
    [journal.requirements.cleanup, "cleanupAt"],
  ];
  const expectedOwnershipMarker = publicationOwnershipMarker(journal.publicationId);
  const candidate = journal.progress.pullRequestCandidate;
  const candidateMatchesRepository = (() => {
    if (!candidate || !journal.repository?.github) return candidate === undefined;
    try {
      const parsed = new URL(candidate.url);
      return (
        parsed.host.toLowerCase() === journal.repository.github.host.toLowerCase() &&
        parsed.pathname
          .toLowerCase()
          .startsWith(`/${journal.repository.github.nameWithOwner.toLowerCase()}/pull/`)
      );
    } catch {
      return false;
    }
  })();
  if (
    journal.publicationId !== journal.worktreeOwnershipId ||
    Boolean(journal.repository) !== requiresRemote ||
    (journal.repository !== undefined && !isGitOriginBinding(journal.repository)) ||
    (journal.requirements.pullRequest && !journal.repository?.github) ||
    (generation === 0
      ? journal.previousDigest !== undefined
      : journal.previousDigest === undefined) ||
    journal.gitState.authoritativeRef !== `refs/heads/${journal.branch}` ||
    Boolean(journal.progress.pullRequestAt) !== Boolean(journal.progress.prUrl) ||
    (journal.progress.prUrl !== undefined && !journal.requirements.pullRequest) ||
    (candidate !== undefined &&
      (!journal.requirements.pullRequest ||
        candidate.ownershipMarker !== expectedOwnershipMarker ||
        !candidateMatchesRepository ||
        (journal.requirements.push && journal.progress.pushedAt === undefined))) ||
    (journal.progress.prUrl !== undefined &&
      candidate !== undefined &&
      (candidate.state !== "accepted" || candidate.url !== journal.progress.prUrl)) ||
    (journal.state === "complete" &&
      requiredProgress.some(
        ([required, key]) => required && journal.progress[key] === undefined,
      )) ||
    (journal.progress.pushedAt !== undefined && journal.progress.promotedAt === undefined) ||
    (journal.progress.pullRequestAt !== undefined &&
      journal.requirements.push &&
      journal.progress.pushedAt === undefined) ||
    (journal.progress.preparedMerge !== undefined &&
      (!journal.requirements.merge ||
        journal.requirements.pullRequest ||
        journal.progress.promotedAt === undefined ||
        journal.progress.preparedMerge.candidateHead.toLowerCase() !==
          journal.gitState.candidateHead.toLowerCase() ||
        journal.progress.preparedMerge.preparedRef !==
          preparedPublicationRef(journal.gitState.sealedRef))) ||
    (journal.progress.mergedAt !== undefined &&
      journal.requirements.pullRequest &&
      journal.progress.pullRequestAt === undefined) ||
    (journal.progress.mergeCommitSha !== undefined && journal.progress.mergedAt === undefined) ||
    (journal.progress.preparedMerge !== undefined &&
      journal.progress.mergedAt !== undefined &&
      journal.progress.mergeCommitSha?.toLowerCase() !==
        journal.progress.preparedMerge.resultHead.toLowerCase()) ||
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
  return findDurableDockerPublicationRecovery(rootDir, taskId);
}

export function clearDockerPublicationRecovery(filePath: string, publicationId: string): boolean {
  try {
    const journal = readJournal(filePath);
    if (journal.publicationId !== publicationId || journal.state !== "complete") return false;
    removeFileDurably(filePath);
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function runGit(
  projectRoot: string,
  args: readonly string[],
  trustedLocalReadRemotePaths?: readonly string[],
  expectedRepository?: TrustedGitHubRepository,
): Promise<string> {
  const result = await runTrustedGitResult(projectRoot, args, {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    ...(trustedLocalReadRemotePaths ? { trustedLocalReadRemotePaths } : {}),
    ...(expectedRepository ? { expectedRepository } : {}),
  });
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error(result.stderr.trim() || result.stdout.trim() || "Git command failed"),
      { code: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    );
  }
  return result.stdout.trim();
}

function trustedGitHubRepository(
  repository: GitOriginBinding,
): TrustedGitHubRepository | undefined {
  const github = repository.github;
  if (!github) return undefined;
  const [owner, repo, ...rest] = github.nameWithOwner.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error("Persisted GitHub repository identity is invalid");
  }
  return { host: github.host, owner, repo };
}

async function readRef(
  projectRoot: string,
  ref: string,
  trustedLocalReadRemotePaths?: readonly string[],
): Promise<string> {
  const value = await runGit(
    projectRoot,
    ["rev-parse", "--verify", ref],
    trustedLocalReadRemotePaths,
  );
  if (!HASH_PATTERN.test(value)) throw new Error(`Git ref ${ref} did not resolve to a commit`);
  return value;
}

async function readOptionalRef(
  projectRoot: string,
  ref: string,
  trustedLocalReadRemotePaths?: readonly string[],
): Promise<string | undefined> {
  // show-ref --hash exits 128 for absence as well as corruption. Its quiet
  // variant silently conflates absence with malformed/dangling symbolic refs.
  const probe = await runTrustedGitResult(
    projectRoot,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
    {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...(trustedLocalReadRemotePaths ? { trustedLocalReadRemotePaths } : {}),
    },
  );
  if (probe.exitCode === 1 && probe.stdout === "" && probe.stderr === "") return undefined;
  if (probe.exitCode !== 0 || probe.stderr !== "" || !HASH_PATTERN.test(probe.stdout.trim())) {
    throw new Error(probe.stderr.trim() || probe.stdout.trim() || `Git ref ${ref} is unreadable`);
  }
  // rev-parse alone accepts an OID whose object is missing. Retain the exact
  // object-existence check, including refusal if the ref disappears meanwhile.
  const value = await runGit(
    projectRoot,
    ["show-ref", "--verify", "--hash", ref],
    trustedLocalReadRemotePaths,
  );
  if (!HASH_PATTERN.test(value)) throw new Error(`Git ref ${ref} returned an invalid commit id`);
  return value;
}

async function remoteBranchHead(
  projectRoot: string,
  branch: string,
  repository: GitOriginBinding,
  trustedLocalReadRemotePaths?: readonly string[],
): Promise<string | undefined> {
  const current = await resolveBoundOriginRepository(projectRoot, repository);
  const output = await runGit(
    projectRoot,
    ["ls-remote", "--heads", current.pushUrl, `refs/heads/${branch}`],
    trustedLocalReadRemotePaths,
    trustedGitHubRepository(repository),
  );
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/(.+)$/i.exec(output);
  return match?.[2] === branch ? match[1] : undefined;
}

async function pushExactBranch(
  branch: string,
  candidateHead: string,
  adapter: ProjectAdapter,
  repository: GitOriginBinding,
  trustedLocalReadRemotePaths?: readonly string[],
): Promise<void> {
  const projectRoot = adapter.projectRoot;
  const current = await resolveBoundOriginRepository(projectRoot, repository);
  const expectedRepository = trustedGitHubRepository(repository);
  const existing = await remoteBranchHead(
    projectRoot,
    branch,
    repository,
    trustedLocalReadRemotePaths,
  );
  if (existing === candidateHead) return;
  await runGit(
    projectRoot,
    ["push", current.pushUrl, `${candidateHead}:refs/heads/${branch}`],
    trustedLocalReadRemotePaths,
    expectedRepository,
  );
  const confirmed = await remoteBranchHead(
    projectRoot,
    branch,
    repository,
    trustedLocalReadRemotePaths,
  );
  if (confirmed !== candidateHead) {
    throw new Error(`remote branch ${branch} was not confirmed at ${candidateHead}`);
  }
}

async function releasePreparedMergeRef(
  projectRoot: string,
  prepared: NonNullable<PublicationProgress["preparedMerge"]>,
): Promise<void> {
  const current = await readOptionalRef(projectRoot, prepared.preparedRef);
  if (current === undefined) return;
  if (current.toLowerCase() !== prepared.resultHead.toLowerCase()) {
    throw new Error(`prepared publication ref ${prepared.preparedRef} changed before release`);
  }
  await runGit(projectRoot, ["update-ref", "-d", prepared.preparedRef, prepared.resultHead]);
  if ((await readOptionalRef(projectRoot, prepared.preparedRef)) !== undefined) {
    throw new Error(`prepared publication ref ${prepared.preparedRef} was not released`);
  }
}

async function restoreMissingLocalCandidateForCleanup(
  journal: DockerPublicationJournal,
): Promise<void> {
  const current = await readOptionalRef(journal.projectRoot, journal.gitState.authoritativeRef);
  if (current !== undefined) {
    if (current.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
      throw new Error(`local branch ${journal.branch} changed before cleanup retry`);
    }
    return;
  }
  const sealedHead = await readRef(journal.projectRoot, journal.gitState.sealedRef);
  if (sealedHead.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
    throw new Error(`sealed candidate for ${journal.branch} changed before cleanup retry`);
  }
  await runGit(journal.projectRoot, [
    "update-ref",
    journal.gitState.authoritativeRef,
    journal.gitState.candidateHead,
    "0".repeat(journal.gitState.candidateHead.length),
  ]);
  const restored = await readOptionalRef(journal.projectRoot, journal.gitState.authoritativeRef);
  if (restored?.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
    throw new Error(`local branch ${journal.branch} was not restored for cleanup validation`);
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

function publicationOwnershipMarker(publicationId: string): string {
  return `<!-- quack-publication:${publicationId} -->`;
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

function hasRemoteRequirements(requirements: PublicationRequirements): boolean {
  return Object.values(requirements).some(Boolean);
}

async function resolvePublicationRepositoryBinding(
  projectRoot: string,
  requirements: PublicationRequirements,
): Promise<GitOriginBinding | undefined> {
  if (!hasRemoteRequirements(requirements)) return undefined;
  const origin = await resolveOriginRepository(projectRoot);
  if (requirements.pullRequest && !origin.github) {
    throw new Error("Pull-request publication requires a GitHub origin");
  }
  return persistentOriginRepositoryBinding(origin);
}

function recordProgress(
  recoveryPath: string,
  journal: DockerPublicationJournal,
  patch: Partial<PublicationProgress>,
): void {
  const next: DockerPublicationJournal = {
    ...journal,
    progress: { ...journal.progress, ...patch },
    updatedAt: new Date().toISOString(),
  };
  delete next.lastError;
  Object.assign(journal, persistJournalUpdate(recoveryPath, journal, next));
  delete journal.lastError;
}

function journalDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function persistJournalUpdate(
  recoveryPath: string,
  current: DockerPublicationJournal,
  next: DockerPublicationJournal,
): DockerPublicationJournal {
  const persisted = readJournal(recoveryPath);
  if (
    !isDeepStrictEqual(persisted, current) ||
    (persisted.generation ?? 0) !== (current.generation ?? 0)
  ) {
    throw new Error("Docker publication recovery changed before its journal update");
  }
  const previousBytes = readTrustedArtifact(recoveryPath, 256_000);
  const advanced: DockerPublicationJournal = {
    ...next,
    generation: (persisted.generation ?? 0) + 1,
    previousDigest: journalDigest(previousBytes),
  };
  try {
    writeJsonAtomic(recoveryPath, advanced);
  } catch (error: unknown) {
    try {
      let recovered = readJournal(recoveryPath);
      if (!isDeepStrictEqual(recovered, advanced)) throw error;
      if (process.platform === "win32") {
        writeJsonAtomic(recoveryPath, recovered);
        recovered = readJournal(recoveryPath);
        if (!isDeepStrictEqual(recovered, advanced)) throw error;
      }
      return recovered;
    } catch {
      throw error;
    }
  }
  return advanced;
}

function recordFailure(
  recoveryPath: string | undefined,
  journal: DockerPublicationJournal | undefined,
  step: DockerPublicationStep,
  error: unknown,
): DockerPublicationIncompleteError {
  const detail = error instanceof Error ? error.message : String(error);
  if (recoveryPath && journal) {
    const failed: DockerPublicationJournal = {
      ...journal,
      lastError: { step, detail, at: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    try {
      Object.assign(journal, persistJournalUpdate(recoveryPath, journal, failed));
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return code !== "ESRCH";
  }
}

export interface RecoveryLockIdentity {
  projectRoot: string;
  publicationId: string;
  gitState: Pick<DockerResumeGitBinding, "sealedRef">;
}

interface RecoveryLockOwner {
  version: 1;
  publicationId: string;
  pid: number;
  processStartedAt: string;
  processIncarnation: string;
  acquiredAt: string;
  nonce: string;
}

interface RecoveryLockLease {
  lockRef: string;
  objectId: string;
  attemptKey: string;
  localAttemptId: string;
}

const activeRecoveryLockAttempts = new Map<string, string>();
const retainedInactiveRecoveryLocks = new Map<string, string>();

function recoveryLockAttemptKey(projectRoot: string, lockRef: string): string {
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  return `${process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot}\0${lockRef}`;
}

function recoveryLockRef(sealedRef: string): string {
  return sealedRef.replace("refs/quack/docker-publication/", "refs/quack/docker-publication-lock/");
}

function validateRecoveryLockOwner(
  value: unknown,
  publicationId: string,
): value is RecoveryLockOwner {
  return (
    isRecord(value) &&
    Object.keys(value).length === 7 &&
    value.version === 1 &&
    value.publicationId === publicationId &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.processStartedAt === "string" &&
    Number.isFinite(Date.parse(value.processStartedAt)) &&
    typeof value.processIncarnation === "string" &&
    value.processIncarnation.length > 0 &&
    value.processIncarnation.length <= 512 &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    isUuid(value.nonce)
  );
}

async function readProcessIncarnation(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        trustedWindowsPowerShellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks)`,
        ],
        { timeout: 5_000, maxBuffer: 16_384 },
      );
      const ticks = stdout.trim();
      return /^\d+$/u.test(ticks) ? `win32:${ticks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const executable = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
      const { stdout } = await execFileAsync(executable, ["-o", "lstart=", "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16_384,
      });
      const started = stdout.trim();
      return started ? `${process.platform}:${started}` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function createRecoveryLockObject(
  recoveryPath: string,
  identity: RecoveryLockIdentity,
): Promise<{ objectId: string; owner: RecoveryLockOwner }> {
  const now = new Date().toISOString();
  const processIncarnation = await readProcessIncarnation(process.pid);
  if (!processIncarnation) {
    throw new Error("Could not establish the publisher process incarnation");
  }
  const owner: RecoveryLockOwner = {
    version: 1,
    publicationId: identity.publicationId,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    processIncarnation,
    acquiredAt: now,
    nonce: randomUUID(),
  };
  const temporary = `${recoveryPath}.${process.pid}.${owner.nonce}.lock-owner`;
  try {
    writeJsonAtomic(temporary, owner, true);
    const objectId = await runGit(identity.projectRoot, ["hash-object", "-w", "--", temporary]);
    if (!HASH_PATTERN.test(objectId)) {
      throw new Error("Git returned an invalid recovery lock object id");
    }
    return { objectId: objectId.toLowerCase(), owner };
  } finally {
    try {
      removeFileDurably(temporary);
    } catch {
      // Git object creation errors remain the primary failure.
    }
  }
}

async function readRecoveryLockOwner(
  identity: RecoveryLockIdentity,
  objectId: string,
): Promise<RecoveryLockOwner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await runGit(identity.projectRoot, ["cat-file", "blob", objectId]),
    ) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `durable recovery lock ${objectId} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!validateRecoveryLockOwner(parsed, identity.publicationId)) {
    throw new Error(`durable recovery lock ${objectId} has invalid ownership metadata`);
  }
  return parsed;
}

async function acquireRecoveryLock(
  recoveryPath: string,
  identity: RecoveryLockIdentity,
): Promise<RecoveryLockLease> {
  const lockRef = recoveryLockRef(identity.gitState.sealedRef);
  const attemptKey = recoveryLockAttemptKey(identity.projectRoot, lockRef);
  const localAttemptId = randomUUID();
  if (activeRecoveryLockAttempts.has(attemptKey)) {
    throw new DockerPublicationIncompleteError(
      "validation",
      recoveryPath,
      "another publisher owns the durable recovery lock",
    );
  }
  activeRecoveryLockAttempts.set(attemptKey, localAttemptId);
  try {
    const { objectId } = await createRecoveryLockObject(recoveryPath, identity);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = await readOptionalRef(identity.projectRoot, lockRef);
      if (observed !== undefined) {
        const owner = await readRecoveryLockOwner(identity, observed);
        if (isProcessAlive(owner.pid)) {
          const liveIncarnation = await readProcessIncarnation(owner.pid);
          if (!liveIncarnation) {
            throw new DockerPublicationIncompleteError(
              "validation",
              recoveryPath,
              "another publisher owns the durable recovery lock",
            );
          }
          if (
            liveIncarnation === owner.processIncarnation &&
            (owner.pid !== process.pid ||
              retainedInactiveRecoveryLocks.get(attemptKey) !== observed)
          ) {
            throw new DockerPublicationIncompleteError(
              "validation",
              recoveryPath,
              "another publisher owns the durable recovery lock",
            );
          }
        }
      }
      const expected = observed ?? "0".repeat(objectId.length);
      try {
        await runGit(identity.projectRoot, ["update-ref", lockRef, objectId, expected]);
      } catch (error: unknown) {
        try {
          const installed = await readOptionalRef(identity.projectRoot, lockRef);
          if (installed === objectId) {
            retainedInactiveRecoveryLocks.delete(attemptKey);
            return { lockRef, objectId, attemptKey, localAttemptId };
          }
        } catch (readbackError: unknown) {
          retainedInactiveRecoveryLocks.set(attemptKey, objectId);
          throw new DockerPublicationIncompleteError(
            "validation",
            recoveryPath,
            `could not confirm durable recovery lock acquisition: ${readbackError instanceof Error ? readbackError.message : String(readbackError)}; update reported ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      let confirmed: string | undefined;
      try {
        confirmed = await readOptionalRef(identity.projectRoot, lockRef);
      } catch (error: unknown) {
        retainedInactiveRecoveryLocks.set(attemptKey, objectId);
        throw new DockerPublicationIncompleteError(
          "validation",
          recoveryPath,
          `could not confirm durable recovery lock acquisition: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (confirmed === objectId) {
        retainedInactiveRecoveryLocks.delete(attemptKey);
        return { lockRef, objectId, attemptKey, localAttemptId };
      }
    }
    throw new DockerPublicationIncompleteError(
      "validation",
      recoveryPath,
      "could not acquire the durable recovery lock after concurrent ownership changes",
    );
  } catch (error: unknown) {
    if (activeRecoveryLockAttempts.get(attemptKey) === localAttemptId) {
      activeRecoveryLockAttempts.delete(attemptKey);
    }
    throw error;
  }
}

async function releaseRecoveryLock(
  recoveryPath: string,
  identity: RecoveryLockIdentity,
  lock: RecoveryLockLease,
): Promise<void> {
  let deleteError: unknown;
  try {
    await runGit(identity.projectRoot, ["update-ref", "-d", lock.lockRef, lock.objectId]);
  } catch (error: unknown) {
    deleteError = error;
  }
  let retained: string | undefined;
  try {
    retained = await readOptionalRef(identity.projectRoot, lock.lockRef);
  } catch (error: unknown) {
    throw new DockerPublicationIncompleteError(
      "validation",
      recoveryPath,
      `could not verify durable recovery lock release: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (retained === undefined || retained !== lock.objectId) return;
  const detail = deleteError instanceof Error ? `: ${deleteError.message}` : "";
  throw new DockerPublicationIncompleteError(
    "validation",
    recoveryPath,
    `durable recovery lock release was not confirmed${detail}`,
  );
}

/** @internal Exported for deterministic real-Git lock-race verification. */
export async function withDockerPublicationRecoveryLock<T>(
  recoveryPath: string,
  identity: RecoveryLockIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  let lock: RecoveryLockLease;
  try {
    lock = await acquireRecoveryLock(recoveryPath, identity);
  } catch (error: unknown) {
    if (error instanceof DockerPublicationIncompleteError) throw error;
    throw new DockerPublicationIncompleteError(
      "validation",
      recoveryPath,
      `could not acquire the durable recovery lock: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let outcome: { success: true; value: T } | { success: false; error: unknown };
  try {
    outcome = { success: true, value: await operation() };
  } catch (error: unknown) {
    outcome = { success: false, error };
  }
  let releaseFailure: { error: unknown } | undefined;
  try {
    await releaseRecoveryLock(recoveryPath, identity, lock);
    if (retainedInactiveRecoveryLocks.get(lock.attemptKey) === lock.objectId) {
      retainedInactiveRecoveryLocks.delete(lock.attemptKey);
    }
  } catch (error: unknown) {
    retainedInactiveRecoveryLocks.set(lock.attemptKey, lock.objectId);
    releaseFailure = { error };
  } finally {
    if (activeRecoveryLockAttempts.get(lock.attemptKey) === lock.localAttemptId) {
      activeRecoveryLockAttempts.delete(lock.attemptKey);
    }
  }
  if (releaseFailure) {
    if (releaseFailure.error instanceof Error) throw releaseFailure.error;
    throw new Error(String(releaseFailure.error));
  }
  if (!outcome.success) {
    if (outcome.error instanceof Error) throw outcome.error;
    throw new Error(String(outcome.error));
  }
  return outcome.value;
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
  const requirements = requiredSteps(
    adapter,
    sharedDispatch,
    finalSharedDispatch,
    options.skipPr === true,
  );
  return {
    adapter,
    targetBranch,
    requirements,
    rawTask: resolved.content,
    title: resolved.task?.title ?? taskId,
  };
}

function resolveRecoveryJournalPath(
  taskId: string,
  recovery: DockerHostPublicationRecoveryInput,
): string {
  if (!isUuid(recovery.publicationId) || !validateGitState(recovery.gitState)) {
    throw new Error("Docker publication recovery identity is invalid");
  }
  if (recovery.worktreeOwnershipId !== recovery.publicationId) {
    throw new Error(
      "Docker publication recovery is not bound to the worktree ownership generation",
    );
  }
  const rootDir = path.resolve(recovery.rootDir);
  ensureDirectoryDurably(rootDir);
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Docker publication recovery root is not a trusted directory");
  }
  return publicationPath(rootDir, taskId, recovery.publicationId);
}

function readTrustedArtifact(filePath: string, maxBytes: number): Buffer {
  const before = fs.lstatSync(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 0 ||
    before.size > maxBytes
  ) {
    throw new Error("Docker publication recovery has an untrusted initial artifact");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (before.ino !== 0 && opened.ino !== before.ino) ||
      (before.dev !== 0 && opened.dev !== before.dev)
    ) {
      throw new Error("Docker publication recovery initial artifact changed identity");
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function initialJournalBytes(journal: DockerPublicationJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

const ISO_TIMESTAMP_SHAPE = "0000-00-00T00:00:00.000Z";

function isCanonicalTimestampPrefix(value: string): boolean {
  if (value.length > ISO_TIMESTAMP_SHAPE.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const expected = ISO_TIMESTAMP_SHAPE[index];
    const observed = value[index];
    if (expected === "0" ? !/\d/u.test(observed) : observed !== expected) return false;
  }
  return true;
}

function matchesInitialJournalPrefix(
  observed: Buffer,
  expectedJournal: DockerPublicationJournal,
  allowComplete: boolean,
): boolean {
  const expected = initialJournalBytes(expectedJournal);
  const marker = `"createdAt": "${expectedJournal.createdAt}"`;
  const markerOffset = expected.indexOf(Buffer.from(marker, "utf-8"));
  if (markerOffset < 0) return false;
  const timestampOffset = markerOffset + `"createdAt": "`.length;
  if (observed.length < timestampOffset) return false;
  if (observed.length === timestampOffset) {
    return observed.equals(expected.subarray(0, observed.length));
  }
  if (!observed.subarray(0, timestampOffset).equals(expected.subarray(0, timestampOffset))) {
    return false;
  }
  const timestampAvailable = Math.min(
    ISO_TIMESTAMP_SHAPE.length,
    observed.length - timestampOffset,
  );
  const timestampPrefix = observed
    .subarray(timestampOffset, timestampOffset + timestampAvailable)
    .toString("utf-8");
  if (!isCanonicalTimestampPrefix(timestampPrefix)) return false;
  if (timestampAvailable < ISO_TIMESTAMP_SHAPE.length) return true;
  let timestamp: string;
  try {
    timestamp = new Date(timestampPrefix).toISOString();
  } catch {
    return false;
  }
  if (timestamp !== timestampPrefix) return false;
  const matchingBytes = initialJournalBytes({
    ...expectedJournal,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return (
    (allowComplete
      ? observed.length <= matchingBytes.length
      : observed.length < matchingBytes.length) &&
    observed.equals(matchingBytes.subarray(0, observed.length))
  );
}

function removeTruncatedInitialArtifact(
  filePath: string,
  expectedJournal: DockerPublicationJournal,
): boolean {
  const observed = readTrustedArtifact(filePath, initialJournalBytes(expectedJournal).length);
  if (!matchesInitialJournalPrefix(observed, expectedJournal, false)) return false;
  removeFileDurably(filePath);
  return true;
}

function journalMatchesCreation(
  existing: DockerPublicationJournal,
  expected: DockerPublicationJournal,
): boolean {
  return (
    existing.taskId === expected.taskId &&
    existing.publicationId === expected.publicationId &&
    existing.projectRoot === expected.projectRoot &&
    existing.branch === expected.branch &&
    existing.targetBranch === expected.targetBranch &&
    existing.worktreePath === expected.worktreePath &&
    existing.worktreeSessionId === expected.worktreeSessionId &&
    existing.worktreeOwnershipId === expected.worktreeOwnershipId &&
    existing.preserveWorktree === expected.preserveWorktree &&
    existing.parentTaskId === expected.parentTaskId &&
    existing.sharedBranchName === expected.sharedBranchName &&
    isDeepStrictEqual(existing.repository, expected.repository) &&
    isDeepStrictEqual(existing.gitState, expected.gitState) &&
    isDeepStrictEqual(existing.sourceResume, expected.sourceResume) &&
    sameRequirements(existing.requirements, expected.requirements)
  );
}

function createOrReadJournal(
  taskId: string,
  projectRoot: string,
  branch: string,
  targetBranch: string,
  requirements: PublicationRequirements,
  repository: GitOriginBinding | undefined,
  options: DockerHostPublicationOptions,
): { recoveryPath?: string; journal?: DockerPublicationJournal } {
  if (!options.recovery) return {};
  const recovery = options.recovery;
  const recoveryPath = resolveRecoveryJournalPath(taskId, recovery);
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
    ...(repository ? { repository } : {}),
    gitState: recovery.gitState,
    worktreePath: fs.realpathSync.native(recovery.worktreePath),
    worktreeSessionId: recovery.worktreeSessionId,
    worktreeOwnershipId: recovery.worktreeOwnershipId,
    preserveWorktree: recovery.preserveWorktree,
    ...(recovery.sourceResume ? { sourceResume: recovery.sourceResume } : {}),
    requirements,
    progress: {},
    state: "pending",
    generation: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (!fs.existsSync(recoveryPath)) {
    const discovered = findDurableDockerPublicationRecovery(path.dirname(recoveryPath), taskId);
    if (discovered) {
      if (
        path.resolve(discovered.path) !== path.resolve(recoveryPath) ||
        !journalMatchesCreation(discovered.journal, journal)
      ) {
        throw new Error("Docker publication recovery already exists with different ownership");
      }
      return { recoveryPath, journal: discovered.journal };
    }
  }
  if (fs.existsSync(recoveryPath)) {
    let existing: DockerPublicationJournal | undefined;
    try {
      existing = readJournal(recoveryPath);
    } catch (error: unknown) {
      if (!removeTruncatedInitialArtifact(recoveryPath, journal)) throw error;
    }
    if (existing) {
      if (!journalMatchesCreation(existing, journal)) {
        throw new Error("Docker publication recovery already exists with different ownership");
      }
      return { recoveryPath, journal: existing };
    }
  }
  try {
    writeJsonAtomic(recoveryPath, journal, true);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = readJournal(recoveryPath);
    if (!journalMatchesCreation(existing, journal)) {
      throw new Error("Docker publication recovery already exists with different ownership");
    }
    return { recoveryPath, journal: existing };
  }
  return { recoveryPath, journal };
}

export async function initializeDockerPublicationRecovery(
  taskId: string,
  projectRoot: string,
  promotedBranch: string,
  options: DockerHostPublicationOptions,
): Promise<string> {
  if (!options.recovery) {
    throw new Error("durable recovery ownership is required before journal initialization");
  }
  const context = await resolvePublicationContext(taskId, projectRoot, promotedBranch, options);
  const repository = await resolvePublicationRepositoryBinding(projectRoot, context.requirements);
  const created = createOrReadJournal(
    taskId,
    projectRoot,
    promotedBranch,
    context.targetBranch,
    context.requirements,
    repository,
    options,
  );
  if (!created.recoveryPath || !created.journal) {
    throw new Error("durable Docker publication journal was not established");
  }
  return created.recoveryPath;
}

async function ensureSealedPublicationCandidate(
  projectRoot: string,
  journal: DockerPublicationJournal,
): Promise<void> {
  const observed = await readOptionalRef(projectRoot, journal.gitState.sealedRef);
  if (observed !== undefined) {
    if (observed.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
      throw new Error("sealed publication ref no longer matches the candidate commit");
    }
    return;
  }
  const candidate = await readRef(projectRoot, `${journal.gitState.candidateHead}^{commit}`);
  if (candidate.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
    throw new Error("journaled publication candidate is not an exact commit");
  }
  await runGit(projectRoot, [
    "merge-base",
    "--is-ancestor",
    journal.gitState.baseHead,
    journal.gitState.candidateHead,
  ]);
  await runGit(projectRoot, [
    "update-ref",
    journal.gitState.sealedRef,
    journal.gitState.candidateHead,
    "0".repeat(journal.gitState.candidateHead.length),
  ]);
  const confirmed = await readOptionalRef(projectRoot, journal.gitState.sealedRef);
  if (confirmed?.toLowerCase() !== journal.gitState.candidateHead.toLowerCase()) {
    throw new Error("journaled publication candidate seal was not confirmed");
  }
}

async function executePublication(
  journal: DockerPublicationJournal,
  recoveryPath: string,
  context: Awaited<ReturnType<typeof resolvePublicationContext>>,
): Promise<DockerHostPublicationResult> {
  const { adapter, requirements, rawTask, title } = context;
  const projectRoot = fs.realpathSync.native(adapter.projectRoot);
  const trustedLocalReadRemotePaths = adapter.trustedLocalReadRemotePaths;
  if (
    journal.projectRoot !== projectRoot ||
    journal.branch !== journal.gitState.authoritativeRef.slice("refs/heads/".length) ||
    journal.targetBranch !== context.targetBranch ||
    !sameRequirements(journal.requirements, requirements)
  ) {
    throw recordFailure(recoveryPath, journal, "validation", "publication contract changed");
  }
  if (journal.repository) {
    try {
      await resolveBoundOriginRepository(projectRoot, journal.repository);
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "validation", error);
    }
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
      await ensureSealedPublicationCandidate(projectRoot, journal);
      await runGit(
        projectRoot,
        ["merge-base", "--is-ancestor", journal.gitState.baseHead, journal.gitState.candidateHead],
        trustedLocalReadRemotePaths,
      );
      const current = await readRef(
        projectRoot,
        journal.gitState.authoritativeRef,
        trustedLocalReadRemotePaths,
      );
      if (current === journal.gitState.baseHead) {
        await runGit(
          projectRoot,
          [
            "update-ref",
            journal.gitState.authoritativeRef,
            journal.gitState.candidateHead,
            journal.gitState.baseHead,
          ],
          trustedLocalReadRemotePaths,
        );
      } else if (current !== journal.gitState.candidateHead) {
        throw new Error("authoritative branch changed before publication promotion");
      }
      const confirmed = await readRef(
        projectRoot,
        journal.gitState.authoritativeRef,
        trustedLocalReadRemotePaths,
      );
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
      await pushExactBranch(
        journal.branch,
        journal.gitState.candidateHead,
        adapter,
        journal.repository!,
        trustedLocalReadRemotePaths,
      );
      recordProgress(recoveryPath, journal, { pushedAt: new Date().toISOString() });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "push", error);
    }
  }

  if (requirements.pullRequest && !journal.progress.pullRequestAt) {
    try {
      if (!journal.repository?.github) {
        throw new Error("GitHub repository identity was not pinned");
      }
      await resolveBoundOriginRepository(projectRoot, journal.repository);
      const githubRepository = trustedGitHubRepository(journal.repository);
      if (!githubRepository) throw new Error("GitHub repository identity was not pinned");
      const remoteHead = await remoteBranchHead(
        projectRoot,
        journal.branch,
        journal.repository,
        trustedLocalReadRemotePaths,
      );
      if (remoteHead !== journal.gitState.candidateHead) {
        throw new Error("remote pull-request branch no longer matches the sealed commit");
      }
      const binding: PullRequestBinding = {
        repository: githubRepository,
        headBranch: journal.branch,
        baseBranch: journal.targetBranch,
        headOid: journal.gitState.candidateHead,
      };
      const ownershipMarker = publicationOwnershipMarker(journal.publicationId);
      const recordCandidate = (candidate: PullRequestCandidate): void => {
        const existing = journal.progress.pullRequestCandidate;
        recordProgress(recoveryPath, journal, {
          pullRequestCandidate: {
            ...candidate,
            recordedAt:
              existing?.url === candidate.url &&
              existing.ownershipMarker === candidate.ownershipMarker
                ? existing.recordedAt
                : new Date().toISOString(),
          },
        });
      };
      let prUrl: string;
      const pendingCandidate = journal.progress.pullRequestCandidate;
      if (pendingCandidate && pendingCandidate.state !== "closed") {
        const recovered = await recoverPullRequestCandidate(projectRoot, pendingCandidate, binding);
        recordCandidate(recovered);
        if (recovered.state !== "accepted") {
          throw new Error(
            "The invalid Quack-owned pull request was closed; retry publication to create a replacement",
          );
        }
        prUrl = recovered.url;
      } else {
        const created = await createPullRequest(
          {
            taskId: journal.taskId,
            title: `[${journal.taskId}] ${title}`,
            body: publicationBody(journal.taskId, rawTask),
            baseBranch: journal.targetBranch,
            headBranch: journal.branch,
            expectedHeadOid: journal.gitState.candidateHead,
            repository: githubRepository,
            ownershipMarker,
            onCandidate: recordCandidate,
          },
          adapter,
        );
        if (!created.success || !created.prUrl) {
          throw new Error(
            created.error ?? `Pull request URL was not confirmed for ${journal.taskId}`,
          );
        }
        const acceptedCandidate = journal.progress.pullRequestCandidate;
        if (
          acceptedCandidate?.state !== "accepted" ||
          acceptedCandidate.url !== created.prUrl ||
          acceptedCandidate.ownershipMarker !== ownershipMarker
        ) {
          throw new Error("Pull request candidate was not durably accepted before publication");
        }
        prUrl = created.prUrl;
      }
      recordProgress(recoveryPath, journal, {
        pullRequestAt: new Date().toISOString(),
        prUrl,
      });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "pull-request", error);
    }
  }

  if (requirements.merge && !journal.progress.mergedAt) {
    try {
      if (
        requirements.pullRequest &&
        (!journal.progress.pullRequestAt || !journal.progress.prUrl)
      ) {
        throw new Error("Pull-request publication was not durably confirmed before merge");
      }
      if (!journal.repository) throw new Error("Git origin identity was not pinned");
      const origin = await resolveBoundOriginRepository(projectRoot, journal.repository);
      const githubRepository = trustedGitHubRepository(journal.repository);
      if (!githubRepository) {
        throw new Error("Current branch-manager publication requires a GitHub repository identity");
      }
      let pullRequestBinding: PullRequestBinding | undefined;
      if (journal.progress.prUrl) {
        pullRequestBinding = {
          repository: githubRepository,
          headBranch: journal.branch,
          baseBranch: journal.targetBranch,
          headOid: journal.gitState.candidateHead,
        };
      }
      const preparedMerge = journal.progress.preparedMerge;
      const merged = await mergeBranchToTarget(
        journal.taskId,
        adapter,
        journal.progress.prUrl,
        journal.targetBranch,
        undefined,
        journal.branch,
        pullRequestBinding,
        journal.gitState.candidateHead,
        githubRepository,
        journal.progress.prUrl
          ? undefined
          : {
              ...(preparedMerge
                ? {
                    prepared: {
                      strategy: preparedMerge.strategy,
                      candidateHead: preparedMerge.candidateHead,
                      targetHead: preparedMerge.targetHead,
                      resultHead: preparedMerge.resultHead,
                      preparedRef: preparedMerge.preparedRef,
                    },
                  }
                : {}),
              preparedRef: preparedPublicationRef(journal.gitState.sealedRef),
              onPrepared: (prepared) => {
                recordProgress(recoveryPath, journal, {
                  preparedMerge: { ...prepared, preparedAt: new Date().toISOString() },
                });
              },
            },
        origin,
      );
      if (!merged.success) {
        throw new Error(merged.error ?? `Failed to auto-merge ${journal.branch}`);
      }
      const recordedPreparation = journal.progress.preparedMerge;
      if (
        recordedPreparation &&
        merged.mergeCommitSha?.toLowerCase() !== recordedPreparation.resultHead.toLowerCase()
      ) {
        throw new Error("prepared target publication returned a different merge commit");
      }
      recordProgress(recoveryPath, journal, {
        mergedAt: new Date().toISOString(),
        ...(merged.mergeCommitSha ? { mergeCommitSha: merged.mergeCommitSha } : {}),
      });
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "merge", error);
    }
  }

  if (journal.progress.preparedMerge) {
    try {
      await releasePreparedMergeRef(projectRoot, journal.progress.preparedMerge);
    } catch (error: unknown) {
      throw recordFailure(recoveryPath, journal, "merge", error);
    }
  }

  if (requirements.status && !journal.progress.statusAt) {
    try {
      if (!journal.repository) throw new Error("Git origin identity was not pinned");
      await resolveBoundOriginRepository(projectRoot, journal.repository);
      const githubRepository = trustedGitHubRepository(journal.repository);
      if (!githubRepository) {
        throw new Error("Current task-status publication requires a GitHub repository identity");
      }
      const status = await updateTaskFileStatus(
        journal.taskId,
        adapter,
        journal.targetBranch,
        githubRepository,
      );
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
      if (journal.preserveWorktree) {
        const outcome = "retained-with-worktree";
        warnings.push(outcome);
        recordProgress(recoveryPath, journal, {
          cleanupAt: new Date().toISOString(),
          cleanupOutcome: outcome,
        });
      } else {
        if (!journal.repository) throw new Error("Git origin identity was not pinned");
        const cleanupOrigin = await resolveBoundOriginRepository(projectRoot, journal.repository);
        const githubRepository = trustedGitHubRepository(journal.repository);
        if (!githubRepository) {
          throw new Error("Current branch cleanup requires a GitHub repository identity");
        }
        await restoreMissingLocalCandidateForCleanup(journal);
        const cleanup = await deleteAfterMerge(journal.branch, adapter, {
          baseBranch: journal.targetBranch,
          expectedRepository: githubRepository,
          expectedSourceOid: journal.gitState.candidateHead,
          expectedMergedCommit:
            journal.progress.preparedMerge?.resultHead ?? journal.progress.mergeCommitSha,
          expectedOriginPushUrl: cleanupOrigin.pushUrl,
        });
        if (cleanup.deleted && cleanup.localDeleted) {
          recordProgress(recoveryPath, journal, { cleanupLocalAt: new Date().toISOString() });
        }
        if (
          cleanup.reason === "delete-failed" ||
          cleanup.reason === "head-mismatch" ||
          cleanup.reason === "origin-mismatch" ||
          cleanup.reason === "not-merged" ||
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
    const completed: DockerPublicationJournal = {
      ...journal,
      state: "complete",
      updatedAt: new Date().toISOString(),
    };
    delete completed.lastError;
    Object.assign(journal, persistJournalUpdate(recoveryPath, journal, completed));
    delete journal.lastError;
  } catch (error: unknown) {
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
  const initialJournal = readJournal(resolvedPath);
  return withDockerPublicationRecoveryLock(resolvedPath, initialJournal, async () => {
    const journal = readJournal(resolvedPath);
    if (
      journal.publicationId !== initialJournal.publicationId ||
      journal.projectRoot !== initialJournal.projectRoot ||
      journal.gitState.sealedRef !== initialJournal.gitState.sealedRef
    ) {
      throw new DockerPublicationIncompleteError(
        "validation",
        resolvedPath,
        "Docker publication recovery identity changed while acquiring its lock",
      );
    }
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
  let repository: GitOriginBinding | undefined;
  try {
    context = await resolvePublicationContext(taskId, projectRoot, promotedBranch, options);
    repository = await resolvePublicationRepositoryBinding(projectRoot, context.requirements);
  } catch (error: unknown) {
    throw recordFailure(undefined, undefined, "validation", error);
  }

  const recovery = options.recovery;
  const recoveryPath = resolveRecoveryJournalPath(taskId, recovery);
  const created = createOrReadJournal(
    taskId,
    projectRoot,
    promotedBranch,
    context.targetBranch,
    context.requirements,
    repository,
    options,
  );
  if (!created.journal || created.recoveryPath !== recoveryPath) {
    throw new DockerPublicationIncompleteError(
      "validation",
      recoveryPath,
      "durable Docker publication journal was not established",
    );
  }
  const identity: RecoveryLockIdentity = {
    projectRoot: fs.realpathSync.native(projectRoot),
    publicationId: recovery.publicationId,
    gitState: { sealedRef: recovery.gitState.sealedRef },
  };
  return withDockerPublicationRecoveryLock(recoveryPath, identity, async () => {
    const journal = readJournal(recoveryPath);
    if (!journalMatchesCreation(journal, created.journal!)) {
      throw new DockerPublicationIncompleteError(
        "validation",
        recoveryPath,
        "durable Docker publication journal ownership changed before locking",
      );
    }
    return executePublication(journal, recoveryPath, context);
  });
}
