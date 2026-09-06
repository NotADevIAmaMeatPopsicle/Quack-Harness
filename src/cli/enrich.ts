// ─── CLI: quack enrich ───────────────────────────────────────────────
// Run readiness gate + enrichment for a task. Show the enriched diff
// and prompt for approval: y (approve) / n (reject) / edit (open in editor).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import { loadAdapter } from "../core/adapter-loader.js";
import { listDuplicateClaimants, resolveTaskFile } from "../core/task-file-resolver.js";
import { formatDuplicateClaimantsMessage } from "../core/duplicate-claimants.js";
import { runReadinessGate } from "../gate/gate.js";

// ─── Prompt helper ──────────────────────────────────────────────────

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ─── Main enrich handler ────────────────────────────────────────────

export async function enrichCommand(taskId: string, options: { project?: string }): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  try {
    const adapter = await loadAdapter(projectPath);
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

    console.log(`\nEnriching ${taskId}\n${"=".repeat(40)}\n`);

    // Find and parse task file
    const resolved = await resolveTaskFile(taskDir, taskId);
    if (!resolved?.task) {
      throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
    }

    const { filePath, task } = resolved;

    console.log(`Task: ${task.id} — ${task.title}`);
    console.log(`Priority: ${task.priority}`);
    console.log(`Status: ${task.status}\n`);

    // Run gate with enrichment enabled
    console.log("Running readiness gate...\n");
    const gateResult = await runReadinessGate(task, adapter);

    if (gateResult.outcome === "pass") {
      console.log("Task already passes readiness gate — no enrichment needed.");
      process.exit(0);
    }

    if (gateResult.outcome === "rejected") {
      console.log(`Task rejected: ${gateResult.reason}`);
      if ("missing" in gateResult.details) {
        console.log(`Missing fields: ${gateResult.details.missing.join(", ")}`);
      }
      if ("deficiencies" in gateResult.details) {
        console.log(`Deficiencies: ${gateResult.details.deficiencies.join(", ")}`);
      }
      process.exit(2);
    }

    // outcome === "enriched"
    const enrichedTask = gateResult.task;

    console.log("Enrichment complete. Changes:\n");
    console.log("--- Original ---");
    console.log(enrichedTask.original.rawContent.slice(0, 500));
    if (enrichedTask.original.rawContent.length > 500) {
      console.log("  ... (truncated)");
    }
    console.log();

    console.log("--- Enriched ---");
    console.log(enrichedTask.enriched.rawContent.slice(0, 500));
    if (enrichedTask.enriched.rawContent.length > 500) {
      console.log("  ... (truncated)");
    }
    console.log();

    if (enrichedTask.diff) {
      console.log(`Diff summary: ${enrichedTask.diff}`);
      console.log();
    }

    // Prompt for approval
    const answer = await promptUser("Approve enrichment? (y/n/edit): ");

    switch (answer) {
      case "y":
      case "yes": {
        const claimants = await listDuplicateClaimants(taskDir, taskId);
        if (claimants.length > 0) {
          console.error(formatDuplicateClaimantsMessage(taskId, claimants));
          process.exit(1);
          return;
        }
        // Write enriched content back to the task file
        await fs.writeFile(filePath, enrichedTask.enriched.rawContent, "utf-8");
        console.log(`\nEnriched task written to ${filePath}`);
        process.exit(0);
        break;
      }

      case "n":
      case "no": {
        console.log("\nEnrichment rejected. Task file unchanged.");
        process.exit(2);
        break;
      }

      case "edit":
      case "e": {
        const claimants = await listDuplicateClaimants(taskDir, taskId);
        if (claimants.length > 0) {
          console.error(formatDuplicateClaimantsMessage(taskId, claimants));
          process.exit(1);
          return;
        }
        // Keep previews outside taskDir so the scanner does not treat the
        // enriched copy as another claimant for this task id.
        const previewDir = path.join(adapter.projectRoot, ".quack", "enriched");
        const tmpPath = path.join(previewDir, `${taskId}.enriched.md`);
        await fs.mkdir(previewDir, { recursive: true });
        await fs.writeFile(tmpPath, enrichedTask.enriched.rawContent, "utf-8");
        console.log(`\nEnriched version written to ${tmpPath}`);
        console.log("Edit the file manually, then replace the original when satisfied.");
        process.exit(0);
        break;
      }

      default: {
        console.log(`\nUnrecognized option: "${answer}". Task file unchanged.`);
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
