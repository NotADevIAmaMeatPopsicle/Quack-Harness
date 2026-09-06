import * as path from "node:path";
import { loadAdapter } from "../core/adapter-loader.js";
import { buildRegistry, loadRegistry, saveRegistry } from "../templates/template-registry.js";
import { findBestTemplate } from "../templates/template-matcher.js";
import { parseTaskFile } from "../core/task-parser.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";

export interface TemplatesCommandOptions {
  rebuild?: boolean;
  list?: boolean;
  match?: string;
  project?: string;
}

/**
 * CLI handler for template management commands.
 *
 * Commands:
 * - --rebuild: Rebuild template registry from all completed tasks
 * - --list: List templates grouped by category
 * - --match <taskId>: Find best matching template for a task
 */
export async function templatesCommand(options: TemplatesCommandOptions): Promise<void> {
  try {
    const projectRoot = options.project ? path.resolve(options.project) : process.cwd();
    const adapter = await loadAdapter(projectRoot);

    if (options.rebuild) {
      await handleRebuild(adapter.projectRoot, adapter.config.project.taskDir);
    } else if (options.list) {
      await handleList(adapter.projectRoot);
    } else if (options.match) {
      await handleMatch(options.match, adapter.projectRoot, adapter.config.project.taskDir);
    } else {
      console.error("Error: Must specify one of --rebuild, --list, or --match <taskId>");
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function handleRebuild(projectRoot: string, taskDir: string): Promise<void> {
  console.log("[REBUILD] Building template registry from all completed tasks...");

  const registry = await buildRegistry(projectRoot, taskDir);

  await saveRegistry(registry, projectRoot, undefined, taskDir);

  console.log(`[REBUILD] ✓ Registry built with ${registry.templates.length} templates`);
  console.log(`[REBUILD] Saved to: .quack/templates/task-templates.json`);
  console.log(`[REBUILD] Updated at: ${registry.updatedAt}`);
}

async function handleList(projectRoot: string): Promise<void> {
  const registry = await loadRegistry(projectRoot);

  if (registry.templates.length === 0) {
    console.log("[LIST] No templates found. Run --rebuild to generate the registry.");
    return;
  }

  console.log(`[LIST] Template Registry (${registry.templates.length} templates)`);
  console.log(`[LIST] Last updated: ${registry.updatedAt}\n`);

  // Group templates by category
  const categories = Object.keys(registry.categoryStats).sort();

  for (const category of categories) {
    const stats = registry.categoryStats[category as keyof typeof registry.categoryStats];
    if (stats.count === 0) continue;

    console.log(`\n## ${category} (${stats.count} templates)`);
    console.log(`   Avg success rate: ${(stats.avgSuccessRate * 100).toFixed(0)}%`);
    console.log(`   Avg cost: $${stats.avgCostUsd.toFixed(2)}`);

    const categoryTemplates = registry.templates.filter((t) => t.category === category);
    for (const template of categoryTemplates) {
      console.log(
        `   - ${template.sourceTaskId} (${(template.successRate * 100).toFixed(0)}% success, $${template.avgCostUsd.toFixed(2)})`,
      );
      console.log(`     Tags: ${template.tags.join(", ")}`);
      console.log(`     Files: ${template.filePatterns.join(", ")}`);
    }
  }
}

async function handleMatch(taskId: string, projectRoot: string, taskDir: string): Promise<void> {
  const registry = await loadRegistry(projectRoot);

  if (registry.templates.length === 0) {
    console.log("[MATCH] No templates found. Run --rebuild to generate the registry.");
    return;
  }

  // Load the task
  const absoluteTaskDir = path.join(projectRoot, taskDir);
  const resolved = await resolveTaskFile(absoluteTaskDir, taskId);
  if (!resolved) {
    throw new Error(`Task file not found for ${taskId}`);
  }
  const task = resolved.task ?? parseTaskFile(resolved.content, resolved.filePath);

  // Find best match
  const match = findBestTemplate(task, registry);

  if (!match) {
    console.log(`[MATCH] No matching template found for ${taskId} (threshold: 0.3)`);
    return;
  }

  console.log(`[MATCH] Best match for ${taskId}:`);
  console.log(`   Template: ${match.template.sourceTaskId}`);
  console.log(`   Category: ${match.template.category}`);
  console.log(`   Match score: ${match.score.toFixed(2)}`);
  console.log(`   Success rate: ${(match.template.successRate * 100).toFixed(0)}%`);
  console.log(`   Avg cost: $${match.template.avgCostUsd.toFixed(2)}`);
  console.log(`   Match reasons:`);
  for (const reason of match.matchReasons) {
    console.log(`     - ${reason}`);
  }
  console.log(`   File patterns: ${match.template.filePatterns.join(", ")}`);
  console.log(`   Tags: ${match.template.tags.join(", ")}`);
}
