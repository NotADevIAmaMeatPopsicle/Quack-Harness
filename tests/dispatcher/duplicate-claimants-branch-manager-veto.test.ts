// TASK-1338-B pre-change record: all four target-branch-only duplicate arms
// executed and FAILED at the intended success:false assertion after commit and
// push. REJECTED is the non-updatable CONTROL for the earlier no-write
// return; COMPLETE separately proves the recovery path is idempotent.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { listDuplicateClaimants } from "../../src/core/task-file-resolver";
import { updateTaskFileStatus } from "../../src/dispatcher/branch-manager";
import {
  DUPLICATE_FIXTURE_CASES,
  type DuplicateFixtureKind,
  type DuplicateFixtureOrder,
  taskSpec,
} from "../helpers/duplicate-claimants-fixture";

jest.setTimeout(120_000);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The provisioned Codex sandbox rejects git child processes. CI and admin
// runs do not set CODEX_THREAD_ID and execute the real-repository suite.
const gitAvailable = process.env.CODEX_THREAD_ID === undefined;

const describeWithGit = gitAvailable ? describe : describe.skip;
const itWithGit = gitAvailable ? it : it.skip;

interface RepoFixture {
  root: string;
  origin: string;
  project: string;
  claimants: string[];
  adapter: ProjectAdapter;
}

function createRepoFixture(
  kind: DuplicateFixtureKind | "single",
  order: DuplicateFixtureOrder,
  status = "READY",
): RepoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-branch-veto-"));
  const origin = path.join(root, "origin.git");
  const project = path.join(root, "project");
  git(root, ["init", "--bare", origin]);
  git(root, ["clone", origin, project]);
  git(project, ["config", "user.email", "quack-test@example.com"]);
  git(project, ["config", "user.name", "Quack Test"]);
  git(project, ["config", "commit.gpgsign", "false"]);
  git(project, ["checkout", "-b", "dev"]);

  const taskDir = path.join(project, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const names =
    kind === "single"
      ? ["TASK-100-a.md"]
      : kind === "candidate-scoped"
        ? ["TASK-100-a.md", "TASK-100-b.md"]
        : ["TASK-100-a.md", "TASK-999-b.md"];
  const entries = names.map((name) => [name, taskSpec("TASK-100", { status })] as const);
  for (const [name, content] of order === "forward" ? entries : [...entries].reverse()) {
    fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
  }
  git(project, ["add", "docs/tasks"]);
  git(project, ["commit", "-m", "target branch fixture"]);
  git(project, ["push", "-u", "origin", "dev"]);

  // The checked-out admin branch has one claimant. The contest exists only
  // on origin/dev, so an entry-side query in the caller would false-green.
  git(project, ["checkout", "-b", "admin"]);
  for (const name of names.slice(1)) fs.rmSync(path.join(taskDir, name));
  if (names.length > 1) {
    git(project, ["add", "docs/tasks"]);
    git(project, ["commit", "-m", "admin branch has one claimant"]);
  }

  return {
    root,
    origin,
    project,
    claimants: [...names].sort(),
    adapter: {
      projectRoot: project,
      config: { project: { taskDir: "docs/tasks" } },
    } as ProjectAdapter,
  };
}

describeWithGit.each(DUPLICATE_FIXTURE_CASES)(
  "branch-manager duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses inside the target-branch worktree before write, stage, commit, or push", async () => {
      const fixture = createRepoFixture(kind, order);
      try {
        expect(
          await listDuplicateClaimants(path.join(fixture.project, "docs", "tasks"), "TASK-100"),
        ).toEqual([]);
        const beforeSha = git(fixture.root, [
          "--git-dir",
          fixture.origin,
          "rev-parse",
          "refs/heads/dev",
        ]);
        const beforeTree = git(fixture.root, [
          "--git-dir",
          fixture.origin,
          "show",
          "refs/heads/dev:docs/tasks/TASK-100-a.md",
        ]);

        const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev");

        expect(result.success).toBe(false);
        expect(result.error).toContain("TASK-100");
        for (const claimant of fixture.claimants) expect(result.error).toContain(claimant);
        expect(
          git(fixture.root, ["--git-dir", fixture.origin, "rev-parse", "refs/heads/dev"]),
        ).toBe(beforeSha);
        expect(
          git(fixture.root, [
            "--git-dir",
            fixture.origin,
            "show",
            "refs/heads/dev:docs/tasks/TASK-100-a.md",
          ]),
        ).toBe(beforeTree);
        expect(git(fixture.project, ["status", "--porcelain"])).toBe("");
        expect(fs.existsSync(path.join(fixture.project, ".quack", "tmp-status-update"))).toBe(
          false,
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  },
);

itWithGit("non-updatable status returns before the veto", async () => {
  const fixture = createRepoFixture("cross-population", "forward", "REJECTED");
  try {
    const beforeSha = git(fixture.root, [
      "--git-dir",
      fixture.origin,
      "rev-parse",
      "refs/heads/dev",
    ]);
    const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No updatable status");
    expect(git(fixture.root, ["--git-dir", fixture.origin, "rev-parse", "refs/heads/dev"])).toBe(
      beforeSha,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

itWithGit("an already-complete target is an idempotent success before the veto", async () => {
  const fixture = createRepoFixture("cross-population", "forward", "COMPLETE");
  try {
    const beforeSha = git(fixture.root, [
      "--git-dir",
      fixture.origin,
      "rev-parse",
      "refs/heads/dev",
    ]);
    const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev");
    expect(result).toEqual({ success: true });
    expect(git(fixture.root, ["--git-dir", fixture.origin, "rev-parse", "refs/heads/dev"])).toBe(
      beforeSha,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

itWithGit("updates and pushes normally with one claimant", async () => {
  const fixture = createRepoFixture("single", "forward");
  try {
    const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev");
    expect(result).toEqual({ success: true });
    expect(
      git(fixture.root, [
        "--git-dir",
        fixture.origin,
        "show",
        "refs/heads/dev:docs/tasks/TASK-100-a.md",
      ]),
    ).toContain("**Status:** COMPLETE");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
