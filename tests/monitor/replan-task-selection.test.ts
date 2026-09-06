// TASK-1339-A R2: replan resolves once and preflights the parent task.
//
// The naive-control tests are MATCHER-ONLY CONTROLS and intentionally pass
// before the production change. The behavioral tests were written to fail
// on both the selected task id and the canonical resolver call count.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { runPreflight } from "../../src/preflight/preflight-runner";
import * as taskFileResolver from "../../src/core/task-file-resolver";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

jest.mock("../../src/preflight/preflight-runner", () => ({
  ...jest.requireActual<object>("../../src/preflight/preflight-runner"),
  runPreflight: jest.fn(() => Promise.resolve({})),
}));

const mockedRunPreflight = runPreflight as jest.MockedFunction<typeof runPreflight>;

async function postJson(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: replan parent selection (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(() => {
      fixture = createDivergentTaskFixture(order, { prefix: "quack-replan-selection-" });
      writeTestAdapter(fixture.root);
      const approvalDir = path.join(fixture.root, ".quack", "logs", "approvals");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        path.join(approvalDir, "TASK-100.json"),
        JSON.stringify({
          taskId: "TASK-100",
          state: "pending",
          blueprint: {},
          createdAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      mockedRunPreflight.mockClear();
    });

    afterEach(async () => {
      if (stopServer) await stopServer();
      stopServer = undefined;
      jest.restoreAllMocks();
      fixture.cleanup();
    });

    it("MATCHER-ONLY CONTROL: the naive prefix read selects the child", () => {
      expect(fixture.naiveSelection).toBe("TASK-100-A-child.md");
    });

    it("resolves once and preflights the parent without touching either spec", async () => {
      const resolveSpy = jest.spyOn(taskFileResolver, "resolveTaskFile");
      const port = 30000 + Math.floor(Math.random() * 10000);
      const monitor = createMonitorServer({
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        logDir: path.join(fixture.root, ".quack", "logs"),
        adapterPath: path.join(fixture.root, ".quack", "adapter.json"),
        quackRoot: fixture.root,
        port,
      });
      const started = await monitor.start();
      stopServer = started.stop;

      const response = await postJson(port, "/api/tasks/TASK-100/blueprint/replan");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response.status).toBe(200);
      expect(mockedRunPreflight).toHaveBeenCalledTimes(1);
      expect(mockedRunPreflight.mock.calls[0]?.[0].id).toBe("TASK-100");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });
  },
);
