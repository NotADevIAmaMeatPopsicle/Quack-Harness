import { parseTaskFile } from "../core/task-parser.js";
import type { ChildDraft, DecompositionTopology } from "./decompose-types.js";

/**
 * Convert a parent task spec into the non-dispatchable tracker that owns a
 * finalized decomposition. This is pure so every writer can validate the
 * complete replacement before touching the source file.
 */
export function buildDecompositionTrackerContent(
  parentContent: string,
  topology: DecompositionTopology,
  drafts: readonly ChildDraft[],
): string {
  const childIds = topology.subtasks.map((subtask) => subtask.id);
  const draftById = new Map(drafts.map((draft) => [draft.subtaskId, draft]));

  if (
    drafts.length !== childIds.length ||
    draftById.size !== childIds.length ||
    childIds.some((childId) => !draftById.has(childId))
  ) {
    throw new Error(
      `Cannot rewrite ${topology.parentTaskId}: child drafts do not match the finalized topology`,
    );
  }

  if (!/(\*\*Status:\*\*\s*)\S+/.test(parentContent)) {
    throw new Error(`Cannot rewrite ${topology.parentTaskId}: parent status metadata is missing`);
  }
  if (!/(\*\*Blocks:\*\*\s*)\[.*?\]/.test(parentContent)) {
    throw new Error(`Cannot rewrite ${topology.parentTaskId}: parent Blocks metadata is missing`);
  }

  const tableRows = topology.subtasks
    .map((subtask) => {
      const draft = draftById.get(subtask.id);
      const dependencies = subtask.dependsOn.length > 0 ? subtask.dependsOn.join(", ") : "—";
      return `| \`${subtask.id}\` | ${draft?.title ?? subtask.title} | ${dependencies} | prep ${draft?.prepScore ?? 0} |`;
    })
    .join("\n");

  const decompositionSummary =
    `\n\n## Decomposition Summary\n\n` +
    `This task has been decomposed into ${childIds.length} child task(s). ` +
    `It is now a tracker task and should not be dispatched directly while the child chain is active.\n\n` +
    `| Child | Scope | Depends On | Ready Gate |\n` +
    `|-------|-------|------------|------------|\n` +
    tableRows;

  let updatedParent = parentContent
    .replace(/(\*\*Status:\*\*\s*)\S+/, "$1DECOMPOSED")
    .replace(/(\*\*Blocks:\*\*\s*)\[.*?\]/, `$1[${childIds.join(", ")}]`);

  if (!updatedParent.includes("## Decomposition Summary")) {
    updatedParent += decompositionSummary;
  }

  const parsed = parseTaskFile(updatedParent);
  if (
    parsed.id !== topology.parentTaskId ||
    parsed.status !== "DECOMPOSED" ||
    childIds.some((childId) => !parsed.blocks.includes(childId))
  ) {
    throw new Error(
      `Cannot rewrite ${topology.parentTaskId}: generated tracker failed identity or dependency validation`,
    );
  }

  return updatedParent;
}
