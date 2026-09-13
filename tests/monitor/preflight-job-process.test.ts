import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preflightInput } from "../helpers/preflight-job-fixture";
import { PreflightJobStore } from "../../src/monitor/preflight-job-store";

it("two real processes publish exactly one full-preflight reservation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-preflight-process-"));
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const ready: Promise<void>[] = [];
  const results: Promise<{ jobId: string; created: boolean }>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [path.join(__dirname, "../helpers/preflight-reservation-process.cjs"),
        root, JSON.stringify(preflightInput)], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      exits.push(new Promise((resolve) => child.once("close", () => resolve())));
      ready.push(new Promise((resolve, reject) => {
        child.on("message", (message: { type?: string }) => { if (message.type === "ready") resolve(); });
        child.once("error", reject);
        child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr)); });
      }));
      results.push(new Promise((resolve, reject) => {
        child.on("message", (message: { type?: string; jobId: string; created: boolean }) => {
          if (message.type === "result") resolve(message);
        });
        child.once("error", reject);
        child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr)); });
      }));
    }
    await Promise.all(ready);
    for (const child of children) child.send({ type: "start" });
    const observed = await Promise.all(results);
    expect(observed.filter((result) => result.created)).toHaveLength(1);
    expect(observed[0].jobId).toBe(observed[1].jobId);
    expect(new PreflightJobStore(root, "fixture").latest("TASK-1355")?.jobId).toBe(observed[0].jobId);
    await Promise.all(exits);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(exits);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 45_000);
