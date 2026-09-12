import { PrepJobStore } from "../../src/monitor/prep-job-store";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PrepWorker } from "../../src/monitor/prep-worker";

class FakeChild extends EventEmitter {
  pid = 45454;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}
const pass = {
  schemaValid: true,
  schemaErrors: [],
  depthScore: 5,
  depthReady: true,
  deficiencies: [],
  outcome: "pass",
};

describe("prep terminal result contract", () => {
  let root: string;
  let child: FakeChild;
  let worker: PrepWorker;
  const onTerminal = jest.fn();
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = { ...originalEnvironment };
    for (const name of Object.keys(process.env))
      if (/^(?:ANTHROPIC_API_KEY(?:_\d+)?|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name))
        delete process.env[name];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-result-"));
    child = new FakeChild();
    const spawnProcess = jest.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    worker = new PrepWorker(
      root,
      "fixture.js",
      {
        platform: "linux",
        spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      },
      { onTerminal },
    );
    onTerminal.mockClear();
  });
  afterEach(() => {
    process.env = originalEnvironment;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  }

  it.each([
    null,
    false,
    [],
    {},
    { error: "provider failed" },
    { outcome: "pass" },
    { ...pass, schemaValid: false },
    { ...pass, depthScore: "5" },
    { ...pass, depthReady: false },
    { ...pass, schemaErrors: [42] },
    { ...pass, outcome: ["pass"] },
    { ...pass, outcome: ["enriched"] },
  ])(
    "fails parseable exit-zero output that violates the complete result contract: %j",
    (output) => {
      const job = worker.start("TASK-001");
      child.stdout.emit("data", Buffer.from(JSON.stringify(output)));
      finish();
      expect(job).toMatchObject({
        status: "failed",
        exitCode: 0,
        signal: null,
        completedAt: expect.any(String) as unknown,
      });
      expect(job.result).toBeUndefined();
      expect(new PrepWorker(root, "unused.js").getJob("TASK-001")).toEqual(job);
      expect(onTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for closed stdout, including a late final chunk, before accepting the result", async () => {
    const job = worker.start("TASK-001");
    const serialized = JSON.stringify(pass);
    child.stdout.emit("data", Buffer.from(serialized.slice(0, -1)));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(job.status).toBe("running");
    expect(job.completedAt).toBeUndefined();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(() => worker.start("TASK-001")).toThrow("already running");
    child.stdout.emit("data", Buffer.from("}"));
    child.emit("close", 0, null);
    expect(job.status).toBe("completed");
    expect(job.result).toEqual(pass);
    await expect(worker.waitForIdle()).resolves.toBe(true);
  });

  it.each([
    {
      ...pass,
      depthScore: 2,
      depthReady: false,
      deficiencies: ["More detail required"],
      outcome: "rejected",
    },
    {
      ...pass,
      schemaValid: false,
      schemaErrors: ["Missing criteria"],
      depthScore: 0,
      depthReady: false,
      outcome: "rejected",
    },
  ])("records a computed gate rejection without calling the prep child a crash", (result) => {
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
    finish();
    expect(job.status).toBe("completed");
    expect(job.result?.outcome).toBe("rejected");
    expect(job.error).toBeUndefined();
    const eventFile = fs
      .readdirSync(path.join(root, ".quack", "logs"))
      .find((name) => name.startsWith("events-prep-"))!;
    const event = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "logs", eventFile), "utf8"),
    ) as { stage: string; payload: { result: { outcome: string } } };
    expect(event.stage).toBe("prep_job_completed");
    expect(event.payload.result.outcome).toBe("rejected");
  });

  it("persists terminal signal/exit diagnostics with secrets removed from logs, API data and events", () => {
    process.env.ANTHROPIC_API_KEY = "fixture-private-api-value";
    const job = worker.start("TASK-001");
    child.stderr.emit(
      "data",
      Buffer.from("auth failed: fixture-private-api-value Bearer another-secret"),
    );
    finish(null, "SIGTERM");
    expect(job).toMatchObject({ status: "failed", exitCode: null, signal: "SIGTERM" });
    expect(job.error).toContain("[redacted]");
    const files = fs
      .readdirSync(path.join(root, ".quack", "logs"))
      .filter((name) => /\.(?:log|jsonl)$/.test(name));
    for (const name of files) {
      const content = fs.readFileSync(path.join(root, ".quack", "logs", name), "utf8");
      expect(content).not.toContain("fixture-private-api-value");
      expect(content).not.toContain("another-secret");
    }
    expect(JSON.stringify(onTerminal.mock.calls)).not.toContain("fixture-private-api-value");
  });

  it("retains spawn errors until close and refuses oversized successful output", () => {
    const job = worker.start("TASK-001");
    child.emit("error", new Error("fixture spawn failure"));
    expect(job.status).toBe("running");
    child.emit("close", null, null);
    expect(job.error).toBe("fixture spawn failure");
    const second = worker.start("TASK-002");
    child.stdout.emit("data", Buffer.from(JSON.stringify(pass) + " ".repeat(70_000)));
    finish();
    expect(second.status).toBe("failed");
    expect(second.diagnostics?.stdoutTruncated).toBe(true);
    expect(second.diagnostics?.stdout.length).toBeLessThan(100);
  });

  it("round-trips in-bound Unicode failure diagnostics after restart", () => {
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from("漢".repeat(60_000)));
    child.stderr.emit("data", Buffer.from("診".repeat(60_000)));
    finish(1);
    expect(job.persistenceError).toBeUndefined();
    expect(job.diagnostics).toMatchObject({ stdoutTruncated: false, stderrTruncated: false });
    expect(Buffer.byteLength(JSON.stringify(job), "utf8")).toBeGreaterThan(300_000);
    expect(new PrepWorker(root, "unused.js").getJob("TASK-001")).toEqual(job);
  });

  it("round-trips in-bound Unicode result and diagnostic copies after restart", () => {
    const output = { ...pass, deficiencies: ["漢".repeat(50_000)] };
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from(JSON.stringify(output)));
    finish();
    expect(job.status).toBe("completed");
    expect(job.persistenceError).toBeUndefined();
    expect(job.result).toEqual(output);
    expect(Buffer.byteLength(JSON.stringify(job), "utf8")).toBeGreaterThan(300_000);
    expect(new PrepWorker(root, "unused.js").getJob("TASK-001")).toEqual(job);
  });

  it("refuses over-limit serialization before replacing a readable observation", () => {
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from(JSON.stringify(pass)));
    finish();
    const store = new PrepJobStore(path.join(root, ".quack", "logs"), "fixture");
    const oversized = {
      ...job,
      diagnostics: { ...job.diagnostics!, stdout: "漢".repeat(400_000) },
    };
    expect(() => store.write(oversized)).toThrow("size limit");
    expect(store.read("TASK-001")).toEqual(job);
  });

  it("reports corrupt persisted observations without creating a readiness result or repairing the file", () => {
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from(JSON.stringify(pass)));
    finish();
    expect(job.status).toBe("completed");
    const latest = path.join(
      root,
      ".quack",
      "logs",
      "prep-jobs",
      `${Buffer.from("TASK-001").toString("base64url")}.json`,
    );
    fs.writeFileSync(latest, "null", "utf8");
    const restarted = new PrepWorker(root, "unused.js");
    expect(() => restarted.getJob("TASK-001")).toThrow("malformed");
    expect(fs.readFileSync(latest, "utf8")).toBe("null");
    expect(fs.existsSync(path.join(root, ".quack", "prep"))).toBe(false);
  });

  it.each([
    { exitCode: 1 },
    { signal: "SIGTERM" },
    { result: { ...pass, outcome: ["pass"] } },
    { result: { ...pass, outcome: ["enriched"] } },
    { completedAt: "2000-01-01T00:00:00Z" },
    {
      diagnostics: {
        stdout: "x".repeat(65 * 1024),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    },
  ])("rejects contradictory or unbounded persisted completion evidence (case %#)", (corruption) => {
    const job = worker.start("TASK-001");
    child.stdout.emit("data", Buffer.from(JSON.stringify(pass)));
    finish();
    const latest = path.join(
      root,
      ".quack",
      "logs",
      "prep-jobs",
      `${Buffer.from("TASK-001").toString("base64url")}.json`,
    );
    const content = JSON.stringify({ ...job, ...corruption });
    fs.writeFileSync(latest, content, "utf8");
    expect(() => new PrepWorker(root, "unused.js").getJob("TASK-001")).toThrow("malformed");
    expect(fs.readFileSync(latest, "utf8")).toBe(content);
  });
});
