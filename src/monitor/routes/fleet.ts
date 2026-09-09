// ─── Fleet Routes ───────────────────────────────────────────────────
// REST API routes for the fleet plane: budget, key health, model routing,
// emergency control (stop/pause/resume), container inventory, cost velocity,
// agent health, and per-task health. /api/tasks/:id/health is included here
// because it sits in the same control-plane code path (progressDetector) and
// shares the closure dep shape — moving it isolates the entire block.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Express, Request, Response } from "express";

import type { DispatchManager } from "../dispatch-manager.js";
import type { DispatchQueue } from "../../queue/index.js";
import type { FleetController } from "../../dispatcher/fleet-controller.js";
import type { CostVelocityTracker } from "../../dispatcher/cost-velocity.js";
import type { KeyManager } from "../../dispatcher/key-manager.js";
import type { FleetBudgetChecker } from "../../dispatcher/fleet-budget.js";
import type { ProgressDetector } from "../progress-detector.js";
import { ModelRoutingConfigSchema } from "../../core/adapter-schema.js";

export interface FleetRouteProject {
  projectRoot?: string;
  dispatchManager?: DispatchManager | null;
  dispatchQueue?: DispatchQueue | null;
  fleetController?: FleetController | null;
  keyManager?: KeyManager | null;
  costVelocityTracker: CostVelocityTracker;
  progressDetector: ProgressDetector;
}

export type FleetEventStage = "fleet_emergency_stop" | "fleet_paused" | "fleet_resumed";

export interface FleetRouteDeps {
  resolveProject: (req: Request) => FleetRouteProject;
  fleetBudget: FleetBudgetChecker;
  emitFleetEvent: (stage: FleetEventStage, payload: unknown) => void;
}

export function registerFleetRoutes(app: Express, deps: FleetRouteDeps): void {
  const { resolveProject, fleetBudget, emitFleetEvent } = deps;

  // ─── Fleet budget endpoints ────────────────────────────────────

  app.get("/api/fleet/budget", (_req: Request, res: Response) => {
    const status = fleetBudget.getStatus();
    res.json(status);
  });

  app.get("/api/fleet/keys", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.keyManager) {
      res.json({ keys: [], count: 0 });
      return;
    }
    // getKeyHealth() already returns sanitized data (no env var names or key values)
    const keys = p.keyManager.getKeyHealth();
    res.json({ keys, count: keys.length });
  });

  app.get("/api/fleet/routing", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    try {
      const { loadAdapter } = await import("../../core/adapter-loader.js");
      const { resolveModel, MODEL_TIERS } = await import("../../dispatcher/model-router.js");
      const adapter = await loadAdapter(p.projectRoot);
      const routing = adapter.config.modelRouting;
      const agentConfig = adapter.config.agent;

      // Resolve actual models for each stage
      const stages = ["gate", "enrich", "plan", "worker", "judge"] as const;
      const resolved: Record<string, string> = {};
      for (const stage of stages) {
        resolved[stage] = resolveModel(routing, agentConfig, { stage });
      }
      resolved.workerComplex = resolveModel(routing, agentConfig, {
        stage: "worker",
        taskTags: ["architecture"],
      });

      res.json({
        config: routing || null,
        resolved,
        retryEscalation: routing?.retryEscalation ?? false,
        modelTiers: MODEL_TIERS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read routing config: ${msg}` });
    }
  });

  app.patch("/api/fleet/routing", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    try {
      const adapterPath = path.join(p.projectRoot, ".quack", "adapter.json");

      // Read current config
      const content = fs.readFileSync(adapterPath, "utf-8");
      const config = JSON.parse(content) as Record<string, unknown>;

      // Validate updates against ModelRoutingConfig schema
      const updates = req.body as Record<string, unknown>;
      const currentRouting = (config.modelRouting as Record<string, unknown>) || {};
      const merged = { ...currentRouting, ...updates };

      const validation = ModelRoutingConfigSchema.safeParse(merged);
      if (!validation.success) {
        res.status(400).json({
          error: "Invalid model routing configuration",
          details: validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        return;
      }

      // Update config with validated routing
      config.modelRouting = validation.data;

      // Write back to disk
      fs.writeFileSync(adapterPath, JSON.stringify(config, null, 2), "utf-8");

      res.json({ ok: true, modelRouting: validation.data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to update routing config: ${msg}` });
    }
  });

  // ─── Fleet control endpoints ──────────────────────────────────

  app.get("/api/fleet/status", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }
    res.json(p.fleetController.getStatus());
  });

  app.post("/api/fleet/emergency-stop", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const reason = typeof body?.reason === "string" ? body.reason : "Emergency stop";

    try {
      // Close queue admission before the potentially multi-second process
      // drain. Otherwise the queue can schedule or propagate another task
      // while the managers are still shutting down.
      p.dispatchQueue?.abort();
      const result = await p.fleetController.emergencyStop(reason);

      emitFleetEvent("fleet_emergency_stop", {
        reason,
        killedTasks: result.killedTasks,
        killedPids: result.killedPids,
        prepKilledTasks: result.prepKilledTasks,
        prepTimedOutTasks: result.prepTimedOutTasks,
      });
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Emergency stop failed: ${msg}` });
    }
  });

  app.post("/api/fleet/pause", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const reason = typeof body?.reason === "string" ? body.reason : "Manual pause";

    try {
      p.fleetController.pause(reason);

      // Also pause the dispatch queue
      if (p.dispatchQueue) {
        p.dispatchQueue.pause(`Fleet paused: ${reason}`);
      }

      emitFleetEvent("fleet_paused", { reason });
      res.json({ ok: true, state: "paused" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Pause failed: ${msg}` });
    }
  });

  app.get("/api/fleet/prep-shutdown-survivors", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }
    res.json({ survivors: p.fleetController.getPrepShutdownSurvivors() });
  });

  app.post(
    "/api/fleet/prep-shutdown-survivors/:taskId/reconcile",
    (req: Request, res: Response) => {
      const p = resolveProject(req);
      if (!p.fleetController) {
        res.status(500).json({ error: "Fleet controller not available" });
        return;
      }
      const body = req.body as Record<string, unknown> | undefined;
      if (
        typeof body?.confirmationToken !== "string" ||
        body.confirmationToken.length === 0 ||
        body.processTreeConfirmedStopped !== true
      ) {
        res.status(400).json({
          error:
            "confirmationToken and processTreeConfirmedStopped=true are required after independently verifying the process tree is gone",
        });
        return;
      }
      const reconciled = p.fleetController.reconcilePrepShutdownSurvivor(
        req.params.taskId as string,
        body.confirmationToken,
        true,
      );
      if (!reconciled) {
        res.status(409).json({ error: "Prep shutdown survivor could not be reconciled" });
        return;
      }
      res.json({ ok: true, taskId: req.params.taskId });
    },
  );

  app.get("/api/fleet/shared-checkout-shutdown-survivor", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }
    res.json({ survivor: p.fleetController.getSharedCheckoutShutdownSurvivor() ?? null });
  });

  app.post(
    "/api/fleet/shared-checkout-shutdown-survivor/reconcile",
    (req: Request, res: Response) => {
      const p = resolveProject(req);
      if (!p.fleetController) {
        res.status(500).json({ error: "Fleet controller not available" });
        return;
      }
      const body = req.body as Record<string, unknown> | undefined;
      if (
        typeof body?.taskId !== "string" ||
        typeof body.sessionId !== "string" ||
        typeof body.reconciliationToken !== "string" ||
        body.processTreeConfirmedStopped !== true
      ) {
        res.status(400).json({
          error:
            "taskId, sessionId, reconciliationToken, and processTreeConfirmedStopped=true are required",
        });
        return;
      }
      const reconciled = p.fleetController.reconcileSharedCheckoutShutdownSurvivor(
        body.taskId,
        body.sessionId,
        body.reconciliationToken,
        true,
      );
      if (!reconciled) {
        res
          .status(409)
          .json({ error: "Shared-checkout shutdown survivor could not be reconciled" });
        return;
      }
      res.json({ ok: true, taskId: body.taskId });
    },
  );

  app.post("/api/fleet/resume", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.fleetController) {
      res.status(500).json({ error: "Fleet controller not available" });
      return;
    }

    const priorState = p.fleetController.getState();
    try {
      // Re-open manager admission before queue scheduling. An emergency stop
      // aborts (rather than pauses) the queue, so it must be started again.
      await p.fleetController.resume();
      if (p.dispatchQueue) {
        if (priorState === "emergency_stopped") {
          await p.dispatchQueue.start();
        } else {
          await p.dispatchQueue.resume();
        }
      }

      emitFleetEvent("fleet_resumed", {});
      res.json({ ok: true, state: "running" });
    } catch (err: unknown) {
      if (priorState === "emergency_stopped") {
        p.dispatchQueue?.abort();
        await p.fleetController.emergencyStop("Emergency resume failed").catch(() => undefined);
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Resume failed: ${msg}` });
    }
  });

  // ─── Fleet/containers endpoint ─────────────────────────────────

  app.get("/api/fleet/containers", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.dispatchManager) {
      res.json([]);
      return;
    }
    res.json(p.dispatchManager.getActiveContainers());
  });

  // ─── Cost Velocity endpoints ─────────────────────────────────

  app.get("/api/fleet/velocity", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const baseline = p.costVelocityTracker.getBaseline();
    const activeSnapshots = p.costVelocityTracker.getActiveSnapshots();
    const config = p.costVelocityTracker.getConfig();
    res.json({ config, baseline, activeSnapshots });
  });

  // ─── Agent Health endpoints ─────────────────────────────────

  app.get("/api/fleet/health", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const agents = p.progressDetector.getAllHealth();
    const config = p.progressDetector.getConfig();
    res.json({ config, agents });
  });

  app.get("/api/tasks/:id/health", (req: Request, res: Response) => {
    const p = resolveProject(req);
    const taskId = req.params.id as string;
    const health = p.progressDetector.getHealth(taskId);
    if (!health) {
      res.status(404).json({ error: `No health data for task ${taskId}` });
      return;
    }
    res.json(health);
  });
}
