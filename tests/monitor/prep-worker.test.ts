import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { PrepWorker } from "../../src/monitor/prep-worker";

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for prep fixture state");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function forceKillTree(pid: number): void {
  if (!pid || !processExists(pid)) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

describe("PrepWorker shutdown lifecycle", () => {
  jest.setTimeout(15_000);

  let tempDir: string;
  let rootPid = 0;
  let descendantPid = 0;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-prep-worker-"));
  });

  afterEach(async () => {
    forceKillTree(rootPid);
    forceKillTree(descendantPid);
    await fs.rm(tempDir, { recursive: true, force: true });
    rootPid = 0;
    descendantPid = 0;
  });

  it("awaits a real prep process tree before reporting emergency shutdown complete", async () => {
    const descendantPidPath = path.join(tempDir, "descendant.pid");
    const fixturePath = path.join(tempDir, "prep-fixture.cjs");
    await fs.writeFile(
      fixturePath,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const { spawn } = require("node:child_process");',
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
        'fs.writeFileSync(path.join(process.cwd(), "descendant.pid"), String(child.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const worker = new PrepWorker(tempDir, fixturePath);
    const job = worker.start("TASK-PREP-TREE");
    rootPid = job.pid;
    descendantPid = await waitFor(async () => {
      try {
        return Number.parseInt(await fs.readFile(descendantPidPath, "utf8"), 10);
      } catch {
        return undefined;
      }
    });
    expect(processExists(rootPid)).toBe(true);
    expect(processExists(descendantPid)).toBe(true);

    const result = await worker.shutdownAll({
      gracefulTimeoutMs: 500,
      forceTimeoutMs: 2_000,
    });

    expect(result.requested).toEqual(["TASK-PREP-TREE"]);
    expect(result.exited).toEqual(["TASK-PREP-TREE"]);
    expect(result.timedOut).toEqual([]);
    expect(worker.getActiveJobs()).toEqual([]);
    expect(processExists(rootPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
    expect(() => worker.start("TASK-BLOCKED-DURING-STOP")).toThrow("Prep worker is shutting down");
    expect(worker.resumeAfterShutdown()).toBe(true);
  });
});
