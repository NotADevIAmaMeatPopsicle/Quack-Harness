import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  ListenerRegistry,
  ListenerTokenBindingError,
  ListenerRecordReadError,
  LISTENER_HOST_ID_PATTERN,
} from "../../federation/listener-registry.js";
import {
  WORKER_COMMAND_PROTOCOL_VERSION,
  type WorkerCommandResultStatus,
} from "../../core/worker-protocol.js";
import { validationDetails } from "../../intake/task-intake.js";
import {
  acknowledgeFederatedHostCommands,
  applyActiveFederatedLeases,
  appendFederatedHostCommand,
  isActiveFederatedStatus,
  listFederatedJobs,
  maybeRunSwarmSchedulerRefill,
  readFederatedHostCommands,
  sortFederatedQueue,
} from "../federation/index.js";
import type { FederationProjectContext } from "../federation/types.js";
import type { FederationSchedulingDeps } from "../federation/scheduling.js";

const listenerRegistrationSchema = z.object({
  hostId: z.string().trim().regex(LISTENER_HOST_ID_PATTERN),
  alias: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  capabilities: z.array(z.string().trim().min(1)).min(1),
  projectPaths: z.record(z.string(), z.string()).optional(),
  repoRoot: z.string().trim().min(1).optional(),
  repoCommit: z.string().trim().min(1).optional(),
  maxConcurrentJobs: z.number().int().positive().default(1),
  runtimeRole: z.enum(["headnode", "worker"]).optional(),
  protocolVersion: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listenerHeartbeatSchema = z.object({
  healthy: z.boolean(),
  currentLoad: z.number().int().min(0).optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  repoCommit: z.string().trim().min(1).optional(),
  runtimeRole: z.enum(["headnode", "worker"]).optional(),
  protocolVersion: z.string().trim().min(1).optional(),
  lastCommand: z
    .object({
      kind: z.enum([
        "git_pull",
        "refresh_project",
        "worker.refresh",
        "probe_capabilities",
        "collect_diagnostics",
        "sync_wiki",
      ]),
      status: z.enum([
        "accepted",
        "running",
        "completed",
        "failed",
        "retryable",
        "non_retryable",
      ] satisfies readonly WorkerCommandResultStatus[]),
      completedAt: z
        .string()
        .trim()
        .refine((value) => Number.isFinite(Date.parse(value)))
        .optional(),
      durationMs: z.number().int().min(0).optional(),
      errorCategory: z
        .enum([
          "transport",
          "auth",
          "tool_missing",
          "bad_payload",
          "project_not_found",
          "platform_mismatch",
          "execution_failed",
          "not_supported",
          "unknown",
        ])
        .optional(),
      message: z.string().trim().min(1).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listenerInviteSchema = z.object({
  tokenId: z.string().trim().min(1),
  scopes: z
    .array(
      z.enum([
        "listener:register",
        "listener:read",
        "listener:admin",
        "listener:heartbeat",
        "federation:write",
      ]),
    )
    .min(1),
});

const workerRefreshRequestSchema = z.object({
  dryRun: z.boolean().optional(),
  reason: z.string().trim().min(1).default("operator-request"),
  repos: z.array(z.string().trim().min(1)).optional(),
  branches: z.record(z.string(), z.string().trim().min(1)).optional(),
  runInstall: z.boolean().optional(),
  runCapabilityProbes: z.boolean().optional(),
  applyProfile: z.boolean().optional(),
  maxDirtyAction: z.enum(["block", "stash"]).default("block"),
});

export type ListenerRouteProject = FederationProjectContext;

export interface ListenerRouteDeps {
  resolveProject: (req: Request) => ListenerRouteProject;
  requireServiceScope: (req: Request, res: Response, scope: string) => string | undefined;
  requireServiceScopeWhenConfigured: (req: Request, res: Response, scope: string) => boolean;
  createServiceToken: (
    tokenId: string,
    scopes: Array<
      | "listener:register"
      | "listener:read"
      | "listener:admin"
      | "listener:heartbeat"
      | "federation:write"
    >,
  ) => { id: string; token: string; scopes: string[] };
  federationSchedulingDeps: FederationSchedulingDeps;
}

function listenerCanAcceptMoreWork(
  listener:
    | {
        enabled?: boolean;
        healthy?: boolean;
        currentLoad?: number;
        maxConcurrentJobs?: number;
      }
    | undefined,
): boolean {
  if (!listener || listener.enabled === false || listener.healthy !== true) return false;
  return (listener.currentLoad ?? 0) < (listener.maxConcurrentJobs ?? 1);
}

function listenerRegainedCapacity(
  previous:
    | {
        enabled?: boolean;
        healthy?: boolean;
        currentLoad?: number;
        maxConcurrentJobs?: number;
      }
    | undefined,
  current:
    | {
        enabled?: boolean;
        healthy?: boolean;
        currentLoad?: number;
        maxConcurrentJobs?: number;
      }
    | undefined,
): boolean {
  return !listenerCanAcceptMoreWork(previous) && listenerCanAcceptMoreWork(current);
}

export function registerListenerRoutes(app: Express, deps: ListenerRouteDeps): void {
  const {
    resolveProject,
    requireServiceScope,
    requireServiceScopeWhenConfigured,
    createServiceToken,
    federationSchedulingDeps,
  } = deps;

  app.get("/v1/listeners", async (req: Request, res: Response) => {
    if (!requireServiceScopeWhenConfigured(req, res, "listener:read")) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const registry = new ListenerRegistry(p.projectRoot);
    const snapshot = await registry.listWithDiagnostics();
    const listeners = await applyActiveFederatedLeases(p.projectRoot, snapshot.records);
    res.json({
      ok: true,
      listeners,
      registryHealth: {
        healthy: snapshot.issues.length === 0,
        unavailable: snapshot.unavailable,
        issues: snapshot.issues,
      },
    });
  });

  app.post("/v1/listeners/register", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:register");
    if (!tokenId) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = listenerRegistrationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_listener_registration_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const registry = new ListenerRegistry(p.projectRoot);
    let listener;
    try {
      listener = await registry.register(parsed.data, tokenId);
    } catch (error: unknown) {
      if (error instanceof ListenerTokenBindingError) {
        res.status(409).json({ error: error.code, message: error.message, hostId: error.hostId });
        return;
      }
      res.status(503).json({
        error: "listener_registry_unavailable",
        message:
          "Listener registry operation could not finish; inspect the current record before retrying.",
        ...(error instanceof ListenerRecordReadError ? { issue: error.issue } : {}),
      });
      return;
    }
    const scheduler = await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps);
    res.status(201).json({ ok: true, accepted: true, listener, scheduler });
  });

  app.post("/v1/listeners/invites", (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:admin");
    if (!tokenId) return;

    const parsed = listenerInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_listener_invite_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      const invite = createServiceToken(parsed.data.tokenId, parsed.data.scopes);
      res.status(201).json({
        ok: true,
        createdBy: tokenId,
        tokenId: invite.id,
        token: invite.token,
        scopes: invite.scopes,
        warning: "Store this token now; Quack only returns it at creation time.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({
        error: "listener_invite_failed",
        message: msg,
      });
    }
  });

  app.post("/v1/listeners/:hostId/heartbeat", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:heartbeat");
    if (!tokenId) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = listenerHeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_listener_heartbeat_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const hostId = req.params.hostId as string;
    const registry = new ListenerRegistry(p.projectRoot);
    let previous;
    let listener;
    try {
      previous = await registry.get(hostId);
      listener = await registry.heartbeat(hostId, parsed.data, tokenId);
    } catch (error: unknown) {
      if (error instanceof ListenerTokenBindingError) {
        res.status(403).json({ error: error.code, message: error.message, hostId: error.hostId });
        return;
      }
      res.status(503).json({
        error: "listener_registry_unavailable",
        message:
          "Listener registry operation could not finish; inspect the current record before retrying.",
        ...(error instanceof ListenerRecordReadError ? { issue: error.issue } : {}),
      });
      return;
    }
    if (!listener) {
      res.status(404).json({
        error: "listener_not_found",
        message: `Listener ${hostId} is not registered.`,
        hostId,
      });
      return;
    }

    const scheduler = listenerRegainedCapacity(previous, listener)
      ? await maybeRunSwarmSchedulerRefill(p, {}, federationSchedulingDeps)
      : undefined;

    res.json({ ok: true, accepted: true, tokenId, listener, scheduler });
  });

  app.get("/v1/listeners/:hostId/commands", async (req: Request, res: Response) => {
    if (!requireServiceScopeWhenConfigured(req, res, "listener:read")) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const hostId = req.params.hostId as string;
    const includeAcknowledged = req.query.includeAcknowledged === "true";
    const commands = await readFederatedHostCommands(p.projectRoot, hostId, includeAcknowledged);
    res.json({ ok: true, hostId, commands });
  });

  app.post("/v1/listeners/:hostId/commands", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:admin");
    if (!tokenId) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const commandSchema = z.discriminatedUnion("kind", [
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("git_pull"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          remote: z.string().trim().min(1).optional(),
          targetBranch: z.string().trim().min(1),
          ffOnly: z.boolean().optional(),
          repoPathKey: z.string().trim().min(1).optional(),
        }),
      }),
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("refresh_project"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          repoPathKey: z.string().trim().min(1).optional(),
          exec: z
            .array(
              z.object({
                cmd: z.string().trim().min(1),
                args: z.array(z.string()).default([]),
                cwd: z.string().trim().min(1).optional(),
                env: z.record(z.string(), z.string()).optional(),
              }),
            )
            .optional(),
        }),
      }),
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("worker.refresh"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          reason: z.string().trim().min(1),
          repos: z.array(z.string().trim().min(1)).optional(),
          branches: z.record(z.string(), z.string().trim().min(1)).optional(),
          runInstall: z.boolean().optional(),
          runCapabilityProbes: z.boolean().optional(),
          applyProfile: z.boolean().optional(),
          maxDirtyAction: z.enum(["block", "stash"]).optional(),
        }),
      }),
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("probe_capabilities"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          refreshListenerHeartbeat: z.boolean().optional(),
        }),
      }),
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("collect_diagnostics"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          includeJobs: z.boolean().optional(),
          includeHealth: z.boolean().optional(),
        }),
      }),
      z.object({
        commandId: z.string().trim().min(1).optional(),
        kind: z.literal("sync_wiki"),
        taskId: z.string().trim().min(1).optional(),
        targetProjectId: z.string().trim().min(1).optional(),
        notes: z.string().trim().min(1).optional(),
        payload: z.object({
          mode: z.enum(["status", "pull"]),
        }),
      }),
    ]);
    const parsed = commandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_listener_command_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const hostId = req.params.hostId as string;
    const command = {
      commandId:
        parsed.data.commandId ??
        `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
      issuedAt: new Date().toISOString(),
      issuedBy: tokenId,
      ...parsed.data,
    };
    await appendFederatedHostCommand(p.projectRoot, hostId, command);
    res.status(201).json({ ok: true, hostId, command });
  });

  app.post("/api/workers/:hostId/refresh", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:admin");
    if (!tokenId) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = workerRefreshRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_worker_refresh_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const hostId = req.params.hostId as string;
    const command = {
      commandId: `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
      kind: "worker.refresh" as const,
      issuedAt: new Date().toISOString(),
      issuedBy: tokenId,
      targetProjectId: p.projectId,
      notes: `Refresh worker ${hostId}: ${parsed.data.reason}`,
      payload: {
        reason: parsed.data.reason,
        repos: parsed.data.repos,
        branches: parsed.data.branches,
        runInstall: parsed.data.runInstall ?? false,
        runCapabilityProbes: parsed.data.runCapabilityProbes ?? true,
        applyProfile: parsed.data.applyProfile ?? true,
        maxDirtyAction: parsed.data.maxDirtyAction,
      },
    };

    if (!parsed.data.dryRun) {
      await appendFederatedHostCommand(p.projectRoot, hostId, command);
    }
    res.status(parsed.data.dryRun ? 200 : 202).json({
      ok: true,
      hostId,
      dryRun: parsed.data.dryRun ?? false,
      command,
      ackPath: `/v1/listeners/${encodeURIComponent(hostId)}/commands/ack`,
    });
  });

  app.post("/v1/listeners/:hostId/commands/ack", async (req: Request, res: Response) => {
    const tokenId = requireServiceScope(req, res, "listener:heartbeat");
    if (!tokenId) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const schema = z
      .object({
        commandId: z.string().trim().min(1).optional(),
        commandIds: z.array(z.string().trim().min(1)).optional(),
        results: z
          .array(
            z.object({
              commandId: z.string().trim().min(1),
              protocolVersion: z.literal(WORKER_COMMAND_PROTOCOL_VERSION),
              kind: z.enum([
                "git_pull",
                "refresh_project",
                "worker.refresh",
                "probe_capabilities",
                "collect_diagnostics",
                "sync_wiki",
              ]),
              status: z.enum([
                "accepted",
                "running",
                "completed",
                "failed",
                "retryable",
                "non_retryable",
              ]),
              acknowledgedAt: z.string().trim().min(1),
              startedAt: z.string().trim().min(1).optional(),
              completedAt: z.string().trim().min(1).optional(),
              durationMs: z.number().int().min(0).optional(),
              exitCode: z.number().int().optional(),
              message: z.string().optional(),
              errorCategory: z
                .enum([
                  "transport",
                  "auth",
                  "tool_missing",
                  "bad_payload",
                  "project_not_found",
                  "platform_mismatch",
                  "execution_failed",
                  "not_supported",
                  "unknown",
                ])
                .optional(),
              stdoutSnippet: z.string().optional(),
              stderrSnippet: z.string().optional(),
              metadata: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .optional(),
      })
      .refine((value) => value.commandId || (value.commandIds && value.commandIds.length > 0), {
        message: "commandId or commandIds is required.",
      });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_listener_command_ack_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const hostId = req.params.hostId as string;
    try {
      await new ListenerRegistry(p.projectRoot).assertTokenBinding(hostId, tokenId);
    } catch (error: unknown) {
      if (error instanceof ListenerTokenBindingError) {
        res.status(403).json({ error: error.code, message: error.message, hostId });
        return;
      }
      res.status(503).json({
        error: "listener_registry_unavailable",
        message: "Listener identity cannot be verified from its current registry record.",
        ...(error instanceof ListenerRecordReadError ? { issue: error.issue } : {}),
      });
      return;
    }
    const commandIds = [
      ...(parsed.data.commandIds ?? []),
      ...(parsed.data.commandId ? [parsed.data.commandId] : []),
    ];
    const resultsByCommandId = Object.fromEntries(
      (parsed.data.results ?? []).map((result) => [result.commandId, result] as const),
    );
    const acknowledged = await acknowledgeFederatedHostCommands(
      p.projectRoot,
      hostId,
      commandIds,
      tokenId,
      resultsByCommandId,
    );
    res.json({ ok: true, hostId, acknowledged });
  });

  app.get("/v1/listeners/:hostId/jobs", async (req: Request, res: Response) => {
    if (!requireServiceScopeWhenConfigured(req, res, "listener:read")) return;
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const hostId = req.params.hostId as string;
    const statusFilter =
      typeof req.query.status === "string"
        ? new Set(
            req.query.status
              .split(",")
              .map((status) => status.trim())
              .filter(Boolean),
          )
        : undefined;
    const jobs = sortFederatedQueue(
      (await listFederatedJobs(p.projectRoot))
        .filter((job) => job.hostId === hostId)
        // TASK-1330: released pauses re-enter this feed only with a durable pause
        // generation. New listeners treat them as resume handshakes, never fresh
        // starts; old listeners still ignore them because they select only assigned.
        .filter((job) =>
          statusFilter
            ? statusFilter.has(job.status)
            : isActiveFederatedStatus(job.status) ||
              (job.status === "awaiting_approval" &&
                Boolean(job.pause) &&
                [
                  "released",
                  "resume_requested",
                  "resume_claimed",
                  "approved_but_not_started",
                ].includes(job.pause?.state ?? "")),
        )
        .map((job) => ({ ...job, projectId: job.projectId ?? p.projectId })),
    );
    res.json({ ok: true, hostId, jobs });
  });
}
