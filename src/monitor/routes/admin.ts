// ─── Admin Routes ────────────────────────────────────────────────────
// Administrative endpoints: branch sweep, operational tooling (TASK-898).

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { sweep as SweepFn } from "../../dispatcher/branch-manager.js";

export type { SweepFn };

// ─── Types ──────────────────────────────────────────────────────────

export interface AdminRouteDeps {
  resolveProject: (req: Request) => {
    projectRoot?: string;
    projectId?: string | null;
  };
}

// ─── Schemas ────────────────────────────────────────────────────────

const sweepBranchesSchema = z.object({
  dryRun: z.boolean().default(true),
  minAgeDays: z.number().positive().max(365).optional(),
  baseBranch: z.string().optional(),
  allowedPrefixes: z.array(z.string().trim().min(1)).optional(),
  protectedOwners: z.array(z.string().trim().min(1)).optional(),
  protectedPatterns: z.array(z.string().trim().min(1)).optional(),
  ownerOverride: z
    .object({
      owner: z.string().trim().min(1),
      reason: z.string().trim().min(1),
    })
    .optional(),
});

// ─── Route registration ──────────────────────────────────────────────

export function registerAdminRoutes(app: Express, deps: AdminRouteDeps): void {
  const { resolveProject } = deps;

  /**
   * POST /api/admin/branches/sweep
   *
   * Scan and optionally delete merged quack/TASK-* branches (local + remote).
   * Defaults to dryRun: true — pass {"dryRun": false} to actually delete.
   */
  app.post("/api/admin/branches/sweep", async (req: Request, res: Response) => {
    const project = resolveProject(req);
    if (!project.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parseResult = sweepBranchesSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.flatten(),
      });
      return;
    }

    const {
      dryRun,
      minAgeDays,
      baseBranch,
      allowedPrefixes,
      protectedOwners,
      protectedPatterns,
      ownerOverride,
    } = parseResult.data;

    try {
      const { loadAdapter } = await import("../../core/adapter-loader.js");
      const { sweep } = await import("../../dispatcher/branch-manager.js");
      const adapter = await loadAdapter(project.projectRoot);
      const report = await sweep(
        project.projectRoot,
        {
          dryRun,
          minAgeDays,
          baseBranch,
          allowedPrefixes,
          protectedOwners,
          protectedPatterns,
          ownerOverride,
        },
        adapter,
      );
      res.json({ ok: true, report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });
}
