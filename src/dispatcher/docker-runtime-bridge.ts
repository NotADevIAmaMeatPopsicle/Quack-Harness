// Docker runtime output crosses a trust boundary: the managed workload can
// write its private runtime directory, while the monitor's event and approval
// consumers are authoritative. This module is the only bridge between those
// trees. It accepts a deliberately small telemetry vocabulary while the
// container is live, validates control artifacts after the container is gone,
// and records which exact archive may seed a later resume.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JobProvenance } from "../monitor/federation/types.js";
import type { QuackEvent, SessionEntry } from "../monitor/event-types.js";

const MAX_EVENT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{40,64}$/i;
const RUNTIME_MANIFEST = "runtime-manifest.json";
const RUNTIME_REJECTIONS = "runtime-import-rejections.jsonl";
const CHECKPOINT_STAGES = new Set([
  "gate",
  "blueprint",
  "approve",
  "branch",
  "context",
  "agent",
  "commit",
  "judge_review",
  "judge",
  "pr",
]);
const SAFE_LIVE_STAGES = new Set([
  "session_start",
  "stage_started",
  "stage_heartbeat",
  "stage_completed",
  "stage_failed",
  "blueprint_start",
  "blueprint_warning",
  "blueprint_fallback",
  "agent_turn",
  "agent_tool_use",
  "agent_complete",
  "agent_progress",
  "checkpoint_saved",
  "checkpoint_loaded",
  "stage_skipped",
  "blueprint_pending_approval",
  "judge_pending_approval",
]);

interface RuntimeManifest {
  version: 1;
  taskId: string;
  dispatchSessionId: string;
  ownershipId: string;
  startedAt: string;
  eventSessionId: string;
  project: string;
  provenance: JobProvenance;
  parentTaskId?: string;
  sharedBranchName?: string;
  telemetryValidatedAt?: string;
  resumeSource?: DockerResumeSourceBinding;
  gitState?: DockerResumeGitBinding;
  state: "active" | "sealed" | "rejected";
  sealedAt?: string;
}

export interface DockerResumeSourceBinding {
  archiveName: string;
  dispatchSessionId: string;
  eventSessionId: string;
  ownershipId: string;
  approvedGate: "blueprint" | "judge";
  gitState: DockerResumeGitBinding;
  /** Host-rechecked diff approved at a judge gate. */
  approvedDiffHash?: string;
  parentTaskId?: string;
  sharedBranchName?: string;
}

export interface DockerResumeGitBinding {
  authoritativeRef: string;
  baseHead: string;
  candidateHead: string;
  sealedRef: string;
}

interface FileCursor {
  dev: number;
  ino: number;
  offset: number;
  remainder: string;
  sessionId: string;
  started: boolean;
  project?: string;
}

export interface DockerRuntimeBridgeOptions {
  sourceDir: string;
  archiveRoot: string;
  taskId: string;
  dispatchSessionId: string;
  ownershipId: string;
  startedAt: string;
  provenance: JobProvenance;
  expectedProject: string;
  parentTaskId?: string;
  sharedBranchName?: string;
  resumeSource?: DockerResumeSourceBinding;
  pollIntervalMs?: number;
}

export interface DockerRuntimeTerminal {
  outcome: "approved" | "awaiting_approval" | "spec_changed" | "error" | "stopped";
  totalCostUsd?: number;
  turnsUsed?: number;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function isBoundedString(value: unknown, max = 100_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalString(value: unknown, max = 100_000): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isFiniteNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isSafeRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

function isValidDecompositionBinding(parentTaskId: unknown, sharedBranchName: unknown): boolean {
  if (parentTaskId === undefined && sharedBranchName === undefined) return true;
  return (
    isBoundedString(parentTaskId, 240) &&
    isSafeRef(sharedBranchName) &&
    !String(sharedBranchName).startsWith("refs/")
  );
}

function isSafeJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 1_000_000;
  if (Array.isArray(value))
    return value.length <= 10_000 && value.every((v) => isSafeJson(v, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 1_000) return false;
  return Object.entries(value).every(
    ([key, child]) => key.length <= 200 && isSafeJson(child, depth + 1),
  );
}

function isOptionalSafeJson(value: unknown): boolean {
  return value === undefined || isSafeJson(value);
}

function isStringArray(value: unknown, maxEntries = 100_000, maxLength = 8_192): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxEntries &&
    value.every((entry) => typeof entry === "string" && entry.length <= maxLength)
  );
}

function validateVerificationResult(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["allPassed", "commands", "conventionChecks", "adapterFreshness"])
  ) {
    return false;
  }
  const commands = (candidate: unknown): boolean =>
    Array.isArray(candidate) &&
    candidate.length <= 1_000 &&
    candidate.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["name", "passed", "output"]) &&
        isBoundedString(entry.name, 1_000) &&
        typeof entry.passed === "boolean" &&
        typeof entry.output === "string" &&
        entry.output.length <= 1_000_000,
    );
  return (
    typeof value.allPassed === "boolean" &&
    commands(value.commands) &&
    commands(value.conventionChecks) &&
    (value.adapterFreshness === undefined ||
      (isRecord(value.adapterFreshness) &&
        hasOnlyKeys(value.adapterFreshness, [
          "status",
          "localHash",
          "authoritativeHash",
          "reason",
        ]) &&
        ["fresh", "refreshed", "stale", "unknown"].includes(
          String(value.adapterFreshness.status),
        ) &&
        isOptionalString(value.adapterFreshness.localHash, 256) &&
        isOptionalString(value.adapterFreshness.authoritativeHash, 256) &&
        isOptionalString(value.adapterFreshness.reason, 10_000)))
  );
}

function validateAgentResult(value: unknown, taskId: string): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "taskId",
      "outcome",
      "filesModified",
      "filesCreated",
      "verification",
      "turnsUsed",
      "totalCostUsd",
      "messages",
      "error",
      "claudeSessionId",
      "safetyFacts",
    ]) ||
    value.taskId !== taskId ||
    !["success", "failure", "timeout", "budget_exceeded", "max_turns"].includes(
      String(value.outcome),
    ) ||
    !isStringArray(value.filesModified) ||
    !isStringArray(value.filesCreated) ||
    !validateVerificationResult(value.verification) ||
    !Number.isInteger(value.turnsUsed) ||
    !isFiniteNumber(value.turnsUsed, 0, 1_000_000) ||
    !isFiniteNumber(value.totalCostUsd, 0, 1_000_000) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 100_000 ||
    !value.messages.every(
      (message) =>
        isRecord(message) &&
        hasOnlyKeys(message, ["role", "content", "timestamp", "turnNumber"]) &&
        ["user", "assistant", "system"].includes(String(message.role)) &&
        typeof message.content === "string" &&
        message.content.length <= 1_000_000 &&
        isIsoDate(message.timestamp) &&
        Number.isInteger(message.turnNumber) &&
        isFiniteNumber(message.turnNumber, 0, 1_000_000),
    ) ||
    !isOptionalString(value.error, 100_000) ||
    !isOptionalString(value.claudeSessionId, 1_000) ||
    (value.safetyFacts !== undefined && !isSafeJson(value.safetyFacts))
  ) {
    return false;
  }
  return true;
}

function validateJudgeResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "verdict",
      "confidence",
      "scopeViolations",
      "criteriaGaps",
      "qualityIssues",
      "feedback",
      "complianceChecks",
      "criteriaEvaluation",
      "enforcementDemotions",
      "followUpItems",
      "claudeSessionId",
      "judgmentTrace",
      "judgmentDecision",
      "judgmentProjectionFailure",
    ]) ||
    !["APPROVE", "REJECT", "REVISE"].includes(String(value.verdict)) ||
    !isFiniteNumber(value.confidence, 0, 1) ||
    !isStringArray(value.scopeViolations, 10_000, 100_000) ||
    !isStringArray(value.criteriaGaps, 10_000, 100_000) ||
    !isStringArray(value.qualityIssues, 10_000, 100_000) ||
    typeof value.feedback !== "string" ||
    value.feedback.length > 1_000_000 ||
    !isOptionalString(value.claudeSessionId, 1_000)
  ) {
    return false;
  }
  return [
    value.complianceChecks,
    value.criteriaEvaluation,
    value.enforcementDemotions,
    value.followUpItems,
    value.judgmentTrace,
    value.judgmentDecision,
    value.judgmentProjectionFailure,
  ].every(isOptionalSafeJson);
}

function validateOutputSnapshots(value: unknown, taskId: string): boolean {
  if (!Array.isArray(value) || value.length > 1_000) return false;
  return value.every((snapshot) => {
    if (!isRecord(snapshot)) return false;
    if (
      !hasOnlyKeys(snapshot, [
        "taskId",
        "attempt",
        "kind",
        "sealedAt",
        "diffBase",
        "diffRef",
        "baseSha",
        "headShaBefore",
        "headShaAfter",
        "sealedCommitSha",
        "branchName",
        "worktreePath",
        "manifestPath",
        "diffPath",
        "statusPath",
        "nameStatusPath",
        "gitDiff",
        "diffStat",
        "statusShort",
        "changedFiles",
        "nameStatus",
        "filesStaged",
        "excludedFiles",
        "claudeSessionId",
        "empty",
        "sealConformance",
        "secretScan",
      ]) ||
      snapshot.taskId !== taskId ||
      !Number.isInteger(snapshot.attempt) ||
      !isFiniteNumber(snapshot.attempt, 0, 10_000) ||
      !["worker", "retry", "lifecycle_fix"].includes(String(snapshot.kind)) ||
      !isIsoDate(snapshot.sealedAt) ||
      ![snapshot.diffBase, snapshot.diffRef].every(
        (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 500,
      ) ||
      ![snapshot.baseSha, snapshot.headShaBefore, snapshot.headShaAfter].every(
        (entry) => typeof entry === "string" && HASH_PATTERN.test(entry),
      ) ||
      (snapshot.sealedCommitSha !== undefined &&
        (typeof snapshot.sealedCommitSha !== "string" ||
          !HASH_PATTERN.test(snapshot.sealedCommitSha))) ||
      !isOptionalString(snapshot.branchName, 500) ||
      ![
        snapshot.worktreePath,
        snapshot.manifestPath,
        snapshot.diffPath,
        snapshot.statusPath,
        snapshot.nameStatusPath,
      ].every((entry) => typeof entry === "string" && entry.length <= 8_192) ||
      typeof snapshot.gitDiff !== "string" ||
      snapshot.gitDiff.length > 12 * 1024 * 1024 ||
      typeof snapshot.diffStat !== "string" ||
      snapshot.diffStat.length > 1_000_000 ||
      typeof snapshot.statusShort !== "string" ||
      snapshot.statusShort.length > 1_000_000 ||
      !isStringArray(snapshot.changedFiles) ||
      !Array.isArray(snapshot.nameStatus) ||
      !snapshot.nameStatus.every(
        (entry) =>
          isRecord(entry) &&
          hasOnlyKeys(entry, ["status", "path", "previousPath"]) &&
          isBoundedString(entry.status, 100) &&
          isBoundedString(entry.path, 8_192) &&
          isOptionalString(entry.previousPath, 8_192),
      ) ||
      !Number.isInteger(snapshot.filesStaged) ||
      !isFiniteNumber(snapshot.filesStaged, 0, 1_000_000) ||
      !isStringArray(snapshot.excludedFiles) ||
      !isOptionalString(snapshot.claudeSessionId, 1_000) ||
      typeof snapshot.empty !== "boolean" ||
      !isOptionalSafeJson(snapshot.sealConformance) ||
      !isOptionalSafeJson(snapshot.secretScan)
    ) {
      return false;
    }
    return true;
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function safeArchiveComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function expectedArchiveName(taskId: string, ownershipId: string): string {
  return `${safeArchiveComponent(taskId)}-${safeArchiveComponent(ownershipId)}`;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isDispatchSessionId(value: unknown, taskId: string): value is string {
  if (typeof value !== "string") return false;
  const prefix = `quack-${taskId}-`;
  return value.startsWith(prefix) && isUuid(value.slice(prefix.length));
}

function assertRegularFile(filePath: string, maxBytes: number): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error(
      `Docker runtime artifact has an untrusted identity: ${path.basename(filePath)}`,
    );
  }
  return stat;
}

function readRegularFile(filePath: string, maxBytes: number): string {
  const before = assertRegularFile(filePath, maxBytes);
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
      throw new Error(`Docker runtime artifact changed identity: ${path.basename(filePath)}`);
    }
    const value = fs.readFileSync(fd, "utf-8");
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.nlink !== 1 ||
      (opened.ino !== 0 && after.ino !== opened.ino) ||
      (opened.dev !== 0 && after.dev !== opened.dev)
    ) {
      throw new Error(`Docker runtime artifact changed while reading: ${path.basename(filePath)}`);
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(filePath: string): Record<string, unknown> {
  const raw = readRegularFile(filePath, MAX_CONTROL_FILE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Docker runtime artifact is not valid JSON: ${path.basename(filePath)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Docker runtime artifact must contain an object: ${path.basename(filePath)}`);
  }
  return parsed;
}

function writeJsonExclusive(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  fs.renameSync(temporary, filePath);
}

function validateSpecIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "contractHash",
      "auditHash",
      "effectiveContractHash",
      "enrichedContractHash",
      "taskSpecRelativePath",
      "sourceRef",
      "stampedAt",
    ])
  ) {
    return false;
  }
  const hash = (candidate: unknown): boolean =>
    candidate === undefined || (typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate));
  return (
    hash(value.contractHash) &&
    typeof value.contractHash === "string" &&
    hash(value.auditHash) &&
    typeof value.auditHash === "string" &&
    hash(value.effectiveContractHash) &&
    hash(value.enrichedContractHash) &&
    isOptionalString(value.taskSpecRelativePath, 1_000) &&
    isOptionalString(value.sourceRef, 500) &&
    isIsoDate(value.stampedAt)
  );
}

function validateBlueprint(value: unknown, taskId: string): boolean {
  if (!isRecord(value) || value.taskId !== taskId) return false;
  if (
    !Array.isArray(value.fileAnalyses) ||
    !Array.isArray(value.codeExamples) ||
    !Array.isArray(value.verificationPatterns) ||
    !Array.isArray(value.antiPatterns) ||
    !Array.isArray(value.preconditions)
  ) {
    return false;
  }
  const stringArray = (candidate: unknown): boolean =>
    Array.isArray(candidate) &&
    candidate.length <= 10_000 &&
    candidate.every((v) => typeof v === "string");
  if (!stringArray(value.antiPatterns) || !stringArray(value.preconditions)) return false;
  if (
    !value.fileAnalyses.every(
      (entry) =>
        isRecord(entry) &&
        isBoundedString(entry.filePath, 4_096) &&
        ["Create", "Modify", "Delete", "Reference"].includes(String(entry.action)) &&
        typeof entry.currentStructure === "string" &&
        typeof entry.integrationPoints === "string" &&
        typeof entry.patternToFollow === "string",
    )
  ) {
    return false;
  }
  if (
    !value.codeExamples.every(
      (entry) =>
        isRecord(entry) &&
        isBoundedString(entry.file, 4_096) &&
        typeof entry.description === "string" &&
        typeof entry.before === "string" &&
        typeof entry.after === "string",
    )
  ) {
    return false;
  }
  if (
    !value.verificationPatterns.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.criterion === "string" &&
        ["grep", "grep_count", "file_exists", "file_not_exists"].includes(
          String(entry.checkType),
        ) &&
        typeof entry.pattern === "string" &&
        typeof entry.fileGlob === "string" &&
        (entry.expectedMatches === undefined || Number.isInteger(entry.expectedMatches)),
    )
  ) {
    return false;
  }
  return isSafeJson(value);
}

function validateBlueprintApproval(
  value: Record<string, unknown>,
  taskId: string,
  allowedStates: readonly string[],
): void {
  const allowed = [
    "taskId",
    "state",
    "blueprint",
    "preflightResult",
    "approvedBy",
    "rejectionReason",
    "decidedAt",
    "createdAt",
    "executionMode",
    "review",
    "reviewedAt",
    "reviewGate",
    "override",
    "specIdentity",
    "specIdentityVersion",
  ];
  if (
    !hasOnlyKeys(value, allowed) ||
    value.taskId !== taskId ||
    !allowedStates.includes(String(value.state)) ||
    !isIsoDate(value.createdAt) ||
    !validateBlueprint(value.blueprint, taskId) ||
    !isOptionalString(value.approvedBy, 500) ||
    !isOptionalString(value.rejectionReason, 100_000) ||
    (value.decidedAt !== undefined && !isIsoDate(value.decidedAt)) ||
    (value.executionMode !== undefined && value.executionMode !== "loop") ||
    (value.specIdentity !== undefined && !validateSpecIdentity(value.specIdentity)) ||
    (value.specIdentityVersion !== undefined && !Number.isInteger(value.specIdentityVersion)) ||
    !isOptionalSafeJson(value.preflightResult) ||
    !isOptionalSafeJson(value.review) ||
    !isOptionalSafeJson(value.reviewGate) ||
    !isOptionalSafeJson(value.override)
  ) {
    throw new Error(`Invalid Docker blueprint approval for ${taskId}`);
  }
  validateApprovalStateFields(value, taskId, "blueprint");
}

function validateJudgeApproval(
  value: Record<string, unknown>,
  taskId: string,
  allowedStates: readonly string[],
): void {
  const allowed = [
    "taskId",
    "state",
    "diff",
    "filesModified",
    "filesCreated",
    "verificationPassed",
    "approvedBy",
    "rejectionReason",
    "decidedAt",
    "createdAt",
    "executionMode",
    "review",
    "reviewedAt",
    "reviewGate",
    "agentSessionId",
    "intentHold",
    "override",
    "specIdentity",
    "specIdentityVersion",
  ];
  const stringArray = (candidate: unknown): boolean =>
    Array.isArray(candidate) &&
    candidate.length <= 10_000 &&
    candidate.every((v) => typeof v === "string");
  if (
    !hasOnlyKeys(value, allowed) ||
    value.taskId !== taskId ||
    !allowedStates.includes(String(value.state)) ||
    typeof value.diff !== "string" ||
    value.diff.length > 12 * 1024 * 1024 ||
    !stringArray(value.filesModified) ||
    !stringArray(value.filesCreated) ||
    typeof value.verificationPassed !== "boolean" ||
    !isIsoDate(value.createdAt) ||
    !isOptionalString(value.approvedBy, 500) ||
    !isOptionalString(value.rejectionReason, 100_000) ||
    (value.decidedAt !== undefined && !isIsoDate(value.decidedAt)) ||
    (value.executionMode !== undefined && value.executionMode !== "loop") ||
    !isOptionalString(value.reviewedAt, 64) ||
    !isOptionalString(value.agentSessionId, 500) ||
    (value.specIdentity !== undefined && !validateSpecIdentity(value.specIdentity)) ||
    (value.specIdentityVersion !== undefined && !Number.isInteger(value.specIdentityVersion)) ||
    !isOptionalSafeJson(value.review) ||
    !isOptionalSafeJson(value.reviewGate) ||
    !isOptionalSafeJson(value.intentHold) ||
    !isOptionalSafeJson(value.override)
  ) {
    throw new Error(`Invalid Docker judge approval for ${taskId}`);
  }
  validateApprovalStateFields(value, taskId, "judge");
}

function validateApprovalStateFields(
  value: Record<string, unknown>,
  taskId: string,
  gate: "blueprint" | "judge",
): void {
  if (
    value.state === "pending" &&
    (value.approvedBy !== undefined ||
      value.rejectionReason !== undefined ||
      value.decidedAt !== undefined ||
      value.override !== undefined)
  ) {
    throw new Error(`Invalid Docker ${gate} pending decision fields for ${taskId}`);
  }
  if (
    value.state === "approved" &&
    (!isIsoDate(value.decidedAt) ||
      !isBoundedString(value.approvedBy, 500) ||
      value.rejectionReason !== undefined)
  ) {
    throw new Error(`Invalid Docker ${gate} approved decision fields for ${taskId}`);
  }
  if (
    value.state === "rejected" &&
    (!isIsoDate(value.decidedAt) || !isBoundedString(value.rejectionReason, 100_000))
  ) {
    throw new Error(`Invalid Docker ${gate} rejected decision fields for ${taskId}`);
  }
}

function validateCheckpoint(
  value: Record<string, unknown>,
  taskId: string,
  eventSessionId?: string,
): void {
  const allowed = [
    "taskId",
    "sessionId",
    "completedStages",
    "claudeSessionId",
    "agentResult",
    "judgeResult",
    "gateResult",
    "branchName",
    "gitDiff",
    "outputSnapshots",
    "totalCostUsd",
    "retriesUsed",
    "updatedAt",
    "startedAt",
    "parentTaskId",
    "featureBranch",
  ];
  if (
    !hasOnlyKeys(value, allowed) ||
    value.taskId !== taskId ||
    !isBoundedString(value.sessionId, 240)
  ) {
    throw new Error(`Invalid Docker checkpoint identity for ${taskId}`);
  }
  if (eventSessionId && value.sessionId !== eventSessionId) {
    throw new Error(
      `Docker checkpoint session does not match validated event provenance for ${taskId}`,
    );
  }
  if (
    !Array.isArray(value.completedStages) ||
    value.completedStages.length > CHECKPOINT_STAGES.size ||
    new Set(value.completedStages).size !== value.completedStages.length ||
    !value.completedStages.every(
      (stage) => typeof stage === "string" && CHECKPOINT_STAGES.has(stage),
    ) ||
    !isFiniteNumber(value.totalCostUsd, 0, 1_000_000) ||
    !Number.isInteger(value.retriesUsed) ||
    !isFiniteNumber(value.retriesUsed, 0, 10_000) ||
    !isIsoDate(value.updatedAt) ||
    !isIsoDate(value.startedAt) ||
    !isOptionalString(value.claudeSessionId, 1_000) ||
    !isOptionalString(value.gitDiff, 12 * 1024 * 1024) ||
    !isOptionalString(value.parentTaskId, 240) ||
    !isOptionalString(value.branchName, 240) ||
    !isOptionalString(value.featureBranch, 240) ||
    (value.branchName !== undefined && !isSafeRef(value.branchName)) ||
    (value.featureBranch !== undefined && !isSafeRef(value.featureBranch)) ||
    (value.agentResult !== undefined && !validateAgentResult(value.agentResult, taskId)) ||
    (value.judgeResult !== undefined && !validateJudgeResult(value.judgeResult)) ||
    (value.gateResult !== undefined &&
      (!isRecord(value.gateResult) ||
        !["pass", "enriched", "rejected"].includes(String(value.gateResult.outcome)) ||
        !isSafeJson(value.gateResult))) ||
    (value.outputSnapshots !== undefined && !validateOutputSnapshots(value.outputSnapshots, taskId))
  ) {
    throw new Error(`Invalid Docker checkpoint schema for ${taskId}`);
  }
  const stages = new Set(value.completedStages as string[]);
  if (
    (!stages.has("agent") &&
      (value.agentResult !== undefined ||
        value.claudeSessionId !== undefined ||
        value.gitDiff !== undefined ||
        value.outputSnapshots !== undefined)) ||
    (stages.has("agent") &&
      (!validateAgentResult(value.agentResult, taskId) ||
        !Array.isArray(value.outputSnapshots) ||
        value.outputSnapshots.length === 0)) ||
    (stages.has("commit") &&
      (!isBoundedString(value.branchName, 240) || typeof value.gitDiff !== "string")) ||
    (!stages.has("judge") && value.judgeResult !== undefined) ||
    (stages.has("judge") && !validateJudgeResult(value.judgeResult))
  ) {
    throw new Error(`Docker checkpoint fields do not match completed stages for ${taskId}`);
  }
  if (
    isRecord(value.agentResult) &&
    typeof value.agentResult.totalCostUsd === "number" &&
    value.agentResult.totalCostUsd > value.totalCostUsd
  ) {
    throw new Error(`Docker checkpoint cost is lower than its agent result for ${taskId}`);
  }
}

function validateSpecStale(value: Record<string, unknown>, taskId: string): void {
  if (
    !hasOnlyKeys(value, ["taskId", "surface", "verdict", "reason", "refusedAt"]) ||
    value.taskId !== taskId ||
    !isBoundedString(value.surface, 500) ||
    !["stale", "diverged", "unverifiable", "contested"].includes(String(value.verdict)) ||
    !isBoundedString(value.reason, 100_000) ||
    !isIsoDate(value.refusedAt)
  ) {
    throw new Error(`Invalid Docker spec-stale marker for ${taskId}`);
  }
}

function validateLivePayload(stage: string, payload: unknown, taskId: string): boolean {
  if (!isRecord(payload)) return false;
  const exact = (keys: readonly string[]): boolean => hasOnlyKeys(payload, keys);
  switch (stage) {
    case "session_start":
      return (
        exact([
          "model",
          "maxTurns",
          "maxBudget",
          "taskId",
          "taskTitle",
          "taskDescription",
          "jobId",
          "hostId",
          "hostAlias",
          "hostEndpoint",
          "remoteSessionId",
          "leaseId",
          "provenance",
          "federated",
        ]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.model, 500) &&
        isFiniteNumber(payload.maxTurns, 0, 100_000) &&
        isFiniteNumber(payload.maxBudget, 0, 1_000_000) &&
        typeof payload.federated === "boolean" &&
        isOptionalString(payload.taskTitle, 10_000) &&
        isOptionalString(payload.taskDescription, 100_000) &&
        isOptionalString(payload.jobId, 1_000) &&
        isOptionalString(payload.hostId, 1_000) &&
        isOptionalString(payload.hostAlias, 1_000) &&
        isOptionalString(payload.hostEndpoint, 8_192) &&
        isOptionalString(payload.remoteSessionId, 1_000) &&
        isOptionalString(payload.leaseId, 1_000) &&
        isSafeJson(payload.provenance)
      );
    case "agent_turn":
      return (
        exact(["turnNumber", "role", "contentPreview"]) &&
        Number.isInteger(payload.turnNumber) &&
        isFiniteNumber(payload.turnNumber, 0, 1_000_000) &&
        isBoundedString(payload.role, 100) &&
        typeof payload.contentPreview === "string" &&
        payload.contentPreview.length <= 10_000
      );
    case "agent_tool_use":
      return (
        exact(["turnNumber", "toolName", "filePath", "bashCommand"]) &&
        Number.isInteger(payload.turnNumber) &&
        isFiniteNumber(payload.turnNumber, 0, 1_000_000) &&
        isBoundedString(payload.toolName, 500) &&
        isOptionalString(payload.filePath, 8_192) &&
        isOptionalString(payload.bashCommand, 10_000)
      );
    case "agent_complete":
      return (
        exact([
          "outcome",
          "turnsUsed",
          "totalCostUsd",
          "filesModified",
          "claudeSessionId",
          "errors",
        ]) &&
        isBoundedString(payload.outcome, 500) &&
        Number.isInteger(payload.turnsUsed) &&
        isFiniteNumber(payload.turnsUsed, 0, 1_000_000) &&
        isFiniteNumber(payload.totalCostUsd, 0, 1_000_000) &&
        Array.isArray(payload.filesModified) &&
        payload.filesModified.length <= 100_000 &&
        payload.filesModified.every(
          (entry) => typeof entry === "string" && entry.length <= 8_192,
        ) &&
        isOptionalString(payload.claudeSessionId, 1_000) &&
        (payload.errors === undefined ||
          (Array.isArray(payload.errors) &&
            payload.errors.length <= 10 &&
            payload.errors.every((entry) => typeof entry === "string" && entry.length <= 500)))
      );
    case "agent_progress":
      return (
        exact(["taskId", "turnNumber", "toolName", "filePath", "costUsd", "elapsedMs"]) &&
        payload.taskId === taskId &&
        Number.isInteger(payload.turnNumber) &&
        isFiniteNumber(payload.turnNumber, 0, 1_000_000) &&
        isFiniteNumber(payload.elapsedMs, 0) &&
        (payload.costUsd === undefined || isFiniteNumber(payload.costUsd, 0, 1_000_000)) &&
        isOptionalString(payload.toolName, 500) &&
        isOptionalString(payload.filePath, 8_192)
      );
    case "stage_started":
    case "stage_heartbeat":
      return (
        exact(["taskId", "scope", "stage", "staleAfterMs", "recommendedAction", "detail"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.scope, 200) &&
        isBoundedString(payload.stage, 200) &&
        isFiniteNumber(payload.staleAfterMs, 1, 24 * 60 * 60 * 1000) &&
        isBoundedString(payload.recommendedAction, 4_000) &&
        isOptionalString(payload.detail, 10_000)
      );
    case "stage_completed":
      return (
        exact(["taskId", "scope", "stage", "detail"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.scope, 200) &&
        isBoundedString(payload.stage, 200) &&
        isOptionalString(payload.detail, 10_000)
      );
    case "stage_failed":
      return (
        exact(["taskId", "scope", "stage", "error", "recommendedAction", "detail"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.scope, 200) &&
        isBoundedString(payload.stage, 200) &&
        isBoundedString(payload.error, 10_000) &&
        isBoundedString(payload.recommendedAction, 4_000) &&
        isOptionalString(payload.detail, 10_000)
      );
    case "blueprint_start":
      return (
        exact(["taskId", "cached", "mode", "warningMs", "timeoutMs"]) &&
        payload.taskId === taskId &&
        typeof payload.cached === "boolean" &&
        ["dispatch", "loop"].includes(String(payload.mode)) &&
        isFiniteNumber(payload.warningMs, 1) &&
        isFiniteNumber(payload.timeoutMs, 1)
      );
    case "blueprint_warning":
    case "blueprint_fallback":
      return (
        exact(["taskId", "reason", "elapsedMs", "timeoutMs"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.reason, 2_000) &&
        isFiniteNumber(payload.elapsedMs, 0) &&
        (payload.timeoutMs === undefined || isFiniteNumber(payload.timeoutMs, 1))
      );
    case "checkpoint_saved":
      return (
        exact(["taskId", "stage", "completedStages"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.stage, 200) &&
        Array.isArray(payload.completedStages) &&
        payload.completedStages.every(
          (entry) => typeof entry === "string" && CHECKPOINT_STAGES.has(entry),
        )
      );
    case "checkpoint_loaded":
      return (
        exact(["taskId", "completedStages", "resumeFromStage"]) &&
        payload.taskId === taskId &&
        Array.isArray(payload.completedStages) &&
        payload.completedStages.every(
          (entry) => typeof entry === "string" && CHECKPOINT_STAGES.has(entry),
        ) &&
        typeof payload.resumeFromStage === "string" &&
        CHECKPOINT_STAGES.has(payload.resumeFromStage)
      );
    case "stage_skipped":
      return (
        exact(["taskId", "stage", "reason"]) &&
        payload.taskId === taskId &&
        isBoundedString(payload.stage, 200) &&
        isBoundedString(payload.reason, 10_000)
      );
    case "blueprint_pending_approval":
      return (
        exact(["taskId", "autoApproveAttempted", "reason"]) &&
        payload.taskId === taskId &&
        typeof payload.autoApproveAttempted === "boolean" &&
        isBoundedString(payload.reason, 10_000)
      );
    case "judge_pending_approval":
      return (
        exact(["taskId", "filesChanged", "diffLines", "reason"]) &&
        payload.taskId === taskId &&
        isFiniteNumber(payload.filesChanged, 0, 1_000_000) &&
        isFiniteNumber(payload.diffLines, 0, 10_000_000) &&
        isOptionalString(payload.reason, 10_000)
      );
    default:
      return false;
  }
}

function validateManifest(value: Record<string, unknown>, taskId: string): RuntimeManifest {
  if (
    !hasOnlyKeys(value, [
      "version",
      "taskId",
      "dispatchSessionId",
      "ownershipId",
      "startedAt",
      "eventSessionId",
      "project",
      "provenance",
      "parentTaskId",
      "sharedBranchName",
      "telemetryValidatedAt",
      "resumeSource",
      "gitState",
      "state",
      "sealedAt",
    ]) ||
    value.version !== 1 ||
    value.taskId !== taskId ||
    !isDispatchSessionId(value.dispatchSessionId, taskId) ||
    value.eventSessionId !== value.dispatchSessionId ||
    !isUuid(value.ownershipId) ||
    !isIsoDate(value.startedAt) ||
    !isBoundedString(value.project, 500) ||
    !isRecord(value.provenance) ||
    !isValidDecompositionBinding(value.parentTaskId, value.sharedBranchName) ||
    (value.telemetryValidatedAt !== undefined && !isIsoDate(value.telemetryValidatedAt)) ||
    (value.resumeSource !== undefined && !validateResumeSourceBinding(value.resumeSource)) ||
    (value.gitState !== undefined && !validateResumeGitBinding(value.gitState)) ||
    !["active", "sealed", "rejected"].includes(String(value.state)) ||
    (value.sealedAt !== undefined && !isIsoDate(value.sealedAt))
  ) {
    throw new Error(`Invalid Docker runtime archive manifest for ${taskId}`);
  }
  return value as unknown as RuntimeManifest;
}

function validateResumeSourceBinding(value: unknown): value is DockerResumeSourceBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "archiveName",
      "dispatchSessionId",
      "eventSessionId",
      "ownershipId",
      "approvedGate",
      "gitState",
      "approvedDiffHash",
      "parentTaskId",
      "sharedBranchName",
    ]) &&
    isBoundedString(value.archiveName, 1_000) &&
    isBoundedString(value.dispatchSessionId, 500) &&
    value.eventSessionId === value.dispatchSessionId &&
    isUuid(value.ownershipId) &&
    ["blueprint", "judge"].includes(String(value.approvedGate)) &&
    validateResumeGitBinding(value.gitState) &&
    (value.approvedDiffHash === undefined ||
      (typeof value.approvedDiffHash === "string" &&
        /^[a-f0-9]{64}$/i.test(value.approvedDiffHash))) &&
    (value.approvedGate === "judge" || value.approvedDiffHash === undefined) &&
    isValidDecompositionBinding(value.parentTaskId, value.sharedBranchName)
  );
}

function validateResumeGitBinding(value: unknown): value is DockerResumeGitBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["authoritativeRef", "baseHead", "candidateHead", "sealedRef"]) &&
    typeof value.authoritativeRef === "string" &&
    value.authoritativeRef.startsWith("refs/heads/") &&
    isSafeRef(value.authoritativeRef) &&
    typeof value.sealedRef === "string" &&
    value.sealedRef.startsWith("refs/quack/docker-resume/") &&
    isSafeRef(value.sealedRef) &&
    typeof value.baseHead === "string" &&
    /^[a-f0-9]{40,64}$/i.test(value.baseHead) &&
    typeof value.candidateHead === "string" &&
    /^[a-f0-9]{40,64}$/i.test(value.candidateHead) &&
    value.baseHead.length === value.candidateHead.length
  );
}

function assertArchiveIdentity(
  sourceArchive: string,
  taskId: string,
  manifest: RuntimeManifest,
): void {
  const stat = fs.lstatSync(sourceArchive);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Docker runtime archive for ${taskId} is not a trusted directory`);
  }
  if (
    path.basename(path.resolve(sourceArchive)) !== expectedArchiveName(taskId, manifest.ownershipId)
  ) {
    throw new Error(`Docker runtime archive identity does not match its ownership for ${taskId}`);
  }
  if (
    manifest.eventSessionId !== manifest.dispatchSessionId ||
    !manifest.telemetryValidatedAt ||
    manifest.state !== "sealed" ||
    !manifest.sealedAt
  ) {
    throw new Error(`Docker runtime archive for ${taskId} has no validated sealed session`);
  }
}

function checkpointStages(value: Record<string, unknown>): Set<string> {
  return new Set(value.completedStages as string[]);
}

function validateApprovalDecisionTiming(
  approval: Record<string, unknown>,
  manifest: RuntimeManifest,
  taskId: string,
): void {
  if (approval.state !== "approved" || !isIsoDate(approval.decidedAt)) {
    throw new Error(`Docker resume for ${taskId} requires an operator-approved gate artifact`);
  }
  const decidedAt = Date.parse(approval.decidedAt);
  const sealedAt = Date.parse(manifest.sealedAt!);
  if (decidedAt < sealedAt || decidedAt > Date.now() + CLOCK_SKEW_MS) {
    throw new Error(
      `Docker approval decision is outside the host-owned archive lifecycle for ${taskId}`,
    );
  }
}

interface ValidatedDockerResumeState {
  manifest: RuntimeManifest;
  checkpoint: Record<string, unknown>;
  approval: Record<string, unknown>;
  approvalFile: string;
  approvedGate: "blueprint" | "judge";
  binding: DockerResumeSourceBinding;
}

export interface DockerPausedRuntimeBinding extends DockerResumeSourceBinding {
  archiveDir: string;
  provenance: JobProvenance;
  startedAt: string;
  approvalCreatedAt: string;
}

export interface DockerValidatedResumeArchive extends DockerResumeSourceBinding {
  archiveDir: string;
  provenance: JobProvenance;
  startedAt: string;
}

function validateGateCheckpoint(
  checkpoint: Record<string, unknown>,
  taskId: string,
  gate: "blueprint" | "judge",
  approval?: Record<string, unknown>,
): void {
  const stages = checkpointStages(checkpoint);
  if (gate === "blueprint") {
    if (!stages.has("gate") || !stages.has("blueprint") || stages.has("approve")) {
      throw new Error(
        `Docker blueprint approval is inconsistent with its checkpoint for ${taskId}`,
      );
    }
    for (const later of ["branch", "context", "agent", "commit", "judge_review", "judge", "pr"]) {
      if (stages.has(later)) {
        throw new Error(
          `Docker blueprint approval contains impossible later-stage claims for ${taskId}`,
        );
      }
    }
    return;
  }
  for (const prerequisite of [
    "gate",
    "blueprint",
    "approve",
    "branch",
    "context",
    "agent",
    "commit",
  ]) {
    if (!stages.has(prerequisite)) {
      throw new Error(
        `Docker judge approval lacks ${prerequisite} checkpoint evidence for ${taskId}`,
      );
    }
  }
  if (stages.has("judge_review") || stages.has("judge") || stages.has("pr")) {
    throw new Error(`Docker judge approval contains impossible later-stage claims for ${taskId}`);
  }
  if (approval) {
    if (typeof checkpoint.gitDiff !== "string" || approval.diff !== checkpoint.gitDiff) {
      throw new Error(
        `Docker judge approval does not match the sealed checkpoint diff for ${taskId}`,
      );
    }
    if (
      approval.agentSessionId !== undefined &&
      approval.agentSessionId !== checkpoint.claudeSessionId
    ) {
      throw new Error(
        `Docker judge approval does not match the sealed agent session for ${taskId}`,
      );
    }
  }
}

function validateArchivedEventEvidence(
  sourceArchive: string,
  taskId: string,
  manifest: RuntimeManifest,
  checkpoint: Record<string, unknown>,
  gate: "blueprint" | "judge",
): void {
  const eventPath = path.join(sourceArchive, `events-${manifest.eventSessionId}.jsonl`);
  const raw = readRegularFile(eventPath, MAX_EVENT_FILE_BYTES);
  let sessionStarts = 0;
  let matchingAgentComplete = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Docker event evidence is malformed for ${taskId}`);
    }
    if (
      !isRecord(parsed) ||
      parsed.sessionId !== manifest.eventSessionId ||
      parsed.taskId !== taskId ||
      parsed.project !== manifest.project ||
      !isIsoDate(parsed.timestamp) ||
      typeof parsed.stage !== "string" ||
      !isRecord(parsed.payload)
    ) {
      throw new Error(`Docker event evidence changed provenance for ${taskId}`);
    }
    if (parsed.stage === "session_start") {
      sessionStarts += 1;
      if (
        !validateLivePayload(parsed.stage, parsed.payload, taskId) ||
        !sameJson(parsed.payload.provenance, manifest.provenance)
      ) {
        throw new Error(`Docker session_start evidence is invalid for ${taskId}`);
      }
    } else if (parsed.stage === "agent_complete") {
      if (!validateLivePayload(parsed.stage, parsed.payload, taskId)) {
        throw new Error(`Docker agent completion evidence is invalid for ${taskId}`);
      }
      const agentResult = checkpoint.agentResult;
      matchingAgentComplete =
        isRecord(agentResult) &&
        parsed.payload.turnsUsed === agentResult.turnsUsed &&
        parsed.payload.totalCostUsd === agentResult.totalCostUsd &&
        sameJson(parsed.payload.filesModified, agentResult.filesModified) &&
        parsed.payload.claudeSessionId === agentResult.claudeSessionId;
    } else if (
      !SAFE_LIVE_STAGES.has(parsed.stage) &&
      !["session_complete", "session_error"].includes(parsed.stage)
    ) {
      throw new Error(`Docker event evidence contains a non-allowlisted stage for ${taskId}`);
    }
  }
  if (sessionStarts !== 1) {
    throw new Error(`Docker resume requires exactly one validated session_start for ${taskId}`);
  }
  if (gate === "judge" && !matchingAgentComplete) {
    throw new Error(`Docker judge approval lacks matching agent completion evidence for ${taskId}`);
  }
}

function validateDockerResumeState(
  sourceArchive: string,
  taskId: string,
): ValidatedDockerResumeState {
  const manifest = validateManifest(readJson(path.join(sourceArchive, RUNTIME_MANIFEST)), taskId);
  assertArchiveIdentity(sourceArchive, taskId, manifest);
  if (!manifest.gitState) {
    throw new Error(`Docker resume archive for ${taskId} has no sealed private Git state`);
  }
  const checkpoint = readJson(path.join(sourceArchive, `checkpoint-${taskId}.json`));
  validateCheckpoint(checkpoint, taskId, manifest.eventSessionId);
  if (checkpoint.startedAt !== manifest.startedAt) {
    throw new Error(`Docker checkpoint lifecycle does not match its host archive for ${taskId}`);
  }
  if (
    manifest.parentTaskId &&
    (checkpoint.parentTaskId !== manifest.parentTaskId ||
      checkpoint.featureBranch !== manifest.sharedBranchName)
  ) {
    throw new Error(`Docker checkpoint decomposition identity changed for ${taskId}`);
  }
  const blueprintPath = path.join(sourceArchive, "approvals", `${taskId}.json`);
  const judgePath = path.join(sourceArchive, "approvals", `${taskId}-judge.json`);
  const present = [blueprintPath, judgePath].filter((candidate) => fs.existsSync(candidate));
  if (present.length !== 1) {
    throw new Error(`Docker resume for ${taskId} requires exactly one approved gate artifact`);
  }

  const approvalFile = present[0];
  const approval = readJson(approvalFile);
  const approvedGate = approvalFile === blueprintPath ? "blueprint" : "judge";
  if (approvedGate === "blueprint") {
    validateBlueprintApproval(approval, taskId, ["approved"]);
  } else {
    validateJudgeApproval(approval, taskId, ["approved"]);
  }
  validateGateCheckpoint(checkpoint, taskId, approvedGate, approval);
  validateArchivedEventEvidence(sourceArchive, taskId, manifest, checkpoint, approvedGate);
  validateApprovalDecisionTiming(approval, manifest, taskId);
  return {
    manifest,
    checkpoint,
    approval,
    approvalFile,
    approvedGate,
    binding: {
      archiveName: path.basename(sourceArchive),
      dispatchSessionId: manifest.dispatchSessionId,
      eventSessionId: manifest.eventSessionId,
      ownershipId: manifest.ownershipId,
      approvedGate,
      gitState: manifest.gitState,
      ...(approvedGate === "judge"
        ? {
            approvedDiffHash: createHash("sha256")
              .update(String(approval.diff), "utf-8")
              .digest("hex"),
          }
        : {}),
      ...(manifest.parentTaskId ? { parentTaskId: manifest.parentTaskId } : {}),
      ...(manifest.sharedBranchName ? { sharedBranchName: manifest.sharedBranchName } : {}),
    },
  };
}

export function inspectValidatedDockerPendingArchive(
  sourceArchive: string,
  taskId: string,
): DockerPausedRuntimeBinding {
  const manifest = validateManifest(readJson(path.join(sourceArchive, RUNTIME_MANIFEST)), taskId);
  assertArchiveIdentity(sourceArchive, taskId, manifest);
  if (!manifest.gitState) {
    throw new Error(`Docker pause archive for ${taskId} has no sealed private Git state`);
  }
  const checkpoint = readJson(path.join(sourceArchive, `checkpoint-${taskId}.json`));
  validateCheckpoint(checkpoint, taskId, manifest.eventSessionId);
  if (checkpoint.startedAt !== manifest.startedAt) {
    throw new Error(`Docker checkpoint lifecycle does not match its host archive for ${taskId}`);
  }
  if (
    manifest.parentTaskId &&
    (checkpoint.parentTaskId !== manifest.parentTaskId ||
      checkpoint.featureBranch !== manifest.sharedBranchName)
  ) {
    throw new Error(`Docker checkpoint decomposition identity changed for ${taskId}`);
  }
  const blueprintPath = path.join(sourceArchive, "approvals", `${taskId}.json`);
  const judgePath = path.join(sourceArchive, "approvals", `${taskId}-judge.json`);
  const present = [blueprintPath, judgePath].filter((candidate) => fs.existsSync(candidate));
  if (present.length !== 1) {
    throw new Error(`Docker pause for ${taskId} requires exactly one pending gate artifact`);
  }
  const approvalPath = present[0];
  const approval = readJson(approvalPath);
  const approvedGate = approvalPath === blueprintPath ? "blueprint" : "judge";
  if (approvedGate === "blueprint") {
    validateBlueprintApproval(approval, taskId, ["pending"]);
  } else {
    validateJudgeApproval(approval, taskId, ["pending"]);
  }
  validateGateCheckpoint(checkpoint, taskId, approvedGate, approval);
  validateArchivedEventEvidence(sourceArchive, taskId, manifest, checkpoint, approvedGate);
  const createdAt = Date.parse(String(approval.createdAt));
  if (
    createdAt < Date.parse(manifest.startedAt) - CLOCK_SKEW_MS ||
    createdAt > Date.parse(manifest.sealedAt!) + CLOCK_SKEW_MS
  ) {
    throw new Error(
      `Docker pending approval is outside its sealed runtime lifecycle for ${taskId}`,
    );
  }
  return {
    archiveDir: path.resolve(sourceArchive),
    archiveName: path.basename(sourceArchive),
    dispatchSessionId: manifest.dispatchSessionId,
    eventSessionId: manifest.eventSessionId,
    ownershipId: manifest.ownershipId,
    approvedGate,
    gitState: manifest.gitState,
    ...(approvedGate === "judge"
      ? {
          approvedDiffHash: createHash("sha256")
            .update(String(approval.diff), "utf-8")
            .digest("hex"),
        }
      : {}),
    ...(manifest.parentTaskId ? { parentTaskId: manifest.parentTaskId } : {}),
    ...(manifest.sharedBranchName ? { sharedBranchName: manifest.sharedBranchName } : {}),
    provenance: manifest.provenance,
    startedAt: manifest.startedAt,
    approvalCreatedAt: String(approval.createdAt),
  };
}

export class DockerRuntimeBridge {
  readonly archiveDir: string;
  private readonly sourceIdentity: { dev: number; ino: number; realPath: string };
  private readonly cursors = new Map<string, FileCursor>();
  private timer?: ReturnType<typeof setInterval>;
  private fatalError?: Error;
  private closed = false;
  private manifest: RuntimeManifest;
  private latestCostUsd = 0;
  private latestTurnsUsed = 0;
  private activeSessionWritten = false;
  private terminalSessionWritten = false;

  constructor(private readonly options: DockerRuntimeBridgeOptions) {
    const sourceStat = fs.lstatSync(options.sourceDir);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error("Docker runtime source is not a trusted directory");
    }
    this.sourceIdentity = {
      dev: sourceStat.dev,
      ino: sourceStat.ino,
      realPath: fs.realpathSync.native(options.sourceDir),
    };
    fs.mkdirSync(options.archiveRoot, { recursive: true });
    const archiveRootStat = fs.lstatSync(options.archiveRoot);
    if (!archiveRootStat.isDirectory() || archiveRootStat.isSymbolicLink()) {
      throw new Error("Docker runtime archive root is not a trusted directory");
    }
    if (!isDispatchSessionId(options.dispatchSessionId, options.taskId)) {
      throw new Error("Docker runtime bridge requires the host-assigned dispatch session id");
    }
    if (!isUuid(options.ownershipId)) {
      throw new Error("Docker runtime bridge requires a UUID-backed worktree ownership id");
    }
    if (!isBoundedString(options.expectedProject, 500)) {
      throw new Error("Docker runtime bridge requires a host-known project identity");
    }
    if (!isValidDecompositionBinding(options.parentTaskId, options.sharedBranchName)) {
      throw new Error("Docker runtime bridge requires paired parent/shared branch identity");
    }
    if (options.resumeSource && !validateResumeSourceBinding(options.resumeSource)) {
      throw new Error("Docker runtime bridge received an invalid resume source binding");
    }
    if (
      options.resumeSource &&
      (options.resumeSource.parentTaskId !== options.parentTaskId ||
        options.resumeSource.sharedBranchName !== options.sharedBranchName)
    ) {
      throw new Error("Docker runtime bridge resume lineage changed decomposition identity");
    }
    this.archiveDir = path.join(
      options.archiveRoot,
      expectedArchiveName(options.taskId, options.ownershipId),
    );
    fs.mkdirSync(this.archiveDir, { recursive: false });
    this.manifest = {
      version: 1,
      taskId: options.taskId,
      dispatchSessionId: options.dispatchSessionId,
      ownershipId: options.ownershipId,
      startedAt: options.startedAt,
      eventSessionId: options.dispatchSessionId,
      project: options.expectedProject,
      provenance: options.provenance,
      ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      ...(options.sharedBranchName ? { sharedBranchName: options.sharedBranchName } : {}),
      ...(options.resumeSource ? { resumeSource: options.resumeSource } : {}),
      state: "active",
    };
    writeJsonExclusive(path.join(this.archiveDir, RUNTIME_MANIFEST), this.manifest);
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.pollOnce();
    this.timer = setInterval(
      () => this.pollOnce(),
      Math.max(25, this.options.pollIntervalMs ?? 100),
    );
    this.timer.unref();
  }

  pollOnce(): number {
    if (this.closed || this.fatalError) return 0;
    try {
      this.assertSourceIdentity();
      let accepted = 0;
      for (const entry of fs.readdirSync(this.options.sourceDir, { withFileTypes: true })) {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !/^events-[A-Za-z0-9._-]+\.jsonl$/.test(entry.name)
        ) {
          continue;
        }
        accepted += this.readEventFile(entry.name);
      }
      return accepted;
    } catch (error: unknown) {
      this.fatalError = error instanceof Error ? error : new Error(String(error));
      this.recordRejection(this.fatalError.message);
      return 0;
    }
  }

  sealAndImport(): string {
    if (this.closed) return this.archiveDir;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pollOnce();
    this.closed = true;
    if (this.fatalError) {
      this.updateManifest("rejected");
      throw this.fatalError;
    }
    try {
      this.assertSourceIdentity();
      this.assertAllowedTree();
      this.importControlArtifacts();
      this.updateManifest("sealed");
      return this.archiveDir;
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.recordRejection(failure.message);
      this.updateManifest("rejected");
      throw failure;
    }
  }

  abort(reason: string): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closed = true;
    this.recordRejection(reason);
    this.updateManifest("rejected");
  }

  recordGitResumeState(gitState: DockerResumeGitBinding): void {
    if (!this.closed || this.manifest.state !== "sealed") {
      throw new Error("Docker private Git state can only be attached to a sealed runtime archive");
    }
    if (!validateResumeGitBinding(gitState)) {
      throw new Error("Docker private Git resume state is invalid");
    }
    if (this.manifest.gitState) {
      if (!isDeepStrictEqual(this.manifest.gitState, gitState)) {
        throw new Error("Docker private Git resume state was already sealed with different values");
      }
      return;
    }
    this.manifest = { ...this.manifest, gitState };
    writeJsonAtomic(path.join(this.archiveDir, RUNTIME_MANIFEST), this.manifest);
  }

  emitTrustedTerminal(terminal: DockerRuntimeTerminal): void {
    if (this.terminalSessionWritten) return;
    const sessionId = this.manifest.eventSessionId;
    const project = this.manifest.project;
    const timestamp = new Date().toISOString();
    const event: QuackEvent =
      terminal.outcome === "error"
        ? {
            sessionId,
            taskId: this.options.taskId,
            project,
            timestamp,
            stage: "session_error",
            payload: { error: terminal.error ?? "Docker dispatch failed", failedStage: "docker" },
          }
        : {
            sessionId,
            taskId: this.options.taskId,
            project,
            timestamp,
            stage: "session_complete",
            payload: {
              outcome: terminal.outcome,
              durationMs: Math.max(0, Date.now() - Date.parse(this.options.startedAt)),
              totalCostUsd: terminal.totalCostUsd ?? this.latestCostUsd,
              ...(terminal.turnsUsed !== undefined || this.latestTurnsUsed > 0
                ? { turnsUsed: terminal.turnsUsed ?? this.latestTurnsUsed }
                : {}),
            },
          };
    fs.appendFileSync(
      path.join(this.archiveDir, `events-${sessionId}.jsonl`),
      `${JSON.stringify(event)}\n`,
      "utf-8",
    );
    this.writeHostSession(
      terminal.outcome === "error" ? "error" : "completed",
      terminal.outcome,
      terminal.totalCostUsd ?? this.latestCostUsd,
      terminal.turnsUsed ?? this.latestTurnsUsed,
    );
    this.terminalSessionWritten = true;
  }

  private writeHostSession(
    status: SessionEntry["status"],
    outcome?: string,
    totalCostUsd?: number,
    turnsUsed?: number,
    title?: string,
  ): void {
    const entry: SessionEntry = {
      sessionId: this.options.dispatchSessionId,
      taskId: this.options.taskId,
      project: this.options.expectedProject,
      ...(title ? { title } : {}),
      startTime: this.options.startedAt,
      status,
      ...(outcome ? { outcome } : {}),
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...(status !== "active"
        ? { durationMs: Math.max(0, Date.now() - Date.parse(this.options.startedAt)) }
        : {}),
      ...(turnsUsed !== undefined && turnsUsed > 0 ? { turnsUsed } : {}),
    };
    fs.appendFileSync(
      path.join(this.archiveDir, "sessions.jsonl"),
      `${JSON.stringify(entry)}\n`,
      "utf-8",
    );
  }

  private assertSourceIdentity(): void {
    const stat = fs.lstatSync(this.options.sourceDir);
    const real = fs.realpathSync.native(this.options.sourceDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      real !== this.sourceIdentity.realPath ||
      (this.sourceIdentity.ino !== 0 && stat.ino !== this.sourceIdentity.ino) ||
      (this.sourceIdentity.dev !== 0 && stat.dev !== this.sourceIdentity.dev)
    ) {
      throw new Error("Docker runtime source changed identity during dispatch");
    }
  }

  private readEventFile(fileName: string): number {
    const source = path.join(this.options.sourceDir, fileName);
    const stat = assertRegularFile(source, MAX_EVENT_FILE_BYTES);
    const sessionId = fileName.slice("events-".length, -".jsonl".length);
    if (sessionId !== this.options.dispatchSessionId) {
      this.recordRejection("Rejected Docker event file with an unowned session id");
      return 0;
    }
    let cursor = this.cursors.get(fileName);
    if (!cursor) {
      cursor = {
        dev: stat.dev,
        ino: stat.ino,
        offset: 0,
        remainder: "",
        sessionId,
        started: false,
      };
      this.cursors.set(fileName, cursor);
    }
    if (
      stat.size < cursor.offset ||
      (cursor.ino !== 0 && stat.ino !== cursor.ino) ||
      (cursor.dev !== 0 && stat.dev !== cursor.dev)
    ) {
      throw new Error(`Docker event stream changed identity: ${fileName}`);
    }
    if (stat.size === cursor.offset) return 0;
    const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let chunk: Buffer;
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size < cursor.offset ||
        (cursor.ino !== 0 && opened.ino !== cursor.ino) ||
        (cursor.dev !== 0 && opened.dev !== cursor.dev)
      ) {
        throw new Error(`Docker event stream changed while reading: ${fileName}`);
      }
      chunk = Buffer.alloc(opened.size - cursor.offset);
      fs.readSync(fd, chunk, 0, chunk.length, cursor.offset);
      cursor.offset = opened.size;
    } finally {
      fs.closeSync(fd);
    }
    const complete = cursor.remainder + chunk.toString("utf-8");
    const lines = complete.split("\n");
    cursor.remainder = lines.pop() ?? "";
    let accepted = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = this.validateLiveEvent(JSON.parse(line) as unknown, cursor);
        fs.appendFileSync(
          path.join(this.archiveDir, fileName),
          `${JSON.stringify(event)}\n`,
          "utf-8",
        );
        if (event.stage === "agent_complete") {
          const payload = event.payload as { totalCostUsd: number; turnsUsed: number };
          this.latestCostUsd = payload.totalCostUsd;
          this.latestTurnsUsed = payload.turnsUsed;
        }
        accepted += 1;
      } catch (error: unknown) {
        this.recordRejection(error instanceof Error ? error.message : String(error));
      }
    }
    return accepted;
  }

  private validateLiveEvent(value: unknown, cursor: FileCursor): QuackEvent {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["sessionId", "taskId", "project", "timestamp", "stage", "payload"])
    ) {
      throw new Error("Rejected Docker event with an invalid envelope");
    }
    if (
      value.sessionId !== this.options.dispatchSessionId ||
      value.sessionId !== cursor.sessionId ||
      value.taskId !== this.options.taskId ||
      value.project !== this.options.expectedProject ||
      !isIsoDate(value.timestamp) ||
      Date.parse(value.timestamp) < Date.parse(this.options.startedAt) - CLOCK_SKEW_MS ||
      Date.parse(value.timestamp) > Date.now() + CLOCK_SKEW_MS ||
      typeof value.stage !== "string" ||
      !SAFE_LIVE_STAGES.has(value.stage) ||
      !validateLivePayload(value.stage, value.payload, this.options.taskId)
    ) {
      throw new Error(`Rejected untrusted Docker event for ${this.options.taskId}`);
    }
    if (!cursor.started) {
      if (value.stage !== "session_start") {
        throw new Error("Rejected Docker telemetry before a validated session_start");
      }
      const payload = value.payload as Record<string, unknown>;
      if (!sameJson(payload.provenance, this.options.provenance)) {
        throw new Error("Rejected Docker session_start with mismatched provenance");
      }
      this.manifest.eventSessionId = value.sessionId;
      this.manifest.project = value.project;
      this.manifest.telemetryValidatedAt = new Date().toISOString();
      cursor.started = true;
      cursor.project = value.project;
      writeJsonAtomic(path.join(this.archiveDir, RUNTIME_MANIFEST), this.manifest);
      if (!this.activeSessionWritten) {
        const payload = value.payload as Record<string, unknown>;
        this.writeHostSession(
          "active",
          undefined,
          undefined,
          undefined,
          typeof payload.taskTitle === "string" ? payload.taskTitle : undefined,
        );
        this.activeSessionWritten = true;
      }
    } else if (value.stage === "session_start") {
      throw new Error("Rejected duplicate Docker session_start telemetry");
    } else if (value.project !== cursor.project) {
      throw new Error("Rejected Docker event whose project changed within the session");
    }
    return value as unknown as QuackEvent;
  }

  private assertAllowedTree(): void {
    const checkpoint = `checkpoint-${this.options.taskId}.json`;
    for (const entry of fs.readdirSync(this.options.sourceDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Untrusted Docker runtime entry: ${entry.name}`);
      if (entry.isFile()) {
        if (
          entry.name === "sessions.jsonl" ||
          entry.name === checkpoint ||
          entry.name === `events-${this.options.dispatchSessionId}.jsonl`
        ) {
          assertRegularFile(path.join(this.options.sourceDir, entry.name), MAX_CONTROL_FILE_BYTES);
          continue;
        }
        throw new Error(`Docker runtime artifact is not allowlisted: ${entry.name}`);
      }
      if (!entry.isDirectory() || !["approvals", "spec-stale"].includes(entry.name)) {
        throw new Error(`Docker runtime artifact is not allowlisted: ${entry.name}`);
      }
      const allowedChildren =
        entry.name === "approvals"
          ? new Set([`${this.options.taskId}.json`, `${this.options.taskId}-judge.json`])
          : new Set([`${this.options.taskId}.json`]);
      for (const child of fs.readdirSync(path.join(this.options.sourceDir, entry.name), {
        withFileTypes: true,
      })) {
        if (!child.isFile() || child.isSymbolicLink() || !allowedChildren.has(child.name)) {
          throw new Error(
            `Docker runtime artifact is not allowlisted: ${entry.name}/${child.name}`,
          );
        }
      }
    }
  }

  private importControlArtifacts(): void {
    const eventSessionId = this.manifest.eventSessionId;
    const checkpointName = `checkpoint-${this.options.taskId}.json`;
    const checkpointSource = path.join(this.options.sourceDir, checkpointName);
    let checkpoint: Record<string, unknown> | undefined;
    if (fs.existsSync(checkpointSource)) {
      checkpoint = readJson(checkpointSource);
      validateCheckpoint(checkpoint, this.options.taskId, eventSessionId);
    }

    const approvals: Array<{
      source: string;
      target: string;
      kind: "blueprint" | "judge";
      value?: Record<string, unknown>;
    }> = [
      {
        source: path.join(this.options.sourceDir, "approvals", `${this.options.taskId}.json`),
        target: path.join(this.archiveDir, "approvals", `${this.options.taskId}.json`),
        kind: "blueprint",
      },
      {
        source: path.join(this.options.sourceDir, "approvals", `${this.options.taskId}-judge.json`),
        target: path.join(this.archiveDir, "approvals", `${this.options.taskId}-judge.json`),
        kind: "judge",
      },
    ];
    const pendingApprovals: Array<{
      source: string;
      target: string;
      kind: "blueprint" | "judge";
      value: Record<string, unknown>;
    }> = [];
    for (const candidate of approvals) {
      if (!fs.existsSync(candidate.source)) continue;
      const parsed = readJson(candidate.source);
      // A managed workload can never import an affirmative human decision.
      // Decided/auto-approved files are ignored; only a complete pending
      // request can cross into the monitor-owned archive.
      if (parsed.state !== "pending") continue;
      if (candidate.kind === "blueprint") {
        validateBlueprintApproval(parsed, this.options.taskId, ["pending"]);
      } else {
        validateJudgeApproval(parsed, this.options.taskId, ["pending"]);
      }
      pendingApprovals.push({ ...candidate, value: parsed });
    }

    if (pendingApprovals.length > 1) {
      throw new Error(
        `Docker runtime contains more than one pending approval for ${this.options.taskId}`,
      );
    }
    const pendingApproval = pendingApprovals[0];

    if (pendingApproval && !checkpoint) {
      throw new Error(`Docker ${pendingApproval.kind} approval is missing its bound checkpoint`);
    }
    if (pendingApproval && checkpoint) {
      validateGateCheckpoint(
        checkpoint,
        this.options.taskId,
        pendingApproval.kind,
        pendingApproval.value,
      );
    }

    const staleSource = path.join(
      this.options.sourceDir,
      "spec-stale",
      `${this.options.taskId}.json`,
    );
    let stale: Record<string, unknown> | undefined;
    if (fs.existsSync(staleSource)) {
      stale = readJson(staleSource);
      validateSpecStale(stale, this.options.taskId);
    }

    // Publish only after the complete candidate set has validated. A rejected
    // sibling must never leave a partial authoritative approval/checkpoint.
    if (pendingApproval) writeJsonExclusive(pendingApproval.target, pendingApproval.value);
    if (checkpoint) writeJsonExclusive(path.join(this.archiveDir, checkpointName), checkpoint);
    if (stale) {
      writeJsonExclusive(
        path.join(this.archiveDir, "spec-stale", `${this.options.taskId}.json`),
        stale,
      );
    }
  }

  private recordRejection(reason: string): void {
    try {
      fs.appendFileSync(
        path.join(this.archiveDir, RUNTIME_REJECTIONS),
        `${JSON.stringify({ at: new Date().toISOString(), taskId: this.options.taskId, reason: reason.slice(0, 4_000) })}\n`,
        "utf-8",
      );
    } catch {
      // The caller still receives fatal control-artifact failures directly.
    }
  }

  private updateManifest(state: RuntimeManifest["state"]): void {
    this.manifest = {
      ...this.manifest,
      state,
      ...(state === "active" ? {} : { sealedAt: new Date().toISOString() }),
    };
    writeJsonAtomic(path.join(this.archiveDir, RUNTIME_MANIFEST), this.manifest);
  }
}

/**
 * Seed a fresh child-private runtime directory from one exact host-owned,
 * validated archive. Only resumable control records cross back into the
 * container; events/session indexes/rejection diagnostics never do.
 */
export function seedDockerResumeState(
  sourceArchive: string,
  targetDir: string,
  taskId: string,
  targetSessionId: string,
): DockerResumeSourceBinding {
  if (!isDispatchSessionId(targetSessionId, taskId)) {
    throw new Error(`Docker resume for ${taskId} requires the new host-assigned session id`);
  }
  const validated = validateDockerResumeState(sourceArchive, taskId);
  const targetStat = fs.lstatSync(targetDir);
  if (
    !targetStat.isDirectory() ||
    targetStat.isSymbolicLink() ||
    fs.readdirSync(targetDir).length !== 0
  ) {
    throw new Error("Docker resume target must be a fresh empty runtime directory");
  }

  const checkpointName = `checkpoint-${taskId}.json`;
  // The checkpoint belongs to the new execution attempt after validation.
  // Rebinding this one field prevents later saves from carrying the old event
  // session into a new host-owned archive while every substantive stage and
  // approval value remains byte-for-byte equivalent JSON.
  const checkpoint = { ...validated.checkpoint, sessionId: targetSessionId };
  validateCheckpoint(checkpoint, taskId, targetSessionId);
  const approvalTarget = path.join(targetDir, "approvals", path.basename(validated.approvalFile));
  writeJsonExclusive(approvalTarget, validated.approval);
  writeJsonExclusive(path.join(targetDir, checkpointName), checkpoint);
  return validated.binding;
}

export function isValidatedDockerResumeArchive(sourceArchive: string, taskId: string): boolean {
  try {
    validateDockerResumeState(sourceArchive, taskId);
    return true;
  } catch {
    return false;
  }
}

export function inspectValidatedDockerResumeArchive(
  sourceArchive: string,
  taskId: string,
): DockerValidatedResumeArchive {
  const validated = validateDockerResumeState(sourceArchive, taskId);
  return {
    ...validated.binding,
    archiveDir: path.resolve(sourceArchive),
    provenance: validated.manifest.provenance,
    startedAt: validated.manifest.startedAt,
  };
}

export const DOCKER_RUNTIME_MANIFEST = RUNTIME_MANIFEST;
