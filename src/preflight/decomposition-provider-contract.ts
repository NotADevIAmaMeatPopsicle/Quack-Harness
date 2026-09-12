import type { FileModification } from "../core/types.js";
import { parseTaskFile } from "../core/task-parser.js";
import type { SubtaskDefinition } from "./decompose-types.js";
import {
  MIN_DECOMPOSITION_SUBTASKS,
  hasValidDecompositionChildCount,
  resolveDecompositionMaxSubtasks,
} from "./decomposition-limits.js";

const SUBTASK_KEYS = [
  "id",
  "title",
  "filesToModify",
  "successCriteria",
  "dependsOn",
  "isFinal",
] as const;
const FILE_KEYS = ["path", "action", "notes"] as const;
const FILE_ACTIONS = new Set<FileModification["action"]>([
  "Create",
  "Modify",
  "Delete",
  "Reference",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFileModification(value: unknown): value is FileModification {
  if (!isRecord(value) || !hasExactKeys(value, FILE_KEYS)) return false;
  return (
    isNonEmptyString(value.path) &&
    typeof value.action === "string" &&
    FILE_ACTIONS.has(value.action as FileModification["action"]) &&
    typeof value.notes === "string"
  );
}

function isStringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return (
    Array.isArray(value) && (!requireNonEmpty || value.length > 0) && value.every(isNonEmptyString)
  );
}

function parseSubtask(value: unknown): SubtaskDefinition | null {
  if (!isRecord(value) || !hasExactKeys(value, SUBTASK_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !Array.isArray(value.filesToModify) ||
    value.filesToModify.length === 0 ||
    !value.filesToModify.every(isFileModification) ||
    !isStringArray(value.successCriteria, true) ||
    !isStringArray(value.dependsOn) ||
    typeof value.isFinal !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    filesToModify: value.filesToModify,
    successCriteria: value.successCriteria,
    dependsOn: value.dependsOn,
    isFinal: value.isFinal,
  };
}

/**
 * Validate child identities independently from coverage and quality data.
 * This protects materialization of a caller-supplied plan without replacing
 * the task-creation reservation that owns the final disk collision check.
 */
export function validateChildIdentitySet(
  subtasks: readonly Pick<SubtaskDefinition, "id" | "dependsOn">[],
  parentId: string,
): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < subtasks.length; index++) {
    const child = subtasks[index];
    const expectedId = `${parentId}-${String.fromCharCode(65 + index)}`;
    if (child.id !== expectedId || seen.has(child.id)) return false;
    if (new Set(child.dependsOn).size !== child.dependsOn.length) return false;
    if (child.dependsOn.some((dependency) => dependency === child.id || !seen.has(dependency))) {
      return false;
    }
    seen.add(child.id);
  }
  return true;
}

export function validateTaskDecompositionValue(
  value: unknown,
  parentId: string,
  maxSubtasks: number,
): { subtasks: SubtaskDefinition[] } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["subtasks"])) return null;
  if (
    !Array.isArray(value.subtasks) ||
    !hasValidDecompositionChildCount(value.subtasks.length, maxSubtasks)
  ) {
    return null;
  }

  const subtasks: SubtaskDefinition[] = [];
  for (const rawSubtask of value.subtasks) {
    const subtask = parseSubtask(rawSubtask);
    if (!subtask) return null;
    subtasks.push(subtask);
  }
  if (!validateChildIdentitySet(subtasks, parentId)) return null;
  if (
    subtasks.some((subtask, index) =>
      index === subtasks.length - 1 ? !subtask.isFinal : subtask.isFinal,
    )
  ) {
    return null;
  }
  return { subtasks };
}

export function parseTaskDecompositionOutput(
  rawText: string,
  parentId: string,
  maxSubtasks: number,
): { subtasks: SubtaskDefinition[] } | null {
  try {
    return validateTaskDecompositionValue(JSON.parse(rawText), parentId, maxSubtasks);
  } catch {
    return null;
  }
}

export function buildTaskDecompositionOutputSchema(maxSubtasks: number): Record<string, unknown> {
  const resolvedMax = resolveDecompositionMaxSubtasks(maxSubtasks);
  return {
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        minItems: MIN_DECOMPOSITION_SUBTASKS,
        maxItems: resolvedMax,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            filesToModify: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  path: { type: "string", minLength: 1 },
                  action: {
                    type: "string",
                    enum: ["Create", "Modify", "Delete", "Reference"],
                  },
                  notes: { type: "string" },
                },
                required: ["path", "action", "notes"],
                additionalProperties: false,
              },
            },
            successCriteria: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
            dependsOn: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            isFinal: { type: "boolean" },
          },
          required: SUBTASK_KEYS,
          additionalProperties: false,
        },
      },
    },
    required: ["subtasks"],
    additionalProperties: false,
  };
}

export interface ChildSpecMaterializationOutput {
  subtaskId: string;
  markdown: string;
}

export const CHILD_SPEC_MATERIALIZATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    subtaskId: { type: "string", minLength: 1 },
    markdown: { type: "string", minLength: 1 },
  },
  required: ["subtaskId", "markdown"],
  additionalProperties: false,
};

export function parseChildSpecMaterializationOutput(
  rawText: string,
  expectedSubtaskId: string,
): ChildSpecMaterializationOutput | null {
  try {
    const value: unknown = JSON.parse(rawText);
    if (!isRecord(value) || !hasExactKeys(value, ["subtaskId", "markdown"])) {
      return null;
    }
    if (value.subtaskId !== expectedSubtaskId || !isNonEmptyString(value.markdown)) {
      return null;
    }
    if (parseTaskFile(value.markdown).id !== expectedSubtaskId) return null;
    return { subtaskId: value.subtaskId, markdown: value.markdown };
  } catch {
    return null;
  }
}
