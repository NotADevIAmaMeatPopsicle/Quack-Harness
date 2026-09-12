// TASK-1339-A R6: HTTP returns sync outcomes and the periodic poller warns
// with every skipped task id. These tests use the real sync map and task
// directory. Only authentication is replaced with the standard test config.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { createMonitorServer } from "../../src/monitor/server";
import {
  createDivergentTaskFixture,
  taskSpec,
  writeTestAdapter,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

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

function writeLegacySyncMap(fixture: DivergentTaskFixture, taskId = "TASK-100-parent"): void {
  const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
  fs.mkdirSync(path.dirname(syncPath), { recursive: true });
  fs.writeFileSync(
    syncPath,
    JSON.stringify(
      {
        entries: [
          {
            taskId,
            issueNumber: 42,
            direction: "published",
            createdAt: "2026-08-17T00:00:00.000Z",
            lastSyncedAt: "2026-08-17T00:00:00.000Z",
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
}

async function postSync(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/github/sync",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf-8");
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: sync outcome monitor surfaces (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;
    let adapter: ProjectAdapter;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      fixture = createDivergentTaskFixture(order, { prefix: "quack-sync-surface-" });
      writeTestAdapter(fixture.root, {
        reportBack: false,
        pollEnabled: false,
      });
      writeLegacySyncMap(fixture);
      adapter = await loadAdapter(fixture.root);
    });

    afterEach(async () => {
      if (stopServer) await stopServer();
      stopServer = undefined;
      jest.restoreAllMocks();
      fixture.cleanup();
    });

    async function startServer(): Promise<number> {
      const port = await freePort();
      const monitor = createMonitorServer({
        port,
        quackRoot: fixture.root,
        projectAdapters: [adapter],
      });
      const started = await monitor.start();
      stopServer = started.stop;
      return port;
    }

    it("returns skipped rows in the HTTP response body", async () => {
      const port = await startServer();

      const response = await postSync(port);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        outcomes: [
          {
            taskId: "TASK-100-parent",
            issueNumber: 42,
            outcome: "skipped",
            reason: "task_file_unresolvable",
          },
        ],
      });
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });

    // PRE-FIX CONTROL: a fully resolved outcome already reported success.
    // This arm pins that the skipped-row fix does not invert successful syncs.
    it("returns success true when every row syncs", async () => {
      writeLegacySyncMap(fixture, "TASK-100");
      const port = await startServer();

      const response = await postSync(port);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        outcomes: [
          {
            taskId: "TASK-100",
            issueNumber: 42,
            outcome: "synced",
            taskStatus: "READY",
            statusChanged: false,
          },
        ],
      });
    });

    it("warns with the skipped id during periodic status sync", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      writeTestAdapter(fixture.root, {
        reportBack: false,
        pollEnabled: true,
        pollIntervalMs: 1_000_000,
        statusSyncIntervalMs: 20,
      });
      adapter = await loadAdapter(fixture.root);
      await startServer();

      await waitFor(() =>
        warn.mock.calls.some((call) => call.join(" ").includes("TASK-100-parent")),
      );

      expect(
        warn.mock.calls.some((call) => {
          const message = call.join(" ");
          return message.includes("[github-sync]") && message.includes("TASK-100-parent");
        }),
      ).toBe(true);
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });

    it("propagates duplicate_claimants and every claimant through the periodic warning", async () => {
      fs.writeFileSync(fixture.childPath, taskSpec("TASK-100", { status: "READY" }), "utf-8");
      writeLegacySyncMap(fixture, "TASK-100");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      writeTestAdapter(fixture.root, {
        reportBack: false,
        pollEnabled: true,
        pollIntervalMs: 1_000_000,
        statusSyncIntervalMs: 20,
      });
      adapter = await loadAdapter(fixture.root);
      await startServer();

      await waitFor(() =>
        warn.mock.calls.some((call) => call.join(" ").includes("duplicate_claimants")),
      );

      const warning = warn.mock.calls
        .map((call) => call.join(" "))
        .find((message) => message.includes("duplicate_claimants"));
      expect(warning).toContain("TASK-100");
      expect(warning).toContain("TASK-100-A-child.md");
      expect(warning).toContain("TASK-100-parent.md");
    });
  },
);
