// Lightweight, side-effect-free reader for host-owned Docker publication
// journals. Kept separate from publication executors so monitor lifecycle
// code does not eagerly load Git/GitHub integrations (important for startup
// isolation and testability).

import * as fs from "node:fs";
import * as path from "node:path";
import type { DockerResumeGitBinding, DockerResumeSourceBinding } from "./docker-runtime-bridge.js";

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
  pullRequestAt?: string;
  prUrl?: string;
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
  gitState: DockerResumeGitBinding;
  worktreePath: string;
  worktreeSessionId: string;
  worktreeOwnershipId: string;
  preserveWorktree: boolean;
  sourceResume?: DockerResumeSourceBinding;
  requirements: DockerPublicationRequirements;
  progress: DockerPublicationProgress;
  state: "pending" | "complete";
  createdAt: string;
  updatedAt: string;
  lastError?: { step: DockerPublicationStep; detail: string; at: string };
}

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

export function readDockerPublicationRecovery(filePath: string): DockerPublicationJournal {
  const resolved = path.resolve(filePath);
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
  const requiredProgress: Array<[boolean, keyof DockerPublicationProgress]> = [
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
  if (path.basename(resolved) !== `${safeTaskId(journal.taskId)}-${journal.publicationId}.json`) {
    throw new Error("Docker publication recovery filename does not match its ownership");
  }
  return journal;
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
    fs.rmSync(filePath);
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}
