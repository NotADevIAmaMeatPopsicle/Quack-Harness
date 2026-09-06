// ─── Decomposition Prompt Builder ──────────────────────────────────
// Builds the prompt for the LLM-based task topology planning agent.
// Purpose is narrowed to file ownership and dependency ordering ONLY —
// prose authoring happens in subtask-materializer.ts.

import type { ParsedTask } from "../core/types.js";
import type { Blueprint } from "../blueprint/blueprint-types.js";
import { formatBlueprintForPrompt } from "../blueprint/blueprint-prompt.js";

/**
 * Build the topology planning prompt for the decompose agent.
 * Asks the LLM to assign file ownership and dependency order ONLY.
 * Does NOT ask for prose descriptions, problem statements, or testing
 * scenarios — those are authored by subtask-materializer.ts.
 *
 * @param task - The parent task to plan a topology for
 * @param blueprint - Blueprint with file analyses and integration points
 * @returns Complete prompt string for the topology agent
 */
export function buildDecomposePrompt(task: ParsedTask, blueprint: Blueprint): string {
  const blueprintSection = formatBlueprintForPrompt(blueprint);

  return `# Task Topology Planning Request

You are a topology planning agent. Your ONLY job is to plan FILE OWNERSHIP and DEPENDENCY ORDER for the child subtasks of a parent task. Do NOT write prose descriptions, problem statements, or testing scenarios — those will be written separately.

## Parent Task: ${task.id}

**Title:** ${task.title}

**Files to Own (${task.filesToModify.length} files):**
${task.filesToModify.map((f) => `- ${f.action}: ${f.path}${f.notes ? ` — ${f.notes}` : ""}`).join("\n")}

**Success Criteria to Map (${task.successCriteria.length} criteria):**
${task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Blueprint Analysis

${blueprintSection}

## Topology Rules

1. **Create 2-4 subtasks maximum.** Each parent file must be owned by EXACTLY ONE child.
2. **Each parent success criterion must be mapped to AT LEAST ONE child owner.**
3. **Order children by dependency:** standalone first, integration last.
4. **The final child** (isFinal: true) may carry "All parent task success criteria verified" as an extra criterion.
5. **File ownership** — use the blueprint's integration points to decide which files belong together.
6. **dependsOn** — reference sibling subtask IDs only (not the parent task ID).

## Required Output Format

\`\`\`json
{
  "subtasks": [
    {
      "id": "${task.id}-A",
      "title": "Short scope title (3-8 words)",
      "filesToModify": [{"path": "src/example.ts", "action": "Create", "notes": "brief note"}],
      "successCriteria": ["exact criterion text from parent"],
      "dependsOn": [],
      "isFinal": false
    }
  ]
}
\`\`\`

**IMPORTANT:**
- Subtask IDs MUST follow the pattern ${task.id}-A, ${task.id}-B, ${task.id}-C
- The last subtask must have isFinal: true
- File paths must exactly match those from the parent task
- Success criteria text must come from the parent task
- ONLY output the JSON — no prose, no approach sections, no testing scenarios

Now analyze the task and blueprint above, and output the topology JSON.
`;
}
