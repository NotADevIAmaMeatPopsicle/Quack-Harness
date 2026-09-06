// ─── Template Routes ────────────────────────────────────────────────
// REST API routes for template registry CRUD operations.

import type { Express, Request, Response } from "express";
import { buildRegistry, loadRegistry } from "../../templates/template-registry.js";
import { extractTemplate } from "../../templates/template-extractor.js";
import { parseTaskFile } from "../../core/task-parser.js";
import { resolveTaskFile } from "../../core/task-file-resolver.js";
import type { RunAnalysis } from "../../analytics/analytics-types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProjectContext {
  projectRoot?: string;
  taskDir?: string;
}

export function registerTemplateRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
): void {
  app.get("/api/templates", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const registry = await loadRegistry(p.projectRoot);
      res.json(registry);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load template registry: ${msg}` });
    }
  });

  app.get("/api/templates/:sourceTaskId", async (req: Request, res: Response) => {
    const sourceTaskId =
      typeof req.params.sourceTaskId === "string"
        ? req.params.sourceTaskId
        : req.params.sourceTaskId[0];
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const registry = await loadRegistry(p.projectRoot);
      const template = registry.templates.find((t) => t.sourceTaskId === sourceTaskId);

      if (!template) {
        res.status(404).json({ error: `Template not found for ${sourceTaskId}` });
        return;
      }

      res.json({ template });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load template: ${msg}` });
    }
  });

  app.post("/api/templates/rebuild", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const registry = await buildRegistry(p.projectRoot, p.taskDir ?? "docs/tasks");
      res.json({
        ok: true,
        templateCount: registry.templates.length,
        updatedAt: registry.updatedAt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to rebuild template registry: ${msg}` });
    }
  });

  app.post("/api/templates/extract", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const taskId = typeof body?.taskId === "string" ? body.taskId : undefined;

    if (!taskId) {
      res.status(400).json({ error: "taskId is required in request body" });
      return;
    }

    try {
      // Load the task file
      const taskDir = path.join(p.projectRoot, p.taskDir ?? "docs/tasks");
      const resolved = await resolveTaskFile(taskDir, taskId);
      if (!resolved) {
        res.status(404).json({ error: `Task file not found for ${taskId}` });
        return;
      }
      const task = resolved.task ?? parseTaskFile(resolved.content, resolved.filePath);

      // Load session history for this task
      const sessionLogPath = path.join(p.projectRoot, ".quack", "logs", "sessions.jsonl");
      const sessionLog = await fs.readFile(sessionLogPath, "utf-8");
      const sessions = sessionLog
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RunAnalysis)
        .filter((s) => s.taskId === taskId);

      if (sessions.length === 0) {
        res.status(404).json({ error: `No session history found for ${taskId}` });
        return;
      }

      const template = extractTemplate(task, sessions);
      res.json({ ok: true, template });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to extract template: ${msg}` });
    }
  });
}
