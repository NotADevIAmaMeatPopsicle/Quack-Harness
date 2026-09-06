import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import express from "express";

import { registerResearchRoutes } from "../../src/monitor/routes/research";
import type { DispatchAnalysis } from "../../src/research/research-types";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-research-api-"));
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function makeAnalysis(overrides: Partial<DispatchAnalysis> = {}): DispatchAnalysis {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    taskId: overrides.taskId ?? "TASK-001",
    project: "quack",
    outcome: overrides.outcome ?? "failed",
    startTime: overrides.startTime ?? "2026-05-13T00:00:00.000Z",
    durationMs: 1000,
    totalCostUsd: 0.1,
    turnsUsed: 3,
    stageTimings: [],
    codeMetrics: null,
    linesPerMinute: null,
    costPerLine: null,
    efficiencyScore: null,
    anomalies: overrides.anomalies ?? [],
    workerHostAlias: overrides.workerHostAlias,
    executionMode: overrides.executionMode,
    analyzedAt: overrides.analyzedAt ?? "2026-05-13T00:01:00.000Z",
  };
}

describe("research API validation taxonomy", () => {
  let root: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    root = makeTempDir();
    fs.mkdirSync(path.join(root, ".quack", "research"), { recursive: true });
    const app = express();
    registerResearchRoutes(app, () => ({ projectRoot: root, projectName: "quack" }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        port = typeof address === "object" && address ? address.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("summarizes validation drift separately from generic failures", async () => {
    fs.writeFileSync(
      path.join(root, ".quack", "research", "analyses.json"),
      JSON.stringify({
        analyses: [
          makeAnalysis({
            sessionId: "session-stale",
            taskId: "TASK-100",
            workerHostAlias: "headnode",
            anomalies: [
              {
                type: "stale_adapter",
                message: "stale adapter bundle blocked verification",
                value: 1,
                threshold: 0,
              } as never,
            ],
          }),
          makeAnalysis({
            sessionId: "session-refresh",
            taskId: "TASK-101",
            workerHostAlias: "laptop",
            outcome: "approved",
            anomalies: [
              {
                type: "refreshed_adapter",
                message: "worktree adapter bundle was refreshed",
                value: 1,
                threshold: 0,
              } as never,
            ],
          }),
          makeAnalysis({
            sessionId: "session-class",
            taskId: "TASK-102",
            workerHostAlias: "laptop",
            anomalies: [
              {
                type: "validation_class_mismatch",
                message: "verification class did not match selected command",
                value: 1,
                threshold: 0,
              } as never,
            ],
          }),
        ],
        baseline: null,
        lastRebuilt: null,
      }),
      "utf-8",
    );

    const response = await httpGet(`http://localhost:${port}/api/research/dashboard`);

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      summary: {
        validationDriftRuns: number;
        validationFailureTaxonomy: Record<string, number>;
        validationDriftByWorker: Array<Record<string, unknown>>;
      };
    };
    expect(body.summary.validationDriftRuns).toBe(3);
    expect(body.summary.validationFailureTaxonomy).toMatchObject({
      stale_adapter: 1,
      refreshed_adapter: 1,
      validation_class_mismatch: 1,
    });
    expect(body.summary.validationDriftByWorker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worker: "headnode", stale_adapter: 1 }),
        expect.objectContaining({
          worker: "worker-laptop",
          refreshed_adapter: 1,
          validation_class_mismatch: 1,
        }),
      ]),
    );
  });
});
