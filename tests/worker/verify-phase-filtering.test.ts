import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { AdapterConfig } from "../../src/core/types";

// Mock child_process.exec at its callback contract. Verification owns timeout
// and process-tree cleanup now, so a promisify-only mock would never settle.
type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

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
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      void options;
      const matchedResult = findResult(command);
      queueMicrotask(() => {
        if (matchedResult?.error) {
          const err = Object.assign(new Error("Command failed"), {
            code: matchedResult.code ?? 1,
            killed: false,
            signal: null,
          });
          callback(err, matchedResult.stdout ?? "", matchedResult.stderr ?? "");
          return;
        }
        callback(null, matchedResult?.stdout ?? "OK", matchedResult?.stderr ?? "");
      });
      return { pid: undefined };
    },
  );

  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock Docker runner to avoid Docker calls
jest.mock("../../src/testing/docker-test-runner.js", () => ({
  isDockerAvailable: jest.fn(() => false),
  run: jest.fn(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runVerification } =
  require("../../src/worker/tools/verify") as typeof import("../../src/worker/tools/verify");

import type { ProjectAdapter } from "../../src/core/adapter-loader";

function makeAdapter(
  verificationCommands: AdapterConfig["verification"]["commands"],
): ProjectAdapter {
  return {
    config: {
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
      verification: {
        commands: verificationCommands,
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: ["src/", "tests/"],
        deniedPaths: [".env"],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoCreatePr: true,
        autoPush: true,
      },
      logging: {
        dir: ".quack/logs",
        level: "debug",
        retainDays: 30,
      },
    } as AdapterConfig,
    projectRoot: "/test/project",
  } as ProjectAdapter;
}

describe("verify — phase filtering", () => {
  beforeEach(() => {
    mockCommandResults = {};
  });

  describe("backward compatibility — commands without phase", () => {
    it("runs commands without phase field (defaults to all)", async () => {
      mockCommandResults["npm test"] = { stdout: "5 passed", stderr: "" };

      const adapter = makeAdapter([
        { name: "tests", command: "npm test", required: true, timeout: 60 },
      ]);

      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe("tests");
      expect(result.commands[0].passed).toBe(true);
    });
  });

  describe("default (worker) phase — no runThorough", () => {
    it("runs fast-phase commands", async () => {
      mockCommandResults["npm run type-check"] = { stdout: "OK", stderr: "" };

      const adapter = makeAdapter([
        {
          name: "typecheck",
          command: "npm run type-check",
          required: true,
          timeout: 60,
          phase: "fast",
        },
        {
          name: "docker-tests",
          command: "npm test",
          required: true,
          timeout: 300,
          phase: "thorough",
        },
      ]);

      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe("typecheck");
    });

    it("runs all-phase commands", async () => {
      mockCommandResults["npm run build"] = { stdout: "Build succeeded", stderr: "" };

      const adapter = makeAdapter([
        { name: "build", command: "npm run build", required: true, timeout: 60, phase: "all" },
        {
          name: "docker-tests",
          command: "npm test",
          required: true,
          timeout: 300,
          phase: "thorough",
        },
      ]);

      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe("build");
    });

    it("excludes thorough-phase commands", async () => {
      const adapter = makeAdapter([
        {
          name: "full-docker-tests",
          command: "npm test",
          required: true,
          timeout: 1200,
          phase: "thorough",
        },
      ]);

      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(0);
      expect(result.allPassed).toBe(true); // No failures when nothing runs
    });

    it("runs both fast and all phase commands but not thorough", async () => {
      mockCommandResults["npm run type-check"] = { stdout: "OK", stderr: "" };
      mockCommandResults["npm run build"] = { stdout: "OK", stderr: "" };

      const adapter = makeAdapter([
        {
          name: "typecheck",
          command: "npm run type-check",
          required: true,
          timeout: 60,
          phase: "fast",
        },
        { name: "build", command: "npm run build", required: true, timeout: 60, phase: "all" },
        {
          name: "docker-full",
          command: "docker compose run ...",
          required: true,
          timeout: 1200,
          phase: "thorough",
        },
      ]);

      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(2);
      expect(result.commands.map((c) => c.name)).toEqual(["typecheck", "build"]);
    });
  });

  describe("post-judge phase — runThorough: true", () => {
    it("runs all phases including thorough", async () => {
      mockCommandResults["npm run type-check"] = { stdout: "OK", stderr: "" };
      mockCommandResults["npm run build"] = { stdout: "OK", stderr: "" };
      mockCommandResults["docker compose run"] = { stdout: "All tests passed", stderr: "" };

      const adapter = makeAdapter([
        {
          name: "typecheck",
          command: "npm run type-check",
          required: true,
          timeout: 60,
          phase: "fast",
        },
        { name: "build", command: "npm run build", required: true, timeout: 60, phase: "all" },
        {
          name: "docker-full",
          command: "docker compose run ...",
          required: true,
          timeout: 1200,
          phase: "thorough",
        },
      ]);

      const result = await runVerification(adapter, "all", { runThorough: true });

      expect(result.commands).toHaveLength(3);
      expect(result.commands.map((c) => c.name)).toEqual(["typecheck", "build", "docker-full"]);
    });
  });

  describe("specific scope (by name)", () => {
    it("runs a specific command by name regardless of phase", async () => {
      mockCommandResults["docker compose run"] = { stdout: "Tests passed", stderr: "" };

      const adapter = makeAdapter([
        {
          name: "docker-full",
          command: "docker compose run test-runner",
          required: true,
          timeout: 1200,
          phase: "thorough",
        },
      ]);

      // When specifying by name, phase filtering does not apply
      const result = await runVerification(adapter, "docker-full");

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe("docker-full");
    });
  });

  describe("adapter config with mixed host + Docker commands", () => {
    it("handles a mixed adapter correctly in worker mode (default)", async () => {
      mockCommandResults["npm run build"] = { stdout: "OK", stderr: "" };
      mockCommandResults["npm test"] = { stdout: "5 passed", stderr: "" };

      const adapter = makeAdapter([
        {
          name: "build",
          command: "npm run build",
          required: true,
          timeout: 60,
          phase: "fast",
          environment: "host",
        },
        {
          name: "unit-tests",
          command: "npm test",
          required: true,
          timeout: 120,
          phase: "fast",
          environment: "host",
        },
        {
          name: "integration-tests",
          command: "npx jest --testPathPattern=integration",
          required: true,
          timeout: 1200,
          phase: "thorough",
          environment: "docker",
          docker: {
            composeFile: "docker-compose.test.yml",
            service: "test-runner",
            warmUp: true,
            dependsOn: ["postgres"],
          },
        },
      ]);

      // Worker mode: only fast commands run
      const result = await runVerification(adapter, "all");

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].name).toBe("build");
      expect(result.commands[1].name).toBe("unit-tests");
    });
  });
});
