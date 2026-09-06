import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { repairProjectState } from "../../src/cli/repair-state";

describe("repairProjectState", () => {
  const originalFetch = global.fetch;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-repair-state-"));
    fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function initGitRepoWithProjectionFiles(): void {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    fs.mkdirSync(path.join(projectRoot, ".quack", "reviews"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "verified.json"),
      JSON.stringify({ tasks: {} }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "reviews", "latest-by-task.json"),
      JSON.stringify({ "TASK-777": "review-task-777" }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "reviews", "review-task-777.json"),
      JSON.stringify(
        {
          reviewId: "review-task-777",
          taskId: "TASK-777",
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
    git([
      "add",
      ".quack/verified.json",
      ".quack/reviews/latest-by-task.json",
      ".quack/reviews/review-task-777.json",
    ]);
  }

  it("rebuilds the DB and writes a federation peer config for future startup sync", async () => {
    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      writePeerConfig: true,
      peerUrl: "http://headnode.test:3333",
      peerProjectId: "example-service",
      serviceTokenEnv: "QUACK_SERVICE_TOKEN",
      serviceToken: "qsvc_test_token",
      pullPeer: false,
    });

    expect(result.dbRepair.finalIntegrity.status).toBe("ok");
    expect(result.peerConfigPath).toBeDefined();
    expect(fs.existsSync(result.peerConfigPath!)).toBe(true);

    const peerConfig = JSON.parse(fs.readFileSync(result.peerConfigPath!, "utf-8")) as {
      url: string;
      remoteProjectId: string;
      serviceTokenEnv: string;
      pushOnWrite: boolean;
    };
    expect(peerConfig).toMatchObject({
      url: "http://headnode.test:3333",
      remoteProjectId: "example-service",
      serviceTokenEnv: "QUACK_SERVICE_TOKEN",
      pushOnWrite: false,
    });

    const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
    expect(fs.existsSync(verifiedPath)).toBe(true);
    const verified = JSON.parse(fs.readFileSync(verifiedPath, "utf-8")) as {
      tasks: Record<string, unknown>;
    };
    expect(verified.tasks).toEqual({});

    // TASK-902: core.worktree fields must be present in result.
    // Non-git temp dir → git config exits non-zero → no leak detected.
    expect(result.coreWorktreeLeaked).toBe(false);
    expect(result.coreWorktreeFixed).toBe(false);
    expect(result.coreWorktreeLeakedValue).toBeUndefined();

    // QPI-048 leg (h) wiring pin: the ghost-prep sweep RUNS inside
    // repairProjectState (a dropped call would leave this field absent).
    expect(result.ghostPrep).toBeDefined();
    expect(result.ghostPrep.applied).toBe(false);
    expect(result.ghostPrep.ghosts).toEqual([]);
  });

  it("QPI-048 leg (h): the sweep detects ghosts through the full repair flow", async () => {
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    // A real SPEC shape: round-2c F1 made the sweep's parent check
    // require the parser's Metadata block, so an H1 alone is a document.
    fs.writeFileSync(
      path.join(taskDir, "TASK-42-parent.md"),
      "# TASK-42: Parent Fixture\n\n## Metadata\n- **Status:** BACKLOG\n",
      "utf-8",
    );
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(path.join(prepDir, "TASK-42-A.json"), "{}", "utf-8");

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
    });
    expect(result.ghostPrep.ghosts).toEqual([
      { taskId: "TASK-42-A", parentId: "TASK-42", files: ["TASK-42-A.json"] },
    ]);
    // Dry-run by default: reported, not removed.
    expect(fs.existsSync(path.join(prepDir, "TASK-42-A.json"))).toBe(true);
  });

  it("pulls verified rows from the configured peer and regenerates the projection", async () => {
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "TASK-777-peer-sync.md"),
      [
        "# TASK-777: Peer sync fixture",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1-2 hours",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** [verification]",
        "",
        "## Problem Statement",
        "Fixture.",
        "",
        "## Success Criteria",
        "- [ ] Fixture works",
      ].join("\n"),
      "utf-8",
    );
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            rows: [
              {
                task_id: "TASK-777",
                verified_at: "2026-05-05",
                updated_at: "2026-05-05T12:00:00.000Z",
                commit_sha: "abc1234",
                method: "/verify-task",
                verdict: "VERIFIED",
                criteria_checked: 3,
                criteria_passed: 3,
                notes: "reviewId=review-task-777-1",
              },
            ],
          }),
      }),
    ) as unknown as typeof fetch;

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      writePeerConfig: true,
      peerUrl: "http://headnode.test:3333",
      peerProjectId: "example-service",
      serviceTokenEnv: "QUACK_SERVICE_TOKEN",
      serviceToken: "qsvc_test_token",
      pullPeer: true,
    });

    expect(result.peerPull.applied).toBe(1);
    expect(result.finalVerifiedRows).toBe(1);

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as {
      tasks: Record<
        string,
        {
          commit: string;
          method: string;
          verdict: string;
        }
      >;
    };
    expect(verified.tasks["TASK-777"]).toMatchObject({
      commit: "abc1234",
      method: "/verify-task",
      verdict: "VERIFIED",
    });

    // TASK-902: core.worktree fields present in pull-peer test too
    expect(result.coreWorktreeLeaked).toBe(false);
    expect(result.coreWorktreeFixed).toBe(false);
  });

  it("detects tracked generated projection files", async () => {
    initGitRepoWithProjectionFiles();

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
    });

    expect(result.projectionHygiene.status).toBe("migration_required");
    expect(result.projectionHygiene.trackedGeneratedFiles).toEqual(
      expect.arrayContaining([".quack/verified.json", ".quack/reviews/latest-by-task.json"]),
    );
    expect(result.projectionHygiene.missingGitignoreEntries).toEqual(
      expect.arrayContaining([".quack/verified.json", ".quack/reviews/latest-by-task.json"]),
    );
  });

  it("dry-runs generated projection migration without writing", async () => {
    initGitRepoWithProjectionFiles();

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
      migrateGeneratedProjections: true,
      dryRun: true,
    });

    expect(result.projectionMigration?.dryRun).toBe(true);
    expect(result.projectionMigration?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "append_gitignore",
          path: ".quack/verified.json",
          applied: false,
        }),
        expect.objectContaining({
          kind: "git_rm_cached",
          path: ".quack/verified.json",
          applied: false,
        }),
      ]),
    );
    expect(fs.existsSync(path.join(projectRoot, ".gitignore"))).toBe(false);
    expect(git(["ls-files", ".quack/verified.json"]).trim()).toBe(".quack/verified.json");
  });

  it("applies generated projection migration without removing review audit bundles", async () => {
    initGitRepoWithProjectionFiles();

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
      migrateGeneratedProjections: true,
      apply: true,
    });

    expect(result.projectionMigration?.dryRun).toBe(false);
    expect(result.projectionHygiene.status).toBe("ok");

    const gitignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".quack/verified.json");
    expect(gitignore).toContain(".quack/reviews/latest-by-task.json");

    expect(git(["ls-files", ".quack/verified.json"]).trim()).toBe("");
    expect(git(["ls-files", ".quack/reviews/latest-by-task.json"]).trim()).toBe("");
    expect(git(["ls-files", ".quack/reviews/review-task-777.json"]).trim()).toBe(
      ".quack/reviews/review-task-777.json",
    );

    expect(() =>
      git(["check-ignore", "--no-index", ".quack/reviews/review-task-777.json"]),
    ).toThrow();
  });

  // TODO(TASK-910): the next two integration-style tests rely on initializing
  // a real git repo in a temp dir and setting core.worktree via execSync.
  // The setup is flaky on Windows (path quoting, stdio:'ignore' hides
  // git init/config failures). The same behavior is unit-tested directly in
  // tests/dispatcher/worktree-cleanup.test.ts using the safeUnsetCoreWorktree
  // surface, so skipping here is safe — but we should rewrite these as
  // unit-style tests against the cleanCoreWorktreeIfLeaked export.
  it.skip("detects and cleans a leaked core.worktree pointing inside .quack/worktrees/", async () => {
    // Initialize a real git repo in the temp dir so git config commands work
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: projectRoot, stdio: "ignore" });

    // Set a leaked core.worktree pointing into .quack/worktrees/
    const leakedValue = path.join(projectRoot, ".quack", "worktrees", "TASK-893-A");
    execSync(`git config --local core.worktree "${leakedValue}"`, {
      cwd: projectRoot,
      stdio: "ignore",
    });

    // Verify the leak is set
    const before = execSync("git config --local --get core.worktree", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    expect(before).toBe(leakedValue);

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
    });

    // repair-state should detect and clean the leaked value
    expect(result.coreWorktreeLeaked).toBe(true);
    expect(result.coreWorktreeFixed).toBe(true);
    expect(result.coreWorktreeLeakedValue).toBe(leakedValue);

    // Verify git config is actually cleaned
    try {
      execSync("git config --local --get core.worktree", {
        cwd: projectRoot,
        encoding: "utf-8",
      });
      // If we get here, the config still exists — fail
      expect("core.worktree still set").toBe("core.worktree unset");
    } catch {
      // git config --get exits non-zero when key is absent — expected
    }
  });

  it.skip("does NOT clean core.worktree pointing outside .quack/worktrees/", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: projectRoot, stdio: "ignore" });

    // Set a core.worktree value that is NOT a Quack worktree path
    const operatorValue = "/some/operator/custom/path";
    execSync(`git config --local core.worktree "${operatorValue}"`, {
      cwd: projectRoot,
      stdio: "ignore",
    });

    const result = await repairProjectState({
      project: projectRoot,
      rebuildDb: true,
      pullPeer: false,
    });

    // Detected as leaked (value exists) but NOT cleaned (not a Quack path)
    expect(result.coreWorktreeLeaked).toBe(true);
    expect(result.coreWorktreeFixed).toBe(false);
    expect(result.coreWorktreeLeakedValue).toBe(operatorValue);

    // Verify the operator's value is preserved
    const after = execSync("git config --local --get core.worktree", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    expect(after).toBe(operatorValue);
  });
});
