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

export function resolveMonitorBindHost(host?: string): string {
  return host?.trim() || "127.0.0.1";
}

export function formatMonitorUrlHost(host: string): string {
  return host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
}

export function describeMonitorNetwork(
  host: string,
  port: number,
  mode: "single" | "multi",
): { bindHost: string; lines: string[] } {
  const urlHost = formatMonitorUrlHost(host);
  const lines = [`Bind:      ${urlHost}:${port}`, `Dashboard: http://${urlHost}:${port}`];
  lines.push(
    mode === "single"
      ? `SSE:       http://${urlHost}:${port}/api/events/stream`
      : `API:       http://${urlHost}:${port}/api/projects`,
  );
  lines.push(`Health:    http://${urlHost}:${port}/api/health`);
  return { bindHost: host, lines };
}

export async function monitorCommand(options: {
  port?: string;
  host?: string;
  project?: string | string[];
}): Promise<void> {
  // Determine project paths and port
  let projectPaths: string[];
  let port: number;
  const host = resolveMonitorBindHost(options.host);
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

      const network = describeMonitorNetwork(host, port, "single");
      const adapterPath = path.resolve(adapter.projectRoot, ".quack", "adapter.json");
      const server = createMonitorServer({
        logDir,
        port,
        adapterPath,
        projectRoot: adapter.projectRoot,
        taskDir: adapter.config.project.taskDir,
        runtimeRole: "headnode",
        host: network.bindHost,
      });
      const { stop } = await server.start();

      for (const line of network.lines) console.log(line);
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

      const network = describeMonitorNetwork(host, port, "multi");
      const server = createMonitorServer({
        port,
        projectAdapters: adapters,
        runtimeRole: "headnode",
        host: network.bindHost,
      });
      const { stop } = await server.start();

      for (const line of network.lines) console.log(line);
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
