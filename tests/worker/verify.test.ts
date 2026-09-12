import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { computeAdapterBundleMetadata } from "../../src/core/adapter-loader";
import type { AdapterConfig, ParsedTask } from "../../src/core/types";
import { summarizeOutput } from "../../src/worker/tools/output-summarizer";

// ─── Mock child_process.exec at the module level ─────────────────────
// The source code does: import { exec } from "node:child_process"
// then wraps exec with timeout/process-tree handling.

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  killed?: boolean;
  code?: number;
  signal?: string;
};

// Store mock behavior for different command patterns
let mockCommandResults: Record<string, MockExecResult> = {};

function findResult(command: string): MockExecResult | undefined {
  for (const [pattern, result] of Object.entries(mockCommandResults)) {
    if (command.includes(pattern)) {
      return result;
    }
  }
  return undefined;
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const mockExec = jest.fn(
    (
      command: string,
      options:
        | Record<string, unknown>
        | ((err: Error | null, stdout: string, stderr: string) => void),
      callback?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      void options; // unused in mock
      const cb = typeof options === "function" ? options : callback;
      const matchedResult = findResult(command);
      const child = { pid: 12345, kill: jest.fn(), on: jest.fn() };

      setImmediate(() => {
        if (!cb) return;
        if (!matchedResult) {
          cb(null, "", "");
          return;
        }

        if (matchedResult.error || matchedResult.killed) {
          const err = Object.assign(new Error("Command failed"), {
            code: matchedResult.code ?? 1,
            killed: matchedResult.killed ?? false,
            signal: matchedResult.signal ?? null,
            stdout: matchedResult.stdout ?? "",
            stderr: matchedResult.stderr ?? "",
          });
          cb(err, matchedResult.stdout ?? "", matchedResult.stderr ?? "");
          return;
        }

        cb(null, matchedResult.stdout ?? "", matchedResult.stderr ?? "");
      });

      return child;
    },
  );

  return {
    ...actual,
    exec: mockExec,
  };
});

jest.mock("../../src/testing/docker-test-runner.js", () => ({
  isDockerAvailable: jest.fn(() => false),
  run: jest.fn(),
}));

// ─── Import AFTER mocking ────────────────────────────────────────────

// Must import after jest.mock so the mock is in place when the module loads
const {
  runVerification,
  formatVerificationResult,
  prepareVerificationCommandRuntime,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("../../src/worker/tools/verify") as typeof import("../../src/worker/tools/verify");

// ─── Test helpers ────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<AdapterConfig> = {}): ProjectAdapter {
  const defaultVerification = {
    commands: [
      {
        name: "tests",
        command: "npm test",
        required: true,
        timeout: 300,
      },
      {
        name: "typecheck",
        command: "npm run type-check",
        required: false,
        timeout: 60,
      },
      {
        name: "lint",
        command: "npm run lint",
        required: false,
        timeout: 60,
      },
    ],
    conventionChecks: [
      {
        name: "layer-violations",
        description: "No req/res objects in service or repository files",
        command: "node .quack/convention-checks/layer-violations.js",
        conventionRef: "ADR-012",
      },
    ],
  };

  const defaultConfig: AdapterConfig = {
    version: "1.0",
    project: {
      name: "test-project",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: overrides.verification ?? defaultVerification,
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env", ".env.*"],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 30,
    },
  };

  return {
    config: defaultConfig,
    projectRoot: "/test/project",
    conventionsDoc: "# Test Conventions",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: computeAdapterBundleMetadata(defaultConfig),
  };
}

function setupMockCommands(results: Record<string, MockExecResult>) {
  mockCommandResults = results;
}

// ─── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockCommandResults = {};
});

describe("runVerification", () => {
  describe("adapter freshness", () => {
    test("blocks verification before commands run when the adapter bundle is stale", async () => {
      const adapter = makeAdapter();
      const authoritativeBundle = {
        ...adapter.adapterBundle,
        sharedHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      };

      const result = await runVerification(adapter, "all", {
        authoritativeAdapterBundle: authoritativeBundle,
      });

      expect(result.allPassed).toBe(false);
      expect(result.adapterFreshness).toMatchObject({
        status: "stale",
        localHash: adapter.adapterBundle.sharedHash,
        authoritativeHash: authoritativeBundle.sharedHash,
      });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        name: "adapter-freshness",
        passed: false,
      });
      expect(result.commands[0]?.output).toContain("stale adapter bundle");
    });

    test("runs verification and reports fresh metadata when bundle hashes match", async () => {
      const adapter = makeAdapter();
      setupMockCommands({
        "npm test": { stdout: "tests passed" },
      });

      const result = await runVerification(adapter, "tests", {
        authoritativeAdapterBundle: adapter.adapterBundle,
      });

      expect(result.allPassed).toBe(true);
      expect(result.adapterFreshness).toMatchObject({
        status: "fresh",
        localHash: adapter.adapterBundle.sharedHash,
        authoritativeHash: adapter.adapterBundle.sharedHash,
      });
      expect(result.commands[0]).toMatchObject({
        name: "tests",
        passed: true,
      });
    });
  });

  describe("all commands pass", () => {
    test("should return allPassed=true when all commands and convention checks pass", async () => {
      setupMockCommands({
        "npm test": {
          stdout: "Tests:  42 passed, 42 total\nTest Suites:  5 passed, 5 total",
        },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(true);
      expect(result.commands).toHaveLength(3);
      expect(result.conventionChecks).toHaveLength(1);

      // All commands passed
      for (const cmd of result.commands) {
        expect(cmd.passed).toBe(true);
      }
      for (const check of result.conventionChecks) {
        expect(check.passed).toBe(true);
      }
    });

    test("should include summarized success messages", async () => {
      setupMockCommands({
        "npm test": {
          stdout: "Tests:  42 passed, 42 total",
        },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.commands[0].output).toContain("42");
      expect(result.commands[0].output).toContain("passed");
    });
  });

  describe("one command fails", () => {
    test("should return allPassed=false when one command fails", async () => {
      setupMockCommands({
        "npm test": {
          stdout: "FAIL src/test.ts\n  x should work\nTests:  1 failed, 41 passed, 42 total",
          error: true,
          code: 1,
        },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.commands[0].passed).toBe(false);
      expect(result.commands[0]).toMatchObject({
        required: true,
        status: "failed",
      });
      expect(result.commands[0].output).toContain("failed");
      expect(result.commands[1].passed).toBe(true);
      expect(result.commands[2].passed).toBe(true);
    });

    test("should not fail allPassed when an optional command fails", async () => {
      setupMockCommands({
        "npm test": { stdout: "Tests:  42 passed, 42 total" },
        "npm run type-check": {
          stdout: "optional typecheck failed",
          error: true,
          code: 1,
        },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(true);
      expect(result.commands[1]).toMatchObject({
        name: "typecheck",
        passed: false,
        required: false,
        status: "optional-unavailable",
      });
    });

    test("blocks an unavailable required Docker check but not an optional one", async () => {
      const docker = {
        composeFile: "docker-compose.test.yml",
        service: "test-runner",
        warmUp: false,
        dependsOn: [],
      };
      const adapter = makeAdapter({
        verification: {
          commands: [
            {
              name: "required-browser-smoke",
              command: "npm run test:browser",
              required: true,
              timeout: 300,
              environment: "docker",
              docker,
            },
            {
              name: "optional-browser-smoke",
              command: "npm run test:browser",
              required: false,
              timeout: 300,
              environment: "docker",
              docker,
            },
          ],
          conventionChecks: [],
        },
      });

      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.commands).toEqual([
        expect.objectContaining({
          name: "required-browser-smoke",
          passed: false,
          required: true,
          status: "failed",
        }),
        expect.objectContaining({
          name: "optional-browser-smoke",
          passed: false,
          required: false,
          status: "optional-unavailable",
        }),
      ]);
    });

    test("reports optional commands as explicitly skipped when their execution is disabled", async () => {
      setupMockCommands({
        "npm test": { stdout: "Tests:  42 passed, 42 total" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all", { includeOptional: false });

      expect(result.allPassed).toBe(true);
      expect(result.commands.map((command) => command.name)).toEqual([
        "tests",
        "typecheck",
        "lint",
      ]);
      expect(result.commands.slice(1)).toEqual([
        expect.objectContaining({
          name: "typecheck",
          passed: false,
          required: false,
          status: "skipped",
        }),
        expect.objectContaining({
          name: "lint",
          passed: false,
          required: false,
          status: "skipped",
        }),
      ]);
      expect(result.conventionChecks).toHaveLength(1);
    });
  });

  describe("zero-test output", () => {
    test("fails required test commands that report zero tests despite exit 0", async () => {
      setupMockCommands({
        "npm test": {
          stdout: "No tests found, exiting with code 0\n--passWithNoTests",
        },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.commands[0].passed).toBe(false);
      expect(result.commands[0].output).toContain("zero tests");
    });
  });

  describe("scoped task test fallback", () => {
    test("passes required adapter test command when mapped frontend scoped tests pass", async () => {
      setupMockCommands({
        "bash .quack/verify-web-dashboard.sh test": {
          stderr: "ManagerBrief unrelated failure",
          error: true,
          code: 1,
        },
        "npm --prefix frontends/web-dashboard test": {
          stdout: "Tests:  20 passed, 20 total",
        },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter({
        verification: {
          commands: [
            {
              name: "web-dashboard-test",
              command: "bash .quack/verify-web-dashboard.sh test",
              required: true,
              timeout: 60000,
            },
          ],
          conventionChecks: [],
        },
      });
      const task = {
        id: "TASK-893",
        filesToModify: [
          {
            path: "frontends/web-dashboard/src/components/inventory/ProductCard.test.jsx",
            action: "Modify",
            notes: "",
          },
        ],
      } as ParsedTask;

      const result = await runVerification(adapter, "all", { task });

      expect(result.allPassed).toBe(true);
      expect(result.commands[0]).toMatchObject({
        name: "web-dashboard-test",
        passed: true,
      });
      expect(result.commands[0].output).toContain("scoped task tests passed");
      expect(result.commands[0].output).toContain("npm --prefix frontends/web-dashboard test");
    });
  });

  describe("command times out", () => {
    test("should return timeout error message", async () => {
      setupMockCommands({
        "npm test": {
          killed: true,
          signal: "SIGTERM",
          stdout: "partial output...",
          stderr: "",
        },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.commands[0].passed).toBe(false);
      expect(result.commands[0].output).toContain("timed out");
    });
  });

  describe("convention check fails", () => {
    test("should include violation details in output", async () => {
      setupMockCommands({
        "npm test": { stdout: "Tests:  42 passed, 42 total" },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": {
          stderr: "VIOLATION: src/services/foo.service.js uses req.body on line 23",
          error: true,
          code: 1,
        },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.conventionChecks[0].passed).toBe(false);
      expect(result.conventionChecks[0].output).toContain("VIOLATION");
      expect(result.conventionChecks[0].output).toContain("ADR-012");
    });
  });

  describe("missing/invalid command", () => {
    test("should handle gracefully when command is not found", async () => {
      setupMockCommands({
        "nonexistent-cmd": {
          error: true,
          code: 127,
          stderr: "bash: nonexistent-cmd: command not found",
        },
      });

      const adapter = makeAdapter({
        verification: {
          commands: [
            {
              name: "missing",
              command: "nonexistent-cmd",
              required: true,
              timeout: 30,
            },
          ],
          conventionChecks: [],
        },
      });

      const result = await runVerification(adapter, "all");

      expect(result.allPassed).toBe(false);
      expect(result.commands[0].passed).toBe(false);
      expect(result.commands[0].output).toBeTruthy();
      // Should not throw
    });
  });

  describe("scope parameter", () => {
    test("scope='all' runs all commands and convention checks", async () => {
      setupMockCommands({
        "npm test": { stdout: "Tests:  10 passed, 10 total" },
        "npm run type-check": { stdout: "" },
        "npm run lint": { stdout: "" },
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(3);
      expect(result.conventionChecks).toHaveLength(1);
    });

    test("scope=specific command name runs only that command", async () => {
      setupMockCommands({
        "npm run lint": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "lint");

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe("lint");
      expect(result.conventionChecks).toHaveLength(0);
    });

    test("scope=convention check name runs only that check", async () => {
      setupMockCommands({
        "layer-violations": { stdout: "" },
      });

      const adapter = makeAdapter();
      const result = await runVerification(adapter, "layer-violations");

      expect(result.commands).toHaveLength(0);
      expect(result.conventionChecks).toHaveLength(1);
      expect(result.conventionChecks[0].name).toBe("layer-violations");
    });

    test("scope=unknown name returns error result", async () => {
      const adapter = makeAdapter();
      const result = await runVerification(adapter, "nonexistent");

      expect(result.allPassed).toBe(false);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].passed).toBe(false);
      expect(result.commands[0].output).toContain("Unknown verification command");
      expect(result.commands[0].output).toContain("nonexistent");
    });
  });
});

describe("prepareVerificationCommandRuntime", () => {
  test("prepends Git POSIX tools for Windows bash and grep commands", () => {
    const result = prepareVerificationCommandRuntime(
      "bash .quack/verify.sh build && grep -R foo src",
      {
        platform: "win32",
        env: {
          Path: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
        existsSync: (filePath) =>
          filePath === "C:\\Program Files\\Git\\usr\\bin\\bash.exe" ||
          filePath === "C:\\Program Files\\Git\\usr\\bin\\grep.exe",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.env.Path).toBe("C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32");
    expect(result.shell).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  });

  test("uses configured bash path for Unix-style quoted Windows pipelines", () => {
    const result = prepareVerificationCommandRuntime(
      "grep -rn 'DemoContext\\|from.*reference.*Data' src/ | head -10",
      {
        platform: "win32",
        env: {
          Path: "C:\\Windows\\System32",
          QUACK_BASH_PATH: "D:\\Git\\bin\\bash.exe",
        },
        existsSync: (filePath) => filePath === "D:\\Git\\bin\\bash.exe",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.command).toContain("grep -rn");
    expect(result.shell).toBe("D:\\Git\\bin\\bash.exe");
  });

  test("returns clear Windows toolchain error before falling through to WSL bash", () => {
    const result = prepareVerificationCommandRuntime("bash .quack/verify.sh test", {
      platform: "win32",
      env: { Path: "C:\\Windows\\System32" },
      existsSync: () => false,
    });

    expect(result.error).toContain("POSIX verification tooling unavailable on Windows");
    expect(result.error).toContain("QUACK_POSIX_BIN_DIR");
  });

  test("leaves non-POSIX Windows commands unchanged", () => {
    const result = prepareVerificationCommandRuntime("npm test", {
      platform: "win32",
      env: { Path: "C:\\Windows\\System32" },
      existsSync: () => {
        throw new Error("should not probe paths");
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.env.Path).toBe("C:\\Windows\\System32");
  });
});

describe("formatVerificationResult", () => {
  test("formats passing result", () => {
    const formatted = formatVerificationResult({
      allPassed: true,
      commands: [
        { name: "tests", passed: true, output: "All 42 tests passed" },
        { name: "lint", passed: true, output: "Lint clean" },
      ],
      conventionChecks: [
        { name: "layer-check", passed: true, output: "Convention check passed (ADR-012)" },
      ],
    });

    expect(formatted).toContain("VERIFICATION PASSED");
    expect(formatted).toContain("[PASS] tests");
    expect(formatted).toContain("[PASS] lint");
    expect(formatted).toContain("[PASS] layer-check");
  });

  test("formats failing result", () => {
    const formatted = formatVerificationResult({
      allPassed: false,
      commands: [
        { name: "tests", passed: false, output: "3 tests failed" },
        { name: "lint", passed: true, output: "Lint clean" },
      ],
      conventionChecks: [],
    });

    expect(formatted).toContain("VERIFICATION FAILED");
    expect(formatted).toContain("[FAIL] tests");
    expect(formatted).toContain("[PASS] lint");
  });

  test("distinguishes non-blocking optional results from required failures", () => {
    const formatted = formatVerificationResult({
      allPassed: false,
      commands: [
        {
          name: "browser-smoke",
          passed: false,
          required: false,
          status: "optional-unavailable",
          output: "Browser dependency is not integrated",
        },
        {
          name: "optional-sweep",
          passed: false,
          required: false,
          status: "skipped",
          output: "Optional verifier execution was disabled",
        },
        {
          name: "tests",
          passed: false,
          required: true,
          status: "failed",
          output: "3 tests failed",
        },
      ],
      conventionChecks: [],
    });

    expect(formatted).toContain("[OPTIONAL UNAVAILABLE] browser-smoke");
    expect(formatted).toContain("[SKIPPED] optional-sweep");
    expect(formatted).toContain("[FAIL] tests");
  });
});

describe("summarizeOutput", () => {
  describe("success cases", () => {
    test("should extract Jest test count from summary line", () => {
      const output = "Test Suites:  5 passed, 5 total\nTests:  42 passed, 42 total\nTime: 3.2s";
      const result = summarizeOutput(output, true);
      expect(result).toContain("42");
      expect(result).toContain("passed");
    });

    test("should return brief message for tsc clean output", () => {
      const output = "src/index.ts\n";
      const result = summarizeOutput(output, true);
      expect(result).toBeTruthy();
    });

    test("should handle empty output on success", () => {
      const result = summarizeOutput("", true);
      expect(result).toContain("Passed");
    });
  });

  describe("failure cases", () => {
    test("should extract failing test names from Jest output", () => {
      const output = [
        "FAIL src/core/types.test.ts",
        "  x should validate input correctly",
        "  x should handle edge cases",
        "",
        "Tests:  2 failed, 40 passed, 42 total",
      ].join("\n");

      const result = summarizeOutput(output, false);
      expect(result).toContain("failed");
    });

    test("should extract TypeScript errors", () => {
      const output = [
        "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/bar.ts(20,3): error TS2339: Property 'baz' does not exist on type 'Foo'.",
        "",
        "Found 2 errors.",
      ].join("\n");

      const result = summarizeOutput(output, false);
      expect(result).toContain("TypeScript error");
      expect(result).toContain("TS2322");
    });

    test("should extract ESLint violations", () => {
      const output = [
        "/src/foo.ts",
        "  10:5  error  Unexpected any  @typescript-eslint/no-explicit-any",
        "  20:3  warning  Missing return type  @typescript-eslint/explicit-function-return-type",
        "",
        "2 problems (1 error, 1 warning)",
      ].join("\n");

      const result = summarizeOutput(output, false);
      expect(result).toContain("ESLint");
      expect(result).toContain("problem");
    });

    test("should handle empty output on failure", () => {
      const result = summarizeOutput("", false);
      expect(result).toContain("Failed");
    });
  });

  describe("truncation", () => {
    test("should truncate long output to ~2000 chars", () => {
      // Generate output much longer than 2000 chars
      const longOutput = "x".repeat(5000);
      const result = summarizeOutput(longOutput, false);
      expect(result.length).toBeLessThanOrEqual(2100); // Some tolerance for truncation marker
      expect(result).toContain("truncated");
    });

    test("should not truncate short output", () => {
      const shortOutput = "All tests passed";
      const result = summarizeOutput(shortOutput, true);
      expect(result).not.toContain("truncated");
    });
  });
});
