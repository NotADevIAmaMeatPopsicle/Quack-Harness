import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DockerIsolationConfig } from "../../src/core/types";
import {
  clearDockerPublicationRecovery,
  initializeDockerPublicationRecovery,
  publishDockerPromotedResult,
} from "../../src/dispatcher/docker-host-publication";
import { DockerManager } from "../../src/dispatcher/docker-manager";

const execFileAsync = promisify(execFile);
const describeWithDocker = process.env.QUACK_RUN_DOCKER_E2E === "1" ? describe : describe.skip;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return String(result.stdout).trim();
}

describeWithDocker("DockerManager real Docker isolation", () => {
  jest.setTimeout(120_000);

  test("commits privately, leaves authoritative Git untouched, then host-publishes and auto-merges", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-e2e-"));
    const projectRoot = path.join(tempRoot, "project");
    const remoteRoot = path.join(tempRoot, "origin.git");
    const taskId = "TASK-DOCKER-E2E";
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
    const stateRoot = path.join(tempRoot, "state");
    const config: DockerIsolationConfig = {
      image: process.env.QUACK_DOCKER_E2E_IMAGE ?? "node:22-bookworm",
      volumes: [],
      envPassthrough: [],
      resourceLimits: { memoryMb: 512, cpus: 1 },
      networkMode: "none",
      cleanupPolicy: "remove",
    };
    let manager: DockerManager | undefined;

    try {
      fs.mkdirSync(path.join(projectRoot, ".quack", "prep"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, ".quack", "adapter.json"),
        `${JSON.stringify(
          {
            version: "1.0",
            project: {
              name: "docker-e2e",
              root: ".",
              taskDir: "docs/tasks",
              conventionsDir: "docs",
            },
            agent: {
              model: "fixture",
              judgeModel: "fixture",
              enrichModel: "fixture",
              maxTurns: 10,
              maxBudgetPerTask: 1,
              maxRetries: 0,
            },
            verification: {
              commands: [{ name: "noop", command: "true", required: true, timeout: 1000 }],
              conventionChecks: [],
            },
            sandbox: { writablePaths: ["source.txt"], deniedPaths: [] },
            git: {
              baseBranch: "main",
              branchPrefix: "quack/",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "",
              autoPush: true,
              autoCreatePr: false,
              autoMerge: true,
              autoMergeTarget: "main",
              autoMergeStrategy: "squash",
              branchCleanup: { enabled: false },
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 1 },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectRoot, "docs", "tasks", `${taskId}.md`),
        `# ${taskId}: Docker publication fixture\n\n## Metadata\n- **Priority:** P1-HIGH\n- **Effort:** 1 hour\n- **Status:** READY\n- **Blocked By:** []\n- **Tags:** [test]\n\n## Problem Statement\nExercise private Git publication.\n\n## Current State\nThe fixture is unchanged.\n\n## Recommended Approach\nCommit one isolated edit.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| source.txt | Modify | Add one line |\n\n## Success Criteria\n- [ ] The host publishes the exact container commit.\n\n## Testing Requirements\n- [ ] Verify the source checkout is untouched before host promotion.\n`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectRoot, ".gitignore"),
        ".quack/worktrees/\n.quack/logs/\n.quack/prep/\n",
        "utf-8",
      );
      fs.writeFileSync(path.join(projectRoot, "source.txt"), "authoritative\n", "utf-8");
      await git(projectRoot, "init", "--initial-branch=main");
      await git(projectRoot, "config", "user.email", "quack-e2e@example.invalid");
      await git(projectRoot, "config", "user.name", "Quack E2E");
      await git(projectRoot, "add", ".");
      await git(projectRoot, "commit", "-m", "initial");
      await git(tempRoot, "init", "--bare", remoteRoot);
      await git(projectRoot, "remote", "add", "origin", remoteRoot);
      await git(projectRoot, "push", "-u", "origin", "main");
      await git(
        projectRoot,
        "worktree",
        "add",
        "-b",
        "quack/TASK-DOCKER-E2E",
        worktreePath,
        "HEAD",
      );

      manager = new DockerManager(projectRoot, config, stateRoot);
      await manager.checkDocker();
      const container = await manager.createContainer(taskId, worktreePath);
      const child = manager.execAgent(container.containerId, [
        "sh",
        "-lc",
        [
          "git config --global --add safe.directory /workspace",
          "git config user.email quack-e2e@example.invalid",
          "git config user.name 'Quack E2E'",
          "test ! -e /quack-git",
          '! sh -c "printf tamper >> /quack-git-objects/info/quack-tamper"',
          '! sh -c "printf tamper > /workspace/.git"',
          '! sh -c "printf tamper > /workspace/.quack/adapter.json"',
          '! sh -c "printf tamper > /workspace/.quack/prep/forged.json"',
          "printf 'container commit\\n' >> source.txt",
          "git add source.txt",
          "git commit -m 'container commit'",
        ].join(" && "),
      ]);
      let stderr = "";
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const [exitCode] = (await once(child, "close")) as [number | null];
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/fatal:|error:/i);

      await manager.stopContainer(container.containerId);
      const results = await manager.extractResults(container);
      expect(results.branch).toBe("quack/TASK-DOCKER-E2E");
      expect(results.log).toContain("container commit");
      expect(
        fs.readFileSync(path.join(worktreePath, "source.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("authoritative\ncontainer commit\n");
      expect(fs.readFileSync(path.join(projectRoot, "source.txt"), "utf-8")).toBe(
        "authoritative\n",
      );
      expect(
        (await git(projectRoot, "show", "quack/TASK-DOCKER-E2E:source.txt")).replace(/\r\n/g, "\n"),
      ).toBe("authoritative");

      const publicationId = randomUUID();
      const gitState = manager.preparePrivateGitForPublication(container, publicationId);
      const publicationOptions = {
        recovery: {
          rootDir: path.join(stateRoot, "publication"),
          publicationId,
          gitState,
          worktreePath,
          worktreeSessionId: `quack-${taskId}-${randomUUID()}`,
          worktreeOwnershipId: publicationId,
          preserveWorktree: false,
        },
      };
      await initializeDockerPublicationRecovery(
        taskId,
        projectRoot,
        "quack/TASK-DOCKER-E2E",
        publicationOptions,
      );
      manager.sealPreparedPublicationRef(gitState);
      const publication = await publishDockerPromotedResult(
        taskId,
        projectRoot,
        "quack/TASK-DOCKER-E2E",
        publicationOptions,
      );
      expect(publication.autoMerged).toBe(true);
      expect(
        (await git(projectRoot, "show", "quack/TASK-DOCKER-E2E:source.txt")).replace(/\r\n/g, "\n"),
      ).toBe("authoritative\ncontainer commit");
      expect((await git(projectRoot, "show", "main:source.txt")).replace(/\r\n/g, "\n")).toBe(
        "authoritative\ncontainer commit",
      );
      expect(await git(projectRoot, "show", `origin/main:source.txt`)).toContain(
        "container commit",
      );
      expect(manager.releaseSealedPublicationRef(gitState)).toBe(true);
      expect(publication.recoveryPath).toBeDefined();
      expect(clearDockerPublicationRecovery(publication.recoveryPath!, publicationId)).toBe(true);
    } finally {
      if (manager) await manager.cleanupAll({ includeRetained: true });
      try {
        await git(projectRoot, "worktree", "remove", "--force", worktreePath);
      } catch {
        // Best-effort test cleanup after an earlier setup failure.
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
