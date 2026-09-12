// TASK-1338-C coverage note: these dependency-token cases were added after
// the target-id START matrix had already recorded the pre-change 200 response.
// The production dependency veto was therefore not separately rerun red.

import * as fs from "node:fs";
import * as path from "node:path";

import { QuackDB } from "../../src/db/quack-db";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { createMonitorServer } from "../../src/monitor/server";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  postJson,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

function blockedTask(id: string, blockedBy: string): string {
  return taskSpec(id, { status: "READY" }).replace(
    "- **Blocked By:** []",
    `- **Blocked By:** [${blockedBy}]`,
  );
}

function makeJob(taskId: string): DispatchJob {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    pid: 82,
    startedAt: new Date().toISOString(),
    status: "running",
    output: [],
  };
}

function seedStatuses(root: string, entries: Array<[string, string]>): void {
  const db = new QuackDB(path.join(root, ".quack", "quack.db"));
  try {
    for (const [taskId, status] of entries) {
      db.setStatus(taskId, status, "dependency-fixture");
    }
  } finally {
    db.close();
  }
}

async function startTask(root: string): Promise<{
  response: Awaited<ReturnType<typeof postJson>>;
  startSpy: jest.SpyInstance;
  stop: () => Promise<void>;
}> {
  const startSpy = jest
    .spyOn(DispatchManager.prototype, "start")
    .mockImplementation((taskId) => makeJob(taskId));
  const adapterPath = writeAdapter(root);
  const monitor = createMonitorServer({
    port: 0,
    host: "127.0.0.1",
    projectRoot: root,
    taskDir: "docs/tasks",
    adapterPath,
    logDir: path.join(root, ".quack", "logs"),
  });
  const started = await monitor.start();
  const response = await postJson(started.port, "/api/tasks/TASK-200/start", {
    localSmokeOnly: true,
    skipGate: true,
    skipDecomposeCheck: true,
  });
  return { response, startSpy, stop: started.stop };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "START exact completed dependency claimant gate (%s, %s)",
  (kind, order) => {
    it("refuses a contested DB-complete dependency before target dispatch", async () => {
      const fixture = createDuplicateFixture("quack-start-dependency-exact-", kind, order);
      let stop: (() => Promise<void>) | undefined;
      let startSpy: jest.SpyInstance | undefined;
      try {
        fs.writeFileSync(
          path.join(fixture.taskDir, "TASK-200-target.md"),
          blockedTask("TASK-200", "TASK-100"),
        );
        seedStatuses(fixture.root, [["TASK-100", "COMPLETE"]]);

        const started = await startTask(fixture.root);
        ({ stop, startSpy } = started);

        expect(started.response.status).toBe(409);
        expect(started.response.body).toMatchObject({
          ok: false,
          error: "duplicate_claimants",
          taskId: "TASK-100",
          claimants: fixture.claimants,
        });
        expect(startSpy).not.toHaveBeenCalled();
        const audit = new QuackDB(path.join(fixture.root, ".quack", "quack.db"));
        expect(audit.getStatus("TASK-200")).toBeUndefined();
        audit.close();
      } finally {
        await stop?.();
        startSpy?.mockRestore();
        removeFixture(fixture.root);
      }
    });
  },
);

describe.each(DUPLICATE_FIXTURE_CASES)(
  "START fallback dependency matrix (%s, %s)",
  (kind, order) => {
    it("refuses when one member of an all-subtasks completion fallback is contested", async () => {
      const fixture = createSingleClaimantFixture("quack-start-dependency-fallback-");
      let stop: (() => Promise<void>) | undefined;
      let startSpy: jest.SpyInstance | undefined;
      try {
        fs.writeFileSync(fixture.claimantPaths[0], taskSpec("TASK-100", { status: "DECOMPOSED" }));
        const claimantNames =
          kind === "candidate-scoped"
            ? ["TASK-100-A-a.md", "TASK-100-A-b.md"]
            : ["TASK-100-A-a.md", "TASK-999-A-b.md"];
        const creationNames = order === "forward" ? claimantNames : [...claimantNames].reverse();
        for (const name of creationNames) {
          fs.writeFileSync(path.join(fixture.taskDir, name), taskSpec("TASK-100-A"));
        }
        fs.writeFileSync(path.join(fixture.taskDir, "TASK-100-B.md"), taskSpec("TASK-100-B"));
        fs.writeFileSync(
          path.join(fixture.taskDir, "TASK-200-target.md"),
          blockedTask("TASK-200", "TASK-100"),
        );
        seedStatuses(fixture.root, [
          ["TASK-100", "DECOMPOSED"],
          ["TASK-100-A", "COMPLETE"],
          ["TASK-100-B", "COMPLETE"],
        ]);

        const started = await startTask(fixture.root);
        ({ stop, startSpy } = started);

        expect(started.response.status).toBe(409);
        expect(started.response.body).toMatchObject({
          ok: false,
          error: "duplicate_claimants",
          taskId: "TASK-100-A",
          claimants: [...claimantNames].sort(),
        });
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        await stop?.();
        startSpy?.mockRestore();
        removeFixture(fixture.root);
      }
    });
  },
);

it.each(["exact", "fallback"] as const)(
  "admits a clean target with an uncontested %s DB-complete dependency",
  async (kind) => {
    const fixture = createSingleClaimantFixture(`quack-start-dependency-clean-${kind}-`);
    let stop: (() => Promise<void>) | undefined;
    let startSpy: jest.SpyInstance | undefined;
    try {
      if (kind === "fallback") {
        fs.writeFileSync(fixture.claimantPaths[0], taskSpec("TASK-100", { status: "DECOMPOSED" }));
        fs.writeFileSync(path.join(fixture.taskDir, "TASK-100-A.md"), taskSpec("TASK-100-A"));
        fs.writeFileSync(path.join(fixture.taskDir, "TASK-100-B.md"), taskSpec("TASK-100-B"));
        seedStatuses(fixture.root, [
          ["TASK-100", "DECOMPOSED"],
          ["TASK-100-A", "COMPLETE"],
          ["TASK-100-B", "COMPLETE"],
        ]);
      } else {
        seedStatuses(fixture.root, [["TASK-100", "COMPLETE"]]);
      }
      fs.writeFileSync(
        path.join(fixture.taskDir, "TASK-200-target.md"),
        blockedTask("TASK-200", "TASK-100"),
      );

      const started = await startTask(fixture.root);
      ({ stop, startSpy } = started);

      expect(started.response.status).toBe(200);
      expect(started.response.body).toMatchObject({
        ok: true,
        taskId: "TASK-200",
        sessionId: "session-TASK-200",
        dispatchMode: "local_smoke",
        message: "Dispatch started for TASK-200",
      });
      expect(startSpy).toHaveBeenCalledTimes(1);
      const audit = new QuackDB(path.join(fixture.root, ".quack", "quack.db"));
      expect(audit.getStatus("TASK-200")?.status).toBe("IN_PROGRESS");
      audit.close();
    } finally {
      await stop?.();
      startSpy?.mockRestore();
      removeFixture(fixture.root);
    }
  },
);
