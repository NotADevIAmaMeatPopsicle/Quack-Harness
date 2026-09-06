import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { ManagedWorktreeRecord, ManagedWorktreeCleanupResult } from "../dispatch-manager.js";
import { validationDetails } from "../../intake/task-intake.js";

const DEFAULT_WORKTREE_MAX_AGE_HOURS = 24;

const pruneWorktreesSchema = z.object({
  dryRun: z.boolean().optional(),
  maxAgeHours: z
    .number()
    .positive()
    .max(24 * 30)
    .optional(),
  ownerOverride: z
    .object({
      owner: z.string().min(1),
      reason: z.string().min(1),
    })
    .optional(),
});

export interface WorktreeRouteProject {
  projectId?: string;
  projectName?: string;
  dispatchManager?: {
    listManagedWorktrees: (maxAgeMs?: number, nowMs?: number) => ManagedWorktreeRecord[];
    pruneManagedWorktrees: (options?: {
      dryRun?: boolean;
      maxAgeMs?: number;
      nowMs?: number;
      ownerOverride?: {
        owner: string;
        reason: string;
      };
    }) => ManagedWorktreeCleanupResult;
  } | null;
}

export interface WorktreeRouteDeps {
  resolveProject: (req: Request) => WorktreeRouteProject;
}

function maxAgeMsFromHours(value: unknown): number {
  const hours =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_WORKTREE_MAX_AGE_HOURS;
  return Math.round(hours * 60 * 60 * 1000);
}

function summarizeManagedWorktrees(records: ManagedWorktreeRecord[]): {
  scanned: number;
  pruneEligible: number;
  active: number;
  dirty: number;
  evidenceBearing: number;
  registered: number;
  orphaned: number;
} {
  return {
    scanned: records.length,
    pruneEligible: records.filter((record) => record.pruneEligible).length,
    active: records.filter((record) => record.activeJob).length,
    dirty: records.filter((record) => record.dirty).length,
    evidenceBearing: records.filter((record) => record.evidenceFiles.length > 0).length,
    registered: records.filter((record) => record.registered).length,
    orphaned: records.filter((record) => !record.registered).length,
  };
}

export function registerWorktreeRoutes(app: Express, deps: WorktreeRouteDeps): void {
  const { resolveProject } = deps;

  app.get("/api/worktrees", (req: Request, res: Response) => {
    const project = resolveProject(req);
    if (!project.dispatchManager) {
      res.status(404).json({ error: "Dispatch manager not configured" });
      return;
    }

    const rawHours =
      typeof req.query.maxAgeHours === "string" ? Number(req.query.maxAgeHours) : undefined;
    const maxAgeMs = maxAgeMsFromHours(rawHours);
    const checkedAt = new Date().toISOString();
    const records = project.dispatchManager.listManagedWorktrees(maxAgeMs);
    res.json({
      ok: true,
      projectId: project.projectId ?? null,
      projectName: project.projectName ?? null,
      checkedAt,
      maxAgeMs,
      summary: summarizeManagedWorktrees(records),
      records,
    });
  });

  app.post("/api/worktrees/prune", (req: Request, res: Response) => {
    const project = resolveProject(req);
    if (!project.dispatchManager) {
      res.status(404).json({ error: "Dispatch manager not configured" });
      return;
    }

    const parsed = pruneWorktreesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_worktree_prune_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const result = project.dispatchManager.pruneManagedWorktrees({
      dryRun: parsed.data.dryRun,
      maxAgeMs: maxAgeMsFromHours(parsed.data.maxAgeHours),
      ownerOverride: parsed.data.ownerOverride,
    });

    res.json({
      ok: true,
      projectId: project.projectId ?? null,
      projectName: project.projectName ?? null,
      summary: summarizeManagedWorktrees(result.retained),
      result,
    });
  });
}
