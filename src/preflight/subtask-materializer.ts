import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
// ─── Subtask Materializer ───────────────────────────────────────────
// Generates rich child-task markdown drafts from a topology plan.
// Each draft has child-specific Problem Statement, Current State,
// Recommended Approach, scenario-based Testing Requirements, and a
// Full-Stack Completion Addendum for cross-layer children.
// This module is side-effect free — it only returns draft objects.

import type { ParsedTask } from "../core/types.js";
import type { Blueprint } from "../blueprint/blueprint-types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { DecompositionTopology, SubtaskDefinition, ChildDraft } from "./decompose-types.js";
import { runChildQualityGate, validateChildDraftScope } from "./subtask-quality-gate.js";
import { resolveModel } from "../dispatcher/model-router.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { runCodexStructuredEvaluation } from "../llm/codex-structured-evaluator.js";
import {
  CHILD_SPEC_MATERIALIZATION_OUTPUT_SCHEMA,
  parseChildSpecMaterializationOutput,
} from "./decomposition-provider-contract.js";
import { hasValidDecompositionTopologyIdentity } from "./decomposition-plan-integrity.js";
import { resolveEffectiveDecompositionMaxSubtasks } from "./decomposition-limits.js";

/** Cross-layer file indicators — children touching these get the addendum */
const CROSS_LAYER_PATH_PATTERNS = [
  /server\.ts$/,
  /monitor\//,
  /routes\//,
  /cli\//,
  /api-contracts/,
  /federation\//,
];

function requiresFullStackAddendum(subtask: SubtaskDefinition): boolean {
  return subtask.filesToModify.some((f) => CROSS_LAYER_PATH_PATTERNS.some((p) => p.test(f.path)));
}

/**
 * Minimal SDK result message shape used for type narrowing.
 */
interface SDKSuccessResult {
  type: "result";
  subtype: "success";
  result: string;
}

interface SDKMessage {
  type: string;
  subtype?: string;
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

let _queryFn: QueryFn | undefined;

async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

/**
 * Materialize rich child draft specs from a topology plan.
 * Calls the LLM for each child to produce specific Problem Statement,
 * Current State, Recommended Approach, and Testing Requirements.
 * Runs a quality gate on each draft before returning.
 * This function is side-effect free — no files are written.
 *
 * @param topology - Plan from decomposeTask
 * @param parentTask - The parent task being decomposed
 * @param adapter - Project adapter with config
 * @param blueprint - Blueprint with file analyses
 * @returns Array of child drafts with quality metrics
 */
export async function materializeChildDrafts(
  topology: DecompositionTopology,
  parentTask: ParsedTask,
  adapter: ProjectAdapter,
  blueprint: Blueprint,
): Promise<ChildDraft[]> {
  const maxSubtasks = resolveEffectiveDecompositionMaxSubtasks(
    topology.maxSubtasks ?? adapter.config.preflight?.autoDecompose?.maxSubtasks,
    adapter.config.preflight?.autoDecompose?.maxSubtasks,
  );
  if (
    topology.parentTaskId !== parentTask.id ||
    !hasValidDecompositionTopologyIdentity(parentTask.id, topology.subtasks, maxSubtasks)
  ) {
    throw new Error(
      `Materialization topology for ${parentTask.id} must contain 2..configuredMax exact sequential children with one trailing final child`,
    );
  }

  const drafts: ChildDraft[] = [];

  for (const subtask of topology.subtasks) {
    let markdown: string;
    try {
      markdown = await generateChildDraft(subtask, parentTask, adapter, blueprint);
    } catch (err) {
      // If LLM call fails, produce a parse-error draft so the caller can report it
      const errMsg = err instanceof Error ? err.message : String(err);
      drafts.push({
        subtaskId: subtask.id,
        title: subtask.title,
        markdown: "",
        sectionsPresent: [],
        prepScore: 0,
        prepReady: false,
        deficiencies: [`Materialization failed: ${errMsg}`],
        parseError: errMsg,
      });
      continue;
    }

    const gate = runChildQualityGate(subtask.id, markdown);
    const scopeDeficiencies = validateChildDraftScope(subtask, markdown);
    drafts.push({
      subtaskId: subtask.id,
      title: subtask.title,
      markdown,
      sectionsPresent: gate.sectionsPresent,
      prepScore: gate.prepScore,
      prepReady: gate.prepReady && scopeDeficiencies.length === 0,
      deficiencies: [...gate.deficiencies, ...scopeDeficiencies],
      parseError: gate.parseError,
    });
  }

  return drafts;
}

/**
 * Call the LLM to generate a rich child draft for a single subtask.
 */
async function generateChildDraft(
  subtask: SubtaskDefinition,
  parentTask: ParsedTask,
  adapter: ProjectAdapter,
  blueprint: Blueprint,
): Promise<string> {
  const evaluator = adapter.config.evaluationProviders?.childSpecMaterialization;
  const prompt = buildMaterializePrompt(
    subtask,
    parentTask,
    blueprint,
    evaluator?.runner === "codex-cli" ? "structured" : "markdown",
  );
  const model =
    evaluator?.model ??
    resolveModel(adapter.config.modelRouting, adapter.config.agent, {
      stage: "plan",
    });

  if (evaluator?.runner === "codex-cli") {
    const result = await runCodexStructuredEvaluation(
      {
        projectRoot: adapter.projectRoot,
        model,
        systemPrompt:
          "Author only the requested child task specification. Inspect the repository read-only and return the required JSON object; do not modify files.",
        prompt,
        outputSchema: CHILD_SPEC_MATERIALIZATION_OUTPUT_SCHEMA,
        parse: (rawText) => parseChildSpecMaterializationOutput(rawText, subtask.id),
      },
      evaluator,
    );
    if (result.status === "runner_error") {
      throw new Error(`Codex child spec materialization ${result.errorKind}: ${result.message}`);
    }
    const validated = parseChildSpecMaterializationOutput(JSON.stringify(result.value), subtask.id);
    if (!validated) {
      throw new Error(
        "Codex child spec materialization parse_failed: evaluator returned an invalid or conflicting child identity",
      );
    }
    return validated.markdown;
  }

  const queryFn = await getQueryFn();
  const queryResult = queryFn({
    prompt,
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
      ...getSdkPermissionOptions(),
      env: getClaudeSdkEnvironment(adapter.config.agent.apiKeys),
      model,
      maxTurns: 10,
      cwd: adapter.projectRoot,
    },
  });

  const MATERIALIZE_TIMEOUT_MS = 180_000;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Child draft materialization timed out for ${subtask.id} after ${MATERIALIZE_TIMEOUT_MS / 1000}s`,
          ),
        ),
      MATERIALIZE_TIMEOUT_MS,
    );
    timer.unref();
  });

  const iterate = async (): Promise<string> => {
    for await (const message of queryResult) {
      if (message.type === "result" && message.subtype === "success") {
        return (message as SDKSuccessResult).result;
      }
    }
    throw new Error(`No result from materialization agent for ${subtask.id}`);
  };

  return Promise.race([iterate(), timeoutPromise]);
}

/**
 * Build the per-subtask materialization prompt.
 */
function buildMaterializePrompt(
  subtask: SubtaskDefinition,
  parentTask: ParsedTask,
  blueprint: Blueprint,
  outputMode: "markdown" | "structured" = "markdown",
): string {
  const needsAddendum = requiresFullStackAddendum(subtask);

  const fileAnalysisSection = subtask.filesToModify
    .map((f) => {
      const analysis = blueprint.fileAnalyses.find((a) => a.filePath === f.path);
      if (!analysis) return `- **${f.path}** (${f.action})${f.notes ? `: ${f.notes}` : ""}`;
      return [
        `- **${f.path}** (${f.action})`,
        analysis.currentStructure ? `  - Current: ${analysis.currentStructure}` : "",
        analysis.integrationPoints ? `  - Integration: ${analysis.integrationPoints}` : "",
        analysis.patternToFollow ? `  - Pattern: ${analysis.patternToFollow}` : "",
        f.notes ? `  - Notes: ${f.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `# Child Task Spec Authoring Request

You are a task spec authoring agent. Write a complete TASK-*.md spec for child subtask **${subtask.id}**.

## Parent Context

**Parent Task:** ${parentTask.id} — ${parentTask.title}

**Parent Problem Statement:**
${parentTask.problemStatement}

**Parent Current State:**
${parentTask.currentState}

**Parent Recommended Approach:**
${parentTask.recommendedApproach}

## This Child's Scope

**ID:** ${subtask.id}
**Title:** ${subtask.title}
**Depends On:** ${subtask.dependsOn.length > 0 ? subtask.dependsOn.join(", ") : "none"}
**Is Final Subtask:** ${subtask.isFinal}

**Files Owned:**
${fileAnalysisSection}

**Success Criteria:**
${subtask.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Required Output Format

Output ONLY the complete markdown spec with these exact H2 sections, in order:

\`\`\`markdown
# ${subtask.id}: ${subtask.title}

## Metadata
- **Priority:** ${parentTask.priority}
- **Effort:** [estimate based on scope]
- **Status:** READY
- **Blocked By:** [${subtask.dependsOn.join(", ")}]
- **Blocks:** []
- **Tags:** ${[...new Set([...parentTask.tags, "subtask"])].join(", ")}

## Problem Statement
[Child-specific problem statement. Explain what THIS child must solve within the parent's broader problem. Do NOT copy the parent problem statement verbatim. 2-4 sentences.]

## Current State
[Child-specific current state describing the files this child modifies and their current condition. Do NOT use generic phrases like "Parent task was decomposed".]

## Recommended Approach
[Concrete implementation steps for THIS child's files. Reference specific patterns from the blueprint. Do NOT use generic phrases like "Follow the parent task's blueprint".]

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
${subtask.filesToModify.map((f) => `| \`${f.path}\` | ${f.action} | ${f.notes ?? ""} |`).join("\n")}

## Success Criteria
${subtask.successCriteria.map((c) => `- [ ] ${c}`).join("\n")}

## Testing Requirements
[Scenario-based testing requirements — NOT "At least N×2 new tests". List 3-6 specific test scenarios that verify this child's success criteria.]

## Anti-Patterns
[3-5 anti-patterns specific to this child's files and scope. Do NOT use generic "Do NOT modify files outside scope".]

## Context References
${parentTask.contextReferences.map((r) => `- ${r}`).join("\n")}
- Parent task: ${parentTask.id}
${subtask.dependsOn.map((d) => `- Sibling dependency: ${d}`).join("\n")}
${
  needsAddendum
    ? `
## Full-Stack Completion Addendum

### Cross-Task Contract
[Describe the interface contract between this child and its siblings — what data shapes, function signatures, or API routes must remain stable across the decomposition.]

### Error Handling Matrix
[List the error cases this child must handle and the expected behavior for each.]
${
  subtask.filesToModify.some((f) => /server\.ts$|routes\//.test(f.path))
    ? `
### API Response Contract
[List each API route this child adds or modifies, with request shape, success response, and error response codes.]
`
    : ""
}
### End-to-End Verification Notes
[What a manual smoke test for this child looks like — specific endpoints, CLI commands, or UI actions to verify.]`
    : ""
}
\`\`\`

${
  outputMode === "structured"
    ? `Return ONLY a JSON object with exactly two fields: "subtaskId" set to "${subtask.id}", and "markdown" containing the complete markdown spec above. No prose before or after.`
    : "Output ONLY the markdown spec above. No prose before or after. No code fences wrapping the spec."
}
`;
}

/**
 * Build a fallback child spec without LLM (deterministic).
 * Used when the LLM call is unavailable. Produces a valid parseable spec
 * with child-specific content derived from the topology.
 */
export function buildFallbackChildDraft(
  subtask: SubtaskDefinition,
  parentTask: ParsedTask,
): string {
  const needsAddendum = requiresFullStackAddendum(subtask);
  const tags = [...new Set([...parentTask.tags, "subtask"])];
  const sections: string[] = [];

  sections.push(`# ${subtask.id}: ${subtask.title}`);
  sections.push("");
  sections.push("## Metadata");
  sections.push(`- **Priority:** ${parentTask.priority}`);
  sections.push(`- **Effort:** ${estimateSubtaskEffort(subtask, parentTask)}`);
  sections.push(`- **Status:** READY`);
  sections.push(`- **Blocked By:** [${subtask.dependsOn.join(", ")}]`);
  sections.push(`- **Blocks:** []`);
  sections.push(`- **Tags:** ${tags.join(", ")}`);
  sections.push("");

  sections.push("## Problem Statement");
  sections.push(
    `${subtask.title} implements ${subtask.filesToModify.length} file(s) as part of ${parentTask.id}: ${parentTask.title}. ` +
      `The scope is limited to the files listed below and the success criteria assigned to this child.`,
  );
  sections.push("");

  sections.push("## Current State");
  const fileList = subtask.filesToModify.map((f) => `${f.path} (${f.action})`).join(", ");
  sections.push(
    `This child owns: ${fileList}. ` +
      (parentTask.currentState
        ? `From the parent context: ${parentTask.currentState.slice(0, 200)}`
        : "See parent task for full context."),
  );
  sections.push("");

  sections.push("## Recommended Approach");
  sections.push(
    `Implement the files listed in the scope below following the patterns from the parent task blueprint. ` +
      `Complete all success criteria before running verification.`,
  );
  if (subtask.dependsOn.length > 0) {
    sections.push(
      `This child depends on ${subtask.dependsOn.join(", ")} — ensure those are merged before starting.`,
    );
  }
  sections.push("");

  sections.push("## Files to Modify");
  sections.push("| File | Action | Notes |");
  sections.push("|------|--------|-------|");
  for (const f of subtask.filesToModify) {
    sections.push(`| \`${f.path}\` | ${f.action} | ${f.notes ?? ""} |`);
  }
  sections.push("");

  sections.push("## Success Criteria");
  for (const c of subtask.successCriteria) {
    sections.push(`- [ ] ${c}`);
  }
  sections.push("");

  sections.push("## Testing Requirements");
  sections.push(`- [ ] All tests for modified files pass after this child's changes`);
  sections.push(`- [ ] Each success criterion above has at least one corresponding test scenario`);
  sections.push(`- [ ] \`npm run build\` succeeds`);
  if (subtask.isFinal) {
    sections.push(`- [ ] All parent task success criteria verified end-to-end`);
  }
  sections.push("");

  sections.push("## Anti-Patterns");
  sections.push(
    `- Do NOT modify files outside this child's scope — other children own those files`,
  );
  sections.push(`- Do NOT skip validation steps for the files you modify`);
  if (subtask.isFinal) {
    sections.push(`- Do NOT declare complete without running the full parent task verification`);
  }
  sections.push("");

  sections.push("## Context References");
  sections.push(`- Parent task: ${parentTask.id}`);
  for (const ref of parentTask.contextReferences) {
    sections.push(`- ${ref}`);
  }
  for (const dep of subtask.dependsOn) {
    sections.push(`- Sibling dependency: ${dep}`);
  }
  sections.push("");

  if (needsAddendum) {
    sections.push("## Full-Stack Completion Addendum");
    sections.push("");
    sections.push("### Cross-Task Contract");
    sections.push(
      `Define the interface between this child and its siblings before implementation begins.`,
    );
    sections.push("");
    sections.push("### Error Handling Matrix");
    sections.push(`Document error cases and expected behavior for each file in scope.`);
    sections.push("");
    sections.push("### End-to-End Verification Notes");
    sections.push(`Specify the manual smoke test steps for this child's deliverables.`);
    sections.push("");
  }

  return sections.join("\n");
}

function estimateSubtaskEffort(subtask: SubtaskDefinition, parentTask: ParsedTask): string {
  const parentFiles = parentTask.filesToModify.length;
  const subtaskFiles = subtask.filesToModify.length;
  if (parentFiles === 0) return "1-2 hours";
  const ratio = subtaskFiles / parentFiles;
  if (ratio <= 0.25) return "1-2 hours";
  if (ratio <= 0.4) return "2-3 hours";
  if (ratio <= 0.6) return "3-4 hours";
  return "4-6 hours";
}
