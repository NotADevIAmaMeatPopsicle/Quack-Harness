import { loadAdapter } from "../../src/core/adapter-loader";
import * as issueFetcher from "../../src/integrations/github/issue-fetcher";
import * as importPipeline from "../../src/integrations/github/import-pipeline";
import * as statusSyncer from "../../src/integrations/github/status-syncer";
import { createMonitorServer } from "../../src/monitor/server";
import { TaskService } from "../../src/monitor/task-service";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
} from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

type PollKind = "import" | "sync";
const POLL_INTERVAL_MS = 123_457;
const SYNC_INTERVAL_MS = 234_569;

async function settleCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected GitHub shutdown state was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function observeShutdownDeadlines(): {
  pending: () => NodeJS.Timeout[];
  fired: () => number;
} {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const pending = new Set<NodeJS.Timeout>();
  let fired = 0;
  jest.spyOn(global, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = originalSetTimeout(() => {
      if (pending.delete(timer)) fired += 1;
      callback(...args);
    }, delay);
    if (delay === 1000) pending.add(timer);
    return timer;
  }) as typeof setTimeout);
  jest.spyOn(global, "clearTimeout").mockImplementation((timer) => {
    if (timer && typeof timer === "object") pending.delete(timer);
    originalClearTimeout(timer);
  });
  return { pending: () => [...pending], fired: () => fired };
}

describe("monitor owns in-flight GitHub polling during shutdown", () => {
  let fixture: DivergentTaskFixture;
  let stopServer: (() => Promise<void>) | undefined;
  let releaseWork: (() => void) | undefined;

  beforeEach(() => {
    fixture = createDivergentTaskFixture("child-first", { prefix: "quack-github-stop-" });
    writeTestAdapter(fixture.root, {
      reportBack: false,
      pollEnabled: true,
      pollIntervalMs: POLL_INTERVAL_MS,
      statusSyncIntervalMs: SYNC_INTERVAL_MS,
    });
    jest.spyOn(TaskService.prototype, "startupValidation").mockResolvedValue();
  });

  afterEach(async () => {
    releaseWork?.();
    await settleCallbacks();
    try {
      if (stopServer) await stopServer();
      fixture.cleanup();
    } finally {
      stopServer = undefined;
      releaseWork = undefined;
      jest.restoreAllMocks();
    }
  });

  async function startHeldPoll(kind: PollKind): Promise<{
    timeline: string[];
    closeCalls: () => number;
    callCounts: () => number[];
    runQueuedCallbacks: () => void;
    stop: () => Promise<void>;
    release: () => void;
  }> {
    const timeline: string[] = [];
    const callbacks = new Map<PollKind, () => void>();
    const originalSetInterval = global.setInterval;
    jest.spyOn(global, "setInterval").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === POLL_INTERVAL_MS) callbacks.set("import", () => callback(...args));
      if (delay === SYNC_INTERVAL_MS) callbacks.set("sync", () => callback(...args));
      return originalSetInterval(callback, delay, ...args);
    }) as typeof setInterval);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseWork = release;
    const syncOutcome: statusSyncer.SyncAllTasksOutcome = {
      outcomes: [
        {
          taskId: "TASK-100",
          issueNumber: 42,
          outcome: "skipped",
          reason: "duplicate_claimants",
          claimants: ["TASK-100-A-child.md", "TASK-100-parent.md"],
        },
      ],
    };
    const sync = jest.spyOn(statusSyncer, "syncAllTasks").mockImplementation(() => {
      timeline.push("sync-entered");
      return (kind === "sync" ? gate : Promise.resolve()).then(() => {
        timeline.push("sync-finished");
        return syncOutcome;
      });
    });
    const fetch = jest.spyOn(issueFetcher, "fetchIssuesByLabel").mockResolvedValue([
      {
        number: 42,
        title: "Shutdown ownership fixture",
        body: "This fixture never invokes a provider.",
        labels: [],
        assignees: [],
        comments: [],
        referencedFiles: [],
        linkedPRs: [],
        state: "open",
        url: "https://github.com/fixture-owner/fixture-repo/issues/42",
      },
    ]);
    const importIssue = jest.spyOn(importPipeline, "importIssue").mockImplementation(() => {
      timeline.push("import-entered");
      return (kind === "import" ? gate : Promise.resolve()).then(() => {
        timeline.push("import-finished");
        return { taskId: "TASK-200", issueNumber: 42 };
      });
    });
    const observeDiagnostic = (message?: unknown): void => {
      if (typeof message === "string" && /^\[github-(?:poll|sync)\]/.test(message)) {
        timeline.push("diagnostic");
      }
    };
    jest.spyOn(console, "log").mockImplementation(observeDiagnostic);
    jest.spyOn(console, "warn").mockImplementation(observeDiagnostic);

    const adapter = await loadAdapter(fixture.root);
    const monitor = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      quackRoot: fixture.root,
      projectAdapters: [adapter],
    });
    stopServer = (await monitor.start()).stop;
    const project = monitor.registry?.getActiveProject();
    if (!project) throw new Error("Expected the actual registered fixture project");
    const closeDb = project.db.close.bind(project.db);
    const close = jest.spyOn(project.db, "close").mockImplementation(() => {
      timeline.push("database-close");
      closeDb();
    });
    expect(callbacks.size).toBe(2);
    callbacks.get(kind)!();
    await waitFor(() => timeline.includes(`${kind}-entered`));
    if (kind === "sync") expect(sync).toHaveBeenCalledWith(adapter.config, fixture.root);
    else {
      expect(fetch).toHaveBeenCalledWith(
        "fixture-owner",
        "fixture-repo",
        "quack-ready",
        fixture.root,
      );
      expect(importIssue).toHaveBeenCalledWith(42, adapter, false);
    }
    return {
      timeline,
      closeCalls: () => close.mock.calls.length,
      callCounts: () => [
        fetch.mock.calls.length,
        importIssue.mock.calls.length,
        sync.mock.calls.length,
      ],
      runQueuedCallbacks: () => {
        for (const callback of callbacks.values()) callback();
      },
      stop: stopServer,
      release,
    };
  }

  test.each<PollKind>(["import", "sync"])(
    "waits for an admitted %s callback and its diagnostic before closing project state",
    async (kind) => {
      const held = await startHeldPoll(kind);
      const deadlines = observeShutdownDeadlines();
      let settled = false;
      const stopping = held.stop().then(() => {
        settled = true;
      });
      try {
        await waitFor(() => settled || deadlines.pending().length > 0);
        expect(settled).toBe(false);
        expect(held.closeCalls()).toBe(0);
        expect(deadlines.pending().map((timer) => timer.hasRef())).toEqual([true]);
        const calls = held.callCounts();
        held.runQueuedCallbacks();
        await settleCallbacks();
        expect(held.callCounts()).toEqual(calls);

        held.release();
        await stopping;
        expect(held.timeline.indexOf(`${kind}-finished`)).toBeLessThan(
          held.timeline.indexOf("diagnostic"),
        );
        expect(held.timeline.indexOf("diagnostic")).toBeLessThan(
          held.timeline.indexOf("database-close"),
        );
        expect(held.closeCalls()).toBe(1);
        expect(deadlines.fired()).toBe(0);
        expect(deadlines.pending()).toEqual([]);
      } finally {
        held.release();
        await settleCallbacks();
        await stopping;
      }
    },
  );

  test.each<PollKind>(["import", "sync"])(
    "refuses stop after the one-second grace for %s, retains resources, and retries after completion",
    async (kind) => {
      const held = await startHeldPoll(kind);
      const deadlines = observeShutdownDeadlines();
      const stopping = held.stop();
      try {
        await expect(stopping).rejects.toThrow(
          /GitHub polling callback\(s\) remain active after the 1000ms background grace period/,
        );
        expect(held.closeCalls()).toBe(0);
        expect(held.timeline).not.toContain("diagnostic");
        expect(deadlines.fired()).toBe(1);
        expect(deadlines.pending()).toEqual([]);
        const calls = held.callCounts();
        held.runQueuedCallbacks();
        await settleCallbacks();
        expect(held.callCounts()).toEqual(calls);

        held.release();
        await waitFor(() => held.timeline.includes("diagnostic"));
        await expect(held.stop()).resolves.toBeUndefined();
        expect(held.closeCalls()).toBe(1);
        expect(held.timeline.indexOf("diagnostic")).toBeLessThan(
          held.timeline.indexOf("database-close"),
        );
        expect(deadlines.pending()).toEqual([]);
      } finally {
        held.release();
        await settleCallbacks();
        await stopping.catch(() => undefined);
      }
    },
  );
});
