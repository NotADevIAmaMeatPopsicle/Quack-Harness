// TASK-1338-B pre-change record: all four target-branch-only duplicate arms
// executed and FAILED at the intended success:false assertion after commit and
// push. The ON_HOLD-status target is a CONTROL for the earlier no-write
// return and is covered behaviorally by the READY matrix.

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

const MOCK_REPOSITORY = { host: "github.com", owner: "org", repo: "repo" } as const;
const MOCK_PUSH_URL = "https://github.com/org/repo.git";
let mockTransportFixture: { project: string; origin: string };
let mockPublicationPushes: Array<{
  projectRoot: string;
  args: readonly string[];
  expectedRepository: unknown;
}>;

// Keep real Git reads, worktrees, commits, and bare-repository writes. Only the
// audited GitHub identity and exact status push delivery are fixture boundaries:
// the fake push URL is never contacted, and no other transport can escape.
jest.mock("../../src/worker/trusted-executable", () => {
  const actual = jest.requireActual<typeof import("../../src/worker/trusted-executable")>(
    "../../src/worker/trusted-executable",
  );
  return {
    ...actual,
    resolveTrustedGitHubRepository: async (
      projectRoot: string,
      options: Parameters<typeof actual.resolveTrustedGitHubRepository>[1],
    ) => {
      expect(projectRoot).toBe(mockTransportFixture.project);
      const result = await actual.runTrustedGitResult(
        projectRoot,
        ["remote", "get-url", "--push", "--all", "origin"],
        { timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(MOCK_PUSH_URL);
      return actual.parseTrustedGitHubRepository(result.stdout);
    },
    runTrustedGitResult: (
      projectRoot: string,
      args: readonly string[],
      options: Parameters<typeof actual.runTrustedGitResult>[2],
    ) => {
      if (args[0] === "fetch") {
        expect(projectRoot).toBe(mockTransportFixture.project);
        expect(args).toEqual(["fetch", "origin", "dev:refs/remotes/origin/dev"]);
        expect(options.trustedLocalReadRemotePaths).toEqual([mockTransportFixture.origin]);
        expect(git(projectRoot, ["remote", "get-url", "origin"])).toBe(mockTransportFixture.origin);
      } else if (["clone", "ls-remote", "send-pack", "pull"].includes(args[0] ?? "")) {
        throw new Error("Unexpected transport in the local status-publication fixture");
      }
      if (args[0] !== "push") return actual.runTrustedGitResult(projectRoot, args, options);

      mockPublicationPushes.push({
        projectRoot,
        args,
        expectedRepository: options.expectedRepository,
      });
      expect(projectRoot).toBe(
        path.join(mockTransportFixture.project, ".quack", "tmp-status-update"),
      );
      expect(options.expectedRepository).toEqual(MOCK_REPOSITORY);
      expect(git(projectRoot, ["remote", "get-url", "--push", "--all", "origin"])).toBe(
        MOCK_PUSH_URL,
      );
      const headOid = git(projectRoot, ["rev-parse", "HEAD"]);
      expect(headOid).toMatch(/^[a-f0-9]{40,64}$/u);
      expect(args).toEqual(["push", "origin", `${headOid}:refs/heads/dev`]);
      const executable = actual.resolveTrustedExecutable(
        "git",
        projectRoot,
        "branch-veto fixture Git",
      );
      const stdout = execFileSync(
        executable,
        ["-C", projectRoot, "push", mockTransportFixture.origin, `${headOid}:refs/heads/dev`],
        {
          cwd: path.dirname(executable),
          encoding: "utf8",
          env: actual.buildTrustedGitEnvironment(executable),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
    },
  };
});

jest.setTimeout(120_000);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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
  git(project, ["remote", "set-url", "--push", "origin", MOCK_PUSH_URL]);
  mockTransportFixture = { project, origin };
  mockPublicationPushes = [];

  return {
    root,
    origin,
    project,
    claimants: [...names].sort(),
    adapter: {
      projectRoot: project,
      config: { project: { taskDir: "docs/tasks" } },
      trustedLocalReadRemotePaths: [origin],
    } as ProjectAdapter,
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
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

        const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev", {
          host: "github.com",
          owner: "org",
          repo: "repo",
        });

        expect(result.success).toBe(false);
        expect(mockPublicationPushes).toEqual([]);
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

it("non-updatable status returns before the veto", async () => {
  const fixture = createRepoFixture("cross-population", "forward", "ON_HOLD");
  try {
    const beforeSha = git(fixture.root, [
      "--git-dir",
      fixture.origin,
      "rev-parse",
      "refs/heads/dev",
    ]);
    const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev", {
      host: "github.com",
      owner: "org",
      repo: "repo",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No updatable status");
    expect(mockPublicationPushes).toEqual([]);
    expect(git(fixture.root, ["--git-dir", fixture.origin, "rev-parse", "refs/heads/dev"])).toBe(
      beforeSha,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

it("updates and pushes normally with one claimant", async () => {
  const fixture = createRepoFixture("single", "forward");
  try {
    const beforeSha = git(fixture.root, [
      "--git-dir",
      fixture.origin,
      "rev-parse",
      "refs/heads/dev",
    ]);
    const result = await updateTaskFileStatus("TASK-100", fixture.adapter, "dev", {
      host: "github.com",
      owner: "org",
      repo: "repo",
    });
    expect(result).toEqual({ success: true });
    const publishedSha = git(fixture.root, [
      "--git-dir",
      fixture.origin,
      "rev-parse",
      "refs/heads/dev",
    ]);
    expect(publishedSha).not.toBe(beforeSha);
    expect(mockPublicationPushes).toEqual([
      {
        projectRoot: path.join(fixture.project, ".quack", "tmp-status-update"),
        args: ["push", "origin", `${publishedSha}:refs/heads/dev`],
        expectedRepository: MOCK_REPOSITORY,
      },
    ]);
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
