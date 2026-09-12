import { createHash } from "node:crypto";

import type { ParsedTask } from "../core/types.js";
import type { CoverageReport, FileOwnership, SubtaskDefinition } from "./decompose-types.js";
import { validateChildIdentitySet } from "./decomposition-provider-contract.js";
import {
  DEFAULT_MAX_DECOMPOSITION_SUBTASKS,
  hasValidDecompositionChildCount,
} from "./decomposition-limits.js";
export { MAX_DECOMPOSITION_SUBTASKS } from "./decomposition-limits.js";

/** Bind a staged topology to the exact parent bytes it was planned from. */
export function computeDecompositionParentHash(parentContent: string): string {
  return createHash("sha256").update(parentContent).digest("hex");
}

/** Validate child IDs/dependencies and the single trailing final-child marker. */
export function hasValidDecompositionTopologyIdentity(
  parentTaskId: string,
  subtasks: readonly unknown[],
  maxSubtasks = DEFAULT_MAX_DECOMPOSITION_SUBTASKS,
): boolean {
  if (!hasValidDecompositionChildCount(subtasks.length, maxSubtasks)) return false;

  const fileActions = new Set(["Create", "Modify", "Delete", "Reference"]);
  const parsed: SubtaskDefinition[] = [];
  for (const value of subtasks) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = [
      "dependsOn",
      "filesToModify",
      "id",
      "isFinal",
      "successCriteria",
      "title",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return false;
    }
    if (
      typeof record.id !== "string" ||
      record.id.trim().length === 0 ||
      typeof record.title !== "string" ||
      record.title.trim().length === 0 ||
      !Array.isArray(record.filesToModify) ||
      !record.filesToModify.every((file: unknown) => {
        if (typeof file !== "object" || file === null || Array.isArray(file)) return false;
        const fileRecord = file as Record<string, unknown>;
        return (
          Object.keys(fileRecord).sort().join("\0") === "action\0notes\0path" &&
          typeof fileRecord.path === "string" &&
          fileRecord.path.trim().length > 0 &&
          typeof fileRecord.action === "string" &&
          fileActions.has(fileRecord.action) &&
          typeof fileRecord.notes === "string"
        );
      }) ||
      !Array.isArray(record.successCriteria) ||
      !record.successCriteria.every(
        (criterion) => typeof criterion === "string" && criterion.trim().length > 0,
      ) ||
      !Array.isArray(record.dependsOn) ||
      !record.dependsOn.every(
        (dependency) => typeof dependency === "string" && dependency.trim().length > 0,
      ) ||
      typeof record.isFinal !== "boolean"
    ) {
      return false;
    }
    parsed.push(record as unknown as SubtaskDefinition);
  }

  return (
    validateChildIdentitySet(parsed, parentTaskId) &&
    parsed.every((subtask, index) =>
      index === parsed.length - 1 ? subtask.isFinal : !subtask.isFinal,
    )
  );
}

/** Recompute exact parent scope ownership from topology, ignoring submitted reports. */
export function buildDecompositionCoverageReport(
  task: ParsedTask,
  subtasks: SubtaskDefinition[],
): CoverageReport {
  const parentFileActions = new Map(
    task.filesToModify.map((file) => [file.path, file.action] as const),
  );
  const fileOwnerMap = new Map<string, string[]>();
  const mismatchedFileActions: NonNullable<CoverageReport["mismatchedFileActions"]> = [];
  for (const subtask of subtasks) {
    for (const file of subtask.filesToModify) {
      const owners = fileOwnerMap.get(file.path) ?? [];
      owners.push(subtask.id);
      fileOwnerMap.set(file.path, owners);
      const expectedAction = parentFileActions.get(file.path);
      if (expectedAction && expectedAction !== file.action) {
        mismatchedFileActions.push({
          filePath: file.path,
          expectedAction,
          actualAction: file.action,
          ownedBy: subtask.id,
        });
      }
    }
  }

  const fileOwnership: FileOwnership[] = [];
  for (const [filePath, owners] of fileOwnerMap) {
    fileOwnership.push({ filePath, ownedBy: owners[0], isShared: owners.length > 1 });
  }
  const mappedFiles = new Set(fileOwnerMap.keys());
  const unmappedFiles = task.filesToModify
    .map((file) => file.path)
    .filter((p) => !mappedFiles.has(p));
  const unexpectedFiles = [...mappedFiles].filter((filePath) => !parentFileActions.has(filePath));
  const duplicatedFiles = [...fileOwnerMap.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([filePath]) => filePath);

  const criterionOwnerMap = new Map<string, string[]>();
  for (const subtask of subtasks) {
    for (const criterion of subtask.successCriteria) {
      const owners = criterionOwnerMap.get(criterion) ?? [];
      owners.push(subtask.id);
      criterionOwnerMap.set(criterion, owners);
    }
  }
  const criterionOwnership = task.successCriteria.map((criterion) => ({
    criterion,
    ownedBy: criterionOwnerMap.get(criterion) ?? [],
  }));
  const unmappedCriteria = criterionOwnership
    .filter((entry) => entry.ownedBy.length === 0)
    .map((entry) => entry.criterion);
  const parentCriteria = new Set(task.successCriteria);
  const unexpectedCriteria = [
    ...new Set(
      subtasks.flatMap((subtask) =>
        subtask.successCriteria.filter(
          (criterion) =>
            !parentCriteria.has(criterion) &&
            !(criterion === "All parent task success criteria verified" && subtask.isFinal),
        ),
      ),
    ),
  ];
  const duplicatedCriteria = [...criterionOwnerMap.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([criterion]) => criterion);

  return {
    fileOwnership,
    criterionOwnership,
    unmappedFiles,
    unmappedCriteria,
    duplicatedFiles,
    duplicatedCriteria,
    unexpectedFiles,
    mismatchedFileActions,
    unexpectedCriteria,
    hasCoverageGap:
      unmappedFiles.length > 0 ||
      unmappedCriteria.length > 0 ||
      duplicatedFiles.length > 0 ||
      duplicatedCriteria.length > 0 ||
      unexpectedFiles.length > 0 ||
      mismatchedFileActions.length > 0 ||
      unexpectedCriteria.length > 0,
  };
}
