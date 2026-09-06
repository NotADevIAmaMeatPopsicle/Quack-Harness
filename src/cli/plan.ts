// ─── CLI: quack plan ────────────────────────────────────────────────
// Generate task specifications from a raw prompt using the planner agent.

import { loadAdapter } from "../core/adapter-loader.js";
import { planTasks } from "../planner/index.js";

/**
 * CLI command handler for `quack plan`.
 *
 * @param rawPrompt - Raw user prompt describing the feature/task to implement
 * @param options - CLI options
 */
export async function planCommand(
  rawPrompt: string,
  options: {
    project?: string;
    model?: string;
    maxTasks?: number;
    dryRun?: boolean;
    startId?: number;
  },
): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  try {
    console.log(`\nPlanning tasks from prompt...\n${"=".repeat(40)}\n`);

    // Load adapter
    const adapter = await loadAdapter(projectPath);
    console.log(`Project: ${adapter.config.project.name}`);
    console.log(`Root: ${adapter.projectRoot}\n`);

    // Run planner
    const result = await planTasks(rawPrompt, adapter, {
      model: options.model,
      maxTasks: options.maxTasks,
      dryRun: options.dryRun,
      startId: options.startId,
    });

    // Display results
    if (options.dryRun) {
      console.log(`\nGenerated ${result.taskIds.length} task(s) (dry-run):\n`);
      for (let i = 0; i < result.taskIds.length; i++) {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`Task ${i + 1}: ${result.taskIds[i]}`);
        console.log("=".repeat(60));
        console.log(result.specs[i]);
      }
      console.log(`\n${"=".repeat(60)}`);
      console.log("\nDry-run complete. No files were written.");
    } else {
      console.log(`\nSuccessfully generated ${result.taskIds.length} task(s):\n`);
      for (const taskId of result.taskIds) {
        console.log(`  ✓ ${taskId}`);
      }
      console.log(`\nTask files written to ${adapter.config.project.taskDir}`);
    }

    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
