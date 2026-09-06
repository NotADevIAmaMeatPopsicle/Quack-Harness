// ─── Analytics Routes ───────────────────────────────────────────────
// REST API routes for analytics data with filtering capabilities.

import type { Express, Request, Response } from "express";
import type { FailurePatternDB } from "../../analytics/analytics-types.js";
import { createEmptyPatternDB } from "../../analytics/analytics-types.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectContext {
  projectRoot?: string;
}

export function registerAnalyticsRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
): void {
  const getAnalyticsPath = (projectRoot: string) =>
    path.join(projectRoot, ".quack", "analytics", "failure-patterns.json");

  const loadAnalyticsDB = (projectRoot: string): FailurePatternDB => {
    const analyticsPath = getAnalyticsPath(projectRoot);
    if (!fs.existsSync(analyticsPath)) {
      return createEmptyPatternDB();
    }
    try {
      return JSON.parse(fs.readFileSync(analyticsPath, "utf-8")) as FailurePatternDB;
    } catch {
      return createEmptyPatternDB();
    }
  };

  app.get("/api/analytics/summary", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const db = loadAnalyticsDB(p.projectRoot);
      const successRate = db.totalRuns > 0 ? db.totalApproved / db.totalRuns : 0;

      // Return top-level aggregate stats only (distinct from /patterns)
      res.json({
        totalRuns: db.totalRuns,
        totalApproved: db.totalApproved,
        totalRejected: db.totalRejected,
        totalErrors: db.totalErrors,
        successRate,
        topPatterns: db.knownPatterns.slice(0, 5),
        updatedAt: db.updatedAt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load analytics: ${msg}` });
    }
  });

  app.get("/api/analytics/patterns", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const db = loadAnalyticsDB(p.projectRoot);
      // Return the full pattern DB (distinct from /summary)
      res.json(db);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load analytics patterns: ${msg}` });
    }
  });

  app.get("/api/analytics/by-tag", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const tag = req.query.tag as string | undefined;

    try {
      const db = loadAnalyticsDB(p.projectRoot);

      if (tag) {
        const tagData = db.byTag[tag];
        if (!tagData) {
          res.json({ tag, data: null });
          return;
        }
        res.json({ tag, data: tagData });
      } else {
        // Return all tag data
        res.json(db.byTag);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load tag analytics: ${msg}` });
    }
  });

  app.get("/api/analytics/by-file", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const file = req.query.file as string | undefined;

    try {
      const db = loadAnalyticsDB(p.projectRoot);

      if (file) {
        const fileData = db.byFile[file];
        if (!fileData) {
          res.json({ file, data: null });
          return;
        }
        res.json({ file, data: fileData });
      } else {
        // Return all file data
        res.json(db.byFile);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load file analytics: ${msg}` });
    }
  });
}
