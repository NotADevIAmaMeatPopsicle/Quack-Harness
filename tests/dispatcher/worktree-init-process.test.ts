import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import { runContainedWorktreeInitCommand } from "../../src/dispatcher/worktree-init-process.js";

function quoteShellArgument(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

describe("contained worktree-init process", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-init-process-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("runs a command from a cwd containing spaces and records containment", async () => {
    const cwd = path.join(tmpDir, "directory with spaces");
    await fs.mkdir(cwd);
    await Promise.all([
      fs.writeFile(path.join(cwd, "powershell.exe"), "cwd shadow binary", "utf8"),
      fs.writeFile(path.join(cwd, "cmd.exe"), "cwd shadow binary", "utf8"),
    ]);
    const command = [
      quoteShellArgument(process.execPath),
      "-e",
      quoteShellArgument("process.stdout.write('contained-ok')"),
    ].join(" ");

    const result = await runContainedWorktreeInitCommand({
      command,
      cwd,
      env: process.env,
      timeoutMs: 10_000,
      maxBufferBytes: 1024 * 1024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("contained-ok");
    expect(result.descendantsContained).toBe(true);
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest("preserves cmd metacharacters in structured argv and cwd paths", async () => {
    const cwd = path.join(tmpDir, "repo & (demo) %QUACK_MISSING% !");
    const marker = path.join(cwd, "structured-argv.txt");
    const payload = "amp&pipe|less<than>caret^percent%QUACK_MISSING%bang!paren()";
    await fs.mkdir(cwd);
    const script = 'require("node:fs").writeFileSync(process.argv[1],process.argv[2],"utf8")';

    const result = await runContainedWorktreeInitCommand({
      executable: process.execPath,
      args: ["-e", script, marker, payload],
      cwd,
      env: process.env,
      timeoutMs: 10_000,
      maxBufferBytes: 1024 * 1024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.descendantsContained).toBe(true);
    expect(await fs.readFile(marker, "utf8")).toBe(payload);
  });

  test("kills a timed-out command tree before returning", async () => {
    const childScript = path.join(tmpDir, "child.cjs");
    const parentScript = path.join(tmpDir, "parent.cjs");
    const pidFile = path.join(tmpDir, "child.pid");
    await fs.writeFile(path.join(tmpDir, "taskkill.exe"), "cwd shadow binary", "utf8");
    await fs.writeFile(childScript, "setInterval(() => undefined, 1000);\n", "utf8");
    await fs.writeFile(
      parentScript,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[3], String(child.pid));",
        "child.unref();",
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
      "utf8",
    );
    const command = [
      quoteShellArgument(process.execPath),
      quoteShellArgument(parentScript),
      quoteShellArgument(childScript),
      quoteShellArgument(pidFile),
    ].join(" ");

    const result = await runContainedWorktreeInitCommand({
      command,
      cwd: tmpDir,
      env: process.env,
      timeoutMs: 1_500,
      maxBufferBytes: 1024 * 1024,
    });
    const descendantPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);

    try {
      expect(result.timedOut).toBe(true);
      expect(result.descendantsContained).toBe(true);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(descendantPid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          process.kill(descendantPid, "SIGKILL");
        }
      } catch {
        // The expected path already removed the descendant.
      }
    }
  }, 15_000);

  test("fails closed on POSIX hosts without an OS-enforced descendant boundary", async () => {
    const result = await runContainedWorktreeInitCommand({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: tmpDir,
      env: process.env,
      timeoutMs: 10_000,
      maxBufferBytes: 1024,
      platform: "darwin",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("darwin is unsupported");
  });

  const linuxNamespaceAvailable = (() => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/setsid")) return false;
    const probe = spawnSync(
      "/usr/bin/unshare",
      [
        "--user",
        "--map-current-user",
        "--pid",
        "--fork",
        "--kill-child=SIGKILL",
        "--mount-proc",
        "--",
        "/bin/true",
      ],
      { stdio: "ignore", timeout: 5_000 },
    );
    return probe.status === 0;
  })();
  const linuxNamespaceTest = linuxNamespaceAvailable ? test : test.skip;

  linuxNamespaceTest(
    "contains an env-scrubbing setsid escape inside the Linux PID namespace",
    async () => {
      const survivalMarker = path.join(tmpDir, "escaped.txt");
      const escapedScript =
        `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(survivalMarker)},"escaped"),350);` +
        "setInterval(()=>{},1000);";
      const rootScript =
        'const {spawn}=require("node:child_process");' +
        `const child=spawn("/usr/bin/setsid",[process.execPath,"-e",${JSON.stringify(escapedScript)}],` +
        '{detached:true,stdio:"ignore",env:{PATH:process.env.PATH}});' +
        "child.unref();";

      const result = await runContainedWorktreeInitCommand({
        executable: process.execPath,
        args: ["-e", rootScript],
        cwd: tmpDir,
        env: process.env,
        timeoutMs: 10_000,
        maxBufferBytes: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.descendantsContained).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(existsSync(survivalMarker)).toBe(false);
    },
    10_000,
  );
});
