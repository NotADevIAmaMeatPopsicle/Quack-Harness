// ─── CLI: quack projects ────────────────────────────────────────────
// Manage the global project registry (~/.quack/config.json).
// List, add, remove projects and update per-project / monitor settings.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  loadGlobalConfig,
  registerProject,
  unregisterProject,
  updateProjectSettings,
  updateMonitorSettings,
  getConfigPath,
} from "../core/global-config.js";

export function projectsCommand(options: {
  add?: string;
  remove?: string;
  setAutoPrep?: string;
  setAutoPreflight?: string;
  port?: string;
}): void {
  try {
    // ─── Add a project ──────────────────────────────────────────
    if (options.add) {
      const projectPath = path.resolve(options.add);
      const adapterPath = path.join(projectPath, ".quack", "adapter.json");

      if (!fs.existsSync(adapterPath)) {
        console.error(
          `Error: No .quack/adapter.json found at ${projectPath}\n` +
            "Run `quack init <path>` first to bootstrap the project adapter.",
        );
        process.exit(1);
      }

      registerProject(projectPath);
      console.log(`Registered: ${projectPath}`);
      return;
    }

    // ─── Remove a project ───────────────────────────────────────
    if (options.remove) {
      const projectPath = path.resolve(options.remove);
      const removed = unregisterProject(projectPath);
      if (removed) {
        console.log(`Unregistered: ${projectPath}`);
      } else {
        console.error(`Not found in registry: ${projectPath}`);
        process.exit(1);
      }
      return;
    }

    // ─── Update auto-prep setting ───────────────────────────────
    if (options.setAutoPrep !== undefined) {
      const projectPath = path.resolve(process.cwd());
      const value = options.setAutoPrep === "true";
      updateProjectSettings(projectPath, { autoPrep: value });
      console.log(`Updated autoPrep=${value} for ${projectPath}`);
      return;
    }

    // ─── Update auto-preflight setting ──────────────────────────
    if (options.setAutoPreflight !== undefined) {
      const projectPath = path.resolve(process.cwd());
      const value = options.setAutoPreflight === "true";
      updateProjectSettings(projectPath, { autoPreflight: value });
      console.log(`Updated autoPreflight=${value} for ${projectPath}`);
      return;
    }

    // ─── Update monitor port ────────────────────────────────────
    if (options.port) {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error("Error: Invalid port number");
        process.exit(1);
      }
      updateMonitorSettings({ port });
      console.log(`Updated default monitor port to ${port}`);
      return;
    }

    // ─── List projects (default) ────────────────────────────────
    const config = loadGlobalConfig();

    console.log(`\nQuack Global Config — ${getConfigPath()}`);
    console.log("=".repeat(50));
    console.log(`\nDefault monitor port: ${config.monitor.port}\n`);

    if (config.projects.length === 0) {
      console.log("No projects registered.");
      console.log("\nRegister a project:");
      console.log("  quack projects --add <path>");
      console.log("  quack init <path>  (auto-registers)\n");
      return;
    }

    console.log(`Projects (${config.projects.length}):\n`);
    for (const entry of config.projects) {
      const adapterExists = fs.existsSync(path.join(entry.path, ".quack", "adapter.json"));
      const status = adapterExists ? "ok" : "MISSING adapter";

      const settings: string[] = [];
      if (entry.autoPrep) settings.push("autoPrep");
      if (entry.autoPreflight) settings.push("autoPreflight");
      const settingsStr = settings.length > 0 ? ` [${settings.join(", ")}]` : "";

      console.log(`  ${entry.path}  (${status})${settingsStr}`);
    }
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
