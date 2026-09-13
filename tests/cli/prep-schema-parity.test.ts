import { computeSchemaPolicyHash } from "../../src/gate/schema-policy";
import { parsePrepGateResult } from "../../src/monitor/prep-job-result";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { prepCommand } from "../../src/cli/prep";
import { loadAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import { runReadinessGate } from "../../src/gate/gate";
import { evaluateTaskDepth } from "../../src/gate/depth-evaluator";
import { PrepCache } from "../../src/monitor/prep-cache";
import { ReadinessService } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import { runOvernightRunner } from "../../src/overnight/runner";
import { taskSpec } from "../helpers/divergent-task-fixture";

jest.mock("../../src/gate/depth-evaluator", () => ({ evaluateTaskDepth: jest.fn() }));
const depth = evaluateTaskDepth as jest.MockedFunction<typeof evaluateTaskDepth>;

describe("configured schema parity across prep producers", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-schema-parity-"));
    fs.mkdirSync(path.join(root, ".quack"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    depth.mockReset();
    // Keep the default-schema control inside prep; no blueprint/model work.
    depth.mockResolvedValue({
      ready: false,
      overallScore: 4,
      scores: {},
      deficiencies: ["fixture depth rejection"],
    } as Awaited<ReturnType<typeof evaluateTaskDepth>>);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test.each([
    ["cli", false, false, true],
    ["overnight", false, false, true],
    ["cli", true, false, false],
    ["overnight", true, false, false],
    ["cli", false, false, false],
    ["overnight", false, false, false],
    ["cli", true, true, false],
    ["overnight", true, true, false],
  ] as const)("%s: required=%s, files=%s, edit=%s", async (producer, required, hasFiles, editDuringEvaluation) => {
    const raw = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../fixtures/adapters/gate-required-sections/.quack/adapter.json"),
        "utf8",
      ),
    ) as { gate: { requiredSections: string[] } };
    if (!required) raw.gate.requiredSections = [];
    fs.writeFileSync(path.join(root, ".quack", "adapter.json"), JSON.stringify(raw));
    const content = taskSpec("TASK-100", { targetFiles: hasFiles ? ["src/example.ts"] : [] });
    const taskPath = path.join(root, "docs", "tasks", "TASK-100.md");
    fs.writeFileSync(taskPath, content);
    const adapter = await loadAdapter(root);
    const fullGate = await runReadinessGate(parseTaskFile(content, taskPath), adapter, {
      skipDepthOnly: true,
    });
    const rejected = required && !hasFiles;
    expect(fullGate.outcome).toBe(rejected ? "rejected" : "pass");

    const evaluatedPolicy = computeSchemaPolicyHash(raw.gate.requiredSections);
    if (editDuringEvaluation) depth.mockImplementationOnce(() => {
      raw.gate.requiredSections = ["filesToModify"];
      fs.writeFileSync(path.join(root, ".quack", "adapter.json"), JSON.stringify(raw));
      return Promise.resolve({ ready: false, overallScore: 4, scores: {}, deficiencies: ["fixture depth rejection"] } as Awaited<ReturnType<typeof evaluateTaskDepth>>);
    });
    if (producer === "cli") {
      const exit = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const stdout = jest.spyOn(console, "log").mockImplementation(() => {});
      await prepCommand("TASK-100", { project: root });
      expect(exit).toHaveBeenCalledWith(0);
      const serialized = stdout.mock.calls.find(([value]) => typeof value === "string" && value.includes('"schemaPolicyHash"'))?.[0] as string;
      expect(parsePrepGateResult(JSON.parse(serialized)).schemaPolicyHash).toBe(evaluatedPolicy);
    } else {
      const requests: string[] = [];
      const server = http.createServer((req, res) => {
        requests.push(req.method ?? "");
        res.setHeader("Content-Type", "application/json");
        res.end(req.url?.startsWith("/api/dispatch/jobs") ? "[]" : '{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address() as { port: number };
        await runOvernightRunner({
          projectRoot: root,
          monitorUrl: `http://127.0.0.1:${address.port}`,
          taskIds: ["TASK-100"],
          checkpointPath: path.join(root, ".quack", "fixture-overnight.json"),
          once: true,
          maxCycles: 1,
          autoEnrich: false,
          autoDecompose: false,
          federationDispatch: false,
          logger: () => {},
        });
        expect(requests.every((method) => method === "GET")).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
    const cached = await new PrepCache(root).read("TASK-100");
    const expectedErrors = rejected ? ["files_to_modify (required by project config)"] : [];
    expect(cached).toMatchObject({ schemaPolicyHash: evaluatedPolicy, schemaValid: !rejected, schemaErrors: expectedErrors });
    if (rejected) {
      expect(fullGate).toMatchObject({ details: { missing: expectedErrors } });
      expect(cached).toMatchObject({
        depthScore: 0,
        depthReady: false,
        outcome: "rejected",
        deficiencies: expectedErrors,
      });
      expect(depth).not.toHaveBeenCalled();
    } else expect(depth).toHaveBeenCalledTimes(1);
    const readiness = new ReadinessService({
      projectRoot: root,
      taskService: new TaskService(root, "docs/tasks"),
    });
    try {
      expect((await readiness.resolveCurrent("TASK-100"))?.prep).toMatchObject({
        schemaPolicyHash: evaluatedPolicy,
        schemaValid: !rejected,
        schemaErrors: expectedErrors,
      });
    } finally {
      readiness.close();
    }
  });
});
