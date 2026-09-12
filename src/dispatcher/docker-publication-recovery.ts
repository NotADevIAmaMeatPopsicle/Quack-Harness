// Lightweight, side-effect-free reader for host-owned Docker publication
// journals. Kept separate from publication executors so monitor lifecycle
// code does not eagerly load Git/GitHub integrations (important for startup
// isolation and testability).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DockerResumeGitBinding, DockerResumeSourceBinding } from "./docker-runtime-bridge.js";
import type { GitOriginBinding, GitHubRepositoryBinding } from "./github-repository.js";
import {
  installDurableJsonTempNoReplace,
  reconcileDurableJsonInstall,
  removeFileDurably,
  replaceDurableJsonFromTemp,
} from "./durable-json-file.js";

export interface DockerPublicationRequirements {
  push: boolean;
  pullRequest: boolean;
  merge: boolean;
  status: boolean;
  cleanup: boolean;
}

export interface DockerPublicationProgress {
  promotedAt?: string;
  pushedAt?: string;
  pullRequestCandidate?: {
    url: string;
    ownershipMarker: string;
    state: "pending" | "accepted" | "closed";
    recordedAt: string;
  };
  pullRequestAt?: string;
  prUrl?: string;
  preparedMerge?: {
    strategy: "merge" | "rebase" | "squash";
    candidateHead: string;
    targetHead: string;
    resultHead: string;
    preparedRef: string;
    preparedAt: string;
  };
  mergedAt?: string;
  mergeCommitSha?: string;
  statusAt?: string;
  cleanupLocalAt?: string;
  cleanupAt?: string;
  cleanupOutcome?: string;
}

export type DockerPublicationStep =
  | "validation"
  | "promotion"
  | "push"
  | "pull-request"
  | "merge"
  | "status"
  | "cleanup";

export interface DockerPublicationJournal {
  version: 1;
  publicationId: string;
  taskId: string;
  projectRoot: string;
  branch: string;
  targetBranch: string;
  parentTaskId?: string;
  sharedBranchName?: string;
  repository?: GitOriginBinding;
  gitState: DockerResumeGitBinding;
  worktreePath: string;
  worktreeSessionId: string;
  worktreeOwnershipId: string;
  preserveWorktree: boolean;
  sourceResume?: DockerResumeSourceBinding;
  requirements: DockerPublicationRequirements;
  progress: DockerPublicationProgress;
  state: "pending" | "complete";
  generation?: number;
  previousDigest?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: { step: DockerPublicationStep; detail: string; at: string };
}

const HASH_PATTERN = /^[a-f0-9]{40,64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGitHubBinding(value: unknown): value is GitHubRepositoryBinding {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  if (
    typeof value.selector !== "string" ||
    typeof value.host !== "string" ||
    typeof value.nameWithOwner !== "string"
  ) {
    return false;
  }
  const hostMatch = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/u.exec(value.host);
  if (!hostMatch) return false;
  if (hostMatch[2]) {
    const port = Number(hostMatch[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  }
  const segments = value.nameWithOwner.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/u.test(segment),
    ) &&
    value.selector === `${value.host}/${value.nameWithOwner}`
  );
}

function validateRepositoryBinding(value: unknown): value is GitOriginBinding {
  return (
    isRecord(value) &&
    Object.keys(value).length >= 1 &&
    Object.keys(value).every((key) => ["pushUrlHash", "github"].includes(key)) &&
    typeof value.pushUrlHash === "string" &&
    /^[a-f0-9]{64}$/iu.test(value.pushUrlHash) &&
    (value.github === undefined || validateGitHubBinding(value.github))
  );
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

function preparedPublicationRef(sealedRef: string): string {
  return sealedRef.replace(
    "refs/quack/docker-publication/",
    "refs/quack/docker-publication-prepared/",
  );
}

function validateGitState(value: unknown): value is DockerResumeGitBinding {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
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

function validateRequirements(value: unknown): value is DockerPublicationRequirements {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    ["push", "pullRequest", "merge", "status", "cleanup"].every(
      (key) => typeof value[key] === "boolean",
    )
  );
}

function validateProgress(value: unknown): value is DockerPublicationProgress {
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
): value is NonNullable<DockerPublicationProgress["pullRequestCandidate"]> {
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
): value is NonNullable<DockerPublicationProgress["preparedMerge"]> {
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

function readDockerPublicationArtifact(
  filePath: string,
  identityPath: string,
): DockerPublicationJournal {
  const resolved = path.resolve(filePath);
  reconcileDurableJsonInstall(resolved);
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256_000) {
    throw new Error("Docker publication recovery has an untrusted file identity");
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
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
    !validateRequirements(parsed.requirements) ||
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
  const requiredProgress: Array<[boolean, keyof DockerPublicationProgress]> = [
    [true, "promotedAt"],
    [journal.requirements.push, "pushedAt"],
    [journal.requirements.pullRequest, "pullRequestAt"],
    [journal.requirements.merge, "mergedAt"],
    [journal.requirements.status, "statusAt"],
    [journal.requirements.cleanup, "cleanupAt"],
  ];
  const expectedOwnershipMarker = `<!-- quack-publication:${journal.publicationId} -->`;
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
    (journal.repository !== undefined && !validateRepositoryBinding(journal.repository)) ||
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
  if (
    path.basename(identityPath) !== `${safeTaskId(journal.taskId)}-${journal.publicationId}.json`
  ) {
    throw new Error("Docker publication recovery filename does not match its ownership");
  }
  return journal;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function readTrustedBytes(filePath: string): Buffer {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256_000) {
    throw new Error("Docker publication recovery has an untrusted file identity");
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
      throw new Error("Docker publication recovery changed identity");
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "ESRCH"
    );
  }
}

function sameJournalOwnership(
  left: DockerPublicationJournal,
  right: DockerPublicationJournal,
): boolean {
  return (
    left.publicationId === right.publicationId &&
    left.taskId === right.taskId &&
    left.projectRoot === right.projectRoot &&
    left.branch === right.branch &&
    left.targetBranch === right.targetBranch &&
    left.parentTaskId === right.parentTaskId &&
    left.sharedBranchName === right.sharedBranchName &&
    isDeepStrictEqual(left.repository, right.repository) &&
    left.worktreePath === right.worktreePath &&
    left.worktreeSessionId === right.worktreeSessionId &&
    left.worktreeOwnershipId === right.worktreeOwnershipId &&
    left.preserveWorktree === right.preserveWorktree &&
    isDeepStrictEqual(left.gitState, right.gitState) &&
    isDeepStrictEqual(left.sourceResume, right.sourceResume) &&
    isDeepStrictEqual(left.requirements, right.requirements)
  );
}

const INSTALL_TEMP_SUFFIX =
  /\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/iu;

function reconcileUpdateTemps(
  finalPath: string,
  current: DockerPublicationJournal,
): DockerPublicationJournal {
  const directory = path.dirname(finalPath);
  const finalName = path.basename(finalPath);
  const currentBytes = readTrustedBytes(finalPath);
  const currentDigest = digest(currentBytes);
  const currentGeneration = current.generation ?? 0;
  const successors: Array<{
    path: string;
    journal: DockerPublicationJournal;
    bytes: Buffer;
  }> = [];

  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(`${finalName}.`) || !name.endsWith(".tmp")) continue;
    const suffix = INSTALL_TEMP_SUFFIX.exec(name);
    if (!suffix || name.slice(0, suffix.index) !== finalName) continue;
    const pid = Number(suffix[1]);
    if (isProcessAlive(pid)) {
      throw new Error(`Docker publication journal update ${name} belongs to a live process`);
    }
    const temporaryPath = path.join(directory, name);
    let candidate: DockerPublicationJournal;
    try {
      candidate = readDockerPublicationArtifact(temporaryPath, finalPath);
    } catch (error: unknown) {
      throw new Error(
        `Docker publication journal update ${name} is incomplete or invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sameJournalOwnership(candidate, current)) {
      throw new Error(`Docker publication journal update ${name} has different ownership`);
    }
    const candidateBytes = readTrustedBytes(temporaryPath);
    if (candidateBytes.equals(currentBytes)) {
      removeFileDurably(temporaryPath);
      continue;
    }
    const candidateGeneration = candidate.generation ?? 0;
    if (
      candidateGeneration === 0 &&
      currentGeneration === 0 &&
      candidate.state === "pending" &&
      current.state === "pending" &&
      Object.keys(candidate.progress).length === 0 &&
      Object.keys(current.progress).length === 0 &&
      candidate.lastError === undefined &&
      current.lastError === undefined &&
      candidate.createdAt === candidate.updatedAt &&
      current.createdAt === current.updatedAt
    ) {
      removeFileDurably(temporaryPath);
      continue;
    }
    if (candidateGeneration < currentGeneration) {
      removeFileDurably(temporaryPath);
      continue;
    }
    if (
      candidateGeneration !== currentGeneration + 1 ||
      candidate.previousDigest !== currentDigest
    ) {
      throw new Error(`Docker publication journal update ${name} is not the exact next generation`);
    }
    successors.push({ path: temporaryPath, journal: candidate, bytes: candidateBytes });
  }

  if (successors.length === 0) return current;
  const successorBytes = successors[0].bytes;
  if (successors.some((candidate) => !candidate.bytes.equals(successorBytes))) {
    throw new Error("Docker publication journal has divergent next-generation updates");
  }
  const winner = successors[0];
  for (const duplicate of successors.slice(1)) removeFileDurably(duplicate.path);
  replaceDurableJsonFromTemp(winner.path, finalPath);
  return readDockerPublicationArtifact(finalPath, finalPath);
}

export function reconcileDockerPublicationRecoveryArtifacts(
  filePath: string,
): DockerPublicationJournal {
  const resolved = path.resolve(filePath);
  const current = readDockerPublicationArtifact(resolved, resolved);
  return reconcileUpdateTemps(resolved, current);
}

export function readDockerPublicationRecovery(filePath: string): DockerPublicationJournal {
  return reconcileDockerPublicationRecoveryArtifacts(filePath);
}

/**
 * A crash before the no-replace link leaves a fully fsynced journal temp but
 * no final name. Promote the one schema- and filename-bound artifact during
 * startup discovery. A partial or ambiguous artifact blocks a new run rather
 * than silently abandoning the sealed publication identity.
 */
function recoverOrphanedInstallTemp(root: string, taskId: string): void {
  const prefix = `${safeTaskId(taskId)}-`;
  const candidates = fs
    .readdirSync(root)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .map((name) => {
      const suffix = INSTALL_TEMP_SUFFIX.exec(name);
      if (!suffix || suffix.index <= 0) return undefined;
      const finalName = name.slice(0, suffix.index);
      if (!finalName.endsWith(".json")) return undefined;
      const finalPath = path.join(root, finalName);
      if (fs.existsSync(finalPath)) return undefined;
      return { temporaryPath: path.join(root, name), finalPath };
    })
    .filter(
      (candidate): candidate is { temporaryPath: string; finalPath: string } =>
        candidate !== undefined,
    );
  if (candidates.length === 0) return;
  if (candidates.length > 1) {
    throw new Error(
      `Multiple orphan Docker publication journals exist for ${taskId}; reconcile explicitly`,
    );
  }

  const candidate = candidates[0];
  let orphan: DockerPublicationJournal;
  try {
    orphan = readDockerPublicationArtifact(candidate.temporaryPath, candidate.finalPath);
  } catch (error: unknown) {
    throw new Error(
      `Orphan Docker publication journal ${candidate.temporaryPath} is incomplete or invalid; ` +
        `the exact publication remains blocked for recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (orphan.taskId !== taskId) {
    throw new Error("Orphan Docker publication journal belongs to a different task");
  }
  if (
    orphan.state !== "pending" ||
    Object.keys(orphan.progress).length !== 0 ||
    orphan.lastError !== undefined ||
    orphan.createdAt !== orphan.updatedAt
  ) {
    throw new Error("Orphan Docker publication journal is not an uncommitted initial installation");
  }
  try {
    installDurableJsonTempNoReplace(candidate.temporaryPath, candidate.finalPath);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const installed = readDockerPublicationRecovery(candidate.finalPath);
  if (!sameJournalOwnership(installed, orphan)) {
    throw new Error("Recovered Docker publication journal has different ownership");
  }
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
  recoverOrphanedInstallTemp(root, taskId);
  const prefix = `${safeTaskId(taskId)}-`;
  const matches = fs
    .readdirSync(root)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(root, name);
      return { path: filePath, journal: readDockerPublicationRecovery(filePath) };
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
    const journal = readDockerPublicationRecovery(filePath);
    if (journal.publicationId !== publicationId || journal.state !== "complete") return false;
    removeFileDurably(filePath);
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}
