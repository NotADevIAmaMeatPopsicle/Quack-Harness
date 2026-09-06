// ─── Producer A tests (TASK-1312) ───────────────────────────────────

import {
  assertBranchDeletionAllowed,
  classifyGitMutation,
  DEFAULT_PROTECTED_BRANCHES,
  resolveProtectedBranches,
} from "../../../src/judgment/producers/branch-mutation";
import type { AdapterGitConfig } from "../../../src/core/types";

function gitConfig(overrides: Partial<AdapterGitConfig> = {}): AdapterGitConfig {
  return {
    baseBranch: "main",
    branchPrefix: "quack/",
    commitFormat: "{message}",
    commitTrailer: "",
    autoCreatePr: false,
    autoPush: false,
    ...overrides,
  };
}

describe("resolveProtectedBranches", () => {
  it("defaults to the shared four-branch set unioned with baseBranch", () => {
    expect(resolveProtectedBranches(gitConfig())).toEqual(["main", "dev", "staging", "prod"]);
  });

  it("unions a non-default baseBranch in", () => {
    expect(resolveProtectedBranches(gitConfig({ baseBranch: "trunk" }))).toEqual([
      "main",
      "dev",
      "staging",
      "prod",
      "trunk",
    ]);
  });

  it("configured branches never lose the baseBranch (round-1 weakening guard)", () => {
    const resolved = resolveProtectedBranches(
      gitConfig({ protectedBranches: ["release"], baseBranch: "dev" }),
    );
    expect(resolved).toEqual(["release", "dev"]);
  });

  it("deduplicates", () => {
    const resolved = resolveProtectedBranches(
      gitConfig({ protectedBranches: ["main", "dev"], baseBranch: "main" }),
    );
    expect(resolved).toEqual(["main", "dev"]);
  });

  it("exports the shared default set", () => {
    expect(DEFAULT_PROTECTED_BRANCHES).toEqual(["main", "dev", "staging", "prod"]);
  });
});

describe("classifyGitMutation", () => {
  const protectedSet = ["main", "dev", "staging", "prod"];

  it("classifies a protected-branch delete with candidate code", () => {
    const facts = classifyGitMutation("git push origin --delete main", protectedSet);
    expect(facts).toHaveLength(1);
    expect(facts[0].mutationClass).toBe("branch_delete");
    expect(facts[0].targetRef).toBe("main");
    expect(facts[0].candidateSafetyCode).toBe("protected_branch_delete");
  });

  it("classifies a task-branch delete WITHOUT candidate code", () => {
    const facts = classifyGitMutation("git branch -D quack/TASK-42", protectedSet);
    expect(facts[0].mutationClass).toBe("branch_delete");
    expect(facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("targetless history rewrites endanger every ref: candidate code set", () => {
    const facts = classifyGitMutation("git reflog expire --expire=now --all", protectedSet);
    expect(facts[0].mutationClass).toBe("history_rewrite");
    expect(facts[0].candidateSafetyCode).toBe("protected_branch_history_rewrite");
  });

  it("targeted history rewrite on a protected ref: candidate code set", () => {
    const facts = classifyGitMutation("git update-ref -d refs/heads/main", protectedSet);
    expect(facts[0].candidateSafetyCode).toBe("protected_branch_history_rewrite");
  });

  it("force-push to a TASK branch is NOT a protected-history candidate (round-2 precision)", () => {
    const facts = classifyGitMutation("git push --force origin quack/TASK-9", protectedSet);
    expect(facts[0].mutationClass).toBe("history_rewrite");
    expect(facts[0].targetRef).toBe("quack/TASK-9");
    expect(facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("force-push to a protected branch IS a candidate", () => {
    const facts = classifyGitMutation("git push --force origin main", protectedSet);
    expect(facts[0].candidateSafetyCode).toBe("protected_branch_history_rewrite");
  });

  it("bare force-push (no parseable target) is NOT promoted", () => {
    const facts = classifyGitMutation("git push --force", protectedSet);
    expect(facts[0].mutationClass).toBe("history_rewrite");
    expect(facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("multi-target deletes yield one fact per target (round-2)", () => {
    const facts = classifyGitMutation(
      "git push origin --delete quack/TASK-1 main quack/TASK-2",
      protectedSet,
    );
    expect(facts).toHaveLength(3);
    const protectedFact = facts.find((f) => f.targetRef === "main");
    expect(protectedFact?.candidateSafetyCode).toBe("protected_branch_delete");
    expect(facts.filter((f) => f.candidateSafetyCode).length).toBe(1);
  });

  it("multi-target local branch delete yields one fact per branch", () => {
    const facts = classifyGitMutation("git branch -D quack/TASK-1 dev", protectedSet);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.targetRef === "dev")?.candidateSafetyCode).toBe(
      "protected_branch_delete",
    );
  });

  it("plain write verbs classify without candidate codes", () => {
    const facts = classifyGitMutation("git commit -m x", protectedSet);
    expect(facts[0].mutationClass).toBe("write");
    expect(facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("compound commands yield facts per matching segment", () => {
    const facts = classifyGitMutation(
      "cd . && git push origin --delete dev; git remote set-url origin x",
      protectedSet,
    );
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.mutationClass).sort()).toEqual(["branch_delete", "remote_redirect"]);
  });

  it("returns empty for read commands", () => {
    expect(classifyGitMutation("git status", protectedSet)).toEqual([]);
  });
});

describe("assertBranchDeletionAllowed", () => {
  const protectedSet = ["main", "dev", "staging", "prod"];

  it("refuses protected branches with a reason", () => {
    const check = assertBranchDeletionAllowed("main", protectedSet);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("main");
  });

  it("normalizes refs/heads/ and origin/ prefixes", () => {
    expect(assertBranchDeletionAllowed("refs/heads/dev", protectedSet).allowed).toBe(false);
    expect(assertBranchDeletionAllowed("origin/prod", protectedSet).allowed).toBe(false);
  });

  it("allows task branches", () => {
    expect(assertBranchDeletionAllowed("quack/TASK-1312", protectedSet).allowed).toBe(true);
  });

  it("refuses shell-metacharacter branch names fail-closed (round-2 injection guard)", () => {
    for (const name of [
      "x; git branch -D prod #",
      "a&&b",
      "evil`cmd`",
      "sp ace",
      "$(rm -rf)",
      "a|b",
    ]) {
      const check = assertBranchDeletionAllowed(name, protectedSet);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("invalid name");
    }
  });

  it("still allows normal ref characters", () => {
    expect(assertBranchDeletionAllowed("feature/x_1.2-rc", protectedSet).allowed).toBe(true);
  });
});
