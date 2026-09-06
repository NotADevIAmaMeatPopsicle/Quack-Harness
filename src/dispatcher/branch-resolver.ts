import type { AdapterGitConfig } from "../core/types.js";

export interface ResolvedBranchTarget {
  baseBranch: string;
  autoMergeTarget: string;
  groupName?: string;
}

export function resolveBranchGroupForTask(
  taskId: string,
  gitConfig: AdapterGitConfig,
): string | undefined {
  const groups = gitConfig.branchGroups;
  if (!groups) return undefined;

  for (const [name, group] of Object.entries(groups)) {
    if (!group.taskPattern) continue;
    try {
      if (new RegExp(group.taskPattern).test(taskId)) {
        return name;
      }
    } catch {
      // Invalid regex in config -- ignore this group and continue.
    }
  }
  return undefined;
}

/**
 * Resolve effective base/merge branches for a task.
 * Priority:
 * 1. Explicit task-level targetBranch
 * 2. Matching branch group pattern
 * 3. Adapter global defaults
 */
export function resolveTargetBranch(
  taskId: string,
  taskTargetBranch: string | undefined,
  gitConfig: AdapterGitConfig,
): ResolvedBranchTarget {
  if (taskTargetBranch) {
    return {
      baseBranch: taskTargetBranch,
      autoMergeTarget: taskTargetBranch,
    };
  }

  const groupName = resolveBranchGroupForTask(taskId, gitConfig);
  if (groupName && gitConfig.branchGroups) {
    const group = gitConfig.branchGroups[groupName];
    return {
      baseBranch: group.baseBranch,
      autoMergeTarget: group.autoMergeTarget ?? group.baseBranch,
      groupName,
    };
  }

  return {
    baseBranch: gitConfig.baseBranch,
    autoMergeTarget: gitConfig.autoMergeTarget ?? gitConfig.baseBranch,
  };
}
