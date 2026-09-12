import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  cleanupTrustedNodeLaunch,
  confirmWindowsNodeLaunchAlreadyExited,
  spawnTrustedNode,
  terminateWindowsNodeJob,
} from "../../src/monitor/trusted-node-launch";

jest.setTimeout(30_000);

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("trusted monitor Node launch", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-trusted-node-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("uses canonical Node instead of a cwd-local executable shadow", async () => {
    const projectRoot = path.join(tempRoot, "project & shell metachar");
    fs.mkdirSync(projectRoot);
    const outputPath = path.join(projectRoot, "runtime.txt");
    const scriptPath = path.join(projectRoot, "record runtime.cjs");
    fs.writeFileSync(
      scriptPath,
      `require("node:fs").writeFileSync(process.argv[2], process.execPath, "utf8");`,
      "utf8",
    );
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error("SystemRoot is required for this Windows test");
      fs.copyFileSync(
        path.join(systemRoot, "System32", "cmd.exe"),
        path.join(projectRoot, "node.exe"),
      );
      fs.copyFileSync(
        path.join(systemRoot, "System32", "cmd.exe"),
        path.join(projectRoot, "powershell.exe"),
      );
    }

    const launch = spawnTrustedNode({
      projectRoot,
      scriptPath,
      args: [outputPath],
      cwd: projectRoot,
      env: { ...process.env, PATH: `${projectRoot}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    try {
      const [code] = (await once(launch.child, "exit")) as [number | null];
      expect(code).toBe(0);
      expect(fs.realpathSync.native(fs.readFileSync(outputPath, "utf8"))).toBe(
        fs.realpathSync.native(process.execPath),
      );
    } finally {
      cleanupTrustedNodeLaunch(launch);
    }
  });

  test("preserves the Node program exit code through the Windows wrapper", async () => {
    const scriptPath = path.join(tempRoot, "exit-seven.cjs");
    fs.writeFileSync(scriptPath, "process.exit(7);", "utf8");
    const launch = spawnTrustedNode({
      projectRoot: tempRoot,
      scriptPath,
      args: [],
      cwd: tempRoot,
      env: process.env,
    });
    try {
      const [code] = (await once(launch.child, "exit")) as [number | null];
      if (launch.windowsJob) {
        expect(
          fs.readFileSync(path.join(launch.windowsJob.tempRoot, "node.exit"), "utf8").trim(),
        ).toBe("7");
        expect(confirmWindowsNodeLaunchAlreadyExited(launch)).toBe(true);
      }
      expect(code).toBe(7);
    } finally {
      cleanupTrustedNodeLaunch(launch);
    }
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest(
    "terminates a detached descendant and proves the Job Object is empty without taskkill",
    async () => {
      const readyPath = path.join(tempRoot, "ready.json");
      const heartbeatPath = path.join(tempRoot, "heartbeat.txt");
      const taskkillMarker = path.join(tempRoot, "taskkill-shadow-ran");
      const childScript = path.join(tempRoot, "descendant.cjs");
      const ownerScript = path.join(tempRoot, "owner.cjs");
      fs.writeFileSync(
        childScript,
        [
          "const fs = require('node:fs');",
          "const heartbeat = process.argv[2];",
          "setInterval(() => fs.writeFileSync(heartbeat, String(Date.now()), 'utf8'), 20);",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        ownerScript,
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          "const [childScript, ready, heartbeat] = process.argv.slice(2);",
          "const child = spawn(process.execPath, [childScript, heartbeat], { detached: true, stdio: 'ignore' });",
          "fs.writeFileSync(ready, JSON.stringify({ pid: child.pid }), 'utf8');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        path.join(tempRoot, "taskkill.cmd"),
        `@echo off\r\n>"${taskkillMarker}" echo hijacked\r\n`,
        "utf8",
      );
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error("SystemRoot is required for this Windows test");
      fs.copyFileSync(
        path.join(systemRoot, "System32", "where.exe"),
        path.join(tempRoot, "taskkill.exe"),
      );

      const launch = spawnTrustedNode({
        projectRoot: tempRoot,
        scriptPath: ownerScript,
        args: [childScript, readyPath, heartbeatPath],
        cwd: tempRoot,
        env: { ...process.env, PATH: `${tempRoot}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      const exitPromise = once(launch.child, "exit");
      try {
        await waitForFile(readyPath);
        await waitForFile(heartbeatPath);
        const { pid: descendantPid } = JSON.parse(fs.readFileSync(readyPath, "utf8")) as {
          pid: number;
        };

        const originalPath = process.env.PATH;
        let result: ReturnType<typeof terminateWindowsNodeJob>;
        try {
          process.env.PATH = `${tempRoot}${path.delimiter}${originalPath ?? ""}`;
          result = terminateWindowsNodeJob(launch.windowsJob!);
        } finally {
          process.env.PATH = originalPath;
        }
        expect(result).toEqual({ confirmed: true });
        await exitPromise;

        expect(() => process.kill(descendantPid, 0)).toThrow();
        const finalHeartbeat = fs.readFileSync(heartbeatPath, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(fs.readFileSync(heartbeatPath, "utf8")).toBe(finalHeartbeat);
        expect(fs.existsSync(taskkillMarker)).toBe(false);
      } finally {
        cleanupTrustedNodeLaunch(launch);
      }
    },
  );

  windowsTest(
    "cleans up a detached pipe-inheriting descendant after the Node root exits",
    async () => {
      const readyPath = path.join(tempRoot, "normal-exit-ready.json");
      const heartbeatPath = path.join(tempRoot, "normal-exit-heartbeat.txt");
      const childScript = path.join(tempRoot, "normal-exit-descendant.cjs");
      const ownerScript = path.join(tempRoot, "normal-exit-owner.cjs");
      fs.writeFileSync(
        childScript,
        [
          "const fs = require('node:fs');",
          "const heartbeat = process.argv[2];",
          "setInterval(() => fs.writeFileSync(heartbeat, String(Date.now()), 'utf8'), 20);",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        ownerScript,
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          "const [childScript, ready, heartbeat] = process.argv.slice(2);",
          "const child = spawn(process.execPath, [childScript, heartbeat], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          "fs.writeFileSync(ready, JSON.stringify({ pid: child.pid }), 'utf8');",
          "setTimeout(() => process.exit(0), 200);",
        ].join("\n"),
        "utf8",
      );

      const launch = spawnTrustedNode({
        projectRoot: tempRoot,
        scriptPath: ownerScript,
        args: [childScript, readyPath, heartbeatPath],
        cwd: tempRoot,
        env: process.env,
      });
      try {
        await waitForFile(readyPath);
        await waitForFile(heartbeatPath);
        const { pid: descendantPid } = JSON.parse(fs.readFileSync(readyPath, "utf8")) as {
          pid: number;
        };
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const exit = once(launch.child, "exit");
        const timeoutFailure = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("contained wrapper did not exit")), 10_000);
        });
        let code: number | null;
        try {
          [code] = (await Promise.race([exit, timeoutFailure])) as [number | null];
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        expect(code).toBe(0);
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        if (launch.child.exitCode === null) {
          terminateWindowsNodeJob(launch.windowsJob!);
        }
        cleanupTrustedNodeLaunch(launch);
      }
    },
  );
});
