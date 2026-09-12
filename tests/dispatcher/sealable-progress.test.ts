// ─── hasSealableProgress real-git tests (TASK-1314 F1) ──────────────
// The resume progress check must see the progress workers can ACTUALLY
// produce: dirty sealable work with zero commits (workers cannot
// commit — the sealer commits post-worker). A mocked generic diff
// cannot prove this (round-1's exact critique of the old test), so
// these run against real temp repositories.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import { hasSealableProgress } from "../../src/dispatcher/branch-manager";
import { parseStatus } from "../../src/dispatcher/output-snapshot";

jest.setTimeout(30000);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepoAdapter(repoDir: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "progress-test",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: ["src/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
  };
  return {
    config,
    projectRoot: repoDir,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("hasSealableProgress (real git)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-progress-"));
    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "quack@example.test"]);
    git(repoDir, ["config", "user.name", "Quack Test"]);
    fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
    git(repoDir, ["add", "base.txt"]);
    git(repoDir, ["commit", "-m", "base"]);
    git(repoDir, ["branch", "-M", "main"]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("clean tree with no commits beyond base is NOT progress", async () => {
    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(false);
  });

  it("dirty tracked + untracked sealable work with ZERO commits IS progress", async () => {
    fs.writeFileSync(path.join(repoDir, "base.txt"), "modified\n");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "new-work.ts"), "export {};\n");
    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(true);
  });

  it("a transient-only tree (sealer-EXCLUDED paths) is NOT progress", async () => {
    fs.mkdirSync(path.join(repoDir, ".quack", "logs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".quack", "logs", "session.jsonl"), "{}\n");
    fs.mkdirSync(path.join(repoDir, ".quack", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".quack", "evidence", "x.json"), "{}\n");
    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(false);
  });

  it("committed-only work still counts as progress (existing behavior preserved)", async () => {
    git(repoDir, ["checkout", "-b", "quack/TASK-042"]);
    fs.writeFileSync(path.join(repoDir, "committed.txt"), "work\n");
    git(repoDir, ["add", "committed.txt"]);
    git(repoDir, ["commit", "-m", "work"]);
    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(true);
  });

  it("quoted renames and non-ASCII names classify as REAL sealable paths (round-2 F1)", async () => {
    // A staged rename whose paths git C-quotes (spaces), plus an
    // untracked non-ASCII name (octal-escaped by default quotepath).
    fs.writeFileSync(path.join(repoDir, "old name.txt"), "x\n");
    git(repoDir, ["add", "old name.txt"]);
    git(repoDir, ["commit", "-m", "add spaced file"]);
    git(repoDir, ["mv", "old name.txt", "new name.txt"]);
    fs.writeFileSync(path.join(repoDir, "café.txt"), "y\n");

    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(true);

    // The shared classification preserves BOTH rename endpoints so
    // `git commit --only` records the deletion as well as the destination.
    // Only the destination and untracked file exist in the worktree; the
    // source is intentionally absent after `git mv`.
    const statusOut = execFileSync("git", ["status", "--short"], {
      cwd: repoDir,
    }).toString();
    const { included, includedToStage } = parseStatus(statusOut);
    expect(included).toContain("old name.txt");
    expect(included).toContain("new name.txt");
    expect(included).toContain("café.txt");
    expect(fs.existsSync(path.join(repoDir, "old name.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, "new name.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, "café.txt"))).toBe(true);
    expect(includedToStage).toEqual(["café.txt"]);
  });

  it("an excluded-path rename is NOT progress (round-2 F1)", async () => {
    fs.mkdirSync(path.join(repoDir, ".quack", "logs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".quack", "logs", "old log.jsonl"), "{}\n");
    git(repoDir, ["add", "-f", ".quack/logs/old log.jsonl"]);
    git(repoDir, ["commit", "-m", "log file"]);
    git(repoDir, ["mv", ".quack/logs/old log.jsonl", ".quack/logs/new log.jsonl"]);

    await expect(hasSealableProgress(makeRepoAdapter(repoDir))).resolves.toBe(false);
  });
});
