import type { ParsedTask } from "../core/types.js";
import type { TemplateRegistry, TemplateMatch } from "./template-types.js";
import { categorizeTask } from "./task-categorizer.js";

/**
 * Finds the best-matching template for a given task.
 *
 * Scoring heuristics:
 * - Same category: +0.3
 * - Overlapping tags: +0.1 per shared tag
 * - Overlapping file patterns: +0.2 per shared file pattern
 * - Similar complexity (file count within 2): +0.1
 * - High success rate template preferred: +0.1 if > 80%
 *
 * @param task - The task to find a template for
 * @param registry - The template registry to search
 * @returns The best matching template, or null if no match above threshold (0.3)
 */
export function findBestTemplate(
  task: ParsedTask,
  registry: TemplateRegistry,
): TemplateMatch | null {
  const taskCategory = categorizeTask(task);
  const taskTags = new Set(task.tags);
  const taskFilePatterns = new Set(extractFilePatterns(task.filesToModify.map((f) => f.path)));
  const taskComplexity = task.filesToModify.length;

  let bestMatch: TemplateMatch | null = null;
  let bestScore = 0;

  for (const template of registry.templates) {
    const matchReasons: string[] = [];
    let score = 0;

    // Same category: +0.3
    if (template.category === taskCategory) {
      score += 0.3;
      matchReasons.push("same category");
    }

    // Overlapping tags: +0.1 per tag
    const templateTags = new Set(template.tags);
    const sharedTags = [...taskTags].filter((t) => templateTags.has(t));
    if (sharedTags.length > 0) {
      score += sharedTags.length * 0.1;
      matchReasons.push(`${sharedTags.length} shared tags`);
    }

    // Overlapping file patterns: +0.2 per pattern
    const templateFilePatterns = new Set(template.filePatterns);
    const sharedPatterns = [...taskFilePatterns].filter((p) => templateFilePatterns.has(p));
    if (sharedPatterns.length > 0) {
      score += sharedPatterns.length * 0.2;
      matchReasons.push(`${sharedPatterns.length} shared file patterns`);
    }

    // Similar complexity (within 2 files): +0.1
    const templateFileCount = template.fileCount ?? template.filePatterns.length;
    const complexityDiff = Math.abs(templateFileCount - taskComplexity);
    if (complexityDiff <= 2) {
      score += 0.1;
      matchReasons.push("similar complexity");
    }

    // High success rate preferred: +0.1 if > 80%
    if (template.successRate > 0.8) {
      score += 0.1;
      matchReasons.push("high success rate");
    }

    // Update best match if this score is higher
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        template,
        score,
        matchReasons,
      };
    }
  }

  // Return null if best score doesn't meet threshold
  return bestMatch && bestScore > 0.3 ? bestMatch : null;
}

/**
 * Extracts directory patterns from file paths.
 * Example: ["src/templates/foo.ts", "src/templates/bar.ts"] -> ["src/templates"]
 */
function extractFilePatterns(filePaths: string[]): string[] {
  const dirSet = new Set<string>();

  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");

    // Extract top 2 levels (e.g., "src/templates")
    if (parts.length >= 2) {
      dirSet.add(`${parts[0]}/${parts[1]}`);
    } else if (parts.length === 1) {
      dirSet.add(parts[0]);
    }
  }

  return Array.from(dirSet).sort();
}
