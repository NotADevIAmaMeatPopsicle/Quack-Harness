import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { DuplicateClaimantIndex } from "../../src/core/duplicate-claimants";
import { QuackDB } from "../../src/db";
import { EventWriter } from "../../src/monitor/event-emitter";
import { EventReader } from "../../src/monitor/event-reader";
import type { OnMergeScanDeps } from "../../src/monitor/on-merge-recorder";

const runOnMergeScanMock = jest.fn();
const runBackfillScanMock = jest.fn();

jest.mock("../../src/monitor/on-merge-recorder", () => ({
  ...jest.requireActual<object>("../../src/monitor/on-merge-recorder"),
  runOnMergeScan: (...args: unknown[]): unknown => runOnMergeScanMock(...args) as unknown,
  runBackfillScan: (...args: unknown[]): unknown => runBackfillScanMock(...args) as unknown,
}));

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

import { createMonitorServer } from "../../src/monitor/server";

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

function request(
  url: string,
  method: "GET" | "POST",
  data: Record<string, unknown> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = method === "POST" ? JSON.stringify(data) : "";
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        headers:
          method === "POST"
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : undefined,
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer | string) => {
          responseBody += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson<T>(text: string): T {
  const parsed: unknown = JSON.parse(text);
  return parsed as T;
}

function readTestCursor(projectRoot: string): { lastScannedSha: string } {
  return parseJson<{ lastScannedSha: string }>(
    fs.readFileSync(path.join(projectRoot, ".quack", "on-merge-cursor.json"), "utf-8"),
  );
}

interface TestBackfillResponse {
  candidates: Array<{ taskId: string; disposition: string }>;
}

function taskSpec(): string {
  return [
    "# TASK-610: on-merge claimant disposition fixture",
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** SMALL",
    "- **Status:** COMPLETE",
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** [recording]",
    "",
    "## Problem Statement",
    "Exercise the monitor-owned on-merge dependency injection path.",
    "",
    "## Success Criteria",
    "- [x] scanner path classifies",
    "",
    "## Testing Requirements",
    "- [x] no git subprocess",
  ].join("\n");
}

describe("TASK-1338-D on-merge claimant disposition through the real server injection", () => {
  jest.setTimeout(30000);

  let root: string;
  let logDir: string;
  let verifiedPath: string;
  let stopServer: (() => Promise<void>) | undefined;
  let port: number;

  beforeEach(async () => {
    runOnMergeScanMock.mockReset();
    runBackfillScanMock.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338d-onmerge-"));
    const taskDir = path.join(root, "docs", "tasks");
    const quackDir = path.join(root, ".quack");
    logDir = path.join(root, "non-default", "operator-events");
    verifiedPath = path.join(quackDir, "verified.json");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "TASK-610-a.md"), taskSpec(), "utf-8");
    fs.writeFileSync(path.join(taskDir, "TASK-999-cross-claimant.md"), taskSpec(), "utf-8");
    fs.mkdirSync(quackDir, { recursive: true });
    fs.writeFileSync(verifiedPath, '{"version":1,"tasks":{}}\n', "utf-8");
    fs.writeFileSync(
      path.join(quackDir, "on-merge-cursor.json"),
      JSON.stringify(
        {
          lastScannedSha: "tip-1",
          baseBranch: "main",
          projectRoot: root,
          updatedAt: "2026-08-18T00:00:00Z",
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        project: { name: "onmerge-fixture" },
        git: {
          baseBranch: "main",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "",
        },
      }),
      "utf-8",
    );

    port = await freePort();
    const monitor = createMonitorServer({
      projectRoot: root,
      taskDir: "docs/tasks",
      logDir,
      adapterPath: path.join(root, ".quack", "adapter.json"),
      port,
    });
    const started = await monitor.start();
    stopServer = started.stop;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (stopServer) await stopServer();
    stopServer = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function delegateRealScan(indexOverride?: DuplicateClaimantIndex): void {
    runOnMergeScanMock.mockImplementation((deps: OnMergeScanDeps) => {
      const actual = jest.requireActual<typeof import("../../src/monitor/on-merge-recorder")>(
        "../../src/monitor/on-merge-recorder",
      );
      return actual.runOnMergeScan({
        ...deps,
        ...(indexOverride ? { claimantIndexProvider: () => Promise.resolve(indexOverride) } : {}),
        runGit: (args) => {
          if (args[0] === "rev-parse") return Promise.resolve("tip-2\n");
          if (args[0] === "log") return Promise.resolve("abc1234\tparent\t[TASK-610] merged\n");
          return Promise.reject(new Error(`unexpected git command: ${args.join(" ")}`));
        },
      });
    });
  }

  function delegateRealBackfill(indexOverride?: DuplicateClaimantIndex): void {
    runBackfillScanMock.mockImplementation(
      (deps: OnMergeScanDeps, options: { since: string; apply?: boolean }) => {
        const actual = jest.requireActual<typeof import("../../src/monitor/on-merge-recorder")>(
          "../../src/monitor/on-merge-recorder",
        );
        return actual.runBackfillScan(
          {
            ...deps,
            ...(indexOverride
              ? { claimantIndexProvider: () => Promise.resolve(indexOverride) }
              : {}),
            runGit: (args) => {
              if (args[0] === "log") {
                return Promise.resolve(
                  "abc1234\tparent\t[TASK-610] merged\t2026-08-18T00:00:00Z\n",
                );
              }
              return Promise.reject(new Error(`unexpected git command: ${args.join(" ")}`));
            },
          },
          options,
        );
      },
    );
  }

  it("inverts F's omission proof: contested scan-now writes no row, preserves ledger bytes, persists, projects, and holds", async () => {
    const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
    delegateRealScan();

    const response = await request(`http://127.0.0.1:${port}/api/recording/scan-now`, "POST");
    expect(response.status).toBe(200);
    expect(parseJson<Record<string, unknown>>(response.body)).toMatchObject({
      contested: ["TASK-610"],
      cursorMovedTo: null,
    });

    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-610")).toBeUndefined();
      expect(db.getStatus("TASK-610")?.status).not.toBe("COMPLETE");
    } finally {
      db.close();
    }
    expect(fs.readFileSync(verifiedPath, "utf-8")).toBe(beforeLedger);

    const cursor = readTestCursor(root);
    expect(cursor.lastScannedSha).toBe("tip-1");
    const freshReader = new EventReader(logDir);
    const diagnosticSession = freshReader
      .getAllSessions()
      .find((session) => session.outcome === "claimant_diagnostic");
    expect(diagnosticSession).toBeDefined();
    expect(freshReader.getSessionEvents(diagnosticSession?.sessionId ?? "missing")).toHaveLength(1);

    const workflow = await request(
      `http://127.0.0.1:${port}/v1/tasks/TASK-610/workflow-state`,
      "GET",
    );
    expect(workflow.status).toBe(200);
    expect(parseJson<Record<string, unknown>>(workflow.body)).toMatchObject({
      taskId: "TASK-610",
      state: "blocked",
      blockReasonCode: "pending_manual_handoff",
      claimantDiagnostic: {
        taskId: "TASK-610",
        claimants: ["TASK-610-a.md", "TASK-999-cross-claimant.md"],
        commitSha: "abc1234",
        scannerMethod: "on-merge",
      },
    });
  });

  it("CLEAN POSITIVE TWIN records, changes the ledger, and advances through the same route", async () => {
    fs.rmSync(path.join(root, "docs", "tasks", "TASK-999-cross-claimant.md"));
    const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
    delegateRealScan();

    const response = await request(`http://127.0.0.1:${port}/api/recording/scan-now`, "POST");
    expect(response.status).toBe(200);
    expect(parseJson<Record<string, unknown>>(response.body)).toMatchObject({
      recorded: ["TASK-610"],
      cursorMovedTo: "tip-2",
    });

    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-610")).toMatchObject({
        verdict: "SOFT-VERIFIED",
        method: "on-merge",
        commit_sha: "abc1234",
      });
    } finally {
      db.close();
    }
    expect(fs.readFileSync(verifiedPath, "utf-8")).not.toBe(beforeLedger);
    const cursor = readTestCursor(root);
    expect(cursor.lastScannedSha).toBe("tip-2");
  });

  it("holds the cursor on a between-appends failure and repairs durability while still contested", async () => {
    delegateRealScan();
    const recordSpy = jest
      .spyOn(EventWriter.prototype, "recordSession")
      .mockImplementationOnce(() => {
        throw new Error("between diagnostic appends");
      });

    const failed = await request(`http://127.0.0.1:${port}/api/recording/scan-now`, "POST");
    expect(failed.status).toBe(500);
    let cursor = readTestCursor(root);
    expect(cursor.lastScannedSha).toBe("tip-1");
    recordSpy.mockRestore();

    const retried = await request(`http://127.0.0.1:${port}/api/recording/scan-now`, "POST");
    expect(retried.status).toBe(200);
    cursor = readTestCursor(root);
    expect(cursor.lastScannedSha).toBe("tip-1");

    const freshReader = new EventReader(logDir);
    const diagnosticSessions = freshReader
      .getAllSessions()
      .filter((session) => session.outcome === "claimant_diagnostic");
    expect(diagnosticSessions).toHaveLength(1);
    expect(
      freshReader.getSessionEvents(diagnosticSessions[0]?.sessionId ?? "missing"),
    ).toHaveLength(1);
  });

  it("reports producer rejection by name and leaves scan-now's real cursor unmoved", async () => {
    const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
    delegateRealScan({ status: "unavailable", reason: "fixture producer rejected" });

    const response = await request(`http://127.0.0.1:${port}/api/recording/scan-now`, "POST");
    expect(response.status).toBe(200);
    expect(parseJson<Record<string, unknown>>(response.body)).toMatchObject({
      claimantIndexUnavailable: ["TASK-610"],
      cursorMovedTo: null,
    });
    const cursor = readTestCursor(root);
    expect(cursor.lastScannedSha).toBe("tip-1");
    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-610")).toBeUndefined();
    } finally {
      db.close();
    }
    expect(fs.readFileSync(verifiedPath, "utf-8")).toBe(beforeLedger);
  });

  it.each([
    ["dry-run", false],
    ["apply", true],
  ])(
    "keeps the DB, ledger bytes, and live cursor unchanged for contested backfill %s",
    async (_label, apply) => {
      const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
      const beforeCursor = fs.readFileSync(
        path.join(root, ".quack", "on-merge-cursor.json"),
        "utf-8",
      );
      delegateRealBackfill();

      const response = await request(`http://127.0.0.1:${port}/api/recording/backfill`, "POST", {
        since: "2026-08-01",
        apply,
      });
      expect(response.status).toBe(200);
      expect(parseJson<TestBackfillResponse>(response.body).candidates[0]).toMatchObject({
        taskId: "TASK-610",
        disposition: "contested",
      });

      const db = new QuackDB(path.join(root, ".quack", "quack.db"));
      try {
        expect(db.getVerified("TASK-610")).toBeUndefined();
      } finally {
        db.close();
      }
      expect(fs.readFileSync(verifiedPath, "utf-8")).toBe(beforeLedger);
      expect(fs.readFileSync(path.join(root, ".quack", "on-merge-cursor.json"), "utf-8")).toBe(
        beforeCursor,
      );
      const diagnosticSessions = new EventReader(logDir)
        .getAllSessions()
        .filter((session) => session.outcome === "claimant_diagnostic");
      expect(diagnosticSessions).toHaveLength(apply ? 1 : 0);
    },
  );

  it("CLEAN POSITIVE TWIN applies backfill through the same server injection without moving the live cursor", async () => {
    fs.rmSync(path.join(root, "docs", "tasks", "TASK-999-cross-claimant.md"));
    const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
    const beforeCursor = fs.readFileSync(
      path.join(root, ".quack", "on-merge-cursor.json"),
      "utf-8",
    );
    delegateRealBackfill();

    const response = await request(`http://127.0.0.1:${port}/api/recording/backfill`, "POST", {
      since: "2026-08-01",
      apply: true,
    });
    expect(response.status).toBe(200);
    expect(parseJson<TestBackfillResponse>(response.body).candidates[0]).toMatchObject({
      taskId: "TASK-610",
      disposition: "recorded",
    });

    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-610")).toMatchObject({
        verdict: "SOFT-VERIFIED",
        method: "migration-scan",
        commit_sha: "abc1234",
      });
    } finally {
      db.close();
    }
    expect(fs.readFileSync(verifiedPath, "utf-8")).not.toBe(beforeLedger);
    expect(fs.readFileSync(path.join(root, ".quack", "on-merge-cursor.json"), "utf-8")).toBe(
      beforeCursor,
    );
  });

  it.each([
    ["dry-run", false],
    ["apply", true],
  ])(
    "reports producer rejection distinctly for backfill %s without any ledger mutation",
    async (_label, apply) => {
      const beforeLedger = fs.readFileSync(verifiedPath, "utf-8");
      const beforeCursor = fs.readFileSync(
        path.join(root, ".quack", "on-merge-cursor.json"),
        "utf-8",
      );
      delegateRealBackfill({ status: "unavailable", reason: "fixture producer rejected" });

      const response = await request(`http://127.0.0.1:${port}/api/recording/backfill`, "POST", {
        since: "2026-08-01",
        apply,
      });
      expect(response.status).toBe(200);
      expect(parseJson<TestBackfillResponse>(response.body).candidates[0]).toMatchObject({
        taskId: "TASK-610",
        disposition: "claimant-index-unavailable",
      });

      const db = new QuackDB(path.join(root, ".quack", "quack.db"));
      try {
        expect(db.getVerified("TASK-610")).toBeUndefined();
      } finally {
        db.close();
      }
      expect(fs.readFileSync(verifiedPath, "utf-8")).toBe(beforeLedger);
      expect(fs.readFileSync(path.join(root, ".quack", "on-merge-cursor.json"), "utf-8")).toBe(
        beforeCursor,
      );
    },
  );
});
