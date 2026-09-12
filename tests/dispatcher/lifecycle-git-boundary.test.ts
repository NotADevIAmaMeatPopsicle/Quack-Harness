import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import { atomicCommit } from "../../src/dispatcher/lifecycle-manager.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("lifecycle atomic Git boundary", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-lifecycle-git-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.test"]);
    git(root, ["config", "user.name", "Quack Test"]);
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-500.md"), "Status: READY\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("ignores cwd Git shadows and repository hooks while committing task specs", () => {
    const shadowMarker = path.join(root, "git-shadow-ran.txt");
    const hookMarker = path.join(root, "pre-commit-hook-ran.txt");
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(root, "git.cmd"),
        `@echo off\r\necho shadow>"${shadowMarker}"\r\nexit /b 91\r\n`,
      );
    } else {
      const shadow = path.join(root, "git");
      fs.writeFileSync(shadow, `#!/bin/sh\necho shadow > '${shadowMarker}'\nexit 91\n`);
      fs.chmodSync(shadow, 0o755);
    }
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, `#!/bin/sh\necho hook > '${hookMarker}'\nexit 92\n`);
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-500.md"), "Status: COMPLETE\n");

    const adapter = {
      projectRoot: root,
      config: { project: { taskDir: "docs/tasks" } },
    } as ProjectAdapter;

    expect(atomicCommit("TASK-500", adapter, root, [])).toBeUndefined();
    expect(fs.existsSync(shadowMarker)).toBe(false);
    expect(fs.existsSync(hookMarker)).toBe(false);
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("[TASK-500] lifecycle: mark complete");
  });
});
