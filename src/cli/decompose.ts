// ─── Decompose CLI Command ──────────────────────────────────────────
// CLI command for decomposing a complex task into focused subtasks.
// Supports staged modes: plan, materialize, finalize.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadAdapter } from "../core/adapter-loader.js";
import { parseTaskFile } from "../core/task-parser.js";
import { decomposeTask } from "../preflight/task-decomposer.js";
import { materializeChildDrafts } from "../preflight/subtask-materializer.js";
import { writeSubtaskSpecs } from "../preflight/subtask-writer.js";
import { generateBlueprint } from "../blueprint/blueprint-agent.js";
import { evaluateComplexity } from "../preflight/complexity-evaluator.js";
import { assembleContext } from "../dispatcher/context-assembler.js";
import { PREP_THRESHOLD } from "../preflight/subtask-quality-gate.js";
import type { DecompositionTopology, ChildDraft } from "../preflight/decompose-types.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";
import { formatDuplicateClaimantsMessage } from "../core/duplicate-claimants.js";

export interface DecomposeOptions {
  project?: string;
  /** Staged operation mode. Default: plan */
  mode?: "plan" | "materialize" | "finalize";
  /** @deprecated Use mode=plan instead */
  dryRun?: boolean;
  enqueue?: boolean;
  maxSubtasks?: number;
  port?: number;
  /** Path to a JSON file containing topology from a previous plan run */
  planFile?: string;
  /** Path to a JSON file containing drafts from a previous materialize run */
  draftsFile?: string;
  /** Must be true to allow finalize to write files */
  reviewAcknowledged?: boolean;
}

/**
 * CLI command to decompose a task into subtasks using staged workflow.
 * Stages:
 *   plan       — produce topology + coverage report, write nothing
 *   materialize — generate rich child drafts + quality scores, write nothing
 *   finalize   — write child files and rewrite the parent as tracker
 *
 * @param taskId - Task ID to decompose (e.g., "TASK-042")
 * @param options - Command options
 */
export async function decomposeCommand(taskId: string, options: DecomposeOptions): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  // Resolve mode (map legacy dryRun → plan)
  let mode: "plan" | "materialize" | "finalize" = options.mode ?? "plan";
  if (options.dryRun === true) mode = "plan";

  try {
    console.log(`\nDecomposing ${taskId} (mode: ${mode})...\n${"=".repeat(50)}\n`);

    // Load adapter and parse task
    const adapter = await loadAdapter(projectPath);
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
    // TASK-1334: ONE canonical resolution, and its content reused rather than
    // re-read. Decompose finalize writes subtask specs derived from whatever
    // this selected and rewrites that file as DECOMPOSED, so a prefix match
    // here could decompose a SUBTASK under its parent's id and emit
    // `TASK-NNN-A-A`-shaped descendants.
    const { resolveTaskFile } = await import("../core/task-file-resolver.js");
    const resolved = await resolveTaskFile(taskDir, taskId);

    if (!resolved) {
      throw new Error(`Task file not found for ${taskId}`);
    }

    const filePath = resolved.filePath;
    const content = resolved.content;
    const parsedTask = resolved.task ?? parseTaskFile(content, filePath);

    // ── MODE: plan ──────────────────────────────────────────────────────────
    if (mode === "plan") {
      // Check complexity first
      console.log("Evaluating task complexity...");
      const context = await assembleContext(parsedTask, adapter);
      const complexity = evaluateComplexity(
        parsedTask,
        context.contextSizeEstimate ?? {
          taskSpec: 0,
          blueprint: 0,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 0,
          withinBudget: true,
        },
      );

      console.log(`  Files to modify: ${complexity.filesToModify}`);
      console.log(`  Success criteria: ${complexity.successCriteria}`);
      console.log(
        `  Estimated context: ~${complexity.estimatedContextTokens.toLocaleString()} tokens`,
      );

      if (!complexity.recommendDecomposition) {
        console.log(`\n⚠  Task does not exceed decomposition thresholds.`);
        console.log(`   Reason: ${complexity.reason}`);
        console.log(`   You may still proceed with decomposition if desired.\n`);
      } else {
        console.log(`\n✓ Task exceeds thresholds — decomposition recommended`);
        console.log(`  Reason: ${complexity.reason}\n`);
      }

      // Generate blueprint
      console.log("Generating implementation blueprint...");
      const blueprint = await generateBlueprint(parsedTask, adapter);
      console.log(`  ✓ Analyzed ${blueprint.fileAnalyses.length} files\n`);

      // Produce topology
      console.log("Planning topology...");
      const topology = await decomposeTask(parsedTask, adapter, blueprint, {
        maxSubtasks: options.maxSubtasks,
      });

      console.log(`\n✓ Topology plan: ${topology.subtasks.length} subtask(s)\n`);

      for (let i = 0; i < topology.subtasks.length; i++) {
        const subtask = topology.subtasks[i];
        console.log(`  ${i + 1}. ${subtask.id}: ${subtask.title}`);
        console.log(`     Files: ${subtask.filesToModify.length}`);
        console.log(`     Criteria: ${subtask.successCriteria.length}`);
        if (subtask.dependsOn.length > 0) {
          console.log(`     Depends on: ${subtask.dependsOn.join(", ")}`);
        }
        console.log("");
      }

      // Print coverage report
      const cr = topology.coverageReport;
      if (cr.hasCoverageGap) {
        console.log(`⚠  Coverage gaps detected:`);
        if (cr.unmappedFiles.length > 0) {
          console.log(`   Unmapped files: ${cr.unmappedFiles.join(", ")}`);
        }
        if (cr.unmappedCriteria.length > 0) {
          console.log(`   Unmapped criteria: ${cr.unmappedCriteria.length}`);
        }
      } else {
        console.log(
          `✓ Coverage: all ${parsedTask.filesToModify.length} files and ${parsedTask.successCriteria.length} criteria mapped\n`,
        );
      }
      if (cr.duplicatedFiles.length > 0) {
        console.log(
          `⚠  Duplicated files (owned by multiple children): ${cr.duplicatedFiles.join(", ")}`,
        );
      }

      // Save topology for next step
      const topologyFile = path.join(taskDir, `.${taskId}-topology.json`);
      await fs.writeFile(topologyFile, JSON.stringify(topology, null, 2), "utf-8");

      console.log(`\n✓ Plan mode complete — no files written`);
      console.log(`  Topology saved to: ${topologyFile}`);
      console.log(`\nNext steps:`);
      console.log(
        `  Run with --mode materialize --plan-file ${topologyFile} to generate child drafts`,
      );
      console.log("");

      process.exit(0);
    }

    // ── MODE: materialize ───────────────────────────────────────────────────
    if (mode === "materialize") {
      let topology: DecompositionTopology;
      if (options.planFile) {
        const planJson = await fs.readFile(options.planFile, "utf-8");
        topology = JSON.parse(planJson) as DecompositionTopology;
      } else {
        console.log("No --plan-file provided — re-running plan step...");
        const blueprint = await generateBlueprint(parsedTask, adapter);
        topology = await decomposeTask(parsedTask, adapter, blueprint, {
          maxSubtasks: options.maxSubtasks,
        });
      }

      console.log("Generating implementation blueprint...");
      const blueprint = await generateBlueprint(parsedTask, adapter);
      console.log(`  ✓ Analyzed ${blueprint.fileAnalyses.length} files\n`);

      console.log("Materializing rich child drafts...");
      const drafts = await materializeChildDrafts(topology, parsedTask, adapter, blueprint);

      console.log(`\n✓ Generated ${drafts.length} child draft(s):\n`);
      for (const draft of drafts) {
        const gateIcon = draft.prepReady ? "✓" : "✗";
        console.log(`  ${gateIcon} ${draft.subtaskId}: ${draft.title} (prep ${draft.prepScore})`);
        if (draft.deficiencies.length > 0) {
          for (const d of draft.deficiencies.slice(0, 3)) {
            console.log(`      - ${d}`);
          }
        }
      }

      const allReady = drafts.every((d) => d.prepReady);
      if (!allReady) {
        console.log(
          `\n⚠  Some drafts did not pass quality gates. Fix deficiencies before finalizing.`,
        );
      } else {
        console.log(`\n✓ All child drafts passed quality gates`);
      }

      // Save drafts for finalize step
      const draftsFile = path.join(taskDir, `.${taskId}-drafts.json`);
      await fs.writeFile(draftsFile, JSON.stringify(drafts, null, 2), "utf-8");
      const topologyOut = path.join(taskDir, `.${taskId}-topology.json`);
      await fs.writeFile(topologyOut, JSON.stringify(topology, null, 2), "utf-8");

      console.log(`\n✓ Materialize mode complete — no files written`);
      console.log(`  Drafts saved to: ${draftsFile}`);
      console.log(`\nNext steps:`);
      console.log(`  Review the drafts, then run:`);
      console.log(
        `  --mode finalize --drafts-file ${draftsFile} --plan-file ${topologyOut} --review-acknowledged`,
      );
      console.log("");

      process.exit(0);
    }

    // ── MODE: finalize ──────────────────────────────────────────────────────
    if (mode === "finalize") {
      if (!options.reviewAcknowledged) {
        console.error(
          `\n❌ Finalize requires --review-acknowledged flag.\n` +
            `   Review child drafts (--mode materialize) and run again with --review-acknowledged\n`,
        );
        process.exit(1);
      }

      // Gate: parent readiness — check prep cache for parent score
      const { PrepCache } = await import("../monitor/prep-cache.js");
      const prepCache = new PrepCache(adapter.projectRoot);
      const parentPrep = await prepCache.read(taskId, filePath);
      const parentThreshold = adapter.config.preflight?.autoDecompose?.parentPrepThreshold ?? 4.0;
      if (!parentPrep) {
        console.error(
          `\n❌ Parent task ${taskId} has no prep result.\n` +
            `   Run 'quack prep ${taskId}' before finalizing decomposition.\n`,
        );
        process.exit(1);
      }
      if (parentPrep.depthScore < parentThreshold || !parentPrep.depthReady) {
        console.error(
          `\n❌ Parent task ${taskId} prep score ${parentPrep.depthScore} is below threshold ${parentThreshold}.\n` +
            `   Enrich or repair the parent task before decomposing.\n`,
        );
        if (parentPrep.deficiencies.length > 0) {
          console.error(`   Deficiencies:`);
          for (const d of parentPrep.deficiencies.slice(0, 5)) {
            console.error(`     - ${d}`);
          }
        }
        console.error("");
        process.exit(1);
      }

      if (!options.draftsFile) {
        console.error(
          `\n❌ Finalize requires --drafts-file pointing to materialized drafts.\n` +
            `   Run --mode materialize first to generate the drafts file.\n`,
        );
        process.exit(1);
      }

      const draftsJson = await fs.readFile(options.draftsFile, "utf-8");
      const drafts = JSON.parse(draftsJson) as ChildDraft[];

      let topology: DecompositionTopology | undefined;
      if (options.planFile) {
        const planJson = await fs.readFile(options.planFile, "utf-8");
        topology = JSON.parse(planJson) as DecompositionTopology;
      }

      // Gate: check quality
      const failedDrafts = drafts.filter((d) => d.parseError || !d.prepReady);
      if (failedDrafts.length > 0) {
        console.error(`\n❌ ${failedDrafts.length} draft(s) failed quality gates:\n`);
        for (const d of failedDrafts) {
          console.error(`   ${d.subtaskId}: prep ${d.prepScore} (threshold ${PREP_THRESHOLD})`);
          for (const deficiency of d.deficiencies.slice(0, 3)) {
            console.error(`      - ${deficiency}`);
          }
        }
        console.error(`\n   Fix deficiencies and re-run --mode materialize before finalizing.\n`);
        process.exit(1);
      }

      // Gate: coverage
      if (topology?.coverageReport?.hasCoverageGap) {
        const cr = topology.coverageReport;
        console.error(`\n❌ Coverage gap — cannot finalize:\n`);
        if (cr.unmappedFiles.length > 0) {
          console.error(`   Unmapped files: ${cr.unmappedFiles.join(", ")}`);
        }
        if (cr.unmappedCriteria.length > 0) {
          console.error(`   Unmapped criteria: ${cr.unmappedCriteria.join("; ")}`);
        }
        console.error("");
        process.exit(1);
      }

      const claimants = await listDuplicateClaimants(taskDir, taskId);
      if (claimants.length > 0) {
        console.error(formatDuplicateClaimantsMessage(taskId, claimants));
        process.exit(1);
        return;
      }
      console.log("Writing child task spec files...");
      const writtenPaths = await writeSubtaskSpecs(drafts, adapter);

      console.log(`\n✓ Created ${writtenPaths.length} subtask spec file(s):\n`);
      for (const fp of writtenPaths) {
        console.log(`  - ${path.basename(fp)}`);
      }

      // Rewrite parent as tracker.
      // TASK-1334: the file resolved at entry, not a second lookup. This is
      // the destructive half of decompose, and it must rewrite the SAME file
      // the drafts were derived from. Round 2 (R2-1): and the same CONTENT,
      // carried from that resolution rather than re-read at write time.
      const taskFilePath = filePath;
      const parentContent = content;
      const childIds = drafts.map((d) => d.subtaskId);
      const tableRows = drafts
        .map((d) => {
          const deps = topology?.subtasks?.find((s) => s.id === d.subtaskId)?.dependsOn ?? [];
          return `| \`${d.subtaskId}\` | ${d.title} | ${deps.length > 0 ? deps.join(", ") : "—"} | prep ${d.prepScore} |`;
        })
        .join("\n");

      const decompositionSummary =
        `\n\n## Decomposition Summary\n\n` +
        `This task has been decomposed into ${childIds.length} child task(s). ` +
        `It is now a tracker task and should not be dispatched directly while the child chain is active.\n\n` +
        `| Child | Scope | Depends On | Ready Gate |\n` +
        `|-------|-------|------------|------------|\n` +
        tableRows;

      let updatedParent = parentContent
        .replace(/(\*\*Status:\*\*\s*)\S+/, "$1DECOMPOSED")
        .replace(/(\*\*Blocks:\*\*\s*)\[.*?\]/, `$1[${childIds.join(", ")}]`);

      if (!updatedParent.includes("## Decomposition Summary")) {
        updatedParent += decompositionSummary;
      }

      if (updatedParent !== parentContent) {
        await fs.writeFile(taskFilePath, updatedParent, "utf-8");
        console.log(`✓ Parent task ${taskId} rewritten as decomposition tracker`);
      }

      if (options.enqueue) {
        console.log("\nEnqueuing subtasks in dispatch queue...");
        try {
          const port = options.port ?? 3333;
          const resp = await fetch(`http://localhost:${port}/api/queue/enqueue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskIds: childIds,
              parentTaskId: taskId,
              sharedBranchName: `quack/${taskId}`,
            }),
          });
          if (resp.ok) {
            console.log(`  ✓ Enqueued ${childIds.length} subtask(s) in dispatch queue`);
          } else {
            const respBody = await resp.text();
            console.log(`  ⚠ Failed to enqueue: ${respBody}`);
          }
        } catch {
          console.log("  ⚠ Could not connect to monitor server");
          console.log("    Start the monitor first: quack monitor --project .");
        }
      }

      console.log(`\nNext steps:`);
      console.log(`  1. Review the generated child spec files in ${taskDir}`);
      console.log(`  2. Run 'quack queue enqueue ${childIds.join(" ")}' to queue them`);
      console.log(`  3. Or dispatch each subtask individually with 'quack run <subtask-id>'`);
      console.log("");

      process.exit(0);
    }
  } catch (err) {
    console.error(
      `\n❌ Decomposition failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
