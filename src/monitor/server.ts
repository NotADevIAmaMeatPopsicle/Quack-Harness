// â”€â”€â”€ Monitor Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Express app factory for the Quack Monitor dashboard.
// Serves the static dashboard, REST API for session/task/dispatch data,
// and SSE endpoint for real-time event streaming.

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { spawn, execFileSync, execSync, type ChildProcess } from "node:child_process";
import express from "express";
import type { Express, Request, Response } from "express";

import { EventReader } from "./event-reader.js";
import { EventWriter } from "./event-emitter.js";
import { SSEManager } from "./sse-manager.js";
import { type EventPayload, type QuackEvent, type SessionCompletePayload } from "./event-types.js";
import { buildCostSummaryFromSessions, sessionRowToCostSummarySession } from "./cost-summary.js";
import {
  buildTaskSessionMapFromSummaries,
  eventSessionToMonitorSummary,
  SessionService,
  type MonitorSessionSummary,
} from "./session-service.js";
import {
  paginateItems,
  parseListParam,
  parsePaginationQuery,
  parseSortOrder,
  sortByField,
} from "./list-query.js";
import { TASK_STATUSES, normalizeTaskStatus } from "../core/task-status.js";
import {
  classifyDeclaredId,
  listDuplicateClaimants,
  listTaskClaimantDeclarations,
} from "../core/task-file-resolver.js";
import {
  buildStrictDuplicateClaimantIndex,
  DuplicateClaimantAdmissionError,
  duplicateClaimantRefusal,
  duplicateClaimantRefusalForIndex,
  formatDuplicateClaimantsMessage,
  type DuplicateClaimantIndex,
} from "../core/duplicate-claimants.js";
import { persistClaimantDiagnostic } from "./claimant-diagnostic.js";
import type {
  DuplicateClaimantCheck,
  DuplicateClaimantRefusal,
} from "../core/duplicate-claimants.js";
import { TaskService } from "./task-service.js";
import type { TaskSummary } from "./task-service.js";
import { DispatchManager } from "./dispatch-manager.js";
import { PrepCache, computeContentHash } from "./prep-cache.js";
import {
  recordVerification,
  reconcileVerifiedDrift,
  regenerateProjection,
  setVerificationPeerSyncHandler,
} from "./verification-store.js";
import { PrepWorker } from "./prep-worker.js";
import { PrepScheduler } from "./prep-scheduler.js";
import { AdminRunManager } from "./admin-run-manager.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import type {
  AdapterFreshnessMetadata,
  AdapterGitConfig,
  AutoPrepConfig,
  ExecutionMode,
  FleetBudgetConfig,
  IsolationConfig,
  SmartTestingConfig,
  VerificationCommand,
  TestRunResult,
} from "../core/types.js";
import {
  AdapterConfigSchema,
  AdapterGitConfigSchema,
  RecordingConfigSchema,
  SmartTestingConfigSchema,
  VerificationCommandSchema,
} from "../core/adapter-schema.js";
import {
  JudgmentConfigSchema,
  type JudgmentConfig,
} from "../judgment/runner/intent-judgment-config.js";
import {
  AdvisoryOverrideRequiredError,
  type AdvisoryOverride,
  type AdvisoryOverrideMode,
} from "../judgment/advisory-override.js";
import { z } from "zod";
import { FleetBudgetChecker } from "../dispatcher/fleet-budget.js";
import { FleetController } from "../dispatcher/fleet-controller.js";
import { CostVelocityTracker } from "../dispatcher/cost-velocity.js";
import { ProgressDetector } from "./progress-detector.js";
import { FileHeartbeat } from "../dispatcher/file-heartbeat.js";
import { resolveRunScopedPauseState } from "../dispatcher/paused-run-state.js";
import { KeyManager } from "../dispatcher/key-manager.js";
import type {
  CostVelocityConfig,
  StuckDetectionConfig,
  DispatchQueueConfig,
} from "../core/types.js";
import { DispatchQueue } from "../queue/index.js";
import { getBuildInfo } from "../core/build-info.js";
import {
  ProjectRegistry,
  buildProjectContext,
  generateProjectId,
  initializeProjectDb,
  teardownProjectContext,
} from "./project-registry.js";
import type { ProjectContext } from "./project-registry.js";
import { QuackDB, NoopDB } from "../db/index.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import { computeAdapterBundleMetadata, loadAdapter } from "../core/adapter-loader.js";
import { ReadinessService } from "./readiness-service.js";
import { evaluateEnrichmentCandidate } from "./enrichment-candidate-gate.js";
import { inspectGeneratedProjectionHygiene } from "./projection-hygiene.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { startFreshnessMonitor } from "./task-freshness.js";
import {
  runBackfillScan,
  runOnMergeScan,
  startOnMergeRecorder,
  type BackfillDeps,
  type MergeScanCandidate,
} from "./on-merge-recorder.js";
import type { VerifiedJsonEntry } from "../core/types.js";
import { registerGitHubSyncRoutes } from "./routes/github-sync.js";
import { registerTestResultsRoutes } from "./routes/test-results.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerTriageRoutes } from "./routes/triage.js";
import { registerAgentResourcesRoutes } from "./routes/agent-resources.js";
import { registerWikiRoutes } from "./routes/wiki.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { registerCoordinationRoutes } from "./routes/coordination.js";
import type { CoordinationDb } from "./routes/coordination.js";
import { registerFleetRoutes } from "./routes/fleet.js";
import { registerDeploymentMonitoringRoutes } from "./routes/deployment-monitoring.js";
import { registerWorkerEnrollmentRoutes } from "./routes/worker-enrollment.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerIntakeRoutes, type IntakeRouteDeps } from "./routes/intake.js";
import {
  runValidationIntakeDryRun,
  runValidationIntakePersist,
} from "../intake/validation-intake.js";
import { generateValidationSpec as generateValidationSpecImpl } from "../intake/validation-spec-generator.js";
import { registerTestingRoutes } from "./routes/testing.js";
import { registerListenerRoutes } from "./routes/listeners.js";
import { registerFederationRoutes, type FederationRouteDeps } from "./routes/federation.js";
import { registerWorkflowRoutes, type WorkflowRouteDeps } from "./routes/workflows.js";
import type {
  RuntimeAuthorityDescriptor,
  RuntimeStateAuthority,
  WorkerRuntimeRole,
} from "../core/worker-protocol.js";
import { type FederationProjectContext, type JobProvenance } from "./federation/types.js";
import { resolveCcusageCommand } from "./ccusage-command.js";
import { restoreTaskStatusFromInProgress } from "./federation/events.js";
import {
  cleanupInactiveDbDispatchSessions,
  DEFAULT_STALE_DB_SESSION_MAX_AGE_MS,
  summarizeSessionRecoverySweep,
  type SessionRecoveryProjectSummary,
  type SessionRecoverySweepSummary,
} from "./session-recovery.js";
import {
  releaseFederatedDependencyBlocks as releaseFederatedDependencyBlocksModule,
  buildFederationClaimantIndex as buildFederationClaimantIndexModule,
  runSwarmSchedulerTick as runSwarmSchedulerTickModule,
  type FederationSchedulingDeps,
} from "./federation/scheduling.js";
import {
  reconcileFederatedJobs as reconcileFederatedJobsModule,
  type FederationOrchestrationDeps,
} from "./federation/orchestration.js";
import {
  loadFederationPeerConfig,
  loadFederatedJob,
  pullVerifiedFromPeer,
  pushVerificationToPeer,
  startPeriodicVerifiedSync,
} from "./federation/index.js";
import { ResearchStore } from "../research/research-store.js";
import {
  registerAuthRoutes,
  createAuthMiddleware,
  createViewerGuard,
  type AuthenticatedRequest,
} from "./routes/auth.js";
import { AuthService, initAuthConfig } from "./auth.js";
import { checkDockerHealth, requiresDocker } from "../utils/docker-health.js";
import { resolveTargetBranch } from "../dispatcher/branch-resolver.js";
import { PausedRunRefusalError } from "../dispatcher/paused-run-state.js";
import { toRuntimeDiagnostics } from "../core/runtime-errors.js";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import { recordLoopFinalization } from "./loop-finalize.js";
import { createTaskFilesFromInput } from "../planner/task-writer.js";
import { getChangedFiles, parseJestOutput } from "../testing/smart-test-runner.js";
import {
  formatTestDetails,
  formatTestSummary,
  writeTestArtifact,
} from "../testing/test-formatter.js";
import {
  refreshWorkflowStateProjection,
  resolveWorkflowState,
} from "../workflow/workflow-state-resolver.js";
import type { BlockReasonCode } from "../workflow/workflow-state-types.js";
import { type TaskIntakeRecord } from "../intake/task-intake.js";
import { ListenerRegistry } from "../federation/listener-registry.js";
import {
  loadLatestReviewBundleForTask,
  regenerateLatestByTaskIndex,
  type GateIssue,
  type PersistedReviewBundle,
  type WikiAction,
  type WikiArtifact,
} from "../review/docs-gate.js";

export interface MonitorServerOptions {
  /** @deprecated Use projectAdapters instead */
  logDir?: string;
  port?: number;
  /** @deprecated Use projectAdapters instead */
  adapterPath?: string;
  /** @deprecated Use projectAdapters instead */
  projectRoot?: string;
  /** @deprecated Use projectAdapters instead */
  taskDir?: string;
  /** Array of project adapters to register (new multi-project API) */
  projectAdapters?: ProjectAdapter[];
  /** Root of the Quack installation (for auth config). Defaults to auto-detect. */
  quackRoot?: string;
  /** Optional override for the built UI 2.0 asset directory (primarily for tests). */
  uiBuildDir?: string;
  /** Optional override for the project-wiki repo root. */
  wikiRoot?: string;
  /** Runtime role; worker runtimes disable human-facing UI assets. */
  runtimeRole?: WorkerRuntimeRole;
  /** State authority override. Defaults to canonical for headnode and cache for worker. */
  stateAuthority?: RuntimeStateAuthority;
  /** Canonical headnode URL used when this runtime is not authoritative. */
  canonicalBaseUrl?: string;
  /** Optional bind host override. */
  host?: string;
  /** Origins allowed to make credentialed cross-origin requests. Defaults to loopback only. */
  corsOrigins?: string[];
  /** Optional external-completion git runner override for deterministic route tests. */
  federationGitExec?: FederationRouteDeps["execGit"];
}

export interface MonitorServer {
  app: Express;
  sse: SSEManager;
  /** @deprecated Use registry instead */
  reader: EventReader;
  /** Project registry for multi-project support */
  registry?: ProjectRegistry;
  start: () => Promise<{ port: number; stop: () => Promise<void> }>;
}

type MonitorUiMode = "modern" | "legacy" | "headless";

interface MonitorUiAssets {
  mode: MonitorUiMode;
  rootDir: string;
  legacyDir: string;
  legacyRoute: string;
}

function getAdapterBundleMetadata(adapter: ProjectAdapter) {
  return adapter.adapterBundle ?? computeAdapterBundleMetadata(adapter.config);
}

function resolveMonitorUiAssets(options: MonitorServerOptions): MonitorUiAssets {
  if (options.runtimeRole === "worker") {
    return {
      mode: "headless",
      rootDir: "",
      legacyDir: "",
      legacyRoute: "/legacy",
    };
  }
  const legacyDir = path.join(__dirname, "public");
  const modernDir = options.uiBuildDir ?? path.join(__dirname, "ui");

  if (fs.existsSync(path.join(modernDir, "index.html"))) {
    return {
      mode: "modern",
      rootDir: modernDir,
      legacyDir,
      legacyRoute: "/legacy",
    };
  }

  return {
    mode: "legacy",
    rootDir: legacyDir,
    legacyDir,
    legacyRoute: "/legacy",
  };
}

function shouldServeAppShell(req: Request): boolean {
  if (req.method !== "GET") return false;
  if (path.posix.extname(req.path)) return false;
  const accept = req.headers.accept;
  return typeof accept !== "string" || accept === "" || accept.includes("text/html");
}

/**
 * Load the verified.json tasks index for a project. Returns empty object
 * if the file doesn't exist or can't be parsed.
 */
async function loadVerifiedIndex(
  projectRoot: string | undefined,
): Promise<Record<string, VerifiedJsonEntry>> {
  if (!projectRoot) return {};
  try {
    const raw = await fsPromises.readFile(
      path.join(projectRoot, ".quack", "verified.json"),
      "utf-8",
    );
    const data = JSON.parse(raw.replace(/^\uFEFF/u, "")) as {
      tasks?: Record<string, VerifiedJsonEntry>;
    };
    return data.tasks ?? {};
  } catch {
    return {};
  }
}

interface SupportContentRecord {
  id?: string;
  reviewId?: string;
  taskId?: string;
  title?: string;
  summary?: string;
  productArea?: string;
  generatedAt?: string;
}

interface DocsJobEventSummary {
  jobId?: string;
  eventType?: string;
  taskId?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

function parseJsonl<T>(raw: string): T[] {
  const records: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed auxiliary records; UI summaries are best-effort.
    }
  }
  return records;
}

function parseAdminTaskIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseOptionalAdminNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function loadSupportContentRecords(
  projectRoot: string,
  taskId: string,
): Promise<SupportContentRecord[]> {
  const supportPath = path.join(projectRoot, ".quack", "docs-pipeline", "support-content.jsonl");
  try {
    const raw = await fsPromises.readFile(supportPath, "utf-8");
    return parseJsonl<Record<string, unknown>>(raw)
      .filter((record) => record.taskId === taskId)
      .map((record) => ({
        id: typeof record.id === "string" ? record.id : undefined,
        reviewId: typeof record.reviewId === "string" ? record.reviewId : undefined,
        taskId: typeof record.taskId === "string" ? record.taskId : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        summary: typeof record.summary === "string" ? record.summary : undefined,
        productArea: typeof record.productArea === "string" ? record.productArea : undefined,
        generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : undefined,
      }))
      .sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""));
  } catch {
    return [];
  }
}

async function loadDocsJobEventSummaries(
  projectRoot: string,
  taskId: string,
): Promise<DocsJobEventSummary[]> {
  const eventDir = path.join(projectRoot, ".quack", "docs-pipeline", "job-events");
  let entries: string[];
  try {
    entries = await fsPromises.readdir(eventDir);
  } catch {
    return [];
  }

  const records: DocsJobEventSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const raw = await fsPromises.readFile(path.join(eventDir, entry), "utf-8");
    for (const record of parseJsonl<DocsJobEventSummary>(raw)) {
      if (record.taskId === taskId) {
        records.push(record);
      }
    }
  }
  return records.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
}

async function fileArtifactSummary(filePath: string): Promise<{
  exists: boolean;
  path: string;
  updatedAt?: string;
}> {
  try {
    const stat = await fsPromises.stat(filePath);
    return { exists: true, path: filePath, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { exists: false, path: filePath };
  }
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CanonicalTaskSpecCommitResult {
  attempted: boolean;
  committed: boolean;
  pushed: boolean;
  branch?: string;
  commitSha?: string;
  skippedReason?: string;
  error?: string;
}

interface CanonicalTaskSpecGitPrecheck {
  ok: boolean;
  gitRepository: boolean;
  branch?: string;
  reason?: string;
  error?: string;
}

function commandOutputToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : "";
}

function runGitSync(cwd: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
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
      stdout: commandOutputToString(execError.stdout),
      stderr: commandOutputToString(execError.stderr) || execError.message || "git command failed",
    };
  }
}

function inspectCanonicalTaskSpecGitTarget(
  projectRoot: string,
  allowedTargetBranches: string[],
): CanonicalTaskSpecGitPrecheck {
  const insideWorkTree = runGitSync(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return { ok: true, gitRepository: false, reason: "not_git_repository" };
  }

  const branchResult = runGitSync(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchResult.exitCode !== 0) {
    return {
      ok: false,
      gitRepository: true,
      reason: "branch_unresolved",
      error: branchResult.stderr || branchResult.stdout || "failed to resolve current branch",
    };
  }

  const branch = branchResult.stdout.trim();
  if (!branch || branch === "HEAD") {
    return { ok: false, gitRepository: true, branch, reason: "detached_head" };
  }

  if (allowedTargetBranches.length > 0 && !allowedTargetBranches.includes(branch)) {
    return {
      ok: false,
      gitRepository: true,
      branch,
      reason: "not_on_canonical_target_branch",
      error: `Current branch ${branch} is not one of: ${allowedTargetBranches.join(", ")}`,
    };
  }

  const stagedBefore = runGitSync(projectRoot, ["diff", "--cached", "--name-only"]);
  if (stagedBefore.exitCode !== 0) {
    return {
      ok: false,
      gitRepository: true,
      branch,
      reason: "staged_changes_unreadable",
      error: stagedBefore.stderr || "failed to inspect staged changes",
    };
  }

  const preStagedFiles = stagedBefore.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (preStagedFiles.length > 0) {
    return {
      ok: false,
      gitRepository: true,
      branch,
      reason: "preexisting_staged_changes",
      error: `Refusing canonical task-spec write with preexisting staged files: ${preStagedFiles.join(", ")}`,
    };
  }

  return { ok: true, gitRepository: true, branch };
}

/**
 * Optional configuration for `commitCanonicalTaskSpecChange`. Added in
 * TASK-922 so the legacy auto-enrich endpoints can drive the same canonical
 * commit/push flow that the v1 enrichment-candidates path already uses,
 * while letting operator clones opt out via adapter config.
 *
 * When omitted, the helper preserves its TASK-921-B behavior: a fixed
 * `docs(tasks): accept enrichment candidate for {taskId}` message, push
 * always attempted, no branch skip list.
 */
interface CommitCanonicalTaskSpecOptions {
  /**
   * Commit message override. Supports `{taskId}` substitution.
   * Defaults to the v1 enrichment-candidate message when undefined.
   */
  commitMessage?: string;
  /** When false, commit locally and skip the push step. Defaults to true. */
  push?: boolean;
  /**
   * Branch names on which auto-commit must NOT run. When the current
   * branch matches, the helper returns `skippedReason: "protected_branch"`
   * before touching the working tree.
   */
  skipBranches?: string[];
}

function commitCanonicalTaskSpecChange(
  projectRoot: string,
  taskId: string,
  taskFilePath: string,
  options: CommitCanonicalTaskSpecOptions = {},
): CanonicalTaskSpecCommitResult {
  const insideWorkTree = runGitSync(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return {
      attempted: false,
      committed: false,
      pushed: false,
      skippedReason: "not_git_repository",
    };
  }

  const relativeTaskPath = path.relative(projectRoot, taskFilePath).split(path.sep).join("/");
  if (relativeTaskPath.startsWith("..")) {
    return {
      attempted: false,
      committed: false,
      pushed: false,
      skippedReason: "task_file_outside_project_root",
    };
  }

  // Resolve the current branch up-front so we can apply skipBranches before
  // staging anything. The v1 caller path does not pass skipBranches so this
  // is a no-op for that flow.
  const earlyBranchResult = runGitSync(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const earlyBranch =
    earlyBranchResult.exitCode === 0 ? earlyBranchResult.stdout.trim() : undefined;
  if (
    options.skipBranches &&
    options.skipBranches.length > 0 &&
    earlyBranch &&
    earlyBranch !== "HEAD" &&
    options.skipBranches.includes(earlyBranch)
  ) {
    return {
      attempted: false,
      committed: false,
      pushed: false,
      branch: earlyBranch,
      skippedReason: "protected_branch",
    };
  }

  const stagedBefore = runGitSync(projectRoot, ["diff", "--cached", "--name-only"]);
  if (stagedBefore.exitCode !== 0) {
    return {
      attempted: true,
      committed: false,
      pushed: false,
      error: stagedBefore.stderr || "failed to inspect staged changes",
    };
  }

  const preStagedFiles = stagedBefore.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (preStagedFiles.length > 0) {
    return {
      attempted: false,
      committed: false,
      pushed: false,
      skippedReason: "preexisting_staged_changes",
    };
  }

  const addResult = runGitSync(projectRoot, ["add", "--", relativeTaskPath]);
  if (addResult.exitCode !== 0) {
    return {
      attempted: true,
      committed: false,
      pushed: false,
      error: addResult.stderr || "failed to stage canonical task spec",
    };
  }

  const stagedAfter = runGitSync(projectRoot, ["diff", "--cached", "--name-only"]);
  const stagedFiles = stagedAfter.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (stagedFiles.length === 0) {
    return {
      attempted: true,
      committed: false,
      pushed: false,
      skippedReason: "no_git_changes",
    };
  }
  if (stagedFiles.length !== 1 || stagedFiles[0] !== relativeTaskPath) {
    runGitSync(projectRoot, ["reset", "HEAD", "--", relativeTaskPath]);
    return {
      attempted: true,
      committed: false,
      pushed: false,
      skippedReason: "unexpected_staged_changes",
    };
  }

  const commitMessage = (
    options.commitMessage ?? `docs(tasks): accept enrichment candidate for {taskId}`
  ).replace(/\{taskId\}/gu, taskId);

  const commitResult = runGitSync(projectRoot, ["commit", "-m", commitMessage]);
  if (commitResult.exitCode !== 0) {
    runGitSync(projectRoot, ["reset", "HEAD", "--", relativeTaskPath]);
    return {
      attempted: true,
      committed: false,
      pushed: false,
      error: commitResult.stderr || commitResult.stdout || "git commit failed",
    };
  }

  const branchResult = runGitSync(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
  const commitShaResult = runGitSync(projectRoot, ["rev-parse", "HEAD"]);
  const commitSha = commitShaResult.exitCode === 0 ? commitShaResult.stdout.trim() : undefined;

  if (!branch || branch === "HEAD") {
    return {
      attempted: true,
      committed: true,
      pushed: false,
      branch,
      commitSha,
      skippedReason: "detached_head_not_pushed",
    };
  }

  // Allow callers to skip the push step (e.g., when an operator wants to
  // commit locally on Headnode for review before publishing).
  if (options.push === false) {
    return {
      attempted: true,
      committed: true,
      pushed: false,
      branch,
      commitSha,
      skippedReason: "push_disabled_by_config",
    };
  }

  const pushResult = runGitSync(projectRoot, ["push", "origin", `HEAD:${branch}`]);
  if (pushResult.exitCode !== 0) {
    return {
      attempted: true,
      committed: true,
      pushed: false,
      branch,
      commitSha,
      error: pushResult.stderr || pushResult.stdout || "git push failed",
    };
  }

  return {
    attempted: true,
    committed: true,
    pushed: true,
    branch,
    commitSha,
  };
}

function artifactForAction(
  artifacts: WikiArtifact[] | undefined,
  action: WikiAction,
): WikiArtifact | undefined {
  return artifacts?.find((artifact) => artifact.action === action);
}

function countUnresolvedHighFindings(
  findings: PersistedReviewBundle["findings"] | undefined,
): number {
  return (findings ?? []).filter((finding) => {
    const status = finding.status ?? "open";
    return (
      (finding.severity === "P1" || finding.severity === "P2") &&
      status !== "resolved" &&
      status !== "waived"
    );
  }).length;
}

function reviewBlockingReasons(review: PersistedReviewBundle | undefined): Array<{
  code: string;
  message: string;
  field?: string;
  blockReasonCode?: BlockReasonCode;
}> {
  if (!review) {
    return [
      {
        code: "pending_review",
        message: "No review bundle has been recorded for this task.",
        blockReasonCode: "pending_review",
      },
    ];
  }
  return review.gate.issues
    .filter((issue: GateIssue) => issue.blocking)
    .map((issue: GateIssue) => ({
      code: issue.code,
      message: issue.message,
      field: issue.field,
      blockReasonCode: issue.blockReasonCode,
    }));
}

function isVerifiedEntry(entry: VerifiedJsonEntry | undefined): boolean {
  return !!entry && (entry.verdict === "VERIFIED" || entry.verdict === "SOFT-VERIFIED");
}

function pendingStateLabel(blockReasonCode: BlockReasonCode | undefined): string | undefined {
  switch (blockReasonCode) {
    case "pending_review":
      return "Pending review";
    case "pending_wiki_artifacts":
      return "Pending wiki artifacts";
    case "pending_manual_handoff":
      return "Pending manual handoff";
    case "pending_remote_listener":
      return "Pending remote listener";
    case "host_unhealthy":
      return "Host unhealthy";
    case "workflow_attempts_exhausted":
      return "Attempts exhausted";
    case "review_linkage_required":
      return "Review linkage required";
    default:
      return blockReasonCode;
  }
}

/**
 * Build a session outcome map from all sessions: for each task, keep the
 * session with the highest-priority outcome. Priority: approved > active >
 * rejected > error. Within equal priority, later entries win.
 */
function buildSessionMap(
  reader: EventReader,
): Map<string, { outcome: string; costUsd: number; status: string }> {
  return buildTaskSessionMapFromSummaries(
    reader.getExecutionSessions().map(eventSessionToMonitorSummary),
  );
}

function taskSortValue(
  task: TaskSummary,
  sort: string,
): string | number | boolean | null | undefined {
  switch (sort) {
    case "title":
      return task.title;
    case "priority":
      return task.priority;
    case "status":
      return task.status;
    case "effectiveStatus":
      return task.effectiveStatus;
    case "effort":
      return task.effort;
    case "lastCostUsd":
      return task.lastCostUsd;
    case "successCriteriaCount":
      return task.successCriteriaCount;
    case "branchGroup":
      return task.branchGroup;
    case "needsVerification":
      return task.needsVerification;
    case "id":
    default:
      return task.id;
  }
}

function sessionSortValue(session: MonitorSessionSummary, sort: string): string | number | null {
  switch (sort) {
    case "taskId":
      return session.taskId;
    case "title":
      return session.title;
    case "status":
      return session.status;
    case "outcome":
      return session.outcome;
    case "totalCostUsd":
      return session.totalCostUsd;
    case "durationMs":
      return session.durationMs;
    case "turnsUsed":
      return session.turnsUsed;
    case "gateScore":
      return session.gateScore;
    case "startTime":
    default:
      return session.startTime;
  }
}

// â”€â”€â”€ TestRunner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs verification commands (test, lint, build) as child processes
// and streams output to SSE clients.

export { TestRunResult } from "../core/types.js";

interface TestRunnerStartOptions {
  timeoutMs?: number;
  force?: boolean;
  smartTesting?: SmartTestingConfig;
  baseBranch?: string;
  adapterFreshness?: AdapterFreshnessMetadata;
}

function resolveRuntimeAuthority(options: MonitorServerOptions): RuntimeAuthorityDescriptor {
  const runtimeRole = options.runtimeRole ?? "headnode";
  const stateAuthority =
    options.stateAuthority ?? (runtimeRole === "worker" ? "cache" : "canonical");
  return {
    runtimeRole,
    stateAuthority,
    canonicalBaseUrl: options.canonicalBaseUrl ?? process.env.QUACK_BASE_URL ?? null,
    localDbAuthoritative: stateAuthority === "canonical",
  };
}

interface TestRunnerStartResult {
  started: boolean;
  skipped?: boolean;
  taskId?: string;
}

export class TestRunner {
  private process: ChildProcess | null = null;
  private running = false;
  private currentName = "";
  private currentCommand = "";
  private currentAdapterFreshness: AdapterFreshnessMetadata | undefined;
  private history: TestRunResult[] = [];
  private projectRoot: string;
  private historyFile: string;
  private onOutput: (data: string) => void;
  private onEvent?: (stage: QuackEvent["stage"], payload: Record<string, unknown>) => void;

  constructor(
    projectRoot: string,
    onOutput: (data: string) => void,
    onEvent?: (stage: QuackEvent["stage"], payload: Record<string, unknown>) => void,
  ) {
    this.projectRoot = projectRoot;
    this.historyFile = path.join(projectRoot, ".quack", "logs", "test-history.jsonl");
    this.onOutput = onOutput;
    this.onEvent = onEvent;
    this.loadHistory();
  }

  private loadHistory(): void {
    if (!fs.existsSync(this.historyFile)) return;
    try {
      const lines = fs
        .readFileSync(this.historyFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      const entries = lines.slice(-100).map((l) => JSON.parse(l) as TestRunResult);
      this.history = entries;
    } catch {
      // Ignore parse errors
    }
  }

  private saveHistoryEntry(entry: TestRunResult): void {
    const dir = path.dirname(this.historyFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(this.historyFile, JSON.stringify(entry) + "\n");
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): {
    running: boolean;
    name: string;
    command: string;
    adapterFreshness?: AdapterFreshnessMetadata;
  } {
    return {
      running: this.running,
      name: this.currentName,
      command: this.currentCommand,
      adapterFreshness: this.currentAdapterFreshness,
    };
  }

  getHistory(): TestRunResult[] {
    return [...this.history];
  }

  private getCurrentGitSha(): string | undefined {
    try {
      return execSync("git rev-parse HEAD", {
        cwd: this.projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim();
    } catch {
      return undefined;
    }
  }

  private hasSourceChangesSince(lastRunGitSha: string | undefined): boolean {
    try {
      const status = execSync("git status --porcelain", {
        cwd: this.projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim();
      if (status.length > 0) return true;
    } catch {
      return true;
    }

    if (!lastRunGitSha) return true;
    const currentSha = this.getCurrentGitSha();
    if (!currentSha) return true;
    return currentSha !== lastRunGitSha;
  }

  private getLastRunForCommand(name: string): TestRunResult | undefined {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].name === name) return this.history[i];
    }
    return undefined;
  }

  private appendHistory(result: TestRunResult): void {
    this.saveHistoryEntry(result);
    this.history.push(result);
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }
  }

  private finishRun(name: string, result: TestRunResult): void {
    this.appendHistory(result);
    this.running = false;
    this.process = null;
    this.currentName = "";
    this.currentCommand = "";
    this.currentAdapterFreshness = undefined;
    this.onOutput(
      `\n--- ${name} finished with exit code ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s) ---\n`,
    );
  }

  private buildSmartTestCommand(
    mode: "related" | "full",
    baseBranch: string,
    jsonFile: string,
  ): string {
    if (mode !== "related") {
      return `npx jest --json --outputFile "${jsonFile}" --forceExit`;
    }

    const changedFiles = getChangedFiles(this.projectRoot, baseBranch);
    const relevantFiles = changedFiles.filter(
      (filePath) =>
        filePath.endsWith(".ts") ||
        filePath.endsWith(".tsx") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".jsx"),
    );
    if (relevantFiles.length === 0) {
      return `npx jest --json --outputFile "${jsonFile}" --forceExit`;
    }

    const escapedFiles = relevantFiles
      .map((filePath) => `"${filePath.replace(/"/g, '\\"')}"`)
      .join(" ");
    return `npx jest --findRelatedTests ${escapedFiles} --json --outputFile "${jsonFile}" --forceExit`;
  }

  start(name: string, command: string, options?: TestRunnerStartOptions): TestRunnerStartResult {
    if (this.running) {
      throw new Error("A command is already running");
    }

    this.running = true;
    this.currentName = name;
    this.currentCommand = command;
    this.currentAdapterFreshness = options?.adapterFreshness;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const gitSha = this.getCurrentGitSha();

    if (name === "test" && options?.smartTesting?.enabled) {
      const lastRun = this.getLastRunForCommand(name);
      const shouldSkipForNoChanges = !options.force && !this.hasSourceChangesSince(lastRun?.gitSha);

      if (shouldSkipForNoChanges) {
        const finishedAt = new Date().toISOString();
        const result: TestRunResult = {
          name,
          command,
          exitCode: 0,
          durationMs: 0,
          startedAt,
          finishedAt,
          projectId: this.projectRoot,
          gitSha,
          taskId: lastRun?.taskId,
          skippedNoChanges: true,
          adapterFreshness: options.adapterFreshness,
        };
        this.appendHistory(result);
        this.running = false;
        this.currentName = "";
        this.currentCommand = "";
        this.currentAdapterFreshness = undefined;
        this.onOutput(
          `[smart-test] No source changes detected since the last run; skipping ${name}.\n`,
        );
        if (lastRun?.taskId) {
          this.onEvent?.("test_run_complete", { taskId: lastRun.taskId, skippedNoChanges: true });
        }
        this.onEvent?.("test_dashboard_update", {
          taskId: lastRun?.taskId ?? null,
          skippedNoChanges: true,
        });
        return { started: false, skipped: true, taskId: lastRun?.taskId };
      }

      const mode = options.smartTesting.mode === "related" ? "related" : "full";
      const outputDir = options.smartTesting.outputDir || ".quack/test-results";
      const taskId = `manual-${Date.now()}`;
      const resultsDir = path.join(this.projectRoot, outputDir);
      const jsonFile = path.join(resultsDir, `${taskId}-${mode}.json`);
      const baseBranch = options.baseBranch || "main";
      const smartCommand = this.buildSmartTestCommand(mode, baseBranch, jsonFile);

      this.onOutput(`[smart-test] Running ${mode} mode against base branch '${baseBranch}'...\n`);

      const proc = spawn(smartCommand, [], {
        cwd: this.projectRoot,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.process = proc;

      const handleData = (data: Buffer): void => {
        this.onOutput(data.toString());
      };
      proc.stdout?.on("data", handleData);
      proc.stderr?.on("data", handleData);

      proc.on("close", (code) => {
        const finishedAt = new Date().toISOString();
        const durationMs = Date.now() - startMs;
        const parsed = parseJestOutput(jsonFile);
        const artifactPath = path.join(resultsDir, `${taskId}-result.json`);
        writeTestArtifact(parsed, artifactPath);
        this.onOutput(`\n[smart-test] ${formatTestSummary(parsed)}\n`);
        if (parsed.failed > 0) {
          this.onOutput(formatTestDetails(parsed) + "\n");
        }

        const result: TestRunResult = {
          name,
          command,
          exitCode: parsed.exitCode ?? code ?? 1,
          durationMs,
          startedAt,
          finishedAt,
          projectId: this.projectRoot,
          gitSha,
          taskId,
          adapterFreshness: options.adapterFreshness,
        };
        this.finishRun(name, result);
        this.onEvent?.("test_run_complete", {
          taskId,
          totalTests: parsed.totalTests,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
        });
        this.onEvent?.("test_result_summary", {
          taskId,
          summary: formatTestSummary(parsed),
          allFailuresPreExisting: parsed.baseline?.allFailuresPreExisting ?? false,
        });
        this.onEvent?.("test_dashboard_update", { taskId });
      });

      proc.on("error", (err) => {
        const finishedAt = new Date().toISOString();
        const durationMs = Date.now() - startMs;
        const result: TestRunResult = {
          name,
          command,
          exitCode: -1,
          durationMs,
          startedAt,
          finishedAt,
          projectId: this.projectRoot,
          gitSha,
          taskId,
          adapterFreshness: options.adapterFreshness,
        };
        this.finishRun(name, result);
        this.onOutput(`\n--- ${name} error: ${err.message} ---\n`);
      });

      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeout = setTimeout(() => {
          if (this.running && this.process === proc) {
            this.onOutput(`\n--- ${name} timed out after ${options.timeoutMs}ms ---\n`);
            this.killProcess(proc);
          }
        }, options.timeoutMs);
        timeout.unref?.();
      }

      return { started: true, taskId };
    }

    // Split command for spawn â€” use shell mode for npm/npx commands
    const proc = spawn(command, [], {
      cwd: this.projectRoot,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = proc;

    const handleData = (data: Buffer): void => {
      this.onOutput(data.toString());
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    proc.on("close", (code) => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;

      const result: TestRunResult = {
        name,
        command,
        exitCode: code,
        durationMs,
        startedAt,
        finishedAt,
        projectId: this.projectRoot,
        gitSha,
        adapterFreshness: options?.adapterFreshness,
      };
      this.finishRun(name, result);
    });

    proc.on("error", (err) => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;

      const result: TestRunResult = {
        name,
        command,
        exitCode: -1,
        durationMs,
        startedAt,
        finishedAt,
        projectId: this.projectRoot,
        gitSha,
        adapterFreshness: options?.adapterFreshness,
      };
      this.finishRun(name, result);
      this.onOutput(`\n--- ${name} error: ${err.message} ---\n`);
    });

    return { started: true };
  }

  stop(): boolean {
    if (!this.process || !this.running) {
      return false;
    }
    this.killProcess(this.process);
    return true;
  }

  killAll(): void {
    if (this.process) {
      this.killProcess(this.process);
    }
  }

  private killProcess(proc: ChildProcess): void {
    if (process.platform === "win32" && proc.pid) {
      // On Windows, shell-spawned processes need taskkill /T to kill the entire tree
      try {
        execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
      } catch {
        proc.kill("SIGTERM");
      }
    } else {
      proc.kill("SIGTERM");
    }
  }
}

/**
 * TASK-1326 round-2b F2: this hardcoded `.quack/logs`, so on a custom
 * `logging.dir` the approve/reject/replan/revise routes looked in a
 * directory the records were never written to. That was latent before
 * (an approve simply reported "No pending approval found"); once the
 * paused-run guard reads the CONFIGURED dir it became a DEADLOCK — the
 * guard sees a pend the operator has no working way to clear. The
 * confirmation round executed exactly that case.
 *
 * The worktree half of the custom-dir problem (the junction covers only
 * `.quack/logs`, so a child writing elsewhere is invisible to the
 * monitor) remains QPI-044; mirroring the relative path here is
 * strictly better than assuming the default.
 */
function resolveTaskRuntimeLogDir(
  projectRoot: string,
  dispatchManager: DispatchManager | null | undefined,
  taskId: string,
  configuredLogDir?: string,
): string {
  const managedWorktree = dispatchManager?.getJob(taskId)?.worktreePath;
  const conventionalWorktree = path.join(projectRoot, ".quack", "worktrees", taskId);
  const runtimeRoot =
    managedWorktree ?? (fs.existsSync(conventionalWorktree) ? conventionalWorktree : projectRoot);
  const fallback = path.resolve(projectRoot, ".quack", "logs");
  const configured = configuredLogDir ?? fallback;
  if (runtimeRoot === projectRoot) return configured;
  const rel = path.relative(projectRoot, configured);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // The configured dir lives outside the project: the child writes
    // there directly, worktree or not.
    return configured;
  }
  return path.resolve(runtimeRoot, rel);
}

function formatLoopReviewFeedback(review: ReviewRunResult | undefined): string {
  if (!review) return "";
  if (review.status === "runner_error") {
    return `### Loop reviewer environment failure\n- ${review.errorKind}: ${review.message}`;
  }
  if (review.findings.length === 0) {
    return `### Loop reviewer verdict: ${review.verdict}\n${review.summary}`;
  }
  return [
    `### Loop reviewer verdict: ${review.verdict}`,
    review.summary,
    ...review.findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.summary}${finding.detail ? ` — ${finding.detail}` : ""}`,
    ),
  ].join("\n");
}

export function createMonitorServer(options: MonitorServerOptions): MonitorServer {
  const { logDir, port = 3333, adapterPath, projectRoot, taskDir, projectAdapters } = options;

  // Strip Claude Code nesting detection env vars â€” the monitor is a standalone
  // server process, not a Claude Code session. Without this, inline LLM calls
  // (preflight depth evaluation, enrichment, blueprint generation) fail when
  // the monitor was spawned from within a Claude Code session.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;

  // Strip ANTHROPIC_API_KEY so the SDK CLI subprocess uses the Max subscription's
  // OAuth auth instead of a potentially empty/depleted API key inherited from the
  // parent environment. The dispatch manager already does this for child processes
  // (dispatch-manager.ts:323), but in-process SDK calls (depth evaluator, spec
  // reviewer, blueprint agent) inherit the monitor's env directly.
  delete process.env.ANTHROPIC_API_KEY;

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Multi-project mode or legacy single-project mode
  const useMultiProject = projectAdapters && projectAdapters.length > 0;
  const registry = useMultiProject ? new ProjectRegistry() : undefined;

  // Legacy single-project support (kept for backward compatibility)
  const reader = logDir ? new EventReader(logDir) : new EventReader("");
  const sse = new SSEManager();

  // â”€â”€â”€ Multi-project initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Note: Actual project context building happens in start() function
  // to support async initialization

  // â”€â”€â”€ Task service & dispatch manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const taskService = projectRoot && taskDir ? new TaskService(projectRoot, taskDir) : null;

  // Resolve the quack binary path (dist/index.js relative to project)
  const quackBin = path.resolve(__dirname, "..", "index.js");
  const adminRuns = new AdminRunManager(quackBin);

  // Load isolation config from adapter.json (if available)
  let isolationConfig: IsolationConfig | undefined;
  if (adapterPath && fs.existsSync(adapterPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>;
      if (raw.isolation && typeof raw.isolation === "object") {
        isolationConfig = raw.isolation as IsolationConfig;
      }
    } catch {
      /* ignore parse errors â€” use defaults */
    }
  }

  // Note: DispatchManager creation delayed until after apiKeysConfig is loaded
  let dispatchManager: DispatchManager | null = null;

  // â”€â”€â”€ Prep cache, worker & scheduler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const prepCache = projectRoot ? new PrepCache(projectRoot) : null;
  const prepWorker = projectRoot ? new PrepWorker(projectRoot, quackBin) : null;

  // Load automation config and fleet budget from adapter.json (if available)
  let autoPrepConfig: AutoPrepConfig | undefined;
  let fleetBudgetConfig: FleetBudgetConfig | undefined;
  let costVelocityConfig: CostVelocityConfig | undefined;
  let stuckDetectionConfig: StuckDetectionConfig | undefined;
  let queueConfig: DispatchQueueConfig | undefined;
  let legacyJudgmentConfig: JudgmentConfig | undefined;
  let apiKeysConfig:
    | { pool: string[]; strategy: "round-robin" | "least-used" | "least-cost"; cooldownMs: number }
    | undefined;
  // Legacy project name extracted from adapter.json for collision-safe ID generation
  let legacyProjectName: string | undefined;
  if (adapterPath && fs.existsSync(adapterPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>;
      const projectConf = raw.project as Record<string, unknown> | undefined;
      if (projectConf && typeof projectConf.name === "string") {
        legacyProjectName = projectConf.name;
      }
      const automation = raw.automation as Record<string, unknown> | undefined;
      const ap = automation?.autoPrep as Record<string, unknown> | undefined;
      if (ap) {
        autoPrepConfig = {
          enabled: ap.enabled === true,
          maxConcurrent: typeof ap.maxConcurrent === "number" ? ap.maxConcurrent : 1,
          cooldownSeconds: typeof ap.cooldownSeconds === "number" ? ap.cooldownSeconds : 30,
          maxPerHour: typeof ap.maxPerHour === "number" ? ap.maxPerHour : 20,
          maxBudgetPerHour: typeof ap.maxBudgetPerHour === "number" ? ap.maxBudgetPerHour : 2.0,
          priorityOrder:
            (ap.priorityOrder as AutoPrepConfig["priorityOrder"]) ?? "priority_then_id",
          skipPrepped: ap.skipPrepped !== false,
        };
      }
      const fb = raw.fleetBudget as Record<string, unknown> | undefined;
      if (fb) {
        fleetBudgetConfig = {
          dailyCapUsd: typeof fb.dailyCapUsd === "number" ? fb.dailyCapUsd : 25.0,
          hourlyCapUsd: typeof fb.hourlyCapUsd === "number" ? fb.hourlyCapUsd : 10.0,
          perWaveCapUsd: typeof fb.perWaveCapUsd === "number" ? fb.perWaveCapUsd : 15.0,
          alertThresholds: Array.isArray(fb.alertThresholds)
            ? (fb.alertThresholds as number[])
            : [50, 75, 90],
          enforceHard: fb.enforceHard !== false,
        };
      }
      const cv = raw.costVelocity as Record<string, unknown> | undefined;
      if (cv) {
        costVelocityConfig = {
          enabled: cv.enabled === true,
          windowMinutes: typeof cv.windowMinutes === "number" ? cv.windowMinutes : 5,
          warnMultiplier: typeof cv.warnMultiplier === "number" ? cv.warnMultiplier : 3,
          killMultiplier: typeof cv.killMultiplier === "number" ? cv.killMultiplier : 5,
          minSamplesForBaseline:
            typeof cv.minSamplesForBaseline === "number" ? cv.minSamplesForBaseline : 5,
        };
      }
      const sd = raw.stuckDetection as Record<string, unknown> | undefined;
      if (sd) {
        stuckDetectionConfig = {
          enabled: sd.enabled !== false,
          warningMinutes: typeof sd.warningMinutes === "number" ? sd.warningMinutes : 5,
          criticalMinutes: typeof sd.criticalMinutes === "number" ? sd.criticalMinutes : 10,
          killMinutes: typeof sd.killMinutes === "number" ? sd.killMinutes : 15,
          checkIntervalSeconds:
            typeof sd.checkIntervalSeconds === "number" ? sd.checkIntervalSeconds : 30,
          fileHeartbeat: sd.fileHeartbeat !== false,
        };
      }
      const q = raw.queue as Record<string, unknown> | undefined;
      if (q) {
        queueConfig = {
          maxConcurrent: typeof q.maxConcurrent === "number" ? q.maxConcurrent : 1,
          cooldownBetweenTasksMs:
            typeof q.cooldownBetweenTasksMs === "number" ? q.cooldownBetweenTasksMs : 5000,
          failurePropagation:
            (q.failurePropagation as DispatchQueueConfig["failurePropagation"]) ??
            "skip_dependents",
          fleetBudgetUsd: typeof q.fleetBudgetUsd === "number" ? q.fleetBudgetUsd : 0,
          pauseOnFailure: q.pauseOnFailure === true,
          persistState: q.persistState !== false,
          autoStartOnEnqueue: q.autoStartOnEnqueue === true,
        };
      }
      const agent = raw.agent as Record<string, unknown> | undefined;
      const keys = agent?.apiKeys as Record<string, unknown> | undefined;
      if (keys && Array.isArray(keys.pool) && keys.pool.length > 0) {
        apiKeysConfig = {
          pool: keys.pool as string[],
          strategy: (keys.strategy as "round-robin" | "least-used" | "least-cost") ?? "round-robin",
          cooldownMs: typeof keys.cooldownMs === "number" ? keys.cooldownMs : 60000,
        };
      }
    } catch {
      /* ignore parse errors â€” use defaults */
    }
  }
  // Judgment rollout controls merge/ledger authority. Unlike the historical
  // best-effort monitor settings above, a malformed configured judgment block
  // must fail startup instead of silently degrading to off.
  if (adapterPath && fs.existsSync(adapterPath)) {
    const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>;
    if (raw.judgment !== undefined) {
      legacyJudgmentConfig = JudgmentConfigSchema.parse(raw.judgment);
    }
  }

  const defaultAutoPrepConfig: AutoPrepConfig = {
    enabled: false,
    maxConcurrent: 1,
    cooldownSeconds: 30,
    maxPerHour: 20,
    maxBudgetPerHour: 2.0,
    priorityOrder: "priority_then_id",
    skipPrepped: true,
  };

  // In multi-project mode, load fleet budget from first project adapter if not already set
  if (!fleetBudgetConfig && projectAdapters && projectAdapters.length > 0) {
    for (const pa of projectAdapters) {
      const paAdapterPath = path.resolve(pa.projectRoot, ".quack", "adapter.json");
      if (fs.existsSync(paAdapterPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(paAdapterPath, "utf-8")) as Record<
            string,
            unknown
          >;
          const fb = raw.fleetBudget as Record<string, unknown> | undefined;
          if (fb) {
            fleetBudgetConfig = {
              dailyCapUsd: typeof fb.dailyCapUsd === "number" ? fb.dailyCapUsd : 25.0,
              hourlyCapUsd: typeof fb.hourlyCapUsd === "number" ? fb.hourlyCapUsd : 10.0,
              perWaveCapUsd: typeof fb.perWaveCapUsd === "number" ? fb.perWaveCapUsd : 15.0,
              alertThresholds: Array.isArray(fb.alertThresholds)
                ? (fb.alertThresholds as number[])
                : [50, 75, 90],
              enforceHard: fb.enforceHard !== false,
            };
            break;
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }
  }

  const defaultFleetBudgetConfig: FleetBudgetConfig = {
    dailyCapUsd: 25.0,
    hourlyCapUsd: 10.0,
    perWaveCapUsd: 15.0,
    alertThresholds: [50, 75, 90],
    enforceHard: true,
  };

  const defaultQueueConfig: DispatchQueueConfig = {
    maxConcurrent: 1,
    cooldownBetweenTasksMs: 5000,
    failurePropagation: "skip_dependents",
    fleetBudgetUsd: 0,
    pauseOnFailure: false,
    persistState: true,
    autoStartOnEnqueue: false,
  };

  // Compute legacy project ID early â€” needed by callbacks during DispatchQueue construction
  const legacyProjectId: string = legacyProjectName
    ? generateProjectId(legacyProjectName)
    : projectRoot
      ? generateProjectId(projectRoot)
      : "default";

  // Initialize SQLite DB for legacy single-project mode
  const legacyDbPath = projectRoot
    ? path.resolve(projectRoot, ".quack", "quack.db")
    : path.resolve(".quack", "quack.db");
  const legacyDbInit = initializeProjectDb(
    legacyDbPath,
    legacyProjectName ?? projectRoot ?? "default",
  );
  const legacyDb: QuackDB | NoopDB = legacyDbInit.db;
  const legacyDbState = legacyDbInit.dbState;
  let lastSessionRecoverySummary: SessionRecoverySweepSummary = summarizeSessionRecoverySweep([]);

  // Initialize KeyManager for legacy single-project mode (if apiKeys config present)
  const legacyKeyManager = apiKeysConfig
    ? new KeyManager({
        strategy: apiKeysConfig.strategy,
        cooldownMs: apiKeysConfig.cooldownMs,
      })
    : undefined;

  // Now create DispatchManager with KeyManager (if available)
  dispatchManager = projectRoot
    ? // QPI-043: pass the resolved log dir so the durable child-exit write
      // lands where the EventReader reads (empty string falls back to the
      // projectRoot default inside the constructor).
      new DispatchManager(
        projectRoot,
        quackBin,
        isolationConfig,
        legacyKeyManager,
        logDir || undefined,
        taskService
          ? async (taskId) => ({
              taskId,
              claimants: await listDuplicateClaimants(taskService.getTaskDirectory(), taskId),
            })
          : undefined,
      )
    : null;

  // Start watchdog to kill stuck dispatch processes (2-hour default)
  dispatchManager?.startWatchdog();

  const fleetBudget = new FleetBudgetChecker(
    reader,
    fleetBudgetConfig ?? defaultFleetBudgetConfig,
    legacyKeyManager,
  );

  const prepScheduler =
    prepWorker && prepCache && taskService
      ? new PrepScheduler(
          prepWorker,
          prepCache,
          taskService,
          autoPrepConfig ?? defaultAutoPrepConfig,
          (stage, payload) => {
            sse.broadcast({
              sessionId: "auto-prep",
              taskId: "",
              project: currentProjectId(),
              timestamp: new Date().toISOString(),
              stage,
              payload,
            });
          },
          {
            isPrepCurrent: async (taskId) => {
              if (!projectRoot || !taskService) return false;
              const readiness = new ReadinessService({
                projectRoot,
                taskService,
                prepCache,
                db: legacyDb,
              });
              return readiness.isPrepCurrent(taskId);
            },
            // TASK-1318 (round-3 F2): see project-registry. Without the
            // store, eligibility and hygiene both revert to spec status
            // and the routing is inert.
            db: legacyDb,
          },
        )
      : null;

  // â”€â”€â”€ Fleet controller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const fleetController =
    dispatchManager && projectRoot
      ? new FleetController(dispatchManager, prepScheduler, projectRoot)
      : null;

  const emitFleetEvent = (
    stage: "fleet_emergency_stop" | "fleet_paused" | "fleet_resumed",
    payload: unknown,
  ) => {
    sse.broadcast({
      sessionId: "fleet",
      taskId: "",
      project: currentProjectId(),
      timestamp: new Date().toISOString(),
      stage,
      payload: payload as never,
    });
  };

  // â”€â”€â”€ Dispatch Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const dispatchQueue =
    dispatchManager && taskService && projectRoot && logDir
      ? new DispatchQueue(
          dispatchManager,
          taskService,
          reader,
          queueConfig ?? defaultQueueConfig,
          logDir,
          (stage, taskId, payload) => {
            sse.broadcast({
              sessionId: "dispatch-queue",
              taskId,
              project: currentProjectId(),
              timestamp: new Date().toISOString(),
              stage: stage as never,
              payload: payload as never,
            });
          },
          legacyDb,
        )
      : null;

  // â”€â”€â”€ Cost Velocity Tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const costVelocityTracker = new CostVelocityTracker(costVelocityConfig);

  // Compute initial baseline from historical data
  const initialCostSummary = reader.getCostSummary();
  costVelocityTracker.computeBaseline(initialCostSummary);

  // â”€â”€â”€ Progress Detector (stuck agent detection) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const progressDetector = new ProgressDetector(stuckDetectionConfig);

  // Track active file heartbeats per dispatch
  const activeHeartbeats = new Map<string, FileHeartbeat>();

  // Track active progress watchers per dispatch (for PROGRESS.md file changes â†’ SSE)
  const activeProgressWatchers = new Map<
    string,
    import("../dispatcher/progress-watcher.js").ProgressWatcherHandle
  >();

  // Track revision dispatches so we can emit revision_complete on session_complete
  const activeRevisions = new Set<string>();

  // Wire stuck detection callback â†’ emit SSE events + kill agent
  progressDetector.setStuckCallback((stuckEvent) => {
    if (stuckEvent.level === "kill") {
      // Auto-kill the stuck agent
      if (dispatchManager) {
        dispatchManager.stop(stuckEvent.taskId);
      }
      sse.broadcast({
        sessionId: "progress-detector",
        taskId: stuckEvent.taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "agent_stuck_killed",
        payload: {
          taskId: stuckEvent.taskId,
          silentMs: stuckEvent.silentMs,
          totalCostUsd: stuckEvent.totalCostUsd,
          turnsCompleted: stuckEvent.turnNumber,
        } as never,
      });
    } else if (stuckEvent.level === "critical") {
      sse.broadcast({
        sessionId: "progress-detector",
        taskId: stuckEvent.taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "agent_stuck_critical",
        payload: {
          taskId: stuckEvent.taskId,
          silentMs: stuckEvent.silentMs,
          lastActivity: stuckEvent.lastActivity,
          turnNumber: stuckEvent.turnNumber,
        } as never,
      });
    } else {
      sse.broadcast({
        sessionId: "progress-detector",
        taskId: stuckEvent.taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "agent_stuck_warning",
        payload: {
          taskId: stuckEvent.taskId,
          silentMs: stuckEvent.silentMs,
          lastActivity: stuckEvent.lastActivity,
          turnNumber: stuckEvent.turnNumber,
        } as never,
      });
    }
  });

  // â”€â”€â”€ Container lifecycle events via SSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (dispatchManager) {
    dispatchManager.setEventCallback((stage, taskId, payload) => {
      sse.broadcast({
        sessionId: "dispatch",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage,
        payload: payload as never,
      });
    });
  }

  // â”€â”€â”€ CORS (allows frontend to be served separately) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Only set CORS headers when an Origin header is present (cross-origin).
  // Same-origin requests don't send Origin, and setting "Access-Control-Allow-Origin: *"
  // with "Access-Control-Allow-Credentials: true" is forbidden by the spec â€”
  // the browser silently drops Set-Cookie headers, breaking auth.
  const defaultCorsOrigins = new Set([
    "http://localhost",
    "https://localhost",
    "http://127.0.0.1",
    "https://127.0.0.1",
    "http://[::1]",
    "https://[::1]",
  ]);
  const configuredCorsOrigins = new Set(options.corsOrigins ?? []);
  const isAllowedCorsOrigin = (origin: string): boolean => {
    if (configuredCorsOrigins.has(origin)) return true;
    try {
      const parsed = new URL(origin);
      return defaultCorsOrigins.has(`${parsed.protocol}//${parsed.hostname}`);
    } catch {
      return false;
    }
  };

  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && isAllowedCorsOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-API-Key, X-Project-Id, X-Quack-Service-Token",
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (_req.method === "OPTIONS" && origin && !isAllowedCorsOrigin(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // â”€â”€â”€ Authentication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Auth config lives at <quack-project-root>/.quack/auth.json.
  // When no users are configured, auth is disabled (open access).
  const quackRoot = options.quackRoot ?? path.resolve(__dirname, "..", "..");
  const authConfig = initAuthConfig(quackRoot);
  const authService = new AuthService(quackRoot, authConfig);
  registerAuthRoutes(app, authService);
  app.use(createAuthMiddleware(authService));
  app.use(createViewerGuard());

  // â”€â”€â”€ Static files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const uiAssets = resolveMonitorUiAssets(options);
  const authority = resolveRuntimeAuthority(options);
  if (uiAssets.mode === "modern") {
    console.log(
      `[monitor] Serving UI 2.0 from ${uiAssets.rootDir} at / (legacy dashboard at ${uiAssets.legacyRoute})`,
    );
  } else if (uiAssets.mode === "legacy") {
    console.warn(
      `[monitor] UI 2.0 build not found at ${options.uiBuildDir ?? path.join(__dirname, "ui")}; serving legacy dashboard at /`,
    );
  } else {
    console.log("[monitor] Worker runtime mode: UI assets disabled; loopback API only.");
  }
  app.get("/favicon.ico", (_req: Request, res: Response) => {
    res.status(204).end();
  });
  if (uiAssets.mode !== "headless") {
    app.use(
      uiAssets.legacyRoute,
      express.static(uiAssets.legacyDir, { index: false, redirect: false }),
    );
    app.use(express.static(uiAssets.rootDir, { index: false, redirect: false }));
  }

  function hasExplicitLocalSmoke(req: Request): boolean {
    const body = req.body as Record<string, unknown> | undefined;
    return body?.localSmokeOnly === true || req.query.localSmokeOnly === "true";
  }

  function rejectNonCanonicalWrite(
    req: Request,
    res: Response,
    writeKind: string,
    correctPath: string,
  ): boolean {
    if (authority.localDbAuthoritative || hasExplicitLocalSmoke(req)) return false;
    const correctEndpoint = authority.canonicalBaseUrl
      ? `${authority.canonicalBaseUrl.replace(/\/+$/u, "")}${correctPath}`
      : correctPath;
    res.status(409).json({
      ok: false,
      error: "worker_not_canonical",
      message:
        "This monitor is not the canonical Quack state authority. Submit canonical state writes to Headnode or pass localSmokeOnly for isolated platform smoke tests.",
      writeKind,
      correctEndpoint,
      ...authority,
    });
    return true;
  }

  // â”€â”€â”€ Project resolution helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Single resolution function for both registry (multi-project) and
  // legacy (single-project) modes. All project-scoped logic routes
  // through resolveProject() to avoid duplicating ID/service resolution.
  interface ResolvedProject {
    projectId: string;
    projectRoot: string | undefined;
    taskDir: string | undefined;
    logDir: string | undefined;
    adapterPath: string | undefined;
    reader: EventReader;
    taskService: TaskService | null;
    dispatchManager: DispatchManager | null;
    prepCache: PrepCache | null;
    prepWorker: PrepWorker | null;
    prepScheduler: PrepScheduler | null;
    fleetController: FleetController | null;
    costVelocityTracker: CostVelocityTracker;
    progressDetector: ProgressDetector;
    dispatchQueue: DispatchQueue | null;
    keyManager: KeyManager | null;
    db: QuackDB | NoopDB;
    judgmentConfig?: JudgmentConfig;
  }

  async function rejectDuplicateClaimantWrite(
    project: ResolvedProject,
    taskId: string,
    res: Response,
  ): Promise<boolean> {
    const check = await buildDuplicateClaimantCheck(project, taskId);
    return rejectDuplicateClaimantCheck(check, res);
  }

  async function buildDuplicateClaimantCheck(
    project: ResolvedProject,
    taskId: string,
  ): Promise<DuplicateClaimantCheck> {
    if (!project.projectRoot || !project.taskDir) return { taskId, claimants: [] };
    const taskDir = path.resolve(project.projectRoot, project.taskDir);
    return { taskId, claimants: await listDuplicateClaimants(taskDir, taskId) };
  }

  function rejectDuplicateClaimantCheck(check: DuplicateClaimantCheck, res: Response): boolean {
    if (check.claimants.length < 2) return false;

    res.status(409).json({ ok: false, ...duplicateClaimantRefusal(check) });
    return true;
  }

  function rejectDuplicateClaimantIndex(
    index: DuplicateClaimantIndex,
    taskId: string,
    res: Response,
  ): boolean {
    const refusal = duplicateClaimantRefusalForIndex(index, taskId);
    if (!refusal) return false;
    res.status(409).json({ ok: false, ...refusal });
    return true;
  }

  function resolvedProjectFromContext(ctx: ProjectContext): ResolvedProject {
    return {
      projectId: ctx.id,
      projectRoot: ctx.rootPath,
      taskDir: ctx.adapter.config.project.taskDir,
      logDir: ctx.logDir,
      adapterPath: path.resolve(ctx.rootPath, ".quack", "adapter.json"),
      reader: ctx.eventReader,
      taskService: ctx.taskService,
      dispatchManager: ctx.dispatchManager,
      prepCache: ctx.prepCache,
      prepWorker: ctx.prepWorker,
      prepScheduler: ctx.prepScheduler,
      fleetController: ctx.fleetController,
      costVelocityTracker: ctx.costVelocityTracker,
      progressDetector: ctx.progressDetector,
      dispatchQueue: ctx.dispatchQueue,
      keyManager: ctx.keyManager,
      db: ctx.db,
      judgmentConfig: ctx.adapter.config.judgment,
    };
  }

  function createReadinessService(project: ResolvedProject): ReadinessService | null {
    if (!project.projectRoot || !project.taskService) {
      return null;
    }

    return new ReadinessService({
      projectRoot: project.projectRoot,
      taskService: project.taskService,
      prepCache: project.prepCache,
      db: project.db,
    });
  }

  interface ProjectIdCandidate {
    source: "path" | "body" | "query" | "header";
    value: string;
  }

  interface ProjectIdResolution {
    projectId: string | null;
    candidates: ProjectIdCandidate[];
    conflict: boolean;
  }

  function shouldReadBodyProjectIdCandidate(req: Request): boolean {
    if (req.method.toUpperCase() !== "POST") {
      return true;
    }

    // Worker enrollment create uses body.projectId to bind the new worker to a
    // target repo/project profile, not to select the monitor project context.
    if (req.path === "/api/workers/enrollments") {
      return false;
    }

    return true;
  }

  function collectProjectIdCandidates(req: Request): ProjectIdCandidate[] {
    const candidates: ProjectIdCandidate[] = [];
    const body = req.body as Record<string, unknown> | undefined;
    const addCandidate = (source: ProjectIdCandidate["source"], raw: unknown): void => {
      if (typeof raw !== "string") return;
      const value = raw.trim();
      if (!value) return;
      candidates.push({ source, value });
    };

    addCandidate("path", req.params.projectId);
    if (shouldReadBodyProjectIdCandidate(req)) {
      addCandidate("body", body?.projectId);
    }
    addCandidate("query", req.query.projectId);
    addCandidate("query", req.query.project);
    addCandidate("header", req.headers["x-project-id"]);

    return candidates;
  }

  function resolveProjectIdFromRequest(req: Request): ProjectIdResolution {
    const candidates = collectProjectIdCandidates(req);
    if (candidates.length === 0) {
      return { projectId: null, candidates, conflict: false };
    }

    const unique = new Set(candidates.map((candidate) => candidate.value));
    if (unique.size > 1) {
      return { projectId: null, candidates, conflict: true };
    }

    const priority: ProjectIdCandidate["source"][] = ["path", "body", "query", "header"];
    for (const source of priority) {
      const match = candidates.find((candidate) => candidate.source === source);
      if (match) return { projectId: match.value, candidates, conflict: false };
    }

    return { projectId: candidates[0]?.value ?? null, candidates, conflict: false };
  }

  // ─── Advisory-override plumbing (TASK-1319, P2-5) ────────────────
  // The endpoints are NOT the enforcement boundary; the approval-state
  // writers are (round-1 R1-3, because those writers are exported and
  // accept any state). These two helpers only carry the mode down and
  // translate the writer's typed refusal back up.

  /** Round-1 R1-7: `warn` unless an adapter says otherwise, so a client
   *  that posts no body can still approve while the record is written. */
  function advisoryOverrideMode(project: ResolvedProject): AdvisoryOverrideMode {
    return project.judgmentConfig?.advisoryOverride?.mode ?? "warn";
  }

  /** Surface the override on the event stream so an operator sees it in
   *  the moment, not only in a JSON file they would have to go find. */
  function broadcastAdvisoryOverride(
    taskId: string,
    decided: { override?: AdvisoryOverride; unexplained: boolean },
  ): void {
    if (!decided.override) return;
    sse.broadcast({
      sessionId: "approval",
      taskId,
      project: currentProjectId(),
      timestamp: new Date().toISOString(),
      stage: "advisory_override_recorded",
      payload: {
        taskId,
        surface: decided.override.surface,
        actor: decided.override.actor,
        reason: decided.override.reason,
        advisories: decided.override.advisories,
        unexplained: decided.unexplained,
      } as never,
    });
  }

  /** Map the writer's typed refusal to a 400 the dashboard can act on.
   *  Returns true when it handled the error. */
  function respondIfAdvisoryOverrideRequired(res: Response, err: unknown): boolean {
    if (!(err instanceof AdvisoryOverrideRequiredError)) return false;
    res.status(400).json({
      error: err.message,
      code: err.code,
      surface: err.surface,
      // The operator has to be able to SEE what they are overriding at
      // the moment they are asked to justify it. A prompt that just
      // says "reason required" teaches people to type "ok".
      advisories: err.advisories,
      missing: err.missing,
    });
    return true;
  }

  function resolveProject(req?: Request): ResolvedProject {
    const requestProjectId = req ? resolveProjectIdFromRequest(req).projectId : null;
    // Multi-project mode: resolve from registry
    if (registry) {
      const ctx = requestProjectId
        ? registry.getProject(requestProjectId)
        : registry.getActiveProject();
      if (ctx) {
        return resolvedProjectFromContext(ctx);
      }
    }

    // Legacy single-project mode: services were instantiated at startup
    return {
      projectId: legacyProjectId,
      projectRoot: projectRoot ?? undefined,
      taskDir: taskDir ?? undefined,
      logDir: logDir ?? undefined,
      adapterPath: adapterPath ?? undefined,
      reader,
      taskService,
      dispatchManager,
      prepCache,
      prepWorker,
      prepScheduler,
      fleetController,
      costVelocityTracker,
      progressDetector,
      dispatchQueue,
      keyManager: legacyKeyManager ?? null,
      db: legacyDb,
      judgmentConfig: legacyJudgmentConfig,
    };
  }

  function resolveProjects(req?: Request): ResolvedProject[] {
    const requestProjectId = req ? resolveProjectIdFromRequest(req).projectId : null;
    if (registry && !requestProjectId) {
      return registry.listProjects().map(resolvedProjectFromContext);
    }
    return [resolveProject(req)];
  }

  type WriteScopeResult =
    | { ok: true; project: ResolvedProject }
    | { ok: false; status: number; body: Record<string, unknown> };

  // Ledger-writing endpoints must not guess their target: on a multi-project
  // registry an unscoped write silently lands on the ACTIVE project — the
  // wrong-ledger class (TASK-1301; QPI-022 family), made concrete by
  // cross-project task-id collisions (example minted TASK-1207 into the block
  // this repo's v2 series occupies). Reads keep the active-project default.
  function resolveProjectForWrite(req: Request): WriteScopeResult {
    if (registry) {
      const requestProjectId = resolveProjectIdFromRequest(req).projectId;
      const registered = registry.listProjects();
      if (requestProjectId) {
        // An explicit id must resolve in the registry or terminate here:
        // resolveProject's legacy fall-through would otherwise let a write
        // that names a NONEXISTENT project land on the default project
        // (round-2 catch — the "project-missing-but-bypassed" surface).
        const ctx = registry.getProject(requestProjectId);
        if (!ctx) {
          return {
            ok: false,
            status: 404,
            body: {
              error: `Unknown project id "${requestProjectId}".`,
              code: "UNKNOWN_PROJECT",
              projects: registered.map((registeredCtx) => registeredCtx.id),
            },
          };
        }
        return { ok: true, project: resolvedProjectFromContext(ctx) };
      }
      if (registered.length > 1) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              "This endpoint writes project state on a multi-project monitor; name the target project explicitly.",
            code: "PROJECT_SCOPE_REQUIRED",
            projects: registered.map((ctx) => ctx.id),
            hint: "Pass ?project=<id> (or ?projectId=), a projectId body field, or an X-Project-Id header.",
          },
        };
      }
    }
    return { ok: true, project: resolveProject(req) };
  }

  app.use((req: Request, res: Response, next) => {
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/v1/")) {
      next();
      return;
    }

    const resolution = resolveProjectIdFromRequest(req);
    if (resolution.conflict) {
      res.status(400).json({
        error: "Conflicting projectId values across request sources",
        code: "PROJECT_ID_CONFLICT",
        candidates: resolution.candidates,
      });
      return;
    }

    if (!resolution.projectId) {
      next();
      return;
    }

    if (registry) {
      if (!registry.hasProject(resolution.projectId)) {
        res.status(404).json({
          error: `Project ${resolution.projectId} not found`,
          code: "PROJECT_NOT_FOUND",
        });
        return;
      }
      next();
      return;
    }

    if (resolution.projectId !== legacyProjectId) {
      res.status(404).json({
        error: `Project ${resolution.projectId} not found`,
        code: "PROJECT_NOT_FOUND",
      });
      return;
    }

    next();
  });

  // Helper to get the current project ID for SSE events.
  // Resolves ID directly (not via resolveProject) so it's safe to call
  // during construction before all services are initialized.
  function currentProjectId(): string {
    if (registry) {
      const ctx = registry.getActiveProject();
      if (ctx) return ctx.id;
    }
    return legacyProjectId;
  }

  function intakeEventTaskId(record: TaskIntakeRecord): string {
    return record.taskId ?? record.intakeId;
  }

  function createIntakeWriter(p: ResolvedProject, record: TaskIntakeRecord): EventWriter {
    const resolvedLogDir = p.logDir ?? path.join(p.projectRoot ?? "", ".quack", "logs");
    const writer = new EventWriter({
      sessionId: record.sessionId,
      taskId: intakeEventTaskId(record),
      project: p.projectId,
      logDir: resolvedLogDir,
    });
    writer.title = record.title;
    return writer;
  }

  function emitIntakeCreated(p: ResolvedProject, record: TaskIntakeRecord): void {
    const writer = createIntakeWriter(p, record);
    writer.recordSession("completed", {
      outcome: "intake_classified",
      title: record.title,
    });
    writer.emit("intake_submitted", {
      intakeId: record.intakeId,
      workflowId: record.workflowId,
      taskId: record.taskId,
      source: record.source,
      requestedBy: record.requestedBy,
      idempotencyKey: record.idempotencyKey,
    });
    writer.emit("intake_classified", {
      intakeId: record.intakeId,
      workflowId: record.workflowId,
      taskId: record.taskId,
      lane: record.classification.lane,
      riskLevel: record.classification.riskLevel,
      reasons: record.classification.reasons,
    });
  }

  function emitIntakeRouted(p: ResolvedProject, record: TaskIntakeRecord): void {
    if (!record.route) return;
    const writer = createIntakeWriter(p, record);
    writer.recordSession("completed", {
      outcome: "intake_routed",
      title: record.title,
    });
    writer.emit("intake_routed", {
      intakeId: record.intakeId,
      workflowId: record.workflowId,
      taskId: record.taskId,
      lane: record.route.lane,
      riskLevel: record.route.riskLevel,
      reasons: record.route.reasons,
      actor: record.route.actor,
      reason: record.route.reason,
    });
  }

  function createWorkflowWriter(
    p: ResolvedProject,
    workflowId: string,
    taskId: string,
    title: string,
  ): EventWriter {
    const resolvedLogDir = p.logDir ?? path.join(p.projectRoot ?? "", ".quack", "logs");
    const writer = new EventWriter({
      sessionId: workflowId,
      taskId,
      project: p.projectId,
      logDir: resolvedLogDir,
    });
    writer.title = title;
    return writer;
  }

  const createFederationWriter = (
    project: FederationProjectContext,
    workflowId: string,
    taskId: string,
    title: string,
  ): EventWriter => createWorkflowWriter(project as ResolvedProject, workflowId, taskId, title);

  const federationOrchestrationDeps: FederationOrchestrationDeps = {
    createWriter: createFederationWriter,
  };

  const federationSchedulingDeps: FederationSchedulingDeps = {
    createWriter: createFederationWriter,
    reconcileJobs: (project, claimantIndex) =>
      reconcileFederatedJobsModule(project, federationOrchestrationDeps, claimantIndex),
  };

  function normalizeProjectPathForConfig(value: string): string {
    let resolved = path.resolve(value);
    if (process.platform === "win32" && /^[A-Z]:/.test(resolved)) {
      resolved = resolved[0].toLowerCase() + resolved.slice(1);
    }
    return resolved;
  }

  async function persistActiveProjectSelection(
    projectId: string,
    ctx: ProjectContext | undefined,
  ): Promise<void> {
    if (!ctx) return;
    try {
      const { loadGlobalConfig, saveGlobalConfig } = await import("../core/global-config.js");
      const config = loadGlobalConfig();
      const activePath = normalizeProjectPathForConfig(ctx.rootPath);
      const isConfiguredProject = config.projects.some(
        (entry) => normalizeProjectPathForConfig(entry.path) === activePath,
      );
      if (!isConfiguredProject) return;
      if (config.activeProjectId === projectId) return;
      saveGlobalConfig({
        ...config,
        activeProjectId: projectId,
      });
    } catch (err: unknown) {
      console.warn(
        "[project-registry] Failed to persist active project (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function applyPersistedActiveProjectSelection(): Promise<void> {
    if (!registry) return;
    try {
      const { loadGlobalConfig } = await import("../core/global-config.js");
      const config = loadGlobalConfig();
      const activeProjectId = config.activeProjectId;
      if (!activeProjectId || !registry.hasProject(activeProjectId)) return;
      const activeContext = registry.getProject(activeProjectId);
      const activePath = activeContext ? normalizeProjectPathForConfig(activeContext.rootPath) : "";
      const isConfiguredProject = config.projects.some(
        (entry) => normalizeProjectPathForConfig(entry.path) === activePath,
      );
      if (!isConfiguredProject) return;
      registry.setActiveProject(activeProjectId);
      console.log(
        `[project-registry] Restored active project from global config: ${activeProjectId}`,
      );
    } catch (err: unknown) {
      console.warn(
        "[project-registry] Failed to restore active project (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Helpers (upsertFederatedSessionIndex, resolveFederatedTaskEventDetails,
  // sessionTitleForFederatedTask, restoreTaskStatusFromInProgress,
  // restoreTaskStatusAfterFederatedCancel) hoisted to ./federation/events.ts
  // (TASK-884). FederatedTaskEventDetails interface lives in ./federation/types.ts.

  function cleanupOrphanedDbDispatchSessions(p: ResolvedProject): number {
    let cleaned = 0;
    for (const session of p.db.getAllSessions()) {
      if (session.status !== "active") continue;
      if (session.session_id.startsWith("federation-")) continue;
      // TASK-1329 round-2 R2-1: same trap as the EventReader sweep. This runs at
      // startup, ahead of the pause-aware recovery sweep, and would roll a
      // gate-paused task's status back before anything could spare it.
      if (p.logDir && resolveRunScopedPauseState(p.logDir, session.task_id, session.start_time)) {
        continue;
      }
      const durationMs = Math.max(0, Date.now() - new Date(session.start_time).getTime());
      p.db.upsertSession({
        ...session,
        status: "error",
        outcome: "monitor_crash",
        duration_ms: durationMs,
      });
      restoreTaskStatusFromInProgress(p, session.task_id, "monitor_orphan_cleanup");
      cleaned += 1;
    }
    return cleaned;
  }

  function extractServiceToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice("Bearer ".length).trim();
    }
    const headerToken = req.headers["x-quack-service-token"];
    return typeof headerToken === "string" ? headerToken : undefined;
  }

  function requireServiceScope(req: Request, res: Response, scope: string): string | undefined {
    const result = authService.validateServiceToken(extractServiceToken(req), scope);
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        message: result.message,
        requiredScope: scope,
      });
      return undefined;
    }
    return result.tokenId;
  }

  function requireServiceScopeWhenConfigured(req: Request, res: Response, scope: string): boolean {
    const hasConfiguredServiceToken = (authConfig.serviceTokens ?? []).some(
      (token) => token.enabled !== false,
    );
    if (!hasConfiguredServiceToken) {
      return true;
    }
    return !!requireServiceScope(req, res, scope);
  }

  function requireServiceScopeAnyWhenConfigured(
    req: Request,
    res: Response,
    scopes: string[],
  ): boolean {
    const hasConfiguredServiceToken = (authConfig.serviceTokens ?? []).some(
      (token) => token.enabled !== false,
    );
    if (!hasConfiguredServiceToken) {
      return true;
    }
    return !!requireServiceScopeAny(req, res, scopes);
  }

  function requireServiceScopeAny(
    req: Request,
    res: Response,
    scopes: string[],
  ): string | undefined {
    const token = extractServiceToken(req);
    let sawUnauthorized = false;
    let scopeDeniedMessage = "";

    for (const scope of scopes) {
      const result = authService.validateServiceToken(token, scope);
      if (result.ok) return result.tokenId;
      if (result.status === 401) {
        sawUnauthorized = true;
      } else if (!scopeDeniedMessage) {
        scopeDeniedMessage = result.message;
      }
    }

    res.status(sawUnauthorized ? 401 : 403).json({
      error: sawUnauthorized ? "service_token_required" : "service_token_scope_denied",
      message:
        scopeDeniedMessage ||
        `Service token lacks one of the required scopes: ${scopes.join(", ")}`,
      requiredScopes: scopes,
    });
    return undefined;
  }

  // Federation interfaces (FederatedJobRecord, FederatedRelayEvent, FederatedSchedulingOptions,
  // FederatedVerificationOptions, FederatedCompletionOptions, FederatedOrchestrationResult,
  // FederatedRuntimeStatus) hoisted to ./federation/types.ts (TASK-884).

  // Federation domain helpers are hoisted under ./federation/*.ts:
  // types/events/host/lease/jobs/store in TASK-884 and
  // scheduling/orchestration in TASK-884-B.

  // federatedHostEventDetailsFromHost + resolveFederatedHostEventDetails hoisted
  // to ./federation/host.ts (TASK-884).
  // hasFederatedSessionStart + emitFederatedSessionStart hoisted to
  // ./federation/events.ts (TASK-884).

  // federationHostCommandsDir + appendFederatedHostCommand + readFederatedHostCommands
  // + acknowledgeFederatedHostCommands + broadcastPullDevCommand hoisted to
  // ./federation/host.ts (TASK-884).

  // applyActiveFederatedLeases hoisted to ./federation/host.ts (TASK-884).

  async function resolveAndBroadcastProjection(
    p: ResolvedProject,
    taskId: string | undefined,
  ): Promise<Awaited<ReturnType<typeof resolveWorkflowState>> | undefined> {
    if (!taskId || !p.taskService || !p.projectRoot) return undefined;
    const task = await p.taskService.getTask(taskId);
    if (!task) return undefined;

    const projection = await refreshWorkflowStateProjection({
      projectRoot: p.projectRoot,
      taskDir: p.taskService.getTaskDirectory(),
      task,
      reader: p.reader,
      hostId: p.projectId,
    });
    sse.broadcast({
      sessionId: "workflow-projection",
      taskId,
      project: p.projectId,
      timestamp: new Date().toISOString(),
      stage: "workflow_projection_updated",
      payload: {
        taskId,
        state: projection.state,
        blockReasonCode: projection.blockReasonCode,
        mergeReady: projection.mergeReady,
      },
    });
    if (projection.state === "blocked" && projection.blockReasonCode) {
      sse.broadcast({
        sessionId: "workflow-projection",
        taskId,
        project: p.projectId,
        timestamp: new Date().toISOString(),
        stage: "workflow_pending_state",
        payload: {
          taskId,
          state: projection.state,
          blockReasonCode: projection.blockReasonCode,
          label: pendingStateLabel(projection.blockReasonCode) ?? projection.blockReasonCode,
          lane: projection.lane,
          riskLevel: projection.riskLevel,
          hostId: projection.hostId,
        },
      });
    }
    return projection;
  }

  // â”€â”€â”€ API routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/health", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const projects = resolveProjects(req);
    const build = getBuildInfo();
    const activeJobs = projects.reduce(
      (count, project) => count + (project.dispatchManager?.getActiveJobs().length ?? 0),
      0,
    );
    const requestedProjectId = resolveProjectIdFromRequest(req).projectId;
    const worktreeDegraded = projects.some(
      (project) => project.dispatchManager?.isWorktreeDegraded() ?? false,
    );
    const dbIssues = registry
      ? (requestedProjectId
          ? [registry.getProject(requestedProjectId)].filter((project): project is ProjectContext =>
              Boolean(project),
            )
          : registry.listProjects()
        )
          .filter((project) => project.dbState?.degraded)
          .map((project) => ({
            projectId: project.id,
            projectName: project.name,
            dbPath: project.dbState?.dbPath,
            error: project.dbState?.error ?? "SQLite unavailable; using noop DB.",
          }))
      : legacyDbState.degraded
        ? [
            {
              projectId: legacyProjectId,
              projectName: legacyProjectName ?? legacyProjectId,
              dbPath: legacyDbState.dbPath,
              error: legacyDbState.error ?? "SQLite unavailable; using noop DB.",
            },
          ]
        : [];
    const dbDegraded = dbIssues.length > 0;
    res.json({
      status: worktreeDegraded || dbDegraded ? "degraded" : "ok",
      version: build.version,
      commit: build.commit,
      branch: build.branch,
      builtAt: build.builtAt,
      logDir: p.logDir ?? logDir,
      projectRoot: p.projectRoot ?? projectRoot ?? null,
      projectCount: projects.length,
      clients: sse.getClientCount(),
      activeJobs,
      worktreeDegraded,
      dbDegraded,
      dbIssues,
      projectionHygiene: p.projectRoot
        ? inspectGeneratedProjectionHygiene(p.projectRoot)
        : undefined,
      sessionRecovery: lastSessionRecoverySummary,
      ...authority,
      uiMode: uiAssets.mode,
      legacyUiPath: uiAssets.mode === "headless" ? undefined : uiAssets.legacyRoute,
      timestamp: new Date().toISOString(),
    });
  });

  // â”€â”€â”€ Admin run endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Long operator actions should run behind a pollable runId so admin
  // agents do not block their own tool channel while watching Quack.

  const adminRunReadScopes = ["admin:read", "admin:write", "federation:write"];

  app.get("/api/admin/runs", async (_req: Request, res: Response) => {
    if (!requireServiceScopeAnyWhenConfigured(_req, res, adminRunReadScopes)) return;
    res.json({ runs: await adminRuns.listRuns() });
  });

  app.get("/api/admin/runs/:runId", async (req: Request, res: Response) => {
    if (!requireServiceScopeAnyWhenConfigured(req, res, adminRunReadScopes)) return;
    const run = await adminRuns.getRun(req.params.runId as string);
    if (!run) {
      res.status(404).json({ error: "Admin run not found" });
      return;
    }
    res.json(run);
  });

  app.post("/api/admin/runs/:runId/stop", (req: Request, res: Response) => {
    if (!requireServiceScopeWhenConfigured(req, res, "admin:write")) return;
    const stopped = adminRuns.stopRun(req.params.runId as string);
    if (!stopped) {
      res.status(404).json({ ok: false, error: "Admin run not running or not found" });
      return;
    }
    res.json({ ok: true, runId: req.params.runId });
  });

  app.post("/api/admin/runs/overnight", (req: Request, res: Response) => {
    if (!requireServiceScopeWhenConfigured(req, res, "admin:write")) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const taskIds = parseAdminTaskIds(body?.taskIds);
    const sourceBranch = typeof body?.sourceBranch === "string" ? body.sourceBranch : undefined;
    if (taskIds.length === 0 && !sourceBranch) {
      res.status(400).json({
        error: "Provide taskIds or sourceBranch so the background run has a bounded inventory.",
      });
      return;
    }

    const run = adminRuns.startOvernight({
      projectId: p.projectId,
      projectRoot: p.projectRoot,
      monitorUrl:
        typeof body?.monitorUrl === "string" ? body.monitorUrl : `http://localhost:${port}`,
      taskIds,
      sourceBranch,
      targetBranch: typeof body?.targetBranch === "string" ? body.targetBranch : undefined,
      checkpointPath: typeof body?.checkpointPath === "string" ? body.checkpointPath : undefined,
      allowParseErrors: body?.allowParseErrors === true,
      once: body?.once === true,
      maxDispatches: parseOptionalAdminNumber(body?.maxDispatches),
      maxCycles: parseOptionalAdminNumber(body?.maxCycles),
      maxSubtasks: parseOptionalAdminNumber(body?.maxSubtasks),
      autoEnrich: body?.autoEnrich === true,
      autoDecompose: body?.autoDecompose === false ? false : undefined,
      verifyAfterDispatch: body?.verifyAfterDispatch === false ? false : undefined,
      dryRun: body?.dryRun === true,
    });
    res.status(202).json({
      ok: true,
      runId: run.runId,
      statusUrl: `/api/admin/runs/${run.runId}`,
      run,
    });
  });

  // â”€â”€â”€ SDK Diagnostic endpoint (temporary) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tests whether the Agent SDK's query() can spawn a subprocess
  // and get a response from within the monitor process.
  app.post("/api/diag/sdk-test", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    const log: string[] = [];

    log.push(`[${elapsed()}] Starting SDK diagnostic`);
    log.push(`CLAUDECODE=${process.env.CLAUDECODE ?? "(unset)"}`);
    log.push(`CLAUDE_CODE=${process.env.CLAUDE_CODE ?? "(unset)"}`);
    log.push(`CLAUDE_CODE_ENTRYPOINT=${process.env.CLAUDE_CODE_ENTRYPOINT ?? "(unset)"}`);
    log.push(`NODE_OPTIONS=${process.env.NODE_OPTIONS ?? "(unset)"}`);
    log.push(`CLAUDE_AGENT_SDK_VERSION=${process.env.CLAUDE_AGENT_SDK_VERSION ?? "(unset)"}`);
    log.push(`CWD=${process.cwd()}`);

    try {
      log.push(`[${elapsed()}] Importing SDK...`);
      const sdk: {
        query: (params: {
          prompt: string;
          options?: Record<string, unknown>;
        }) => AsyncGenerator<{ type: string; subtype?: string; [key: string]: unknown }, void>;
      } = await import("@anthropic-ai/claude-agent-sdk");
      log.push(`[${elapsed()}] SDK imported, calling query()...`);

      const model = (req.body as { model?: string })?.model ?? "claude-haiku-4-5-20251001";
      const timeoutMs = (req.body as { timeoutMs?: number })?.timeoutMs ?? 30_000;

      const useOutputFormat = (req.body as { outputFormat?: boolean })?.outputFormat ?? false;
      const queryOptions: Record<string, unknown> = {
        model,
        maxTurns: 3,
        tools: [],
        ...getSdkPermissionOptions(),
      };
      if (useOutputFormat) {
        queryOptions.outputFormat = {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
            additionalProperties: false,
          },
        };
      }
      log.push(`outputFormat: ${useOutputFormat ? "json_schema" : "none"}`);

      const gen = sdk.query({
        prompt: useOutputFormat
          ? "Respond with a JSON object containing an 'answer' field set to 'OK'."
          : "Respond with exactly one word: OK",
        options: queryOptions,
      });

      log.push(`[${elapsed()}] query() returned generator, iterating...`);

      const messages: Array<{ type: string; subtype?: string; elapsed: string }> = [];

      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
        timer.unref();
      });

      const iterate = async () => {
        for await (const message of gen) {
          const ts = elapsed();
          messages.push({ type: message.type, subtype: message.subtype, elapsed: ts });
          log.push(`[${ts}] Message: type=${message.type}, subtype=${message.subtype ?? "n/a"}`);

          if (message.type === "result") {
            if (message.subtype === "success") {
              const m = message as { result?: string; total_cost_usd?: number; num_turns?: number };
              log.push(`[${ts}] SUCCESS: ${String(m.result ?? "").slice(0, 200)}`);
              return {
                status: "success",
                result: String(m.result ?? "").slice(0, 200),
                cost: m.total_cost_usd,
                turns: m.num_turns,
              };
            }
            const m = message as { errors?: string[] };
            log.push(`[${ts}] ERROR: ${message.subtype}`);
            return { status: "error", subtype: message.subtype, errors: m.errors };
          }
        }
        return { status: "no_result", message: "Generator exhausted" };
      };

      const result = await Promise.race([iterate(), timeoutPromise]);
      log.push(`[${elapsed()}] Done.`);

      res.json({ ok: true, result, messages, log, totalMs: Date.now() - startTime });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[${elapsed()}] FAILED: ${msg}`);
      res.json({ ok: false, error: msg, log, totalMs: Date.now() - startTime });
    }
  });

  app.get("/api/sessions", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    const query = req.query as Record<string, unknown>;
    const limit = parseInt(req.query.limit as string) || 25;
    const pagination = parsePaginationQuery(query, limit);
    const statusFilter = parseListParam(query.status);
    const excludeStatusFilter = parseListParam(query.excludeStatus);
    const outcomeFilter = parseListParam(query.outcome);
    const excludeOutcomeFilter = parseListParam(query.excludeOutcome);
    const sort = typeof query.sort === "string" ? query.sort : "startTime";
    const order = parseSortOrder(query.order);

    const sessionService = new SessionService({
      db: p.db,
      reader: p.reader,
      taskService: p.taskService ?? undefined,
      resolveGateScore: readiness ? (taskId) => readiness.getCurrentGateScore(taskId) : undefined,
    });
    const sessions = await sessionService.listSessions();
    const filteredSessions = sessions.filter((session) => {
      const status = session.status.toUpperCase();
      const outcome = (session.outcome ?? "").toUpperCase();
      if (statusFilter.size > 0 && !statusFilter.has(status) && !statusFilter.has(outcome))
        return false;
      if (excludeStatusFilter.has(status) || excludeStatusFilter.has(outcome)) return false;
      if (outcomeFilter.size > 0 && !outcomeFilter.has(outcome)) return false;
      if (excludeOutcomeFilter.has(outcome)) return false;
      return true;
    });
    const sortedSessions = sortByField(filteredSessions, sort, order, sessionSortValue);
    if (pagination.requested) {
      const paged = paginateItems(sortedSessions, pagination);
      res.json({ sessions: paged.items, pagination: paged.pagination });
      return;
    }
    res.json(sortedSessions.slice(0, limit));
  });

  app.get("/api/sessions/:id", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const id = req.params.id as string;
    const events = p.reader.getSessionEvents(id);
    if (events.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(events);
  });

  app.get("/api/sessions/:id/events", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const id = req.params.id as string;
    const after = req.query.after as string | undefined;
    if (after) {
      const events = p.reader.getSessionEventsAfter(id, after);
      res.json(events);
    } else {
      const events = p.reader.getSessionEvents(id);
      res.json(events);
    }
  });

  app.get("/api/escalations", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const escalations = p.reader.getEscalations();
    res.json(escalations);
  });

  app.get("/api/costs", (req: Request, res: Response) => {
    const p = resolveProject(req);

    // Prefer SQLite for cost summary (complete history)
    if (p.db) {
      const rows = p.db.getAllSessions();
      const summary = buildCostSummaryFromSessions(rows.map(sessionRowToCostSummarySession));
      res.json(summary);
      return;
    }

    // Fallback to file-based reader
    const summary = p.reader.getCostSummary();
    res.json(summary);
  });

  app.get("/api/tasks/:id/verification", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const taskId = req.params.id as string;
    const sessions = p.reader.getExecutionSessions().filter((s) => s.taskId === taskId);
    if (sessions.length === 0) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    // Find most recent post_judge_verify_result event
    for (const session of sessions.reverse()) {
      const events = p.reader.getSessionEvents(session.sessionId);
      const verifyEvent = events.find((e) => e.stage === "post_judge_verify_result");
      if (verifyEvent) {
        res.json(verifyEvent.payload);
        return;
      }
    }
    res.json({ verified: null, findings: [] });
  });

  // â”€â”€â”€ Analytics API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // NOTE: /api/analytics/summary and /api/analytics/patterns are now handled
  // by routes/analytics.ts (registerAnalyticsRoutes) which provides distinct
  // responses: summary returns aggregate stats, patterns returns the full DB.

  app.post("/api/analytics/rebuild", async (req: Request, res: Response) => {
    try {
      const p = resolveProject(req);
      if (!p.projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }
      const { rebuildAnalyticsDB } = await import("../analytics/analytics-updater.js");
      rebuildAnalyticsDB(p.reader, p.projectRoot);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // â”€â”€â”€ Claude Code Usage (ccusage) â€” Incremental Cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // ccusage scans ALL Claude Code JSONL session files (~2GB+), which takes
  // 30-60s per call. To avoid blocking the dashboard:
  //
  // 1. Persistent cache in .quack/cache/ccusage.json â€” survives restarts
  // 2. Incremental refresh â€” only fetch from last cached date onward
  // 3. Background refresh â€” timer updates cache, API always serves cached data
  // 4. --offline flag â€” skip pricing API calls (use bundled pricing)

  interface CcusageDailyEntry {
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
    modelsUsed?: string[];
    modelBreakdowns?: Array<{
      modelName: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      cost: number;
    }>;
  }

  interface CcusageCacheData {
    daily: CcusageDailyEntry[];
    totals: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalCost: number;
      totalTokens: number;
    };
    lastRefreshedAt: string; // ISO timestamp
    lastFetchedDate: string; // YYYYMMDD â€” last date we fetched data for
  }

  const ccusageCacheRoot = projectRoot ?? process.cwd();
  const ccusageCachePath = path.join(ccusageCacheRoot, ".quack", "cache", "ccusage.json");
  let ccusageData: CcusageCacheData | null = null;
  let ccusageAvailable: boolean | null = null;
  let ccusageRefreshing = false;

  function loadCcusageCache(): CcusageCacheData | null {
    if (!ccusageCachePath) return null;
    try {
      if (fs.existsSync(ccusageCachePath)) {
        return JSON.parse(fs.readFileSync(ccusageCachePath, "utf-8")) as CcusageCacheData;
      }
    } catch {
      /* ignore corrupt cache */
    }
    return null;
  }

  function saveCcusageCache(data: CcusageCacheData): void {
    if (!ccusageCachePath) return;
    try {
      const dir = path.dirname(ccusageCachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ccusageCachePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      /* best-effort */
    }
  }

  // ccusageAvailable is set to true on first successful refresh,
  // false if the refresh fails. No synchronous execSync check â€” avoids
  // blocking server creation (which breaks tests and startup latency).

  function recomputeTotals(daily: CcusageDailyEntry[]): CcusageCacheData["totals"] {
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      totalTokens: 0,
    };
    for (const d of daily) {
      totals.inputTokens += d.inputTokens;
      totals.outputTokens += d.outputTokens;
      totals.cacheCreationTokens += d.cacheCreationTokens;
      totals.cacheReadTokens += d.cacheReadTokens;
      totals.totalCost += d.totalCost;
      totals.totalTokens += d.totalTokens;
    }
    return totals;
  }

  function isCcusageCacheStale(data: CcusageCacheData | null): boolean {
    if (!data) return true;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (!data.lastFetchedDate || data.lastFetchedDate < today) return true;
    const refreshedAt = Date.parse(data.lastRefreshedAt);
    if (!Number.isFinite(refreshedAt)) return true;
    return Date.now() - refreshedAt > 6 * 60 * 60 * 1000;
  }

  /**
   * Refresh ccusage data incrementally.
   * If we have cached data, only fetch from (lastDate - 1 day) onward to catch
   * late-arriving entries. Merge new data into the cache.
   */
  let ccusageChild: ChildProcess | null = null;
  let ccusageAborted = false;
  let ccusageRefreshPromise: Promise<void> | null = null;

  async function refreshCcusageData(): Promise<void> {
    if (ccusageRefreshing || ccusageAvailable === false || !ccusageCachePath || ccusageAborted)
      return;
    ccusageRefreshing = true;

    try {
      // Determine --since flag: overlap by 1 day from last cached date
      let sinceDate: string | null = null;
      if (ccusageData?.lastFetchedDate) {
        // Parse YYYYMMDD, subtract 1 day for overlap
        const y = parseInt(ccusageData.lastFetchedDate.substring(0, 4));
        const m = parseInt(ccusageData.lastFetchedDate.substring(4, 6)) - 1;
        const d = parseInt(ccusageData.lastFetchedDate.substring(6, 8));
        const overlapDate = new Date(y, m, d - 1);
        sinceDate = overlapDate.toISOString().slice(0, 10).replace(/-/g, "");
      }

      const runner = resolveCcusageCommand(process.env, process.platform);
      const args = [...runner.argsPrefix, "daily", "--json", "--offline"];
      if (sinceDate) args.push("--since", sinceDate);

      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(runner.command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: runner.shell,
          timeout: 120000,
          windowsHide: true,
        });
        ccusageChild = child;
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("close", (code) => {
          ccusageChild = null;
          if (ccusageAborted) reject(new Error("ccusage refresh aborted"));
          else if (code === 0 && stdout.trim()) resolve(stdout);
          else reject(new Error(stderr || `ccusage exited with code ${code}`));
        });
        child.on("error", (err) => {
          ccusageChild = null;
          reject(err);
        });
      });

      const parsed = JSON.parse(result) as {
        daily?: CcusageDailyEntry[];
        totals?: Record<string, number>;
      };
      const freshDaily = parsed.daily ?? [];

      if (freshDaily.length === 0) {
        // No new data â€” just update the refresh timestamp
        if (ccusageData) {
          ccusageData.lastRefreshedAt = new Date().toISOString();
          saveCcusageCache(ccusageData);
        }
        return;
      }

      // Merge: replace overlapping dates, append new ones
      const dailyMap = new Map<string, CcusageDailyEntry>();
      if (ccusageData?.daily && sinceDate) {
        // Keep all cached days BEFORE the overlap window
        for (const entry of ccusageData.daily) {
          dailyMap.set(entry.date, entry);
        }
      }
      // Overwrite with fresh data (newer data wins)
      for (const entry of freshDaily) {
        dailyMap.set(entry.date, entry);
      }

      // Sort by date ascending
      const mergedDaily = Array.from(dailyMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      const lastDate = mergedDaily[mergedDaily.length - 1].date.replace(/-/g, "");

      ccusageData = {
        daily: mergedDaily,
        totals: recomputeTotals(mergedDaily),
        lastRefreshedAt: new Date().toISOString(),
        lastFetchedDate: lastDate,
      };

      ccusageAvailable = true;
      saveCcusageCache(ccusageData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "ccusage refresh aborted") return;
      console.error(`[ccusage] Refresh failed: ${msg}`);
      // Mark unavailable if ccusage is not installed (not a transient error)
      if (
        msg.includes("not found") ||
        msg.includes("ENOENT") ||
        msg.includes("command not found") ||
        msg.includes("not recognized as an internal or external command")
      ) {
        ccusageAvailable = false;
      }
    } finally {
      ccusageRefreshing = false;
    }
  }

  function triggerCcusageRefresh(): void {
    if (ccusageRefreshPromise) return;
    const promise = refreshCcusageData()
      .catch((err: unknown) =>
        console.error(
          "[monitor] ccusage refresh error (non-fatal):",
          err instanceof Error ? err.message : err,
        ),
      )
      .finally(() => {
        if (ccusageRefreshPromise === promise) {
          ccusageRefreshPromise = null;
        }
      });
    ccusageRefreshPromise = promise;
  }

  // Load cache from disk on startup
  ccusageData = loadCcusageCache();

  // API endpoint â€” always returns cached data instantly
  app.get("/api/ccusage", (_req: Request, res: Response) => {
    if (!ccusageData) {
      if (ccusageAvailable === false) {
        res.status(404).json({ error: "ccusage not available" });
      } else {
        // Cache is empty â€” data is still loading or hasn't been triggered yet
        res.json({
          daily: [],
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0,
            totalTokens: 0,
          },
          loading: true,
        });
      }
      return;
    }
    const stale = isCcusageCacheStale(ccusageData);
    if (stale && process.env.NODE_ENV !== "test") {
      triggerCcusageRefresh();
    }
    res.json({
      ...ccusageData,
      stale,
      refreshing: ccusageRefreshing,
    });
  });

  // Manual refresh endpoint
  app.post("/api/ccusage/refresh", (_req: Request, res: Response) => {
    if (ccusageRefreshing) {
      res.json({ status: "already_refreshing" });
      return;
    }
    triggerCcusageRefresh();
    res.json({ status: "refresh_started" });
  });

  // â”€â”€â”€ Task endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function parseCreateTaskBody(
    body: unknown,
    mode: "single" | "bulk",
  ): { tasks?: unknown[]; error?: { status: number; payload: Record<string, unknown> } } {
    if (!body || typeof body !== "object") {
      return {
        error: {
          status: 400,
          payload: { error: "Invalid request body", code: "INVALID_PAYLOAD" },
        },
      };
    }

    const record = body as Record<string, unknown>;
    if (mode === "single") {
      const taskObject = record.task && typeof record.task === "object" ? record.task : record;
      return { tasks: [taskObject] };
    }

    if (!Array.isArray(record.tasks)) {
      return {
        error: {
          status: 400,
          payload: {
            error: "Missing required field: tasks",
            code: "TASKS_ARRAY_REQUIRED",
          },
        },
      };
    }

    return { tasks: record.tasks };
  }

  async function runTaskCreate(
    req: Request,
    res: Response,
    mode: "single" | "bulk",
  ): Promise<void> {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.status(404).json({ error: "Task service not configured (no project root)" });
      return;
    }

    const parsed = parseCreateTaskBody(req.body, mode);
    if (parsed.error) {
      res.status(parsed.error.status).json(parsed.error.payload);
      return;
    }

    try {
      const adapter = await loadAdapter(p.projectRoot);
      const result = await createTaskFilesFromInput(parsed.tasks ?? [], adapter);

      const beforeCount = p.taskService.getLastParsedCount();
      const sessionsByTask = buildSessionMap(p.reader);
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const refreshed = await p.taskService.refreshTasks(sessionsByTask, verifiedIndex, p.db);

      sse.broadcast({
        sessionId: "monitor",
        taskId: "",
        project: p.projectId,
        timestamp: new Date().toISOString(),
        stage: "tasks_refreshed",
        payload: {
          taskCount: refreshed.tasks.length,
          parseErrorCount: refreshed.parseErrors.length,
          parseWarningCount: refreshed.parseWarnings.length,
        },
      });

      res.status(201).json({
        ok: true,
        created: result.taskIds,
        files: result.filePaths,
        refreshed: {
          before: beforeCount,
          after: refreshed.tasks.length,
          parseErrors: refreshed.parseErrors,
          parseWarnings: refreshed.parseWarnings,
        },
      });
    } catch (err: unknown) {
      const typed = err as { name?: string; fieldErrors?: unknown; conflictIds?: unknown };
      if (typed.name === "TaskCreateValidationError") {
        res.status(400).json({
          error: "Task payload validation failed",
          code: "TASK_VALIDATION_FAILED",
          fieldErrors: typed.fieldErrors ?? [],
        });
        return;
      }
      if (typed.name === "TaskCreateConflictError") {
        res.status(409).json({
          error: "Task ID conflict",
          code: "TASK_ID_CONFLICT",
          conflictIds: typed.conflictIds ?? [],
        });
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      const diagnostics = toRuntimeDiagnostics(err, "tasks.create");
      res.status(500).json({
        error: `Failed to create tasks: ${msg}`,
        diagnostics: {
          kind: diagnostics.kind,
          stage: diagnostics.stage,
          exitCode: diagnostics.exitCode,
          stderrTail: diagnostics.stderrTail,
          retryable: diagnostics.retryable,
        },
      });
    }
  }

  app.get("/api/tasks", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured (no project root)" });
      return;
    }
    try {
      const query = req.query as Record<string, unknown>;
      const pagination = parsePaginationQuery(query);
      const statusFilter = parseListParam(query.status);
      const excludeStatusFilter = parseListParam(query.excludeStatus);
      const sort = typeof query.sort === "string" ? query.sort : "id";
      const order = typeof query.order === "string" ? parseSortOrder(query.order) : "asc";
      const search = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
      const sessionsByTask = buildSessionMap(p.reader);
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const { tasks, parseErrors, parseWarnings, hygiene } = await p.taskService.listTasks(
        sessionsByTask,
        verifiedIndex,
        p.db,
      );
      const gitConfig = getAdapterGitConfig(p.adapterPath);
      const tasksWithBranchData = gitConfig
        ? tasks.map((task) => {
            const resolved = resolveTargetBranch(task.id, task.targetBranch, gitConfig);
            return {
              ...task,
              targetBranch: resolved.baseBranch,
              branchGroup: resolved.groupName ?? (task.targetBranch ? "task-target" : "default"),
            };
          })
        : tasks.map((task) => ({
            ...task,
            branchGroup: task.branchGroup ?? "default",
          }));
      const filteredTasks = tasksWithBranchData.filter((task) => {
        const status = task.status.toUpperCase();
        const effectiveStatus = task.effectiveStatus.toUpperCase();
        if (
          statusFilter.size > 0 &&
          !statusFilter.has(status) &&
          !statusFilter.has(effectiveStatus)
        )
          return false;
        if (excludeStatusFilter.has(status) || excludeStatusFilter.has(effectiveStatus))
          return false;
        if (search) {
          const haystack = [
            task.id,
            task.title,
            task.priority,
            task.status,
            task.effectiveStatus,
            task.branchGroup,
            ...task.tags,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });
      const sortedTasks = sortByField(filteredTasks, sort, order, taskSortValue);
      const pagedTasks = pagination.requested
        ? paginateItems(sortedTasks, pagination)
        : paginateItems(sortedTasks, {
            page: 1,
            perPage: Math.max(sortedTasks.length, 1),
            requested: false,
          });
      res.json({
        tasks: pagedTasks.items,
        parseErrors,
        parseWarnings,
        hygiene,
        parsedTaskCount: tasksWithBranchData.length,
        filteredTaskCount: sortedTasks.length,
        parseErrorCount: parseErrors.length,
        parseWarningCount: parseWarnings.length,
        taskFileCount: tasksWithBranchData.length + parseErrors.length,
        pagination: pagedTasks.pagination,
        warnings:
          parseErrors.length > 0
            ? [`${parseErrors.length} task file(s) failed to parse and are not dispatchable.`]
            : [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list tasks: ${msg}` });
    }
  });

  app.get("/api/tasks/hygiene", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured (no project root)" });
      return;
    }
    try {
      const sessionsByTask = buildSessionMap(p.reader);
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const { hygiene } = await p.taskService.listTasks(sessionsByTask, verifiedIndex, p.db);
      res.json(
        hygiene ?? {
          duplicateIds: [],
          supersededTasks: [],
          excludedCandidates: [],
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to build task hygiene report: ${msg}` });
    }
  });

  // â”€â”€â”€ Refresh endpoint (Fix 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/branch-groups", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured (no project root)" });
      return;
    }
    const gitConfig = getAdapterGitConfig(p.adapterPath);
    if (!gitConfig) {
      res.json({ groups: [], totalTasks: 0 });
      return;
    }

    try {
      const sessionsByTask = buildSessionMap(p.reader);
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const { tasks } = await p.taskService.listTasks(sessionsByTask, verifiedIndex, p.db);
      const counts = new Map<string, number>();
      for (const task of tasks) {
        const resolved = resolveTargetBranch(task.id, task.targetBranch, gitConfig);
        const groupName = resolved.groupName ?? (task.targetBranch ? "task-target" : "default");
        counts.set(groupName, (counts.get(groupName) ?? 0) + 1);
      }

      const groups: Array<{
        name: string;
        baseBranch: string;
        autoMergeTarget: string;
        description?: string;
        taskPattern?: string;
        taskCount: number;
      }> = [
        {
          name: "default",
          baseBranch: gitConfig.baseBranch,
          autoMergeTarget: gitConfig.autoMergeTarget ?? gitConfig.baseBranch,
          description: "Default branch routing",
          taskCount: counts.get("default") ?? 0,
        },
      ];

      for (const [name, group] of Object.entries(gitConfig.branchGroups ?? {})) {
        groups.push({
          name,
          baseBranch: group.baseBranch,
          autoMergeTarget: group.autoMergeTarget ?? group.baseBranch,
          description: group.description,
          taskPattern: group.taskPattern,
          taskCount: counts.get(name) ?? 0,
        });
      }

      if ((counts.get("task-target") ?? 0) > 0) {
        groups.push({
          name: "task-target",
          baseBranch: "task-defined",
          autoMergeTarget: "task-defined",
          description: "Explicit Target Branch field in task metadata",
          taskCount: counts.get("task-target") ?? 0,
        });
      }

      res.json({ groups, totalTasks: tasks.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list branch groups: ${msg}` });
    }
  });

  app.post("/api/tasks/create", async (req: Request, res: Response) => {
    await runTaskCreate(req, res, "single");
  });

  app.post("/api/tasks/create-bulk", async (req: Request, res: Response) => {
    await runTaskCreate(req, res, "bulk");
  });

  app.post("/api/tasks/refresh", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }
    try {
      const beforeCount = p.taskService.getLastParsedCount();
      const sessionsByTask = buildSessionMap(p.reader);
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const { tasks, parseErrors, parseWarnings } = await p.taskService.refreshTasks(
        sessionsByTask,
        verifiedIndex,
        p.db,
      );
      const gitConfig = getAdapterGitConfig(p.adapterPath);
      const tasksWithBranchData = gitConfig
        ? tasks.map((task) => {
            const resolved = resolveTargetBranch(task.id, task.targetBranch, gitConfig);
            return {
              ...task,
              targetBranch: resolved.baseBranch,
              branchGroup: resolved.groupName ?? (task.targetBranch ? "task-target" : "default"),
            };
          })
        : tasks.map((task) => ({
            ...task,
            branchGroup: task.branchGroup ?? "default",
          }));
      const afterCount = tasks.length;

      sse.broadcast({
        sessionId: "monitor",
        taskId: "",
        project: resolveProject().projectId,
        timestamp: new Date().toISOString(),
        stage: "tasks_refreshed",
        payload: {
          taskCount: afterCount,
          parseErrorCount: parseErrors.length,
          parseWarningCount: parseWarnings.length,
        },
      });

      res.json({
        refreshed: true,
        before: beforeCount,
        after: afterCount,
        tasks: tasksWithBranchData,
        parseErrors,
        parseWarnings,
        parsedTaskCount: tasksWithBranchData.length,
        parseErrorCount: parseErrors.length,
        parseWarningCount: parseWarnings.length,
        taskFileCount: tasksWithBranchData.length + parseErrors.length,
        warnings:
          parseErrors.length > 0
            ? [`${parseErrors.length} task file(s) failed to parse and are not dispatchable.`]
            : [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to refresh tasks: ${msg}` });
    }
  });

  // â”€â”€â”€ Intake endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Federated task intake (/v1/intake/*) is registered together with the
  // bootstrap intake block (/api/scan + /api/intake/*) below; both live
  // in routes/intake.ts (TASK-873).

  // â”€â”€â”€ Workflow + Review endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // /v1/workflows/* + /v1/reviews + /v1/reviews/:id + /v1/jobs/:id/events
  // + /v1/support-content all live in routes/workflows.ts (TASK-873).
  // Closure helpers (createWorkflowWriter, resolveAndBroadcastProjection)
  // are typed against ResolvedProject inside the closure; casts narrow
  // them to WorkflowRouteProject for the route module's view.
  registerWorkflowRoutes(app, {
    resolveProject,
    resolveProjectForWrite: resolveProjectForWrite as WorkflowRouteDeps["resolveProjectForWrite"],
    createWorkflowWriter: createWorkflowWriter as WorkflowRouteDeps["createWorkflowWriter"],
    resolveAndBroadcastProjection:
      resolveAndBroadcastProjection as WorkflowRouteDeps["resolveAndBroadcastProjection"],
    sse,
    // TASK-1203: the reviews→ledger bridge writes through the canonical store.
    recordVerification,
    // Unblock parity with the /api/tasks/:id/verified path: an applied write
    // releases federated dependency blocks, ticks the scheduler, and refreshes
    // already-enqueued queue dependents.
    onLedgerApplied: async (proj, taskId) => {
      const resolved = proj as ResolvedProject;
      await resolved.dispatchQueue?.notifyExternalCompletion(taskId);
      const unblockedJobs = await releaseFederatedDependencyBlocksModule(resolved, taskId);
      if (unblockedJobs.length > 0) {
        await runSwarmSchedulerTickModule(resolved, {}, federationSchedulingDeps);
      }
    },
  });
  registerListenerRoutes(app, {
    resolveProject,
    requireServiceScope,
    requireServiceScopeWhenConfigured,
    createServiceToken: authService.createServiceToken.bind(authService),
    federationSchedulingDeps,
  });
  registerFederationRoutes(app, {
    resolveProject,
    resolveProjectForWrite: resolveProjectForWrite as FederationRouteDeps["resolveProjectForWrite"],
    createWorkflowWriter: createWorkflowWriter as FederationRouteDeps["createWorkflowWriter"],
    resolveAndBroadcastProjection:
      resolveAndBroadcastProjection as FederationRouteDeps["resolveAndBroadcastProjection"],
    requireServiceScope,
    requireServiceScopeAny,
    allowDashboardRead: (req: Request) => {
      const authReq = req as AuthenticatedRequest;
      const hasConfiguredServiceToken = (authConfig.serviceTokens ?? []).some(
        (token) => token.enabled !== false,
      );
      const hasConfiguredApiKey = authService.apiKeyCount > 0;
      return (
        !!authReq.session ||
        !!authReq.apiPrincipal ||
        (!authService.enabled && !hasConfiguredServiceToken && !hasConfiguredApiKey)
      );
    },
    federationSchedulingDeps,
    federationOrchestrationDeps,
    execGit: options.federationGitExec,
  });

  app.post("/api/tasks/:id/reject", async (req: Request, res: Response) => {
    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }
    const taskId = req.params.id as string;
    if (
      rejectNonCanonicalWrite(
        req,
        res,
        "task_reject",
        `/api/tasks/${encodeURIComponent(taskId)}/reject`,
      )
    )
      return;
    const reason = (req.body as { reason?: string })?.reason ?? "";

    try {
      const filePath = await p.taskService.getTaskFilePath(taskId);
      if (!filePath) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const content = await fsPromises.readFile(filePath, "utf-8");
      const statusMatch = content.match(/\*\*Status:\*\*\s*(\w+)/);
      const previousStatus = statusMatch?.[1] ?? "UNKNOWN";

      if (previousStatus === "REJECTED") {
        res.status(400).json({ error: `Task ${taskId} is already REJECTED` });
        return;
      }

      const updated = content.replace(/(\*\*Status:\*\*\s*)\w+/, `$1REJECTED`);
      if (await rejectDuplicateClaimantWrite(p, taskId, res)) return;
      await fsPromises.writeFile(filePath, updated, "utf-8");

      // TASK-867: canonical verification store handles DB + JSON in lockstep.
      await recordVerification(p, {
        taskId,
        verdict: "REJECTED",
        commitSha: "n/a",
        method: "api",
        criteriaChecked: 0,
        criteriaPassed: 0,
        notes: reason || "Rejected via API",
      });

      sse.broadcast({
        sessionId: "monitor",
        taskId,
        project: resolveProject().projectId,
        timestamp: new Date().toISOString(),
        stage: "task_rejected",
        payload: { taskId, reason },
      });

      res.json({ success: true, taskId, previousStatus, newStatus: "REJECTED" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to reject task: ${msg}` });
    }
  });

  // â”€â”€â”€ Record verification result to DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Called by /verify-task after the review bundle is persisted, and by
  // any external tool that needs to record a canonical verification result.
  app.post("/api/tasks/:id/status", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.db) {
      res.status(404).json({ error: "Task status store not configured" });
      return;
    }
    const taskId = req.params.id as string;
    if (
      rejectNonCanonicalWrite(
        req,
        res,
        "task_status",
        `/api/tasks/${encodeURIComponent(taskId)}/status`,
      )
    )
      return;
    const rawStatus = (req.body as { status?: unknown }).status;
    const status = normalizeTaskStatus(typeof rawStatus === "string" ? rawStatus : undefined);
    if (!status) {
      res.status(400).json({
        error: `Invalid status. Must be one of: ${TASK_STATUSES.join(", ")}`,
      });
      return;
    }
    if (status === "COMPLETE" || status === "VERIFIED") {
      const claimantIndex = await buildFederationClaimantIndexModule(p);
      if (rejectDuplicateClaimantIndex(claimantIndex, taskId, res)) return;
    }
    p.db.setStatus(taskId, status, "dashboard");
    sse.broadcast({
      sessionId: "dashboard",
      taskId,
      project: p.projectId,
      timestamp: new Date().toISOString(),
      stage: "task_status_updated" as never,
      payload: { taskId, status, updatedBy: "dashboard" } as never,
    });
    res.json({ ok: true, taskId, status });
  });

  app.post("/api/tasks/:id/verified", async (req: Request, res: Response) => {
    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    const taskId = req.params.id as string;
    const body = req.body as Record<string, unknown> | undefined;

    if (
      rejectNonCanonicalWrite(
        req,
        res,
        "task_verified",
        `/api/tasks/${encodeURIComponent(taskId)}/verified`,
      )
    )
      return;

    if (!body?.verdict) {
      res.status(400).json({ error: "Missing required field: verdict" });
      return;
    }

    try {
      const reviewId = typeof body.reviewId === "string" ? body.reviewId : undefined;
      const method = typeof body.method === "string" ? body.method : "";
      const requireReviewExplicit = body.requireReview === true || body.requireReview === "true";
      // TASK-1106: validation-intake VERIFIED writes also require a review
      // bundle. Non-bypass rule — without this guard, a teammate could POST
      // { verdict: "VERIFIED", method: "validation-intake" } with no evidence.
      const requireReviewForGuardedMethod =
        body.verdict === "VERIFIED" &&
        (method === "/verify-task" || method === "verify-task" || method === "validation-intake");
      const requireReview = requireReviewExplicit || requireReviewForGuardedMethod;

      if (body.verdict === "VERIFIED") {
        if (requireReview && !reviewId) {
          res.status(409).json({
            error: "review_required",
            message: "This verification requires a reviewId with a merge-ready review bundle.",
            taskId,
            method: method || "api",
          });
          return;
        }

        if (reviewId) {
          if (!p.projectRoot) {
            res.status(409).json({
              error: "review_missing",
              message: "Project root is not configured; cannot resolve review bundle.",
              taskId,
              reviewId,
            });
            return;
          }

          const reviewPath = path.join(p.projectRoot, ".quack", "reviews", `${reviewId}.json`);
          let reviewRaw: string;
          try {
            reviewRaw = await fsPromises.readFile(reviewPath, "utf-8");
          } catch {
            res.status(409).json({
              error: "review_missing",
              message: `Review bundle ${reviewId} not found.`,
              taskId,
              reviewId,
            });
            return;
          }

          let parsedReview:
            | {
                gate?: {
                  mergeReady?: boolean;
                  issues?: Array<{ code?: string; message?: string }>;
                };
              }
            | undefined;
          try {
            parsedReview = JSON.parse(reviewRaw) as typeof parsedReview;
          } catch {
            res.status(409).json({
              error: "review_invalid",
              message: `Review bundle ${reviewId} is not valid JSON.`,
              taskId,
              reviewId,
            });
            return;
          }

          if (!parsedReview?.gate?.mergeReady) {
            res.status(409).json({
              error: "review_not_merge_ready",
              message: `Review bundle ${reviewId} is not merge-ready.`,
              taskId,
              reviewId,
              issues: parsedReview?.gate?.issues ?? [],
            });
            return;
          }
        }
      }

      // TASK-1203 round-2 guard: updated_at is the write-recency cursor, so
      // an unvalidated value could plant a future stamp that beats every
      // subsequent canonical write forever (QPI-022 class). Require the UTC
      // ISO-8601 shape (lexical order == chronological order in the store's
      // comparator) and reject cursors from the future beyond clock skew.
      if (body.updated_at !== undefined) {
        const rawCursor = body.updated_at;
        const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
        const parsedCursor = typeof rawCursor === "string" ? Date.parse(rawCursor) : NaN;
        // Round-trip check: Date.parse rolls invalid calendar days over
        // (2026-02-30 parses as Mar 2), which would store a cursor string
        // whose lexical order disagrees with its parsed instant.
        const roundTrips =
          Number.isFinite(parsedCursor) &&
          typeof rawCursor === "string" &&
          new Date(parsedCursor).toISOString().slice(0, 19) === rawCursor.slice(0, 19);
        if (typeof rawCursor !== "string" || !UTC_ISO_RE.test(rawCursor) || !roundTrips) {
          res.status(400).json({
            ok: false,
            error: "invalid_updated_at",
            message: "updated_at must be a UTC ISO-8601 datetime (e.g. 2026-07-14T21:00:00.000Z).",
            taskId,
          });
          return;
        }
        const MAX_CURSOR_SKEW_MS = 5 * 60 * 1000;
        if (parsedCursor > Date.now() + MAX_CURSOR_SKEW_MS) {
          res.status(400).json({
            ok: false,
            error: "updated_at_in_future",
            message: "updated_at may not be in the future (5 minutes of clock skew allowed).",
            taskId,
          });
          return;
        }
      }

      // TASK-867: route through canonical verification store so DB + JSON
      // stay in lockstep. Closes the regression that left verified.json
      // empty on this code path (the bug the other agent surfaced 2026-04-29
      // when 18 tasks had VERIFIED in verified.json but IN_PROGRESS in DB,
      // blocking dependency resolution).
      const verdictNarrowed = body.verdict as
        | "VERIFIED"
        | "FAILED"
        | "REJECTED"
        | "SOFT-VERIFIED"
        | "CANNOT_VERIFY";
      const claimantIndex =
        verdictNarrowed === "VERIFIED" || verdictNarrowed === "SOFT-VERIFIED"
          ? await buildFederationClaimantIndexModule(p)
          : undefined;
      const recordResult = await recordVerification(
        p,
        {
          taskId,
          verdict: verdictNarrowed,
          commitSha: (body.commit as string) ?? "unknown",
          method: (body.method as string) ?? "api",
          criteriaChecked: (body.criteria_checked as number) ?? 0,
          criteriaPassed: (body.criteria_passed as number) ?? 0,
          notes: (body.notes as string) ?? null,
          verifiedAt: (body.verified as string) ?? undefined,
          // TASK-1203 (surfaced pre-existing gap): forward the optional write
          // cursor so callers replaying historical evidence can hit the
          // recency-precedence stale path (federation-sync already sets it on
          // peer rows; without this, every /api repeat write is "newer").
          updatedAt: (body.updated_at as string) ?? undefined,
          reviewId: typeof body.reviewId === "string" ? body.reviewId : undefined,
        },
        {},
        claimantIndex,
      );

      if (recordResult.refusal) {
        res.status(409).json({ ok: false, ...recordResult.refusal });
        return;
      }

      const persisted = {
        verdict: recordResult.row.verdict,
        commit: recordResult.row.commit_sha,
        method: recordResult.row.method,
        criteria_checked: recordResult.row.criteria_checked,
        criteria_passed: recordResult.row.criteria_passed,
        verified: recordResult.row.verified_at,
        updated_at: recordResult.row.updated_at ?? recordResult.row.verified_at,
      };

      if (!recordResult.applied && recordResult.skippedReason === "stale") {
        res.status(409).json({
          ok: false,
          error: "verification_stale_write",
          message: "Verification write was rejected as stale; persisted state is newer.",
          taskId,
          reviewId: typeof body.reviewId === "string" ? body.reviewId : null,
          skippedReason: recordResult.skippedReason,
          persisted,
        });
        return;
      }

      // TASK-1201: SOFT-VERIFIED unblocks dependents (decided semantics), so
      // it releases federated dependency blocks the same way VERIFIED does.
      const unblockedJobs =
        recordResult.applied &&
        (recordResult.row.verdict === "VERIFIED" || recordResult.row.verdict === "SOFT-VERIFIED")
          ? await releaseFederatedDependencyBlocksModule(p, taskId)
          : [];
      const scheduler =
        unblockedJobs.length > 0
          ? await runSwarmSchedulerTickModule(p, {}, federationSchedulingDeps)
          : undefined;

      res.json({
        ok: true,
        taskId,
        applied: recordResult.applied,
        skippedReason: recordResult.skippedReason ?? null,
        verdict: persisted.verdict,
        commit: persisted.commit,
        method: persisted.method,
        criteria_checked: persisted.criteria_checked,
        criteria_passed: persisted.criteria_passed,
        verified: persisted.verified,
        updated_at: persisted.updated_at,
        persisted,
        reviewId: typeof body.reviewId === "string" ? body.reviewId : null,
        unblockedJobs: unblockedJobs.map((job) => job.jobId),
        scheduler,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to record verification: ${msg}` });
    }
  });

  app.get("/api/tasks/parse-errors", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }
    try {
      const { parseErrors } = await p.taskService.listTasks();
      res.json(parseErrors);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get parse errors: ${msg}` });
    }
  });

  app.get("/api/tasks/active", (req: Request, res: Response) => {
    const activeJobs = resolveProjects(req).flatMap(
      (project) =>
        project.dispatchManager?.getActiveJobs().map((job) => ({
          ...job,
          project: project.projectId,
        })) ?? [],
    );
    res.json(activeJobs);
  });

  app.get("/api/tasks/prep-cache", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    if (!readiness || !p.taskService) {
      res.json({ results: {} });
      return;
    }

    try {
      const { tasks } = await p.taskService.listTasks();
      const entries = await Promise.all(
        tasks.map(async (task) => {
          const result = await readiness.resolveCurrent(task.id);
          return [task.id, result?.prep ?? null] as const;
        }),
      );
      res.json({
        results: Object.fromEntries(entries.filter(([, result]) => result !== null)),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read prep cache: ${msg}` });
    }
  });

  app.get("/api/tasks/preflight-cache", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    if (!readiness || !p.taskService) {
      res.json({ results: {} });
      return;
    }

    try {
      const { tasks } = await p.taskService.listTasks();
      const entries = await Promise.all(
        tasks.map(async (task) => {
          const result = await readiness.resolveCurrent(task.id);
          return [task.id, result?.preflight ?? null] as const;
        }),
      );
      res.json({
        results: Object.fromEntries(entries.filter(([, result]) => result !== null)),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read preflight cache: ${msg}` });
    }
  });

  app.get("/v1/tasks/:id/workflow-state", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({
          error: "task_not_found",
          message: `Task ${taskId} not found.`,
          taskId,
        });
        return;
      }

      const projection = await resolveWorkflowState({
        projectRoot: p.projectRoot,
        taskDir: p.taskService.getTaskDirectory(),
        task,
        reader: p.reader,
        hostId: p.projectId,
      });

      res.json(projection);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to resolve workflow state: ${msg}` });
    }
  });

  app.post("/v1/tasks/:id/workflow-state/refresh", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({
          error: "task_not_found",
          message: `Task ${taskId} not found.`,
          taskId,
        });
        return;
      }

      const projection = await resolveAndBroadcastProjection(p, task.id);
      res.json({
        ok: true,
        taskId: task.id,
        projection: projection ?? null,
        refreshedAt: projection?.updatedAt ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to refresh workflow state: ${msg}` });
    }
  });

  app.get("/v1/tasks/:id/review-docs-summary", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({
          error: "task_not_found",
          message: `Task ${taskId} not found.`,
          taskId,
        });
        return;
      }

      const projection = await resolveWorkflowState({
        projectRoot: p.projectRoot,
        taskDir: p.taskService.getTaskDirectory(),
        task,
        reader: p.reader,
        hostId: p.projectId,
      });
      const verifiedIndex = await loadVerifiedIndex(p.projectRoot);
      const verifiedEntry = verifiedIndex[task.id];
      const latestReview = await loadLatestReviewBundleForTask(p.projectRoot, task.id);
      const supportRecords = await loadSupportContentRecords(p.projectRoot, task.id);
      const docsEvents = await loadDocsJobEventSummaries(p.projectRoot, task.id);
      const requiredWikiActions =
        latestReview?.gate.requiredWikiActions ?? projection.requiredWikiActions;
      const wikiArtifacts = latestReview?.wikiArtifacts ?? [];
      const changelogArtifact = artifactForAction(wikiArtifacts, "changelog_entry");
      const featureArtifact = artifactForAction(wikiArtifacts, "feature_page_update");
      const supportArtifact = artifactForAction(wikiArtifacts, "support_bundle");
      const changelogFile = await fileArtifactSummary(
        path.join(p.projectRoot, ".quack", "docs-pipeline", "changelog.md"),
      );
      const featureFile = await fileArtifactSummary(
        path.join(p.projectRoot, ".quack", "docs-pipeline", "feature-updates.md"),
      );
      const supportFile = await fileArtifactSummary(
        path.join(p.projectRoot, ".quack", "docs-pipeline", "support-content.jsonl"),
      );
      const changelogPresent = !!changelogArtifact || changelogFile.exists;
      const featurePresent = !!featureArtifact || featureFile.exists;
      const supportPresent = !!supportArtifact || supportRecords.length > 0;
      const docsReady =
        (!requiredWikiActions.includes("changelog_entry") || changelogPresent) &&
        (!requiredWikiActions.includes("feature_page_update") || featurePresent) &&
        (!requiredWikiActions.includes("support_bundle") || supportPresent);
      const mergeReady = latestReview?.gate.mergeReady ?? projection.mergeReady;
      const pendingState = projection.blockReasonCode
        ? {
            code: projection.blockReasonCode,
            label: pendingStateLabel(projection.blockReasonCode) ?? projection.blockReasonCode,
          }
        : null;

      res.json({
        ok: true,
        taskId: task.id,
        projection,
        pendingState,
        lane: projection.lane ?? null,
        riskLevel: projection.riskLevel ?? null,
        hostId: projection.hostId ?? null,
        verification: {
          verified: isVerifiedEntry(verifiedEntry),
          verifiedAt: verifiedEntry?.verified ?? null,
          method: verifiedEntry?.method ?? null,
          verdict: verifiedEntry?.verdict ?? null,
          criteriaChecked: verifiedEntry?.criteriaChecked ?? null,
          criteriaPassed: verifiedEntry?.criteriaPassed ?? null,
        },
        closeoutState: {
          workflowState: projection.state,
          pendingState,
          mergeReady,
          docsReady,
          verified: isVerifiedEntry(verifiedEntry),
          requiredWikiActions,
          missingWikiActions:
            latestReview?.gate.missingWikiActions ?? projection.missingWikiActions,
        },
        reviewGate: {
          reviewId: latestReview?.reviewId ?? null,
          verdict: latestReview?.verdict ?? null,
          docsImpact: latestReview?.docsImpact ?? projection.docsImpact ?? null,
          mergeReady,
          requiredWikiActions,
          missingWikiActions:
            latestReview?.gate.missingWikiActions ?? projection.missingWikiActions,
          unresolvedFindingsCount: countUnresolvedHighFindings(latestReview?.findings),
          blockingReasons: reviewBlockingReasons(latestReview),
          findings: latestReview?.findings ?? [],
        },
        docsPipeline: {
          changelog: {
            required: requiredWikiActions.includes("changelog_entry"),
            present: changelogPresent,
            artifact: changelogArtifact ?? null,
            path: changelogArtifact?.pagePath ?? (changelogFile.exists ? changelogFile.path : null),
            updatedAt: changelogFile.updatedAt ?? null,
          },
          featureDocs: {
            required: requiredWikiActions.includes("feature_page_update"),
            present: featurePresent,
            artifact: featureArtifact ?? null,
            path: featureArtifact?.pagePath ?? (featureFile.exists ? featureFile.path : null),
            updatedAt: featureFile.updatedAt ?? null,
          },
          supportContent: {
            required: requiredWikiActions.includes("support_bundle"),
            present: supportPresent,
            artifact: supportArtifact ?? null,
            path: supportArtifact?.pagePath ?? (supportFile.exists ? supportFile.path : null),
            updatedAt: supportFile.updatedAt ?? null,
            count: supportRecords.length,
            latestGeneratedAt: supportRecords[0]?.generatedAt ?? null,
            records: supportRecords.slice(0, 10),
          },
          latestDocsEvent: docsEvents[0] ?? null,
          docsEvents: docsEvents.slice(0, 10),
        },
        updatedAt: projection.updatedAt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to build review/docs summary: ${msg}` });
    }
  });

  app.get("/api/tasks/:id", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    try {
      for (const p of resolveProjects(req)) {
        if (!p.taskService) continue;
        const task = await p.taskService.getTask(taskId);
        if (!task) continue;
        // Include dispatch status if available
        const job = p.dispatchManager?.getJob(taskId);
        const gitConfig = getAdapterGitConfig(p.adapterPath);
        const resolved = gitConfig
          ? resolveTargetBranch(task.id, task.targetBranch, gitConfig)
          : null;
        res.json({
          ...task,
          targetBranch: resolved?.baseBranch ?? task.targetBranch,
          branchGroup: resolved?.groupName ?? (task.targetBranch ? "task-target" : "default"),
          project: p.projectId,
          dispatch: job ? { ...job, project: p.projectId } : null,
        });
        return;
      }
      res.status(404).json({ error: `Task ${taskId} not found` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get task: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/runs", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    const taskId = req.params.id as string;
    const sessionService = new SessionService({
      db: p.db,
      reader: p.reader,
      taskService: p.taskService ?? undefined,
      resolveGateScore: readiness
        ? (currentTaskId) => readiness.getCurrentGateScore(currentTaskId)
        : undefined,
    });
    res.json(await sessionService.getTaskRuns(taskId));
  });

  app.get("/api/tasks/:id/progress", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    try {
      const { ProgressWatcher } = await import("../dispatcher/progress-watcher.js");
      const taskId = req.params.id as string;

      // Check the task's worktree first (where PROGRESS.md is written during dispatch),
      // then fall back to the project root
      const job = p.dispatchManager?.getJob(taskId);
      const searchPath = job?.worktreePath ?? p.projectRoot;

      const progress = ProgressWatcher.readProgress(searchPath);
      if (!progress) {
        // If worktree didn't have it, also check project root as fallback
        if (searchPath !== p.projectRoot) {
          const fallback = ProgressWatcher.readProgress(p.projectRoot);
          if (fallback) {
            res.json(fallback);
            return;
          }
        }
        res.status(404).json({ error: "No progress file found" });
        return;
      }
      res.json(progress);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read progress: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/template-match", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.json(null);
      return;
    }
    const taskId = req.params.id as string;
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.json(null);
        return;
      }
      const { loadRegistry } = await import("../templates/template-registry.js");
      const { findBestTemplate } = await import("../templates/template-matcher.js");
      const registry = await loadRegistry(p.projectRoot);
      const match = findBestTemplate(task, registry);
      if (match && match.score > 0.3) {
        res.json({
          sourceTaskId: match.template.sourceTaskId,
          category: match.template.category,
          successRate: match.template.successRate,
          avgCostUsd: match.template.avgCostUsd,
          score: match.score,
          matchReasons: match.matchReasons,
        });
      } else {
        res.json(null);
      }
    } catch {
      // Template matching is optional - return null on any error
      res.json(null);
    }
  });

  app.get("/api/tasks/:id/advisory", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const p = resolveProject(req);

    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Project not configured" });
      return;
    }

    try {
      const { getGateAdvisory } = await import("../analytics/gate-advisor.js");
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const advisory = getGateAdvisory(task, p.projectRoot);
      res.json({
        taskId,
        suggestedMinScore: advisory.suggestedMinScore,
        warnings: advisory.warnings,
        relevantPatterns: advisory.relevantPatterns,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get advisory: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/verify", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const p = resolveProject(req);

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    try {
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { runVerification } = await import("../worker/tools/verify.js");

      const authoritativeAdapter = await loadAdapter(p.projectRoot);

      // Check if task has active dispatch with worktree
      const job = p.dispatchManager?.getJob(taskId);
      const cwd = job?.worktreePath || authoritativeAdapter.projectRoot;

      // Run verification in the appropriate directory
      const adapterForCwd =
        cwd === authoritativeAdapter.projectRoot ? authoritativeAdapter : await loadAdapter(cwd);
      const verifyBody = req.body as { includeOptional?: boolean } | undefined;
      const includeOptional = verifyBody?.includeOptional !== false;
      const result = await runVerification(adapterForCwd, "all", {
        includeOptional,
        authoritativeAdapterBundle: authoritativeAdapter.adapterBundle,
      });

      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Verification failed: ${msg}` });
    }
  });

  const enrichmentCandidateSchema = z
    .object({
      source: z.string().trim().min(1).max(80),
      hostId: z.string().trim().min(1).max(120).optional(),
      branchName: z.string().trim().min(1).max(240).optional(),
      baseSpecHash: z.string().trim().min(1).max(128).optional(),
      candidateContent: z.string().min(1),
      summary: z.string().trim().max(2000).optional(),
      evidence: z.array(z.unknown()).default([]),
      applyMode: z.enum(["propose", "accept-if-better", "dry-run"]).default("propose"),
    })
    .passthrough();

  app.post("/v1/tasks/:id/enrichment-candidates", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const p = resolveProject(req);

    if (
      rejectNonCanonicalWrite(
        req,
        res,
        "enrichment_candidate",
        `/v1/tasks/${encodeURIComponent(taskId)}/enrichment-candidates`,
      )
    ) {
      return;
    }

    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Project not configured" });
      return;
    }

    const parsed = enrichmentCandidateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_enrichment_candidate_payload",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const body = parsed.data;
    const readiness = createReadinessService(p);
    if (!readiness) {
      res.status(500).json({ error: "Readiness service not configured" });
      return;
    }

    try {
      const taskFilePath =
        (await p.taskService.getTaskFilePath(taskId)) ??
        (await p.taskService.getRawTaskFilePath(taskId));
      if (!taskFilePath) {
        res.status(404).json({ error: `Task file for ${taskId} not found` });
        return;
      }

      const currentContent = await fsPromises.readFile(taskFilePath, "utf-8");
      const currentSpecHash = computeContentHash(currentContent);
      if (body.baseSpecHash && body.baseSpecHash !== currentSpecHash) {
        res.status(409).json({
          ok: false,
          error: "base_spec_hash_mismatch",
          taskId,
          submittedBaseSpecHash: body.baseSpecHash,
          currentSpecHash,
        });
        return;
      }

      const decision = evaluateEnrichmentCandidate(currentContent, body.candidateContent);
      const provenanceSource = `external_enrichment_candidate:${body.source}`;
      const deficiencies = [
        ...decision.blockers,
        ...decision.warnings.map((warning) => `warning:${warning}`),
      ];

      if (body.applyMode === "dry-run") {
        res.json({
          ok: true,
          taskId,
          applyMode: body.applyMode,
          source: body.source,
          hostId: body.hostId,
          branchName: body.branchName,
          summary: body.summary,
          evidence: body.evidence,
          currentSpecHash,
          candidateSpecHash: computeContentHash(body.candidateContent),
          decision,
          persisted: false,
          applied: false,
          authority,
        });
        return;
      }

      if (body.applyMode === "propose") {
        const record = readiness.persistEffectiveSpec({
          taskId,
          baseSpecContent: currentContent,
          effectiveContent: body.candidateContent,
          status: "proposed",
          source: provenanceSource,
          deficiencies,
        });
        res.json({
          ok: true,
          taskId,
          applyMode: body.applyMode,
          source: body.source,
          hostId: body.hostId,
          branchName: body.branchName,
          summary: body.summary,
          evidence: body.evidence,
          currentSpecHash,
          baseSpecHash: record.baseSpecHash,
          effectiveSpecHash: record.effectiveSpecHash,
          decision,
          persisted: true,
          applied: false,
          authority,
        });
        return;
      }

      if (!decision.accepted) {
        const record = readiness.persistEffectiveSpec({
          taskId,
          baseSpecContent: currentContent,
          effectiveContent: body.candidateContent,
          status: "rejected",
          source: provenanceSource,
          deficiencies,
        });
        res.status(422).json({
          ok: false,
          taskId,
          applyMode: body.applyMode,
          source: body.source,
          hostId: body.hostId,
          branchName: body.branchName,
          summary: body.summary,
          evidence: body.evidence,
          currentSpecHash,
          baseSpecHash: record.baseSpecHash,
          effectiveSpecHash: record.effectiveSpecHash,
          decision,
          persisted: true,
          applied: false,
          authority,
        });
        return;
      }

      let allowedTargetBranches: string[] = [];
      try {
        const adapter = await loadAdapter(p.projectRoot);
        allowedTargetBranches = [
          adapter.config.git.autoMergeTarget ?? adapter.config.git.baseBranch,
          adapter.config.git.baseBranch,
        ].filter((branch, index, branches) => branch && branches.indexOf(branch) === index);
      } catch {
        allowedTargetBranches = [];
      }
      const gitPrecheck = inspectCanonicalTaskSpecGitTarget(p.projectRoot, allowedTargetBranches);
      if (!gitPrecheck.ok) {
        res.status(409).json({
          ok: false,
          error: "canonical_git_precondition_failed",
          taskId,
          applyMode: body.applyMode,
          decision,
          persisted: false,
          applied: false,
          git: gitPrecheck,
          authority,
        });
        return;
      }

      if (await rejectDuplicateClaimantWrite(p, taskId, res)) return;
      const tmpPath = `${taskFilePath}.tmp`;
      await fsPromises.writeFile(tmpPath, body.candidateContent, "utf-8");
      await fsPromises.rename(tmpPath, taskFilePath);

      const record = readiness.persistEffectiveSpec({
        taskId,
        baseSpecContent: currentContent,
        effectiveContent: body.candidateContent,
        status: "accepted",
        source: provenanceSource,
        deficiencies,
      });

      const prepInvalidated = p.prepCache ? await p.prepCache.invalidate(taskId) : false;
      const preflightInvalidated = p.prepCache
        ? await p.prepCache.invalidatePreflight(taskId)
        : false;
      p.db.invalidatePrep(taskId);
      const git = commitCanonicalTaskSpecChange(p.projectRoot, taskId, taskFilePath);

      sse.broadcast({
        sessionId: "enrichment-candidates",
        taskId,
        project: p.projectId,
        timestamp: new Date().toISOString(),
        stage: "enrichment_candidate_accepted" as never,
        payload: {
          taskId,
          source: body.source,
          hostId: body.hostId,
          branchName: body.branchName,
          filePath: taskFilePath,
          baseSpecHash: record.baseSpecHash,
          effectiveSpecHash: record.effectiveSpecHash,
          score: decision.score,
          git,
        } as never,
      });

      res.json({
        ok: true,
        taskId,
        applyMode: body.applyMode,
        source: body.source,
        hostId: body.hostId,
        branchName: body.branchName,
        summary: body.summary,
        evidence: body.evidence,
        filePath: taskFilePath,
        currentSpecHash,
        baseSpecHash: record.baseSpecHash,
        effectiveSpecHash: record.effectiveSpecHash,
        decision,
        persisted: true,
        applied: true,
        readinessInvalidated: {
          prep: prepInvalidated,
          preflight: preflightInvalidated,
          dbPrep: true,
        },
        git,
        authority,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to process enrichment candidate: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/enrich", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const p = resolveProject(req);

    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Project not configured" });
      return;
    }

    try {
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { runReadinessGate } = await import("../gate/gate.js");
      const { ENRICHMENT_TIMEOUT_MS } = await import("../gate/enrichment-agent.js");

      const adapter = await loadAdapter(p.projectRoot);
      // TASK-1334: ONE resolution, carried through to the write below. This
      // route used to call `getTask` here and then re-select the file by
      // filename prefix at write time, so it enriched the PARENT and
      // overwrote a SUBTASK with the result, leaving the parent unchanged
      // while reporting success.
      const bundle = await p.taskService.getTaskBundle(taskId);
      const task = bundle?.task ?? null;

      if (!task || !bundle) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      // Keep the public enrich route aligned with the agent's longer timeout budget.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(`Enrichment timed out after ${Math.floor(ENRICHMENT_TIMEOUT_MS / 1000)}s`),
            ),
          ENRICHMENT_TIMEOUT_MS,
        );
        timeoutHandle.unref?.();
      });

      let gateResult;
      try {
        gateResult = await Promise.race([runReadinessGate(task, adapter), timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      if (gateResult.outcome === "pass") {
        res.json({ outcome: "pass", gateScore: 4.0 });
      } else if (gateResult.outcome === "enriched") {
        const enrichedTask = gateResult.task;
        // TASK-907: by default the enriched spec is persisted to disk so the
        // operator workflow `preflight → enrich → re-preflight → dispatch`
        // works without a manual `cp`. Pass `dryRun: true` to get a preview
        // (proposal cached, file not modified).
        const body = req.body as Record<string, unknown> | undefined;
        const dryRun = body?.dryRun === true || body?.autoApprove === false;
        const persist = !dryRun;
        let writtenPath: string | undefined;
        let approvalStatus: "proposed" | "accepted" = "proposed";
        let writeError: string | undefined;

        const { extractSpecBody } = await import("../gate/enrichment-agent.js");
        const cleanedBody = extractSpecBody(enrichedTask.enriched.rawContent);

        let gitOutcome: CanonicalTaskSpecCommitResult | undefined;

        if (persist) {
          if (cleanedBody === null) {
            // Unparseable LLM output — do NOT clobber the operator's spec.
            writeError =
              "Enriched content has no `# TASK-` heading; refusing to persist. Re-run /enrich or pass dryRun: true to preview.";
          } else {
            try {
              // TASK-1334: the file this run RESOLVED, not a fresh prefix
              // match. The old `entries.find(e => e.startsWith(taskId))`
              // selected a subtask for 12 parent ids in this repo and 81 in
              // example, and this is the write that made that destructive.
              const filePath: string | undefined = bundle.filePath;
              // TASK-1334: and the CONTENT must declare this task. A correct
              // target plus wrong content still lands `# TASK-999` inside
              // TASK-100's file, which resolving the path cannot prevent.
              // Round 2 (R2-2): three-way, same as the approve sibling. The
              // two-way wrapper let `# TASK-: no id` through, because
              // `extractSpecBody` above only proves the literal `# TASK-`
              // prefix exists, not that a parseable declaration follows.
              const declaredVerdict = classifyDeclaredId(cleanedBody, taskId);
              if (declaredVerdict.kind === "mismatch") {
                writeError =
                  `Enriched content declares ${declaredVerdict.declared}, not ${taskId}; refusing to persist. ` +
                  "Re-run /enrich or pass dryRun: true to preview.";
              } else if (declaredVerdict.kind === "unrecognized") {
                writeError =
                  `Enriched content has no parseable "# ${taskId}" heading; refusing to persist. ` +
                  "Re-run /enrich or pass dryRun: true to preview.";
              } else if (filePath) {
                if (await rejectDuplicateClaimantWrite(p, taskId, res)) return;
                // Atomic write: tmp + rename.
                const tmpPath = `${filePath}.tmp`;
                await fs.promises.writeFile(tmpPath, cleanedBody, "utf-8");
                await fs.promises.rename(tmpPath, filePath);
                writtenPath = filePath;
                approvalStatus = "accepted";

                // TASK-922: commit + push the enriched spec to the canonical
                // clone when adapter.config.enrichment.autoCommit.enabled is
                // true. Default is OFF — operator/laptop clones preserve
                // the prior write-only behavior unless they opt in.
                const autoCommit = adapter.config.enrichment?.autoCommit;
                if (autoCommit?.enabled === true) {
                  gitOutcome = commitCanonicalTaskSpecChange(
                    adapter.projectRoot,
                    taskId,
                    filePath,
                    {
                      commitMessage: autoCommit.commitMessageTemplate,
                      push: autoCommit.push,
                      skipBranches: autoCommit.skipBranches,
                    },
                  );
                }
              } else {
                writeError = `Could not locate spec file for ${taskId}`;
              }
            } catch (writeErr) {
              writeError = writeErr instanceof Error ? writeErr.message : String(writeErr);
            }
          }
        }

        createReadinessService(p)?.persistEffectiveSpec({
          taskId,
          baseSpecContent: enrichedTask.original.rawContent,
          effectiveContent: cleanedBody ?? enrichedTask.enriched.rawContent,
          status: approvalStatus,
          source: persist
            ? approvalStatus === "accepted"
              ? "monitor_enrich_auto_approve"
              : "monitor_enrich_persist_failed"
            : "monitor_enrich_preview",
          // TASK-922 follow-up: persist commit SHA when auto-commit succeeded
          // so audit queries can correlate this enrichment to a dev commit.
          // Omitted when commit was skipped or failed — COALESCE in the DB
          // upsert preserves any prior SHA.
          commitSha: gitOutcome?.committed ? gitOutcome.commitSha : undefined,
        });
        res.json({
          outcome: "enriched",
          enrichedContent: cleanedBody ?? enrichedTask.enriched.rawContent,
          diff: enrichedTask.diff,
          original: enrichedTask.original.rawContent,
          dryRun,
          persisted: writtenPath !== undefined,
          writtenPath,
          writeError,
          git: gitOutcome,
        });
      } else {
        res.json({
          outcome: "rejected",
          reason: gateResult.reason,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Enrichment failed: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/enrich/approve", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const p = resolveProject(req);

    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Project not configured" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    let content = typeof body?.content === "string" ? body.content : undefined;
    let contentSource: "request" | "cache" = "request";

    // Fall back to the most-recent "proposed" effective spec persisted
    // server-side by an earlier `/enrich` call. Closes the round-trip in
    // admin scripts that ran enrich first and want to approve without
    // re-sending the full enriched markdown.
    if (!content) {
      const cached = createReadinessService(p)?.getLatestProposedEffectiveSpec(taskId);
      if (cached) {
        content = cached.content;
        contentSource = "cache";
      }
    }

    if (!content) {
      res.status(400).json({
        error:
          "content is required in request body, OR call /enrich first to seed the proposed cache",
      });
      return;
    }

    try {
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const adapter = await loadAdapter(p.projectRoot);

      // TASK-1334: resolve ONCE, canonically, and reuse the bundle for both
      // the read and the write. The prefix match this replaces selected a
      // SUBTASK for 12 parent ids here and 81 in example, and this route both
      // reads the file as `originalContent` and overwrites it.
      const bundle = await p.taskService.getTaskBundle(taskId);
      if (!bundle) {
        res.status(404).json({ error: `Task file not found for ${taskId}` });
        return;
      }

      const filePath = bundle.filePath;
      const originalContent = bundle.content;

      // TASK-1334: the approved content must declare THIS task. Resolving the
      // target correctly does not stop content headed `# TASK-999` being
      // written into TASK-100's file.
      //
      // Round 1 (R3) made this route refuse UNRECOGNIZED content; round 2
      // (R2-2) extended the same refusal to the `/enrich` sibling, because
      // the old claim that `/enrich` rejects id-less bodies earlier was
      // wrong: `extractSpecBody` only proves the literal `# TASK-` prefix
      // exists somewhere, so `# TASK-: no id` passed it. Both routes now
      // fail closed on anything but a clean parser-equivalent match.
      const declared = classifyDeclaredId(content, taskId);
      if (declared.kind === "mismatch") {
        res.status(400).json({
          error: `Approved content declares ${declared.declared}, not ${taskId}; refusing to persist.`,
        });
        return;
      }
      if (declared.kind === "unrecognized") {
        res.status(400).json({
          error:
            `Approved content has no recognisable "# ${taskId}" heading; refusing to persist. ` +
            "The first heading must declare the task this spec is for.",
        });
        return;
      }

      // Write the enriched content to the task file.
      // TASK-1334: tmp + rename, matching the sibling enrich route. A direct
      // write leaves a truncated spec if the process dies mid-write, and this
      // route is the one an operator reaches by clicking approve.
      if (await rejectDuplicateClaimantWrite(p, taskId, res)) return;
      const approveTmpPath = `${filePath}.tmp`;
      await fs.promises.writeFile(approveTmpPath, content, "utf-8");
      await fs.promises.rename(approveTmpPath, filePath);

      // TASK-922: commit + push when adapter.config.enrichment.autoCommit
      // is enabled. Default OFF preserves the prior write-only behavior.
      // Done BEFORE persistEffectiveSpec so the resulting commit SHA can be
      // written onto the effective-spec DB row as audit metadata.
      let gitOutcome: CanonicalTaskSpecCommitResult | undefined;
      const autoCommit = adapter.config.enrichment?.autoCommit;
      if (autoCommit?.enabled === true) {
        gitOutcome = commitCanonicalTaskSpecChange(adapter.projectRoot, taskId, filePath, {
          commitMessage: autoCommit.commitMessageTemplate,
          push: autoCommit.push,
          skipBranches: autoCommit.skipBranches,
        });
      }

      const approvalRecord = createReadinessService(p)?.persistEffectiveSpec({
        taskId,
        baseSpecContent: originalContent,
        effectiveContent: content,
        status: "accepted",
        source:
          contentSource === "cache" ? "monitor_enrich_approve_cached" : "monitor_enrich_approve",
        // TASK-922 follow-up: thread commit SHA when the commit succeeded.
        commitSha: gitOutcome?.committed ? gitOutcome.commitSha : undefined,
      });

      res.json({
        ok: true,
        taskId,
        filePath,
        contentSource,
        baseSpecHash: approvalRecord?.baseSpecHash,
        effectiveSpecHash: approvalRecord?.effectiveSpecHash,
        git: gitOutcome,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to write enriched content: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/repair", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.projectRoot) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    try {
      const filePath = await p.taskService.getTaskFilePath(taskId);
      if (!filePath) {
        res.status(404).json({ error: `Task file for ${taskId} not found` });
        return;
      }

      const rawContent = await fs.promises.readFile(filePath, "utf-8");
      const { parseTaskFile: parse, TaskParseError: TPE } = await import("../core/task-parser.js");

      // Check if it already parses fine
      try {
        parse(rawContent, filePath);
        res.json({ ok: true, taskId, alreadyValid: true, message: "Task spec is already valid" });
        return;
      } catch (parseErr) {
        const parseError = parseErr instanceof TPE ? parseErr.message : String(parseErr);

        // Load adapter for conventions
        let adapter: ProjectAdapter;
        try {
          adapter = await loadAdapter(
            p.adapterPath ?? path.join(p.projectRoot, ".quack", "adapter.json"),
          );
        } catch {
          adapter = {
            config: {
              project: { name: "", taskDir: "" },
              agent: {},
              verification: { commands: [] },
            },
            conventionsDoc: "",
            projectRoot: p.projectRoot,
          } as unknown as ProjectAdapter;
        }

        const { repairTaskSpec } = await import("../gate/spec-repair-agent.js");
        const repaired = await repairTaskSpec(rawContent, filePath, parseError, adapter);

        // Validate the repaired content
        const repairedTask = parse(repaired, filePath);

        // Write back
        await fs.promises.writeFile(filePath, repaired, "utf-8");

        sse.broadcast({
          sessionId: "task-watcher",
          taskId: repairedTask.id,
          project: resolveProject(req).projectId,
          timestamp: new Date().toISOString(),
          stage: "task_repaired" as never,
          payload: { taskId: repairedTask.id, filePath } as never,
        });

        res.json({ ok: true, taskId: repairedTask.id, repaired: true, title: repairedTask.title });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to repair task: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/transcript", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const run = req.query.run as string | undefined;
    const attempt = req.query.attempt as string | undefined;

    if (!run) {
      res.status(400).json({ error: "Missing required query parameter: run" });
      return;
    }

    const attemptNum = attempt ? parseInt(attempt, 10) : 0;
    if (isNaN(attemptNum)) {
      res.status(400).json({ error: "Invalid attempt number" });
      return;
    }

    const resolvedLogDir = p.logDir ?? logDir;
    if (!resolvedLogDir) {
      res.status(404).json({ error: "Log directory not configured" });
      return;
    }

    const transcriptFile = `transcript-${run}-attempt-${attemptNum}.jsonl`;
    const transcriptPath = path.join(resolvedLogDir, transcriptFile);

    if (!fs.existsSync(transcriptPath)) {
      res.status(404).json({ error: "Transcript not found" });
      return;
    }

    const content = fs.readFileSync(transcriptPath, "utf-8");
    res.type("application/x-ndjson").send(content);
  });

  // â”€â”€â”€ Prep endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.post("/api/tasks/:id/prep", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepCache || !p.prepWorker || !p.taskService) {
      res.status(500).json({ error: "Prep not available (no project root)" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      // Validate task exists
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      // Check if already prepping
      const activeJob = p.prepWorker.getActiveJob(taskId);
      if (activeJob) {
        res.status(409).json({ error: `Task ${taskId} prep is already running` });
        return;
      }

      // Start prep job in background
      const job = p.prepWorker.start(taskId);

      // Return immediately - client will poll or receive SSE updates
      res.json({
        ok: true,
        taskId,
        pid: job.pid,
        message: `Prep started for ${taskId}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to start prep: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/prep", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    if (!readiness || !p.taskService) {
      res.status(404).json({ error: "Prep not available" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const state = await readiness.resolveCurrent(taskId);
      if (!state?.prep) {
        res.status(404).json({
          error: state?.hasStalePrep
            ? `Prep result for ${taskId} is stale for the current spec`
            : `No prep result for ${taskId}`,
          currentSpecHash: state?.currentSpecHash,
          stale: state?.hasStalePrep ?? false,
        });
        return;
      }

      res.json(state.prep);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read prep result: ${msg}` });
    }
  });

  app.delete("/api/tasks/:id/prep", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepCache) {
      res.status(404).json({ error: "Prep not available" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      const deleted = await p.prepCache.invalidate(taskId);
      if (deleted) {
        res.json({ ok: true, message: `Prep result cleared for ${taskId}` });
      } else {
        res.status(404).json({ error: `No prep result for ${taskId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to delete prep result: ${msg}` });
    }
  });

  // â”€â”€â”€ Blueprint approval endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/tasks/:id/blueprint", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { loadApproval } = await import("../dispatcher/blueprint-approval.js");

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const approval = await loadApproval(taskId, logDir);
      if (!approval) {
        res.status(404).json({ error: "Blueprint approval not found" });
        return;
      }
      // Include timeout status for pending approvals
      const { isApprovalExpired, DEFAULT_APPROVAL_TIMEOUT_MS } =
        await import("../dispatcher/blueprint-approval.js");
      const expired = isApprovalExpired(approval, DEFAULT_APPROVAL_TIMEOUT_MS);
      res.json({ ...approval, expired });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get blueprint approval: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/blueprint/approve", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.dispatchManager) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { loadApproval, updateApprovalState } =
      await import("../dispatcher/blueprint-approval.js");
    // TASK-1319: actor and reason arrive in the body. The literal
    // 'human' is gone: the server cannot identify a human from an
    // unauthenticated POST, and claiming one put a false attribution
    // into the audit trail.
    const { actor, reason } = req.body as { actor?: string; reason?: string };

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const approval = await loadApproval(taskId, logDir);
      if (!approval) throw new Error(`No pending approval found for task ${taskId}`);
      const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
      if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;
      const decided = await updateApprovalState(taskId, "approved", logDir, undefined, undefined, {
        ...(actor ? { actor } : {}),
        ...(reason ? { reason } : {}),
        mode: advisoryOverrideMode(p),
      });
      broadcastAdvisoryOverride(taskId, decided);

      // Emit SSE event
      sse.broadcast({
        sessionId: "approval",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "blueprint_approved",
        payload: {
          taskId,
          approvedBy: decided.override?.actor ?? actor ?? "unattributed",
        } as never,
      });

      // Resume dispatch with resume flag so dispatcher skips completed stages
      p.dispatchManager.start(
        taskId,
        {
          resume: true,
          provenance: startProvenance(req),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );

      res.json({ ok: true, message: "Blueprint approved, dispatch resuming" });
    } catch (err: unknown) {
      if (respondIfAdvisoryOverrideRequired(res, err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to approve blueprint: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/blueprint/reject", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { rejectionReason } = req.body as { rejectionReason?: string };
    const { updateApprovalState } = await import("../dispatcher/blueprint-approval.js");

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      await updateApprovalState(taskId, "rejected", logDir, undefined, rejectionReason);

      // Emit SSE event
      sse.broadcast({
        sessionId: "approval",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "blueprint_rejected",
        payload: { taskId, rejectionReason: rejectionReason ?? "No reason provided" } as never,
      });

      res.json({ ok: true, message: "Blueprint rejected" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to reject blueprint: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/blueprint/replan", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.prepCache) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { updateApprovalState } = await import("../dispatcher/blueprint-approval.js");

    try {
      const logDirPath = resolveTaskRuntimeLogDir(
        p.projectRoot,
        p.dispatchManager,
        taskId,
        p.logDir,
      );
      await updateApprovalState(taskId, "rejected", logDirPath, undefined, "Requested re-plan");

      // Invalidate preflight cache to force new blueprint generation
      await p.prepCache.invalidate(taskId);
      await p.prepCache.invalidatePreflight(taskId);

      // Emit SSE event
      sse.broadcast({
        sessionId: "approval",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "blueprint_rejected",
        payload: { taskId, rejectionReason: "Re-plan requested" } as never,
      });

      // Automatically trigger new preflight run if task service is available
      if (p.taskService) {
        try {
          const { loadAdapter } = await import("../core/adapter-loader.js");
          const { resolveTaskFile } = await import("../core/task-file-resolver.js");
          const { runPreflight } = await import("../preflight/preflight-runner.js");
          const adapter = await loadAdapter(p.projectRoot);
          const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
          const resolved = await resolveTaskFile(taskDir, taskId);
          if (resolved?.task) {
            const parsedTask = resolved.task;

            const { createNoOpWriter } = await import("./event-emitter.js");
            let eventWriter = createNoOpWriter();
            if (p.logDir) {
              const { EventWriter } = await import("./event-emitter.js");
              eventWriter = new EventWriter({
                sessionId: "preflight-replan",
                taskId,
                project: p.projectId,
                logDir: p.logDir,
              });
            }
            const originalEmit = eventWriter.emit.bind(eventWriter);
            eventWriter.emit = (stage, payload) => {
              originalEmit(stage, payload);
              sse.broadcast({
                sessionId: "preflight-replan",
                taskId,
                project: p.projectId,
                timestamp: new Date().toISOString(),
                stage: stage as never,
                payload: payload as never,
              });
            };

            // Run preflight asynchronously, then emit SSE events on completion or failure.
            runPreflight(parsedTask, adapter, { force: true, events: eventWriter })
              .then(async () => {
                // Clear the rejected approval after a successful preflight.
                try {
                  const approvalPath = path.join(logDirPath, "approvals", `${taskId}.json`);
                  await fsPromises.unlink(approvalPath);
                } catch {
                  // ok if already gone
                }

                sse.broadcast({
                  sessionId: "approval",
                  taskId,
                  project: currentProjectId(),
                  timestamp: new Date().toISOString(),
                  stage: "blueprint_replan_complete" as never,
                  payload: { taskId } as never,
                });
              })
              .catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`Re-plan preflight failed for ${taskId}: ${errMsg}`);
                sse.broadcast({
                  sessionId: "approval",
                  taskId,
                  project: currentProjectId(),
                  timestamp: new Date().toISOString(),
                  stage: "blueprint_replan_failed" as never,
                  payload: { taskId, error: errMsg } as never,
                });
              });
          }
        } catch (err: unknown) {
          // Non-fatal: replan state update succeeded, just auto-preflight setup failed
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`Auto-preflight after replan failed for ${taskId}: ${errMsg}`);
          sse.broadcast({
            sessionId: "approval",
            taskId,
            project: currentProjectId(),
            timestamp: new Date().toISOString(),
            stage: "blueprint_replan_failed" as never,
            payload: { taskId, error: errMsg } as never,
          });
        }
      }

      res.json({
        ok: true,
        message:
          "Blueprint rejected, new preflight triggered. Listen for blueprint_replan_complete/blueprint_replan_failed SSE events for status.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to replan blueprint: ${msg}` });
    }
  });

  // â”€â”€â”€ Judge review endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/tasks/:id/judge-review", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { loadJudgeApproval } = await import("../dispatcher/judge-approval.js");

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const approval = await loadJudgeApproval(taskId, logDir);
      if (!approval) {
        res.status(404).json({ error: "Judge approval not found" });
        return;
      }
      // Include timeout status for pending approvals
      const { isApprovalExpired, DEFAULT_APPROVAL_TIMEOUT_MS } =
        await import("../dispatcher/judge-approval.js");
      const expired = isApprovalExpired(approval, DEFAULT_APPROVAL_TIMEOUT_MS);
      res.json({ ...approval, expired });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get judge approval: ${msg}` });
    }
  });

  /**
   * TASK-1329 / QPI-041: did THIS run pause at a human gate, or did it die?
   *
   * Exists because the federation listener is a standalone `.mjs` script with no
   * shared runtime import, and round-1 R1-5 ruled out teaching it to load the
   * TypeScript reader. It already speaks HTTP to this monitor for everything
   * else, so the run-scoped answer is served here, where the reader works.
   *
   * `runStartedAt` is REQUIRED and deliberately has no default. Attribution
   * without a run boundary is the fail-OPEN direction: an unrelated pend left by
   * an earlier run would let a genuinely crashed dispatch be reported as
   * "waiting on a human", which is QPI-041's lie with the sign flipped. Refusing
   * is the safe answer; guessing is not.
   */
  app.get("/api/tasks/:id/pause-state", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const runStartedAt =
      typeof req.query.runStartedAt === "string" ? req.query.runStartedAt : undefined;
    if (!runStartedAt) {
      res.status(400).json({
        error: "runStartedAt is required",
        detail:
          "A pause can only be attributed to a specific run. Without a run " +
          "boundary an older pend could mask a crash as a pause.",
      });
      return;
    }

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const paused = resolveRunScopedPauseState(logDir, taskId, runStartedAt);
      res.json(
        paused
          ? {
              paused: true,
              gate: paused.gate,
              createdAt: paused.createdAt,
              approvalFile: paused.approvalFile,
            }
          : { paused: false },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to resolve pause state: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/judge/approve", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.dispatchManager) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { loadJudgeApproval, updateJudgeApprovalState } =
      await import("../dispatcher/judge-approval.js");
    // TASK-1319: see the blueprint handler. Same contract, same reason.
    const { actor, reason } = req.body as { actor?: string; reason?: string };

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const approval = await loadJudgeApproval(taskId, logDir);
      if (!approval) throw new Error(`No pending judge approval found for task ${taskId}`);
      const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
      if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;
      const decided = await updateJudgeApprovalState(
        taskId,
        "approved",
        logDir,
        undefined,
        undefined,
        {
          ...(actor ? { actor } : {}),
          ...(reason ? { reason } : {}),
          mode: advisoryOverrideMode(p),
        },
      );
      broadcastAdvisoryOverride(taskId, decided);

      // Emit SSE event
      sse.broadcast({
        sessionId: "approval",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "judge_approved",
        payload: {
          taskId,
          approvedBy: decided.override?.actor ?? actor ?? "unattributed",
        } as never,
      });

      // Resume dispatch with resume flag so dispatcher skips completed stages
      p.dispatchManager.start(
        taskId,
        {
          resume: true,
          provenance: startProvenance(req),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );

      res.json({ ok: true, message: "Judge review approved, dispatch resuming" });
    } catch (err: unknown) {
      if (respondIfAdvisoryOverrideRequired(res, err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to approve judge review: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/judge/reject", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.dispatchManager) {
      res.status(500).json({ error: "Project not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const { rejectionReason } = req.body as { rejectionReason?: string };
    const { loadJudgeApproval, updateJudgeApprovalState, deleteJudgeApproval } =
      await import("../dispatcher/judge-approval.js");

    try {
      const logDir = resolveTaskRuntimeLogDir(p.projectRoot, p.dispatchManager, taskId, p.logDir);
      const approval = await loadJudgeApproval(taskId, logDir);
      if (!approval) {
        await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, rejectionReason);
        return;
      }
      const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
      if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;
      await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, rejectionReason);

      // Emit SSE event
      sse.broadcast({
        sessionId: "approval",
        taskId,
        project: currentProjectId(),
        timestamp: new Date().toISOString(),
        stage: "judge_rejected",
        payload: { taskId, rejectionReason: rejectionReason ?? "No reason provided" } as never,
      });

      const reviewFeedback = formatLoopReviewFeedback(approval?.review);
      const feedback = [
        rejectionReason ??
          "Changes rejected during judge review. Please review the feedback and try again.",
        reviewFeedback,
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      let resuming = false;
      if (approval?.executionMode === "loop") {
        const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
        const checkpointMgr = new CheckpointManager(logDir);
        const rewound = await checkpointMgr.rewindFrom(taskId, "agent");
        resuming = Boolean(rewound?.claudeSessionId && checkpointMgr.isUsable(rewound));
      }

      // The evidence has been formatted above; the next attempt writes a fresh record.
      await deleteJudgeApproval(taskId, logDir);

      const loopRevision = approval?.executionMode === "loop";
      const startOptions = loopRevision
        ? {
            judgeFeedback: feedback,
            reuseWorktree: true,
            ...(resuming ? { resume: true } : {}),
            provenance: startProvenance(req),
            duplicateClaimantCheck: claimantCheck,
          }
        : {
            judgeFeedback: feedback,
            provenance: startProvenance(req),
            duplicateClaimantCheck: claimantCheck,
          };
      p.dispatchManager.start(taskId, startOptions, claimantCheck);

      res.json({
        ok: true,
        resuming: loopRevision ? resuming : undefined,
        fallback: loopRevision && !resuming ? "fresh-session-reused-worktree" : undefined,
        message: "Judge review rejected, re-dispatching agent with feedback",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to reject judge review: ${msg}` });
    }
  });

  // â”€â”€â”€ Pre-flight endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.post("/api/tasks/:id/preflight", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.taskService) {
      res.status(500).json({ error: "Preflight not available (no project root)" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      // Run preflight in the request handler (it's I/O-bound, not blocking)
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { runPreflight } = await import("../preflight/preflight-runner.js");

      const adapter = await loadAdapter(p.projectRoot);

      const force = (req.body as Record<string, unknown> | undefined)?.force === true;

      // Create event writer for SSE broadcasts (if logDir exists)
      const { createNoOpWriter } = await import("./event-emitter.js");
      let eventWriter = createNoOpWriter();
      if (p.logDir) {
        const { EventWriter } = await import("./event-emitter.js");
        eventWriter = new EventWriter({
          sessionId: "preflight",
          taskId,
          project: p.projectId,
          logDir: p.logDir,
        });
      }

      // Wrap emitter to also broadcast via SSE
      const originalEmit = eventWriter.emit.bind(eventWriter);
      eventWriter.emit = (stage, payload) => {
        originalEmit(stage, payload);
        sse.broadcast({
          sessionId: "preflight",
          taskId,
          project: p.projectId,
          timestamp: new Date().toISOString(),
          stage: stage as never,
          payload: payload as never,
        });
      };

      const result = await runPreflight(task, adapter, { force, events: eventWriter });

      const preflightRefusal = result.decomposition?.refused;
      if (preflightRefusal?.errorType === "duplicate_claimants") {
        const claimants = preflightRefusal.claimants;
        res.status(409).json({
          ok: false,
          error: "duplicate_claimants",
          taskId,
          claimants,
          message: formatDuplicateClaimantsMessage(taskId, claimants),
        });
        return;
      }

      // Note: preflight_complete is already broadcast by the wrapped eventWriter
      // (runPreflight emits all 5 stages: start, gate, blueprint, analysis, complete)

      res.json({ ok: true, taskId, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to run preflight: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/preflight", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    if (!readiness || !p.taskService) {
      res.status(404).json({ error: "Preflight not available" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const state = await readiness.resolveCurrent(taskId);
      if (!state?.preflight) {
        res.status(404).json({
          error: state?.hasStalePreflight
            ? `Preflight result for ${taskId} is stale for the current spec`
            : `No preflight result for ${taskId}`,
          currentSpecHash: state?.currentSpecHash,
          stale: state?.hasStalePreflight ?? false,
        });
        return;
      }

      res.json(state.preflight);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read preflight result: ${msg}` });
    }
  });

  app.get("/v1/tasks/:id/readiness", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const readiness = createReadinessService(p);
    if (!readiness || !p.taskService) {
      res.status(404).json({ error: "Readiness not available" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const state = await readiness.resolveCurrent(taskId);
      if (!state) {
        res.status(404).json({ error: `Readiness unavailable for ${taskId}` });
        return;
      }

      res.json(state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to resolve readiness: ${msg}` });
    }
  });

  // â”€â”€ Task Decomposition API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.post("/api/tasks/:id/decompose", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.taskService) {
      res.status(500).json({ error: "Decompose not available (no project root)" });
      return;
    }

    const taskId = req.params.id as string;
    const body = (req.body as Record<string, unknown> | undefined) ?? {};

    // Reject old approve:true callers with a structured error pointing to staged flow
    if (body.approve === true) {
      res.status(400).json({
        ok: false,
        refusalCode: "DECOMPOSE_REVIEW_REQUIRED",
        refusalMessage:
          "The approve:true path has been replaced by the staged decomposition workflow. " +
          "Use mode=plan, then mode=materialize, then mode=finalize with reviewAcknowledged:true.",
      });
      return;
    }

    // Determine mode (map legacy dryRun:true → plan for backward compat)
    let mode = (body.mode as string | undefined) ?? "plan";
    if (body.dryRun === true) mode = "plan";
    if (!["plan", "materialize", "finalize"].includes(mode)) {
      res.status(400).json({
        ok: false,
        refusalCode: "DECOMPOSE_REVIEW_REQUIRED",
        refusalMessage: `Invalid mode '${mode}'. Use plan, materialize, or finalize.`,
      });
      return;
    }

    try {
      // TASK-1334 slice 1 round 1 (S1-R1): ONE resolution for the whole
      // route. This handler used to resolve the parent here, DISCARD it, and
      // then prefix-select a child below, so `plan` and `materialize` built
      // drafts from the child while `finalize` rewrote the canonical PARENT as
      // DECOMPOSED. I converted the CLI twin of this route in slice 1 and did
      // not check the HTTP one.
      const bundle = await p.taskService.getTaskBundle(taskId);
      const task = bundle?.task ?? null;
      if (!task || !bundle) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      // Load adapter and parse task
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { decomposeTask } = await import("../preflight/task-decomposer.js");
      const { materializeChildDrafts } = await import("../preflight/subtask-materializer.js");
      const { writeSubtaskSpecs } = await import("../preflight/subtask-writer.js");
      const { generateBlueprint } = await import("../blueprint/blueprint-agent.js");
      const { parseTaskFile } = await import("../core/task-parser.js");
      const { DECOMPOSE_REFUSAL_CODES } = await import("../preflight/decompose-types.js");
      const fsSync = await import("node:fs/promises");

      const adapter = await loadAdapter(p.projectRoot);
      // TASK-1334 (S1-R1): the file this route already resolved, not a fresh
      // prefix match. `parseTaskFile` is kept only as the fallback for a spec
      // that does not parse, which is the one case the bundle carries no task
      // for; the PATH and the CONTENT always come from the single resolution.
      // The `taskDir` this used to compute is gone with the prefix scan: the
      // resolver owns directory resolution now.
      const filePath = bundle.filePath;
      const content = bundle.content;
      const parsedTask = bundle.task ?? parseTaskFile(content, filePath);

      // ── MODE: plan ────────────────────────────────────────────────────────
      if (mode === "plan") {
        const blueprint = await generateBlueprint(parsedTask, adapter);
        const maxSubtasks = body.maxSubtasks as number | undefined;
        const topology = await decomposeTask(parsedTask, adapter, blueprint, { maxSubtasks });

        // Attach parentReadiness metrics from prep cache if available
        if (p.prepCache) {
          const parentPrep = await p.prepCache.read(taskId, filePath);
          if (parentPrep) {
            topology.parentReadiness = {
              score: parentPrep.depthScore,
              ready: parentPrep.depthReady,
              deficiencies: parentPrep.deficiencies,
            };
          } else {
            topology.parentReadiness = {
              score: 0,
              ready: false,
              deficiencies: ["No prep result found — run prep on the parent task"],
            };
          }
        }

        const subtaskIds = topology.subtasks.map((s) => s.id);
        sse.broadcast({
          sessionId: "decompose",
          taskId,
          project: p.projectId,
          timestamp: new Date().toISOString(),
          stage: "task_decomposed",
          payload: { taskId, subtaskCount: topology.subtasks.length, subtaskIds, mode: "plan" },
        });

        res.json({
          ok: true,
          mode: "plan",
          taskId,
          topology,
          subtaskIds,
          coverageReport: topology.coverageReport,
          parentReadiness: topology.parentReadiness,
        });
        return;
      }

      // ── MODE: materialize ─────────────────────────────────────────────────
      if (mode === "materialize") {
        type TopologyType = import("../preflight/decompose-types.js").DecompositionTopology;
        let topology: TopologyType;
        const incomingPlan = body.plan as TopologyType | undefined;
        if (incomingPlan?.subtasks) {
          topology = incomingPlan;
        } else {
          const blueprint = await generateBlueprint(parsedTask, adapter);
          const maxSubtasks = body.maxSubtasks as number | undefined;
          topology = await decomposeTask(parsedTask, adapter, blueprint, { maxSubtasks });
        }

        const blueprint = await generateBlueprint(parsedTask, adapter);
        const drafts = await materializeChildDrafts(topology, parsedTask, adapter, blueprint);

        const subtaskIds = topology.subtasks.map((s) => s.id);
        sse.broadcast({
          sessionId: "decompose",
          taskId,
          project: p.projectId,
          timestamp: new Date().toISOString(),
          stage: "task_decomposed",
          payload: {
            taskId,
            subtaskCount: topology.subtasks.length,
            subtaskIds,
            mode: "materialize",
          },
        });

        res.json({ ok: true, mode: "materialize", taskId, topology, drafts, subtaskIds });
        return;
      }

      // ── MODE: finalize ────────────────────────────────────────────────────
      if (mode === "finalize") {
        // Gate 1: review acknowledgment
        if (body.reviewAcknowledged !== true) {
          res.status(400).json({
            ok: false,
            mode: "finalize",
            taskId,
            refusalCode: DECOMPOSE_REFUSAL_CODES.REVIEW_REQUIRED,
            refusalMessage:
              "You must set reviewAcknowledged:true after reviewing child drafts and prep scores.",
          });
          return;
        }

        // Gate 2: parent readiness — parent must have a passing prep score
        if (p.prepCache) {
          const parentPrep = await p.prepCache.read(taskId, filePath);
          const parentThreshold =
            adapter.config.preflight?.autoDecompose?.parentPrepThreshold ?? 4.0;
          if (!parentPrep) {
            res.status(400).json({
              ok: false,
              mode: "finalize",
              taskId,
              refusalCode: DECOMPOSE_REFUSAL_CODES.PARENT_NOT_READY,
              refusalMessage: `Parent task ${taskId} has no prep result. Run prep on the parent before finalizing decomposition.`,
              parentReadiness: { score: 0, ready: false, deficiencies: ["No prep result found"] },
            });
            return;
          }
          if (parentPrep.depthScore < parentThreshold || !parentPrep.depthReady) {
            res.status(400).json({
              ok: false,
              mode: "finalize",
              taskId,
              refusalCode: DECOMPOSE_REFUSAL_CODES.PARENT_NOT_READY,
              refusalMessage: `Parent task ${taskId} prep score ${parentPrep.depthScore} is below threshold ${parentThreshold}.`,
              parentReadiness: {
                score: parentPrep.depthScore,
                ready: false,
                deficiencies: parentPrep.deficiencies,
              },
            });
            return;
          }
        }

        // Gate 3: drafts must be provided
        type ChildDraftType = import("../preflight/decompose-types.js").ChildDraft;
        const rawDrafts = body.drafts as ChildDraftType[] | undefined;
        if (!rawDrafts || rawDrafts.length === 0) {
          res.status(400).json({
            ok: false,
            mode: "finalize",
            taskId,
            refusalCode: DECOMPOSE_REFUSAL_CODES.DRAFT_INVALID,
            refusalMessage:
              "No child drafts provided. Run mode=materialize first and pass the drafts array.",
          });
          return;
        }

        const { PREP_THRESHOLD } = await import("../preflight/subtask-quality-gate.js");

        // Gate 4: check parse errors and prep scores
        const failedDrafts = rawDrafts.filter((d) => d.parseError || !d.prepReady);
        if (failedDrafts.length > 0) {
          const failInfo = failedDrafts.map((d) => ({
            subtaskId: d.subtaskId,
            parseError: d.parseError,
            prepScore: d.prepScore,
            prepThreshold: PREP_THRESHOLD,
            deficiencies: d.deficiencies,
          }));
          const refusalCode = failedDrafts.some((d) => d.parseError)
            ? DECOMPOSE_REFUSAL_CODES.DRAFT_INVALID
            : DECOMPOSE_REFUSAL_CODES.DRAFT_BELOW_THRESHOLD;
          res.status(400).json({
            ok: false,
            mode: "finalize",
            taskId,
            refusalCode,
            refusalMessage: `${failedDrafts.length} child draft(s) failed quality gates.`,
            failedDrafts: failInfo,
          });
          return;
        }

        // Gate 5: coverage report must be clean (if topology provided)
        type CoverageType = import("../preflight/decompose-types.js").CoverageReport;
        type TopologyType = import("../preflight/decompose-types.js").DecompositionTopology;
        const rawTopology = body.plan as TopologyType | undefined;
        if (rawTopology) {
          const coverageReport = rawTopology.coverageReport as CoverageType | undefined;
          if (coverageReport?.hasCoverageGap) {
            res.status(400).json({
              ok: false,
              mode: "finalize",
              taskId,
              refusalCode: DECOMPOSE_REFUSAL_CODES.COVERAGE_GAP,
              refusalMessage:
                "Coverage gap detected — not all parent files or criteria are mapped.",
              unmappedFiles: coverageReport.unmappedFiles,
              unmappedCriteria: coverageReport.unmappedCriteria,
            });
            return;
          }
        }

        // Write child files
        if (await rejectDuplicateClaimantWrite(p, taskId, res)) return;
        let writtenPaths: string[] = [];
        try {
          writtenPaths = await writeSubtaskSpecs(rawDrafts, adapter);
        } catch (writeErr: unknown) {
          const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          if (writeMsg.includes("in progress")) {
            res.status(409).json({
              ok: false,
              mode: "finalize",
              taskId,
              refusalCode: DECOMPOSE_REFUSAL_CODES.WRITE_LOCKED,
              refusalMessage: writeMsg,
            });
            return;
          }
          throw writeErr;
        }

        // Rewrite parent as decomposition tracker.
        // TASK-1334 (S1-R1): the file THIS ROUTE resolved, not a second
        // independent `getTaskFilePath` call. The drafts above were built from
        // `parsedTask`; rewriting a file resolved separately is how "built
        // from one spec, applied to another" happened, and resolving correctly
        // twice is still resolving twice.
        let parentStatusUpdated = false;
        const parentTaskPath = bundle.filePath;
        if (parentTaskPath) {
          // Round 2 (R2-1): the resolution's own content, not a re-read at
          // write time.
          const parentContent = bundle.content;
          const childIds = rawDrafts.map((d) => d.subtaskId);

          // Build Decomposition Summary table
          const tableRows = rawDrafts
            .map((d) => {
              const deps = rawTopology?.subtasks
                ? (rawTopology.subtasks.find((s) => s.id === d.subtaskId)?.dependsOn ?? [])
                : [];
              return `| \`${d.subtaskId}\` | ${d.title} | ${deps.length > 0 ? deps.join(", ") : "\u2014"} | prep ${d.prepScore} |`;
            })
            .join("\n");

          const decompositionSummary =
            `\n\n## Decomposition Summary\n\n` +
            `This task has been decomposed into ${childIds.length} child task(s). ` +
            `It is now a tracker task and should not be dispatched directly while the child chain is active.\n\n` +
            `| Child | Scope | Depends On | Ready Gate |\n` +
            `|-------|-------|------------|------------|\n` +
            tableRows;

          let updatedParent = parentContent
            .replace(/(\*\*Status:\*\*\s*)\S+/, "$1DECOMPOSED")
            .replace(/(\*\*Blocks:\*\*\s*)\[.*?\]/, `$1[${childIds.join(", ")}]`);

          if (!updatedParent.includes("## Decomposition Summary")) {
            updatedParent += decompositionSummary;
          }

          if (updatedParent !== parentContent) {
            await fsSync.default.writeFile(parentTaskPath, updatedParent, "utf-8");
            p.db.setStatus(taskId, "DECOMPOSED", "decompose");
            parentStatusUpdated = true;
          }
        }

        // Optionally enqueue children
        let enqueuedItems: Array<{ taskId: string; status: string }> = [];
        let enqueueRefusals: DuplicateClaimantRefusal[] = [];
        const enqueue = body.enqueue === true;
        if (enqueue && p.dispatchQueue) {
          try {
            const subtaskIds = rawDrafts.map((draft) => draft.subtaskId);
            const claimantChecks = await p.dispatchQueue.scanEnqueueClaimants(subtaskIds);
            const items = p.dispatchQueue.enqueueSubtasks(
              {
                parentTaskId: taskId,
                subtasks: rawDrafts.map((d) => ({
                  id: d.subtaskId,
                  dependsOn: rawTopology?.subtasks
                    ? (rawTopology.subtasks.find((s) => s.id === d.subtaskId)?.dependsOn ?? [])
                    : [],
                })),
              },
              { provenance: startProvenance(req) },
              claimantChecks,
            );
            enqueuedItems = items.map((item) => ({ taskId: item.taskId, status: item.status }));
            enqueueRefusals = items.refusals;
          } catch (enqueueErr: unknown) {
            const enqMsg = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
            console.warn(`Failed to enqueue subtasks after finalize: ${enqMsg}`);
          }
        }

        const subtaskIds = rawDrafts.map((d) => d.subtaskId);
        sse.broadcast({
          sessionId: "decompose",
          taskId,
          project: p.projectId,
          timestamp: new Date().toISOString(),
          stage: "task_decomposed",
          payload: { taskId, subtaskCount: rawDrafts.length, subtaskIds, mode: "finalize" },
        });

        res.json({
          ok: true,
          mode: "finalize",
          taskId,
          subtaskIds,
          writtenPaths,
          enqueuedItems,
          enqueueRefusals,
          parentStatusUpdated,
        });
        return;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to decompose task: ${msg}` });
    }
  });

  app.get("/api/tasks/:id/subtasks", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.taskService || !p.reader) {
      res.status(500).json({ error: "Task service not available" });
      return;
    }

    const taskId = req.params.id as string;

    try {
      // Find subtasks by looking for TASK-NNN-A/B/C pattern
      const sessions = buildSessionMap(p.reader);
      const { tasks: allTasks } = await p.taskService.listTasks(sessions);

      const subtaskPattern = new RegExp(`^${taskId}-[A-Z]$`);
      const subtasks = allTasks.filter((t) => subtaskPattern.test(t.id));

      res.json({ ok: true, taskId, subtasks });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list subtasks: ${msg}` });
    }
  });

  // â”€â”€â”€ Auto-prep scheduler endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/prep/status", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepScheduler) {
      res.json({
        enabled: false,
        running: false,
        queueSize: 0,
        activePreps: 0,
        prepsThisHour: 0,
        maxPerHour: 20,
        costThisHour: 0,
        maxBudgetPerHour: 2.0,
        totalProcessed: 0,
      });
      return;
    }
    res.json(p.prepScheduler.getStatus());
  });

  app.post("/api/prep/start", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepScheduler) {
      res.status(500).json({ error: "Prep scheduler not available" });
      return;
    }
    try {
      await p.prepScheduler.start();
      res.json({ ok: true, message: "Auto-prep started" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to start auto-prep: ${msg}` });
    }
  });

  app.post("/api/prep/stop", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepScheduler) {
      res.status(500).json({ error: "Prep scheduler not available" });
      return;
    }
    p.prepScheduler.stop();
    res.json({ ok: true, message: "Auto-prep stopped" });
  });

  app.get("/api/prep/queue", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.prepScheduler) {
      res.json([]);
      return;
    }
    res.json(p.prepScheduler.getQueue());
  });

  // â”€â”€â”€ Dispatch endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function stringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  function headerString(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return stringField(value[0]);
    return stringField(value);
  }

  // TASK-1323: entry provenance for local dispatch starts. The channel
  // is derived from route + VERIFIED request facts only: the
  // listener-execution channel requires the caller's claimed federated
  // job to exist in the federation store, assigned to the claimed host
  // (round-2 F1 — the bare body-field claim is spoofable). The client's
  // claimed channel is recorded verbatim as an advisory hint and never
  // branched on. Principal is the session username when the auth
  // middleware attached one (round-2 F2 — sessions ride even on open
  // prefixes), else the honest unauthenticated marker until TASK-1302
  // authenticates this surface.
  function startProvenance(
    req: Request,
    fed?: { federatedJobId?: string; federatedWorkerStart?: boolean },
  ): JobProvenance {
    const claimed =
      stringField((req.body as Record<string, unknown> | undefined)?.claimedChannel) ??
      headerString(req, "x-quack-channel");
    const sessionUser = (req as AuthenticatedRequest).session?.username;
    return {
      channel: fed?.federatedWorkerStart ? "listener-execution" : "api-direct",
      principal: sessionUser ? `user:${sessionUser}` : "unauthenticated-local",
      ...(req.ip ? { remoteAddr: req.ip } : {}),
      ...(fed?.federatedWorkerStart && fed.federatedJobId
        ? { parentJobId: fed.federatedJobId }
        : {}),
      ...(claimed ? { claimedChannel: claimed } : {}),
    };
  }

  // TASK-1323 round-2 F1: a federated-worker start is honored only when
  // the claimed job VERIFIABLY exists, is bound to the claimed host, and
  // is in an active state — the claim alone previously bypassed the
  // swarm-mode dispatch block and would have mislabeled provenance.
  async function verifyFederatedStartClaim(
    projectRoot: string | undefined,
    federatedJobId: string | undefined,
    federatedHostId: string | undefined,
  ): Promise<boolean> {
    if (!projectRoot || !federatedJobId || !federatedHostId) return false;
    const record = await loadFederatedJob(projectRoot, federatedJobId);
    return Boolean(
      record &&
      record.hostId === federatedHostId &&
      ["assigned", "running", "verifying", "fixing"].includes(record.status),
    );
  }

  async function hasRegisteredFederatedListeners(
    projectRoot: string | undefined,
  ): Promise<boolean> {
    if (!projectRoot) return false;
    try {
      const listeners = await new ListenerRegistry(projectRoot).list();
      return listeners.some((listener) => listener.enabled !== false);
    } catch {
      return false;
    }
  }

  app.post("/api/tasks/:id/start", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.status(500).json({ error: "Dispatch not available (no project root)" });
      return;
    }
    if (!p.taskService) {
      res.status(500).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const body = req.body as Record<string, unknown> | undefined;
    const skipGate = body?.skipGate === true;
    const skipDepthOnly = body?.skipDepthOnly === true;
    const forceClean = body?.forceClean === true;
    // TASK-1326: body-only and strictly `true`. A header or a request
    // shape must never be able to authorize discarding a paused run
    // (the TASK-1323 F1 lesson: client-controlled shape is not
    // authority).
    const overridePausedRun = body?.overridePausedRun === true;
    const model = typeof body?.model === "string" ? body.model : undefined;
    const maxTurns = typeof body?.maxTurns === "number" ? body.maxTurns : undefined;
    const maxBudget = typeof body?.maxBudget === "number" ? body.maxBudget : undefined;
    const federatedJobId =
      stringField(body?.federatedJobId) ??
      stringField(body?.jobId) ??
      headerString(req, "x-quack-federated-job-id");
    const federatedHostId =
      stringField(body?.federatedHostId) ??
      stringField(body?.workerHostId) ??
      stringField(body?.hostId) ??
      headerString(req, "x-quack-worker-host-id") ??
      headerString(req, "x-quack-federated-host-id");
    const federatedHostAlias =
      stringField(body?.federatedHostAlias) ??
      stringField(body?.hostAlias) ??
      headerString(req, "x-quack-worker-host-alias");
    const federatedHostEndpoint =
      stringField(body?.federatedHostEndpoint) ??
      stringField(body?.hostEndpoint) ??
      headerString(req, "x-quack-worker-host-endpoint");
    const federatedLeaseId =
      stringField(body?.federatedLeaseId) ??
      stringField(body?.leaseId) ??
      headerString(req, "x-quack-federated-lease-id");
    const localSmokeOnly =
      body?.localSmokeOnly === true || headerString(req, "x-quack-local-smoke") === "true";
    const claimsFederatedStart = Boolean(federatedJobId && federatedHostId);
    const federatedWorkerStart =
      claimsFederatedStart &&
      (await verifyFederatedStartClaim(p.projectRoot, federatedJobId, federatedHostId));

    if (
      !localSmokeOnly &&
      !federatedWorkerStart &&
      (await hasRegisteredFederatedListeners(p.projectRoot))
    ) {
      res.status(409).json({
        ok: false,
        code: claimsFederatedStart
          ? "federated_claim_unverified"
          : "direct_dispatch_blocked_in_swarm_mode",
        error: claimsFederatedStart
          ? "Claimed federatedJobId/federatedHostId did not match an active job assigned to that host."
          : "Direct task dispatch is disabled while federated listeners are registered.",
        hint: 'Queue work through POST /v1/federation/queue. For an isolated platform smoke run, pass {"localSmokeOnly":true}. Federated workers must include federatedJobId and federatedHostId matching their assigned job.',
      });
      return;
    }

    // Check fleet state before dispatching
    if (p.fleetController) {
      const fleetCheck = p.fleetController.canDispatch();
      if (!fleetCheck.allowed) {
        res.status(503).json({ ok: false, error: fleetCheck.reason });
        return;
      }
    }

    const resolvedDependencyIds: string[] = [];

    // Validate task exists and check dependencies
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      // Check for unmet dependencies using session-aware effective status
      if (task.blockedBy.length > 0) {
        const sessionsByTask = buildSessionMap(p.reader);
        const { tasks: allTasks } = await p.taskService.listTasks(sessionsByTask, undefined, p.db);
        const taskMap = new Map(allTasks.map((t) => [t.id, t]));

        const unmetDeps: string[] = [];
        for (const rawDepId of task.blockedBy) {
          // Extract task ID from entries like "[TASK-704] (description text)"
          // or bare "TASK-704". The parser may include brackets and descriptions.
          const idMatch = rawDepId.match(/\bTASK-\d+(?:-[A-Z]+)?\b/);
          const depId = idMatch ? idMatch[0] : rawDepId.trim();

          const dep = taskMap.get(depId);
          if (dep && (dep.effectiveStatus === "COMPLETE" || dep.effectiveStatus === "VERIFIED")) {
            resolvedDependencyIds.push(depId);
            continue; // Direct match â€” dependency satisfied
          }
          // If exact ID not found or not COMPLETE, check for subtask pattern.
          // Parent tasks (e.g., TASK-704) may be decomposed into subtasks
          // (TASK-704-A, TASK-704-B). The parent is satisfied if ALL subtasks
          // are COMPLETE, or if ANY task matching the parent ID is COMPLETE.
          const subtaskPrefix = `${depId}-`;
          const subtasks = allTasks.filter((t) => t.id.startsWith(subtaskPrefix));
          if (subtasks.length > 0) {
            const allSubtasksComplete = subtasks.every(
              (st) => st.effectiveStatus === "COMPLETE" || st.effectiveStatus === "VERIFIED",
            );
            if (allSubtasksComplete) {
              resolvedDependencyIds.push(...subtasks.map((subtask) => subtask.id));
              continue; // All subtasks complete â€” dependency satisfied
            }
            const incomplete = subtasks
              .filter(
                (st) => st.effectiveStatus !== "COMPLETE" && st.effectiveStatus !== "VERIFIED",
              )
              .map((st) => st.id);
            unmetDeps.push(`${depId} (subtasks incomplete: ${incomplete.join(", ")})`);
          } else {
            unmetDeps.push(depId);
          }
        }
        if (unmetDeps.length > 0) {
          res.status(400).json({
            error: `Task ${taskId} has unmet dependencies: ${unmetDeps.join(", ")}`,
          });
          return;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to validate task: ${msg}` });
      return;
    }

    // Check decomposition policy before dispatching a parent task.
    // skipGate is allowed for already-prepped tasks, but it must not bypass
    // the large-task decomposition gate unless the operator explicitly opts out.
    const dispatchReadiness = createReadinessService(p);
    if (dispatchReadiness) {
      const skipDecomposeCheck =
        body?.skipDecomposeCheck === true ||
        body?.allowLargeTask === true ||
        body?.allowDecompositionBypass === true;
      if (!skipDecomposeCheck) {
        const cachedPreflight = (await dispatchReadiness.resolveCurrent(taskId))?.preflight ?? null;
        // QPI-048 leg (g): the refusal branches only bite when the
        // pipeline can ACTUALLY decompose — with autoDecompose disabled
        // or writeSpecs suppressed, recommendDecomposition RECOMMENDS
        // and never refuses (the advisory posture the flip intended).
        let autoDecomposeArmed = false;
        if (p.adapterPath && fs.existsSync(p.adapterPath)) {
          try {
            const adapterJson = JSON.parse(fs.readFileSync(p.adapterPath, "utf-8")) as {
              preflight?: { autoDecompose?: { enabled?: boolean; writeSpecs?: boolean } };
            };
            // The config lives under `preflight` (adapter-schema.ts:383,
            // and every live adapter). The first cut of this leg read a
            // TOP-LEVEL `autoDecompose`, which no adapter has, so the
            // flag was permanently false and the refusal branch below
            // could never fire for a project that HAD armed
            // auto-decompose — a policy gate failing open, three lines
            // from a comment about failing closed. Caught by a test that
            // had been quietly red since the leg landed.
            const autoDecompose = adapterJson.preflight?.autoDecompose;
            autoDecomposeArmed =
              autoDecompose?.enabled === true && autoDecompose?.writeSpecs !== false;
          } catch {
            // Review finding (fail direction): an unreadable adapter
            // FAILS CLOSED — the refusal is recoverable in one retry or
            // via the explicit skipDecomposeCheck override, while a
            // fail-open would silently bypass an armed policy on a
            // transient read race. Hosts genuinely without autoDecompose
            // config read SUCCESSFULLY (absent key = unarmed), so this
            // only bites on real read/parse failures.
            autoDecomposeArmed = true;
          }
        }
        const decomposition = cachedPreflight?.decomposition;
        // QPI-048 leg (e) tolerance: enforce the record only when its
        // children are REAL — recorded, not advisory-only, and at least
        // one child spec still EXISTS ON DISK (review finding: a cached
        // record outlives a child revert because readPreflight only
        // invalidates on the PARENT spec hash; without the disk check a
        // reverted family blocks the parent forever, the exact
        // cache-surgery failure mode this fix exists to kill).
        const childrenReal =
          decomposition?.decomposed === true &&
          decomposition.advisoryOnly !== true &&
          decomposition.subtaskFiles.length > 0 &&
          p.projectRoot !== undefined &&
          decomposition.subtaskFiles.some((file) => {
            try {
              return fs.existsSync(path.resolve(p.projectRoot as string, file));
            } catch {
              return false;
            }
          });
        if (childrenReal) {
          res.status(409).json({
            ok: false,
            code: "task_decomposed",
            error: `Task ${taskId} was auto-decomposed into subtasks. Dispatch subtasks instead.`,
            decomposition,
            hint: "Dispatch individual subtask IDs, or pass skipDecomposeCheck: true to override.",
          });
          return;
        }
        if (autoDecomposeArmed && cachedPreflight?.complexity.recommendDecomposition) {
          res.status(409).json({
            ok: false,
            code: "decomposition_required",
            error: `Task ${taskId} exceeds decomposition thresholds and must be decomposed before dispatch.`,
            complexity: cachedPreflight.complexity,
            hint: "Run POST /api/tasks/{taskId}/decompose with approve:true, dispatch the generated subtasks, or pass skipDecomposeCheck:true for an explicit operator override.",
          });
          return;
        }
      }
    }

    const activeStart = p.dispatchManager.getActiveJob(taskId);
    if (activeStart?.status === "awaiting_approval") {
      res.status(409).json({
        error:
          `Task ${taskId} is awaiting human approval at a gate. ` +
          `Approve or reject via the dashboard, or stop the task first.`,
      });
      return;
    }
    if (activeStart) {
      res.status(409).json({
        error: `Task ${taskId} is already running (pid ${activeStart.pid})`,
      });
      return;
    }

    for (const dependencyId of [...new Set(resolvedDependencyIds)]) {
      const dependencyCheck = await buildDuplicateClaimantCheck(p, dependencyId);
      if (rejectDuplicateClaimantCheck(dependencyCheck, res)) return;
    }
    const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
    if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;

    // Check fleet budget caps
    const budgetCheck = fleetBudget.canDispatch();
    if (!budgetCheck.allowed) {
      // Emit fleet_budget_blocked event
      sse.broadcast({
        sessionId: "fleet-budget",
        taskId,
        project: p.projectId,
        timestamp: new Date().toISOString(),
        stage: "fleet_budget_blocked",
        payload: {
          taskId,
          reason: budgetCheck.reason ?? "Unknown",
          currentSpend: budgetCheck.currentSpend,
          limits: budgetCheck.limits,
        },
      });

      // If enforceHard, block dispatch with 429
      if ((fleetBudgetConfig ?? defaultFleetBudgetConfig).enforceHard) {
        res.status(429).json({
          error: budgetCheck.reason,
          currentSpend: budgetCheck.currentSpend,
          limits: budgetCheck.limits,
        });
        return;
      }
      // If not enforcing, emit warning but proceed
    }

    // Check for threshold alerts
    const alerts = fleetBudget.checkAlertThresholds();
    for (const alert of alerts) {
      sse.broadcast({
        sessionId: "fleet-budget",
        taskId,
        project: p.projectId,
        timestamp: new Date().toISOString(),
        stage: "fleet_budget_alert",
        payload: alert,
      });
    }

    // Check Docker availability if required verification commands need it
    if (p.projectRoot) {
      try {
        const adapter = await loadAdapter(p.projectRoot);
        if (requiresDocker(adapter.config.verification.commands)) {
          const dockerHealth = await checkDockerHealth();
          if (!dockerHealth.available) {
            const dockerCmds = adapter.config.verification.commands
              .filter((c) => {
                if (!c.required) return false;
                const haystack =
                  "command" in c ? c.command : `${c.cmd} ${(c.args ?? []).join(" ")}`;
                return /\bdocker\b/i.test(haystack);
              })
              .map((c) => c.name);
            res.status(503).json({
              error: "Docker is required but not available",
              detail: dockerHealth.error,
              hint: "Start Docker Desktop and try again. Required verification commands use Docker.",
              dockerCommands: dockerCmds,
            });
            return;
          }
        }
      } catch {
        // Adapter load failed â€” skip Docker check, let dispatch proceed
      }
    }

    try {
      const job = p.dispatchManager.start(
        taskId,
        {
          skipGate,
          skipDepthOnly,
          forceClean,
          overridePausedRun,
          model,
          maxTurns,
          maxBudget,
          federatedJobId,
          federatedHostId,
          federatedHostAlias,
          federatedHostEndpoint,
          federatedLeaseId,
          provenance: startProvenance(req, { federatedJobId, federatedWorkerStart }),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );
      // Set task status to IN_PROGRESS in DB immediately so dashboard reflects reality
      p.db.setStatus(
        taskId,
        "IN_PROGRESS",
        federatedWorkerStart ? "federated_worker_dispatch" : "dispatch",
      );
      res.json({
        ok: true,
        taskId,
        sessionId: job.sessionId,
        pid: job.pid,
        dispatchMode: federatedWorkerStart
          ? "federated_worker"
          : localSmokeOnly
            ? "local_smoke"
            : "direct",
        federatedJobId,
        federatedHostId,
        message: `Dispatch started for ${taskId}`,
      });
    } catch (err: unknown) {
      // TASK-1326 (QPI-042): a start that would discard a human-gate
      // pause gets a NAMED code, not a bare message — an operator (or a
      // listener) has to be able to tell "you would destroy paid-for
      // work" apart from "already running".
      if (err instanceof PausedRunRefusalError) {
        res.status(409).json({
          ok: false,
          code: "awaiting_human_gate",
          error: err.message,
          gate: err.paused.gate,
          pendOpenedAt: err.paused.createdAt,
          hint:
            "Approve or reject the gate, or stop the task. To discard that run's state " +
            'deliberately, re-send with {"overridePausedRun": true} — its branch, ' +
            "checkpoint and pending record are archived first.",
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
  });

  app.post("/api/tasks/:id/revise", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.status(500).json({ error: "Dispatch not available" });
      return;
    }
    if (!p.taskService) {
      res.status(500).json({ error: "Task service not configured" });
      return;
    }

    const taskId = req.params.id as string;
    let taskExecutionMode: ExecutionMode | undefined;

    // Check if task exists
    try {
      const task = await p.taskService.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }
      taskExecutionMode = task.executionMode;
    } catch {
      res.status(404).json({ error: `Task ${taskId} not found` });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const feedback = typeof body?.feedback === "string" ? body.feedback : "";

    // Load adapter to get revision defaults
    let revisionMaxBudget = 2.0;
    let revisionMaxTurns = 50;
    let adapterExecutionMode: ExecutionMode = "dispatch";
    if (p.adapterPath && fs.existsSync(p.adapterPath)) {
      try {
        const adapterJson = JSON.parse(fs.readFileSync(p.adapterPath, "utf-8")) as Record<
          string,
          unknown
        >;
        if (adapterJson.executionMode === "loop") adapterExecutionMode = "loop";
        const revision = adapterJson.revision as Record<string, unknown> | undefined;
        if (revision) {
          if (typeof revision.maxBudget === "number") revisionMaxBudget = revision.maxBudget;
          if (typeof revision.maxTurns === "number") revisionMaxTurns = revision.maxTurns;
        }
      } catch {
        /* ignore parse errors */
      }
    }

    const maxBudget = typeof body?.maxBudget === "number" ? body.maxBudget : revisionMaxBudget;
    const maxTurns = typeof body?.maxTurns === "number" ? body.maxTurns : revisionMaxTurns;
    const federatedJobId =
      stringField(body?.federatedJobId) ??
      stringField(body?.jobId) ??
      headerString(req, "x-quack-federated-job-id");
    const federatedHostId =
      stringField(body?.federatedHostId) ??
      stringField(body?.workerHostId) ??
      stringField(body?.hostId) ??
      headerString(req, "x-quack-worker-host-id") ??
      headerString(req, "x-quack-federated-host-id");
    const federatedHostAlias =
      stringField(body?.federatedHostAlias) ??
      stringField(body?.hostAlias) ??
      headerString(req, "x-quack-worker-host-alias");
    const federatedHostEndpoint =
      stringField(body?.federatedHostEndpoint) ??
      stringField(body?.hostEndpoint) ??
      headerString(req, "x-quack-worker-host-endpoint");
    const federatedLeaseId =
      stringField(body?.federatedLeaseId) ??
      stringField(body?.leaseId) ??
      headerString(req, "x-quack-federated-lease-id");
    const localSmokeOnly =
      body?.localSmokeOnly === true || headerString(req, "x-quack-local-smoke") === "true";
    const claimsFederatedStart = Boolean(federatedJobId && federatedHostId);
    const federatedWorkerStart =
      claimsFederatedStart &&
      (await verifyFederatedStartClaim(p.projectRoot, federatedJobId, federatedHostId));

    if (
      !localSmokeOnly &&
      !federatedWorkerStart &&
      (await hasRegisteredFederatedListeners(p.projectRoot))
    ) {
      res.status(409).json({
        ok: false,
        code: claimsFederatedStart
          ? "federated_claim_unverified"
          : "direct_revision_blocked_in_swarm_mode",
        error: claimsFederatedStart
          ? "Claimed federatedJobId/federatedHostId did not match an active job assigned to that host."
          : "Direct task revision is disabled while federated listeners are registered.",
        hint: 'Queue fix work through POST /v1/federation/queue with jobType:"fix". For an isolated platform smoke run, pass {"localSmokeOnly":true}. Federated workers must include federatedJobId and federatedHostId matching their assigned job.',
      });
      return;
    }

    // Get last judge feedback from most recent run
    const sessions = p.reader.getExecutionSessions().filter((s) => s.taskId === taskId);
    if (sessions.length === 0) {
      res.status(400).json({ error: "Cannot revise: no prior runs" });
      return;
    }

    // Check if task is currently running
    if (p.dispatchManager.getJob(taskId)) {
      res.status(409).json({ error: `Task ${taskId} is already running` });
      return;
    }

    const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
    if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;

    let judgeFeedback = "";
    const lastSession = sessions[0];
    const events = p.reader.getSessionEvents(lastSession.sessionId);
    const judgeEvent = events.find((e) => e.stage === "judge_result");
    if (judgeEvent) {
      const payload = judgeEvent.payload as Record<string, unknown>;
      judgeFeedback = typeof payload.feedback === "string" ? payload.feedback : "";
    }

    // Merge feedbacks
    let mergedFeedback = judgeFeedback
      ? `${judgeFeedback}\n\n---\n\n## Human Revision Feedback\n\n${feedback}`
      : feedback;
    const effectiveExecutionMode = taskExecutionMode ?? adapterExecutionMode;
    let resuming = false;

    if (effectiveExecutionMode === "loop" && p.projectRoot) {
      const runtimeLogDir = resolveTaskRuntimeLogDir(
        p.projectRoot,
        p.dispatchManager,
        taskId,
        p.logDir,
      );
      const { loadJudgeApproval, deleteJudgeApproval } =
        await import("../dispatcher/judge-approval.js");
      const approval = await loadJudgeApproval(taskId, runtimeLogDir);
      const reviewFeedback = formatLoopReviewFeedback(approval?.review);
      if (reviewFeedback) {
        mergedFeedback = [mergedFeedback, reviewFeedback].filter(Boolean).join("\n\n---\n\n");
      }

      const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
      const checkpointMgr = new CheckpointManager(runtimeLogDir);
      const rewound = await checkpointMgr.rewindFrom(taskId, "agent");
      resuming = Boolean(rewound?.claudeSessionId && checkpointMgr.isUsable(rewound));
      if (approval) {
        await deleteJudgeApproval(taskId, runtimeLogDir);
      }
    }

    // Emit revision_start event
    sse.broadcast({
      sessionId: "revision",
      taskId,
      project: p.projectId,
      timestamp: new Date().toISOString(),
      stage: "revision_start",
      payload: {
        taskId,
        feedback: mergedFeedback,
        prNumber: undefined,
        budget: maxBudget,
        turns: maxTurns,
      },
    });

    try {
      const job = p.dispatchManager.start(
        taskId,
        {
          judgeFeedback: mergedFeedback,
          skipGate: true,
          reuseWorktree: true,
          ...(resuming ? { resume: true } : {}),
          maxBudget,
          maxTurns,
          federatedJobId,
          federatedHostId,
          federatedHostAlias,
          federatedHostEndpoint,
          federatedLeaseId,
          provenance: startProvenance(req, { federatedJobId, federatedWorkerStart }),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );
      // Track this as a revision dispatch for revision_complete emission
      activeRevisions.add(taskId);
      res.json({
        ok: true,
        sessionId: job.sessionId,
        resuming,
        fallback:
          effectiveExecutionMode === "loop" && !resuming
            ? "fresh-session-reused-worktree"
            : undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
  });

  app.post("/api/tasks/:id/stop", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.status(500).json({ error: "Dispatch not available" });
      return;
    }

    const taskId = req.params.id as string;
    const stopped = p.dispatchManager.stop(taskId);
    if (stopped) {
      // Revert task status â€” stopped dispatch means task is back to READY
      p.db.setStatus(taskId, "READY", "dispatch_stopped");
      res.json({ ok: true, message: `Dispatch stopped for ${taskId}` });
    } else {
      res.status(404).json({ error: `No active dispatch for ${taskId}` });
    }
  });

  // â”€â”€â”€ Task Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Deletes task branch + checkpoint. Used for manually pruning
  // leftover artifacts from failed dispatches.
  app.post("/api/tasks/:id/cleanup", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const taskId = req.params.id as string;

    // Refuse cleanup of running tasks
    if (p.dispatchManager?.getJob(taskId)) {
      res.status(409).json({ error: `Task ${taskId} is currently running â€” stop it first` });
      return;
    }

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const results: { branch?: string; checkpoint?: string; errors: string[] } = { errors: [] };

    // Delete checkpoint
    try {
      const resolvedLogDir = p.logDir ?? logDir;
      if (resolvedLogDir) {
        const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
        const checkpointMgr = new CheckpointManager(resolvedLogDir);
        const deleted = await checkpointMgr.delete(taskId);
        results.checkpoint = deleted ? "deleted" : "not found";
      } else {
        results.checkpoint = "no log dir";
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Checkpoint: ${msg}`);
    }

    // Delete branch
    try {
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { cleanupBranch } = await import("../dispatcher/branch-manager.js");
      const adapter = await loadAdapter(p.projectRoot);
      const branchResult = await cleanupBranch(taskId, adapter);
      results.branch = branchResult.success
        ? `deleted (${branchResult.branchName})`
        : (branchResult.error ?? "failed");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Branch: ${msg}`);
    }

    if (results.errors.length > 0) {
      res.status(207).json({ ok: true, taskId, ...results, message: "Partial cleanup" });
    } else {
      res.json({ ok: true, taskId, ...results, message: "Cleanup complete" });
    }
  });

  // Check if a task branch exists (for showing cleanup button)
  app.get("/api/tasks/:id/branch", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const taskId = req.params.id as string;

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    try {
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { buildBranchName } = await import("../dispatcher/branch-manager.js");
      const adapter = await loadAdapter(p.projectRoot);
      const branchName = buildBranchName(taskId, adapter);

      // Check local branches via git
      const stdout = execSync(`git branch --list ${branchName}`, {
        cwd: adapter.projectRoot,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const exists = stdout.trim().length > 0;

      res.json({ taskId, branchName, exists });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Branch check failed: ${msg}` });
    }
  });

  app.post("/api/tasks/:id/force-retry", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.status(500).json({ error: "Dispatch not available" });
      return;
    }

    const taskId = req.params.id as string;
    const body = req.body as Record<string, unknown> | undefined;
    const maxBudget = typeof body?.maxBudget === "number" ? body.maxBudget : undefined;
    const model = typeof body?.model === "string" ? body.model : undefined;

    // Find the last judge_result event for this task
    const sessions = p.reader.getExecutionSessions();
    const taskSessions = sessions
      .filter((s) => s.taskId === taskId)
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

    let judgeFeedback = "";
    for (const session of taskSessions) {
      const events = p.reader.getSessionEvents(session.sessionId);
      const judgeEvents = events.filter((e) => e.stage === "judge_result");
      if (judgeEvents.length > 0) {
        const lastJudge = judgeEvents[judgeEvents.length - 1];
        const jp = lastJudge.payload as Record<string, unknown>;
        const sections: string[] = [];
        sections.push(`### Verdict: ${String(jp.verdict)}`);
        if (Array.isArray(jp.scopeViolations) && jp.scopeViolations.length > 0) {
          sections.push(
            `### Scope Violations\n${jp.scopeViolations.map((s: unknown) => `- ${String(s)}`).join("\n")}`,
          );
        }
        if (Array.isArray(jp.criteriaGaps) && jp.criteriaGaps.length > 0) {
          sections.push(
            `### Criteria Gaps\n${jp.criteriaGaps.map((s: unknown) => `- ${String(s)}`).join("\n")}`,
          );
        }
        if (Array.isArray(jp.qualityIssues) && jp.qualityIssues.length > 0) {
          sections.push(
            `### Quality Issues\n${jp.qualityIssues.map((s: unknown) => `- ${String(s)}`).join("\n")}`,
          );
        }
        if (typeof jp.feedback === "string") {
          sections.push(`### Judge Feedback\n${jp.feedback}`);
        }
        judgeFeedback = sections.join("\n\n");
        break;
      }
    }

    if (!judgeFeedback) {
      res.status(404).json({ error: `No judge feedback found for ${taskId}. Use /start instead.` });
      return;
    }

    const activeRetry = p.dispatchManager.getActiveJob(taskId);
    if (activeRetry?.status === "awaiting_approval") {
      res.status(409).json({
        error:
          `Task ${taskId} is awaiting human approval at a gate. ` +
          `Approve or reject via the dashboard, or stop the task first.`,
      });
      return;
    }
    if (activeRetry) {
      res.status(409).json({
        error: `Task ${taskId} is already running (pid ${activeRetry.pid})`,
      });
      return;
    }

    const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
    if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;

    try {
      const job = p.dispatchManager.start(
        taskId,
        {
          skipGate: true,
          model,
          maxBudget,
          judgeFeedback,
          provenance: startProvenance(req),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );
      res.json({
        ok: true,
        taskId,
        sessionId: job.sessionId,
        pid: job.pid,
        message: `Force-retry started for ${taskId} with judge feedback injected`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
  });

  app.post("/api/tasks/:id/resume", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.status(500).json({ error: "Dispatch not available (no project root)" });
      return;
    }
    if (!p.projectRoot) {
      res.status(500).json({ error: "No project root configured" });
      return;
    }

    const resolvedLogDir = p.logDir ?? logDir;
    if (!resolvedLogDir) {
      res.status(404).json({ error: "Log directory not configured" });
      return;
    }

    const taskId = req.params.id as string;
    const body = req.body as Record<string, unknown> | undefined;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;

    // Check for existing checkpoint
    const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
    const checkpointMgr = new CheckpointManager(resolvedLogDir);
    const checkpoint = await checkpointMgr.load(taskId);

    if (!checkpoint && !sessionId) {
      res.status(404).json({
        error: `No checkpoint or session ID found for ${taskId}. Cannot resume.`,
      });
      return;
    }

    // Prevent double-dispatch
    const existing = p.dispatchManager.getActiveJob(taskId);
    if (existing) {
      res.status(409).json({ error: `Task ${taskId} is already running (pid ${existing.pid})` });
      return;
    }

    // Check fleet state
    if (p.fleetController) {
      const fleetCheck = p.fleetController.canDispatch();
      if (!fleetCheck.allowed) {
        res.status(503).json({ ok: false, error: fleetCheck.reason });
        return;
      }
    }

    const claimantCheck = await buildDuplicateClaimantCheck(p, taskId);
    if (rejectDuplicateClaimantCheck(claimantCheck, res)) return;

    try {
      // Start a dispatch with resume flags + checkpoint context
      const resumeId = sessionId ?? checkpoint?.claudeSessionId;
      // resume: true adds --resume flag to child process, which triggers
      // checkpoint loading + progress file injection in the dispatcher
      const job = p.dispatchManager.start(
        taskId,
        {
          skipGate: true,
          resume: true,
          provenance: startProvenance(req),
          duplicateClaimantCheck: claimantCheck,
        },
        claimantCheck,
      );
      res.json({
        ok: true,
        taskId,
        sessionId: job.sessionId,
        pid: job.pid,
        resuming: true,
        claudeSessionId: resumeId ?? null,
        checkpointStages: checkpoint?.completedStages ?? [],
        message: `Resume dispatch started for ${taskId}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
  });

  // â”€â”€â”€ Checkpoint endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/checkpoints", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const resolvedLogDir = p.logDir ?? logDir;
    if (!resolvedLogDir) {
      res.status(404).json({ error: "Log directory not configured" });
      return;
    }
    try {
      const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
      const checkpointMgr = new CheckpointManager(resolvedLogDir);
      const checkpoints = await checkpointMgr.list();
      res.json(checkpoints);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list checkpoints: ${msg}` });
    }
  });

  app.get("/api/checkpoints/:id", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const resolvedLogDir = p.logDir ?? logDir;
    if (!resolvedLogDir) {
      res.status(404).json({ error: "Log directory not configured" });
      return;
    }
    const taskId = req.params.id as string;
    try {
      const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
      const checkpointMgr = new CheckpointManager(resolvedLogDir);
      const checkpoint = await checkpointMgr.load(taskId);
      if (!checkpoint) {
        res.status(404).json({ error: `No checkpoint found for ${taskId}` });
        return;
      }
      res.json(checkpoint);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load checkpoint: ${msg}` });
    }
  });

  app.delete("/api/checkpoints/:id", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const resolvedLogDir = p.logDir ?? logDir;
    if (!resolvedLogDir) {
      res.status(404).json({ error: "Log directory not configured" });
      return;
    }
    const taskId = req.params.id as string;
    try {
      const { CheckpointManager } = await import("../dispatcher/checkpoint-manager.js");
      const checkpointMgr = new CheckpointManager(resolvedLogDir);
      const deleted = await checkpointMgr.delete(taskId);
      if (deleted) {
        res.json({ ok: true, message: `Checkpoint deleted for ${taskId}` });
      } else {
        res.status(404).json({ error: `No checkpoint found for ${taskId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to delete checkpoint: ${msg}` });
    }
  });

  app.get("/api/dispatch/jobs", (req: Request, res: Response) => {
    const jobs = resolveProjects(req).flatMap(
      (project) =>
        project.dispatchManager?.getAllJobs().map((job) => ({
          ...job,
          project: project.projectId,
        })) ?? [],
    );
    res.json(jobs);
  });

  // â”€â”€â”€ Fleet endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Extracted into ./routes/fleet.ts (TASK-873).
  // Includes /api/fleet/* (budget/keys/routing/control/containers/velocity/
  // health) plus /api/tasks/:id/health (lives in the same control-plane
  // block via progressDetector).
  registerFleetRoutes(app, {
    resolveProject,
    fleetBudget,
    emitFleetEvent,
  });

  // â”€â”€â”€ Queue endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Extracted into ./routes/queue.ts (TASK-873).
  registerQueueRoutes(app, {
    resolveProject,
  });

  // ─── Coordination endpoints (TASK-926) ─────────────────────────
  // Agent-to-agent coordination broker. Uses the active project's QuackDB.
  registerCoordinationRoutes(app, {
    authService,
    getDb: () => {
      const project = resolveProject();
      const db = project.db;
      if (!db || typeof (db as { raw?: unknown }).raw !== "function") {
        throw new Error(
          "Coordination requires QuackDB (better-sqlite3); current project uses NoopDB.",
        );
      }
      return (db as { raw: () => CoordinationDb }).raw();
    },
  });

  registerDeploymentMonitoringRoutes(app);

  // â”€â”€â”€ Remote Instance endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/remotes", async (_req: Request, res: Response) => {
    try {
      const { loadGlobalConfig: load } = await import("../core/global-config.js");
      const config = load();
      res.json(config.remoteInstances ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/remotes", async (req: Request, res: Response) => {
    try {
      const {
        loadGlobalConfig: load,
        saveGlobalConfig: save,
        validateRemoteInstance: validate,
        slugifyAlias,
      } = await import("../core/global-config.js");
      const config = load();
      const remotes = config.remoteInstances ?? [];
      const existingIds = remotes.map((r) => r.id);

      const body = req.body as Record<string, unknown>;
      const instance = {
        alias: body.alias as string,
        host: body.host as string,
        localPort: body.localPort as number,
        remotePort: body.remotePort as number,
        sshTarget: body.sshTarget as string,
        sshKeyPath: body.sshKeyPath as string,
        healthCheckInterval: (body.healthCheckInterval as number) ?? 30000,
        enabled: body.enabled !== false,
      };

      const errors = validate(instance, existingIds);
      if (errors.length > 0) {
        res.status(400).json({ error: "Validation failed", errors });
        return;
      }

      const remote = {
        id: slugifyAlias(instance.alias),
        ...instance,
      };
      remotes.push(remote);
      config.remoteInstances = remotes;
      save(config);
      res.status(201).json({ ok: true, remote });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/remotes/:id", async (req: Request, res: Response) => {
    try {
      const {
        loadGlobalConfig: load,
        saveGlobalConfig: save,
        validateRemoteInstance: validate,
        slugifyAlias,
      } = await import("../core/global-config.js");
      const config = load();
      const remotes = config.remoteInstances ?? [];
      const idx = remotes.findIndex((r) => r.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: "Remote instance not found" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const updated = { ...remotes[idx] };
      if (body.alias !== undefined) {
        updated.alias = body.alias as string;
        updated.id = slugifyAlias(updated.alias);
      }
      if (body.host !== undefined) updated.host = body.host as string;
      if (body.localPort !== undefined) updated.localPort = body.localPort as number;
      if (body.remotePort !== undefined) updated.remotePort = body.remotePort as number;
      if (body.sshTarget !== undefined) updated.sshTarget = body.sshTarget as string;
      if (body.sshKeyPath !== undefined) updated.sshKeyPath = body.sshKeyPath as string;
      if (body.healthCheckInterval !== undefined)
        updated.healthCheckInterval = body.healthCheckInterval as number;
      if (body.enabled !== undefined) updated.enabled = body.enabled as boolean;

      const otherIds = remotes.filter((_, i) => i !== idx).map((r) => r.id);
      const errors = validate(updated, otherIds);
      if (errors.length > 0) {
        res.status(400).json({ error: "Validation failed", errors });
        return;
      }

      remotes[idx] = updated;
      config.remoteInstances = remotes;
      save(config);
      res.json({ ok: true, remote: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.delete("/api/remotes/:id", async (req: Request, res: Response) => {
    try {
      const { loadGlobalConfig: load, saveGlobalConfig: save } =
        await import("../core/global-config.js");
      const config = load();
      const remotes = config.remoteInstances ?? [];
      const idx = remotes.findIndex((r) => r.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: "Remote instance not found" });
        return;
      }
      remotes.splice(idx, 1);
      config.remoteInstances = remotes;
      save(config);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Helper: proxy a GET request to a remote instance.
  // Tries tunnel (localhost:localPort) first, falls back to direct (host:remotePort).
  async function proxyRemoteGet(
    remote: { host: string; localPort: number; remotePort: number },
    apiPath: string,
    res: Response,
  ): Promise<void> {
    const http = await import("node:http");

    const tryUrl = (url: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (proxyRes) => {
          let data = "";
          proxyRes.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          proxyRes.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Connection timed out"));
        });
      });

    // Try tunnel first, then direct
    const tunnelUrl = `http://localhost:${remote.localPort}${apiPath}`;
    const directUrl = `http://${remote.host}:${remote.remotePort}${apiPath}`;

    try {
      // Verify tunnel actually reaches the remote (not a different local service)
      const tunnelData = await tryUrl(tunnelUrl);
      const parsed = JSON.parse(tunnelData) as { projectRoot?: string };
      // If the tunnel response looks like a Quack monitor health/project response, use it
      // Otherwise fall through to direct
      if (
        apiPath === "/api/health" &&
        parsed.projectRoot &&
        typeof parsed.projectRoot === "string"
      ) {
        res.json(parsed);
        return;
      }
      if (apiPath === "/api/projects" && Array.isArray(parsed)) {
        res.json(parsed);
        return;
      }
      // Response doesn't look right (wrong service on that port), try direct
      const directData = await tryUrl(directUrl);
      res.json(JSON.parse(directData));
    } catch {
      // Tunnel failed, try direct connection
      try {
        const directData = await tryUrl(directUrl);
        try {
          res.json(JSON.parse(directData));
        } catch {
          res.json({ raw: directData });
        }
      } catch (err2: unknown) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        res.status(502).json({ error: "Remote unreachable", details: msg });
      }
    }
  }

  app.get("/api/remotes/:id/health", async (req: Request, res: Response) => {
    try {
      const { loadGlobalConfig: load } = await import("../core/global-config.js");
      const config = load();
      const remote = (config.remoteInstances ?? []).find((r) => r.id === req.params.id);
      if (!remote) {
        res.status(404).json({ error: "Remote instance not found" });
        return;
      }
      await proxyRemoteGet(remote, "/api/health", res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/remotes/:id/projects", async (req: Request, res: Response) => {
    try {
      const { loadGlobalConfig: load } = await import("../core/global-config.js");
      const config = load();
      const remote = (config.remoteInstances ?? []).find((r) => r.id === req.params.id);
      if (!remote) {
        res.status(404).json({ error: "Remote instance not found" });
        return;
      }
      await proxyRemoteGet(remote, "/api/projects", res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // â”€â”€â”€ Settings endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/settings", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const resolvedAdapterPath = p.adapterPath ?? adapterPath;
    if (!resolvedAdapterPath) {
      res.status(404).json({ error: "No adapter path configured" });
      return;
    }
    try {
      const content = fs.readFileSync(resolvedAdapterPath, "utf-8");
      const config = JSON.parse(content) as Record<string, unknown>;
      res.json({ path: resolvedAdapterPath, config });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read adapter config: ${msg}` });
    }
  });

  app.put("/api/settings", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const resolvedAdapterPath = p.adapterPath ?? adapterPath;
    if (!resolvedAdapterPath) {
      res.status(404).json({ error: "No adapter path configured" });
      return;
    }
    try {
      const config = req.body as Record<string, unknown>;
      if (!config || typeof config !== "object") {
        res.status(400).json({ error: "Invalid config payload" });
        return;
      }
      fs.writeFileSync(resolvedAdapterPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to write adapter config: ${msg}` });
    }
  });

  // â”€â”€â”€ Plan endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.post("/api/plan", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Plan not available (no project root)" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const maxTasks = typeof body?.maxTasks === "number" ? body.maxTasks : 10;
    const dryRun = body?.dryRun === true;
    const model = typeof body?.model === "string" ? body.model : undefined;
    const startId = typeof body?.startId === "number" ? body.startId : undefined;

    if (!prompt || prompt.trim().length === 0) {
      res.status(400).json({ error: "Missing required field: prompt" });
      return;
    }

    try {
      // Dynamically import the planner module
      const { loadAdapter } = await import("../core/adapter-loader.js");
      const { planTasks } = await import("../planner/index.js");

      const adapter = await loadAdapter(p.projectRoot);
      const result = await planTasks(prompt, adapter, {
        model,
        maxTasks,
        dryRun,
        startId,
      });

      res.json({
        ok: true,
        taskIds: result.taskIds,
        specs: result.specs,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to plan tasks: ${msg}` });
    }
  });

  // â”€â”€â”€ Intake endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // /v1/intake/* (federated task intake) + /api/scan + /api/intake/*
  // (project bootstrap intake) all live in routes/intake.ts (TASK-873).
  // Closure helpers are typed against ResolvedProject (which is closure-
  // scoped and cannot be imported by the route module); the casts narrow
  // them to the route module's IntakeRouteProject view. The runtime
  // object handed back by resolveProject is still a full ResolvedProject.
  registerIntakeRoutes(app, {
    resolveProject,
    emitIntakeCreated: emitIntakeCreated as IntakeRouteDeps["emitIntakeCreated"],
    emitIntakeRouted: emitIntakeRouted as IntakeRouteDeps["emitIntakeRouted"],
    resolveAndBroadcastProjection:
      resolveAndBroadcastProjection as IntakeRouteDeps["resolveAndBroadcastProjection"],
    // TASK-1106 validation-intake orchestrator injection. The route module
    // is kept pure of orchestrator imports; server.ts wires the real
    // implementations here. Tests can swap mocks via createMonitorServer
    // options later if needed (the parent IntakeRouteDeps is Partial).
    runValidationIntakeDryRun,
    runValidationIntakePersist,
    generateValidationSpec: async (args) => {
      const adapter = await loadAdapter(args.projectRoot);
      return generateValidationSpecImpl({
        projectRoot: args.projectRoot,
        adapter,
        intakeId: args.intakeId,
        payload: args.payload,
      });
    },
  });

  // â”€â”€â”€ Testing endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Load verification commands from adapter config
  function getAdapterGitConfig(resolvedAdapterPath?: string): AdapterGitConfig | null {
    const p = resolvedAdapterPath ?? adapterPath;
    if (!p || !fs.existsSync(p)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      const parsed = AdapterGitConfigSchema.safeParse(raw.git);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function getRecordingConfig(
    resolvedAdapterPath?: string,
  ): ReturnType<typeof RecordingConfigSchema.parse> | null {
    const p = resolvedAdapterPath ?? adapterPath;
    if (!p || !fs.existsSync(p)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      if (raw.recording === undefined) return null;
      const parsed = RecordingConfigSchema.safeParse(raw.recording);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function getVerificationCommands(resolvedAdapterPath?: string): VerificationCommand[] {
    const p = resolvedAdapterPath ?? adapterPath;
    if (!p || !fs.existsSync(p)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      const verification = raw.verification as Record<string, unknown> | undefined;
      const rawCommands = verification?.commands;
      if (!Array.isArray(rawCommands)) return [];
      const parsed = z.array(VerificationCommandSchema).safeParse(rawCommands);
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  function getSmartTestingConfig(resolvedAdapterPath?: string): SmartTestingConfig | undefined {
    const p = resolvedAdapterPath ?? adapterPath;
    if (!p || !fs.existsSync(p)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      const verification = raw.verification as Record<string, unknown> | undefined;
      const parsed = SmartTestingConfigSchema.safeParse(verification?.smartTesting);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  function getAdapterFreshness(resolvedAdapterPath?: string): AdapterFreshnessMetadata | undefined {
    const p = resolvedAdapterPath ?? adapterPath;
    if (!p || !fs.existsSync(p)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const bundle = computeAdapterBundleMetadata(parsed.data);
      return {
        status: "fresh",
        localHash: bundle.sharedHash,
        authoritativeHash: bundle.sharedHash,
      };
    } catch {
      return undefined;
    }
  }

  const testRunner = projectRoot
    ? new TestRunner(
        projectRoot,
        (data: string) => {
          sse.broadcast({
            sessionId: "testing",
            taskId: "",
            project: currentProjectId(),
            timestamp: new Date().toISOString(),
            stage: "testing_output" as QuackEvent["stage"],
            payload: { output: data } as unknown as QuackEvent["payload"],
          });
        },
        (stage, payload) => {
          sse.broadcast({
            sessionId: "testing",
            taskId: typeof payload.taskId === "string" ? payload.taskId : "",
            project: currentProjectId(),
            timestamp: new Date().toISOString(),
            stage,
            payload: payload as unknown as QuackEvent["payload"],
          });
        },
      )
    : null;

  // â”€â”€â”€ Testing endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Extracted into ./routes/testing.ts (TASK-873).
  registerTestingRoutes(app, {
    resolveProject,
    testRunner,
    sse,
    getVerificationCommands,
    getSmartTestingConfig,
    getAdapterGitConfig,
    getAdapterFreshness,
    authority,
  });

  // â”€â”€â”€ Project endpoints (multi-project support) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/projects", async (_req: Request, res: Response) => {
    try {
      if (!registry) {
        // Legacy single-project mode â€” return a synthetic project
        if (projectRoot) {
          const legacyId = legacyProjectName
            ? generateProjectId(legacyProjectName)
            : generateProjectId(projectRoot);
          const legacyName = legacyProjectName ?? path.basename(projectRoot);
          let taskCount = 0;
          if (taskService) {
            try {
              taskCount = (await taskService.listTasks()).tasks.length;
            } catch {
              /* ignore */
            }
          }
          res.json([
            {
              id: legacyId,
              name: legacyName,
              path: projectRoot ?? "",
              taskCount,
              active: true,
              ...authority,
            },
          ]);
        } else {
          res.json([]);
        }
        return;
      }

      // Multi-project mode
      const projects = registry.listProjects();
      const activeId = registry.getActiveProjectId();
      const results = await Promise.all(
        projects.map(async (p) => {
          let taskCount = 0;
          if (p.taskService) {
            try {
              taskCount = (await p.taskService.listTasks()).tasks.length;
            } catch {
              /* ignore */
            }
          }
          return {
            id: p.id,
            name: p.name,
            path: p.rootPath,
            taskCount,
            active: p.id === activeId,
            adapterBundle: getAdapterBundleMetadata(p.adapter),
            ...authority,
          };
        }),
      );
      res.json(results);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/projects/:id", (req: Request, res: Response) => {
    if (!registry) {
      res.status(404).json({ error: "Multi-project mode not enabled" });
      return;
    }

    const projectId = req.params.id as string;
    const project = registry.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `Project ${projectId} not found` });
      return;
    }

    res.json({
      id: project.id,
      name: project.name,
      path: project.rootPath,
      logDir: project.logDir,
      adapter: {
        name: project.adapter.config.project.name,
        taskDir: project.adapter.config.project.taskDir,
      },
      adapterBundle: getAdapterBundleMetadata(project.adapter),
      ...authority,
    });
  });

  app.post("/api/projects/active", async (req: Request, res: Response) => {
    if (!registry) {
      res.status(404).json({ error: "Multi-project mode not enabled" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";

    if (!projectId) {
      res.status(400).json({ error: "Missing required field: projectId" });
      return;
    }

    try {
      registry.setActiveProject(projectId);

      // Reload fleet budget config from the new active project's adapter
      const activeCtx = registry.getActiveProject();
      await persistActiveProjectSelection(projectId, activeCtx);
      if (activeCtx) {
        const projAdapterPath = path.resolve(activeCtx.rootPath, ".quack", "adapter.json");
        if (fs.existsSync(projAdapterPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(projAdapterPath, "utf-8")) as Record<
              string,
              unknown
            >;
            const fb = raw.fleetBudget as Record<string, unknown> | undefined;
            if (fb) {
              fleetBudget.updateConfig({
                dailyCapUsd: typeof fb.dailyCapUsd === "number" ? fb.dailyCapUsd : 25.0,
                hourlyCapUsd: typeof fb.hourlyCapUsd === "number" ? fb.hourlyCapUsd : 10.0,
                perWaveCapUsd: typeof fb.perWaveCapUsd === "number" ? fb.perWaveCapUsd : 15.0,
                alertThresholds: Array.isArray(fb.alertThresholds)
                  ? (fb.alertThresholds as number[])
                  : [50, 75, 90],
                enforceHard: fb.enforceHard !== false,
              });
              console.log(
                `[fleet-budget] Reloaded from ${projectId}: daily=$${String(fb.dailyCapUsd)}, hourly=$${String(fb.hourlyCapUsd)}, wave=$${String(fb.perWaveCapUsd)}`,
              );
            }
          } catch {
            /* adapter parse error â€” keep existing config */
          }
        }
      }

      res.json({ ok: true, activeProjectId: projectId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(404).json({ error: msg });
    }
  });

  app.post("/api/projects", async (req: Request, res: Response) => {
    if (!registry) {
      res.status(404).json({ error: "Multi-project mode not enabled" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const projectPath = typeof body?.path === "string" ? body.path : "";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required field: path" });
      return;
    }

    try {
      // Validate path exists
      if (!fs.existsSync(projectPath)) {
        res.status(400).json({ error: "Path does not exist" });
        return;
      }

      // Validate adapter.json exists
      const adapterPath = path.resolve(projectPath, ".quack", "adapter.json");
      if (!fs.existsSync(adapterPath)) {
        res.status(400).json({ error: "No .quack/adapter.json found at path" });
        return;
      }

      // Load adapter
      const adapter = await loadAdapter(projectPath);

      // Generate project ID
      const projectId = generateProjectId(adapter.config.project.name);

      // Check duplicate
      if (registry.hasProject(projectId)) {
        res.status(409).json({ error: `Project ${projectId} is already registered` });
        return;
      }

      // Build project context
      const quackBin = path.resolve(__dirname, "..", "index.js");
      const context = buildProjectContext(adapter, quackBin, (stage, taskId, payload) => {
        sse.broadcast({
          sessionId: "dispatch",
          taskId,
          project: projectId,
          timestamp: new Date().toISOString(),
          stage,
          payload: payload as never,
        });
      });

      // Register project
      registry.register(context);

      // Start event watcher
      const stopProjectWatcher = await context.eventReader.watch(
        buildEventWatcherCallback({
          projectId: context.id,
          progressDet: context.progressDetector,
          velocityTracker: context.costVelocityTracker,
          dispatchMgr: context.dispatchManager,
          projRoot: context.rootPath,
          stuckCfg: adapter.config.stuckDetection,
          eventReader: context.eventReader,
          logDir: context.logDir,
          db: context.db,
          taskService: context.taskService,
        }),
      );
      context.stopWatcher = stopProjectWatcher;

      // Start progress detector
      context.progressDetector.startChecking();

      // Compute velocity baseline
      const summary = context.eventReader.getCostSummary();
      context.costVelocityTracker.computeBaseline(summary);

      // Persist to global config (non-fatal)
      try {
        const { registerProject: gcRegister } = await import("../core/global-config.js");
        gcRegister(projectPath);
      } catch {
        // Global config write failure â€” non-fatal
      }

      res.json({ ok: true, projectId, name: adapter.config.project.name, path: projectPath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.delete("/api/projects/:id", async (req: Request, res: Response) => {
    if (!registry) {
      res.status(404).json({ error: "Multi-project mode not enabled" });
      return;
    }

    const projectId = req.params.id as string;

    // Check project exists
    const context = registry.getProject(projectId);
    if (!context) {
      res.status(404).json({ error: `Project ${projectId} not found` });
      return;
    }

    // Check no active dispatches
    if (context.dispatchManager) {
      const activeJobs = context.dispatchManager.getActiveJobs();
      if (activeJobs.length > 0) {
        res.status(409).json({
          error: "Cannot unregister project with active dispatches. Stop all dispatches first.",
        });
        return;
      }
    }

    // Teardown services
    teardownProjectContext(context);

    // Unregister
    registry.unregister(projectId);

    // Persist removal to global config (non-fatal)
    try {
      const { unregisterProject: gcUnregister } = await import("../core/global-config.js");
      gcUnregister(context.rootPath);
    } catch {
      // Global config write failure â€” non-fatal
    }

    res.json({ ok: true, message: "Project unregistered" });
  });

  // â”€â”€â”€ Global Config Endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/config", async (_req: Request, res: Response) => {
    try {
      const { loadGlobalConfig } = await import("../core/global-config.js");
      const config = loadGlobalConfig();
      res.json(config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // â”€â”€â”€ GitHub Integration Endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.post("/api/github/import", async (req: Request, res: Response) => {
    try {
      const { issueNumber, label, autoDispatch } = req.body as {
        issueNumber?: number;
        label?: string;
        autoDispatch?: boolean;
      };

      const activeProject = registry?.getActiveProject();
      const adapter = activeProject?.adapter;
      if (!adapter) {
        res.status(400).json({ error: "No active project" });
        return;
      }

      const { importIssue, importIssuesByLabel } =
        await import("../integrations/github/import-pipeline.js");

      if (issueNumber) {
        const result = await importIssue(issueNumber, adapter, autoDispatch || false);
        res.json({ success: true, taskId: result.taskId, issueNumber: result.issueNumber });
      } else if (label) {
        const results = await importIssuesByLabel(label, adapter, autoDispatch || false);
        res.json({ success: true, tasks: results });
      } else {
        res.status(400).json({ error: "Must provide issueNumber or label" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/github/publish", async (req: Request, res: Response) => {
    try {
      const { taskId, allBacklog } = req.body as {
        taskId?: string;
        allBacklog?: boolean;
      };

      const activeProject = registry?.getActiveProject();
      const adapter = activeProject?.adapter;
      if (!adapter) {
        res.status(400).json({ error: "No active project" });
        return;
      }

      const githubConfig = adapter.config.integrations?.github;
      if (!githubConfig) {
        res.status(400).json({ error: "GitHub integration not configured" });
        return;
      }

      const { publishTask, publishAllBacklog } =
        await import("../integrations/github/issue-publisher.js");
      const { getSyncMap } = await import("../integrations/github/sync-map.js");

      if (allBacklog) {
        const outcome = await publishAllBacklog(
          adapter.projectRoot,
          adapter.config.project.taskDir,
          githubConfig,
        );
        // Update sync map for published tasks
        const syncMap = await getSyncMap(adapter.config);
        for (const result of outcome.published) {
          if (!syncMap.hasTask(result.taskId)) {
            syncMap.addEntry({
              taskId: result.taskId,
              issueNumber: result.issueNumber,
              direction: "published",
              createdAt: new Date().toISOString(),
              lastSyncedAt: new Date().toISOString(),
              issueState: "open",
              taskStatus: "BACKLOG",
            });
          }
        }
        await syncMap.save();
        res.json({
          success: outcome.skipped.length === 0,
          published: outcome.published,
          skipped: outcome.skipped,
        });
      } else if (taskId) {
        const result = await publishTask(
          taskId,
          adapter.projectRoot,
          githubConfig,
          adapter.config.project.taskDir,
        );
        const syncMap = await getSyncMap(adapter.config);
        syncMap.addEntry({
          taskId,
          issueNumber: result.issueNumber,
          direction: "published",
          createdAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          issueState: "open",
          taskStatus: "BACKLOG",
        });
        await syncMap.save();
        res.json({ success: true, issueNumber: result.issueNumber, url: result.url });
      } else {
        res.status(400).json({ error: "Must provide taskId or allBacklog" });
      }
    } catch (err: unknown) {
      if (err instanceof DuplicateClaimantAdmissionError) {
        rejectDuplicateClaimantCheck({ taskId: err.taskId, claimants: err.claimants }, res);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/github/sync", async (req: Request, res: Response) => {
    try {
      const { status: showStatus } = req.body as { status?: boolean };

      const activeProject = registry?.getActiveProject();
      const adapter = activeProject?.adapter;
      if (!adapter) {
        res.status(400).json({ error: "No active project" });
        return;
      }

      const { syncAllTasks, getSyncStatus } =
        await import("../integrations/github/status-syncer.js");

      if (showStatus) {
        const syncStatus = await getSyncStatus(adapter.config);
        res.json({ success: true, status: syncStatus });
      } else {
        const outcome = await syncAllTasks(adapter.config);
        const success = outcome.outcomes.every((row) => row.outcome !== "skipped");
        res.json({ success, ...outcome });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/github/sync-status", async (_req: Request, res: Response) => {
    try {
      const activeProject = registry?.getActiveProject();
      const adapter = activeProject?.adapter;
      if (!adapter) {
        res.json({ success: true, status: { totalEntries: 0, entries: [] } });
        return;
      }

      const { getSyncStatus } = await import("../integrations/github/status-syncer.js");
      const syncStatus = await getSyncStatus(adapter.config);
      const ghConfig = adapter.config.integrations?.github;
      res.json({
        success: true,
        status: syncStatus,
        repo: ghConfig ? { owner: ghConfig.owner, repo: ghConfig.repo } : null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // â”€â”€â”€ Domain-specific route modules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  registerTemplateRoutes(app, resolveProject);
  registerAnalyticsRoutes(app, resolveProject);
  registerGitHubSyncRoutes(app, resolveProject);
  registerTestResultsRoutes(app, resolveProject);
  registerResearchRoutes(app, resolveProject);
  registerTriageRoutes(app, resolveProject, authority);
  registerAgentResourcesRoutes(app);
  registerWikiRoutes(app, {
    quackRoot,
    wikiRoot: options.wikiRoot,
    requireServiceScopeWhenConfigured,
    requireServiceScopeAnyWhenConfigured,
  });
  registerWorktreeRoutes(app, { resolveProject });

  // ─── Admin endpoints ─────────────────────────────────────────────
  // Branch sweep, operational tooling (TASK-898).
  registerAdminRoutes(app, { resolveProject });

  registerWorkerEnrollmentRoutes(app, {
    resolveProject,
    authService,
    requireServiceScope,
    requireServiceScopeAny,
  });

  // â”€â”€â”€ SSE endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.get("/api/events/stream", (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    sse.addClient(res, sessionId, req);
  });

  // â”€â”€â”€ Fallback to index.html â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (uiAssets.mode !== "headless") {
    app.get(`${uiAssets.legacyRoute}`, (_req: Request, res: Response) => {
      res.sendFile(path.join(uiAssets.legacyDir, "index.html"));
    });

    app.get(
      `${uiAssets.legacyRoute}/*`,
      (req: Request, res: Response, next: express.NextFunction) => {
        if (!shouldServeAppShell(req)) {
          next();
          return;
        }
        res.sendFile(path.join(uiAssets.legacyDir, "index.html"));
      },
    );

    app.get("*", (req: Request, res: Response, next: express.NextFunction) => {
      if (!shouldServeAppShell(req)) {
        next();
        return;
      }
      res.sendFile(path.join(uiAssets.rootDir, "index.html"));
    });
  }

  // â”€â”€â”€ Express global error middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Must be the LAST app.use() â€” catches thrown errors in route handlers.
  // Without this, an unhandled error in any async route kills the process.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("[monitor] Unhandled route error (non-fatal):", err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", message: err.message });
    }
  });

  // â”€â”€â”€ Start function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // â”€â”€â”€ Event watcher callback builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Builds the callback that bridges JSONL events â†’ SSE, progress
  // detection, fleet budget, velocity tracking, and heartbeat lifecycle.
  // Used for both legacy single-project mode and per-project contexts.
  function buildEventWatcherCallback(services: {
    projectId: string;
    progressDet: ProgressDetector;
    velocityTracker: CostVelocityTracker;
    dispatchMgr: DispatchManager | null;
    projRoot: string | undefined;
    stuckCfg: StuckDetectionConfig | undefined;
    eventReader: EventReader;
    logDir: string;
    db: QuackDB | NoopDB;
    taskService: TaskService | null;
  }): (event: QuackEvent) => void {
    return (event: QuackEvent) => {
      let claimantIndexPromise: Promise<DuplicateClaimantIndex> | undefined;
      const claimantIndex = (): Promise<DuplicateClaimantIndex> => {
        claimantIndexPromise ??= buildFederationClaimantIndexModule({
          taskService: services.taskService,
        } as FederationProjectContext);
        return claimantIndexPromise;
      };
      const emitPositiveTokenRefusal = (message: string, failedStage: string): void => {
        const writer = new EventWriter({
          sessionId: event.sessionId,
          taskId: event.taskId,
          project: services.projectId,
          logDir: services.logDir,
        });
        writer.emit("loop_finalize_record_failed", {
          taskId: event.taskId,
          error: message,
          failedStage,
        } as EventPayload);
      };
      const setStatusWithPositiveGuard = (
        taskId: string,
        status: string,
        source: string,
        failedStage: string,
      ): void => {
        if (status !== "COMPLETE" && status !== "VERIFIED") {
          services.db.setStatus(taskId, status, source);
          return;
        }
        void claimantIndex()
          .then((index) => {
            const refusal = duplicateClaimantRefusalForIndex(index, taskId);
            if (refusal) {
              emitPositiveTokenRefusal(refusal.message, failedStage);
              return;
            }
            services.db.setStatus(taskId, status, source);
          })
          .catch((err: unknown) => {
            emitPositiveTokenRefusal(err instanceof Error ? err.message : String(err), failedStage);
          });
      };
      // Ensure event carries the correct project ID
      const tagged = { ...event, project: services.projectId };
      sse.broadcast(tagged);

      // Feed events to progress detector for stuck agent detection
      services.progressDet.processEvent(tagged);

      // â”€â”€â”€ DB: Record session completion and update task status â”€â”€â”€â”€â”€
      if (event.stage === "session_complete" && event.payload) {
        const pl = event.payload as SessionCompletePayload;
        const outcome = pl.outcome ?? "unknown";
        // Preserve start_time from session_start entry
        const existingSession = services.db.getLatestSession(event.taskId);
        // Title from sessions.jsonl completed entry (has title field)
        const plTitle = "title" in pl && typeof pl.title === "string" ? pl.title : null;
        services.db.upsertSession({
          session_id: event.sessionId,
          task_id: event.taskId,
          project: services.projectId,
          title: plTitle ?? existingSession?.title ?? null,
          start_time: existingSession?.start_time ?? event.timestamp,
          status: "completed",
          outcome,
          total_cost_usd: pl.totalCostUsd ?? null,
          duration_ms: pl.durationMs ?? null,
          turns_used: "turnsUsed" in pl && typeof pl.turnsUsed === "number" ? pl.turnsUsed : null,
        });
        // Update task status based on outcome
        if (outcome === "approved") {
          setStatusWithPositiveGuard(
            event.taskId,
            "COMPLETE",
            "session_approved",
            "session_approved",
          );
        } else if (outcome === "rejected" || outcome === "agent_failed") {
          services.db.setStatus(event.taskId, "REJECTED", "session_" + outcome);
        }

        void claimantIndex()
          .then((index) =>
            recordLoopFinalization(authority.stateAuthority, event.taskId, pl, {
              project: { projectRoot: services.projRoot, db: services.db },
              getCriteriaCount: async (taskId) => {
                const task = await services.taskService?.getTask(taskId);
                return task?.successCriteria.length ?? 0;
              },
              claimantIndex: index,
            }),
          )
          .then((finalizeResult) => {
            if (finalizeResult.attempted) {
              if (finalizeResult.record.refusal) {
                emitPositiveTokenRefusal(finalizeResult.record.refusal.message, "loop_finalize");
                return;
              }
              sse.broadcast({
                sessionId: event.sessionId,
                taskId: event.taskId,
                project: services.projectId,
                timestamp: new Date().toISOString(),
                stage: "loop_finalize_recorded",
                payload: {
                  taskId: event.taskId,
                  commit: finalizeResult.commit,
                  applied: finalizeResult.record.applied,
                  reason: finalizeResult.record.skippedReason,
                },
              });
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            sse.broadcast({
              sessionId: event.sessionId,
              taskId: event.taskId,
              project: services.projectId,
              timestamp: new Date().toISOString(),
              stage: "loop_finalize_record_failed",
              payload: {
                taskId: event.taskId,
                commit: pl.mergeCommitSha ?? "",
                error: message,
              },
            });
          });
      }

      // Record dispatch cost when session completes
      if (event.stage === "session_complete" && event.payload) {
        const totalCost = (event.payload as { totalCostUsd?: number }).totalCostUsd;
        if (typeof totalCost === "number" && totalCost > 0) {
          // Extract the key ID from the dispatch job for per-key cost tracking
          const completedJob = services.dispatchMgr?.getJob(event.taskId);
          const keyId = completedJob?.keyId;
          fleetBudget.recordDispatchCost(event.taskId, totalCost, keyId);

          // Feed cost data to velocity tracker
          const durationMs = (event.payload as { durationMs?: number }).durationMs;
          if (typeof durationMs === "number" && durationMs > 0) {
            services.velocityTracker.recordCostUpdate(event.taskId, totalCost, durationMs);
          }
        }

        // Clean up velocity tracker, heartbeat, and progress watcher on session end
        services.velocityTracker.removeTracking(event.taskId);
        const hb = activeHeartbeats.get(event.taskId);
        if (hb) {
          hb.stop();
          activeHeartbeats.delete(event.taskId);
        }
        const pw = activeProgressWatchers.get(event.taskId);
        if (pw) {
          pw.stop().catch((err: unknown) =>
            console.error(
              "[monitor] progress watcher close error (non-fatal):",
              err instanceof Error ? err.message : err,
            ),
          );
          activeProgressWatchers.delete(event.taskId);
        }

        // Emit revision_complete if this was a revision dispatch
        if (activeRevisions.has(event.taskId)) {
          activeRevisions.delete(event.taskId);
          const outcome = (event.payload as { outcome?: string }).outcome ?? "unknown";
          sse.broadcast({
            sessionId: event.sessionId,
            taskId: event.taskId,
            project: services.projectId,
            timestamp: new Date().toISOString(),
            stage: "revision_complete",
            payload: {
              taskId: event.taskId,
              outcome,
              costUsd: totalCost ?? 0,
              turnsUsed: (event.payload as { turnsUsed?: number }).turnsUsed ?? 0,
            },
          });
        }

        // Refresh ccusage cache when a Quack session completes
        triggerCcusageRefresh();

        // Append research analysis for this session (non-fatal)
        try {
          if (services.projRoot) {
            const store = new ResearchStore(services.projRoot);
            store.appendAnalysis(event.sessionId, services.eventReader, services.projRoot);
          }
        } catch (researchErr: unknown) {
          console.error(
            "[monitor] research analysis error (non-fatal):",
            researchErr instanceof Error ? researchErr.message : researchErr,
          );
        }
      }

      // â”€â”€â”€ DB: Record session error â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // TASK-1332 (QPI-045, round-3 R3-6): a spec-staleness refusal leaves
      // the task at IN_PROGRESS, set by the start route, with nothing to
      // reset it — so a task that merely needs a replan looks like it is
      // still running and is ineligible for everything. I claimed this
      // needed a design decision; the review refuted that, and it was
      // right: the restoration helper already exists and this watcher
      // already holds the project DB.
      if (event.stage === "spec_identity_stale" && event.taskId) {
        try {
          restoreTaskStatusFromInProgress(
            { db: services.db },
            event.taskId,
            "spec_changed_refusal",
          );
        } catch (statusErr: unknown) {
          console.error(
            "[monitor] spec-stale status restore failed (non-fatal):",
            statusErr instanceof Error ? statusErr.message : statusErr,
          );
        }

        // Round-5 (R5-6) fixed the misreport: the refusal used to ride in
        // on a `session_error`, the DB got an ERROR row, and the session
        // APIs, which prefer the DB row over the session log's
        // `spec_changed`, showed a deliberate refusal as a crash.
        //
        // Round 6 (R6-2) then moved the REPLACEMENT out of here. The first
        // cut wrote the DB row and did the tracker cleanup in this
        // handler, which duplicated the `session_complete` branch below
        // and still left `ProgressDetector`, the dashboard and the
        // workflow projector with no terminal signal at all. The
        // dispatcher now emits `session_complete { outcome:
        // "spec_changed" }` alongside this event, the same shape
        // `gate_failed` has always used, so all of that is handled once,
        // in the path that already does it. This handler keeps only the
        // task-status restore, which is genuinely its own concern.
      }

      if (event.stage === "session_error") {
        services.db.upsertSession({
          session_id: event.sessionId,
          task_id: event.taskId,
          project: services.projectId,
          title: null,
          start_time: event.timestamp,
          status: "error",
          outcome: "error",
          total_cost_usd: null,
          duration_ms: null,
          turns_used: null,
        });
      }

      // Also clean up on session error
      if (event.stage === "session_error") {
        services.velocityTracker.removeTracking(event.taskId);
        const hb = activeHeartbeats.get(event.taskId);
        if (hb) {
          hb.stop();
          activeHeartbeats.delete(event.taskId);
        }
        const pw = activeProgressWatchers.get(event.taskId);
        if (pw) {
          pw.stop().catch((err: unknown) =>
            console.error(
              "[monitor] progress watcher close error (non-fatal):",
              err instanceof Error ? err.message : err,
            ),
          );
          activeProgressWatchers.delete(event.taskId);
        }
      }

      // â”€â”€â”€ DB: Lifecycle events â€” task status changes from dispatcher â”€
      if (event.stage === "lifecycle_status_updated" && event.payload) {
        const pl = event.payload as Record<string, unknown>;
        const taskId = (pl.taskId as string) ?? event.taskId;
        const newStatus = pl.newStatus as string;
        if (taskId && newStatus) {
          setStatusWithPositiveGuard(taskId, newStatus, "lifecycle", "lifecycle_status_updated");
        }
      }
      if (event.stage === "lifecycle_blocker_resolved" && event.payload) {
        const pl = event.payload as Record<string, unknown>;
        const promotedTaskId = pl.taskId as string;
        const newStatus = (pl.newStatus as string) ?? "READY";
        if (promotedTaskId) {
          setStatusWithPositiveGuard(
            promotedTaskId,
            newStatus,
            "blocker_resolved",
            "lifecycle_blocker_resolved",
          );
        }
      }
      if (event.stage === "lifecycle_parent_completed" && event.payload) {
        const pl = event.payload as Record<string, unknown>;
        const parentId = pl.parentTaskId as string;
        if (parentId) {
          setStatusWithPositiveGuard(parentId, "COMPLETE", "parent_completed", "parent_completed");
        }
      }

      // â”€â”€â”€ DB: Verified entry from lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (event.stage === "lifecycle_complete" && event.payload) {
        const pl = event.payload as Record<string, unknown>;
        const taskId = (pl.taskId as string) ?? event.taskId;
        const verdict = pl.verdict as string;
        if (taskId && verdict) {
          const persistLifecycleVerdict = (): void =>
            services.db.setVerified({
              task_id: taskId,
              verified_at: new Date().toISOString().split("T")[0],
              commit_sha: (pl.commitSha as string) ?? "unknown",
              method: "pipeline",
              verdict,
              criteria_checked: (pl.criteriaChecked as number) ?? 0,
              criteria_passed: (pl.criteriaPassed as number) ?? 0,
              notes: (pl.notes as string) ?? null,
            });
          if (verdict === "VERIFIED" || verdict === "SOFT-VERIFIED") {
            void claimantIndex().then((index) => {
              const refusal = duplicateClaimantRefusalForIndex(index, taskId);
              if (refusal) {
                emitPositiveTokenRefusal(refusal.message, "lifecycle_complete");
                return;
              }
              persistLifecycleVerdict();
            });
          } else {
            persistLifecycleVerdict();
          }
        }
      }

      // â”€â”€â”€ DB: Record session start and set task IN_PROGRESS â”€â”€â”€â”€â”€â”€â”€â”€
      if (event.stage === "session_start" && event.taskId) {
        services.db.upsertSession({
          session_id: event.sessionId,
          task_id: event.taskId,
          project: services.projectId,
          title: null, // Title resolved at API read time from task list
          start_time: event.timestamp,
          status: "active",
          outcome: null,
          total_cost_usd: null,
          duration_ms: null,
          turns_used: null,
        });
        services.db.setStatus(event.taskId, "IN_PROGRESS", "session_start");
      }

      // Start file heartbeat and progress watcher when a new session begins
      if (event.stage === "session_start" && event.taskId) {
        const job = services.dispatchMgr?.getJob(event.taskId);
        const workDir = job?.worktreePath ?? services.projRoot;
        if (workDir && services.stuckCfg?.fileHeartbeat !== false) {
          const hb = new FileHeartbeat(workDir);
          hb.start();
          activeHeartbeats.set(event.taskId, hb);
        }
        // Start watching PROGRESS.md for live dashboard updates
        if (workDir) {
          import("../dispatcher/progress-watcher.js")
            .then(({ ProgressWatcher }) => {
              const watcher = ProgressWatcher.watch(workDir, (progress) => {
                sse.broadcast({
                  sessionId: event.sessionId,
                  taskId: event.taskId,
                  project: services.projectId,
                  timestamp: new Date().toISOString(),
                  stage: "agent_progress_update",
                  payload: {
                    taskId: event.taskId,
                    ...progress,
                  } as never,
                });
              });
              activeProgressWatchers.set(event.taskId, watcher);
            })
            .catch(() => {
              // Non-fatal: progress watching is best-effort
            });
        }
      }

      // Feed cost updates to velocity tracker on per-turn cost data
      if (event.stage === "agent_complete" && event.payload) {
        const payload = event.payload as { totalCostUsd?: number; turnsUsed?: number };
        if (typeof payload.totalCostUsd === "number" && payload.totalCostUsd > 0) {
          const job = services.dispatchMgr?.getJob(event.taskId);
          const elapsedMs = job ? Date.now() - new Date(job.startedAt).getTime() : 0;
          if (elapsedMs > 0) {
            const snapshot = services.velocityTracker.recordCostUpdate(
              event.taskId,
              payload.totalCostUsd,
              elapsedMs,
            );
            // Check for velocity anomaly â†’ emit warning/kill events
            if (snapshot.status === "critical") {
              const killCheck = services.velocityTracker.shouldKill(event.taskId);
              if (killCheck.kill) {
                services.dispatchMgr?.stop(event.taskId);
                services.velocityTracker.markVelocityKilled(event.taskId);
                sse.broadcast({
                  sessionId: "cost-velocity",
                  taskId: event.taskId,
                  project: services.projectId,
                  timestamp: new Date().toISOString(),
                  stage: "cost_velocity_kill",
                  payload: {
                    taskId: event.taskId,
                    costPerMinute: snapshot.costPerMinute,
                    medianCostPerMinute: snapshot.medianCostPerMinute,
                    multiplier: snapshot.multiplier,
                    totalCostUsd: snapshot.currentCostUsd,
                    message: killCheck.reason,
                  } as never,
                });
              }
            } else if (snapshot.status === "warning") {
              sse.broadcast({
                sessionId: "cost-velocity",
                taskId: event.taskId,
                project: services.projectId,
                timestamp: new Date().toISOString(),
                stage: "cost_velocity_warning",
                payload: {
                  taskId: event.taskId,
                  costPerMinute: snapshot.costPerMinute,
                  medianCostPerMinute: snapshot.medianCostPerMinute,
                  multiplier: snapshot.multiplier,
                  message: `Cost velocity ${snapshot.multiplier.toFixed(1)}x above baseline`,
                } as never,
              });
            }
          }
        }
      }

      // Pipe file heartbeat signals into progress detector
      for (const [taskId, hb] of activeHeartbeats) {
        const mod = hb.getLastModification();
        if (mod && Date.now() - mod.timestamp < 5000) {
          services.progressDet.recordFileActivity(taskId);
        }
      }
    };
  }

  async function start(): Promise<{ port: number; stop: () => Promise<void> }> {
    // â”€â”€â”€ Process crash handlers (Phase A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Install BEFORE anything else so crashes during initialization are captured.

    // Ensure log directory exists for crash logs
    const crashLogDir = logDir || path.join(projectRoot || ".", ".quack", "logs");
    try {
      fs.mkdirSync(crashLogDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const crashLogPath = path.join(crashLogDir, "monitor-crash.log");

    const onUncaughtException = (err: Error) => {
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack ?? "no stack"}\n\n`;
      try {
        fs.appendFileSync(crashLogPath, entry, "utf-8");
      } catch {
        // Last resort: write to stderr
        process.stderr.write(entry);
      }
      console.error("[monitor] FATAL uncaughtException:", err.message);
      // Attempt graceful shutdown before exit
      try {
        dispatchManager?.killAll();
        sse.closeAll();
      } catch {
        /* best effort */
      }
      process.exit(1);
    };

    const onUnhandledRejection = (reason: unknown) => {
      const timestamp = new Date().toISOString();
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      const entry = `[${timestamp}] UNHANDLED REJECTION: ${msg}\n${stack ?? "no stack"}\n\n`;
      try {
        fs.appendFileSync(crashLogPath, entry, "utf-8");
      } catch {
        /* ignore */
      }
      console.error("[monitor] unhandledRejection (non-fatal):", msg);
      // Do NOT crash â€” log and continue (Node 15+ behavior)
    };
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);

    // Collect stop functions for all project event watchers
    const projectWatcherStops: Array<() => void> = [];
    const startupValidationTasks: Array<Promise<void>> = [];

    // â”€â”€â”€ Multi-project initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (useMultiProject && registry && projectAdapters) {
      const quackBin = path.resolve(__dirname, "..", "index.js");

      for (const adapter of projectAdapters) {
        const context = buildProjectContext(adapter, quackBin, (stage, taskId, payload) => {
          const projectId = generateProjectId(adapter.config.project.name);
          sse.broadcast({
            sessionId: "dispatch",
            taskId,
            project: projectId,
            timestamp: new Date().toISOString(),
            stage,
            payload: payload as never,
          });
        });
        registry.register(context);

        // Start event watcher for this project's log directory
        const projId = context.id;
        const stopProjectWatcher = await context.eventReader.watch(
          buildEventWatcherCallback({
            projectId: projId,
            progressDet: context.progressDetector,
            velocityTracker: context.costVelocityTracker,
            dispatchMgr: context.dispatchManager,
            projRoot: context.rootPath,
            stuckCfg: adapter.config.stuckDetection,
            eventReader: context.eventReader,
            logDir: context.logDir,
            db: context.db,
            taskService: context.taskService,
          }),
        );
        context.stopWatcher = stopProjectWatcher;
        projectWatcherStops.push(stopProjectWatcher);

        // Start progress detector for this project
        context.progressDetector.startChecking();

        // Compute initial velocity baseline
        const summary = context.eventReader.getCostSummary();
        context.costVelocityTracker.computeBaseline(summary);

        // On startup, mark all "active" sessions as orphaned (no child processes yet)
        const projOrphanCount = context.eventReader.cleanupOrphanedSessions();
        if (projOrphanCount > 0) {
          console.log(`[${context.name}] Cleaned up ${projOrphanCount} orphaned session(s)`);
        }
        const projDbOrphanCount = cleanupOrphanedDbDispatchSessions(
          resolvedProjectFromContext(context),
        );
        if (projDbOrphanCount > 0) {
          console.log(`[${context.name}] Cleaned up ${projDbOrphanCount} orphaned DB session(s)`);
        }

        // Start TaskWatcher for this project (auto-discovery + repair + preflight)
        try {
          const { TaskWatcher } = await import("./task-watcher.js");
          const projTaskDir = path.resolve(context.rootPath, adapter.config.project.taskDir);
          const readiness = new ReadinessService({
            projectRoot: context.rootPath,
            taskService: context.taskService,
            prepCache: context.prepCache,
            db: context.db,
          });
          const projTw = new TaskWatcher(
            projTaskDir,
            adapter,
            {
              onNewTask: (task, filePath) => {
                sse.broadcast({
                  sessionId: "task-watcher",
                  taskId: task.id,
                  project: context.id,
                  timestamp: new Date().toISOString(),
                  stage: "task_discovered" as never,
                  payload: { taskId: task.id, filePath, status: task.status } as never,
                });
                console.log(
                  `[task-watcher][${context.name}] Discovered ${task.id} (${task.status})`,
                );
              },
              onRepaired: (twTaskId, filePath, sectionsAdded) => {
                sse.broadcast({
                  sessionId: "task-watcher",
                  taskId: twTaskId,
                  project: context.id,
                  timestamp: new Date().toISOString(),
                  stage: "task_repaired" as never,
                  payload: { taskId: twTaskId, filePath, sectionsAdded } as never,
                });
                console.log(
                  `[task-watcher][${context.name}] Repaired ${twTaskId}: added ${sectionsAdded.join(", ")}`,
                );
              },
              onRepairFailed: (twTaskId, filePath, error) => {
                sse.broadcast({
                  sessionId: "task-watcher",
                  taskId: twTaskId,
                  project: context.id,
                  timestamp: new Date().toISOString(),
                  stage: "task_repair_failed" as never,
                  payload: { taskId: twTaskId, filePath, error } as never,
                });
                console.log(
                  `[task-watcher][${context.name}] Repair failed for ${twTaskId}: ${error}`,
                );
              },
              onPreflightQueued: (twTaskId) => {
                sse.broadcast({
                  sessionId: "task-watcher",
                  taskId: twTaskId,
                  project: context.id,
                  timestamp: new Date().toISOString(),
                  stage: "task_preflight_queued" as never,
                  payload: { taskId: twTaskId } as never,
                });
              },
              onTerminalStatus: (twTaskId, status) => {
                // TASK-1318 (P2-4): the TASK-914 propagation is RETIRED.
                // It wrote terminal spec `Status:` lines into task_status,
                // which made the human-editable projection a SOURCE for the
                // store the dispatcher trusts — the exact inversion of
                // design principle 5. Operator decided 2026-08-06 to retire it.
                //
                // Availability is preserved because every DB-first reader
                // falls back to spec status when no row exists
                // (federation/scheduling.ts:109, the TASK-1202 overlay, and
                // the 1317 resolver whose precedence ends at `spec`). A
                // NONTERMINAL row now beats a later terminal spec edit,
                // which is the intended semantics rather than a regression.
                //
                // The OBSERVATION is kept and widened: drift is reported
                // whenever the spec's terminal claim differs from the row,
                // not only when the row holds a conflicting terminal.
                const db = context.db;
                if (!db) return;
                const current = db.getStatus(twTaskId)?.status;
                if (current === undefined) return; // rowless is the normal fallback state, not drift
                if (current === status) return; // agreement
                sse.broadcast({
                  sessionId: "task-watcher",
                  taskId: twTaskId,
                  project: context.id,
                  timestamp: new Date().toISOString(),
                  stage: "task_status_drift" as never,
                  payload: { taskId: twTaskId, specStatus: status, dbStatus: current } as never,
                });
              },
            },
            {
              autoRepair: false,
              autoPreflight: !!context.prepWorker,
              isPreflightCurrent: context.prepWorker
                ? (twTaskId, contentHash) =>
                    readiness.isPreflightCurrentForHash(twTaskId, contentHash)
                : undefined,
              queuePreflight: context.prepWorker
                ? (twTaskId) => {
                    context.prepWorker!.start(twTaskId);
                  }
                : undefined,
            },
          );

          projTw
            .start()
            .catch((err: unknown) =>
              console.error(
                `[task-watcher][${context.name}] start error (non-fatal):`,
                err instanceof Error ? err.message : err,
              ),
            );
          context.taskWatcher = projTw;
          console.log(`[task-watcher][${context.name}] Watching for task file changes`);
        } catch {
          // TaskWatcher init failed â€” non-fatal, skip
        }
      }

      await applyPersistedActiveProjectSelection();
      console.log(`Initialized ${registry.count()} project(s)`);

      // Load fleet budget from the active project adapter. This keeps restarts
      // aligned with the persisted active project instead of the first config entry.
      const activeContext = registry.getActiveProject();
      if (activeContext) {
        const activeAdapterPath = path.resolve(activeContext.rootPath, ".quack", "adapter.json");
        if (fs.existsSync(activeAdapterPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(activeAdapterPath, "utf-8")) as Record<
              string,
              unknown
            >;
            const fb = raw.fleetBudget as Record<string, unknown> | undefined;
            if (fb) {
              fleetBudget.updateConfig({
                dailyCapUsd: typeof fb.dailyCapUsd === "number" ? fb.dailyCapUsd : 25.0,
                hourlyCapUsd: typeof fb.hourlyCapUsd === "number" ? fb.hourlyCapUsd : 10.0,
                perWaveCapUsd: typeof fb.perWaveCapUsd === "number" ? fb.perWaveCapUsd : 15.0,
                alertThresholds: Array.isArray(fb.alertThresholds)
                  ? (fb.alertThresholds as number[])
                  : [50, 75, 90],
                enforceHard: fb.enforceHard !== false,
              });
              console.log(
                `[fleet-budget] Loaded from ${activeContext.name}: daily=$${String(fb.dailyCapUsd)}, hourly=$${String(fb.hourlyCapUsd)}, wave=$${String(fb.perWaveCapUsd)}`,
              );
            }
          } catch {
            /* adapter parse error â€” keep defaults */
          }
        }
      }
    }

    // On startup, mark ALL "active" sessions as errors â€” no child processes
    // are running yet, so any "active" session is orphaned from a crash/kill.
    const orphanedCount = reader.cleanupOrphanedSessions();
    if (orphanedCount > 0) {
      console.log(`Cleaned up ${orphanedCount} orphaned session(s) from previous run`);
    }
    const dbOrphanedCount = cleanupOrphanedDbDispatchSessions(resolveProject());
    if (dbOrphanedCount > 0) {
      console.log(`Cleaned up ${dbOrphanedCount} orphaned DB session(s) from previous run`);
    }

    // Clean up leaked heartbeats and progress watchers from crashed sessions.
    // These Maps accumulate across restarts because session_complete never fires
    // for crashed sessions, leading to EMFILE (file descriptor exhaustion).
    for (const hb of activeHeartbeats.values()) {
      try {
        hb.stop();
      } catch {
        /* best effort */
      }
    }
    activeHeartbeats.clear();
    for (const pw of activeProgressWatchers.values()) {
      try {
        void pw.stop();
      } catch {
        /* best effort */
      }
    }
    activeProgressWatchers.clear();

    // â”€â”€â”€ SIGINT/SIGTERM graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Clean up all watchers, heartbeats, and child processes on signal.
    const gracefulShutdown = (signal: string) => {
      console.log(`[monitor] Received ${signal}, shutting down gracefully...`);
      for (const [, hb] of activeHeartbeats) {
        try {
          hb.stop();
        } catch {
          /* best effort */
        }
      }
      activeHeartbeats.clear();
      for (const [, pw] of activeProgressWatchers) {
        try {
          void pw.stop();
        } catch {
          /* best effort */
        }
      }
      activeProgressWatchers.clear();
      try {
        dispatchManager?.killAll();
      } catch {
        /* best effort */
      }
      try {
        adminRuns.stopAll();
      } catch {
        /* best effort */
      }
      try {
        legacyDb.close();
      } catch {
        /* best effort */
      }
      if (registry) {
        for (const ctx of registry.listProjects()) {
          try {
            ctx.db.close();
          } catch {
            /* best effort */
          }
        }
      }
      try {
        sse.closeAll();
      } catch {
        /* best effort */
      }
      process.exit(0);
    };
    const onSigint = () => gracefulShutdown("SIGINT");
    const onSigterm = () => gracefulShutdown("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    // Verify Docker availability on startup when Docker isolation is configured
    if (isolationConfig?.method === "docker" && dispatchManager) {
      try {
        const version = await dispatchManager.checkDockerAvailability();
        console.log(`Docker isolation enabled (Docker ${version})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Docker isolation is configured but Docker is not available: ${msg}`);
      }
    }

    // Start file watcher to bridge JSONL changes â†’ SSE (legacy single-project mode)
    const stopWatcher = await reader.watch(
      buildEventWatcherCallback({
        projectId: legacyProjectId,
        progressDet: progressDetector,
        velocityTracker: costVelocityTracker,
        dispatchMgr: dispatchManager,
        projRoot: projectRoot,
        stuckCfg: stuckDetectionConfig,
        eventReader: reader,
        logDir: logDir ?? path.join(projectRoot ?? quackRoot, ".quack", "logs"),
        db: legacyDb,
        taskService,
      }),
    );

    // Start progress detector periodic checks
    progressDetector.startChecking();

    // Recompute velocity baseline periodically (every 5 minutes)
    const baselineInterval = setInterval(
      () => {
        try {
          // Legacy single-project baseline
          const summary = reader.getCostSummary();
          costVelocityTracker.computeBaseline(summary);

          // Multi-project baselines
          if (registry) {
            for (const ctx of registry.listProjects()) {
              const projSummary = ctx.eventReader.getCostSummary();
              ctx.costVelocityTracker.computeBaseline(projSummary);
            }
          }
        } catch (err) {
          console.error(
            "[monitor] Baseline interval error (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        }
      },
      5 * 60 * 1000,
    ).unref();

    const runSessionRecoverySweep = (): SessionRecoverySweepSummary => {
      const lastRunAt = new Date().toISOString();
      const recoveredProjects: SessionRecoveryProjectSummary[] = [];

      if (!registry) {
        const legacyRecovered = cleanupInactiveDbDispatchSessions(
          // TASK-1329: logDir lets the sweep spare runs paused at a human gate.
          { db: legacyDb, dispatchManager, logDir },
          DEFAULT_STALE_DB_SESSION_MAX_AGE_MS,
        );
        if (legacyRecovered.cleaned > 0) {
          console.log(
            `[cleanup] Recovered ${legacyRecovered.cleaned} DB dispatch session(s): ${legacyRecovered.recoveredTaskIds.join(", ")}`,
          );
        }
        recoveredProjects.push({
          projectId: legacyProjectId,
          projectName: legacyProjectName ?? legacyProjectId,
          cleaned: legacyRecovered.cleaned,
          recoveredTaskIds: legacyRecovered.recoveredTaskIds,
          reasons: legacyRecovered.reasons,
        });
      }

      if (registry) {
        for (const ctx of registry.listProjects()) {
          const projRecovered = cleanupInactiveDbDispatchSessions(
            // TASK-1329: per-project logDir, same reason as the legacy path.
            { db: ctx.db, dispatchManager: ctx.dispatchManager, logDir: ctx.logDir },
            DEFAULT_STALE_DB_SESSION_MAX_AGE_MS,
          );
          if (projRecovered.cleaned > 0) {
            console.log(
              `[cleanup][${ctx.name}] Recovered ${projRecovered.cleaned} DB dispatch session(s): ${projRecovered.recoveredTaskIds.join(", ")}`,
            );
          }
          recoveredProjects.push({
            projectId: ctx.id,
            projectName: ctx.name,
            cleaned: projRecovered.cleaned,
            recoveredTaskIds: projRecovered.recoveredTaskIds,
            reasons: projRecovered.reasons,
          });
        }
      }

      lastSessionRecoverySummary = summarizeSessionRecoverySweep(recoveredProjects, lastRunAt);
      return lastSessionRecoverySummary;
    };

    lastSessionRecoverySummary = runSessionRecoverySweep();

    // â”€â”€â”€ Periodic cleanup: stale sessions + completed jobs â”€â”€â”€â”€â”€â”€â”€â”€
    // Runs every 60 seconds to prune:
    //  - Completed/failed dispatch jobs older than 5 minutes from memory
    //  - "active" sessions with no events for >2 hours (mark as error)
    const cleanupInterval = setInterval(() => {
      try {
        runSessionRecoverySweep();
        dispatchManager?.cleanup(5 * 60 * 1000);
        const staleCleaned = reader.cleanupStaleSessions();
        if (staleCleaned > 0) {
          console.log(`[cleanup] Marked ${staleCleaned} stale session(s) as error`);
        }

        // Multi-project cleanup
        if (registry) {
          for (const ctx of registry.listProjects()) {
            ctx.dispatchManager?.cleanup(5 * 60 * 1000);
            const projCleaned = ctx.eventReader.cleanupStaleSessions();
            if (projCleaned > 0) {
              console.log(`[cleanup][${ctx.name}] Marked ${projCleaned} stale session(s) as error`);
            }
          }
        }
      } catch (err) {
        console.error(
          "[monitor] Cleanup interval error (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
    }, 60 * 1000).unref();

    // â”€â”€â”€ Task freshness monitor (Fix 1 + Fix 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const stopFreshnessMonitors: Array<() => Promise<void>> = [];
    if (taskService && taskDir) {
      const absTaskDir = path.resolve(projectRoot ?? "", taskDir);
      // Fix 3: startup validation
      startupValidationTasks.push(
        taskService.startupValidation().catch((err: unknown) => {
          console.error(
            "[task-freshness] Startup validation error (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        }),
      );
      // Fix 1: periodic re-scan
      stopFreshnessMonitors.push(
        startFreshnessMonitor({
          taskDir: absTaskDir,
          intervalMs: 60_000,
          getLastParsedCount: () => taskService.getLastParsedCount(),
          onDrift: (diskCount, parsedCount) => {
            sse.broadcast({
              sessionId: "monitor",
              taskId: "",
              project: resolveProject().projectId,
              timestamp: new Date().toISOString(),
              stage: "tasks_stale",
              payload: { diskCount, parsedCount, drift: diskCount - parsedCount },
            });
          },
        }),
      );
    }
    // Multi-project freshness monitors
    if (registry) {
      for (const ctx of registry.listProjects()) {
        if (ctx.taskService && ctx.adapter) {
          const td = path.resolve(ctx.adapter.projectRoot, ctx.adapter.config.project.taskDir);
          startupValidationTasks.push(
            ctx.taskService.startupValidation().catch(() => {
              /* non-fatal */
            }),
          );
          stopFreshnessMonitors.push(
            startFreshnessMonitor({
              taskDir: td,
              intervalMs: 60_000,
              getLastParsedCount: () => ctx.taskService!.getLastParsedCount(),
              onDrift: (diskCount, parsedCount) => {
                sse.broadcast({
                  sessionId: "monitor",
                  taskId: "",
                  project: ctx.name,
                  timestamp: new Date().toISOString(),
                  stage: "tasks_stale",
                  payload: { diskCount, parsedCount, drift: diskCount - parsedCount },
                });
              },
            }),
          );
        }
      }
    }

    // ─── Record-on-merge scanner (TASK-1201) ────────────────────────
    // Records completion-shaped merges on the adapter base branch as
    // SOFT-VERIFIED via the canonical writer, so manual-loop work stops
    // being invisible to the ledger. One recorder per projectRoot.
    const stopOnMergeRecorders: (() => void)[] = [];
    const onMergeStartedRoots = new Set<string>();

    // TASK-1204: one deps builder for both recording scans. The profile is
    // the only difference between the live tick scanner and the backfill,
    // so the guard, task lookup, queue hook, and SSE wiring stay identical
    // by construction.
    const buildOnMergeScanDeps = (
      proj: ResolvedProject,
      baseBranch: string,
      profile: { method: "on-merge" | "migration-scan"; notesPrefix: string } = {
        method: "on-merge",
        notesPrefix: "on-merge",
      },
    ): BackfillDeps | null => {
      const projectRoot = proj.projectRoot;
      const projTaskService = proj.taskService;
      if (!projectRoot || !projTaskService) return null;
      return {
        projectRoot,
        baseBranch,
        taskExists: async (taskId: string) => {
          try {
            const task = await projTaskService.getTask(taskId);
            if (task) return true;
            const rawPath = await projTaskService.getRawTaskFilePath(taskId);
            return Boolean(rawPath);
          } catch {
            // Failure direction is safe: "unregistered" emits an advisory,
            // never a ledger write.
            return false;
          }
        },
        hasProtectedRow: (taskId: string) => {
          const row = proj.db.getVerified(taskId);
          return Boolean(row && (row.verdict === "VERIFIED" || row.verdict === "SOFT-VERIFIED"));
        },
        claimantIndexProvider: () =>
          buildStrictDuplicateClaimantIndex(() =>
            listTaskClaimantDeclarations(projTaskService.getTaskDirectory()),
          ),
        record: (candidate: MergeScanCandidate, claimantIndex: DuplicateClaimantIndex) =>
          recordVerification(
            proj,
            {
              taskId: candidate.taskId,
              verdict: "SOFT-VERIFIED",
              commitSha: candidate.commitSha,
              method: profile.method,
              criteriaChecked: 0,
              criteriaPassed: 0,
              notes: `${profile.notesPrefix}: ${candidate.subject}`,
            },
            { skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"] },
            claimantIndex,
          ),
        persistClaimantDiagnostic: (diagnostic) =>
          persistClaimantDiagnostic({
            logDir: proj.logDir ?? path.join(projectRoot, ".quack", "logs"),
            project: proj.projectId,
            diagnostic,
          }),
        scannerMethod: profile.method,
        onTaskRecorded: (taskId: string) => {
          void proj.dispatchQueue?.notifyExternalCompletion(taskId);
        },
        emit: (stage, payload) => {
          sse.broadcast({
            sessionId: "monitor",
            taskId: typeof payload.taskId === "string" ? payload.taskId : "",
            project: proj.projectId,
            timestamp: new Date().toISOString(),
            stage,
            payload,
          });
        },
      };
    };

    const startOnMergeForProject = (proj: ResolvedProject): void => {
      if (!proj.projectRoot || onMergeStartedRoots.has(proj.projectRoot)) return;
      const recordingCfg = getRecordingConfig(proj.adapterPath);
      if (recordingCfg?.onMerge?.enabled === false) return;
      const gitCfg = getAdapterGitConfig(proj.adapterPath);
      if (!gitCfg?.baseBranch) return;
      const deps = buildOnMergeScanDeps(proj, gitCfg.baseBranch);
      if (!deps) return;
      onMergeStartedRoots.add(proj.projectRoot);
      stopOnMergeRecorders.push(
        startOnMergeRecorder({
          ...deps,
          intervalMs: recordingCfg?.onMerge?.intervalMs ?? 300_000,
        }),
      );
    };

    if (process.env.NODE_ENV !== "test") {
      startOnMergeForProject(resolveProject());
      if (registry) {
        for (const ctx of registry.listProjects()) {
          startOnMergeForProject(resolvedProjectFromContext(ctx));
        }
      }
    }

    // Operator trigger: run one scan tick immediately for the resolved project.
    app.post("/api/recording/scan-now", async (req: Request, res: Response) => {
      const scanScope = resolveProjectForWrite(req);
      if (!scanScope.ok) {
        res.status(scanScope.status).json(scanScope.body);
        return;
      }
      const proj = scanScope.project;
      if (!proj.projectRoot || !proj.taskService) {
        res.status(404).json({ error: "Project not configured" });
        return;
      }
      const gitCfg = getAdapterGitConfig(proj.adapterPath);
      if (!gitCfg?.baseBranch) {
        res
          .status(400)
          .json({ error: "no_base_branch", message: "Adapter git.baseBranch is not configured." });
        return;
      }
      const deps = buildOnMergeScanDeps(proj, gitCfg.baseBranch);
      if (!deps) {
        res.status(404).json({ error: "Project not configured" });
        return;
      }
      try {
        const result = await runOnMergeScan(deps);
        res.json({ ok: true, ...result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `On-merge scan failed: ${msg}` });
      }
    });

    // TASK-1204: report-first historical backfill. Dry-run by default;
    // writes only on apply, through the same guarded record path.
    app.post("/api/recording/backfill", async (req: Request, res: Response) => {
      const backfillSchema = z.object({
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
        apply: z.boolean().optional(),
        maxWrites: z.number().int().min(1).max(1000).optional(),
        samplePercent: z.number().int().min(5).max(50).optional(),
      });
      const parsed = backfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_backfill_request",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }

      const backfillScope = resolveProjectForWrite(req);
      if (!backfillScope.ok) {
        res.status(backfillScope.status).json(backfillScope.body);
        return;
      }
      const proj = backfillScope.project;
      if (!proj.projectRoot || !proj.taskService) {
        res.status(404).json({ error: "Project not configured" });
        return;
      }
      const gitCfg = getAdapterGitConfig(proj.adapterPath);
      if (!gitCfg?.baseBranch) {
        res
          .status(400)
          .json({ error: "no_base_branch", message: "Adapter git.baseBranch is not configured." });
        return;
      }
      const deps = buildOnMergeScanDeps(proj, gitCfg.baseBranch, {
        method: "migration-scan",
        notesPrefix: "migration-scan",
      });
      if (!deps) {
        res.status(404).json({ error: "Project not configured" });
        return;
      }
      try {
        const result = await runBackfillScan(deps, parsed.data);
        if (result.busy) {
          res.status(409).json({ ok: false, ...result });
          return;
        }
        res.json({ ok: true, ...result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Backfill scan failed: ${msg}` });
      }
    });

    // â”€â”€â”€ ccusage background refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Initial refresh on startup (async, non-blocking) â€” only if cache is empty
    if (process.env.NODE_ENV !== "test" && isCcusageCacheStale(ccusageData)) {
      triggerCcusageRefresh();
    }
    // Subsequent refreshes triggered by session completion events (see buildEventWatcherCallback)

    // â”€â”€â”€ Hot-reload adapter.json on change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Watches for edits and re-parses config sections so the monitor
    // picks up changes without a restart.
    let adapterWatcher:
      | {
          close: () => Promise<void>;
          on: (event: string, cb: (...args: unknown[]) => void) => void;
        }
      | undefined;
    if (adapterPath && fs.existsSync(adapterPath)) {
      try {
        const chokidar = await import("chokidar");
        adapterWatcher = chokidar.watch(adapterPath, {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
          usePolling: process.platform === "win32",
          interval: 1000,
        });
        adapterWatcher.on("error", (err: unknown) => {
          console.error(
            "[hot-reload] chokidar error (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        });
        adapterWatcher.on("change", () => {
          try {
            const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<
              string,
              unknown
            >;
            // Update fleet budget config
            const fb = raw.fleetBudget as Record<string, unknown> | undefined;
            if (fb) {
              fleetBudget.updateConfig({
                dailyCapUsd: typeof fb.dailyCapUsd === "number" ? fb.dailyCapUsd : 25.0,
                hourlyCapUsd: typeof fb.hourlyCapUsd === "number" ? fb.hourlyCapUsd : 10.0,
                perWaveCapUsd: typeof fb.perWaveCapUsd === "number" ? fb.perWaveCapUsd : 15.0,
                alertThresholds: Array.isArray(fb.alertThresholds)
                  ? (fb.alertThresholds as number[])
                  : [50, 75, 90],
                enforceHard: fb.enforceHard !== false,
              });
            }
            console.log("[hot-reload] adapter.json reloaded");
          } catch (err) {
            console.error(
              "[hot-reload] adapter.json parse error (non-fatal):",
              err instanceof Error ? err.message : err,
            );
          }
        });
      } catch {
        // chokidar not available â€” skip hot-reload
      }
    }

    // â”€â”€â”€ Task file watcher (auto-discovery + auto-repair + auto-preflight)
    let taskWatcherInstance: { close: () => Promise<void> } | undefined;
    if (taskDir && projectRoot) {
      try {
        const { TaskWatcher } = await import("./task-watcher.js");
        let watcherAdapter: ProjectAdapter | undefined;
        if (adapterPath && fs.existsSync(adapterPath)) {
          try {
            watcherAdapter = await loadAdapter(adapterPath);
          } catch {
            /* use fallback */
          }
        }
        if (!watcherAdapter) {
          watcherAdapter = {
            config: {
              project: { name: "", taskDir: "" },
              agent: {},
              verification: { commands: [] },
            },
            conventionsDoc: "",
            projectRoot,
          } as unknown as ProjectAdapter;
        }

        const absoluteTaskDir = path.resolve(projectRoot, taskDir);
        const readiness = taskService
          ? new ReadinessService({
              projectRoot,
              taskService,
              prepCache,
              db: legacyDb,
            })
          : null;
        const tw = new TaskWatcher(
          absoluteTaskDir,
          watcherAdapter,
          {
            onNewTask: (task, filePath) => {
              sse.broadcast({
                sessionId: "task-watcher",
                taskId: task.id,
                project: currentProjectId(),
                timestamp: new Date().toISOString(),
                stage: "task_discovered" as never,
                payload: { taskId: task.id, filePath, status: task.status } as never,
              });
              console.log(`[task-watcher] Discovered ${task.id} (${task.status})`);
            },
            onRepaired: (taskId, filePath, sectionsAdded) => {
              sse.broadcast({
                sessionId: "task-watcher",
                taskId,
                project: currentProjectId(),
                timestamp: new Date().toISOString(),
                stage: "task_repaired" as never,
                payload: { taskId, filePath, sectionsAdded } as never,
              });
              console.log(`[task-watcher] Repaired ${taskId}: added ${sectionsAdded.join(", ")}`);
            },
            onRepairFailed: (taskId, filePath, error) => {
              sse.broadcast({
                sessionId: "task-watcher",
                taskId,
                project: currentProjectId(),
                timestamp: new Date().toISOString(),
                stage: "task_repair_failed" as never,
                payload: { taskId, filePath, error } as never,
              });
              console.log(`[task-watcher] Repair failed for ${taskId}: ${error}`);
            },
            onPreflightQueued: (taskId) => {
              sse.broadcast({
                sessionId: "task-watcher",
                taskId,
                project: currentProjectId(),
                timestamp: new Date().toISOString(),
                stage: "task_preflight_queued" as never,
                payload: { taskId } as never,
              });
            },
            onTerminalStatus: (taskId, status) => {
              if (!legacyDb) return;
              // TASK-1318 (P2-4): propagation retired here too; see the
              // project-scoped wiring above for the full rationale.
              const current = legacyDb.getStatus(taskId)?.status;
              if (current === undefined) return; // rowless is the normal fallback state
              if (current === status) return; // agreement
              sse.broadcast({
                sessionId: "task-watcher",
                taskId,
                project: currentProjectId(),
                timestamp: new Date().toISOString(),
                stage: "task_status_drift" as never,
                payload: { taskId, specStatus: status, dbStatus: current } as never,
              });
            },
          },
          {
            autoRepair: false, // Disabled by default â€” users can trigger repair via API
            autoPreflight: !!prepWorker,
            isPreflightCurrent: readiness
              ? (taskId, contentHash) => readiness.isPreflightCurrentForHash(taskId, contentHash)
              : undefined,
            queuePreflight: prepWorker
              ? (taskId) => {
                  prepWorker.start(taskId);
                }
              : undefined,
          },
        );

        tw.start().catch((err: unknown) =>
          console.error(
            "[task-watcher] start error (non-fatal):",
            err instanceof Error ? err.message : err,
          ),
        );
        taskWatcherInstance = tw;
        console.log("[task-watcher] Watching for task file changes");
      } catch {
        // TaskWatcher init failed â€” non-fatal, skip
      }
    }

    // â”€â”€â”€ GitHub polling daemon â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Poll for new issues to import and sync status for mapped tasks.
    // Only runs when pollEnabled is true in adapter config.
    let githubPollInterval: ReturnType<typeof setInterval> | undefined;
    let githubSyncInterval: ReturnType<typeof setInterval> | undefined;

    const activeProject = registry?.getActiveProject();
    const ghConfig = activeProject?.adapter?.config?.integrations?.github;
    if (ghConfig?.pollEnabled) {
      const pollMs = ghConfig.pollIntervalMs || 300000;
      const syncMs = ghConfig.statusSyncIntervalMs || 600000;
      const importLabel = ghConfig.importLabel || "quack-ready";

      // Poll for new issues to import
      githubPollInterval = setInterval(
        () =>
          void (async () => {
            try {
              const adapter = activeProject?.adapter;
              if (!adapter) return;

              const { fetchIssuesByLabel } =
                await import("../integrations/github/issue-fetcher.js");
              const { getSyncMap } = await import("../integrations/github/sync-map.js");
              const { importIssue } = await import("../integrations/github/import-pipeline.js");

              const issues = await fetchIssuesByLabel(ghConfig.owner, ghConfig.repo, importLabel);
              const syncMap = await getSyncMap(adapter.config);

              for (const issue of issues) {
                if (!syncMap.hasIssue(issue.number)) {
                  try {
                    const result = await importIssue(issue.number, adapter, false);
                    console.log(
                      `[github-poll] Auto-imported issue #${issue.number} as ${result.taskId}`,
                    );
                  } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[github-poll] Failed to import issue #${issue.number}: ${msg}`);
                  }
                }
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[github-poll] Poll failed: ${msg}`);
            }
          })(),
        pollMs,
      ).unref();

      // Sync status for existing mapped tasks
      githubSyncInterval = setInterval(
        () =>
          void (async () => {
            try {
              const adapter = activeProject?.adapter;
              if (!adapter) return;

              const { syncAllTasks } = await import("../integrations/github/status-syncer.js");
              const outcome = await syncAllTasks(adapter.config);
              const skippedRows = outcome.outcomes
                .filter((row) => row.outcome === "skipped")
                .map((row) => {
                  if (row.reason === "duplicate_claimants") {
                    return `${row.taskId} reason=${row.reason} claimants=${row.claimants.join(", ")}`;
                  }
                  if (row.reason === "sync_failed") {
                    return `${row.taskId} reason=${row.reason} message=${row.message}`;
                  }
                  return `${row.taskId} reason=${row.reason}`;
                });
              if (skippedRows.length > 0) {
                console.warn(`[github-sync] Skipped tasks: ${skippedRows.join("; ")}`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[github-sync] Sync failed: ${msg}`);
            }
          })(),
        syncMs,
      ).unref();

      console.log(
        `[github] Polling enabled: import every ${pollMs / 1000}s, sync every ${syncMs / 1000}s`,
      );
    }

    sse.startHeartbeat();

    const stopVerifiedSyncs: Array<() => void> = [];
    const projects = resolveProjects();
    for (const proj of projects) {
      if (proj.projectRoot) {
        try {
          await regenerateLatestByTaskIndex(proj.projectRoot);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reviews-index] regenerate failed for ${proj.projectId}: ${msg}`);
        }
      }

      try {
        const claimantIndex = await buildFederationClaimantIndexModule(proj);
        const r = await reconcileVerifiedDrift(proj, {
          claimantIndex,
          log: (message) => console.error(message),
        });
        if (r.jsonToDb.length > 0 || r.dbToJson.length > 0 || r.taskStatusFixed.length > 0) {
          console.log(
            `[verification-store] reconcile project=${proj.projectId}: ` +
              `jsonToDb=${r.jsonToDb.length} dbToJson=${r.dbToJson.length} statusFixed=${r.taskStatusFixed.length}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[verification-store] reconcile failed for ${proj.projectId}: ${msg}`);
      }

      try {
        await regenerateProjection(proj);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[verification-store] projection regenerate failed for ${proj.projectId}: ${msg}`,
        );
      }

      if (!proj.projectRoot) continue;

      try {
        const peer = await loadFederationPeerConfig(proj.projectRoot);
        setVerificationPeerSyncHandler(
          proj.projectRoot,
          peer?.pushOnWrite
            ? async (project, entry) => pushVerificationToPeer(project, peer, entry)
            : undefined,
        );

        if (!peer) continue;

        if (peer.syncOnStartup) {
          const pull = await pullVerifiedFromPeer(proj, peer);
          if (pull.fetched > 0) {
            console.log(
              `[verification-sync] startup pull project=${proj.projectId}: ` +
                `fetched=${pull.fetched} applied=${pull.applied} skipped=${pull.skipped}`,
            );
          }
        }

        stopVerifiedSyncs.push(startPeriodicVerifiedSync(proj, peer));
      } catch (err: unknown) {
        setVerificationPeerSyncHandler(proj.projectRoot, undefined);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[verification-sync] init failed for ${proj.projectId}: ${msg}`);
      }
    }

    return new Promise((resolve) => {
      const onListening = () => {
        resolve({
          port,
          stop: async () => {
            // Kill in-flight ccusage refresh to prevent "Cannot log after tests are done"
            ccusageAborted = true;
            if (ccusageChild) {
              if (process.platform === "win32" && ccusageChild.pid) {
                try {
                  execSync(`taskkill /F /T /PID ${ccusageChild.pid}`, { stdio: "ignore" });
                } catch {
                  ccusageChild.kill();
                }
              } else {
                ccusageChild.kill();
              }
              ccusageChild = null;
            }
            if (ccusageRefreshPromise) {
              await Promise.race([
                ccusageRefreshPromise.catch(() => undefined),
                new Promise<void>((resolveRace) => setTimeout(resolveRace, 1000)),
              ]);
            }
            prepScheduler?.stop();
            progressDetector.stopChecking();
            await Promise.race([
              Promise.allSettled(startupValidationTasks),
              new Promise<void>((resolveValidation) => setTimeout(resolveValidation, 1000)),
            ]);
            clearInterval(baselineInterval);
            clearInterval(cleanupInterval);
            process.off("uncaughtException", onUncaughtException);
            process.off("unhandledRejection", onUnhandledRejection);
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
            await Promise.allSettled(stopFreshnessMonitors.map((stopFm) => stopFm()));
            for (const stopRecorder of stopOnMergeRecorders) stopRecorder();
            for (const stopSync of stopVerifiedSyncs) stopSync();
            for (const proj of resolveProjects()) {
              setVerificationPeerSyncHandler(proj.projectRoot, undefined);
            }
            if (githubPollInterval) clearInterval(githubPollInterval);
            if (githubSyncInterval) clearInterval(githubSyncInterval);
            if (adapterWatcher) {
              await adapterWatcher.close();
            }
            if (taskWatcherInstance) {
              await taskWatcherInstance.close();
            }
            for (const hb of activeHeartbeats.values()) {
              try {
                hb.stop();
              } catch {
                /* best effort */
              }
            }
            activeHeartbeats.clear();
            for (const pw of activeProgressWatchers.values()) {
              pw.stop().catch(() => {
                /* best effort */
              });
            }
            activeProgressWatchers.clear();
            dispatchManager?.killAll();
            adminRuns.stopAll();
            prepWorker?.killAll();
            testRunner?.killAll();
            // Stop multi-project watchers and services
            for (const stopFn of projectWatcherStops) {
              stopFn();
            }
            if (registry) {
              for (const ctx of registry.listProjects()) {
                ctx.progressDetector.stopChecking();
                ctx.dispatchManager?.killAll();
                ctx.prepScheduler?.stop();
                if (ctx.taskWatcher) {
                  await ctx.taskWatcher.close();
                }
                try {
                  ctx.db.close();
                } catch {
                  /* best effort */
                }
              }
            }
            sse.closeAll();
            authService.destroy();
            try {
              legacyDb.close();
            } catch {
              /* best effort */
            }
            stopWatcher();
            await new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
            });
            await new Promise<void>((resolveSettle) => setTimeout(resolveSettle, 25));
          },
        });
      };
      const server = app.listen(port, options.host ?? "127.0.0.1", onListening);
    });
  }

  return { app, sse, reader, registry, start };
}
