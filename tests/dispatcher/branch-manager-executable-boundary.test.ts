import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import {
  abandonBranch,
  createBranch,
  hasSealableProgress,
} from "../../src/dispatcher/branch-manager";
import { resolveTrustedExecutable } from "../../src/worker/trusted-executable";

const TEST_GIT_EXECUTABLE = resolveTrustedExecutable(
  "git",
  path.resolve(__dirname, "..", ".."),
  "test Git",
);

function git(cwd: string, args: string[]): string {
  return execFileSync(TEST_GIT_EXECUTABLE, ["-C", cwd, ...args], {
    cwd: path.dirname(TEST_GIT_EXECUTABLE),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeAdapter(projectRoot: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "branch-boundary-test",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 7 },
  };
  return {
    config,
    projectRoot,
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
    trustedLocalReadRemotePaths: [path.join(path.dirname(projectRoot), "origin.git")],
  };
}

describe("branch-manager Git executable boundary", () => {
  let fixtureRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-branch-git-boundary-"));
    const origin = path.join(fixtureRoot, "origin.git");
    projectRoot = path.join(fixtureRoot, "project");
    await fs.mkdir(projectRoot);
    git(fixtureRoot, ["init", "--bare", origin]);
    git(projectRoot, ["init", "-b", "main"]);
    git(projectRoot, ["config", "user.email", "quack@example.test"]);
    git(projectRoot, ["config", "user.name", "Quack Test"]);
    await fs.mkdir(path.join(projectRoot, "src"));
    await fs.writeFile(path.join(projectRoot, "src", "feature.ts"), "export const value = 1;\n");
    git(projectRoot, ["add", "src/feature.ts"]);
    git(projectRoot, ["commit", "-m", "initial"]);
    git(projectRoot, ["remote", "add", "origin", origin]);
    git(projectRoot, ["push", "-u", "origin", "main"]);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest.each(["git.exe", "git.cmd"])(
    "keeps pre-worker, resume, and failure paths off a worktree-local %s",
    async (shadowName) => {
      const marker = path.join(projectRoot, "shadow-ran.txt");
      if (shadowName.endsWith(".exe")) {
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        if (!systemRoot) throw new Error("SystemRoot is required for the Windows regression");
        await fs.copyFile(
          path.join(systemRoot, "System32", "where.exe"),
          path.join(projectRoot, shadowName),
        );
      } else {
        await fs.writeFile(
          path.join(projectRoot, shadowName),
          "@echo off\r\necho shadow>shadow-ran.txt\r\nexit /b 91\r\n",
          "utf8",
        );
      }

      const adapter = makeAdapter(projectRoot);
      await expect(createBranch("TASK-BOUNDARY", adapter)).resolves.toEqual({
        success: true,
        branchName: "quack/TASK-BOUNDARY",
      });

      await fs.writeFile(path.join(projectRoot, "src", "feature.ts"), "export const value = 2;\n");
      await expect(hasSealableProgress(adapter, "main")).resolves.toBe(true);
      await expect(abandonBranch("TASK-BOUNDARY", adapter)).resolves.toEqual({
        success: true,
        branchName: "quack/TASK-BOUNDARY",
      });
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
