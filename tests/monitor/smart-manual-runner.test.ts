import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
  exec: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock("../../src/testing/smart-test-runner", () => ({
  getChangedFiles: jest.fn(() => []),
  parseJestOutput: jest.fn(() => ({
    totalTests: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    durationMs: 100,
    suites: [],
    failures: [],
    exitCode: 0,
    timestamp: "2026-04-26T00:00:00.000Z",
  })),
}));

const mockWriteTestArtifact = jest.fn();
jest.mock("../../src/testing/test-formatter", () => ({
  formatTestSummary: jest.fn(() => "2 tests: 2 passed"),
  formatTestDetails: jest.fn(() => ""),
  writeTestArtifact: (...args: unknown[]) => {
    mockWriteTestArtifact(...args);
  },
}));

import { spawn, execSync, execFileSync } from "node:child_process";
import { TestRunner } from "../../src/monitor/server";

class FakeChildProcess extends EventEmitter {
  pid = 1234;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-smart-manual-"));
  fs.mkdirSync(path.join(dir, ".quack", "logs"), { recursive: true });
  return dir;
}

describe("TestRunner smart manual runs", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
    jest.clearAllMocks();
    mockExecSync.mockImplementation((command: string | Buffer) => {
      const text = String(command);
      if (text.includes("git status --porcelain")) return "" as ReturnType<typeof execSync>;
      if (text.includes("git rev-parse HEAD")) return "abc123\n" as ReturnType<typeof execSync>;
      return "" as ReturnType<typeof execSync>;
    });
    mockExecFileSync.mockImplementation((_file: string, args?: readonly string[]) => {
      const text = (args ?? []).join(" ");
      if (text.includes("status --porcelain")) return "";
      if (text.includes("rev-parse HEAD")) return "abc123\n";
      return "";
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on Windows
    }
  });

  test("smart run writes structured artifact after command closes", () => {
    const fakeChild = new FakeChildProcess();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const outputs: string[] = [];
    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];

    const runner = new TestRunner(
      projectRoot,
      (data) => outputs.push(data),
      (stage, payload) => events.push({ stage, payload }),
    );

    const started = runner.start("test", "npm test", {
      smartTesting: {
        enabled: true,
        mode: "related",
        baselineEnabled: true,
        failOnPreExisting: false,
        outputDir: ".quack/test-results",
      },
      force: true,
      baseBranch: "main",
    });

    expect(started.started).toBe(true);
    expect(started.taskId).toMatch(/^manual-/);
    expect(mockSpawn).toHaveBeenCalled();

    fakeChild.emit("close", 0);

    expect(mockWriteTestArtifact).toHaveBeenCalledTimes(1);
    const history = runner.getHistory();
    expect(history[history.length - 1].taskId).toMatch(/^manual-/);
    expect(events.some((event) => event.stage === "test_run_complete")).toBe(true);
    expect(outputs.join("")).toContain("smart-test");
  });

  test("skips smart run when git state is unchanged and force=false", () => {
    const runner = new TestRunner(projectRoot, () => {});
    (runner as unknown as { history: Array<Record<string, unknown>> }).history = [
      {
        name: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: 50,
        startedAt: "2026-04-25T00:00:00.000Z",
        finishedAt: "2026-04-25T00:00:00.050Z",
        gitSha: "abc123",
        taskId: "manual-previous",
      },
    ];

    const result = runner.start("test", "npm test", {
      smartTesting: {
        enabled: true,
        mode: "related",
        baselineEnabled: true,
        failOnPreExisting: false,
        outputDir: ".quack/test-results",
      },
      force: false,
      baseBranch: "main",
    });

    expect(result.started).toBe(false);
    expect(result.skipped).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
    const history = runner.getHistory();
    expect(history[history.length - 1].skippedNoChanges).toBe(true);
  });

  test("force=true bypasses no-change skip", () => {
    const fakeChild = new FakeChildProcess();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const runner = new TestRunner(projectRoot, () => {});
    (runner as unknown as { history: Array<Record<string, unknown>> }).history = [
      {
        name: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: 50,
        startedAt: "2026-04-25T00:00:00.000Z",
        finishedAt: "2026-04-25T00:00:00.050Z",
        gitSha: "abc123",
      },
    ];

    const result = runner.start("test", "npm test", {
      smartTesting: {
        enabled: true,
        mode: "related",
        baselineEnabled: true,
        failOnPreExisting: false,
        outputDir: ".quack/test-results",
      },
      force: true,
      baseBranch: "main",
    });

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
