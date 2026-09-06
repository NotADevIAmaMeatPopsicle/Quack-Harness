// ─── CLI: quack wave ─────────────────────────────────────────────────
// Batch execute a wave of tasks. Currently a placeholder —
// full implementation deferred.

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { loadStatusOverlay, resolveDependencies } from "../dispatcher/dependency-resolver.js";
import { selectTasks } from "../dispatcher/task-selector.js";

export async function waveCommand(
  waveNumber: string,
  options: { parallel: string; project?: string },
): Promise<void> {
  const projectPath = options.project ?? process.cwd();
  const parallelCount = parseInt(options.parallel, 10);

  if (isNaN(parallelCount) || parallelCount < 1) {
    console.error("Error: --parallel must be a positive integer");
    process.exit(1);
  }

  try {
    const adapter = await loadAdapter(projectPath);
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

    console.log(`\nWave ${waveNumber} — ${adapter.config.project.name}\n${"=".repeat(40)}\n`);

    // TASK-1202: eligibility honors DB task_status over spec Status: lines.
    const statusOverlay = loadStatusOverlay(adapter.projectRoot);
    if (statusOverlay) {
      console.log(
        `Status overlay: .quack/quack.db (${statusOverlay.size} rows; db wins over spec)\n`,
      );
    }

    // Resolve dependencies to find eligible tasks
    const resolution = await resolveDependencies(taskDir, { statusOverlay });

    if (resolution.errors.length > 0) {
      console.log("Parse errors:");
      for (const err of resolution.errors) {
        console.log(`  ${err.file}: ${err.error}`);
      }
      console.log();
    }

    if (resolution.eligible.length === 0) {
      console.log("No eligible tasks found for this wave.");
      console.log(`  Blocked tasks: ${resolution.blocked.length}`);
      process.exit(0);
    }

    // Rank eligible tasks
    const selections = selectTasks(resolution.eligible);

    console.log(`Eligible tasks: ${selections.length}`);
    console.log(`Parallel limit: ${parallelCount}`);
    console.log();

    console.log("Tasks that would run:");
    const toRun = selections.slice(0, parallelCount);
    for (const selection of toRun) {
      console.log(
        `  ${selection.taskId} [${selection.priority}] — ` +
          `effort: ${selection.effort}, fit: ${selection.estimatedAgentFit}, ` +
          `readiness: ${selection.readinessScore}`,
      );
    }

    if (selections.length > parallelCount) {
      console.log(`\n  ... and ${selections.length - parallelCount} more eligible task(s) queued`);
    }

    console.log();
    console.log(
      "Note: Full wave execution is not yet implemented. " +
        "Use 'quack run TASK-NNN' to execute individual tasks.",
    );
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
