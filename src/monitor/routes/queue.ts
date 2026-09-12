// ─── Queue Routes ───────────────────────────────────────────────────
// REST API routes for the dispatch queue: enqueue, lifecycle (start/pause/
// resume/stop/abort), per-task actions (cancel/retry/remove), config patch,
// and stats. Each handler resolves the project's DispatchQueue and delegates
// to it. No business logic lives here.

import type { Express, Request, Response } from "express";
import type {
  DispatchQueue,
  DispatchQueueConfig,
  QueueItem,
  QueueStats,
} from "../../queue/index.js";
import type { JobProvenance } from "../federation/types.js";
import type { AuthenticatedRequest } from "./auth.js";
import { formatDuplicateClaimantsMessage } from "../../core/duplicate-claimants.js";

// TASK-1323: queue-mediated dispatches are deferred api-direct entries —
// the queue is a scheduling mechanism, not an entry channel. Derived
// here from the route, never from the client (a client-sent
// options.provenance is overridden below). Principal is the session
// username when the auth middleware attached one (round-2 F2).
function enqueueProvenance(req: Request): JobProvenance {
  const claimedRaw = req.headers["x-quack-channel"];
  const claimed = Array.isArray(claimedRaw) ? claimedRaw[0] : claimedRaw;
  const sessionUser = (req as AuthenticatedRequest).session?.username;
  return {
    channel: "api-direct",
    principal: sessionUser ? `user:${sessionUser}` : "unauthenticated-local",
    ...(req.ip ? { remoteAddr: req.ip } : {}),
    ...(claimed && claimed.trim().length > 0 ? { claimedChannel: claimed.trim() } : {}),
  };
}

export interface QueueRouteProject {
  dispatchQueue?: DispatchQueue | null;
}

export interface QueueRouteDeps {
  resolveProject: (req: Request) => QueueRouteProject;
}

const PRIORITY_LABEL_BY_WEIGHT: Record<number, string> = {
  0: "P0-CRITICAL",
  1: "P1-HIGH",
  2: "P2-MEDIUM",
  3: "P3-LOW",
};

function toPriorityLabel(priority: number | undefined): string | undefined {
  if (typeof priority !== "number") {
    return undefined;
  }
  return PRIORITY_LABEL_BY_WEIGHT[priority] ?? `P${priority}`;
}

function summarizeQueueItem(item: QueueItem): Record<string, unknown> {
  const priority = toPriorityLabel(item.priority);
  const lastError = item.error ?? item.blockedReason;
  return {
    taskId: item.taskId,
    status: item.status,
    priority,
    priorityWeight: item.priority,
    enqueuedAt: item.enqueuedAt,
    startedAt: item.startedAt,
    awaitingApprovalAt: item.awaitingApprovalAt,
    completedAt: item.completedAt,
    blockedBy: item.blockedBy,
    blockedReason: item.blockedReason,
    enrichmentPending: item.enrichmentPending,
    duplicateBlockedBy: item.duplicateBlockedBy,
    error: item.error,
    lastError,
    outcome: item.outcome,
    costUsd: item.costUsd,
    durationMs: item.durationMs,
    retryCount: item.retryCount,
  };
}

function hasPendingWork(stats: QueueStats): boolean {
  return (
    stats.recoveredPendingScan > 0 ||
    stats.queued > 0 ||
    stats.ready > 0 ||
    stats.running > 0 ||
    stats.awaitingApproval > 0
  );
}

function deriveQueueState(
  queue: DispatchQueue,
  stats: QueueStats,
): "idle" | "waiting" | "running" | "paused" | "stopped" | "done" {
  if (queue.isPaused()) {
    return "paused";
  }
  if (stats.awaitingApproval > 0 && stats.running === 0) {
    return "waiting";
  }
  if (queue.isRunning()) {
    return stats.running > 0 ? "running" : "waiting";
  }
  if (stats.total === 0) {
    return "idle";
  }
  return hasPendingWork(stats) ? "stopped" : "done";
}

export function registerQueueRoutes(app: Express, deps: QueueRouteDeps): void {
  const { resolveProject } = deps;

  app.post("/api/queue/enqueue", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const taskIds = Array.isArray(body?.taskIds) ? (body.taskIds as string[]) : [];
    const options = body?.options as Record<string, unknown> | undefined;
    const parentTaskId = typeof body?.parentTaskId === "string" ? body.parentTaskId : undefined;
    const sharedBranchName =
      typeof body?.sharedBranchName === "string" ? body.sharedBranchName : undefined;

    if (taskIds.length === 0) {
      res.status(400).json({ error: "Missing required field: taskIds" });
      return;
    }

    // Merge parentTaskId/sharedBranchName into options when present (from decompose --enqueue)
    const mergedOptions =
      parentTaskId || sharedBranchName ? { ...options, parentTaskId, sharedBranchName } : options;

    try {
      const claimantChecks = await p.dispatchQueue.scanEnqueueClaimants(taskIds);
      const items = p.dispatchQueue.enqueueMultiple(
        taskIds,
        {
          ...mergedOptions,
          provenance: enqueueProvenance(req),
        },
        claimantChecks,
      );
      if (items.refusals.length > 0) {
        if (taskIds.length === 1 && items.refusals.length === 1) {
          const refusal = items.refusals[0];
          res.status(409).json({ ok: false, ...refusal });
          return;
        }
        res.status(409).json({
          ok: false,
          error: "duplicate_claimants",
          items,
          refusals: items.refusals,
        });
        return;
      }
      res.json({ ok: true, items });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/queue/enqueue-all", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    try {
      const items = await p.dispatchQueue.enqueueAllEligible({
        provenance: enqueueProvenance(req),
      });
      if (items.refusals.length > 0) {
        res.status(409).json({
          ok: false,
          error: "duplicate_claimants",
          items,
          refusals: items.refusals,
        });
        return;
      }
      res.json({ ok: true, items, count: items.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/queue/start", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    await p.dispatchQueue.start();
    res.json({ ok: true, message: "Queue started" });
  });

  app.post("/api/queue/pause", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const reason = typeof body?.reason === "string" ? body.reason : undefined;

    p.dispatchQueue.pause(reason);
    res.json({ ok: true, message: "Queue paused" });
  });

  app.post("/api/queue/resume", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    await p.dispatchQueue.resume();
    res.json({ ok: true, message: "Queue resumed" });
  });

  app.post("/api/queue/stop", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    p.dispatchQueue.stop();
    res.json({ ok: true, message: "Queue stopped" });
  });

  app.post("/api/queue/abort", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const stopped = p.dispatchQueue.abort();
    if (!stopped) {
      res.status(409).json({
        ok: false,
        code: "QUEUE_ABORT_STOP_REFUSED",
        error:
          "Queue stopped scheduling, but one or more active tasks could not be durably stopped",
      });
      return;
    }
    res.json({ ok: true, message: "Queue aborted" });
  });

  app.get("/api/queue", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const stats = p.dispatchQueue.getStats();
    const qConfig = p.dispatchQueue.getConfig();
    const items = p.dispatchQueue.getItems();
    const activeTaskIds = items
      .filter((item) => item.status === "running" || item.status === "awaiting_approval")
      .map((item) => item.taskId);

    res.json({
      state: deriveQueueState(p.dispatchQueue, stats),
      running: p.dispatchQueue.isRunning(),
      paused: p.dispatchQueue.isPaused(),
      pauseReason: p.dispatchQueue.getPauseReason(),
      items: items.map((item) => summarizeQueueItem(item)),
      activeTaskIds,
      activeTaskId: activeTaskIds[0],
      maxConcurrent: qConfig.maxConcurrent,
      config: qConfig,
      stats,
      recoveryScanUnavailableReason: stats.recoveryScanUnavailableReason,
    });
  });

  app.get("/api/queue/stats", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    res.json(p.dispatchQueue.getStats());
  });

  app.post("/api/queue/tasks/:id/cancel", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const taskId = req.params.id as string;
    const existing = p.dispatchQueue.getItem(taskId);
    const success = p.dispatchQueue.cancel(taskId);

    if (success) {
      res.json({ ok: true, message: `Task ${taskId} cancelled` });
    } else if (existing) {
      res.status(409).json({
        ok: false,
        code: "QUEUE_TASK_STOP_REFUSED",
        error: `Task ${taskId} could not be durably stopped and remains active`,
      });
    } else {
      res.status(404).json({ error: `Task ${taskId} not found in queue` });
    }
  });

  app.post("/api/queue/tasks/:id/retry", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const taskId = req.params.id as string;
    const item = p.dispatchQueue.getItem(taskId);
    if (!item || item.status !== "failed") {
      res.status(404).json({ error: `Task ${taskId} not found or not failed` });
      return;
    }
    const claimantChecks = await p.dispatchQueue.scanDuplicateClaimants([taskId]);
    const claimantCheck = claimantChecks.get(taskId);
    if (claimantCheck && claimantCheck.claimants.length > 1) {
      res.status(409).json({
        ok: false,
        error: "duplicate_claimants",
        taskId,
        claimants: claimantCheck.claimants,
        message: formatDuplicateClaimantsMessage(taskId, claimantCheck.claimants),
      });
      return;
    }
    const success = p.dispatchQueue.retry(taskId, claimantCheck);

    if (success) {
      res.json({ ok: true, message: `Task ${taskId} re-queued` });
    } else {
      res.status(404).json({ error: `Task ${taskId} not found or not failed` });
    }
  });

  app.delete("/api/queue/tasks/:id", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const taskId = req.params.id as string;
    const success = p.dispatchQueue.remove(taskId);

    if (success) {
      res.json({ ok: true, message: `Task ${taskId} removed from queue` });
    } else {
      res.status(404).json({ error: `Task ${taskId} not found or is running` });
    }
  });

  app.patch("/api/queue/config", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchQueue) {
      res.status(500).json({ error: "Queue not available" });
      return;
    }

    const qConfig = req.body as Partial<DispatchQueueConfig>;
    p.dispatchQueue.updateConfig(qConfig);

    res.json({
      ok: true,
      config: p.dispatchQueue.getConfig(),
      stats: p.dispatchQueue.getStats(),
    });
  });
}
