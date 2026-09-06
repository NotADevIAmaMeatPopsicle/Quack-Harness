import { ParsedTask } from "../core/types.js";
import { buildDepthResponseExample, getTaskTypeDepthConfig } from "./depth-dimensions.js";
import { detectTaskType } from "./task-type-detector.js";

function renderDimensions(task: ParsedTask): string {
  const taskType = detectTaskType(task);
  const config = getTaskTypeDepthConfig(taskType);

  return config.dimensions
    .map((dimension, index) => {
      return [
        `${index + 1}. **${dimension.label}** (1-5)`,
        `   - ${dimension.rubric.low}`,
        `   - ${dimension.rubric.medium}`,
        `   - ${dimension.rubric.high}`,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Builds the evaluation prompt for the LLM depth evaluator.
 * The prompt is task-type aware so non-code work is not graded like a code
 * implementation task.
 */
export function buildDepthPrompt(task: ParsedTask, conventionsSummary: string): string {
  const taskType = detectTaskType(task);
  const config = getTaskTypeDepthConfig(taskType);
  const responseExample = buildDepthResponseExample(taskType);

  return `You are evaluating whether a task specification is detailed enough for a
background coding agent to implement without human guidance during execution.

This task is classified as **${config.title}** based on its tags.
Use the threshold for this task type: overall_score >= ${config.threshold.toFixed(1)}
and no required dimension below 2.

## Task Specification
${task.rawContent}

## Project Context
${conventionsSummary}

## Evaluate On These Dimensions
${renderDimensions(task)}

## Respond With JSON
${responseExample}`;
}
