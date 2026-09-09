import { execFile } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DockerIsolationConfig } from "../../src/core/types";
import { DockerManager } from "../../src/dispatcher/docker-manager";

const execFileAsync = promisify(execFile);
const describeWithDocker = process.env.QUACK_RUN_DOCKER_E2E === "1" ? describe : describe.skip;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return String(result.stdout).trim();
}

describeWithDocker("DockerManager real Docker isolation", () => {
  jest.setTimeout(120_000);

  test("commits in the task worktree and leaves the authoritative checkout untouched", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-e2e-"));
    const projectRoot = path.join(tempRoot, "project");
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
      fs.writeFileSync(path.join(projectRoot, "source.txt"), "authoritative\n", "utf-8");
      await git(projectRoot, "init");
      await git(projectRoot, "config", "user.email", "quack-e2e@example.invalid");
      await git(projectRoot, "config", "user.name", "Quack E2E");
      await git(projectRoot, "add", "source.txt");
      await git(projectRoot, "commit", "-m", "initial");
      await git(projectRoot, "worktree", "add", "--detach", worktreePath, "HEAD");

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
          "git switch -c quack/TASK-DOCKER-E2E",
          "printf 'container commit\\n' >> source.txt",
          "git add source.txt",
          "git commit -m 'container commit'",
          "printf 'container pending\\n' >> source.txt",
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

      const results = await manager.extractResults(container.containerId);
      expect(results.branch).toBe("quack/TASK-DOCKER-E2E");
      expect(results.log).toContain("container commit");
      expect(results.diff).toContain("container pending");
      expect(
        fs.readFileSync(path.join(worktreePath, "source.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("authoritative\ncontainer commit\ncontainer pending\n");
      expect(fs.readFileSync(path.join(projectRoot, "source.txt"), "utf-8")).toBe(
        "authoritative\n",
      );
      expect(
        (await git(projectRoot, "show", "quack/TASK-DOCKER-E2E:source.txt")).replace(/\r\n/g, "\n"),
      ).toBe("authoritative\ncontainer commit");
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
