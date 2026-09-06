import { ParsedTask } from "../core/types.js";

/**
 * Builds the evaluation prompt for the spec ambiguity reviewer.
 * This prompt instructs a fast LLM (Haiku by default) to evaluate whether
 * a task specification contains language that can be interpreted in multiple
 * ways, leading to agent misimplementation.
 *
 * Orthogonal to depth evaluation: depth checks "how much detail", this checks
 * "how unambiguous".
 *
 * @param task - The parsed task to evaluate
 * @returns The fully interpolated evaluation prompt string
 */
export function buildSpecReviewPrompt(task: ParsedTask): string {
  return `You are evaluating whether a task specification contains ambiguous language
that could be interpreted in multiple ways, leading to agent misimplementation.

## Task Specification
${task.rawContent}

## Evaluate on these 6 ambiguity dimensions:

1. **Criterion Ambiguity**: Can any success criterion be implemented in 2+ meaningfully
   different ways? Flag criteria with vague nouns ("visualization", "component", "panel")
   that don't specify exact layout/behavior.

   Examples:
   - "Dashboard shows progress bar" → Could mean: single-color bar, stacked bar chart,
     circular progress, text percentage. Which one?
   - "Add validation component" → Could mean: inline field validator, modal dialog,
     toast notification. Which one?

2. **Interface Contract Gaps**: Do any criteria reference API endpoints, UI elements,
   event payloads, or data structures without defining the exact shape? Flag missing
   request/response schemas, event payload formats, or component prop definitions.

   Examples:
   - "Endpoint returns decomposition result" → What fields? JSON structure? Error cases?
   - "SSE events broadcast during stages" → Which events? What payload fields?

3. **Criterion-to-File Mapping**: Does every success criterion clearly map to at least
   one file in filesToModify? Flag criteria that seem to require files not listed, or
   files that have no criteria pointing at them.

   Examples:
   - Criterion mentions "server endpoint" but filesToModify only has client files
   - Criterion says "update dashboard UI" but no dashboard file listed

4. **Visual/Behavioral Ambiguity**: Do any criteria describe visual elements (charts,
   bars, badges, layouts) or user interactions (click, hover, expand) without
   specifying exact appearance or behavior?

   Examples:
   - "Task card shows pre-flight button" → On compact card or expanded detail view?
   - "Context budget visualization shows breakdown" → Single bar? Stacked segments?
     Pie chart? Table?

5. **Ownership Ambiguity**: Do any criteria describe behavior that could be implemented
   in multiple locations (server vs client, library vs caller, parent vs child component)?
   Flag criteria where the "who does what" is unclear.

   Examples:
   - "Generate subtask specs and enqueue them" → Does the agent do both, or does the
     server enqueue after the agent returns?
   - "SSE events broadcast" → Does the caller emit events, or the underlying function?

6. **Integration Gap**: Do new files created in filesToModify have corresponding modifications
   to the files that must import/register them? For example: if a new CLI command file is
   created, is the CLI index file also in filesToModify? If a new API endpoint file is created,
   is the server file also modified?

   Examples:
   - New file "src/cli/new-command.ts" created but "src/index.ts" not in filesToModify
   - New file "src/routes/new-route.ts" created but "src/monitor/server.ts" not in filesToModify
   - New event type added but "src/monitor/event-types.ts" not in filesToModify

## Files to Modify
${task.filesToModify.map((f, i) => `${i + 1}. ${f.path} (${f.action})`).join("\n")}

## Success Criteria
${task.successCriteria.map((c, i) => `${i}. ${c}`).join("\n")}

## Respond with JSON containing:
{
  "findings": [
    {
      "criterionIndex": 0,
      "criterionText": "the full criterion text",
      "dimension": "criterion_ambiguity" | "interface_gap" | "file_mapping" | "visual_ambiguity" | "ownership_ambiguity" | "integration_gap",
      "explanation": "why this is ambiguous",
      "clarificationQuestion": "specific question to resolve it",
      "severity": "high" | "medium"
    }
  ],
  "suggestedClarifications": [
    "Add JSON schema for endpoint response at line X",
    "Specify exact layout: stacked bar chart with colored segments per section"
  ]
}

Return an empty findings array if the spec is unambiguous.`;
}
