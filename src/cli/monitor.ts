// ─── CLI: quack monitor ─────────────────────────────────────────────
// Starts the monitor web dashboard at localhost:3333.
// Watches .quack/logs/ for event JSONL files and streams them to the
// browser via SSE.
//
// When no --project flag is given, reads ~/.quack/config.json for
// registered projects and uses multi-project mode automatically.

import * as path from "node:path";
import { getBuildInfo } from "../core/build-info.js";

import { loadAdapter } from "../core/adapter-loader.js";
import { createMonitorServer } from "../monitor/server.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";

export async function monitorCommand(options: {
  port?: string;
  host?: string;
  project?: string | string[];
}): Promise<void> {
  // Determine project paths and port
  let projectPaths: string[];
  let port: number;
  let fromGlobalConfig = false;

  if (options.project) {
    // Explicit --project flag(s) — use them directly (backward compat)
    projectPaths = Array.isArray(options.project) ? options.project : [options.project];
    port = options.port ? parseInt(options.port, 10) : 3333;
  } else {
    // No --project flag — try global config
    try {
      const { loadGlobalConfig } = await import("../core/global-config.js");
      const globalConfig = loadGlobalConfig();

      if (globalConfig.projects.length > 0) {
        projectPaths = globalConfig.projects.map((p) => p.path);
        port = options.port ? parseInt(options.port, 10) : globalConfig.monitor.port;
        fromGlobalConfig = true;
      } else {
        // No projects registered — fall back to cwd
        projectPaths = [process.cwd()];
        port = options.port ? parseInt(options.port, 10) : globalConfig.monitor.port;
      }
    } catch {
      // Global config unavailable — fall back to cwd
      projectPaths = [process.cwd()];
      port = options.port ? parseInt(options.port, 10) : 3333;
    }
  }

  try {
    // Load adapters for all projects (skip projects with invalid adapters)
    const adapters: ProjectAdapter[] = [];
    const skippedProjects: string[] = [];
    for (const projectPath of projectPaths) {
      try {
        const adapter = await loadAdapter(projectPath);
        adapters.push(adapter);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        skippedProjects.push(`${projectPath}: ${msg}`);
      }
    }

    if (adapters.length === 0) {
      console.error("Error: No valid projects found.");
      for (const skip of skippedProjects) {
        console.error(`  Skipped: ${skip}`);
      }
      process.exit(1);
    }

    const build = getBuildInfo();
    console.log(`\nQuack Monitor v${build.version} (${build.commit})`);
    console.log(`Built: ${build.builtAt}`);
    console.log(`${"=".repeat(40)}`);

    if (fromGlobalConfig) {
      console.log(`Config:   ~/.quack/config.json`);
    }

    if (skippedProjects.length > 0) {
      console.log(`\nSkipped ${skippedProjects.length} project(s) with invalid adapters:`);
      for (const skip of skippedProjects) {
        console.log(`  - ${skip}`);
      }
    }

    // Always use multi-project mode when loading from global config,
    // even for a single project. This ensures every project gets
    // full services including TaskWatcher.
    if (adapters.length === 1 && !fromGlobalConfig) {
      // Single-project mode (legacy — only when explicit --project flag)
      const adapter = adapters[0];
      const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);

      console.log(`Project: ${adapter.config.project.name}`);
      console.log(`Log dir: ${logDir}`);
      console.log(`Port:    ${port}\n`);

      const adapterPath = path.resolve(adapter.projectRoot, ".quack", "adapter.json");
      const server = createMonitorServer({
        logDir,
        port,
        adapterPath,
        projectRoot: adapter.projectRoot,
        taskDir: adapter.config.project.taskDir,
        runtimeRole: "headnode",
        host: options.host ?? "127.0.0.1",
      });
      const { stop } = await server.start();

      console.log(`Dashboard: http://localhost:${port}`);
      console.log(`SSE:       http://localhost:${port}/api/events/stream`);
      console.log(`Health:    http://localhost:${port}/api/health`);
      console.log(`\nPress Ctrl+C to stop.\n`);

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down monitor...");
        await stop();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    } else {
      // Multi-project mode
      console.log(`Projects: ${adapters.map((a) => a.config.project.name).join(", ")}`);
      console.log(`Port:     ${port}\n`);

      const server = createMonitorServer({
        port,
        projectAdapters: adapters,
        runtimeRole: "headnode",
        host: options.host ?? "127.0.0.1",
      });
      const { stop } = await server.start();

      console.log(`Dashboard: http://localhost:${port}`);
      console.log(`API:       http://localhost:${port}/api/projects`);
      console.log(`Health:    http://localhost:${port}/api/health`);
      console.log(`\nProjects:`);
      for (const adapter of adapters) {
        console.log(`  - ${adapter.config.project.name} (${adapter.projectRoot})`);
      }
      console.log(`\nPress Ctrl+C to stop.\n`);

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down monitor...");
        await stop();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      console.error(err.stack);
    } else {
      console.error(`Error: ${String(err)}`);
    }
    process.exit(1);
  }
}
