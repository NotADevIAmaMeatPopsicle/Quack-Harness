import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import {
  _setOutputSnapshotEvidenceRefsResolvedHook,
  resolveEvidenceProjectRoot,
  sealAgentOutputAttempt,
} from "../../src/dispatcher/output-snapshot";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { resolveTrustedExecutable } from "../../src/worker/trusted-executable";

const TEST_GIT_EXECUTABLE = resolveTrustedExecutable(
  "git",
  path.resolve(__dirname, "..", ".."),
  "test Git",
);

function git(cwd: string, args: string[]): string {
  return execFileSync(TEST_GIT_EXECUTABLE, ["-C", cwd, ...args], {
    cwd: path.dirname(TEST_GIT_EXECUTABLE),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeAdapter(projectRoot: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "seal-test",
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
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 7,
    },
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
  };
}

function makeEvents(): IEventWriter & { emitted: Array<{ stage: string; payload: unknown }> } {
  const emitted: Array<{ stage: string; payload: unknown }> = [];
  return {
    sessionId: "quack-TASK-861-test",
    taskId: "TASK-861",
    project: "seal-test",
    emitted,
    emit(stage, payload) {
      emitted.push({ stage, payload });
    },
    recordSession() {
      // no-op
    },
  };
}

describe("sealAgentOutputAttempt", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-output-seal-"));
    git(tmpDir, ["init", "-b", "main"]);
    git(tmpDir, ["config", "user.email", "quack@example.test"]);
    git(tmpDir, ["config", "user.name", "Quack Test"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 1;\n");
    git(tmpDir, ["add", "src/feature.ts"]);
    git(tmpDir, ["commit", "-m", "initial"]);
    git(tmpDir, ["checkout", "-b", "quack/TASK-861"]);
  });

  afterEach(async () => {
    _setOutputSnapshotEvidenceRefsResolvedHook(undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("commits task files, excludes transient artifacts, and writes durable evidence", async () => {
    await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".quack", "prep"),
      "/root/example-service-dev/.quack/prep\n",
    );
    git(tmpDir, ["add", ".quack/prep"]);
    git(tmpDir, ["commit", "-m", "tracked prep pointer"]);

    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 2;\n");
    await fs.writeFile(path.join(tmpDir, "PROGRESS.md"), "temporary\n");
    await fs.mkdir(path.join(tmpDir, ".quack", "runtime-prep"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".quack", "analytics"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".quack", "federation", "jobs"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".quack", "reviews"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".quack", "verify-worktrees", "TASK-863-manual-1"), {
      recursive: true,
    });
    await fs.writeFile(path.join(tmpDir, ".quack", "verified.json"), "{}\n");
    await fs.writeFile(
      path.join(tmpDir, ".quack", "prep"),
      "/root/example-service-dev/.quack/prep\n# leaked-runtime-pointer\n",
    );
    await fs.writeFile(path.join(tmpDir, ".quack", "runtime-prep", "TASK-861.json"), "{}\n");
    await fs.writeFile(path.join(tmpDir, ".quack", "analytics", "failure-patterns.json"), "{}\n");
    await fs.writeFile(
      path.join(tmpDir, ".quack", "federation", "jobs", "fed-task-861.json"),
      "{}\n",
    );
    await fs.writeFile(path.join(tmpDir, ".quack", "reviews", "latest-by-task.json"), "{}\n");
    await fs.writeFile(
      path.join(tmpDir, ".quack", "verify-worktrees", "TASK-863-manual-1", "marker.txt"),
      "runtime\n",
    );

    const events = makeEvents();
    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events,
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.filesStaged).toBe(1);
    expect(snapshot.changedFiles).toContain("src/feature.ts");
    expect(snapshot.excludedFiles).toContain("PROGRESS.md");
    expect(snapshot.excludedFiles).toContain(".quack/prep");
    expect(snapshot.excludedFiles).toContain(".quack/analytics/");
    expect(snapshot.excludedFiles).toContain(".quack/federation/");
    expect(snapshot.excludedFiles).toContain(".quack/reviews/");
    expect(snapshot.excludedFiles).toContain(".quack/verify-worktrees/");
    expect(snapshot.excludedFiles.some((file) => file.startsWith(".quack"))).toBe(true);
    expect(snapshot.changedFiles).not.toEqual(
      expect.arrayContaining([
        ".quack/analytics/failure-patterns.json",
        ".quack/federation/jobs/fed-task-861.json",
        ".quack/reviews/latest-by-task.json",
        ".quack/verify-worktrees/TASK-863-manual-1/marker.txt",
      ]),
    );
    expect(snapshot.gitDiff).toContain("value = 2");
    expect(snapshot.manifestPath).toContain(path.join(".quack", "evidence", "TASK-861"));
    await expect(fs.stat(snapshot.manifestPath)).resolves.toBeDefined();
    await expect(fs.stat(snapshot.diffPath)).resolves.toBeDefined();

    const status = git(tmpDir, ["status", "--short"]);
    expect(status).toContain("PROGRESS.md");
    expect(status).toContain(".quack/");
    expect(git(tmpDir, ["log", "--oneline", "main..HEAD"])).toContain("sealed agent output");
    expect(events.emitted.map((event) => event.stage)).toEqual(
      expect.arrayContaining(["agent_output_seal_start", "auto_commit", "agent_output_sealed"]),
    );
  });

  test("prefers existing remote base when fetch is unavailable and local base is stale", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "base-only.ts"), "export const base = true;\n");
    git(tmpDir, ["add", "src/base-only.ts"]);
    git(tmpDir, ["commit", "-m", "base moved"]);
    const remoteBaseSha = git(tmpDir, ["rev-parse", "HEAD"]);
    git(tmpDir, ["update-ref", "refs/remotes/origin/main", remoteBaseSha]);
    git(tmpDir, ["checkout", "--detach", "HEAD"]);
    git(tmpDir, ["branch", "-f", "main", "HEAD~1"]);
    git(tmpDir, ["checkout", "-B", "quack/TASK-861", "refs/remotes/origin/main"]);

    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 3;\n");

    const events = makeEvents();
    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events,
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.diffRef).toBe("origin/main");
    expect(snapshot.baseSha).toBe(remoteBaseSha);
    expect(snapshot.changedFiles).toEqual(["src/feature.ts"]);
    expect(snapshot.changedFiles).not.toContain("src/base-only.ts");
  });

  test("refreshes a local bare origin when the operator explicitly authorizes it", async () => {
    const remoteFixture = await fs.mkdtemp(path.join(os.tmpdir(), "quack-output-origin-"));
    const originRoot = path.join(remoteFixture, "origin.git");
    const updaterRoot = path.join(remoteFixture, "updater");
    try {
      git(remoteFixture, ["init", "--bare", "--initial-branch=main", originRoot]);
      git(tmpDir, ["remote", "add", "origin", originRoot]);
      git(tmpDir, ["push", "origin", "main"]);
      git(tmpDir, ["fetch", "origin", "main:refs/remotes/origin/main"]);

      git(remoteFixture, ["clone", "--branch", "main", originRoot, updaterRoot]);
      git(updaterRoot, ["config", "user.email", "quack@example.test"]);
      git(updaterRoot, ["config", "user.name", "Quack Test"]);
      await fs.writeFile(path.join(updaterRoot, "remote-only.ts"), "export const remote = true;\n");
      git(updaterRoot, ["add", "remote-only.ts"]);
      git(updaterRoot, ["commit", "-m", "remote base advanced"]);
      git(updaterRoot, ["push", "origin", "main"]);
      const latestRemoteSha = git(updaterRoot, ["rev-parse", "HEAD"]);

      await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 6;\n");
      const adapter = makeAdapter(tmpDir);
      adapter.trustedLocalReadRemotePaths = [originRoot];
      const snapshot = await sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter,
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
        branchName: "quack/TASK-861",
      });

      expect(snapshot.diffRef).toBe("origin/main");
      expect(snapshot.baseSha).toBe(latestRemoteSha);
      expect(git(tmpDir, ["rev-parse", "refs/remotes/origin/main"])).toBe(latestRemoteSha);
    } finally {
      await fs.rm(remoteFixture, { recursive: true, force: true });
    }
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest.each(["git.exe", "git.cmd"])(
    "does not execute a worktree-local %s shadow while sealing output",
    async (shadowName) => {
      const marker = path.join(tmpDir, "shadow-ran.txt");
      if (shadowName.endsWith(".exe")) {
        const commandInterpreter = process.env.ComSpec;
        if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
        await fs.copyFile(commandInterpreter, path.join(tmpDir, shadowName));
      } else {
        await fs.writeFile(
          path.join(tmpDir, shadowName),
          "@echo off\r\necho shadow>shadow-ran.txt\r\nexit /b 91\r\n",
          "utf8",
        );
      }
      await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 4;\n");

      const snapshot = await sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(tmpDir),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
        branchName: "quack/TASK-861",
      });

      expect(snapshot.sealedCommitSha).toMatch(/^[0-9a-f]{40}$/);
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("disables repository Git hooks while sealing output", async () => {
    const marker = path.join(tmpDir, "hook-ran.txt");
    const shellMarker = marker.replace(/\\/g, "/").replace(/'/g, `'"'"'`);
    const hookPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
    await fs.writeFile(hookPath, `#!/bin/sh\nprintf hook > '${shellMarker}'\n`, "utf8");
    await fs.chmod(hookPath, 0o755);
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 5;\n");

    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events: makeEvents(),
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.sealedCommitSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not commit a pre-staged excluded path", async () => {
    await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".quack", "prep"), "runtime-only\n");
    git(tmpDir, ["add", ".quack/prep"]);
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 7;\n");

    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events: makeEvents(),
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.filesStaged).toBe(1);
    expect(snapshot.excludedFiles).toContain(".quack/prep");
    expect(git(tmpDir, ["show", "--format=", "--name-only", "HEAD"])).toBe("src/feature.ts");
    expect(git(tmpDir, ["diff", "--cached", "--name-only"])).toBe(".quack/prep");
    expect(() => git(tmpDir, ["show", "HEAD:.quack/prep"])).toThrow();
  });

  test("commits both endpoints of a pre-staged included rename", async () => {
    git(tmpDir, ["mv", "src/feature.ts", "src/renamed-feature.ts"]);

    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events: makeEvents(),
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.filesStaged).toBe(1);
    expect(git(tmpDir, ["show", "--format=", "--name-status", "HEAD"])).toContain(
      "R100\tsrc/feature.ts\tsrc/renamed-feature.ts",
    );
    expect(git(tmpDir, ["show", "HEAD:src/renamed-feature.ts"])).toBe("export const value = 1;");
    expect(() => git(tmpDir, ["show", "HEAD:src/feature.ts"])).toThrow();
    expect(git(tmpDir, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("refuses an included-to-excluded rename", async () => {
    await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
    const headBefore = git(tmpDir, ["rev-parse", "HEAD"]);
    git(tmpDir, ["mv", "src/feature.ts", ".quack/prep"]);
    const statusBefore = git(tmpDir, ["status", "--short"]);

    await expect(
      sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(tmpDir),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
      }),
    ).rejects.toThrow(/rename across the output inclusion boundary/i);
    expect(git(tmpDir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(tmpDir, ["status", "--short"])).toBe(statusBefore);
  });

  test("refuses an excluded-to-included rename", async () => {
    await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".quack", "prep"), "tracked runtime pointer\n");
    git(tmpDir, ["add", ".quack/prep"]);
    git(tmpDir, ["commit", "-m", "add tracked runtime pointer"]);
    const headBefore = git(tmpDir, ["rev-parse", "HEAD"]);
    git(tmpDir, ["mv", ".quack/prep", "src/from-prep.ts"]);
    const statusBefore = git(tmpDir, ["status", "--short"]);

    await expect(
      sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(tmpDir),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
      }),
    ).rejects.toThrow(/rename across the output inclusion boundary/i);
    expect(git(tmpDir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(tmpDir, ["status", "--short"])).toBe(statusBefore);
  });

  test("refuses to seal when the requested diff base is invalid", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 8;\n");

    await expect(
      sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(tmpDir),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
        diffBase: "refs/heads/does-not-exist",
        branchName: "quack/TASK-861",
      }),
    ).rejects.toThrow(
      /does-not-exist|unknown revision|bad revision|ambiguous argument|needed a single revision/i,
    );
  });

  test("refuses to seal without a proof-bearing HEAD commit", async () => {
    const unbornRoot = path.join(tmpDir, "unborn");
    await fs.mkdir(unbornRoot);
    git(unbornRoot, ["init", "-b", "main"]);
    git(unbornRoot, ["config", "user.email", "quack@example.test"]);
    git(unbornRoot, ["config", "user.name", "Quack Test"]);

    await expect(
      sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(unbornRoot),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
      }),
    ).rejects.toThrow(/HEAD|needed a single revision|valid object name|unknown revision/i);
  });

  test("refuses to seal when a modified-file diff exceeds the trusted Git buffer", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "x".repeat(11 * 1024 * 1024));

    await expect(
      sealAgentOutputAttempt({
        taskId: "TASK-861",
        adapter: makeAdapter(tmpDir),
        events: makeEvents(),
        attempt: 1,
        kind: "worker",
        branchName: "quack/TASK-861",
      }),
    ).rejects.toThrow();
  }, 30_000);

  test("keeps all evidence bound to captured SHAs when HEAD moves", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const value = 9;\n");
    let capturedHead = "";
    _setOutputSnapshotEvidenceRefsResolvedHook(() => {
      capturedHead = git(tmpDir, ["rev-parse", "HEAD"]);
      git(tmpDir, ["reset", "--hard", "main"]);
      return Promise.resolve();
    });

    const snapshot = await sealAgentOutputAttempt({
      taskId: "TASK-861",
      adapter: makeAdapter(tmpDir),
      events: makeEvents(),
      attempt: 1,
      kind: "worker",
      branchName: "quack/TASK-861",
    });

    expect(snapshot.headShaAfter).toBe(capturedHead);
    expect(git(tmpDir, ["rev-parse", "HEAD"])).not.toBe(capturedHead);
    expect(snapshot.gitDiff).toContain("value = 9");
    expect(snapshot.changedFiles).toContain("src/feature.ts");
  });

  test("resolves evidence root from a Quack worktree path", () => {
    const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-861");
    expect(resolveEvidenceProjectRoot(worktreePath)).toBe(path.resolve(tmpDir));
  });
});
