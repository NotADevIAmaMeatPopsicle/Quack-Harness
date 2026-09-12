import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { TaskService } from "../../src/monitor/task-service";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function observeShutdownDeadlines(): {
  pending: () => Array<{ referenced: boolean; stack: string }>;
  fired: () => number;
  restore: () => void;
} {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const deadlines = new Map<NodeJS.Timeout, string>();
  let fired = 0;
  const timeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = originalSetTimeout(() => {
      if (deadlines.delete(timer)) fired += 1;
      callback(...args);
    }, delay);
    if (delay === 1000) deadlines.set(timer, new Error("Shutdown deadline allocated").stack ?? "");
    return timer;
  }) as typeof setTimeout);
  const clearSpy = jest.spyOn(global, "clearTimeout").mockImplementation((timer) => {
    if (timer && typeof timer === "object") deadlines.delete(timer);
    originalClearTimeout(timer);
  });
  return {
    pending: () => [...deadlines].map(([timer, stack]) => ({ referenced: timer.hasRef(), stack })),
    fired: () => fired,
    restore: () => {
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

describe("monitor shutdown deadline ownership", () => {
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shutdown-timers-"));
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  });

  afterEach(async () => {
    try {
      if (stop) await stop();
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } finally {
      stop = undefined;
      jest.restoreAllMocks();
    }
  });

  async function startMonitor(): Promise<void> {
    const monitor = createMonitorServer({
      projectRoot,
      quackRoot: projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    stop = (await monitor.start()).stop;
  }

  it("returns from stop without retaining deadlines for already-settled startup work", async () => {
    const validation = jest.spyOn(TaskService.prototype, "startupValidation").mockResolvedValue();
    await startMonitor();
    expect(validation).toHaveBeenCalledTimes(1);
    const deadlines = observeShutdownDeadlines();
    try {
      await stop!();
      expect(deadlines.fired()).toBe(0);
      expect(deadlines.pending()).toEqual([]);
    } finally {
      deadlines.restore();
    }
  });

  it("keeps the one-second fallback referenced until pending startup work reaches its deadline", async () => {
    let releaseValidation: (() => void) | undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    jest.spyOn(TaskService.prototype, "startupValidation").mockReturnValue(validationGate);
    await startMonitor();
    const deadlines = observeShutdownDeadlines();
    const stopping = stop!();
    try {
      const observationDeadline = Date.now() + 5000;
      while (deadlines.pending().length === 0) {
        if (Date.now() >= observationDeadline)
          throw new Error("Shutdown deadline was not allocated");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(deadlines.pending().map((deadline) => deadline.referenced)).toEqual([true]);
      await stopping;
      expect(deadlines.fired()).toBe(1);
      expect(deadlines.pending()).toEqual([]);
    } finally {
      releaseValidation?.();
      await stopping;
      deadlines.restore();
    }
  });
});
