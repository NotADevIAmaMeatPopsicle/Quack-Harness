import { verificationEntrySchema } from "../verification-schema.js";
import { assertVerificationDatabaseAvailable } from "../verification-store.js";
import { admitFederatedQueueRecord } from "../federation/queue-admission.js";
import type { Express, Request, Response } from "express";
import { execFileSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { z } from "zod";

import type { EventPayload } from "../event-types.js";
import type { EventWriter } from "../event-emitter.js";
import { recordVerification } from "../verification-store.js";
import { normalizeCapabilities } from "../../federation/host-registry.js";
import {
  ListenerRegistry,
  ListenerTokenBindingError,
  ListenerRecordReadError,
} from "../../federation/listener-registry.js";
import { routeFederatedJob } from "../../federation/job-router.js";
import { validationDetails } from "../../intake/task-intake.js";
import type { BlockReasonCode } from "../../workflow/workflow-state-types.js";
import {
  applyActiveFederatedLeases,
  buildFederationClaimantIndex,
  defaultFederatedHosts,
  emitFederatedSessionStart,
  federatedHostEventDetailsFromHost,
  federatedJobHoldsWorkerAttachment,
  federatedJobId,
  federatedSessionId,
  holdsWorkerAttachment,
  isRelayedSlackStage,
  listFederatedJobs,
  loadReviewBundle,
  loadFederatedJob,
  maybeRunSwarmSchedulerRefill,
  normalizeFederatedRuntimeStatus,
  mintFederatedJobRecord,
  readFederatedMergeLock,
  recordFederatedVerifiedTask,
  federatedStatusTransitionFreedCapacity,
  releaseFederatedDependencyBlocks,
  resolveFederatedHostEventDetails,
  resolveFederatedTaskEventDetails,
  restoreTaskStatusAfterFederatedCancel,
  runSwarmSchedulerTick,
  saveFederatedJob,
  updateFederatedJob,
  sessionStatusForFederatedStatus,
  sessionTitleForFederatedTask,
  sortFederatedQueue,
  terminalFederatedStatus,
  upsertFederatedSessionIndex,
  workflowStateForFederatedStatus,
  reconcileFederatedJob,
  releaseFederatedPause,
  requestFederatedResume,
  claimFederatedResume,
  acknowledgeFederatedResumeStart,
  transitionFederatedResumeRunning,
  transitionFederatedResumeTerminal,
  transitionFederatedPause,
  exactFederatedResumeTerminalReceiptMatches,
  FederatedJobLockBusyError,
  markFederatedPauseManualRecovery,
  FederatedPauseTransitionError,
  orchestrateFederatedCompletion,
  CompletionIntentVerificationConflictError,
  assertSafeGitRef,
  type FederatedJobRecord,
  type FederatedRelayEvent,
  type FederatedRuntimeStatus,
  type FederationProjectContext,
} from "../federation/index.js";
import {
  duplicateClaimantRefusalForIndex,
  type DuplicateClaimantIndex,
} from "../../core/duplicate-claimants.js";
import type { FederationSchedulingDeps } from "../federation/scheduling.js";
import type { FederationOrchestrationDeps } from "../federation/orchestration.js";
import {
  evaluateReviewGateWithJudgment,
  persistReviewBundle,
  requiredActionsForDocsImpact,
  type ReviewBundleInput,
  type WikiAction,
} from "../../review/docs-gate.js";

const federatedHostSchema = z.object({
  id: z.string().trim().min(1),
  alias: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  capabilities: z.array(z.string().trim().min(1)).default(["dispatch"]),
  enabled: z.boolean().default(true),
  healthy: z.boolean().default(true),
  lastHealthCheckAt: z.string().optional(),
  currentLoad: z.number().int().min(0).optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  repoCommit: z.string().trim().min(1).optional(),
  projectPaths: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type FederationRouteProject = FederationProjectContext;

export type FederationWriteScopeResult =
  | {
      ok: true;
      project: FederationRouteProject;
      /** An old, unscoped worker was resolved by a unique persisted job id. */
      compatibilityFallback?: boolean;
    }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface FederationRouteDeps {
  resolveProject: (req: Request) => FederationRouteProject;
  /** TASK-1301: write-route project resolution — refuses to default to the
   *  active project on multi-project registries (PROJECT_SCOPE_REQUIRED). */
  resolveProjectForWrite: (req: Request) => FederationWriteScopeResult;
  /** TASK-1302: existing-job writes get a bounded mixed-fleet fallback. */
  resolveProjectForFederatedJobWrite: (
    req: Request,
    jobId: string,
  ) => Promise<FederationWriteScopeResult>;
  createWorkflowWriter: (
    p: FederationRouteProject,
    workflowId: string,
    taskId: string,
    title: string,
  ) => EventWriter;
  resolveAndBroadcastProjection: (
    p: FederationRouteProject,
    taskId: string | undefined,
  ) => Promise<unknown>;
  requireServiceScope: (req: Request, res: Response, scope: string) => string | undefined;
  requireServiceScopeAny?: (req: Request, res: Response, scopes: string[]) => string | undefined;
  federationSchedulingDeps: FederationSchedulingDeps;
  federationOrchestrationDeps: FederationOrchestrationDeps;
  /** Deterministic external-completion git seam used by route tests. */
  execGit?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      encoding: "utf-8";
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => string;
}

function shouldAutoRefillAfterFederatedUpdate(
  previous: FederatedJobRecord,
  current: FederatedJobRecord,
): boolean {
  if (current.error?.startsWith("duplicate_claimants")) return false;
  return (
    (federatedJobHoldsWorkerAttachment(previous) && !federatedJobHoldsWorkerAttachment(current)) ||
    (previous.status !== "completed" && current.status === "completed") ||
    (previous.nextAction !== "run_fix_job" && current.nextAction === "run_fix_job")
  );
}

const allowedFederatedStatusTransitions: Readonly<
  Record<FederatedRuntimeStatus, ReadonlySet<FederatedRuntimeStatus>>
> = {
  queued: new Set([
    "queued",
    "assigned",
    "running",
    "verifying",
    "fixing",
    "awaiting_approval",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  assigned: new Set([
    "assigned",
    "running",
    "verifying",
    "fixing",
    "awaiting_approval",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  running: new Set([
    "running",
    "verifying",
    "fixing",
    "awaiting_approval",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  verifying: new Set([
    "verifying",
    "fixing",
    "awaiting_approval",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  fixing: new Set([
    "fixing",
    "verifying",
    "awaiting_approval",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  awaiting_approval: new Set([
    "awaiting_approval",
    "running",
    "verifying",
    "fixing",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "canceled",
  ]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  rejected: new Set(["rejected"]),
  blocked: new Set(["blocked"]),
  canceled: new Set(["canceled"]),
};

function assertFederatedStatusTransition(
  current: FederatedRuntimeStatus,
  requested: FederatedRuntimeStatus,
  jobId: string,
): void {
  if (allowedFederatedStatusTransitions[current].has(requested)) return;
  throw new FederatedPauseTransitionError(
    "federated_status_regression",
    `Federated job ${jobId} cannot move from ${current} to ${requested}.`,
  );
}

function gitOutput(
  projectRoot: string,
  args: string[],
  execGit: NonNullable<FederationRouteDeps["execGit"]> = execFileSync,
): string {
  return execGit("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8").trim();
  }
  return String(err);
}

function resolveExternalBranchCommit(
  projectRoot: string,
  branchName: string,
  targetBranch: string,
  execGit?: FederationRouteDeps["execGit"],
): { ok: true; commitSha: string } | { ok: false; error: string; message: string } {
  try {
    assertSafeGitRef(branchName, "branchName");
    assertSafeGitRef(targetBranch, "targetBranch");
    try {
      gitOutput(projectRoot, ["fetch", "origin", targetBranch], execGit);
    } catch {
      // Some test/local clones use only local refs; branch resolution below is authoritative.
    }
    try {
      gitOutput(projectRoot, ["rev-parse", "--verify", targetBranch], execGit);
    } catch {
      gitOutput(projectRoot, ["rev-parse", "--verify", `origin/${targetBranch}`], execGit);
    }
    try {
      return {
        ok: true,
        commitSha: gitOutput(projectRoot, ["rev-parse", "--verify", branchName], execGit),
      };
    } catch {
      const remoteRef = branchName.startsWith("origin/") ? branchName : `origin/${branchName}`;
      return {
        ok: true,
        commitSha: gitOutput(projectRoot, ["rev-parse", "--verify", remoteRef], execGit),
      };
    }
  } catch (err: unknown) {
    return {
      ok: false,
      error: "branch_not_fetchable",
      message: gitErrorMessage(err),
    };
  }
}

function sendFederationOrchestrationFailure(
  res: Response,
  error: unknown,
  identity: { jobId?: string; taskId?: string } = {},
): void {
  const verificationConflict = error instanceof CompletionIntentVerificationConflictError;
  res.status(verificationConflict ? 409 : 500).json({
    ok: false,
    error: verificationConflict
      ? "federated_verification_conflict"
      : "federated_orchestration_failed",
    message: error instanceof Error ? error.message : String(error),
    ...identity,
  });
}

export function registerFederationRoutes(app: Express, deps: FederationRouteDeps): void {
  const {
    resolveProject,
    resolveProjectForWrite,
    resolveProjectForFederatedJobWrite,
    createWorkflowWriter,
    resolveAndBroadcastProjection,
    requireServiceScope,
    requireServiceScopeAny,
    federationSchedulingDeps,
    federationOrchestrationDeps,
  } = deps;

  const sendFederationAdmissionRefusal = (
    index: DuplicateClaimantIndex,
    taskId: string,
    res: Response,
  ): boolean => {
    const refusal = duplicateClaimantRefusalForIndex(index, taskId);
    if (!refusal) return false;
    res.status(409).json({ ok: false, ...refusal });
    return true;
  };
  const refuseFederationAdmission = async (
    p: FederationRouteProject,
    taskId: string,
    res: Response,
  ): Promise<boolean> =>
    sendFederationAdmissionRefusal(await buildFederationClaimantIndex(p), taskId, res);

  const requireFederationRead = (req: Request, res: Response): string | undefined => {
    if (requireServiceScopeAny) {
      return requireServiceScopeAny(req, res, ["federation:read", "federation:write"]);
    }
    return requireServiceScope(req, res, "federation:write");
  };

  const resolveFederatedJobWrite = async (
    req: Request,
    res: Response,
    jobId: string,
  ): Promise<FederationRouteProject | undefined> => {
    const scope = await resolveProjectForFederatedJobWrite(req, jobId);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return undefined;
    }
    if (scope.compatibilityFallback) {
      res.setHeader(
        "Warning",
        '299 Quack "Legacy unscoped federation write accepted; send projectId."',
      );
      res.setHeader("X-Quack-Project-Scope", "legacy-job-id-fallback");
    }
    return scope.project;
  };

  const requireListenerTokenBinding = async (
    p: FederationRouteProject,
    hostId: string,
    tokenId: string,
    res: Response,
  ): Promise<boolean> => {
    if (!p.projectRoot) return false;
    try {
      await new ListenerRegistry(p.projectRoot).assertTokenBinding(hostId, tokenId);
      return true;
    } catch (error: unknown) {
      if (error instanceof ListenerTokenBindingError) {
        res.status(error.code === "listener_not_found" ? 409 : 403).json({
          error: error.code,
          message: error.message,
          hostId,
        });
        return false;
      }
      res.status(503).json({
        error: "listener_registry_unavailable",
        message: "Listener identity cannot be verified from its current registry record.",
        ...(error instanceof ListenerRecordReadError ? { issue: error.issue } : {}),
      });
      return false;
    }
  };

  app.get("/v1/federation/queue", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const jobs = (await listFederatedJobs(p.projectRoot)).map((job) => ({
      ...job,
      projectId: job.projectId ?? p.projectId,
    }));
    const listenerSnapshot = await new ListenerRegistry(p.projectRoot).listWithDiagnostics();
    const hosts = await defaultFederatedHosts(p.projectRoot, listenerSnapshot);
    const activeDispatchJobs = jobs
      // Per-host dispatch load counts durable attachment rather than scheduler
      // eligibility. Released pause generations no longer consume a slot.
      .filter((job) => job.jobType === "dispatch" && federatedJobHoldsWorkerAttachment(job));
    const activeDispatchByHost = activeDispatchJobs.reduce<Record<string, number>>((acc, job) => {
      const hostId = job.hostId ?? "unassigned";
      acc[hostId] = (acc[hostId] ?? 0) + 1;
      return acc;
    }, {});
    const byStatus = jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    }, {});
    const mergeLock = await readFederatedMergeLock(p.projectRoot);
    const mergeLaneActive =
      Boolean(mergeLock) ||
      jobs.some((job) => job.mergeStatus === "not_requested" && job.nextAction === "merge_gate");
    res.json({
      ok: true,
      jobs: sortFederatedQueue(jobs),
      summary: {
        total: jobs.length,
        listenerRegistry: {
          healthy: listenerSnapshot.issues.length === 0,
          unavailable: listenerSnapshot.unavailable,
          issues: listenerSnapshot.issues,
        },
        byStatus,
        mergeLaneActive,
        mergeLock,
        activeDispatchJobs: activeDispatchJobs.length,
        activeDispatchByHost,
        hosts: hosts.map((host) => ({
          id: host.id,
          alias: host.alias,
          baseUrl: host.baseUrl,
          enabled: host.enabled,
          healthy: host.healthy,
          currentLoad: host.currentLoad ?? 0,
          maxConcurrentJobs: host.maxConcurrentJobs ?? 1,
          capabilities: host.capabilities,
          repoCommit: host.repoCommit,
          runtimeRole: host.runtimeRole,
          protocolVersion: host.protocolVersion,
          lastCommand: host.lastCommand,
          lastHealthCheckAt: host.lastHealthCheckAt,
          metadata: host.metadata,
        })),
      },
    });
  });

  app.get("/v1/federation/verified", (req: Request, res: Response) => {
    const tokenId = requireFederationRead(req, res);
    if (!tokenId) return;

    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    try {
      assertVerificationDatabaseAvailable(p);
    } catch (error: unknown) {
      res.status(503).json({
        error: "verification_database_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const since =
      typeof req.query.since === "string" && req.query.since.trim()
        ? req.query.since.trim()
        : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw ?? 250, 1), 1000) : 250;
    const rows = p.db.getVerifiedSince(since, limit);
    const latestCursor =
      rows.length > 0
        ? (rows[rows.length - 1]?.updated_at ?? rows[rows.length - 1]?.verified_at)
        : since;

    res.json({ ok: true, tokenId, rows, latestCursor });
  });

  app.get("/v1/federation/verified/:taskId", (req: Request, res: Response) => {
    const tokenId = requireFederationRead(req, res);
    if (!tokenId) return;

    const p = resolveProject(req);
    const taskId = req.params.taskId as string;
    try {
      assertVerificationDatabaseAvailable(p);
    } catch (error: unknown) {
      res.status(503).json({
        error: "verification_database_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const row = p.db.getVerified(taskId) ?? null;
    res.json({ ok: true, tokenId, row });
  });

  app.post("/v1/federation/verified", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    // Scope guard runs after auth: the error body enumerates project ids.
    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = z
      .object({
        entries: z.array(verificationEntrySchema).min(1),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_verified_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      assertVerificationDatabaseAvailable(p);
    } catch (error: unknown) {
      res.status(503).json({
        error: "verification_database_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const appliedTaskIds: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    const refused: Array<{ taskId: string; claimants: string[]; reason: string }> = [];
    const claimantIndex = await buildFederationClaimantIndex(p);
    try {
      for (const entry of parsed.data.entries) {
        const result = await recordVerification(p, entry, { syncToPeers: false }, claimantIndex);
        if (result.applied) {
          appliedTaskIds.push(entry.taskId);
        } else if (result.refusal) {
          refused.push({
            taskId: result.refusal.taskId,
            claimants: result.refusal.claimants,
            reason: result.refusal.message,
          });
        } else {
          skipped.push({ taskId: entry.taskId, reason: result.skippedReason ?? "skipped" });
        }
      }
    } catch (error: unknown) {
      res.status(500).json({
        error: "verification_write_failed",
        message: error instanceof Error ? error.message : String(error),
        appliedTaskIds,
      });
      return;
    }

    res.json({
      ok: true,
      tokenId,
      accepted: appliedTaskIds.length,
      appliedTaskIds,
      refusedTaskIds: refused.map((entry) => entry.taskId),
      refused,
      skipped,
      ...(claimantIndex.status === "unavailable" ? { unavailable: claimantIndex.reason } : {}),
    });
  });

  app.post("/v1/federation/queue", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z.object({
      taskId: z.string().trim().min(1),
      jobType: z.enum(["intake", "verify", "fix", "dispatch"]).default("dispatch"),
      correlationId: z.string().trim().min(1).optional(),
      parentJobId: z.string().trim().min(1).optional(),
      preferredHostId: z.string().trim().min(1).optional(),
      requiredCapabilities: z.array(z.string().trim().min(1)).optional(),
      priority: z.union([z.number().int(), z.string().trim().min(1)]).optional(),
      leaseTtlMs: z.number().int().positive().optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
      branchName: z.string().trim().min(1).optional(),
      commitSha: z.string().trim().min(1).optional(),
      targetBranch: z.string().trim().min(1).optional(),
      reviewId: z.string().trim().min(1).optional(),
      autoMerge: z.boolean().optional(),
      autoSchedule: z.boolean().default(true),
      allowLowPreflight: z.boolean().default(false),
      allowMissingPreflight: z.boolean().default(false),
      bypassDependencyGate: z.boolean().default(false),
      // QPI-048 leg (f): the operator's decomposition-gate override,
      // expressible swarm-wide — rides the job record to the listener,
      // which passes it to the local start.
      skipDecomposeCheck: z.boolean().default(false),
    });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_queue_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const body = parsed.data;
    if (await refuseFederationAdmission(p, body.taskId, res)) return;
    const requiredCapabilities = normalizeCapabilities(
      body.requiredCapabilities && body.requiredCapabilities.length > 0
        ? body.requiredCapabilities
        : [body.jobType],
    );
    let admission: Awaited<ReturnType<typeof admitFederatedQueueRecord>>;
    try {
      admission = await admitFederatedQueueRecord(p, {
        projectId: p.projectId,
        taskId: body.taskId,
        jobType: body.jobType,
        requiredCapabilities,
        // TASK-1323: channel derived from THIS route, never from the
        // client; the tokenId that QPI-047's hunt found being discarded
        // is now the first thing stamped.
        provenance: {
          channel: "federation-queue",
          tokenId,
          remoteAddr: req.ip,
          claimedChannel: req.header("x-quack-channel") ?? undefined,
        },
        correlationId: body.correlationId,
        parentJobId: body.parentJobId,
        preferredHostId: body.preferredHostId,
        priority: body.priority,
        leaseTtlMs: body.leaseTtlMs,
        maxRetries: body.maxRetries,
        branchName: body.branchName,
        commitSha: body.commitSha,
        targetBranch: body.targetBranch,
        reviewId: body.reviewId,
        autoMerge: body.autoMerge,
        skipDecomposeCheck: body.skipDecomposeCheck || undefined,
      });
    } catch (error: unknown) {
      res.status(503).json({
        ok: false,
        error: "federated_queue_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!admission.ok) {
      res.status(409).json(admission);
      return;
    }
    const record = admission.record;
    if (admission.created) {
      const taskDetails = await resolveFederatedTaskEventDetails(p, record.taskId);
      const taskTitle = sessionTitleForFederatedTask(taskDetails);
      const writer = createWorkflowWriter(
        p,
        federatedSessionId(record.jobId),
        record.taskId,
        taskTitle ?? record.taskId,
      );
      writer.recordSession("active", { outcome: "federated_job_queued", title: taskTitle });
      writer.emit("federated_job_status", {
        jobId: record.jobId,
        taskId: record.taskId,
        taskTitle: taskDetails.taskTitle,
        status: record.status,
        workflowState: "assigned",
        correlationId: record.correlationId,
        message: "Queued for swarm scheduler.",
      });
    }

    const scheduler = body.autoSchedule
      ? await runSwarmSchedulerTick(
          p,
          {
            preferredHostId: body.preferredHostId,
            leaseTtlMs: body.leaseTtlMs,
            allowLowPreflight: body.allowLowPreflight,
            allowMissingPreflight: body.allowMissingPreflight,
            bypassDependencyGate: body.bypassDependencyGate,
          },
          federationSchedulingDeps,
        )
      : undefined;
    const current = (await loadFederatedJob(p.projectRoot, record.jobId)) ?? record;
    const projection = await resolveAndBroadcastProjection(p, record.taskId);
    res.status(202).json({
      ok: true,
      accepted: true,
      tokenId,
      reused: !admission.created,
      queued: record,
      job: current,
      scheduler,
      projection,
    });
  });

  app.post("/v1/federation/scheduler/tick", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const schema = z.object({
      preferredHostId: z.string().trim().min(1).optional(),
      leaseTtlMs: z.number().int().positive().optional(),
      allowLowPreflight: z.boolean().default(false),
      allowMissingPreflight: z.boolean().default(false),
      bypassDependencyGate: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_scheduler_tick_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const result = await runSwarmSchedulerTick(p, parsed.data, federationSchedulingDeps);
      res.json({ ok: true, tokenId, ...result });
    } catch (error: unknown) {
      sendFederationOrchestrationFailure(res, error);
    }
  });

  app.post("/v1/federation/external-completions", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const wikiActionSchema = z.enum(["changelog_entry", "feature_page_update", "support_bundle"]);
    const phaseResultSchema = z.object({
      name: z.string().trim().min(1),
      status: z.enum(["passed", "failed", "skipped"]),
      summary: z.string().trim().min(1).optional(),
    });
    const schema = z.object({
      taskId: z.string().trim().min(1),
      source: z.string().trim().min(1).default("hermes"),
      sourceCardId: z.string().trim().min(1).optional(),
      sourceRunId: z.string().trim().min(1).optional(),
      branchName: z.string().trim().min(1),
      commitSha: z.string().trim().min(1),
      baseBranch: z.string().trim().min(1).optional(),
      targetBranch: z.string().trim().min(1).default("dev"),
      worktreePath: z.string().trim().min(1).optional(),
      verificationClass: z.enum(["fast-required", "targeted-required", "heavy-runtime"]),
      autoVerify: z.boolean().default(true),
      autoMerge: z.boolean().default(false),
      maxFixAttempts: z.number().int().min(0).max(10).default(0),
      docsImpact: z
        .enum(["none", "changelog_only", "feature_page_update", "support_bundle"])
        .default("none"),
      requiredWikiActions: z.array(wikiActionSchema).optional(),
      wikiArtifacts: z
        .array(
          z.object({
            pagePath: z.string().trim().min(1),
            commitSha: z.string().trim().min(1),
            linkedTaskIds: z.array(z.string().trim().min(1)).default([]),
            action: wikiActionSchema.optional(),
          }),
        )
        .optional(),
      supportDocCandidates: z
        .array(
          z.object({
            title: z.string().trim().min(1),
            summary: z.string().trim().min(1),
            productArea: z.string().trim().min(1).optional(),
            linkedTaskIds: z.array(z.string().trim().min(1)).optional(),
            tags: z.array(z.string().trim().min(1)).optional(),
          }),
        )
        .optional(),
      findings: z
        .array(
          z.object({
            title: z.string().trim().min(1),
            severity: z.enum(["P1", "P2", "P3"]),
            status: z.enum(["open", "resolved", "waived"]).optional(),
            file: z.string().optional(),
          }),
        )
        .optional(),
      criteriaChecked: z.number().int().nonnegative(),
      criteriaPassed: z.number().int().nonnegative(),
      phaseResults: z.array(phaseResultSchema).min(1),
      evidence: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
      summary: z.string().optional(),
      reviewNotes: z.string().optional(),
      reviewer: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_external_completion_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const input = parsed.data;
    const claimantIndex = await buildFederationClaimantIndex(p);
    if (claimantIndex.status === "unavailable") {
      sendFederationAdmissionRefusal(claimantIndex, input.taskId, res);
      return;
    }
    const task = p.taskService ? await p.taskService.getTask(input.taskId) : null;
    if (!task) {
      res.status(404).json({
        ok: false,
        error: "task_not_found",
        taskId: input.taskId,
      });
      return;
    }
    if (sendFederationAdmissionRefusal(claimantIndex, input.taskId, res)) return;

    const branch = resolveExternalBranchCommit(
      p.projectRoot,
      input.branchName,
      input.targetBranch,
      deps.execGit,
    );
    if (!branch.ok) {
      res.status(409).json({
        ok: false,
        error: branch.error,
        message: branch.message,
        branchName: input.branchName,
        targetBranch: input.targetBranch,
      });
      return;
    }
    if (
      !branch.commitSha.startsWith(input.commitSha) &&
      !input.commitSha.startsWith(branch.commitSha)
    ) {
      res.status(409).json({
        ok: false,
        error: "commit_mismatch",
        branchName: input.branchName,
        expectedCommitSha: input.commitSha,
        actualCommitSha: branch.commitSha,
      });
      return;
    }

    try {
      let taskContent: string | undefined;
      if (p.taskService) {
        const taskFilePath =
          (await p.taskService.getTaskFilePath(input.taskId)) ??
          (await p.taskService.getRawTaskFilePath(input.taskId));
        if (taskFilePath) {
          try {
            taskContent = await fsPromises.readFile(taskFilePath, "utf-8");
          } catch {
            taskContent = undefined;
          }
        }
      }

      const docsImpact = input.docsImpact;
      const reviewInput: ReviewBundleInput = {
        taskId: input.taskId,
        verdict:
          input.phaseResults.some((phase) => phase.status === "failed") ||
          input.criteriaPassed < input.criteriaChecked
            ? "FAILED"
            : "VERIFIED",
        docsImpact,
        requiredWikiActions: input.requiredWikiActions,
        wikiArtifacts: input.wikiArtifacts,
        supportDocCandidates: input.supportDocCandidates,
        findings: input.findings,
        summary: input.summary ?? `External ${input.source} validation for ${input.taskId}.`,
        reviewNotes: input.reviewNotes,
        reviewer: input.reviewer ?? input.source,
      };
      const gate = await evaluateReviewGateWithJudgment(reviewInput, taskContent, {
        config: p.judgmentConfig,
      });
      const reviewId = `review-${input.taskId.toLowerCase()}-${input.source}-${Date.now()}`;
      const requiredWikiActions: WikiAction[] =
        gate.requiredWikiActions.length > 0
          ? gate.requiredWikiActions
          : requiredActionsForDocsImpact(docsImpact);
      await persistReviewBundle(p.projectRoot, {
        ...reviewInput,
        requiredWikiActions,
        reviewId,
        createdAt: new Date().toISOString(),
        gate,
      });

      const now = new Date().toISOString();
      const jobId = federatedJobId(input.taskId);
      // TASK-1323: external completions mint through the one constructor.
      const job: FederatedJobRecord = mintFederatedJobRecord({
        projectId: p.projectId,
        jobId,
        taskId: input.taskId,
        jobType: "verify",
        status: "completed",
        correlationId: input.sourceRunId ?? jobId,
        requiredCapabilities: ["external-completion"],
        provenance: {
          channel: "external-completion",
          tokenId,
          remoteAddr: req.ip,
          claimedChannel: req.header("x-quack-channel") ?? undefined,
        },
        extra: {
          hostId: `external:${input.source}`,
          branchName: input.branchName,
          commitSha: branch.commitSha,
          targetBranch: input.targetBranch,
          reviewId,
          autoMerge: input.autoMerge,
          mergeStatus: input.autoMerge ? "not_requested" : undefined,
          completedAt: now,
          evidence: input.evidence,
          decision: {
            reason: `External ${input.source} completion imported for canonical closeout.`,
            source: input.source,
            sourceCardId: input.sourceCardId,
            sourceRunId: input.sourceRunId,
            worktreePath: input.worktreePath,
            baseBranch: input.baseBranch,
            verificationClass: input.verificationClass,
          },
          nextAction: input.autoVerify ? "verify_external_completion" : "admin_review_merge",
        },
      });
      const taskDetails = await resolveFederatedTaskEventDetails(p, job.taskId);
      const taskTitle = sessionTitleForFederatedTask(taskDetails);
      const writer = createWorkflowWriter(
        p,
        federatedSessionId(job.jobId),
        job.taskId,
        taskTitle ?? job.taskId,
      );
      if (gate.judgmentOrchestration) {
        writer.emit("judgment_evaluation", {
          taskId: job.taskId,
          stage: "docs_review",
          sequence: 0,
          final: false,
          orchestration: gate.judgmentOrchestration,
        });
      }
      if (gate.judgmentDecision) {
        writer.emit("judgment_decision", {
          taskId: job.taskId,
          stage: "docs_review",
          sequence: gate.judgmentOrchestration ? 1 : 0,
          final: true,
          decision: gate.judgmentDecision,
        });
      } else if (gate.judgmentProjectionFailure) {
        writer.emit("judgment_projection_failed", {
          taskId: job.taskId,
          stage: "docs_review",
          ...gate.judgmentProjectionFailure,
        });
      }
      await saveFederatedJob(p.projectRoot, job);
      const hostDetails = {
        hostAlias: input.source,
        hostEndpoint: input.worktreePath,
      };
      const externalSessionId = input.sourceRunId ?? input.sourceCardId;
      const sourceLabel = input.source.charAt(0).toUpperCase() + input.source.slice(1);
      emitFederatedSessionStart(p, writer, job, externalSessionId, hostDetails, taskDetails);
      writer.emit("agent_progress_update", {
        taskId: job.taskId,
        jobId: job.jobId,
        hostId: job.hostId,
        ...hostDetails,
        source: input.source,
        sourceCardId: input.sourceCardId,
        sourceRunId: input.sourceRunId,
        completed: [],
        inProgress: [`External ${sourceLabel} completion imported for canonical verification.`],
        remaining: input.autoMerge
          ? ["Headnode verify/merge closeout"]
          : ["Admin review/merge closeout"],
        issues: [],
        rawContent: `External ${sourceLabel} completion imported for ${job.taskId}; running Headnode closeout.`,
        lastUpdated: now,
      } as EventPayload);

      const orchestration = await orchestrateFederatedCompletion(
        p,
        job,
        {
          autoVerify: input.autoVerify,
          autoMerge: input.autoMerge,
          branchName: input.branchName,
          commitSha: branch.commitSha,
          targetBranch: input.targetBranch,
          maxFixAttempts: input.maxFixAttempts,
          verification: {
            reviewId,
            requireReview: true,
            criteriaChecked: input.criteriaChecked,
            criteriaPassed: input.criteriaPassed,
            phaseResults: input.phaseResults,
          },
        },
        federationOrchestrationDeps,
      );
      const workflowState = workflowStateForFederatedStatus(orchestration.job.status);
      const sessionStatus = sessionStatusForFederatedStatus(orchestration.job.status);
      upsertFederatedSessionIndex(p, {
        sessionId: writer.sessionId,
        taskId: orchestration.job.taskId,
        title: taskTitle,
        status: sessionStatus,
        outcome:
          sessionStatus === "active"
            ? `federated_job_${orchestration.job.status}`
            : orchestration.job.status,
        totalCostUsd: sessionStatus === "completed" ? 0 : null,
        durationMs: sessionStatus === "completed" ? 0 : null,
      });
      writer.recordSession(sessionStatus, {
        outcome: `federated_job_${orchestration.job.status}`,
        title: taskTitle,
      });
      if (orchestration.job.status === "completed" || orchestration.job.status === "canceled") {
        writer.emit("session_complete", {
          taskId: orchestration.job.taskId,
          jobId: orchestration.job.jobId,
          outcome: orchestration.job.status,
          durationMs: 0,
          totalCostUsd: 0,
          hostId: orchestration.job.hostId,
          ...hostDetails,
          source: input.source,
          workflowState,
          nextAction: orchestration.job.nextAction,
          mergeStatus: orchestration.job.mergeStatus,
          mergeCommitSha: orchestration.job.mergeCommitSha,
        } as EventPayload);
      } else if (
        orchestration.job.status === "failed" ||
        orchestration.job.status === "rejected" ||
        orchestration.job.status === "blocked"
      ) {
        const blockReasonCode =
          orchestration.job.blockReasonCode ??
          (orchestration.job.status === "blocked" ? "pending_manual_handoff" : undefined);
        writer.emit("session_error", {
          taskId: orchestration.job.taskId,
          jobId: orchestration.job.jobId,
          error:
            orchestration.job.error ??
            `External ${input.source} completion ${orchestration.job.status}`,
          failedStage: "external_completion_closeout",
          hostId: orchestration.job.hostId,
          ...hostDetails,
          source: input.source,
          workflowState,
          nextAction: orchestration.job.nextAction,
          mergeStatus: orchestration.job.mergeStatus,
          blockReasonCode,
        } as EventPayload);
        if (blockReasonCode) {
          writer.emit("workflow_pending_state", {
            taskId: orchestration.job.taskId,
            jobId: orchestration.job.jobId,
            state: workflowState,
            blockReasonCode,
            label:
              orchestration.job.error ??
              `External ${input.source} completion ${orchestration.job.status}`,
            hostId: orchestration.job.hostId,
            ...hostDetails,
            source: input.source,
          } as EventPayload);
        }
      }
      const scheduler = shouldAutoRefillAfterFederatedUpdate(job, orchestration.job)
        ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
        : undefined;
      const projection = await resolveAndBroadcastProjection(p, input.taskId);
      res.status(202).json({
        ok: true,
        tokenId,
        review: {
          reviewId,
          mergeReady: gate.mergeReady,
          issues: gate.issues,
        },
        job: orchestration.job,
        orchestration,
        scheduler,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to import external completion: ${msg}` });
    }
  });

  app.post("/v1/federation/jobs", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z.object({
      taskId: z.string().trim().min(1),
      jobType: z.enum(["intake", "verify", "fix", "dispatch"]).default("dispatch"),
      correlationId: z.string().trim().min(1).optional(),
      preferredHostId: z.string().trim().min(1).optional(),
      requiredCapabilities: z.array(z.string().trim().min(1)).optional(),
      hosts: z.array(federatedHostSchema).optional(),
    });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_job_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    if (await refuseFederationAdmission(p, parsed.data.taskId, res)) return;

    try {
      const body = parsed.data;
      const hosts = body.hosts
        ? await applyActiveFederatedLeases(p.projectRoot, body.hosts)
        : await defaultFederatedHosts(p.projectRoot);
      const jobId = federatedJobId(body.taskId);
      const correlationId = body.correlationId ?? jobId;
      const route = routeFederatedJob({
        taskId: body.taskId,
        jobType: body.jobType,
        requiredCapabilities: body.requiredCapabilities,
        preferredHostId: body.preferredHostId,
        hosts,
      });
      const now = new Date().toISOString();
      const taskDetails = await resolveFederatedTaskEventDetails(p, body.taskId);
      const taskTitle = sessionTitleForFederatedTask(taskDetails);
      const writer = createWorkflowWriter(
        p,
        `federation-${jobId}`,
        body.taskId,
        taskTitle ?? body.taskId,
      );
      writer.recordSession("completed", {
        outcome: route.ok ? "federated_job_assigned" : "federated_transport_failed",
        title: taskTitle,
      });
      // TASK-1323: both legacy branches mint through the one constructor,
      // and the submitted event carries the same provenance as the record.
      const legacyProvenance = {
        channel: "federation-jobs-legacy" as const,
        tokenId,
        remoteAddr: req.ip,
        claimedChannel: req.header("x-quack-channel") ?? undefined,
      };
      writer.emit("federated_job_submitted", {
        jobId,
        taskId: body.taskId,
        taskTitle: taskDetails.taskTitle,
        jobType: body.jobType,
        correlationId,
        requiredCapabilities: route.requiredCapabilities,
        provenance: legacyProvenance,
      });

      let record: FederatedJobRecord;
      if (route.ok) {
        const acquiredAt = now;
        const leaseExpiresAt = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString();
        record = mintFederatedJobRecord({
          projectId: p.projectId,
          jobId,
          taskId: body.taskId,
          jobType: body.jobType,
          status: "assigned",
          correlationId,
          requiredCapabilities: route.requiredCapabilities,
          provenance: legacyProvenance,
          extra: {
            hostId: route.host.id,
            fallbackUsed: route.fallbackUsed,
            decision: route.decision,
            lease: {
              leaseId: `${jobId}:${route.host.id}`,
              hostId: route.host.id,
              acquiredAt,
              expiresAt: leaseExpiresAt,
            },
          },
        });
        writer.emit("federated_job_assigned", {
          jobId,
          taskId: body.taskId,
          taskTitle: taskDetails.taskTitle,
          hostId: route.host.id,
          ...federatedHostEventDetailsFromHost(route.host),
          correlationId,
          fallbackUsed: route.fallbackUsed,
          requiredCapabilities: route.requiredCapabilities,
        });
        await saveFederatedJob(p.projectRoot, record);
        const projection = await resolveAndBroadcastProjection(p, body.taskId);
        res.status(202).json({ ok: true, accepted: true, job: record, projection });
        return;
      }

      record = mintFederatedJobRecord({
        projectId: p.projectId,
        jobId,
        taskId: body.taskId,
        jobType: body.jobType,
        status: "blocked",
        correlationId,
        requiredCapabilities: route.requiredCapabilities,
        provenance: legacyProvenance,
        extra: {
          retryable: route.retryable,
          blockReasonCode: route.blockReasonCode,
          error: route.error,
          decision: route.fallback,
        },
      });
      writer.emit("federated_transport_failed", {
        jobId,
        taskId: body.taskId,
        correlationId,
        retryable: route.retryable,
        blockReasonCode: route.blockReasonCode,
        error: route.error,
      });
      await saveFederatedJob(p.projectRoot, record);
      const projection = await resolveAndBroadcastProjection(p, body.taskId);
      res.status(409).json({
        ok: false,
        error: route.error,
        retryable: route.retryable,
        blockReasonCode: route.blockReasonCode,
        job: record,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to submit federated job: ${msg}` });
    }
  });

  app.post("/v1/federation/jobs/:jobId/reconcile", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z.object({
      autoVerify: z.boolean().optional(),
      autoMerge: z.boolean().optional(),
      targetBranch: z.string().trim().min(1).optional(),
      branchName: z.string().trim().min(1).optional(),
      commitSha: z.string().trim().min(1).optional(),
      maxFixAttempts: z.number().int().min(0).max(10).optional(),
      verification: z
        .object({
          reviewId: z.string().trim().min(1).optional(),
          requireReview: z.boolean().optional(),
          criteriaChecked: z.number().int().nonnegative().optional(),
          criteriaPassed: z.number().int().nonnegative().optional(),
          phaseResults: z
            .array(
              z.object({
                name: z.string().trim().min(1),
                status: z.enum(["passed", "failed", "skipped"]),
                summary: z.string().trim().min(1).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_reconcile_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const existing = await loadFederatedJob(p.projectRoot, jobId);
    if (!existing) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }
    existing.projectId ??= p.projectId;
    if (["canceled", "failed", "rejected"].includes(existing.status)) {
      res.status(409).json({
        error: "federated_reconcile_terminal",
        message: `Federated job ${jobId} is terminal (${existing.status}) and cannot be reconciled.`,
        jobId,
        status: existing.status,
      });
      return;
    }

    try {
      const orchestration = await reconcileFederatedJob(
        p,
        existing,
        parsed.data,
        federationOrchestrationDeps,
        await buildFederationClaimantIndex(p),
      );
      const scheduler = shouldAutoRefillAfterFederatedUpdate(existing, orchestration.job)
        ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
        : undefined;
      const projection = await resolveAndBroadcastProjection(p, orchestration.job.taskId);
      res.status(200).json({
        ok: true,
        tokenId,
        job: orchestration.job,
        orchestration,
        scheduler,
        projection,
      });
    } catch (error: unknown) {
      sendFederationOrchestrationFailure(res, error, { jobId, taskId: existing.taskId });
    }
  });

  app.post("/v1/federation/jobs/:jobId/events", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const relayEventSchema = z.object({
      stage: z.string().trim().min(1),
      payload: z.record(z.string(), z.unknown()).default({}),
      timestamp: z.string().trim().min(1).optional(),
      sequence: z.number().int().nonnegative().optional(),
      sessionId: z.string().trim().min(1).optional(),
    });
    const relayPayloadSchema = z
      .object({
        hostId: z.string().trim().min(1).optional(),
        leaseId: z.string().trim().min(1).optional(),
        status: z
          .enum([
            "assigned",
            "queued",
            "running",
            "started",
            "verifying",
            "verify",
            "fixing",
            // TASK-1329 / QPI-041: without this member the relay REJECTED a paused
            // run, so the listener (which ignored the response) dropped the pause
            // and the job stayed "running" until it was reaped as failed. Adding it
            // to the wire schema is what makes the pause reportable at all.
            "awaiting_approval",
            "completed",
            "complete",
            "failed",
            "rejected",
            "blocked",
            "canceled",
          ])
          .optional(),
        remoteSessionId: z.string().trim().min(1).optional(),
        resumeSessionId: z.string().trim().min(1).optional(),
        resumeStartedAt: z.string().datetime().optional(),
        message: z.string().trim().min(1).optional(),
        sequence: z.number().int().nonnegative().optional(),
        blockReasonCode: z.string().trim().min(1).optional(),
        /** TASK-1329: which gate a paused run is waiting at, so `nextAction` can
         *  name the decision instead of sending an operator to investigate a
         *  crash that never happened. */
        pendingGate: z
          .object({
            stage: z.enum(["blueprint", "judge"]),
            since: z.string().datetime(),
            reason: z.string().trim().min(1).optional(),
          })
          .optional(),
        pauseIdentity: z
          .object({
            jobId: z.string().trim().min(1),
            taskId: z.string().trim().min(1),
            jobType: z.literal("dispatch"),
            hostId: z.string().trim().min(1),
            sessionId: z.string().trim().min(1),
          })
          .optional(),
        resumeGrant: z
          .object({
            token: z.string().trim().min(1),
            projectId: z.string().trim().min(1),
            jobId: z.string().trim().min(1),
            taskId: z.string().trim().min(1),
            jobType: z.literal("dispatch"),
            hostId: z.string().trim().min(1),
            originalSessionId: z.string().trim().min(1),
            generation: z.number().int().positive(),
            releaseNonce: z.string().trim().min(1),
            claimToken: z.string().trim().min(1),
            leaseId: z.string().trim().min(1),
            issuedAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
          })
          .strict()
          .optional(),
        // (see the .superRefine below: pendingGate is REQUIRED when the status is
        // awaiting_approval, so the classification cannot be asserted without
        // naming the gate it was earned from)
        branchName: z.string().trim().min(1).optional(),
        commitSha: z.string().trim().min(1).optional(),
        targetBranch: z.string().trim().min(1).optional(),
        reviewId: z.string().trim().min(1).optional(),
        autoVerify: z.boolean().default(true),
        autoMerge: z.boolean().default(false),
        maxFixAttempts: z.number().int().min(0).max(10).optional(),
        verification: z
          .object({
            reviewId: z.string().trim().min(1).optional(),
            requireReview: z.boolean().optional(),
            criteriaChecked: z.number().int().nonnegative().optional(),
            criteriaPassed: z.number().int().nonnegative().optional(),
            phaseResults: z
              .array(
                z.object({
                  name: z.string().trim().min(1),
                  status: z.enum(["passed", "failed", "skipped"]),
                  summary: z.string().trim().min(1).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        workerCompletion: z
          .object({
            canonicalSessionId: z.string().trim().min(1).optional(),
            verified: z.boolean().optional(),
            verificationWorkflowId: z.string().trim().min(1).optional(),
            verificationVerdict: z.enum(["VERIFIED", "FAILED", "BLOCKED"]).optional(),
            autoMerged: z.boolean().optional(),
            mergeTargetBranch: z.string().trim().min(1).optional(),
            mergeCommitSha: z.string().trim().min(1).optional(),
          })
          .optional(),
        events: z.array(relayEventSchema).max(200).default([]),
        evidence: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
      })
      .refine((value) => value.status || value.events.length > 0 || value.evidence.length > 0, {
        message: "At least one of status, events, or evidence is required.",
      })
      .refine(
        // TASK-1329 round-2 R2-5: `awaiting_approval` is a CLAIM about disk state,
        // and it has to be earned. Without this the wire accepts a bare pause with
        // no gate, `nextAction` degrades to a generic decide_human_gate, and the
        // operator is told to decide something the record cannot name - which is
        // the same "trust the label, not the evidence" failure in a nicer costume.
        (value) => value.status !== "awaiting_approval" || Boolean(value.pendingGate),
        {
          message: "pendingGate is required when status is awaiting_approval.",
          path: ["pendingGate"],
        },
      )
      .refine((value) => value.status !== "awaiting_approval" || Boolean(value.pauseIdentity), {
        message: "pauseIdentity is required when status is awaiting_approval.",
        path: ["pauseIdentity"],
      })
      .refine((value) => value.status !== "awaiting_approval" || Boolean(value.leaseId), {
        message: "leaseId is required when status is awaiting_approval.",
        path: ["leaseId"],
      });

    const parsed = relayPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_job_event_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const existing = await loadFederatedJob(p.projectRoot, jobId);
    if (!existing) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }
    existing.projectId ??= p.projectId;

    const body = parsed.data;
    if (
      body.pauseIdentity &&
      (body.pauseIdentity.jobId !== existing.jobId ||
        body.pauseIdentity.taskId !== existing.taskId ||
        body.pauseIdentity.jobType !== existing.jobType ||
        body.pauseIdentity.hostId !== existing.hostId)
    ) {
      res.status(409).json({
        error: "federated_pause_identity_mismatch",
        message: `Recovered pause identity does not match federated job ${jobId}.`,
      });
      return;
    }
    if (existing.hostId && body.hostId && body.hostId !== existing.hostId) {
      res.status(409).json({
        error: "federated_job_host_mismatch",
        message: `Job ${jobId} is assigned to ${existing.hostId}; ${body.hostId} cannot report events for it.`,
        jobId,
        expectedHostId: existing.hostId,
        actualHostId: body.hostId,
      });
      return;
    }
    const resumeMutation = Boolean(body.pauseIdentity || body.resumeGrant || existing.pause);
    const mutationHostId = body.hostId ?? existing.hostId;
    if (
      resumeMutation &&
      (!mutationHostId || !(await requireListenerTokenBinding(p, mutationHostId, tokenId, res)))
    ) {
      if (!mutationHostId && !res.headersSent) {
        res.status(409).json({
          error: "federated_resume_host_required",
          message: `Resume mutation for ${jobId} requires its bound worker host.`,
        });
      }
      return;
    }

    const now = new Date().toISOString();
    const requestedStatus = body.status ? normalizeFederatedRuntimeStatus(body.status) : undefined;
    const normalizedStatusAtRead = requestedStatus ?? existing.status;
    const hostId = body.hostId ?? existing.hostId;
    const newlyQueued = Boolean(
      body.status && normalizedStatusAtRead === "queued" && existing.status !== "queued",
    );
    const newlyAttached = Boolean(
      body.status &&
      hostId &&
      holdsWorkerAttachment(normalizedStatusAtRead) &&
      (!holdsWorkerAttachment(existing.status) || !existing.lease),
    );
    if (
      (newlyQueued || newlyAttached) &&
      (await refuseFederationAdmission(p, existing.taskId, res))
    ) {
      return;
    }
    const lastEvent = body.events.at(-1);
    const statusUpdateReceived = Boolean(body.status);
    let transitionFailure: FederatedPauseTransitionError | undefined;
    let immutableTerminalReceipt = false;
    let immutablePauseReceipt = false;
    const atomicUpdate = await updateFederatedJob(p.projectRoot, jobId, (current) => {
      try {
        if (
          body.pauseIdentity &&
          (body.pauseIdentity.jobId !== current.jobId ||
            body.pauseIdentity.taskId !== current.taskId ||
            body.pauseIdentity.jobType !== current.jobType ||
            body.pauseIdentity.hostId !== current.hostId)
        ) {
          throw new FederatedPauseTransitionError(
            "federated_pause_identity_mismatch",
            `Recovered pause identity does not match federated job ${jobId}.`,
          );
        }
        if (current.hostId && body.hostId && body.hostId !== current.hostId) {
          throw new FederatedPauseTransitionError(
            "federated_job_host_mismatch",
            `Job ${jobId} is assigned to ${current.hostId}; ${body.hostId} cannot report events for it.`,
          );
        }

        let base = current;
        const effectiveStatus = requestedStatus ?? base.status;
        if (body.status && base.pause?.state === "manual_recovery") {
          throw new FederatedPauseTransitionError(
            "federated_pause_manual_recovery",
            `Job ${jobId} is owned by manual recovery and cannot be advanced by a worker status event.`,
          );
        }
        if (
          effectiveStatus === "awaiting_approval" &&
          base.status === "awaiting_approval" &&
          body.pauseIdentity &&
          body.pendingGate &&
          base.pause &&
          ["released", "resume_requested", "resume_claimed", "approved_but_not_started"].includes(
            base.pause.state,
          ) &&
          base.pause.sessionId === body.pauseIdentity.sessionId &&
          base.pause.gate === body.pendingGate.stage &&
          base.pause.openedAt === body.pendingGate.since
        ) {
          // A release response may be lost after the lease was surrendered.
          // Let the exact same pause occurrence observe the durable state
          // without requiring or recreating a lease; this is a no-mutation
          // receipt and cannot advance the generation.
          immutablePauseReceipt = true;
          return base;
        }
        if (terminalFederatedStatus(base.status)) {
          if (body.status && effectiveStatus !== base.status) {
            throw new FederatedPauseTransitionError(
              "federated_status_regression",
              `Terminal federated job ${jobId} cannot move from ${base.status} to ${effectiveStatus}.`,
            );
          }
          if (base.pause?.startGrant?.consumedAt) {
            if (
              !body.resumeGrant ||
              !exactFederatedResumeTerminalReceiptMatches(base, {
                startGrant: body.resumeGrant,
                resumedSessionId: body.resumeSessionId,
              })
            ) {
              throw new FederatedPauseTransitionError(
                "federated_resume_grant_mismatch",
                `Terminal resume receipt is not bound to the consumed grant and session for ${jobId}.`,
              );
            }
          }
          // Terminal delivery is an immutable receipt. In particular it never
          // extends a missing/expired/reassigned lease or appends mutable fields.
          immutableTerminalReceipt = true;
          return base;
        }
        if (body.status) {
          assertFederatedStatusTransition(base.status, effectiveStatus, jobId);
        }
        if (
          body.status &&
          ["assigned", "running", "verifying", "fixing"].includes(effectiveStatus) &&
          !base.pause &&
          !base.lease
        ) {
          throw new FederatedPauseTransitionError(
            "federated_lease_epoch_required",
            `Job ${jobId} cannot attach a worker without a scheduler-issued lease epoch.`,
          );
        }
        if (
          effectiveStatus === "awaiting_approval" &&
          body.pauseIdentity &&
          (base.remoteSessionId !== body.pauseIdentity.sessionId ||
            !base.lease ||
            base.lease.leaseId !== body.leaseId ||
            base.lease.hostId !== body.pauseIdentity.hostId ||
            !Number.isFinite(Date.parse(base.lease.expiresAt)) ||
            Date.parse(base.lease.expiresAt) <= Date.parse(now))
        ) {
          throw new FederatedPauseTransitionError(
            "federated_pause_epoch_mismatch",
            `Pause report for ${jobId} is not bound to its current worker session and live lease.`,
          );
        }

        if (body.resumeGrant) {
          if (!body.status || effectiveStatus === "awaiting_approval" || !base.pause) {
            throw new FederatedPauseTransitionError(
              "invalid_federated_resume_status",
              "A resume grant must accompany a concrete post-pause status.",
            );
          }
          const alreadyConsumed = Boolean(base.pause.startGrant?.consumedAt);
          if (
            alreadyConsumed &&
            terminalFederatedStatus(base.status) &&
            effectiveStatus !== base.status
          ) {
            throw new FederatedPauseTransitionError(
              "federated_resume_status_regression",
              `Terminal resumed job ${jobId} cannot move from ${base.status} back to ${effectiveStatus}.`,
            );
          }
          if (
            alreadyConsumed &&
            ((base.status === "running" && effectiveStatus === "assigned") ||
              (["verifying", "fixing"].includes(base.status) &&
                ["assigned", "running"].includes(effectiveStatus)))
          ) {
            throw new FederatedPauseTransitionError(
              "federated_resume_status_regression",
              `Resumed job ${jobId} cannot move from ${base.status} back to ${effectiveStatus}.`,
            );
          }
          if (
            effectiveStatus === "rejected" &&
            (!alreadyConsumed || !base.pause.startGrant?.resumedSessionId)
          ) {
            base = transitionFederatedResumeTerminal(base, {
              startGrant: body.resumeGrant,
              resumeStartedAt: body.resumeStartedAt,
              now,
            });
          } else {
            if (!body.resumeSessionId) {
              throw new FederatedPauseTransitionError(
                "federated_resume_session_required",
                "A resumed worker status requires the exact locally started session id.",
              );
            }
            if (!alreadyConsumed && effectiveStatus !== "running") {
              throw new FederatedPauseTransitionError(
                "federated_resume_running_required",
                "The first grant-bound status must observe the newly started child as running.",
              );
            }
            base = transitionFederatedResumeRunning(base, {
              startGrant: body.resumeGrant,
              resumedSessionId: body.resumeSessionId,
              resumeStartedAt: body.resumeStartedAt,
              now,
            });
          }
        } else if (body.status && base.pause && effectiveStatus !== "awaiting_approval") {
          // Once a pause generation exists, every attempt to leave it must be
          // bound to that generation's exact grant.  This includes stale
          // assigned/verifying/fixing reports and all terminal closeouts; a
          // manual-recovery record remains operator-owned.
          throw new FederatedPauseTransitionError(
            "federated_resume_grant_required",
            `Job ${jobId} can leave its pause only with the exact start grant.`,
          );
        }

        const normalizedStatus = requestedStatus ?? base.status;
        const currentHostId = body.hostId ?? base.hostId;
        const remoteSessionId =
          body.resumeSessionId ??
          body.workerCompletion?.canonicalSessionId ??
          body.remoteSessionId ??
          body.events.find((event) => event.sessionId)?.sessionId ??
          base.remoteSessionId;
        const eventCount =
          (base.eventCount ?? 0) +
          body.events.length +
          (body.status ? 1 : 0) +
          body.evidence.length;
        // A released pause has deliberately surrendered its lease.  Every
        // other attached status may only extend an existing epoch; status
        // traffic must never manufacture a replacement lease id.
        const preservesReleasedPause =
          normalizedStatus === "awaiting_approval" &&
          base.pause !== undefined &&
          !federatedJobHoldsWorkerAttachment(base);
        if (
          statusUpdateReceived &&
          holdsWorkerAttachment(normalizedStatus) &&
          base.lease &&
          (!Number.isFinite(Date.parse(base.lease.expiresAt)) ||
            Date.parse(base.lease.expiresAt) <= Date.parse(now))
        ) {
          throw new FederatedPauseTransitionError(
            "federated_lease_expired",
            `Expired lease ${base.lease.leaseId} cannot be extended by a status event for ${jobId}.`,
          );
        }
        const lease =
          !statusUpdateReceived || preservesReleasedPause
            ? base.lease
            : currentHostId && holdsWorkerAttachment(normalizedStatus) && base.lease
              ? {
                  ...base.lease,
                  expiresAt: new Date(
                    Date.parse(now) + (base.leaseTtlMs ?? 30 * 60 * 1000),
                  ).toISOString(),
                }
              : undefined;
        const pendingGate =
          normalizedStatus === "awaiting_approval"
            ? (body.pendingGate ?? base.pendingGate)
            : undefined;
        const nextAction = !statusUpdateReceived
          ? base.nextAction
          : normalizedStatus === "awaiting_approval"
            ? `decide_${pendingGate?.stage ?? "human"}_gate:${base.taskId}`
            : normalizedStatus === "running" && body.resumeGrant
              ? `run_${base.jobType}`
              : normalizedStatus === "failed"
                ? "investigate_failed_worker"
                : normalizedStatus === "rejected" || normalizedStatus === "blocked"
                  ? "manual_handoff"
                  : normalizedStatus === "canceled"
                    ? "canceled"
                    : (base.nextAction ?? `run_${base.jobType}`);
        const blockReasonCode =
          normalizedStatus === "blocked"
            ? ((body.blockReasonCode as BlockReasonCode | undefined) ?? base.blockReasonCode)
            : undefined;
        const error =
          normalizedStatus === "failed" ||
          normalizedStatus === "rejected" ||
          normalizedStatus === "blocked"
            ? (body.message ?? base.error)
            : base.error;
        const reportedTargetBranch = body.workerCompletion?.mergeTargetBranch ?? body.targetBranch;
        for (const [label, existingValue, reportedValue, caseInsensitive] of [
          ["branchName", base.branchName, body.branchName, false],
          ["commitSha", base.commitSha, body.commitSha, true],
          ["targetBranch", base.targetBranch, reportedTargetBranch, false],
        ] as const) {
          if (
            existingValue &&
            reportedValue &&
            (caseInsensitive
              ? existingValue.toLowerCase() !== reportedValue.toLowerCase()
              : existingValue !== reportedValue)
          ) {
            throw new FederatedPauseTransitionError(
              "federated_publication_identity_mismatch",
              `Federated completion cannot replace the recorded ${label} for ${jobId}.`,
            );
          }
        }
        const reportedCommitSha = body.commitSha;
        const nextRecord: FederatedJobRecord = {
          ...base,
          status: normalizedStatus,
          hostId: currentHostId,
          remoteSessionId,
          branchName: base.branchName ?? body.branchName,
          commitSha: base.commitSha ?? reportedCommitSha,
          targetBranch: base.targetBranch ?? reportedTargetBranch,
          reviewId: body.reviewId ?? body.verification?.reviewId ?? base.reviewId,
          autoMerge: body.autoMerge || base.autoMerge,
          blockReasonCode,
          pendingGate,
          error,
          nextAction,
          lastEventAt: now,
          lastEventStage: lastEvent?.stage ?? base.lastEventStage,
          eventCount,
          evidence:
            body.evidence.length > 0 ? [...(base.evidence ?? []), ...body.evidence] : base.evidence,
          completedAt:
            statusUpdateReceived && terminalFederatedStatus(normalizedStatus)
              ? (base.completedAt ?? now)
              : base.completedAt,
          lease,
          updatedAt: now,
        };
        if (normalizedStatus === "awaiting_approval" && body.pauseIdentity && pendingGate) {
          return transitionFederatedPause(nextRecord, {
            identity: { ...body.pauseIdentity, projectId: p.projectId },
            gate: pendingGate,
            now,
          });
        }
        return nextRecord;
      } catch (error: unknown) {
        transitionFailure =
          error instanceof FederatedPauseTransitionError
            ? error
            : new FederatedPauseTransitionError(
                "federated_job_event_transition_failed",
                error instanceof Error ? error.message : String(error),
              );
        return undefined;
      }
    });
    if (transitionFailure) {
      res.status(409).json({ error: transitionFailure.code, message: transitionFailure.message });
      return;
    }
    if (!atomicUpdate.record) {
      res.status(404).json({ error: "federated_job_not_found", jobId });
      return;
    }
    const updated: FederatedJobRecord = atomicUpdate.record;
    if (immutableTerminalReceipt || immutablePauseReceipt) {
      res.status(202).json({ accepted: true, duplicate: true, job: updated });
      return;
    }
    const normalizedStatus = updated.status;
    const remoteSessionId = updated.remoteSessionId;

    const taskDetails = await resolveFederatedTaskEventDetails(p, updated.taskId);
    const taskTitle = sessionTitleForFederatedTask(taskDetails);
    const writer = createWorkflowWriter(
      p,
      federatedSessionId(jobId),
      updated.taskId,
      taskTitle ?? updated.taskId,
    );
    const hostDetails = await resolveFederatedHostEventDetails(p, hostId);
    emitFederatedSessionStart(p, writer, updated, remoteSessionId, hostDetails, taskDetails);

    if (body.status) {
      const workflowState = workflowStateForFederatedStatus(normalizedStatus);
      const sessionStatus = sessionStatusForFederatedStatus(normalizedStatus);
      upsertFederatedSessionIndex(p, {
        sessionId: writer.sessionId,
        taskId: updated.taskId,
        title: taskTitle,
        status: sessionStatus,
        outcome:
          sessionStatus === "active" ? `federated_job_${normalizedStatus}` : normalizedStatus,
        totalCostUsd: sessionStatus === "completed" ? 0 : null,
        durationMs: sessionStatus === "completed" ? 0 : null,
      });
      writer.recordSession(sessionStatus, {
        outcome: `federated_job_${normalizedStatus}`,
        title: taskTitle,
      });
      writer.emit("federated_job_status", {
        jobId,
        taskId: updated.taskId,
        taskTitle: taskDetails.taskTitle,
        hostId,
        ...hostDetails,
        status: normalizedStatus,
        workflowState,
        blockReasonCode: body.blockReasonCode as BlockReasonCode | undefined,
        correlationId: updated.correlationId,
        remoteSessionId,
        message: body.message,
        sequence: body.sequence,
        lastEventStage: lastEvent?.stage ?? updated.lastEventStage,
        evidenceCount: body.evidence.length,
      });
      writer.emit("agent_progress_update", {
        taskId: updated.taskId,
        completed:
          normalizedStatus === "completed" ? [`${hostId ?? "remote host"} completed ${jobId}`] : [],
        // TASK-1329: a paused run stays visible here (attachment, not
        // assignability) so it does not silently vanish from the progress view.
        // It is deliberately NOT added to `issues` below: waiting on a human is
        // not a problem report.
        inProgress: holdsWorkerAttachment(normalizedStatus)
          ? [`${hostId ?? "remote host"}: ${normalizedStatus}`]
          : [],
        remaining: [],
        issues:
          normalizedStatus === "failed" ||
          normalizedStatus === "rejected" ||
          normalizedStatus === "blocked"
            ? [body.message ?? `Federated job ${normalizedStatus}`]
            : [],
        rawContent:
          body.message ?? `Federated job ${normalizedStatus} on ${hostId ?? "remote host"}`,
        lastUpdated: now,
      } as EventPayload);
      if (normalizedStatus === "completed" || normalizedStatus === "canceled") {
        writer.emit("session_complete", {
          outcome: normalizedStatus,
          durationMs: 0,
          totalCostUsd: 0,
          hostId,
          ...hostDetails,
        });
      } else if (
        normalizedStatus === "failed" ||
        normalizedStatus === "rejected" ||
        normalizedStatus === "blocked"
      ) {
        const blockReasonCode =
          (body.blockReasonCode as BlockReasonCode | undefined) ??
          (normalizedStatus === "blocked" ? "pending_manual_handoff" : undefined);
        writer.emit("session_error", {
          error: body.message ?? `Federated job ${normalizedStatus}`,
          failedStage: "federated_worker",
          hostId,
          ...hostDetails,
        });
        if (blockReasonCode) {
          writer.emit("workflow_pending_state", {
            taskId: updated.taskId,
            state: workflowState,
            blockReasonCode,
            label: body.message ?? `Federated ${normalizedStatus} on ${hostId ?? "remote host"}`,
            hostId,
            ...hostDetails,
          } as EventPayload);
        }
      }
    }

    for (const event of body.events as FederatedRelayEvent[]) {
      const relayedPayload = {
        jobId,
        taskId: updated.taskId,
        hostId,
        ...hostDetails,
        remoteSessionId: event.sessionId ?? remoteSessionId,
        remoteStage: event.stage,
        remoteTimestamp: event.timestamp,
        sequence: event.sequence,
        relayedPayload: event.payload,
      };
      writer.emit("federated_job_event", relayedPayload);
      if (isRelayedSlackStage(event.stage)) {
        writer.emit(event.stage, {
          ...event.payload,
          remote: {
            jobId,
            hostId,
            ...hostDetails,
            remoteSessionId: event.sessionId ?? remoteSessionId,
            remoteStage: event.stage,
            remoteTimestamp: event.timestamp,
            sequence: event.sequence,
            receivedAt: now,
          },
        } as EventPayload);
      }
    }

    try {
      const orchestration =
        normalizedStatus === "completed"
          ? await orchestrateFederatedCompletion(
              p,
              updated,
              {
                autoVerify: body.autoVerify,
                autoMerge: body.autoMerge || existing.autoMerge === true,
                targetBranch: body.targetBranch ?? updated.targetBranch,
                branchName: body.branchName ?? updated.branchName,
                commitSha: body.commitSha ?? updated.commitSha,
                verification: body.verification
                  ? {
                      ...body.verification,
                      reviewId: body.verification.reviewId ?? body.reviewId ?? updated.reviewId,
                    }
                  : body.reviewId
                    ? { reviewId: body.reviewId }
                    : undefined,
                maxFixAttempts: body.maxFixAttempts,
                workerCompletion: body.workerCompletion,
              },
              federationOrchestrationDeps,
            )
          : undefined;
      const finalJob =
        orchestration?.job ?? (await loadFederatedJob(p.projectRoot, updated.jobId)) ?? updated;
      const scheduler = shouldAutoRefillAfterFederatedUpdate(existing, finalJob)
        ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
        : undefined;
      const projection = await resolveAndBroadcastProjection(p, finalJob.taskId);
      res.status(202).json({
        ok: true,
        accepted: true,
        job: finalJob,
        orchestration,
        scheduler,
        projection,
        relayedEvents: body.events.length,
        relayedSlackEvents: body.events.filter((event) => isRelayedSlackStage(event.stage)).length,
        tokenId,
      });
    } catch (error: unknown) {
      sendFederationOrchestrationFailure(res, error, { jobId, taskId: updated.taskId });
    }
  });

  app.post("/v1/federation/jobs/:jobId/pause/release", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const parsed = z
      .object({
        hostId: z.string().trim().min(1),
        generation: z.number().int().positive(),
        releaseNonce: z.string().trim().min(1),
        localStateArmed: z.literal(true),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_pause_release",
        details: validationDetails(parsed.error),
      });
      return;
    }
    if (!(await requireListenerTokenBinding(p, parsed.data.hostId, tokenId, res))) return;
    try {
      const previous = await loadFederatedJob(p.projectRoot, jobId);
      const job = await releaseFederatedPause(p.projectRoot, { jobId, ...parsed.data });
      const scheduler =
        previous && shouldAutoRefillAfterFederatedUpdate(previous, job)
          ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
          : undefined;
      res.json({ ok: true, tokenId, job, scheduler });
    } catch (error: unknown) {
      if (error instanceof FederatedPauseTransitionError) {
        res
          .status(error.code === "federated_job_not_found" ? 404 : 409)
          .json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/v1/federation/jobs/:jobId/resume/request", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const parsed = z
      .object({
        hostId: z.string().trim().min(1),
        generation: z.number().int().positive(),
        releaseNonce: z.string().trim().min(1),
        decision: z.object({
          action: z.enum(["approved", "rejected"]),
          reason: z.string().optional(),
        }),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_resume_request",
        details: validationDetails(parsed.error),
      });
      return;
    }
    if (!(await requireListenerTokenBinding(p, parsed.data.hostId, tokenId, res))) return;
    try {
      const job = await requestFederatedResume(p.projectRoot, { jobId, ...parsed.data });
      res.json({ ok: true, tokenId, job });
    } catch (error: unknown) {
      if (error instanceof FederatedPauseTransitionError) {
        res
          .status(error.code === "federated_job_not_found" ? 404 : 409)
          .json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/v1/federation/jobs/:jobId/resume/claim", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const parsed = z
      .object({
        hostId: z.string().trim().min(1),
        generation: z.number().int().positive(),
        releaseNonce: z.string().trim().min(1),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_resume_claim",
        details: validationDetails(parsed.error),
      });
      return;
    }
    if (!(await requireListenerTokenBinding(p, parsed.data.hostId, tokenId, res))) return;
    try {
      const hosts = await defaultFederatedHosts(p.projectRoot);
      const host = hosts.find((candidate) => candidate.id === parsed.data.hostId);
      if (!host || host.enabled === false || host.healthy !== true) {
        const job = await markFederatedPauseManualRecovery(p.projectRoot, {
          jobId,
          hostId: parsed.data.hostId,
          generation: parsed.data.generation,
          releaseNonce: parsed.data.releaseNonce,
          reason: `Original host ${parsed.data.hostId} is unavailable; explicit worktree recovery is required.`,
        });
        res.status(409).json({
          error: "federated_resume_host_unavailable",
          message: `Original host ${parsed.data.hostId} is unavailable; explicit worktree recovery is required.`,
          job,
        });
        return;
      }
      if ((host.currentLoad ?? 0) >= (host.maxConcurrentJobs ?? 1)) {
        res.status(409).json({ error: "federated_resume_host_at_capacity" });
        return;
      }
      const job = await claimFederatedResume(p.projectRoot, { jobId, ...parsed.data });
      res.json({ ok: true, tokenId, job, claim: job.pause?.claim });
    } catch (error: unknown) {
      if (error instanceof FederatedPauseTransitionError) {
        res
          .status(error.code === "federated_job_not_found" ? 404 : 409)
          .json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/v1/federation/jobs/:jobId/resume/ack", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const parsed = z
      .object({
        projectId: z.string().trim().min(1),
        taskId: z.string().trim().min(1),
        jobType: z.literal("dispatch"),
        hostId: z.string().trim().min(1),
        originalSessionId: z.string().trim().min(1),
        generation: z.number().int().positive(),
        releaseNonce: z.string().trim().min(1),
        claimToken: z.string().trim().min(1),
        leaseId: z.string().trim().min(1),
        phase: z.literal("approved_but_not_started"),
      })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_federated_resume_ack", details: validationDetails(parsed.error) });
      return;
    }
    if (!(await requireListenerTokenBinding(p, parsed.data.hostId, tokenId, res))) return;
    try {
      const job = await acknowledgeFederatedResumeStart(p.projectRoot, { jobId, ...parsed.data });
      res.json({ ok: true, tokenId, job, startGrant: job.pause?.startGrant });
    } catch (error: unknown) {
      if (error instanceof FederatedPauseTransitionError) {
        res
          .status(error.code === "federated_job_not_found" ? 404 : 409)
          .json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/v1/federation/jobs/:jobId/admin-closeout", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const scope = resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const closeoutSchema = z.object({
      mergeCommitSha: z.string().trim().min(7),
      mergedBranch: z.string().trim().min(1).optional(),
      reviewId: z.string().trim().min(1).optional(),
      notes: z.string().trim().max(500).optional(),
    });
    const parsed = closeoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_admin_closeout_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const jobId = req.params.jobId as string;
    const existing = await loadFederatedJob(p.projectRoot, jobId);
    if (!existing) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }

    const mergeCommitSha = parsed.data.mergeCommitSha;
    const closeoutTerminalStatuses = new Set(["completed", "canceled"]);
    if (
      closeoutTerminalStatuses.has(existing.status) &&
      existing.mergeStatus === "merged" &&
      existing.mergeCommitSha === mergeCommitSha &&
      (!existing.nextAction ||
        existing.nextAction === "merged_no_registered_hosts" ||
        existing.nextAction === "hosts_pull_dev")
    ) {
      const projection = await resolveAndBroadcastProjection(p, existing.taskId);
      res.status(200).json({ ok: true, jobId, alreadyClosedOut: true, job: existing, projection });
      return;
    }

    const closeoutEligibleNextActions = new Set([
      "admin_review_merge",
      "record_merge_ready_review",
    ]);
    const closeoutEligibleManualMergeRecovery =
      existing.status === "blocked" &&
      existing.mergeStatus === "failed" &&
      existing.nextAction === "manual_merge_recovery";
    const closeoutEligibleReviewRecorded =
      existing.status === "blocked" && existing.nextAction === "record_merge_ready_review";
    const closeoutEligibleMergedButStillBlocked =
      existing.status === "blocked" &&
      existing.mergeStatus === "merged" &&
      existing.mergeCommitSha === mergeCommitSha &&
      (existing.nextAction === "merged_no_registered_hosts" ||
        existing.nextAction === "hosts_pull_dev");
    const closeoutEligible =
      (closeoutTerminalStatuses.has(existing.status) &&
        (!existing.nextAction || closeoutEligibleNextActions.has(existing.nextAction))) ||
      closeoutEligibleManualMergeRecovery ||
      closeoutEligibleReviewRecorded ||
      closeoutEligibleMergedButStillBlocked;
    if (!closeoutEligible) {
      res.status(409).json({
        error: "closeout_not_eligible",
        message: `Job ${jobId} state is ${existing.status}/${existing.nextAction ?? "(none)"}; closeout requires status in {completed, canceled} with nextAction in {admin_review_merge, record_merge_ready_review, none}, blocked/record_merge_ready_review after review recording, or blocked/manual_merge_recovery after a failed auto-merge.`,
        jobId,
        status: existing.status,
        nextAction: existing.nextAction,
      });
      return;
    }

    const reviewId = parsed.data.reviewId ?? existing.reviewId;
    if (!reviewId) {
      res.status(409).json({
        error: "review_id_required",
        message: `Job ${jobId} has no reviewId; provide one in the payload (or attach via POST /v1/reviews first).`,
        jobId,
      });
      return;
    }

    const review = await loadReviewBundle(p.projectRoot, reviewId);
    if (!review?.gate?.mergeReady) {
      res.status(409).json({
        error: "review_not_merge_ready",
        message: `Review bundle ${reviewId} is not merge-ready.`,
        jobId,
        reviewId,
        issues: review?.gate?.issues ?? [],
      });
      return;
    }
    const now = new Date().toISOString();
    const targetBranch = parsed.data.mergedBranch ?? existing.targetBranch ?? "dev";

    const closeoutEvidence: Record<string, unknown> = {
      type: "admin_manual_merge_closeout",
      mergeCommitSha,
      mergedBranch: targetBranch,
      reviewId,
      recordedAt: now,
    };
    if (parsed.data.notes) closeoutEvidence.notes = parsed.data.notes;

    let updated: FederatedJobRecord = {
      ...existing,
      status: existing.status === "canceled" ? "canceled" : "completed",
      mergeStatus: "merged",
      mergeCommitSha,
      targetBranch,
      reviewId,
      nextAction: "merged_no_registered_hosts",
      blockReasonCode: undefined,
      error: undefined,
      mergeError: undefined,
      evidence: [...(existing.evidence ?? []), closeoutEvidence],
      lease: undefined,
      completedAt: existing.completedAt ?? now,
      updatedAt: now,
    };

    await saveFederatedJob(p.projectRoot, updated);

    const claimantIndex = await buildFederationClaimantIndex(p);
    const verificationRecord = await recordFederatedVerifiedTask({
      p,
      taskId: updated.taskId,
      commitSha: mergeCommitSha,
      criteriaChecked: 0,
      criteriaPassed: 0,
      reviewId,
      workflowId: updated.verificationWorkflowId ?? `admin-closeout-${jobId}`,
      claimantIndex,
    });
    if (!verificationRecord.converged && verificationRecord.refusal) {
      updated = {
        ...updated,
        blockReasonCode: "pending_manual_handoff",
        error:
          claimantIndex.status === "unavailable"
            ? `duplicate_claimants_unavailable:${claimantIndex.reason}`
            : `duplicate_claimants:${verificationRecord.refusal.taskId}:${verificationRecord.refusal.claimants.join(",")}`,
        nextAction: "resolve_duplicate_claimants",
      };
      await saveFederatedJob(p.projectRoot, updated);
    }

    const taskDetails = await resolveFederatedTaskEventDetails(p, updated.taskId);
    const taskTitle = sessionTitleForFederatedTask(taskDetails);
    const writer = createWorkflowWriter(
      p,
      federatedSessionId(jobId),
      updated.taskId,
      taskTitle ?? updated.taskId,
    );
    const hostDetails = await resolveFederatedHostEventDetails(p, updated.hostId);

    writer.emit("federated_job_status", {
      jobId,
      taskId: updated.taskId,
      taskTitle: taskDetails.taskTitle,
      hostId: updated.hostId,
      ...hostDetails,
      status: "completed",
      workflowState: "merged",
      correlationId: updated.correlationId,
      remoteSessionId: updated.remoteSessionId,
      message:
        parsed.data.notes ??
        `Admin manual merge closeout for ${updated.taskId} (commit ${mergeCommitSha.slice(0, 10)}).`,
      evidenceCount: updated.evidence?.length ?? 0,
    });
    writer.emit("session_complete", {
      outcome: "completed",
      durationMs: 0,
      totalCostUsd: 0,
      hostId: updated.hostId,
      ...hostDetails,
    });

    const unblockedJobs = await releaseFederatedDependencyBlocks(p, updated.taskId, claimantIndex);
    const scheduler =
      unblockedJobs.length > 0
        ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
        : undefined;
    const projection = await resolveAndBroadcastProjection(p, updated.taskId);

    res.status(200).json({
      ok: true,
      jobId,
      alreadyClosedOut: false,
      job: updated,
      unblockedJobs: unblockedJobs.map((job) => job.jobId),
      scheduler,
      projection,
      tokenId,
    });
  });

  app.post("/v1/federation/jobs/:jobId/lease/renew", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z
      .object({
        hostId: z.string().trim().min(1),
        leaseId: z.string().trim().min(1),
        leaseTtlMs: z.number().int().positive().optional(),
      })
      .strict();
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_lease_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    if (!(await requireListenerTokenBinding(p, parsed.data.hostId, tokenId, res))) return;

    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    let renewalFailure: { code: string; message: string } | undefined;
    const renewed = await updateFederatedJob(p.projectRoot, jobId, (current) => {
      const lease = current.lease;
      if (
        current.status === "awaiting_approval" &&
        current.pause &&
        !["attached", "resume_claimed", "approved_but_not_started"].includes(current.pause.state)
      ) {
        renewalFailure = {
          code: "federated_pause_released",
          message: `Pause generation ${current.pause.generation} is ${current.pause.state}; a stale lease renewal cannot reattach it.`,
        };
        return undefined;
      }
      if (
        current.hostId !== parsed.data.hostId ||
        !lease ||
        lease.hostId !== parsed.data.hostId ||
        lease.leaseId !== parsed.data.leaseId
      ) {
        renewalFailure = {
          code: "federated_lease_epoch_mismatch",
          message: `Lease ${parsed.data.leaseId} is not the current assignment for job ${jobId}.`,
        };
        return undefined;
      }
      const leaseExpiresAt = Date.parse(lease.expiresAt);
      if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowMs) {
        renewalFailure = {
          code: "federated_lease_expired",
          message: `Lease ${lease.leaseId} expired before renewal for job ${jobId}.`,
        };
        return undefined;
      }
      if (terminalFederatedStatus(current.status) || !federatedJobHoldsWorkerAttachment(current)) {
        renewalFailure = {
          code: terminalFederatedStatus(current.status)
            ? "federated_job_terminal"
            : "federated_job_not_attached",
          message: `Job ${jobId} is ${current.status}; its lease cannot be renewed.`,
        };
        return undefined;
      }
      const ttlMs = Math.max(1, parsed.data.leaseTtlMs ?? current.leaseTtlMs ?? 30 * 60 * 1000);
      return {
        ...current,
        projectId: current.projectId ?? p.projectId,
        lease: {
          ...lease,
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
        },
        nextAction: current.nextAction ?? `run_${current.jobType}`,
        updatedAt: now,
      };
    });
    if (renewalFailure) {
      res.status(409).json({ error: renewalFailure.code, message: renewalFailure.message, jobId });
      return;
    }
    if (!renewed.record) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }
    const updated = renewed.record;

    const writer = createWorkflowWriter(
      p,
      federatedSessionId(jobId),
      updated.taskId,
      updated.taskId,
    );
    writer.emit("federated_job_status", {
      jobId,
      taskId: updated.taskId,
      hostId: updated.hostId,
      status: updated.status,
      workflowState: workflowStateForFederatedStatus(updated.status),
      correlationId: updated.correlationId,
      message: "Federated job lease renewed.",
    });
    res.json({ ok: true, tokenId, job: updated, lease: updated.lease });
  });

  app.get("/v1/federation/jobs/:jobId", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const jobId = req.params.jobId as string;
    const record = await loadFederatedJob(p.projectRoot, jobId);
    if (!record) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }

    res.json({ ok: true, job: { ...record, projectId: record.projectId ?? p.projectId } });
  });

  app.post("/v1/federation/jobs/:jobId/cancel", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const jobId = req.params.jobId as string;
    const p = await resolveFederatedJobWrite(req, res, jobId);
    if (!p) return;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    let cancelRefusal: "publication_in_progress" | "publication_committed" | undefined;
    let canceledFromStatus: FederatedJobRecord["status"] | undefined;
    let cancellation: Awaited<ReturnType<typeof updateFederatedJob>>;
    try {
      cancellation = await updateFederatedJob(p.projectRoot, jobId, (current) => {
        if (current.mergeStatus === "publishing") {
          cancelRefusal = "publication_in_progress";
          return undefined;
        }
        if (current.mergeStatus === "merged") {
          cancelRefusal = "publication_committed";
          return undefined;
        }
        if (current.status === "canceled") return undefined;
        canceledFromStatus = current.status;
        return {
          ...current,
          projectId: current.projectId ?? p.projectId,
          status: "canceled",
          canceledBy: tokenId,
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (error: unknown) {
      if (!(error instanceof FederatedJobLockBusyError)) throw error;
      res.set("Retry-After", "1");
      res.status(423).json({
        error: error.code,
        message: error.message,
        retryable: error.retryable,
        jobId,
      });
      return;
    }
    if (!cancellation.record) {
      res.status(404).json({
        error: "federated_job_not_found",
        message: `Federated job ${jobId} not found.`,
        jobId,
      });
      return;
    }
    if (cancelRefusal) {
      res.status(409).json({
        error: `federated_${cancelRefusal}`,
        message:
          cancelRefusal === "publication_in_progress"
            ? `Federated job ${jobId} is publishing an admitted commit and cannot be canceled.`
            : `Federated job ${jobId} has already published its admitted commit and cannot be canceled.`,
        jobId,
      });
      return;
    }
    const updated = cancellation.record;
    const taskDetails = await resolveFederatedTaskEventDetails(p, updated.taskId);
    const taskTitle = sessionTitleForFederatedTask(taskDetails);
    const writer = createWorkflowWriter(
      p,
      `federation-${jobId}`,
      updated.taskId,
      taskTitle ?? updated.taskId,
    );
    upsertFederatedSessionIndex(p, {
      sessionId: writer.sessionId,
      taskId: updated.taskId,
      title: taskTitle,
      status: "completed",
      outcome: "canceled",
      totalCostUsd: 0,
      durationMs: 0,
    });
    restoreTaskStatusAfterFederatedCancel(p, updated.taskId);
    writer.recordSession("completed", { outcome: "federated_job_canceled", title: taskTitle });
    writer.emit("federated_job_canceled", {
      jobId,
      taskId: updated.taskId,
      taskTitle: taskDetails.taskTitle,
      correlationId: updated.correlationId,
      canceledBy: tokenId,
    });
    writer.emit("session_complete", {
      outcome: "canceled",
      durationMs: 0,
      totalCostUsd: 0,
    });
    const scheduler = federatedStatusTransitionFreedCapacity(
      canceledFromStatus ?? updated.status,
      updated.status,
    )
      ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
      : undefined;
    const projection = await resolveAndBroadcastProjection(p, updated.taskId);

    res.json({ ok: true, job: updated, scheduler, projection });
  });
}
