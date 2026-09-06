// ─── Review Prompt Builders ─────────────────────────────────────────
// Prompts for the cross-model adversarial reviewer (TASK-1305).
// The system prompt is static so the Agent SDK can cache it; per-request
// content stays in the user prompt (same split the judge uses).

import type { ReviewRequest } from "./reviewer-types.js";

/**
 * Static reviewer identity + output contract. Passed as systemPrompt on the
 * claude-sdk runner; prepended into the request file for the codex runner.
 */
export const REVIEW_SYSTEM_PROMPT = `You are an adversarial cross-model reviewer in a coding-agent pipeline.

Your job is to VERIFY AND TRY TO REFUTE the artifact you are given — never to restate or summarize it. Read the real code before judging any claim about it. Every finding must carry evidence: cite file paths (file or file:line) you actually checked in the anchors field. Findings without evidence are worthless and will be discounted.

Verdict semantics:
- "SHIP": the artifact is sound; proceed.
- "AMEND": real findings exist that should be folded in, but none of them is blocking.
- "FIX_FIRST": at least one blocking issue; do not proceed until fixed.

You MUST output ONLY a single JSON object, no prose before or after it:
{
  "verdict": "SHIP" | "AMEND" | "FIX_FIRST",
  "summary": "one-paragraph overall judgment",
  "confidence": 0.0-1.0,
  "findings": [
    {
      "severity": "blocking" | "should_fix" | "nit",
      "summary": "one-line statement of the issue",
      "detail": "evidence and reasoning",
      "anchors": ["src/path/file.ts:123"]
    }
  ]
}
An empty findings array with verdict SHIP is a valid review when the artifact survives genuine refutation attempts.`;

/** Kind-specific review framing. */
function framingFor(kind: ReviewRequest["kind"]): string {
  if (kind === "brief") {
    return `This is a PRE-BUILD implementation brief (investigation output). Refute it against the CURRENT code and the task spec's intent:
- Anchors that are wrong or stale (the tree may have moved since the brief was written).
- Missed integration points: places the change must touch that the brief does not mention.
- Claims about existing behavior that the real code contradicts.
- Plans that would satisfy the spec's checklist while missing its INTENT.
- Missing re-baseline of tests the change will affect.`;
  }
  return `This is a POST-BUILD git diff. Verify it against the task spec's INTENT, not just its checklist:
- Success criteria that are unmet, or met in letter but gamed in spirit (mentioned-not-enforced, tautological tests, assertion-weakening).
- Scope violations: changes the spec does not authorize.
- Regressions or contract breaks in the code the diff touches.
- Missing tests for changed behavior.`;
}

/**
 * Build the per-request user prompt. Shared by both runners; the codex
 * runner wraps it via buildCodexRequestFileContent().
 */
export function buildReviewPrompt(request: ReviewRequest): string {
  const sections: string[] = [];

  sections.push(`# Adversarial review request — ${request.taskId} (${request.kind})`);
  sections.push(framingFor(request.kind));

  sections.push(`## Task Specification (the contract)\n\n${request.taskSpec}`);

  const artifactHeading =
    request.kind === "brief" ? "Implementation Brief (under review)" : "Git Diff (under review)";
  sections.push(`## ${artifactHeading}\n\n${request.artifact}`);

  if (request.verification && request.verification.trim().length > 0) {
    sections.push(`## Verification Results\n\n${request.verification}`);
  }

  if (request.constraints && request.constraints.trim().length > 0) {
    sections.push(`## Project Constraints\n\n${request.constraints}`);
  }

  sections.push(
    `---\n\nNow perform the review. Read the real files to check claims before judging. Output ONLY the JSON verdict object described in your instructions.`,
  );

  return sections.join("\n\n");
}

/**
 * Full content of the on-disk review request file for the codex-cli runner.
 * States the read-only rule in prose (defense in depth alongside the sandbox
 * flag) and embeds the system contract, since a subprocess has no separate
 * system-prompt channel.
 */
export function buildCodexRequestFileContent(request: ReviewRequest): string {
  return [
    `READ-ONLY REVIEW. You are running with a read-only sandbox and must not create, modify, or delete any file, nor run any command that writes (no git add/commit, no installs). The repository under review is available at your working directory.`,
    ``,
    REVIEW_SYSTEM_PROMPT,
    ``,
    buildReviewPrompt(request),
  ].join("\n");
}

/**
 * The short argv bootstrap for the codex subprocess. The full prompt travels
 * by file to stay clear of the Windows command-line length limit.
 */
export function buildCodexBootstrapPrompt(requestFilePath: string): string {
  return `Read the review request file at ${requestFilePath} and follow its instructions exactly. Output only the JSON verdict object.`;
}
