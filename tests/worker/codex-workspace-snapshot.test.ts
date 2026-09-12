import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { captureWorkspaceSnapshot } from "../../src/worker/codex-agent-worker";

describe("Codex workspace snapshots", () => {
  let repositoryRoot: string;

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-codex-snapshot-"));
    execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.email", "quack-test@example.invalid"], {
      cwd: repositoryRoot,
    });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: repositoryRoot });
    fs.writeFileSync(path.join(repositoryRoot, "tracked.txt"), "baseline\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repositoryRoot });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: repositoryRoot });
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it("captures a detached dispatch worktree without treating it as an error", async () => {
    execFileSync("git", ["checkout", "--detach", "-q", "HEAD"], { cwd: repositoryRoot });

    const snapshot = await captureWorkspaceSnapshot(repositoryRoot, 10_000);

    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.branch).toBe("HEAD");
    expect(snapshot.entries).toEqual({});
  });

  const windowsTest = process.platform === "win32" ? it : it.skip;
  windowsTest("does not execute a repository-local git.exe shadow", async () => {
    const commandInterpreter = process.env.ComSpec;
    if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
    fs.copyFileSync(commandInterpreter, path.join(repositoryRoot, "git.exe"));

    const snapshot = await captureWorkspaceSnapshot(repositoryRoot, 10_000);

    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.entries["git.exe"]?.status).toBe("??");
  });
});
