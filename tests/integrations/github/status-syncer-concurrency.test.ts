import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../../../src/core/adapter-loader";
import { syncAllTasks } from "../../../src/integrations/github/status-syncer";
import { createDivergentTaskFixture, writeTestAdapter } from "../../helpers/divergent-task-fixture";

function waitForChildMessage(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (message) => {
      if ((message as { type?: string }).type === "locked") resolve();
      else reject(new Error(`Unexpected child message: ${JSON.stringify(message)}`));
    });
  });
}

function waitForChildExit(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock-holder child exited ${String(code)}: ${stderr()}`));
    });
  });
}

describe("TASK-1341: syncAllTasks transaction locking", () => {
  it("waits for a cross-process lock before reading or mutating the sync map", async () => {
    const fixture = createDivergentTaskFixture("parent-first", {
      prefix: "quack-sync-all-lock-",
      parent: { status: "READY" },
    });
    writeTestAdapter(fixture.root, { reportBack: false });
    const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(
      syncPath,
      JSON.stringify(
        {
          entries: [
            {
              taskId: "TASK-100",
              issueNumber: 42,
              direction: "published",
              createdAt: "2026-09-08T00:00:00.000Z",
              lastSyncedAt: "2026-09-08T00:00:00.000Z",
              issueState: "open",
              taskStatus: "READY",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const adapter = await loadAdapter(fixture.root);

    const childSource = String.raw`
      const fs = require("node:fs/promises");
      const os = require("node:os");
      const syncPath = process.argv[1];
      const lockPath = syncPath + ".lock";
      (async () => {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({
          version: 2,
          ownerToken: "00000000-0000-4000-8000-000000000100",
          pid: process.pid,
          host: os.hostname(),
          acquiredAt: new Date().toISOString(),
          processIdentity: { bootId: "child-test-boot", startedAt: "1" },
        }));
        if (process.send) process.send({ type: "locked" });
        await new Promise((resolve) => process.once("message", resolve));
        await handle.close();
        await fs.unlink(lockPath);
      })().then(() => process.exit(0)).catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const child = spawn(process.execPath, ["-e", childSource, syncPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let childStderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf-8");
    });

    try {
      await waitForChildMessage(child);
      let firstSettled = false;
      let secondSettled = false;
      const firstSync = syncAllTasks(adapter.config, adapter.projectRoot).finally(() => {
        firstSettled = true;
      });
      const secondSync = syncAllTasks(adapter.config, adapter.projectRoot).finally(() => {
        secondSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      const bothWaitedForLock = !firstSettled && !secondSettled;

      child.send("release");
      const [firstOutcome, secondOutcome] = await Promise.all([
        firstSync,
        secondSync,
        waitForChildExit(child, () => childStderr),
      ]);

      expect(bothWaitedForLock).toBe(true);
      expect(firstOutcome).toEqual(secondOutcome);
      expect(firstOutcome.outcomes).toHaveLength(1);
      expect(firstOutcome.outcomes[0]).toMatchObject({
        taskId: "TASK-100",
        outcome: "synced",
      });
      expect(() => {
        JSON.parse(fs.readFileSync(syncPath, "utf-8"));
      }).not.toThrow();
    } finally {
      if (child.exitCode === null) {
        child.send("release");
        child.kill();
      }
      fixture.cleanup();
    }
  }, 10_000);
});
