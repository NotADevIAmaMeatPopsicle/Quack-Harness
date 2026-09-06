import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import {
  resolveEvidenceProjectRoot,
  sealAgentOutputAttempt,
} from "../../src/dispatcher/output-snapshot";
import type { IEventWriter } from "../../src/monitor/event-emitter";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("commits task files, excludes transient artifacts, and writes durable evidence", async () => {
    await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".quack", "prep"),
      "/srv/example-service-dev/.quack/prep\n",
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
      "/srv/example-service-dev/.quack/prep\n# leaked-runtime-pointer\n",
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

  test("resolves evidence root from a Quack worktree path", () => {
    const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-861");
    expect(resolveEvidenceProjectRoot(worktreePath)).toBe(path.resolve(tmpDir));
  });
});
