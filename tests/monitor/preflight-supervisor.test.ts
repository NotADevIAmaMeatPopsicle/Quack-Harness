import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OwnedCommandWorker } from "../../src/monitor/owned-command-worker";
import { PrepWorker } from "../../src/monitor/prep-worker";
import { FULL_PREFLIGHT_OUTPUT_LIMIT, parsePreflightJobEnvelope } from "../../src/monitor/preflight-job-result";
import { fullPreflightReport } from "../helpers/preflight-job-fixture";

class FakeChild extends EventEmitter {
  pid = 45454;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe("full-preflight shared supervision", () => {
  let root: string;
  let child: FakeChild;
  let worker: OwnedCommandWorker<ReturnType<typeof fullPreflightReport>>;
  const persist = jest.fn();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-full-supervisor-"));
    child = new FakeChild();
    persist.mockClear();
    worker = new OwnedCommandWorker(root, "fixture.js", {
      platform: "linux", spawnProcess: (() => child as unknown as ChildProcess) as typeof spawn,
    }, {
      label: "Preflight", survivorNamespace: "preflight-shutdown-survivors",
      outputLimit: FULL_PREFLIGHT_OUTPUT_LIMIT, outputUnit: "bytes",
      commandArgs: (taskId, jobId) => ["preflight", taskId, "--json", "--job-id", jobId],
      parseResult: parsePreflightJobEnvelope,
      store: { read: () => undefined, write: persist },
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function finish(code = 0): void {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
  }

  it("accepts a large Unicode report split across byte boundaries only after close", () => {
    const job = worker.start("TASK-1355");
    const result = fullPreflightReport();
    result.blueprint.formattedMarkdown = "🙂".repeat(100_000);
    const payload = Buffer.from(JSON.stringify({ jobId: job.jobId, result }));
    for (let offset = 0; offset < payload.length; offset += 101) child.stdout.emit("data", payload.subarray(offset, offset + 101));
    child.emit("exit", 0, null);
    expect(job.status).toBe("running");
    expect(persist).not.toHaveBeenCalled();
    finish();
    expect(job.status).toBe("completed");
    expect(job.result?.blueprint.formattedMarkdown).toBe(result.blueprint.formattedMarkdown);
    expect(Buffer.byteLength(job.diagnostics!.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("enforces a UTF-8 byte bound, not a JavaScript character count", () => {
    const job = worker.start("TASK-1355");
    const result = fullPreflightReport();
    result.blueprint.formattedMarkdown = "界".repeat(1_400_000);
    const payload = JSON.stringify({ jobId: job.jobId, result });
    expect(payload.length).toBeLessThan(FULL_PREFLIGHT_OUTPUT_LIMIT);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(FULL_PREFLIGHT_OUTPUT_LIMIT);
    child.stdout.emit("data", Buffer.from(payload));
    finish();
    expect(job).toMatchObject({ status: "failed", diagnostics: { stdoutTruncated: true } });
    expect(job.result).toBeUndefined();
  });

  it("does not share prep's unresolved-survivor namespace", () => {
    const directory = path.join(root, ".quack/logs/prep-shutdown-survivors");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "unknown.json"), "{}");
    expect(() => new PrepWorker(root, "fixture.js").start("TASK-1355")).toThrow(/unresolved/);
    const job = worker.start("TASK-1355");
    child.stdout.emit("data", Buffer.from(JSON.stringify({ jobId: job.jobId, result: fullPreflightReport() })));
    finish();
    expect(job.status).toBe("completed");
    expect(fs.readFileSync(path.join(directory, "unknown.json"), "utf8")).toBe("{}");
  });
});
