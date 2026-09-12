import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PrepWorker } from "../../src/monitor/prep-worker";
import * as trustedNodeLaunch from "../../src/monitor/trusted-node-launch";

jest.setTimeout(30_000);

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("PrepWorker trusted process boundary", () => {
  let tempRoot: string;
  let worker: PrepWorker | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-worker-test-"));
  });

  afterEach(async () => {
    worker?.beginTerminalDrain();
    worker?.killAll();
    if (worker) await worker.waitForIdle();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("launches prep through canonical Node when cwd shadows node.exe", async () => {
    const scriptPath = path.join(tempRoot, "prep-result.cjs");
    fs.writeFileSync(
      scriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        "  schemaValid: true, schemaErrors: [], depthScore: 5, depthReady: true,",
        "  deficiencies: [], outcome: 'pass', runtime: process.execPath",
        "}));",
      ].join("\n"),
      "utf8",
    );
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error("SystemRoot is required for this Windows test");
      fs.copyFileSync(
        path.join(systemRoot, "System32", "cmd.exe"),
        path.join(tempRoot, "node.exe"),
      );
    }

    worker = new PrepWorker(tempRoot, scriptPath);
    const job = worker.start("TASK-PREP-NODE");
    await waitFor(() => job.status !== "running", "prep completion");

    expect(job.error).toBeUndefined();
    expect(job.status).toBe("completed");
    expect(job.result).toEqual(expect.objectContaining({ schemaValid: true, outcome: "pass" }));
  });

  test("terminal drain permanently fences new prep launches", () => {
    const scriptPath = path.join(tempRoot, "must-not-run.cjs");
    const markerPath = path.join(tempRoot, "unexpected-launch.txt");
    fs.writeFileSync(
      scriptPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran", "utf8");`,
      "utf8",
    );
    worker = new PrepWorker(tempRoot, scriptPath);

    worker.beginTerminalDrain();

    expect(() => worker!.start("TASK-PREP-DRAINED")).toThrow(
      "Prep admission is closed because the monitor is shutting down.",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(worker.getActiveJobs()).toEqual([]);
  });

  test("stays non-idle until child stdio has emitted close", async () => {
    const scriptPath = path.join(tempRoot, "prep-close-boundary.cjs");
    fs.writeFileSync(
      scriptPath,
      "process.stdout.write(JSON.stringify({ schemaValid: true, schemaErrors: [], depthScore: 5, depthReady: true, deficiencies: [], outcome: 'pass' }));",
      "utf8",
    );
    worker = new PrepWorker(tempRoot, scriptPath);
    const job = worker.start("TASK-PREP-CLOSE");
    const internals = worker as unknown as {
      processes: Map<string, import("node:child_process").ChildProcess>;
    };
    const child = internals.processes.get(job.taskId)!;
    const liveAtExit = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(worker!.hasLiveProcesses()));
    });

    expect(await liveAtExit).toBe(true);
    await expect(worker.waitForIdle()).resolves.toBe(true);
    expect(worker.hasLiveProcesses()).toBe(false);
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest("stops detached prep descendants through the Job Object", async () => {
    const readyPath = path.join(tempRoot, "prep-ready.json");
    const heartbeatPath = path.join(tempRoot, "prep-heartbeat.txt");
    const taskkillMarker = path.join(tempRoot, "taskkill-shadow-ran");
    const childScript = path.join(tempRoot, "prep-descendant.cjs");
    const ownerScript = path.join(tempRoot, "prep-owner.cjs");
    fs.writeFileSync(
      childScript,
      [
        "const fs = require('node:fs');",
        `const heartbeat = ${JSON.stringify(heartbeatPath)};`,
        "setInterval(() => fs.writeFileSync(heartbeat, String(Date.now()), 'utf8'), 20);",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      ownerScript,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: child.pid }), 'utf8');`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "taskkill.cmd"),
      `@echo off\r\n>"${taskkillMarker}" echo hijacked\r\n`,
      "utf8",
    );

    worker = new PrepWorker(tempRoot, ownerScript);
    const job = worker.start("TASK-PREP-STOP");
    await waitFor(
      () => fs.existsSync(readyPath) && fs.existsSync(heartbeatPath),
      "prep descendant",
    );
    const { pid: descendantPid } = JSON.parse(fs.readFileSync(readyPath, "utf8")) as {
      pid: number;
    };

    expect(worker.stop(job.taskId)).toBe(true);
    await waitFor(() => job.status === "failed", "prep stop completion");

    expect(job.error).toBe("Prep stopped by operator");
    expect(() => process.kill(descendantPid, 0)).toThrow();
    expect(fs.existsSync(taskkillMarker)).toBe(false);
  });

  windowsTest("keeps prep active when process-tree stop proof is unavailable", async () => {
    const scriptPath = path.join(tempRoot, "prep-refusal.cjs");
    fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);", "utf8");
    worker = new PrepWorker(tempRoot, scriptPath);
    const job = worker.start("TASK-PREP-REFUSAL");
    const stopSpy = jest
      .spyOn(trustedNodeLaunch, "terminateWindowsNodeJob")
      .mockReturnValue({ confirmed: false, warning: "synthetic missing proof" });

    expect(worker.killAll()).toBe(false);
    expect(job.status).toBe("running");
    expect(job.error).toBe("synthetic missing proof");
    expect(worker.getActiveJobs()).toContain(job);

    stopSpy.mockRestore();
    expect(worker.killAll()).toBe(true);
    await waitFor(() => job.status === "failed", "confirmed prep stop");
  });

  windowsTest(
    "retains an unconfirmed exited prep until trusted absence proof succeeds",
    async () => {
      const scriptPath = path.join(tempRoot, "prep-exit-race.cjs");
      fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 500);", "utf8");
      worker = new PrepWorker(tempRoot, scriptPath);
      const job = worker.start("TASK-PREP-EXIT-RACE");
      const stopSpy = jest
        .spyOn(trustedNodeLaunch, "terminateWindowsNodeJob")
        .mockReturnValue({ confirmed: false, warning: "synthetic missing proof" });

      expect(worker.killAll()).toBe(false);
      const internals = worker as unknown as {
        processes: Map<string, import("node:child_process").ChildProcess>;
      };
      await waitFor(() => {
        const child = internals.processes.get(job.taskId);
        return child !== undefined && child.exitCode !== null;
      }, "unconfirmed prep wrapper exit");
      expect(worker.getActiveJobs()).toContain(job);
      expect(internals.processes.has(job.taskId)).toBe(true);

      stopSpy.mockRestore();
      expect(worker.killAll()).toBe(true);
      await expect(worker.waitForIdle()).resolves.toBe(true);
      expect(job.status).toBe("failed");
      expect(worker.getActiveJobs()).not.toContain(job);
      expect(internals.processes.has(job.taskId)).toBe(false);
    },
  );
});
