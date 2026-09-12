// ─── GitHub Sync Routes ─────────────────────────────────────────────
// REST API routes for GitHub sync map CRUD operations.

import type { Express, Request, Response } from "express";
import { getSyncMap } from "../../integrations/github/sync-map.js";
import { syncTaskStatusToIssue } from "../../integrations/github/status-syncer.js";
import type { AdapterConfig } from "../../core/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectContext {
  projectRoot?: string;
}

export function registerGitHubSyncRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
): void {
  app.get("/api/github/sync-map", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    const taskId = req.query.taskId as string | undefined;
    const issueNumber = req.query.issueNumber
      ? parseInt(req.query.issueNumber as string, 10)
      : undefined;

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const adapterPath = path.join(p.projectRoot, ".quack", "adapter.json");
      JSON.parse(fs.readFileSync(adapterPath, "utf-8"));
      const syncMap = await getSyncMap(p.projectRoot);
      let entries = syncMap.getAllEntries();

      if (taskId) {
        entries = entries.filter((e) => e.taskId === taskId);
      }
      if (issueNumber !== undefined) {
        entries = entries.filter((e) => e.issueNumber === issueNumber);
      }

      res.json({ entries });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load sync map: ${msg}` });
    }
  });

  app.delete("/api/github/sync-map/:taskId", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : req.params.taskId[0];
    const p = resolveProject(req);

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const adapterPath = path.join(p.projectRoot, ".quack", "adapter.json");
      JSON.parse(fs.readFileSync(adapterPath, "utf-8"));
      const syncMap = await getSyncMap(p.projectRoot);

      const entry = syncMap.getEntryByTaskId(taskId);
      if (!entry) {
        res.status(404).json({ error: `Sync entry not found for task ${taskId}` });
        return;
      }

      syncMap.removeEntry(taskId);
      await syncMap.save();

      res.json({ ok: true, deleted: entry });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to delete sync entry: ${msg}` });
    }
  });

  app.post("/api/github/sync-map/:taskId/refresh", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : req.params.taskId[0];
    const p = resolveProject(req);

    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const adapterPath = path.join(p.projectRoot, ".quack", "adapter.json");
      const config = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as AdapterConfig;
      const syncMap = await getSyncMap(p.projectRoot);

      const entry = syncMap.getEntryByTaskId(taskId);
      if (!entry) {
        res.status(404).json({ error: `Sync entry not found for task ${taskId}` });
        return;
      }

      // Sync task status to the linked issue
      await syncTaskStatusToIssue(taskId, entry.taskStatus, config, p.projectRoot);

      // Reload the entry to get updated sync timestamp
      const updatedSyncMap = await getSyncMap(p.projectRoot);
      const updatedEntry = updatedSyncMap.getEntryByTaskId(taskId);

      res.json({ ok: true, entry: updatedEntry });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to refresh sync: ${msg}` });
    }
  });
}
