import { ParsedTask, TaskType } from "../core/types.js";

const ARCHITECTURE_TAGS = new Set(["architecture", "adr", "design", "design-doc", "design-docs"]);

const TEST_TAGS = new Set(["e2e", "playwright", "testing", "test", "integration-test"]);

const DOCUMENTATION_TAGS = new Set(["documentation", "docs", "guide", "guides"]);

function normalizeTags(tags: string[]): Set<string> {
  return new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));
}

function hasAnyTag(tags: Set<string>, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (tags.has(candidate)) {
      return true;
    }
  }
  return false;
}

export function detectTaskType(task: Pick<ParsedTask, "tags">): TaskType {
  const tags = normalizeTags(task.tags);

  if (hasAnyTag(tags, ARCHITECTURE_TAGS)) {
    return TaskType.Architecture;
  }
  if (hasAnyTag(tags, TEST_TAGS)) {
    return TaskType.Test;
  }
  if (hasAnyTag(tags, DOCUMENTATION_TAGS)) {
    return TaskType.Documentation;
  }
  return TaskType.Code;
}
