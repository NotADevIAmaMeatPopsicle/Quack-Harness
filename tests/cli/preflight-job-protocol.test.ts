import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeContentHash } from "../../src/monitor/prep-cache";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";
import { taskSpec, writeAdapter } from "../helpers/duplicate-claimants-fixture";
import type { PreflightCommandOptions } from "../../src/cli/preflight";

jest.setTimeout(30_000);
describe("native full-preflight CLI protocol", () => {
  let root: string;
  let reportPath: string;
  let options: PreflightCommandOptions;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-preflight-cli-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    const content = taskSpec("TASK-1355");
    fs.writeFileSync(path.join(root, "docs/tasks/TASK-1355.md"), content);
    writeAdapter(root);
    options = { json: true, jobId: randomUUID(), projectId: "fixture", force: true,
      mode: "deterministic", expectedContentHash: computeContentHash(content),
      expectedSchemaPolicyHash: preflightInput.schemaPolicyHash, expectedReadinessMode: "off" };
    const report = fullPreflightReport();
    report.contentHash = options.expectedContentHash!;
    report.blueprint.formattedMarkdown = "🙂".repeat(180_000);
    reportPath = path.join(root, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  function run(overrides: PreflightCommandOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(__dirname, "../helpers/preflight-cli-process.cjs"),
        root, JSON.stringify({ ...options, ...overrides }), reportPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      // Backpressure ensures the write cannot be assumed synchronous on POSIX.
      child.stdout.pause();
      const timer = setTimeout(() => child.stdout.resume(), 50);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    });
  }

  it("flushes a large Unicode envelope before exit and correlates existing preflight events", async () => {
    const output = await run();
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toEqual({ jobId: options.jobId, result: JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown });
    expect(JSON.parse(fs.readFileSync(path.join(root, "producer-called.json"), "utf8"))).toEqual({ mode: "deterministic", force: true });
    const events = fs.readFileSync(path.join(root, ".quack/logs/events-preflight.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { sessionId: string; project: string; payload: { jobId: string } });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ sessionId: "preflight", project: "fixture", payload: { jobId: options.jobId } });
  });

  it.each([
    { expectedContentHash: "b".repeat(64) }, { expectedSchemaPolicyHash: "c".repeat(64) },
    { expectedReadinessMode: "shadow" as const },
  ])("refuses changed input before invoking the producer (%j)", async (change) => {
    const output = await run(change);
    expect(output).toMatchObject({ code: 1, stdout: "" });
    expect(JSON.parse(output.stderr)).toMatchObject({ jobId: options.jobId, errorType: "PREFLIGHT_INPUT_CHANGED" });
    expect(fs.existsSync(path.join(root, "producer-called.json"))).toBe(false);
  });

  it("names all claimants if ownership changes after reservation", async () => {
    fs.writeFileSync(path.join(root, "docs/tasks/other.md"), taskSpec("TASK-1355"));
    const output = await run();
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stderr)).toMatchObject({ jobId: options.jobId, errorType: "duplicate_claimants",
      claimants: ["TASK-1355.md", "other.md"] });
    expect(fs.existsSync(path.join(root, "producer-called.json"))).toBe(false);
  });

  it("preserves the direct CLI's plain report JSON", async () => {
    options = { json: true, mode: "auto" };
    const output = await run();
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")));
  });
});
