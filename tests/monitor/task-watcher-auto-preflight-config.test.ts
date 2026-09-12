import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { createMonitorServer, type MonitorServer } from "../../src/monitor/server";
import { PrepWorker, type PrepJob } from "../../src/monitor/prep-worker";
import { TaskWatcher } from "../../src/monitor/task-watcher";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86_400_000 }),
}));

jest.setTimeout(120_000);

function createProject(autoRun: boolean | undefined, name: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auto-preflight-"));
  fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
  fs.writeFileSync(
    path.join(projectRoot, ".quack", "adapter.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        project: {
          name,
          root: projectRoot,
          taskDir: "docs/tasks",
          conventionsDir: ".quack",
        },
        agent: {
          model: "claude-opus-4-20250514",
          judgeModel: "claude-sonnet-4-20250514",
          enrichModel: "claude-sonnet-4-20250514",
          maxTurns: 30,
          maxBudgetPerTask: 5,
          maxRetries: 1,
        },
        verification: {
          commands: [
            {
              name: "fixture",
              command: "node --version",
              required: true,
              timeout: 10_000,
            },
          ],
          conventionChecks: [],
        },
        sandbox: {
          writablePaths: [],
          deniedPaths: [],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        git: {
          branchPrefix: "quack",
          baseBranch: "main",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Automated-By: Quack",
          autoCreatePr: false,
          autoPush: false,
        },
        logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
        preflight: autoRun === undefined ? undefined : { autoRun },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return projectRoot;
}

function writeReadyTask(projectRoot: string, taskId: string): string {
  const filePath = path.join(projectRoot, "docs", "tasks", `${taskId}.md`);
  fs.writeFileSync(
    filePath,
    [
      `# ${taskId}: Auto-preflight fixture`,
      "",
      "## Metadata",
      "- **Priority:** P2-MEDIUM",
      "- **Effort:** 1 hour",
      "- **Status:** READY",
      "- **Blocked By:** []",
      "",
      "## Problem Statement",
      "Prove that the adapter's preflight.autoRun setting controls watcher-triggered prep.",
      "",
      "## Success Criteria",
      "- The watcher respects the configured auto-run setting",
      "",
      "## Testing Requirements",
      "- Exercise the monitor-wired watcher",
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

function fakePrepJob(taskId: string): PrepJob {
  return {
    taskId,
    pid: 12345,
    startedAt: "2026-09-09T00:00:00.000Z",
    status: "running",
  };
}

interface ProcessableWatcher {
  processFile(filePath: string): Promise<void>;
}

function processable(
  watcher: { close: () => Promise<void> } | null | undefined,
): ProcessableWatcher {
  if (!watcher) throw new Error("monitor did not construct a task watcher");
  return watcher as unknown as ProcessableWatcher;
}

async function stopServer(server: MonitorServer | null): Promise<void> {
  if (server) await server.stop();
}

describe.each([
  [undefined, 0],
  [false, 0],
  [true, 1],
] as const)("multi-project TaskWatcher with preflight.autoRun=%s", (autoRun, expectedStarts) => {
  it(`queues prep ${expectedStarts === 0 ? "never" : "once"}`, async () => {
    const projectRoot = createProject(autoRun, `Multi Auto Preflight ${autoRun}`);
    let server: MonitorServer | null = null;
    const watcherStart = jest.spyOn(TaskWatcher.prototype, "start").mockResolvedValue(undefined);
    const prepStart = jest
      .spyOn(PrepWorker.prototype, "start")
      .mockImplementation((taskId) => fakePrepJob(taskId));

    try {
      const adapter = await loadAdapter(projectRoot);
      server = createMonitorServer({ port: 0, projectAdapters: [adapter] });
      await server.start();

      const context = server.registry?.listProjects()[0];
      if (!context) throw new Error("monitor did not register the fixture project");
      await processable(context.taskWatcher).processFile(
        writeReadyTask(projectRoot, `TASK-${autoRun ? "5102" : "5101"}`),
      );

      expect(watcherStart).toHaveBeenCalledTimes(1);
      expect(prepStart).toHaveBeenCalledTimes(expectedStarts);
    } finally {
      await stopServer(server);
      jest.restoreAllMocks();
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

describe.each([
  [undefined, 0],
  [false, 0],
  [true, 1],
] as const)(
  "legacy single-project TaskWatcher with preflight.autoRun=%s",
  (autoRun, expectedStarts) => {
    it(`queues prep ${expectedStarts === 0 ? "never" : "once"}`, async () => {
      const projectRoot = createProject(autoRun, `Legacy Auto Preflight ${autoRun}`);
      let server: MonitorServer | null = null;
      const capturedWatchers: TaskWatcher[] = [];
      const watcherStart = jest
        .spyOn(TaskWatcher.prototype, "start")
        .mockImplementation(function captureWatcher(this: TaskWatcher) {
          capturedWatchers.push(this);
          return Promise.resolve();
        });
      const prepStart = jest
        .spyOn(PrepWorker.prototype, "start")
        .mockImplementation((taskId) => fakePrepJob(taskId));

      try {
        const adapter: ProjectAdapter = await loadAdapter(projectRoot);
        server = createMonitorServer({
          port: 0,
          logDir: path.resolve(projectRoot, adapter.config.logging.dir),
          adapterPath: path.resolve(projectRoot, ".quack", "adapter.json"),
          projectRoot,
          taskDir: adapter.config.project.taskDir,
        });
        await server.start();

        const capturedWatcher = capturedWatchers[0];
        if (!capturedWatcher) throw new Error("monitor did not construct the legacy task watcher");
        await capturedWatcher.processFile(
          writeReadyTask(projectRoot, `TASK-${autoRun ? "5202" : "5201"}`),
        );

        expect(watcherStart).toHaveBeenCalledTimes(1);
        expect(prepStart).toHaveBeenCalledTimes(expectedStarts);
      } finally {
        await stopServer(server);
        jest.restoreAllMocks();
        fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  },
);
