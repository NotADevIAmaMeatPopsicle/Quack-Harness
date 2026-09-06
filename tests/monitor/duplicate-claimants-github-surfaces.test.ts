import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { loadAdapter } from "../../src/core/adapter-loader";
import {
  DuplicateClaimantAdmissionError,
  formatDuplicateClaimantsMessage,
} from "../../src/core/duplicate-claimants";
import * as issuePublisher from "../../src/integrations/github/issue-publisher";
import { createMonitorServer } from "../../src/monitor/server";
import { taskSpec } from "../helpers/divergent-task-fixture";
import { createContestedTaskFixture, writeSyncMap } from "../helpers/task-1338e-fixture";

jest.mock("../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn(() =>
    Promise.resolve({
      stdout: "https://github.com/fixture/repo/issues/720\n",
      stderr: "",
    }),
  ),
}));

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function post(
  port: number,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer | string) => {
          raw += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("TASK-1338-E: monitor GitHub mutation outcomes", () => {
  let stopServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stopServer) await stopServer();
    stopServer = undefined;
    jest.restoreAllMocks();
  });

  async function start(projectRoot: string): Promise<number> {
    const port = await freePort();
    const adapter = await loadAdapter(projectRoot);
    const monitor = createMonitorServer({
      port,
      quackRoot: projectRoot,
      projectAdapters: [adapter],
    });
    const started = await monitor.start();
    stopServer = started.stop;
    return port;
  }

  it("returns the exact discriminated batch body and maps only published rows", async () => {
    const fixture = createContestedTaskFixture("parent-first", "candidate", {
      withAdapter: true,
    });
    const cleanName = "TASK-520-clean.md";
    fs.writeFileSync(
      path.join(fixture.taskDir, cleanName),
      taskSpec("TASK-520", { title: "HTTP clean row", status: "BACKLOG" }),
      "utf-8",
    );
    try {
      const port = await start(fixture.root);
      const response = await post(port, "/api/github/publish", { allBacklog: true });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        published: [
          {
            taskId: "TASK-520-clean",
            issueNumber: 720,
            url: "https://github.com/fixture/repo/issues/720",
          },
        ],
        skipped: fixture.claimants.map((file) => ({
          taskId: fixture.taskId,
          file,
          reason: "duplicate_claimants",
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        })),
      });

      const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
      const syncMap = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskId: string }>;
      };
      expect(syncMap.entries.map((entry) => entry.taskId)).toEqual(["TASK-520-clean"]);
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });

  it("maps a thrown single-publish admission error through the shared exact 409 body", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      withAdapter: true,
    });
    fs.rmSync(fixture.claimantPaths[1]);
    const claimants = ["TASK-530-alpha.md", "TASK-530-zeta.md"];
    const error = new DuplicateClaimantAdmissionError({ taskId: "TASK-530", claimants });
    jest.spyOn(issuePublisher, "publishTask").mockRejectedValueOnce(error);
    try {
      const port = await start(fixture.root);
      const response = await post(port, "/api/github/publish", { taskId: "TASK-530" });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        ok: false,
        error: "duplicate_claimants",
        taskId: "TASK-530",
        claimants,
        message: formatDuplicateClaimantsMessage("TASK-530", claimants),
      });
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });

  it("returns a batch outcome instead of 500 for malformed discovery candidates", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      withAdapter: true,
    });
    fs.rmSync(fixture.claimantPaths[1]);
    fs.writeFileSync(path.join(fixture.taskDir, "SAURUS-REM-999-bad.md"), "not a task\n", "utf-8");
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-521-malformed.md"), "not a task\n", "utf-8");
    try {
      const port = await start(fixture.root);
      const response = await post(port, "/api/github/publish", { allBacklog: true });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        published: [
          {
            taskId: "TASK-500-alpha",
            issueNumber: 720,
            url: "https://github.com/fixture/repo/issues/720",
          },
        ],
        skipped: [
          {
            taskId: "unparseable:TASK-521-malformed.md",
            file: "TASK-521-malformed.md",
            reason: "publish_failed",
            message: expect.stringContaining("Missing required H1 heading") as unknown as string,
          },
        ],
      });
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });

  it("propagates duplicate_claimants with claimants through HTTP status sync", async () => {
    const fixture = createContestedTaskFixture("child-first", "cross-population", {
      withAdapter: true,
      reportBack: false,
      status: "COMPLETE",
    });
    writeSyncMap(fixture.root, [
      {
        taskId: fixture.taskId,
        issueNumber: 73,
        taskStatus: "READY",
      },
    ]);
    try {
      const port = await start(fixture.root);
      const response = await post(port, "/api/github/sync", {});
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        outcomes: [
          {
            taskId: fixture.taskId,
            issueNumber: 73,
            outcome: "skipped",
            reason: "duplicate_claimants",
            claimants: fixture.claimants,
          },
        ],
      });
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });
});
