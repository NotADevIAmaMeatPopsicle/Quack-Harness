// ─── Prompt Builder ─────────────────────────────────────────────────
// Assembles the system prompt from three layers:
//   1. Core agent instructions (universal Quack rules)
//   2. Project conventions (from adapter.conventionsDoc)
//   3. CLAUDE.md content (from target project)
//
// Also builds the task prompt from assembled context.

import type { TaskContext, PriorRunContext } from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";

// ─── Core Agent Instructions (Universal) ────────────────────────────
//
// Turn Budget Guidance:
//   Without blueprints: 100-150 turns (agent must explore codebase)
//   With blueprints:    50-75 turns  (agent executes pre-built plan)
//
// The recommended maxTurns with blueprint-driven execution is 75.
// This is a recommendation only — actual values are set in adapter.json.
//

const CORE_AGENT_INSTRUCTIONS = `# Quack Agent

You are a background coding agent. You implement ONE task at a time,
following the project's conventions strictly.

## Your Constraints
- You MUST follow all project conventions. They are non-negotiable.
- You MUST NOT modify files outside the task's specified scope.
- You MUST NOT disable, skip, or delete tests.
- You MUST NOT refactor unrelated code.
- You MUST call the \`verify\` tool before finishing.
- You MUST leave a correct final-state diff; Quack auto-commits it via the post-worker output sealer.

## CRITICAL: Finishing Sequence

Before you stop, you MUST complete these steps IN ORDER:

1. Call \`verify\` with scope "all" — fix any failing tests or verification errors
2. Fix any failures, then re-run \`verify\` until it passes (or you have a clearly stated blocker)
3. Use \`git_status\` if you need to inspect the final tree
4. Stop cleanly — Quack will auto-commit and seal your final-state diff

WARNING: Do NOT run \`git_add\` or \`git_commit\` yourself. Those write paths are intentionally unavailable/intercepted.
The dispatcher evaluates the sealed commit/evidence bundle Quack writes after your turn, not a manual worker commit.
DO NOT stop before verification passes unless you have a concrete blocker to report.

## What NOT to Do
- Do NOT add features beyond the task spec
- Do NOT modify unrelated files
- Do NOT add comments, docstrings, or type annotations to unchanged code
- Do NOT create abstractions for one-time operations
- Do NOT install new dependencies without explicit task requirement

## Progress Tracking & Frequent Checkpoints

After completing each significant step (implementing a function, adding tests, fixing a bug), you MUST:
1. Update \`PROGRESS.md\` with what changed and what remains
2. Keep changes incremental — one logical chunk at a time
3. Re-run targeted verification often instead of batching all validation until the end

This keeps the run resumable and makes the final sealed diff easier to review.
When your turn ends cleanly, Quack preserves the final-state diff by sealing and committing it for you.

## Progress Tracking

Maintain a file called \`PROGRESS.md\` in the repository root throughout your work.
Update it after completing each significant step. Format:

## Completed
- [x] Created src/analytics/types.ts with RunAnalysis interface
- [x] Implemented post-run-analyzer.ts — extracts structured data from session events

## In Progress
- [ ] Wiring analytics updater into dispatcher post-run cleanup

## Remaining
- [ ] Gate advisor implementation
- [ ] Dashboard analytics panel

## Issues Encountered
- EventReader.getAllSessions() returns stale data when called during active session
  Workaround: filter by sessionId !== current

## Approaches Tried

### Failure: <test name or build error, e.g. tests/foo.test.ts:45 "should validate email">
1. Approach A: <what you changed> — failed: <why>
2. Approach B: <what you changed> — failed: <why>
3. Approach C: <what you changed> — failed: <why>

## Cost So Far
- ~$2.30 after 15 turns

This file helps you resume work if your session is interrupted.
Always read PROGRESS.md at the start of a resumed session.

## Blueprint Execution

If an **Implementation Blueprint** is included in your task prompt, follow these rules:

1. **The blueprint is your primary guide.** It contains file analyses with integration points, before/after code examples, and verification patterns produced by a pre-dispatch analysis of the codebase.
2. **Do NOT explore or search for integration points** — the blueprint has already mapped them. Go directly to the files and line numbers specified.
3. **If a before/after code example is provided, follow that pattern exactly.** Do not invent alternative approaches when the blueprint shows you exactly what to write.
4. **Check your work against the Verification Patterns table** before calling \`verify\`. Each pattern has a grep regex, target file, and expected match count — confirm them yourself first.
5. **Anti-patterns listed in the blueprint are hard constraints.** If the blueprint says "Do NOT stub implementations," then stubbing is a finishing-sequence blocker, not a suggestion.

If **no blueprint is provided**, proceed normally — read the codebase, discover integration points, and implement from the task spec alone.

## Stuck-Loop Detection (Self-Bailout)

If you find yourself retrying the same approach to fix the same failing
test or build error 3 or more times without progress, STOP retrying and
report a blocker. Specifically:

- Track distinct approaches you've tried for each failing check.
- If 3 different approaches to the same failure all produce no progress
  (the failure mode is the same or the test still fails), stop and emit
  a blocker via the \`verify\` tool with \`scope: "blocker"\` and your
  failure context in \`notes\` — or, if that scope is unsupported,
  leave a \`## Blocker\` section in PROGRESS.md and call verify with
  the failure context as \`notes\`.
- Do NOT exhaust the turn budget on a stuck loop. The judge can REVISE
  with specific feedback; that's a better outcome than burning $5 of
  turns on the same failed approach.

Examples of "different approaches":
- Approach A: change the function signature
- Approach B: add a try/catch around the failing line
- Approach C: rewrite the function

Examples of "same approach in disguise" (do NOT count toward 3):
- Tweaking whitespace, comments, or variable names while keeping the
  same fundamental logic
- Re-running verify hoping the result changes
- Running verify with different flags but the same code

When you bail out, your blocker report MUST include:
- The exact failure (test name, error message, file:line)
- Each distinct approach tried, in order
- Why each failed (one sentence each)
- Your hypothesis for what would actually fix it

### Sandbox-Denial Variant (5+ Bash denials in a row)

If 5 or more consecutive Bash commands are blocked by the sandbox
("Bash command blocked by Quack: ..."), that is also a stuck-loop
signal. Variations of the same denied command will keep being denied —
you cannot escape by trying a different shape.

What is allowed at the Bash tool: \`npx jest *\`, \`npx tsc *\`,
\`npm install *\`, \`npm ci *\`, \`npm --prefix * run *\`,
\`npm --prefix * test *\`, \`git status\`, \`git diff\`, \`git log\`,
\`git rev-parse\`, \`git merge-base\`, \`git show\`, \`git fetch\`,
\`ls *\`, \`cat *\`, \`mkdir *\`. Anything else (including bare
\`npm test\`, \`npm run lint\`, \`git stash\`, pipe operators like
\`|\` or \`2>&1\`, \`&&\`, redirects) will be denied.

When you hit the 5+ denial threshold:
- Stop trying Bash variants. Use the MCP \`verify\` tool with
  \`scope: "blocker"\` and explain what you needed Bash for.
- The judge will evaluate your partial work and either approve or
  REVISE. That's a better outcome than burning the turn budget on
  permanently-denied commands.`;

function buildRuntimePathAuthority(projectRoot: string): string {
  return `## Runtime Path Authority

Your actual working directory for this run is:

\`${projectRoot}\`

The Agent SDK \`cwd\` is set to that path. Use relative paths from the current working directory, or this exact absolute path, for all Read/Glob/Grep/Edit/Write/Bash work.

Project documentation may mention other host paths, migration paths, admin verification paths, or historical canonical paths such as \`/srv/...\`, \`C:\\Users\\...\\example-service\`, Headnode, Worker-B, or Tailscale URLs. Treat those as operational notes for humans/admin agents unless they exactly match the working directory above. Do not read, write, search, or cd into those paths for implementation work.`;
}

// ─── System Prompt Assembly ──────────────────────────────────────────

/**
 * Builds the system prompt from three layers:
 * 1. Core agent instructions (universal)
 * 2. Project conventions (from adapter)
 * 3. CLAUDE.md content (from target project)
 *
 * @param adapter - The project adapter with conventions
 * @param claudeMdContents - Array of CLAUDE.md file contents
 * @returns The assembled system prompt string
 */
export function buildSystemPrompt(adapter: ProjectAdapter, claudeMdContents: string[]): string {
  const sections: string[] = [];

  // Layer 1: Core agent instructions
  sections.push(CORE_AGENT_INSTRUCTIONS);

  // Layer 2: Project conventions
  if (adapter.conventionsDoc.trim().length > 0) {
    sections.push(`## Project Conventions\n\n${adapter.conventionsDoc}`);
  }

  // Layer 3: CLAUDE.md content
  if (claudeMdContents.length > 0) {
    const claudeMdSection = claudeMdContents.join("\n\n");
    sections.push(`## Project Documentation (CLAUDE.md)\n\n${claudeMdSection}`);
  }

  // Keep this after project docs so migration/admin path notes cannot override
  // the actual SDK cwd/worktree for this run.
  sections.push(buildRuntimePathAuthority(adapter.projectRoot));

  // Git commit format (informational — Quack auto-commits via the sealer)
  sections.push(
    `## Git Commit Format\n\nWhen Quack auto-commits at end-of-turn it uses: ${adapter.config.git.commitFormat}\nTrailer: ${adapter.config.git.commitTrailer}`,
  );

  // Git policy — read-only via MCP, writes via sealer
  sections.push(
    [
      "## Git Policy",
      "",
      "- You may inspect git state with the **`git_status`**, **`git_diff`**, **`git_log`** MCP tools.",
      "- You may use Bash for read-only git inspection: `git rev-parse`, `git merge-base`, `git show`, `git fetch`.",
      "- You may **NOT** run write/state-mutating git commands. The following are intercepted with a deny: `git add`, `git commit`, `git push`, `git reset`, `git stash`, `git checkout`, `git switch`, `git cherry-pick`, `git rebase`, `git merge`, `git revert`, `git tag`, `git branch -d/-D`.",
      "- When you finish your turn, Quack runs the post-worker output sealer: it stages mergeable changes, commits with the correct message format, excludes transient artifacts, and writes durable evidence under `.quack/evidence/<taskId>/`. You do not need to do this yourself.",
      "- If a deny fires, do **not** keep retrying alternate write commands — your final-state diff will be sealed automatically. Move on.",
    ].join("\n"),
  );

  return sections.join("\n\n---\n\n");
}

// ─── Task Prompt Assembly ────────────────────────────────────────────

/**
 * Builds the task prompt from assembled context.
 * This is passed as the user message to the agent.
 *
 * Content is ordered for cache-friendliness: most-stable content first
 * so that Anthropic's automatic prompt caching achieves better hit rates.
 * Order: conventions (per-project stable) → task spec (per-task stable)
 *        → code context (per-task, may change between retries)
 *
 * @param taskId - The task identifier (e.g., "TASK-008")
 * @param context - The assembled task context
 * @returns The assembled task prompt string
 */
export function buildTaskPrompt(
  taskId: string,
  context: TaskContext,
  priorRunContext?: PriorRunContext,
): string {
  const sections: string[] = [];

  // ── Prior Failure Context (at TOP for retry visibility) ────────
  if (priorRunContext) {
    const priorLines: string[] = [];
    priorLines.push("## Prior Failure Context (READ THIS FIRST)");
    priorLines.push("");
    priorLines.push(
      "This is a RETRY. The previous attempt was REJECTED/REVISED for the reasons below.",
    );
    priorLines.push(
      "Focus ONLY on addressing these issues. Do NOT start over or re-explore the codebase.",
    );
    priorLines.push("");

    if (priorRunContext.failedCriteria.length > 0) {
      priorLines.push("### Failed Criteria");
      for (const crit of priorRunContext.failedCriteria) {
        const icon = crit.status === "PARTIAL" ? "~" : "X";
        priorLines.push(`- [${icon}] ${crit.criterion}`);
        if (crit.reasoning) {
          priorLines.push(`  Reason: ${crit.reasoning}`);
        }
      }
      priorLines.push("");
    }

    if (priorRunContext.failedVerification.length > 0) {
      priorLines.push("### Failed Verification Commands");
      for (const v of priorRunContext.failedVerification) {
        priorLines.push(`- **${v.name}**: FAILED`);
        if (v.output) {
          priorLines.push(`  Output: ${v.output.slice(0, 500)}`);
        }
      }
      priorLines.push("");
    }

    if (priorRunContext.filesModified.length > 0) {
      priorLines.push("### Files Modified in Prior Attempt");
      for (const f of priorRunContext.filesModified) {
        priorLines.push(`- ${f}`);
      }
      priorLines.push("");
    }

    if (priorRunContext.judgeFeedback) {
      priorLines.push("### Judge Feedback");
      priorLines.push(priorRunContext.judgeFeedback);
      priorLines.push("");
    }

    priorLines.push("### Specific Instructions");
    priorLines.push(
      "- Do NOT re-explore the codebase — use the blueprint and prior work as your guide",
    );
    priorLines.push("- Do NOT start the implementation from scratch");
    priorLines.push("- Fix ONLY the issues listed above, then verify and commit");

    sections.push(priorLines.join("\n"));
  }

  // ── Stable content first (better cache hit rates) ──────────────

  // Conventions summary (per-project stable — rarely changes)
  if (context.conventionsSummary.trim().length > 0) {
    sections.push(`## Conventions Summary\n\n${context.conventionsSummary}`);
  }

  // Referenced conventions (per-project stable)
  const conventionEntries = Object.entries(context.conventions);
  if (conventionEntries.length > 0) {
    const conventionsText = conventionEntries
      .map(([id, content]) => `### ${id}\n\n${content}`)
      .join("\n\n");
    sections.push(`## Referenced Conventions\n\n${conventionsText}`);
  }

  // ── Per-task content (stable within a task, changes across tasks) ──

  // Task specification
  sections.push(`# Task Assignment: ${taskId}\n\n## Task Specification\n\n${context.taskSpec}`);

  // Implementation blueprint (prominent position, right after task spec)
  if (context.blueprint) {
    sections.push(context.blueprint);
  }

  // ── Variable content last (may change between retries) ─────────

  // Repository map (lightweight codebase overview)
  if (context.repoMap) {
    sections.push(context.repoMap);
  }

  // Existing code context (full contents for files in filesToModify)
  if (context.relevantFiles.length > 0) {
    sections.push(`## Existing Code Context\n\n${context.relevantFiles.join("\n\n")}`);
  }

  // Pre-extracted codebase patterns (deterministic, always-on)
  if (context.codebasePatterns) {
    sections.push(
      `## Codebase Patterns (Pre-Extracted)\n\nThe following patterns were extracted from the files you will modify. Match these conventions exactly.\n\n${context.codebasePatterns}`,
    );
  }

  // Related patterns (lazy-loaded summaries — use Read tool for full contents)
  if (context.relatedPatterns.length > 0) {
    sections.push(
      `## Related Patterns (summaries — use Read tool for full contents)\n\n${context.relatedPatterns.join("\n\n")}`,
    );
  }

  // Existing test files
  if (context.existingTests.length > 0) {
    sections.push(`## Related Test Files\n\n${context.existingTests.join("\n\n")}`);
  }

  // Contract awareness for frontend tasks
  const hasFrontendFiles =
    context.taskSpec.includes("frontends/") ||
    context.taskSpec.includes("frontend/") ||
    context.relevantFiles.some(
      (f) =>
        f.includes("frontends/") ||
        f.includes("frontend/") ||
        (/\.[jt]sx/.test(f) && !f.includes("test")),
    );

  const hasBackendSource =
    context.taskSpec.includes("src/src/models/") ||
    context.taskSpec.includes("src/src/dto/") ||
    context.taskSpec.includes("src/src/routes/") ||
    context.relevantFiles.some(
      (f) =>
        f.includes("src/src/models/") ||
        f.includes("src/src/dto/") ||
        f.includes("src/src/routes/"),
    );

  if (hasFrontendFiles && hasBackendSource) {
    sections.push(`## Contract Alignment Rules

This task modifies frontend code that consumes backend APIs. Before defining ANY TypeScript types, enum values, or API service calls:

1. **READ the backend model file** for enum definitions (e.g., \`src/src/models/*.model.js\`)
2. **READ the backend DTO file** for field name transformations (e.g., \`src/src/dto/*.dto.js\`)
3. **READ the backend route file** for HTTP methods and endpoint paths (e.g., \`src/src/routes/*.js\`)
4. **The backend is the source of truth** — NEVER invent field names, enum values, or API endpoints

If the blueprint includes a "Contract Sources" section, use those exact file references. If not, search for the relevant backend files before implementing frontend types.`);
  }

  // Instructions (blueprint-aware)
  const instructionPreamble = context.blueprint
    ? `Implement this task according to the specification. Follow the Implementation Blueprint as your primary guide.\n\n**Path Authority:** If the blueprint's fileAnalyses.filePath differs from the spec's "Files to Modify" paths, the BLUEPRINT path is correct (it was validated against the actual codebase). Always use the blueprint's paths.`
    : `Implement this task according to the specification. Follow ALL success criteria.`;

  sections.push(
    `## Instructions\n\n${instructionPreamble}\n\nWhen done, follow the finishing sequence exactly:\n1. Call \`verify\` with scope "all"\n2. Fix any failures, then re-verify\n3. Use \`git_status\` if you need to inspect the final tree\n4. Stop cleanly so Quack can auto-commit and seal your final-state diff\n\nDo NOT run \`git_add\` or \`git_commit\` — the post-worker output sealer is the only commit writer.`,
  );

  return sections.join("\n\n");
}
