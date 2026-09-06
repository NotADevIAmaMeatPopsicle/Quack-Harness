// ─── Spec Repair Prompt ─────────────────────────────────────────────
// Builds the prompt for the spec repair agent, which fixes incomplete
// task specs by filling in missing required sections. Works from raw
// markdown content and the parse error, not a ParsedTask (since the
// spec failed to parse).

/**
 * Builds the prompt for the spec repair agent.
 *
 * @param rawContent - The raw markdown content of the task file
 * @param filePath - Path to the task file (for context)
 * @param parseError - The error message from the parser
 * @param conventionsDoc - Project conventions document content
 * @returns The fully interpolated repair prompt string
 */
export function buildSpecRepairPrompt(
  rawContent: string,
  filePath: string,
  parseError: string,
  conventionsDoc: string,
): string {
  return `You are a task spec repair agent. A task specification file failed to parse because it is missing required sections. Your job is to fill in the missing sections so the file passes the parser, while preserving ALL existing content.

## Task File
Path: ${filePath}

\`\`\`markdown
${rawContent}
\`\`\`

## Parse Error
${parseError}

## Required Sections

A valid task spec MUST have all of these sections:

1. **H1 heading** — \`# TASK-NNN: Title\`
2. **## Metadata** — Must contain:
   - \`- **Priority:** P0-CRITICAL|P1-HIGH|P2-MEDIUM|P3-LOW\`
   - \`- **Effort:** <estimate>\`
   - \`- **Status:** BACKLOG|READY|IN_PROGRESS|BLOCKED|ON_HOLD|DECOMPOSED|VERIFYING|COMPLETE|VERIFIED|REJECTED\`
   - \`- **Blocked By:** []\` (or list of TASK IDs)
   - \`- **Tags:** tag1, tag2\`
3. **## Problem Statement** — Non-empty description of the problem
4. **## Success Criteria** — At least one bullet item (\`- [ ] criterion\` or \`- criterion\`)
5. **## Testing Requirements** — At least one bullet item (\`- [ ] requirement\` or \`- requirement\`)

Optional sections (add only if useful context exists): Current State, Recommended Approach, Files to Modify, Context References.

## Project Conventions
${conventionsDoc || "(No conventions document available)"}

## Instructions

1. Read the raw spec above to understand its structure. You are repairing the envelope, NOT authoring task content.
2. Identify which required pieces are missing or malformed from the parse error.
3. Metadata: you may normalize an existing Priority/Status value to its canonical enum (keep the submitter's original text in a "- **<Field>-Note:**" line so nothing is lost) and you may add a missing metadata field. Any value you cannot derive from the submitter's own text must be a safe default whose line contains the marker "(repair placeholder)".
4. **Preserve ALL existing content byte-for-byte.** Only ADD lines, or replace the one malformed metadata line / H1 heading. Your output is checked by a mechanical additive-only guard: any altered, reworded, reordered, or removed submitter line causes the entire repair to be REJECTED.
5. Missing required sections (Problem Statement, Success Criteria, Testing Requirements): do NOT invent real content. Insert one explicit placeholder item containing the marker "(repair placeholder)", for example: "- [ ] TBD (repair placeholder): submitter must define real testing requirements". Inventing plausible criteria would silently rewrite the task's contract; placeholders keep the task tracked but blocked until the submitter fills them in.
6. Place new sections in the standard order when practical; appending at the end of the file is also acceptable.

Output the complete repaired spec as a single markdown document. Do NOT wrap it in code fences. Output raw markdown only.`;
}
