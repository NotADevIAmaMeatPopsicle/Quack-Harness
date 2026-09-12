import type { VerificationResult, ComplianceCheckResult, ParsedTask } from "../core/types.js";

/**
 * Input data for building the judge evaluation prompt.
 */
/**
 * Pre-dispatch spec-review ambiguity finding surfaced to the judge so it
 * can give the worker the benefit of any reasonable interpretation on
 * criteria flagged ambiguous at preflight time. TASK-894.
 */
export interface SpecReviewFinding {
  criterionIndex: number;
  criterionText?: string;
  dimension: string;
  severity: "high" | "medium" | "low";
  explanation: string;
  suggestedClarification?: string;
}

export interface JudgePromptInput {
  /** Full content of the TASK-*.md file */
  taskSpec: string;
  /** Git diff of all changes made by the agent */
  gitDiff: string;
  /** Verification results from the deterministic checks */
  verificationResults: VerificationResult;
  /**
   * Current adapter requirement flags keyed by command name. This lets a
   * resumed judge safely interpret legacy checkpoints that predate explicit
   * `required` and `status` result metadata.
   */
  verificationCommandRequirements?: Readonly<Record<string, boolean>>;
  /** Project-specific judge criteria (empty string if not present) */
  judgeCriteria: string;
  /** Pre-judge compliance check results (optional) */
  complianceChecks?: ComplianceCheckResult[];
  /** Parsed task for extracting success criteria (optional) */
  parsedTask?: ParsedTask;
  /** Verified list of changed files from git diff --name-only (optional) */
  changedFiles?: string[];
  /** Compact summary of recent BACKLOG/READY tasks (title + tags) for follow-up dedup */
  recentBacklogSummary?: string;
  /**
   * Pre-dispatch spec-review output (from the preflight specReview block).
   * When present and non-empty, rendered as a "Pre-Dispatch Spec Ambiguities"
   * informational section so the judge can adjust its bar on contested
   * criteria. Always optional — judges should behave normally when absent.
   */
  specReview?: {
    riskLevel: "low" | "medium" | "high";
    findings: SpecReviewFinding[];
  };
}

/**
 * Formats verification results into a readable string for the judge prompt.
 *
 * @param verification - The verification results from adapter verifiers
 * @returns Formatted string showing pass/fail status of each check
 */
function formatVerificationResults(
  verification: VerificationResult,
  commandRequirements: Readonly<Record<string, boolean>> = {},
): string {
  const lines: string[] = [];

  lines.push(`Overall: ${verification.allPassed ? "ALL PASSED" : "SOME FAILED"}`);
  lines.push("");

  if (verification.commands.length > 0) {
    lines.push("### Verification Commands");
    lines.push(
      "Only entries marked FAIL (REQUIRED; BLOCKING) are deterministic verification failures. " +
        "SKIPPED and OPTIONAL UNAVAILABLE entries are non-blocking evidence.",
    );
    for (const cmd of verification.commands) {
      const required = cmd.required ?? commandRequirements[cmd.name] ?? true;
      const status =
        cmd.status ?? (cmd.passed ? "passed" : required ? "failed" : "optional-unavailable");
      const label =
        status === "skipped"
          ? required
            ? "SKIPPED (REQUIRED; BLOCKING)"
            : "SKIPPED (OPTIONAL; NON-BLOCKING)"
          : status === "optional-unavailable" || (!cmd.passed && !required)
            ? "OPTIONAL UNAVAILABLE (NON-BLOCKING)"
            : cmd.passed
              ? required
                ? "PASS"
                : "PASS (OPTIONAL)"
              : "FAIL (REQUIRED; BLOCKING)";
      lines.push(`- **${cmd.name}**: ${label}`);
      if (status !== "passed" && cmd.output) {
        lines.push(`  Output: ${cmd.output}`);
      }
    }
    lines.push("");
  }

  if (verification.conventionChecks.length > 0) {
    lines.push("### Convention Checks");
    for (const check of verification.conventionChecks) {
      const status = check.passed ? "PASS" : "FAIL";
      lines.push(`- **${check.name}**: ${status}`);
      if (!check.passed && check.output) {
        lines.push(`  Output: ${check.output}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Extracts success criteria from the parsed task or raw task spec.
 * If parsedTask is provided, uses the pre-parsed criteria. Otherwise,
 * attempts to extract from the task spec markdown.
 *
 * @param parsedTask - Optional parsed task with criteria
 * @param taskSpec - Raw task specification markdown
 * @returns Array of success criteria strings
 */
export function extractSuccessCriteria(parsedTask?: ParsedTask, taskSpec?: string): string[] {
  if (parsedTask?.successCriteria && parsedTask.successCriteria.length > 0) {
    return parsedTask.successCriteria;
  }

  if (!taskSpec) return [];

  // Fallback: extract from markdown
  const lines = taskSpec.split("\n");
  const criteria: string[] = [];
  let inSuccessCriteria = false;

  for (const line of lines) {
    if (line.includes("Success Criteria")) {
      inSuccessCriteria = true;
      continue;
    }

    if (inSuccessCriteria && line.match(/^#+\s/)) {
      // Hit next section header
      break;
    }

    if (inSuccessCriteria) {
      const match = line.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (match) {
        criteria.push(match[1].trim());
      }
    }
  }

  return criteria;
}

/**
 * Formats compliance check results into a readable string for the judge prompt.
 * Highlights flagged criteria (patterns not found) that need code-level verification.
 *
 * @param complianceChecks - The pre-judge compliance check results
 * @returns Formatted string showing compliance check findings
 */
function formatComplianceChecks(complianceChecks: ComplianceCheckResult[]): string {
  if (complianceChecks.length === 0) {
    return "No compliance patterns triggered.";
  }

  const lines: string[] = [];
  const flagged = complianceChecks.filter((c) => !c.found && c.severity === "flag");
  const warnings = complianceChecks.filter((c) => !c.found && c.severity === "warning");
  const passed = complianceChecks.filter((c) => c.found);

  if (flagged.length > 0) {
    lines.push("### ⚠️ FLAGGED CRITERIA (Code Evidence Not Found)");
    lines.push("");
    lines.push(
      "The following success criteria triggered patterns but lack corresponding code implementation:",
    );
    lines.push("");
    for (const check of flagged) {
      lines.push(`**Criterion:** "${check.criterion}"`);
      lines.push(`**Expected:** ${check.description}`);
      lines.push(`**Status:** No matching code patterns found in diff`);
      lines.push("");
    }
    lines.push(
      "⚠️ **Action Required:** Verify these criteria are actually enforced in code, not just mentioned in comments/docs.",
    );
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### ⚠ WARNINGS (Suggested Patterns Missing)");
    lines.push("");
    for (const check of warnings) {
      lines.push(`- **"${check.criterion}"**: ${check.description} not detected`);
    }
    lines.push("");
  }

  if (passed.length > 0) {
    lines.push("### ✓ PASSED COMPLIANCE CHECKS");
    lines.push("");
    for (const check of passed) {
      const evidenceSummary =
        check.evidence.length > 3
          ? `${check.evidence.slice(0, 3).join(", ")} (+${check.evidence.length - 3} more)`
          : check.evidence.join(", ");
      lines.push(`- **"${check.criterion}"**: ${check.description} found at ${evidenceSummary}`);
    }
  }

  return lines.join("\n");
}

/**
 * Static judge system prompt — shared across all judge invocations.
 * Placed in the system prompt for optimal cache hit rates: the SDK
 * caches the system prompt automatically, so this static content is
 * only transmitted once per cache window (5 minutes).
 */
export const JUDGE_SYSTEM_PROMPT = `You are an adversarial code review judge evaluating changes made by a background coding agent.

Your task is to find gaps where the implementation claims to satisfy requirements but doesn't actually enforce them.

## Per-Criterion Evaluation Instructions

For EACH success criterion listed above, you MUST:

1. **Identify the enforcement mechanism**: Find the SPECIFIC code that enforces this criterion
   - File path and line numbers where the enforcement occurs
   - NOT where it's mentioned in comments or variable names
   - NOT where it's passed as a parameter to another system

2. **Classify the enforcement type**:
   - **deterministic_code**: The code itself enforces the criterion (e.g., if statements, Math.min, array.slice)
   - **llm_instruction_only**: The criterion is only mentioned in prompts/instructions to an LLM
   - **not_implemented**: No enforcement found in the diff

3. **Test edge cases**: Ask yourself:
   - What happens if the LLM returns more items than requested?
   - What happens if external input violates the constraint?
   - What happens if the validation is bypassed?
   - Is the enforcement on the critical path or can it be skipped?

4. **Assign a status**:
   - **PASS**: Criterion is deterministically enforced in code
   - **PARTIAL**: Criterion relies on external compliance (e.g., LLM following instructions)
   - **FAIL**: Criterion is not enforced or implementation is incorrect

## Additional Checks

Beyond success criteria, also verify:

1. **Recommended Approach**: Was the approach described in the task spec followed?
2. **Implementation Details**: Were specific technical requirements met?
3. **Testing Requirements**: Are all required test categories present and meaningful?
4. **Scope Violations**: Any changes outside the specified files or unrelated refactoring?
5. **Quality Issues**: Obvious bugs, security issues, or anti-patterns?

## Path Verification (Anti-Hallucination)

CRITICAL: Before citing any file path in your evaluation, you MUST verify it exists using Glob or Read.
NEVER reference a path you haven't confirmed exists. If you cannot find a file, state "file not found" —
do NOT guess at alternative paths or fabricate directory structures.

When a "Changed Files (Verified)" section is present in the prompt, constrain your evaluation to ONLY
those files. Do not evaluate or cite files not in that verified list.

## Test Mock Awareness

Test files use mocks and stubs intentionally. Do NOT flag mock expectations, test doubles, or stubbed
dependencies as "not implemented" or "incomplete". Evaluate test coverage by whether tests exercise
the actual success criteria, not by mock fidelity. A test that mocks a database call to verify
business logic is valid — the mock is not a deficiency.

## Deterministic Verification Semantics

The Verification Results section distinguishes required blocking checks from optional evidence.

- FAIL (REQUIRED; BLOCKING) is a real deterministic failure and may block approval.
- SKIPPED (OPTIONAL; NON-BLOCKING) means the check was deliberately not run.
- OPTIONAL UNAVAILABLE (NON-BLOCKING) means an optional verifier could not produce a passing result.
- Optional skipped or unavailable checks are NOT failed success criteria and MUST NOT be the sole basis
  for REVISE or REJECT. Evaluate the task contract and diff normally; mention such checks only as
  non-blocking context when useful.
- The overall result is the aggregate of required checks. ALL PASSED can therefore coexist with
  optional skipped or unavailable evidence without contradiction.

## Response Format

You have read-only access to the codebase via Read, Glob, and Grep tools. Use them to verify claims.

Respond with this JSON structure:

{
  "verdict": "APPROVE" | "REVISE" | "REJECT",
  "confidence": 0.0-1.0,
  "criteria_evaluation": [
    {
      "criterion": "exact text of the success criterion",
      "status": "PASS" | "FAIL" | "PARTIAL",
      "evidence": "file:line reference or 'not found'",
      "reasoning": "why this status was assigned",
      "enforcement_type": "deterministic_code" | "llm_instruction_only" | "not_implemented"
    }
  ],
  "scope_violations": ["list of changes outside task scope"],
  "criteria_gaps": ["deprecated - use criteria_evaluation instead but include for compatibility"],
  "quality_issues": ["code quality concerns"],
  "feedback": "specific actionable feedback explaining the verdict",
  "follow_up_items": [
    {
      "title": "Short title for the follow-up task",
      "description": "What should be done and why",
      "type": "optimization" | "edge_case" | "testing" | "refactoring" | "scope_gap",
      "estimated_effort": "1-2 hours" | "2-3 hours" | "3-4 hours" | "4-6 hours"
    }
  ]
}

Note: follow_up_items is OPTIONAL. Only include when APPROVE-ing and you have genuine suggestions for future work. These items will be auto-generated as follow-up task specs.

## Verdict Guidelines

- **APPROVE**: ALL criteria have status PASS, no major scope violations or quality issues
- **REVISE**: One or more criteria are PARTIAL or FAIL, but the issues are **concretely fixable** — the agent can address them with specific code changes. Use REVISE whenever you can describe exactly what needs to change. This includes:
  - Incorrect logic (wrong condition, inverted check, missing property)
  - Missing implementation of a specific feature or criterion
  - Code quality issues (non-deterministic rendering, DRY violations)
  - Scope violations (files created outside spec) — these are fixable by removing them
  - Test failures or missing test coverage
- **REJECT**: The implementation has **fundamental architectural or approach problems** that cannot be fixed with targeted changes. Use REJECT ONLY when:
  - The entire approach is wrong and needs to be rewritten from scratch
  - The agent misunderstood the task so thoroughly that incremental fixes won't work
  - The changes are dangerous (security vulnerabilities, data loss risks)
  - The agent made no meaningful progress toward the task goals
- **When in doubt between REVISE and REJECT, choose REVISE.** A failed criterion that has a clear fix path (e.g., "change triangle to rectangle", "replace Date.now() with state.frame") is REVISE, not REJECT.

## Scope Violation Guidance

Not all out-of-spec file changes are equal:
- **True scope violation**: Agent refactored unrelated modules, added unrelated features, or modified files explicitly marked as off-limits. Flag these.
- **Necessary scaffolding**: Agent created configuration files (e.g., .eslintrc.json, tsconfig additions) to make the project's own verification commands pass. Do NOT treat these as scope violations — if the project's lint/test/build commands require a file to exist, creating it is a reasonable action. Note it as an observation, not a rejection reason.

## STRICT: Scope Boundaries (Anti-Scope-Creep)

The task spec's "Success Criteria" section is the CONTRACT. You evaluate ONLY those criteria.

- Do NOT invent new requirements beyond what the task spec lists
- Do NOT reinterpret advisory/optional features as blocking requirements
- Do NOT raise the bar based on best practices or personal judgment
- If a spec says a feature is "advisory" or "display only", do not REVISE because it isn't auto-applied
- If all listed success criteria pass, the verdict MUST be APPROVE regardless of quality_issues
- quality_issues and follow_up_items are for noting improvements, NOT for blocking approval

On RETRY evaluations (when previous feedback exists):
- If the agent addressed your specific feedback, do NOT move the goalposts
- Your previous feedback was a SUGGESTION, not an amendment to the spec
- If the agent's implementation satisfies the original criteria, verdict is APPROVE

## Scope Gap Detection (Anti-Incomplete-Delivery)

While you must not invent new requirements, you SHOULD detect incomplete delivery:

1. **Files to Modify audit**: Compare the task spec's "Files to Modify" table against the git diff.
   - If a file listed with action "Create" does NOT appear in the diff, note it as a scope gap.
   - If a file listed with action "Modify" has no changes in the diff, note it.
   - Files listed with action **Reference** are context-only. The agent reads them but does NOT modify them. A Reference file absent from the diff is NOT a scope gap — do not flag it.
   - Report these gaps in \`follow_up_items\` with type "scope_gap".

2. **Implementation Plan audit**: If the task spec has an implementation plan with multiple phases/layers:
   - Check whether each described phase has corresponding changes in the diff.
   - If an entire phase (e.g., "Phase D: Frontend") has zero changes, note it as a scope gap.

3. **Verdict impact**:
   - Scope gaps that correspond to success criteria → REVISE (criterion not met)
   - Scope gaps in filesToModify but NOT in success criteria → note as follow_up_items, do NOT block APPROVE
   - This preserves the contract: success criteria are still the primary evaluation target

This complements (does not replace) the anti-scope-creep rules above. You still must NOT
invent requirements — but you CAN observe that planned work was not delivered.

## Non-Blocking Follow-Up Items

When approving a task, you may note non-blocking improvements as follow_up_items.
These are suggestions for future work — they do NOT affect the verdict.

Use follow_up_items for:
- Edge cases that could be hardened but aren't critical
- Performance optimizations that aren't in the spec
- Refactoring opportunities noticed during review
- Additional test coverage beyond what was required
- Documentation improvements

Do NOT put items in follow_up_items that should block approval — those belong in criteria_evaluation as FAIL.

## Spec Ambiguity Awareness (TASK-894)

If a \`## Pre-Dispatch Spec Ambiguities\` section is present, the preflight spec reviewer flagged criterion-level ambiguities BEFORE the worker started. When evaluating the worker's choice on those specific criteria, you MUST give the worker the benefit of any reasonable interpretation. Do not REVISE or REJECT because the worker chose interpretation A when interpretation B would also have been valid — both were valid given the ambiguity. Note the ambiguity in your feedback so the operator can clarify the spec for next time, but do not penalize the worker for picking a defensible path through an under-specified criterion. The ambiguity does NOT excuse missing the criterion entirely — only the choice between valid interpretations.

Remember: You are an adversarial reviewer. If you see "maxTasks: 5" in a prompt but no code that enforces this limit, that's NOT a PASS - it's at best PARTIAL since it depends on LLM compliance.`;

/**
 * Builds the judge evaluation prompt with per-task dynamic content.
 * Static judge instructions are in JUDGE_SYSTEM_PROMPT (passed as system
 * prompt to the SDK for caching). This function builds only the dynamic
 * user message containing task-specific data.
 *
 * The prompt instructs the judge to:
 * 1. Evaluate each success criterion individually with evidence
 * 2. Distinguish "mentioned in code" from "enforced by code"
 * 3. Check implementation details and recommended approach
 * 4. Verify edge cases and error handling
 *
 * Based on ARCHITECTURE.md Section 8.3 LLM-as-Judge pattern.
 *
 * @param input - The judge prompt input data
 * @returns The fully interpolated evaluation prompt string
 */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const {
    taskSpec,
    gitDiff,
    verificationResults,
    verificationCommandRequirements,
    judgeCriteria,
    complianceChecks,
    parsedTask,
    changedFiles,
    recentBacklogSummary,
    specReview,
  } = input;

  const formattedVerification = formatVerificationResults(
    verificationResults,
    verificationCommandRequirements,
  );
  const successCriteria = extractSuccessCriteria(parsedTask, taskSpec);

  const complianceSection =
    complianceChecks && complianceChecks.length > 0
      ? `\n## Pre-Judge Compliance Checks\n\n${formatComplianceChecks(complianceChecks)}\n`
      : "";

  const projectSpecificSection =
    judgeCriteria.trim().length > 0
      ? `\n## Project-Specific Evaluation Criteria\n\n${judgeCriteria.trim()}\n`
      : "";

  // Format success criteria as a numbered list for explicit per-criterion evaluation
  const criteriaList =
    successCriteria.length > 0
      ? successCriteria.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n")
      : "No success criteria found in task spec";

  // Verified changed files section — anchors judge to real paths
  const changedFilesSection =
    changedFiles && changedFiles.length > 0
      ? `\n## Changed Files (Verified via git diff)\n\nThe following files were actually modified by the agent. Constrain your evaluation to ONLY these files.\nDo NOT reference file paths that are not in this list.\n\n${changedFiles.map((f) => `- ${f}`).join("\n")}\n`
      : "";

  const backlogSummarySection =
    recentBacklogSummary && recentBacklogSummary.trim().length > 0
      ? `\n## Recent Backlog (for follow-up dedup)\n\nThe following tasks are already in the backlog. When generating follow_up_items, avoid suggesting work that is already captured here.\n\n${recentBacklogSummary.trim()}\n`
      : "";

  // TASK-894: surface preflight spec-review findings to the judge so it can
  // give the worker the benefit of any reasonable interpretation on
  // criteria flagged ambiguous BEFORE dispatch. Renders only when findings
  // are non-empty so the prompt is unchanged when no review was run.
  const specReviewSection =
    specReview && specReview.findings.length > 0
      ? `\n## Pre-Dispatch Spec Ambiguities (informational)\n\nThe preflight spec reviewer flagged the following ambiguities BEFORE dispatch.\nUse these to weight your evaluation when a criterion is contested:\n- If the worker's chosen interpretation matches one of the flagged interpretations, that is a PASS for the criterion (the spec was ambiguous, the worker picked one valid path).\n- If the worker's interpretation creates a problem the reviewer didn't flag, that's a separate issue worth noting.\n\nRisk level: ${specReview.riskLevel}\n\nFindings:\n${specReview.findings
          .map((f, i) => {
            const sev = f.severity.toUpperCase();
            const crit = f.criterionText ? ` "${f.criterionText.slice(0, 80)}"` : "";
            return `${i + 1}. [${sev}] Criterion ${f.criterionIndex}${crit} (${f.dimension}): ${f.explanation}`;
          })
          .join("\n")}\n`
      : "";

  return `## Original Task Specification

${taskSpec}
${changedFilesSection}${backlogSummarySection}${specReviewSection}
## Git Diff

\`\`\`diff
${gitDiff}
\`\`\`

## Verification Results

${formattedVerification}
${complianceSection}
## Extracted Success Criteria

${criteriaList}
${projectSpecificSection}
Evaluate each criterion above following the Per-Criterion Evaluation Instructions in your system prompt. Respond with the JSON structure specified in the Response Format.`;
}
