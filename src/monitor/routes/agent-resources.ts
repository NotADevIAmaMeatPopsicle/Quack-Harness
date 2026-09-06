// ─── Agent Resources Routes ────────────────────────────────────────────────
// Serves public project documentation from the repository so the monitor can
// provide an in-app reference without exposing local agent configuration or
// private operating material.
//
// All paths resolve relative to the Quack repo root (3 levels up from this
// compiled file at dist/monitor/routes/agent-resources.js → repo root).

import type { Express, Request, Response } from "express";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface AgentResource {
  id: string;
  title: string;
  description: string;
  category: string;
  relativePath: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export const RESOURCES: AgentResource[] = [
  {
    id: "readme",
    title: "README",
    description: "Project overview, prerequisites, quick start, and supported capabilities.",
    category: "Start here",
    relativePath: "README.md",
  },
  {
    id: "architecture",
    title: "Architecture",
    description: "Component boundaries, execution lifecycle, persistence, and trust model.",
    category: "Design",
    relativePath: "ARCHITECTURE.md",
  },
  {
    id: "getting-started",
    title: "Getting Started",
    description: "Installation, adapter setup, first task, and local monitor walkthrough.",
    category: "Guides",
    relativePath: "docs/GETTING-STARTED.md",
  },
  {
    id: "adapter-reference",
    title: "Adapter Configuration",
    description: "Reference for project paths, policies, verification, Git, and model settings.",
    category: "Reference",
    relativePath: "docs/ADAPTER_CONFIG_REFERENCE.md",
  },
  {
    id: "cli-reference",
    title: "CLI Reference",
    description: "Commands and options for tasks, queues, workers, repair, and integrations.",
    category: "Reference",
    relativePath: "docs/CLI_REFERENCE.md",
  },
  {
    id: "api-reference",
    title: "HTTP API Reference",
    description: "Monitor, queue, task, worker, review, and federation endpoints.",
    category: "Reference",
    relativePath: "docs/API_REFERENCE.md",
  },
  {
    id: "security",
    title: "Security Policy",
    description: "Vulnerability reporting and deployment guidance.",
    category: "Policy",
    relativePath: "SECURITY.md",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    description: "Common installation, configuration, verification, and worker issues.",
    category: "Guides",
    relativePath: "docs/TROUBLESHOOTING.md",
  },
];

const RESOURCE_BY_ID = new Map(RESOURCES.map((r) => [r.id, r]));

interface ResourceListEntry extends AgentResource {
  available: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

async function describeResource(resource: AgentResource): Promise<ResourceListEntry> {
  const absolute = path.join(REPO_ROOT, resource.relativePath);
  try {
    const stat = await fs.stat(absolute);
    return {
      ...resource,
      available: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      ...resource,
      available: false,
      sizeBytes: null,
      modifiedAt: null,
    };
  }
}

function readFileText(resource: AgentResource): Promise<string> {
  const absolute = path.join(REPO_ROOT, resource.relativePath);
  return fs.readFile(absolute, "utf8");
}

function downloadFilenameFor(resource: AgentResource): string {
  // Use the actual filename so consumers get a reasonable suggested name.
  return path.basename(resource.relativePath);
}

export function registerAgentResourcesRoutes(app: Express): void {
  app.get("/api/agent-resources", async (_req: Request, res: Response) => {
    try {
      const entries = await Promise.all(RESOURCES.map(describeResource));
      res.json({
        repoRoot: REPO_ROOT,
        count: entries.length,
        resources: entries,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list agent resources: ${msg}` });
    }
  });

  app.get("/api/agent-resources/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const resource = RESOURCE_BY_ID.get(id);
    if (!resource) {
      res.status(404).json({ error: `Unknown agent resource id: ${id}` });
      return;
    }
    try {
      const content = await readFileText(resource);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("X-Resource-Id", resource.id);
      res.setHeader("X-Resource-Path", resource.relativePath);
      res.send(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(404).json({
        error: `Resource '${id}' is registered but the file is not present on disk: ${msg}`,
      });
    }
  });

  app.get("/api/agent-resources/:id/download", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const resource = RESOURCE_BY_ID.get(id);
    if (!resource) {
      res.status(404).json({ error: `Unknown agent resource id: ${id}` });
      return;
    }
    try {
      const content = await readFileText(resource);
      const filename = downloadFilenameFor(resource);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Resource-Id", resource.id);
      res.send(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(404).json({
        error: `Resource '${id}' is registered but the file is not present on disk: ${msg}`,
      });
    }
  });
}
