import type { Express, Request, Response } from "express";
import { execFileSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { z } from "zod";

import type { EventPayload } from "../event-types.js";
import type { EventWriter } from "../event-emitter.js";
import { recordVerification } from "../verification-store.js";
import { normalizeCapabilities } from "../../federation/host-registry.js";
import { routeFederatedJob } from "../../federation/job-router.js";
import { validationDetails } from "../../intake/task-intake.js";
import type { BlockReasonCode } from "../../workflow/workflow-state-types.js";
import {
  applyActiveFederatedLeases,
  buildFederationClaimantIndex,
  createFederatedLease,
  defaultFederatedHosts,
  emitFederatedSessionStart,
  federatedHostEventDetailsFromHost,
  federatedJobId,
  federatedSessionId,
  holdsWorkerAttachment,
  isRelayedSlackStage,
  listFederatedJobs,
  loadReviewBundle,
  loadFederatedJob,
  maybeRunSwarmSchedulerRefill,
  normalizeFederatedRuntimeStatus,
  queueFederatedJobRecord,
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
  sessionStatusForFederatedStatus,
  sessionTitleForFederatedTask,
  sortFederatedQueue,
  terminalFederatedStatus,
  upsertFederatedSessionIndex,
  workflowStateForFederatedStatus,
  reconcileFederatedJob,
  orchestrateFederatedCompletion,
  assertSafeGitRef,
  type FederatedJobRecord,
  type FederatedRelayEvent,
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

export interface FederationRouteDeps {
  resolveProject: (req: Request) => FederationRouteProject;
  /** TASK-1301: write-route project resolution — refuses to default to the
   *  active project on multi-project registries (PROJECT_SCOPE_REQUIRED). */
  resolveProjectForWrite: (
    req: Request,
  ) =>
    | { ok: true; project: FederationRouteProject }
    | { ok: false; status: number; body: Record<string, unknown> };
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
  /** Allow a local/open dashboard or an authenticated dashboard principal to read queue data. */
  allowDashboardRead?: (req: Request) => boolean;
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
    federatedStatusTransitionFreedCapacity(previous.status, current.status) ||
    (previous.status !== "completed" && current.status === "completed") ||
    (previous.nextAction !== "run_fix_job" && current.nextAction === "run_fix_job")
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

export function registerFederationRoutes(app: Express, deps: FederationRouteDeps): void {
  const {
    resolveProject,
    resolveProjectForWrite,
    createWorkflowWriter,
    resolveAndBroadcastProjection,
    requireServiceScope,
    requireServiceScopeAny,
    allowDashboardRead,
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

  const verificationEntrySchema = z.object({
    taskId: z.string().trim().min(1),
    verdict: z.enum(["VERIFIED", "FAILED", "REJECTED", "SOFT-VERIFIED", "CANNOT_VERIFY"]),
    commitSha: z.string().trim().min(1),
    method: z.string().trim().min(1),
    criteriaChecked: z.number().int().min(0),
    criteriaPassed: z.number().int().min(0),
    notes: z.string().optional().nullable(),
    verifiedAt: z.string().trim().min(1).optional(),
    updatedAt: z.string().trim().min(1).optional(),
    reviewId: z.string().trim().min(1).optional(),
    workflowId: z.string().trim().min(1).optional(),
  });

  const requireFederationRead = (req: Request, res: Response): string | undefined => {
    if (allowDashboardRead?.(req)) {
      return "dashboard";
    }
    if (requireServiceScopeAny) {
      return requireServiceScopeAny(req, res, ["federation:read", "federation:write"]);
    }
    return requireServiceScope(req, res, "federation:write");
  };

  app.get("/v1/federation/queue", async (req: Request, res: Response) => {
    const tokenId = requireFederationRead(req, res);
    if (!tokenId) return;

    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const jobs = await listFederatedJobs(p.projectRoot);
    const hosts = await defaultFederatedHosts(p.projectRoot);
    const activeDispatchJobs = jobs
      // TASK-1329: per-host dispatch load, so it counts attachment (a paused run
      // still occupies its host) rather than assignability.
      .filter((job) => job.jobType === "dispatch" && holdsWorkerAttachment(job.status));
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

    const appliedTaskIds: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    const refused: Array<{ taskId: string; claimants: string[]; reason: string }> = [];
    const claimantIndex = await buildFederationClaimantIndex(p);
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

    const p = resolveProject(req);
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
    const record = queueFederatedJobRecord({
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
    await saveFederatedJob(p.projectRoot, record);
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
      queued: record,
      job: current,
      scheduler,
      projection,
    });
  });

  app.post("/v1/federation/scheduler/tick", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;
    const p = resolveProject(req);
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
    const result = await runSwarmSchedulerTick(p, parsed.data, federationSchedulingDeps);
    res.json({ ok: true, tokenId, ...result });
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

    const p = resolveProject(req);
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

    const p = resolveProject(req);
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
  });

  app.post("/v1/federation/jobs/:jobId/events", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const p = resolveProject(req);
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
        message: z.string().trim().min(1).optional(),
        sequence: z.number().int().nonnegative().optional(),
        blockReasonCode: z.string().trim().min(1).optional(),
        /** TASK-1329: which gate a paused run is waiting at, so `nextAction` can
         *  name the decision instead of sending an operator to investigate a
         *  crash that never happened. */
        pendingGate: z
          .object({
            stage: z.enum(["blueprint", "judge"]),
            since: z.string().trim().min(1).optional(),
            reason: z.string().trim().min(1).optional(),
          })
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
      );

    const parsed = relayPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_job_event_payload",
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

    const body = parsed.data;
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

    const now = new Date().toISOString();
    const normalizedStatus = body.status
      ? normalizeFederatedRuntimeStatus(body.status)
      : existing.status;
    const hostId = body.hostId ?? existing.hostId;
    const newlyQueued = Boolean(
      body.status && normalizedStatus === "queued" && existing.status !== "queued",
    );
    const newlyAttached = Boolean(
      body.status &&
      hostId &&
      holdsWorkerAttachment(normalizedStatus) &&
      (!holdsWorkerAttachment(existing.status) || !existing.lease),
    );
    if (
      (newlyQueued || newlyAttached) &&
      (await refuseFederationAdmission(p, existing.taskId, res))
    ) {
      return;
    }
    const remoteSessionId =
      body.workerCompletion?.canonicalSessionId ??
      body.remoteSessionId ??
      body.events.find((event) => event.sessionId)?.sessionId ??
      existing.remoteSessionId;
    const lastEvent = body.events.at(-1);
    const eventCount =
      (existing.eventCount ?? 0) +
      body.events.length +
      (body.status ? 1 : 0) +
      body.evidence.length;
    const statusUpdateReceived = Boolean(body.status);
    // TASK-1329 R1-6: this MUST key off worker attachment, not the scheduler's
    // active set. A run paused at a human gate still has its listener bound to
    // it, so dropping the lease here would strand the job outside stale-lease
    // recovery and it could never be reclaimed if that host later died.
    const lease = !statusUpdateReceived
      ? existing.lease
      : hostId && holdsWorkerAttachment(normalizedStatus)
        ? {
            leaseId: existing.lease?.leaseId ?? `${jobId}:${hostId}`,
            hostId,
            acquiredAt: existing.lease?.acquiredAt ?? now,
            expiresAt: new Date(Date.parse(now) + 30 * 60 * 1000).toISOString(),
          }
        : undefined;
    // TASK-1329 / QPI-041: a pause is neither a failure nor a completion, so it
    // gets its own action naming the DECISION and the gate. Before this, a
    // paused run reached the operator as `investigate_failed_worker`, sending
    // them to look for a crash that never happened.
    const pendingGate =
      normalizedStatus === "awaiting_approval"
        ? (body.pendingGate ?? existing.pendingGate)
        : undefined;
    const nextAction = !statusUpdateReceived
      ? existing.nextAction
      : normalizedStatus === "awaiting_approval"
        ? `decide_${pendingGate?.stage ?? "human"}_gate:${existing.taskId}`
        : normalizedStatus === "failed"
          ? "investigate_failed_worker"
          : normalizedStatus === "rejected" || normalizedStatus === "blocked"
            ? "manual_handoff"
            : normalizedStatus === "canceled"
              ? "canceled"
              : (existing.nextAction ?? `run_${existing.jobType}`);
    const blockReasonCode =
      normalizedStatus === "blocked"
        ? ((body.blockReasonCode as BlockReasonCode | undefined) ?? existing.blockReasonCode)
        : undefined;
    // A pause is deliberately absent here: populating `error` for a paused run
    // is how "waiting on you" reads as "something went wrong" downstream.
    const error =
      normalizedStatus === "failed" ||
      normalizedStatus === "rejected" ||
      normalizedStatus === "blocked"
        ? (body.message ?? existing.error)
        : existing.error;
    const updated: FederatedJobRecord = {
      ...existing,
      status: normalizedStatus,
      hostId,
      remoteSessionId,
      branchName: body.branchName ?? existing.branchName,
      commitSha: body.workerCompletion?.mergeCommitSha ?? body.commitSha ?? existing.commitSha,
      targetBranch:
        body.workerCompletion?.mergeTargetBranch ?? body.targetBranch ?? existing.targetBranch,
      reviewId: body.reviewId ?? body.verification?.reviewId ?? existing.reviewId,
      autoMerge: body.autoMerge || existing.autoMerge,
      blockReasonCode,
      // TASK-1329: cleared on any non-paused status so a stale gate never
      // outlives the pause that produced it.
      pendingGate,
      error,
      nextAction,
      lastEventAt: now,
      lastEventStage: lastEvent?.stage ?? existing.lastEventStage,
      eventCount,
      evidence:
        body.evidence.length > 0
          ? [...(existing.evidence ?? []), ...body.evidence]
          : existing.evidence,
      completedAt:
        statusUpdateReceived && terminalFederatedStatus(normalizedStatus)
          ? (existing.completedAt ?? now)
          : existing.completedAt,
      lease,
      updatedAt: now,
    };

    await saveFederatedJob(p.projectRoot, updated);

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
    if (!verificationRecord.applied && verificationRecord.refusal) {
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

    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z.object({
      hostId: z.string().trim().min(1),
      leaseTtlMs: z.number().int().positive().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_federated_lease_payload",
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

    if (existing.hostId && existing.hostId !== parsed.data.hostId) {
      res.status(409).json({
        error: "federated_job_host_mismatch",
        message: `Job ${jobId} is assigned to ${existing.hostId}; ${parsed.data.hostId} cannot renew it.`,
        jobId,
        expectedHostId: existing.hostId,
        actualHostId: parsed.data.hostId,
      });
      return;
    }

    if (terminalFederatedStatus(existing.status)) {
      res.status(409).json({
        error: "federated_job_terminal",
        message: `Job ${jobId} is ${existing.status}; its lease cannot be renewed.`,
        jobId,
        status: existing.status,
      });
      return;
    }

    if (
      existing.status === "queued" &&
      (await refuseFederationAdmission(p, existing.taskId, res))
    ) {
      return;
    }

    const now = new Date().toISOString();
    const updated: FederatedJobRecord = {
      ...existing,
      status: existing.status === "queued" ? "assigned" : existing.status,
      hostId: parsed.data.hostId,
      lease: createFederatedLease(
        existing.jobId,
        parsed.data.hostId,
        now,
        parsed.data.leaseTtlMs ?? existing.leaseTtlMs,
      ),
      nextAction: existing.nextAction ?? `run_${existing.jobType}`,
      updatedAt: now,
    };
    await saveFederatedJob(p.projectRoot, updated);

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
    const tokenId = requireFederationRead(req, res);
    if (!tokenId) return;

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

    res.json({ ok: true, job: record });
  });

  app.post("/v1/federation/jobs/:jobId/cancel", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "federation:write");
    if (!tokenId) return;

    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
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

    const updated: FederatedJobRecord = {
      ...existing,
      status: "canceled",
      canceledBy: tokenId,
      updatedAt: new Date().toISOString(),
    };
    await saveFederatedJob(p.projectRoot, updated);
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
    const scheduler = federatedStatusTransitionFreedCapacity(existing.status, updated.status)
      ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
      : undefined;
    const projection = await resolveAndBroadcastProjection(p, updated.taskId);

    res.json({ ok: true, job: updated, scheduler, projection });
  });
}
