import { resolveTargetBranch } from "../../src/dispatcher/branch-resolver";
import type { AdapterGitConfig } from "../../src/core/types";

const baseGitConfig: AdapterGitConfig = {
  baseBranch: "main",
  branchPrefix: "quack/",
  commitFormat: "[{taskId}] {message}",
  commitTrailer: "Implemented-by: Quack Agent",
  autoCreatePr: true,
  autoPush: true,
  autoMerge: true,
  autoMergeTarget: "main",
  autoMergeStrategy: "squash",
};

describe("resolveTargetBranch", () => {
  test("uses explicit task target branch over all other routing", () => {
    const config: AdapterGitConfig = {
      ...baseGitConfig,
      branchGroups: {
        feature: {
          baseBranch: "feature/web-dashboard-ui",
          taskPattern: "^TASK-5\\d\\d$",
        },
      },
    };

    const resolved = resolveTargetBranch("TASK-559", "feature/manual-override", config);
    expect(resolved.baseBranch).toBe("feature/manual-override");
    expect(resolved.autoMergeTarget).toBe("feature/manual-override");
    expect(resolved.groupName).toBeUndefined();
  });

  test("uses matching branch group pattern when task has no explicit target", () => {
    const config: AdapterGitConfig = {
      ...baseGitConfig,
      branchGroups: {
        "web-app": {
          baseBranch: "feature/web-dashboard-ui",
          autoMergeTarget: "feature/web-dashboard-ui",
          taskPattern: "^TASK-(55[9-9]|56\\d|57[0-5])$",
        },
      },
    };

    const resolved = resolveTargetBranch("TASK-570", undefined, config);
    expect(resolved.baseBranch).toBe("feature/web-dashboard-ui");
    expect(resolved.autoMergeTarget).toBe("feature/web-dashboard-ui");
    expect(resolved.groupName).toBe("web-app");
  });

  test("falls back to adapter base and merge target when no group matches", () => {
    const config: AdapterGitConfig = {
      ...baseGitConfig,
      baseBranch: "HardFixTest",
      autoMergeTarget: "HardFixTest",
      branchGroups: {
        "web-app": {
          baseBranch: "feature/web-dashboard-ui",
          taskPattern: "^TASK-55\\d$",
        },
      },
    };

    const resolved = resolveTargetBranch("TASK-712", undefined, config);
    expect(resolved.baseBranch).toBe("HardFixTest");
    expect(resolved.autoMergeTarget).toBe("HardFixTest");
    expect(resolved.groupName).toBeUndefined();
  });

  test("falls back autoMergeTarget to group base branch when omitted", () => {
    const config: AdapterGitConfig = {
      ...baseGitConfig,
      branchGroups: {
        release: {
          baseBranch: "release/v2",
          taskPattern: "^TASK-9\\d\\d$",
        },
      },
    };

    const resolved = resolveTargetBranch("TASK-901", undefined, config);
    expect(resolved.baseBranch).toBe("release/v2");
    expect(resolved.autoMergeTarget).toBe("release/v2");
    expect(resolved.groupName).toBe("release");
  });

  test("ignores invalid group regex and continues gracefully", () => {
    const config: AdapterGitConfig = {
      ...baseGitConfig,
      branchGroups: {
        broken: {
          baseBranch: "feature/broken",
          taskPattern: "[invalid-regex(",
        },
        sane: {
          baseBranch: "feature/sane",
          taskPattern: "^TASK-777$",
        },
      },
    };

    const resolved = resolveTargetBranch("TASK-777", undefined, config);
    expect(resolved.baseBranch).toBe("feature/sane");
    expect(resolved.groupName).toBe("sane");
  });
});
