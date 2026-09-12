// TASK-1336-A preserved proof port: publish-all must emit declared ids and every
// sync-map surface must use the loaded adapter's absolute project root.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import express from "express";

import { handlePublish } from "../../../src/cli/publish";
import { loadAdapter } from "../../../src/core/adapter-loader";
import type { GitHubConfig, SyncEntry } from "../../../src/integrations/github/github-types";
import { publishAllBacklog } from "../../../src/integrations/github/issue-publisher";
import {
  getSyncMap,
  resolveGitHubSyncMapPath,
  withSyncMapTransaction,
} from "../../../src/integrations/github/sync-map";
import {
  getSyncStatus,
  syncAllTasks,
  syncDispatchComplete,
  syncDispatchStarted,
  syncPRCreated,
  syncTaskStatusToIssue,
} from "../../../src/integrations/github/status-syncer";
import { createMonitorServer } from "../../../src/monitor/server";
import { registerGitHubSyncRoutes } from "../../../src/monitor/routes/github-sync";
import { taskSpec, writeTestAdapter } from "../../helpers/divergent-task-fixture";

type RunBoundGitHubCommand =
  typeof import("../../../src/integrations/github/trusted-github").runBoundGitHubCommand;
type ReadBoundGitHubIssuePage =
  typeof import("../../../src/integrations/github/trusted-github").readBoundGitHubIssuePage;
const mockRunBoundGitHubCommand = jest.fn<
  ReturnType<RunBoundGitHubCommand>,
  Parameters<RunBoundGitHubCommand>
>();
const mockReadBoundGitHubIssuePage = jest.fn<
  ReturnType<ReadBoundGitHubIssuePage>,
  Parameters<ReadBoundGitHubIssuePage>
>();

jest.mock("../../../src/integrations/github/trusted-github", () => ({
  ...jest.requireActual<object>("../../../src/integrations/github/trusted-github"),
  runBoundGitHubCommand: (...args: Parameters<RunBoundGitHubCommand>) =>
    mockRunBoundGitHubCommand(...args),
  readBoundGitHubIssuePage: (...args: Parameters<ReadBoundGitHubIssuePage>) =>
    mockReadBoundGitHubIssuePage(...args),
}));

const REPOSITORY = { host: "github.com", owner: "fixture", repo: "repo" };
const ISSUE_URL = "https://github.com/fixture/repo/issues/736";
const mockPublishedIssues = new Map<
  string,
  {
    number: number;
    url: string;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    state: string;
    createdAt: string;
  }
>();

beforeEach(() => {
  mockPublishedIssues.clear();
  const result = (stdout: string) =>
    Promise.resolve({
      exitCode: 0,
      stdout,
      stderr: "",
      repository: REPOSITORY,
    });
  mockReadBoundGitHubIssuePage.mockReset().mockImplementation((root, config, after) => {
    expect(path.isAbsolute(root)).toBe(true);
    expect(config).toMatchObject({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });
    expect(after).toBeUndefined();
    const created = mockPublishedIssues.get(root);
    return result(
      JSON.stringify({
        data: {
          repository: {
            nameWithOwner: "fixture/repo",
            issues: {
              nodes: created ? [created] : [],
              totalCount: created ? 1 : 0,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
  });
  mockRunBoundGitHubCommand.mockReset().mockImplementation((root, config, args, options) => {
    expect(path.isAbsolute(root)).toBe(true);
    expect(config).toMatchObject({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });
    if (args[0] === "issue" && args[1] === "create") {
      expect(args).toEqual([
        "issue",
        "create",
        expect.stringMatching(/^--title=/u),
        "--label=quack-task",
        "--body-file",
        "-",
      ]);
      expect(mockPublishedIssues.has(root)).toBe(false);
      if (typeof options?.input !== "string") throw new Error("Missing fixture issue body");
      mockPublishedIssues.set(root, {
        number: 736,
        url: ISSUE_URL,
        title: (args[2] ?? "").slice("--title=".length),
        body: options.input,
        labels: [{ name: "quack-task" }],
        state: "open",
        createdAt: "2026-08-18T16:00:00.000Z",
      });
      return result(`${ISSUE_URL}\n`);
    }
    expect(args).toEqual(["issue", "view", "736", "--json", "number,url,title,body,labels,state"]);
    const created = mockPublishedIssues.get(root);
    if (!created) throw new Error("Missing fixture issue for authoritative readback");
    return result(JSON.stringify(created));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

jest.mock("../../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

const GITHUB_CONFIG: GitHubConfig = {
  owner: "fixture",
  repo: "repo",
  publishLabel: "quack-task",
  pollEnabled: false,
};

const FIXED_TIME = "2026-08-18T16:00:00.000Z";

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

function syncEntry(taskId: string, issueNumber: number): SyncEntry {
  return {
    taskId,
    issueNumber,
    direction: "published",
    createdAt: FIXED_TIME,
    lastSyncedAt: FIXED_TIME,
    issueState: "open",
    taskStatus: "BACKLOG",
  };
}

function writeSyncMap(projectRoot: string, entries: SyncEntry[]): string {
  const syncPath = path.join(projectRoot, ".quack", "sync", "github-sync.json");
  fs.mkdirSync(path.dirname(syncPath), { recursive: true });
  fs.writeFileSync(syncPath, JSON.stringify({ entries }, null, 2), "utf-8");
  return syncPath;
}

function createDescriptiveProject(prefix: string): {
  root: string;
  taskDir: string;
  syncPath: string;
  cleanup(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "TASK-610-descriptive-publisher-file.md"),
    taskSpec("TASK-610", { title: "Declared publisher identity", status: "BACKLOG" }),
    "utf-8",
  );
  const adapterPath = writeTestAdapter(root, GITHUB_CONFIG);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
    project: { root: string };
  };
  adapter.project.root = ".";
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2), "utf-8");
  return {
    root,
    taskDir,
    syncPath: path.join(root, ".quack", "sync", "github-sync.json"),
    cleanup: () =>
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function requestJson(
  port: number,
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
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

describe("TASK-1336-A: declared-id publishing", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    jest.restoreAllMocks();
  });

  it("returns the parsed declared id for a descriptive filename", async () => {
    const fixture = createDescriptiveProject("quack-1336a-result-");
    try {
      const outcome = await publishAllBacklog(fixture.root, "docs/tasks", GITHUB_CONFIG);
      expect(outcome).toEqual({
        published: [
          {
            taskId: "TASK-610",
            issueNumber: 736,
            url: "https://github.com/fixture/repo/issues/736",
          },
        ],
        skipped: [],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("CLI persists the declared id only in the selected project from a foreign cwd", async () => {
    const fixture = createDescriptiveProject("quack-1336a-cli-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-cli-cwd-"));
    const decoyPath = writeSyncMap(foreignCwd, [syncEntry("TASK-DECOY", 999)]);
    const decoyBefore = fs.readFileSync(decoyPath, "utf-8");
    try {
      process.chdir(foreignCwd);
      await handlePublish({ allBacklog: true, project: fixture.root });

      expect(readJson<{ entries: SyncEntry[] }>(fixture.syncPath).entries).toEqual([
        expect.objectContaining({ taskId: "TASK-610", issueNumber: 736 }),
      ]);
      expect(fs.readFileSync(decoyPath, "utf-8")).toBe(decoyBefore);
    } finally {
      process.chdir(originalCwd);
      fixture.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("HTTP batch publish persists the declared id only in the selected project from a foreign cwd", async () => {
    const fixture = createDescriptiveProject("quack-1336a-http-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-http-cwd-"));
    const decoyPath = writeSyncMap(foreignCwd, [syncEntry("TASK-DECOY", 999)]);
    const decoyBefore = fs.readFileSync(decoyPath, "utf-8");
    const port = await freePort();
    const adapter = await loadAdapter(fixture.root);
    const monitor = createMonitorServer({
      port,
      quackRoot: fixture.root,
      projectAdapters: [adapter],
    });
    const started = await monitor.start();
    try {
      process.chdir(foreignCwd);
      const response = await requestJson(port, "POST", "/api/github/publish", {
        allBacklog: true,
      });
      expect(response).toEqual({
        status: 200,
        body: {
          success: true,
          published: [
            {
              taskId: "TASK-610",
              issueNumber: 736,
              url: "https://github.com/fixture/repo/issues/736",
            },
          ],
          skipped: [],
        },
      });
      expect(readJson<{ entries: SyncEntry[] }>(fixture.syncPath).entries).toEqual([
        expect.objectContaining({ taskId: "TASK-610", issueNumber: 736 }),
      ]);
      expect(fs.readFileSync(decoyPath, "utf-8")).toBe(decoyBefore);
    } finally {
      process.chdir(originalCwd);
      await started.stop();
      fixture.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

// LANDED COMPATIBILITY INVARIANT: the marker is diagnostic-only and must
// retain E's exact unparseable:<basename> publish_failed shape.
describe("TASK-1336-A: landed unparseable marker compatibility invariant", () => {
  it("never persists the diagnostic marker beside a valid declared id", async () => {
    const fixture = createDescriptiveProject("quack-1336a-marker-");
    const originalCwd = process.cwd();
    const malformedName = "TASK-611-malformed.md";
    fs.writeFileSync(path.join(fixture.taskDir, malformedName), "not a task\n", "utf-8");
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      process.chdir(fixture.root);
      await handlePublish({ allBacklog: true, project: fixture.root });
      const outcome = await publishAllBacklog(fixture.root, "docs/tasks", GITHUB_CONFIG);
      expect(outcome.skipped).toEqual([
        {
          taskId: `unparseable:${malformedName}`,
          file: malformedName,
          reason: "publish_failed",
          message: expect.stringContaining("Missing required H1 heading") as unknown as string,
        },
      ]);
      const map = readJson<{ entries: SyncEntry[] }>(fixture.syncPath);
      expect(map.entries.map((entry) => entry.taskId)).toEqual(["TASK-610"]);
      expect(map.entries.some((entry) => entry.taskId.startsWith("unparseable:"))).toBe(false);
      expect(exit).toHaveBeenCalledWith(1);
      expect([...log.mock.calls, ...error.mock.calls].flat().join("\n")).toContain(
        `unparseable:${malformedName}`,
      );
    } finally {
      process.chdir(originalCwd);
      fixture.cleanup();
    }
  });
});

describe("TASK-1336-A: sync-map CRUD path authority", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("reads and deletes only the selected project's map from a foreign cwd", async () => {
    const selected = createDescriptiveProject("quack-1336a-crud-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-crud-cwd-"));
    const selectedEntry = syncEntry("TASK-SELECTED", 41);
    const decoyEntry = syncEntry("TASK-DECOY", 99);
    writeSyncMap(selected.root, [selectedEntry]);
    const decoyPath = writeSyncMap(foreignCwd, [decoyEntry]);
    const decoyBefore = fs.readFileSync(decoyPath, "utf-8");
    const app = express();
    registerGitHubSyncRoutes(app, () => ({ projectRoot: selected.root }));
    const port = await freePort();
    const server = app.listen(port, "127.0.0.1");
    try {
      process.chdir(foreignCwd);
      expect(await requestJson(port, "GET", "/api/github/sync-map")).toEqual({
        status: 200,
        body: { entries: [selectedEntry] },
      });
      expect(await requestJson(port, "DELETE", "/api/github/sync-map/TASK-SELECTED")).toEqual({
        status: 200,
        body: { ok: true, deleted: selectedEntry },
      });
      expect(readJson<{ entries: SyncEntry[] }>(selected.syncPath).entries).toEqual([]);
      expect(fs.readFileSync(decoyPath, "utf-8")).toBe(decoyBefore);
    } finally {
      process.chdir(originalCwd);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      selected.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("normalizes a relative root at the deprecated monitor construction boundary", async () => {
    const selected = createDescriptiveProject("quack-1336a-legacy-monitor-root-");
    const parent = path.dirname(selected.root);
    const relativeRoot = path.relative(parent, selected.root);
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-legacy-monitor-cwd-"));
    const selectedEntry = syncEntry("TASK-LEGACY-BOUNDARY", 51);
    writeSyncMap(selected.root, [selectedEntry]);
    const port = await freePort();
    let started: Awaited<ReturnType<ReturnType<typeof createMonitorServer>["start"]>> | undefined;
    try {
      process.chdir(parent);
      const monitor = createMonitorServer({
        port,
        projectRoot: relativeRoot,
        taskDir: selected.taskDir,
        logDir: path.join(selected.root, ".quack", "logs"),
        adapterPath: path.join(selected.root, ".quack", "adapter.json"),
        quackRoot: selected.root,
      });
      started = await monitor.start();
      process.chdir(foreignCwd);

      expect(await requestJson(port, "GET", "/api/github/sync-map")).toEqual({
        status: 200,
        body: { entries: [selectedEntry] },
      });
    } finally {
      process.chdir(originalCwd);
      if (started) await started.stop();
      selected.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

describe("TASK-1336-A: status sync path authority", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("keeps an explicit defined string root as the required final parameter on all wrappers", () => {
    type HasRequiredStringRoot<Arguments extends readonly unknown[]> = Arguments extends [
      ...unknown[],
      infer Root,
    ]
      ? undefined extends Root
        ? false
        : Root extends string
          ? true
          : false
      : false;
    type Assert<T extends true> = T;
    const arityTripwires: [
      Assert<HasRequiredStringRoot<Parameters<typeof syncDispatchStarted>>>,
      Assert<HasRequiredStringRoot<Parameters<typeof syncDispatchComplete>>>,
      Assert<HasRequiredStringRoot<Parameters<typeof syncPRCreated>>>,
      Assert<HasRequiredStringRoot<Parameters<typeof syncTaskStatusToIssue>>>,
      Assert<HasRequiredStringRoot<Parameters<typeof syncAllTasks>>>,
      Assert<HasRequiredStringRoot<Parameters<typeof getSyncStatus>>>,
    ] = [true, true, true, true, true, true];

    expect(arityTripwires).toEqual([true, true, true, true, true, true]);
  });

  it("reads only the selected project's map from a foreign cwd", async () => {
    const selected = createDescriptiveProject("quack-1336a-status-reader-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-status-reader-cwd-"));
    writeSyncMap(selected.root, [syncEntry("TASK-SELECTED", 61)]);
    writeSyncMap(foreignCwd, [syncEntry("TASK-DECOY", 62)]);
    const adapter = await loadAdapter(selected.root);
    try {
      process.chdir(foreignCwd);
      expect(await getSyncStatus(adapter.config, adapter.projectRoot)).toEqual({
        totalEntries: 1,
        entries: [
          {
            taskId: "TASK-SELECTED",
            issueNumber: 61,
            direction: "published",
            lastSyncedAt: FIXED_TIME,
          },
        ],
      });
    } finally {
      process.chdir(originalCwd);
      selected.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("writes only the selected project's map from a foreign cwd", async () => {
    const selected = createDescriptiveProject("quack-1336a-status-writer-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-status-writer-cwd-"));
    const selectedPath = writeSyncMap(selected.root, [syncEntry("TASK-SHARED", 71)]);
    const decoyPath = writeSyncMap(foreignCwd, [syncEntry("TASK-SHARED", 72)]);
    const decoyBefore = fs.readFileSync(decoyPath, "utf-8");
    const adapter = await loadAdapter(selected.root);
    try {
      process.chdir(foreignCwd);
      await syncTaskStatusToIssue("TASK-SHARED", "COMPLETE", adapter.config, adapter.projectRoot);

      expect(readJson<{ entries: SyncEntry[] }>(selectedPath).entries).toEqual([
        expect.objectContaining({ taskId: "TASK-SHARED", issueNumber: 71, taskStatus: "COMPLETE" }),
      ]);
      expect(fs.readFileSync(decoyPath, "utf-8")).toBe(decoyBefore);
    } finally {
      process.chdir(originalCwd);
      selected.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

// Current-candidate compatibility: the migrated root API must retain the
// transaction path and the existing owner-fenced sync-map lock.
describe("TASK-1336-A: current transaction path authority", () => {
  it("refuses a relative root before a factory or transaction can choose the cwd", async () => {
    expect(() => resolveGitHubSyncMapPath(".")).toThrow("project root must be absolute");
    await expect(getSyncMap(".")).rejects.toThrow("project root must be absolute");
    const operation = jest.fn(() => undefined);
    await expect(withSyncMapTransaction(".", operation)).rejects.toThrow(
      "project root must be absolute",
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("syncs the selected project under its transaction lock from a foreign cwd", async () => {
    const selected = createDescriptiveProject("quack-1336a-transaction-root-");
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-transaction-cwd-"));
    const originalCwd = process.cwd();
    writeSyncMap(selected.root, [syncEntry("TASK-610", 81)]);
    const decoyPath = writeSyncMap(foreignCwd, [syncEntry("TASK-DECOY", 82)]);
    const decoyBefore = fs.readFileSync(decoyPath, "utf8");
    const adapter = await loadAdapter(selected.root);
    try {
      process.chdir(foreignCwd);
      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
      expect(outcome).toEqual({
        outcomes: [
          {
            taskId: "TASK-610",
            issueNumber: 81,
            outcome: "synced",
            taskStatus: "BACKLOG",
            statusChanged: false,
          },
        ],
      });
      expect(readJson<{ entries: SyncEntry[] }>(selected.syncPath).entries).toEqual([
        expect.objectContaining({ taskId: "TASK-610", issueNumber: 81 }),
      ]);
      expect(fs.readFileSync(decoyPath, "utf8")).toBe(decoyBefore);
      expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      selected.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
