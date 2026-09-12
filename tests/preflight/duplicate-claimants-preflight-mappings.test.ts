// TASK-1338-B pre-change record: the HTTP mapping executed and FAILED at 409
// because the route wrapped the refused result in ok:true. Both CLI mappings
// executed and FAILED at exit 1 because they followed the success path.

import * as path from "node:path";

import { preflightCommand } from "../../src/cli/preflight";
import { createMonitorServer } from "../../src/monitor/server";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { runPreflight } from "../../src/preflight/preflight-runner";
import {
  createDuplicateFixture,
  expectPinnedHttpRefusal,
  postJson,
  removeFixture,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/preflight/preflight-runner", () => ({ runPreflight: jest.fn() }));

const claimants = ["TASK-100-a.md", "TASK-999-b.md"];
const refusedResult = {
  taskId: "TASK-100",
  timestamp: "2026-08-18T00:00:00.000Z",
  contentHash: "a".repeat(64),
  gate: { ready: true, score: 5, dimensions: {} },
  blueprint: {
    fileAnalyses: 1,
    codeExamples: 0,
    verificationPatterns: 0,
    antiPatterns: 0,
    formattedMarkdown: "fixture",
  },
  contextEstimate: {
    taskSpec: 1,
    blueprint: 1,
    repoMap: 0,
    relevantFiles: 0,
    relatedPatterns: 0,
    existingTests: 0,
    conventions: 0,
    claudeMd: 0,
    total: 2,
    withinBudget: true,
  },
  complexity: {
    filesToModify: 1,
    successCriteria: 1,
    estimatedContextTokens: 2,
    independentFeatures: 1,
    featureClusters: [],
    recommendDecomposition: true,
    reason: "fixture",
  },
  decomposition: {
    decomposed: false,
    subtaskIds: ["TASK-100-A"],
    subtaskFiles: [],
    refused: { errorType: "duplicate_claimants", claimants },
  },
} as unknown as PreflightResult;

const mockedRunPreflight = runPreflight as jest.MockedFunction<typeof runPreflight>;

beforeEach(() => {
  mockedRunPreflight.mockReset();
  mockedRunPreflight.mockResolvedValue(refusedResult);
});

it("maps a refused preflight result to the pinned HTTP 409", async () => {
  const fixture = createDuplicateFixture(
    "quack-preflight-http-map-",
    "cross-population",
    "forward",
  );
  const adapterPath = writeAdapter(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      quackRoot: fixture.root,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await server.start();
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/preflight", { force: true });
    expectPinnedHttpRefusal(response, claimants);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});

it.each([false, true])(
  "maps a refused preflight result to pinned CLI stderr (json=%s)",
  async (json) => {
    const fixture = createDuplicateFixture(
      "quack-preflight-cli-map-",
      "cross-population",
      "forward",
    );
    writeAdapter(fixture.root);
    let exitCode: number | undefined;
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await preflightCommand("TASK-100", { project: fixture.root, json });
      expect(exitCode).toBe(1);
      if (json) {
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const rendered: unknown = errorSpy.mock.calls[0][0];
        const parsed = JSON.parse(String(rendered)) as Record<string, unknown>;
        expect(parsed).toEqual({
          error: "duplicate_claimants",
          taskId: "TASK-100",
          claimants,
          message: `Task TASK-100 has duplicate claimants: ${claimants.join(", ")}. Refusing to write until the id has one owner.`,
        });
      } else {
        const stderr = errorSpy.mock.calls.flat().join(" ");
        expect(stderr).toContain("TASK-100");
        for (const claimant of claimants) expect(stderr).toContain(claimant);
      }
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      removeFixture(fixture.root);
    }
  },
);
