import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ProjectAdapter } from "../core/adapter-loader.js";
import { listTaskClaimantDeclarations } from "../core/task-file-resolver.js";

/**
 * Builds the planner prompt for the task generation agent.
 * This prompt instructs a read-only agent session to research the project
 * and generate well-structured TASK-NNN.md files from a raw prompt.
 *
 * @param rawPrompt - Raw user prompt describing the feature/task to implement
 * @param adapter - The project adapter with config and conventions
 * @param maxTasks - Maximum number of tasks to generate (default: 10)
 * @param startId - Starting task number (auto-detected if not provided)
 * @returns The fully interpolated planner prompt string
 */
export async function buildPlannerPrompt(
  rawPrompt: string,
  adapter: ProjectAdapter,
  maxTasks?: number,
  startId?: number,
): Promise<string> {
  const maxTasksLimit = maxTasks ?? 10;
  const nextTaskId = startId ?? (await detectNextTaskId(adapter));

  // Load an example task file to show the format
  const exampleTask = await loadExampleTask(adapter);

  return `You are a task planning agent for Quack, a codebase-agnostic background coding agent system.
Your job is to take a raw user prompt and generate one or more well-structured TASK-NNN.md files
that can pass through Quack's readiness gate without enrichment.

## User Prompt
${rawPrompt}

## Your Task
1. **Research the project** — Use Read, Glob, and Grep to explore:
   - ADRs and architecture documents (search for ADR-*, ARCHITECTURE.md, docs/)
   - Product specs and feature documentation
   - Existing task files (to understand format, numbering, dependency chains)
   - Convention files from the project's conventions directory
   - Existing source code structure (directory layout, key interfaces, patterns)
   - CLAUDE.md and README.md for project context
   - adapter.json for verification commands, sandbox rules, test patterns

2. **Decompose the prompt** into 1-${maxTasksLimit} discrete, well-scoped work units:
   - Each task should be completable in a single agent session (< 75 turns, < $5)
   - Tasks should modify no more than ~10 files each
   - Database/schema changes go in their own task (blocking downstream work)
   - API endpoints and their tests can be one task per resource
   - Frontend features should be separate from backend
   - Each task must have at least one verifiable acceptance test

   **Runtime Validation Rules (all platforms):**
   - Unit tests verify logic; functional tests verify the built output works in the target runtime
   - Early tasks should establish functional test infrastructure before feature work begins
   - Each user-facing task should include at least one functional test requirement
   - Common bugs unit tests miss:
     - Browser: import resolution (.js extensions), canvas rendering, DOM events, CSS layout, missing polyfills
     - Android: Activity lifecycle, permissions, sensor APIs, screen density
     - Desktop (Electron/Tauri): IPC (main↔renderer), native OS integration, window management
     - React Native: native bridge, platform-specific rendering, deep linking
   - For device-dependent tests (Android emulator, iOS simulator), document the test procedure but don't require them to pass in automated verification

3. **Generate TASK-NNN.md files** — Start numbering from TASK-${String(nextTaskId).padStart(3, "0")}:
   - Include ALL 7 required fields: title, priority, effort, status, problemStatement, successCriteria (min 1), testingRequirements (min 1)
   - Include recommended fields: currentState, recommendedApproach, filesToModify table
   - Set proper dependency chains between generated tasks (blockedBy/blocks)
   - Reference specific ADRs, conventions, and existing code patterns discovered during research
   - Make success criteria testable and specific
   - Tie testing requirements to the project's verification commands
   - Ensure filesToModify entries respect the project's sandbox writable paths

4. **Validate each spec** before outputting:
   - All 7 required fields present and non-empty
   - At least one success criterion
   - At least one testing requirement
   - Dependency chains reference only valid task IDs (existing or newly generated)
   - filesToModify paths are within sandbox writable paths

## Project Configuration
**Name:** ${adapter.config.project.name}
**Task Directory:** ${adapter.config.project.taskDir}
**Conventions Directory:** ${adapter.config.project.conventionsDir}
**Writable Paths:** ${adapter.config.sandbox.writablePaths.join(", ")}
**Verification Commands:** ${adapter.config.verification.commands.map((c) => c.name).join(", ")}
**Test Patterns:** ${adapter.config.project.testPatterns ? `${adapter.config.project.testPatterns.testDir} (suffixes: ${adapter.config.project.testPatterns.suffixes.join(", ")})` : "default (tests/ directory)"}

## Project Conventions
${adapter.conventionsDoc}

## Task File Format (Example)
${exampleTask}

## Output Format
For each generated task, output the complete TASK-NNN.md content in a markdown code block:

\`\`\`markdown
# TASK-${String(nextTaskId).padStart(3, "0")}: Title Here

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4-6 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** tag1, tag2
- **Conventions:** []

## Problem Statement
[Detailed description of the problem this task solves]

## Current State
[What exists now, discovered during your research]

## Recommended Approach
[Specific implementation approach, referencing patterns you found]

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| path/to/file.ts | Create | Description |

## Success Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Testing Requirements
- [ ] Requirement 1
- [ ] Requirement 2

## Context References
- Relevant file or ADR discovered during research
\`\`\`

Generate up to ${maxTasksLimit} tasks. Be thorough in your research before generating specs.`;
}

/**
 * Detect the next available task ID by scanning existing task files.
 */
async function detectNextTaskId(adapter: ProjectAdapter): Promise<number> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

  try {
    const declarations = await listTaskClaimantDeclarations(taskDir);
    const taskNumbers = declarations
      .map(({ declaredId }) => {
        const match = declaredId.match(/^TASK-(\d+)(?:-[A-Z])?$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((num) => Number.isFinite(num) && num > 0);

    if (taskNumbers.length === 0) {
      return 1;
    }

    return Math.max(...taskNumbers) + 1;
  } catch {
    // If taskDir doesn't exist, start from 1
    return 1;
  }
}

/**
 * Load an example task file to show the planner the expected format.
 * Prefers a completed task as the example.
 */
async function loadExampleTask(adapter: ProjectAdapter): Promise<string> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

  try {
    const entries = await fs.readdir(taskDir);
    const taskFiles = entries.filter((entry) => entry.startsWith("TASK-") && entry.endsWith(".md"));

    if (taskFiles.length === 0) {
      return "[No example tasks found in the project]";
    }

    // Try to find a completed task
    for (const file of taskFiles) {
      const content = await fs.readFile(path.join(taskDir, file), "utf-8");
      if (content.includes("**Status:** COMPLETE")) {
        return content;
      }
    }

    // Fall back to the first task file
    const firstTaskFile = taskFiles[0];
    return await fs.readFile(path.join(taskDir, firstTaskFile), "utf-8");
  } catch {
    return "[Could not load example task]";
  }
}
