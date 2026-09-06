import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

// Mock node:fs for structural checks
jest.mock("node:fs", () => ({
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

// Mock Agent SDK (semantic layer uses it)
jest.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: jest.fn(),
}));

// Mock Docker test runner
const mockDockerRun = jest.fn();
const mockIsDockerAvailable = jest.fn();
jest.mock("../../src/testing/docker-test-runner.js", () => ({
  isDockerAvailable: mockIsDockerAvailable,
  run: mockDockerRun,
  warmUp: jest.fn(),
  tearDown: jest.fn(),
}));

import { _setQueryFn, runPostJudgeVerification } from "../../src/dispatcher/post-judge-verifier.js";
import * as childProcess from "node:child_process";

const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;

describe("post-judge-verifier — Docker command routing", () => {
  let mockEvents: IEventWriter;
  let mockTask: ParsedTask;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock the LLM query function to return empty semantic results
    // eslint-disable-next-line require-yield
    _setQueryFn(async function* () {
      await Promise.resolve();
      yield { type: "result", subtype: "success", result: "" };
    });

    mockEvents = {
      emit: jest.fn(),
      sessionId: "test-session",
    } as unknown as IEventWriter;

    mockTask = {
      id: "TASK-077",
      successCriteria: ["Build passes", "Tests pass"],
      filesToModify: [],
    } as unknown as ParsedTask;
  });

  // ─── Docker unavailable fallback ────────────────────────────────────

  describe("Docker unavailable fallback", () => {
    it("emits warning and skips Docker command when Docker is not running", async () => {
      mockIsDockerAvailable.mockReturnValue(false);
      mockExecSync.mockReturnValue("Build succeeded"); // host commands pass

      const adapter: ProjectAdapter = {
        projectRoot: "/test/project",
        config: {
          verification: {
            commands: [
              { name: "build", command: "npm run build", required: true, timeout: 30000 },
              {
                name: "docker-tests",
                command: "npx jest",
                required: true,
                timeout: 120000,
                environment: "docker",
                docker: {
                  composeFile: "docker-compose.test.yml",
                  service: "test-runner",
                  warmUp: false,
                  dependsOn: [],
                },
              },
            ],
            conventionChecks: [],
            postJudge: {
              enabled: true,
              layers: ["deterministic"],
              model: "claude-haiku-4-5-20251001",
              failOnBuildError: true,
              failOnTestError: true,
              failOnLintError: false,
              maxSemanticTokens: 8000,
            },
          },
          git: { baseBranch: "main" },
        },
      } as unknown as ProjectAdapter;

      await runPostJudgeVerification("TASK-077", mockTask, adapter, "/test/project", mockEvents);

      // Docker run should NOT have been called
      expect(mockDockerRun).not.toHaveBeenCalled();

      // Should emit a warning finding for the Docker command
      const emitCalls = (mockEvents.emit as ReturnType<typeof jest.fn>).mock.calls;
      const findingCalls = emitCalls.filter((c) => c[0] === "post_judge_verify_finding");
      const dockerFinding = findingCalls.find(
        (c) => (c[1] as Record<string, unknown>).criterion === "docker-tests",
      );
      expect(dockerFinding).toBeDefined();
      expect((dockerFinding![1] as Record<string, unknown>).status).toBe("warn");
    });
  });

  // ─── Docker command routing ─────────────────────────────────────────

  describe("Docker command routing", () => {
    it("routes docker-environment commands to DockerTestRunner.run()", async () => {
      mockIsDockerAvailable.mockReturnValue(true);
      mockDockerRun.mockReturnValue({
        exitCode: 0,
        stdout: "10 passed",
        stderr: "",
        timedOut: false,
      });
      mockExecSync.mockReturnValue("Build succeeded"); // host build passes

      const adapter: ProjectAdapter = {
        projectRoot: "/test/project",
        config: {
          verification: {
            commands: [
              { name: "build", command: "npm run build", required: true, timeout: 30000 },
              {
                name: "docker-tests",
                command: "npx jest",
                required: true,
                timeout: 120000,
                environment: "docker",
                docker: {
                  composeFile: "docker-compose.test.yml",
                  service: "test-runner",
                  warmUp: false,
                  dependsOn: ["postgres"],
                },
              },
            ],
            conventionChecks: [],
            postJudge: {
              enabled: true,
              layers: ["deterministic"],
              model: "claude-haiku-4-5-20251001",
              failOnBuildError: true,
              failOnTestError: true,
              failOnLintError: false,
              maxSemanticTokens: 8000,
            },
          },
          git: { baseBranch: "main" },
        },
      } as unknown as ProjectAdapter;

      const result = await runPostJudgeVerification(
        "TASK-077",
        mockTask,
        adapter,
        "/test/project",
        mockEvents,
      );

      // Docker runner should have been called
      expect(mockDockerRun).toHaveBeenCalledTimes(1);
      expect(mockDockerRun).toHaveBeenCalledWith(
        expect.objectContaining({
          composeFile: "docker-compose.test.yml",
          service: "test-runner",
          command: "npx jest",
          workDir: "/test/project",
        }),
      );

      // Result should show test passing
      expect(result.testsPassed).toBe(true);
    });

    it("marks test as failed when Docker command returns non-zero exit", async () => {
      mockIsDockerAvailable.mockReturnValue(true);
      mockDockerRun.mockReturnValue({
        exitCode: 1,
        stdout: "",
        stderr: "FAIL tests/foo.test.ts: assertion error",
        timedOut: false,
      });
      mockExecSync.mockReturnValue("Build succeeded");

      const adapter: ProjectAdapter = {
        projectRoot: "/test/project",
        config: {
          verification: {
            commands: [
              { name: "build", command: "npm run build", required: true, timeout: 30000 },
              {
                name: "docker-tests",
                command: "npx jest",
                required: true,
                timeout: 120000,
                environment: "docker",
                docker: {
                  composeFile: "docker-compose.test.yml",
                  service: "test-runner",
                  warmUp: false,
                  dependsOn: [],
                },
              },
            ],
            conventionChecks: [],
            postJudge: {
              enabled: true,
              layers: ["deterministic"],
              model: "claude-haiku-4-5-20251001",
              failOnBuildError: true,
              failOnTestError: true,
              failOnLintError: false,
              maxSemanticTokens: 8000,
            },
          },
          git: { baseBranch: "main" },
        },
      } as unknown as ProjectAdapter;

      const result = await runPostJudgeVerification(
        "TASK-077",
        mockTask,
        adapter,
        "/test/project",
        mockEvents,
      );

      expect(result.testsPassed).toBe(false);
      expect(result.verified).toBe(false);

      // Finding should show fail
      const dockerFinding = result.findings.find((f) => f.criterion === "docker-tests");
      expect(dockerFinding?.status).toBe("fail");
    });

    it("host commands still run via execSync even when Docker commands are present", async () => {
      mockIsDockerAvailable.mockReturnValue(true);
      mockDockerRun.mockReturnValue({
        exitCode: 0,
        stdout: "Tests passed",
        stderr: "",
        timedOut: false,
      });
      mockExecSync.mockReturnValue("Build OK");

      const adapter: ProjectAdapter = {
        projectRoot: "/test/project",
        config: {
          verification: {
            commands: [
              {
                name: "build",
                command: "npm run build",
                required: true,
                timeout: 30000,
                environment: "host",
              },
              {
                name: "docker-tests",
                command: "npx jest",
                required: true,
                timeout: 120000,
                environment: "docker",
                docker: {
                  composeFile: "docker-compose.test.yml",
                  service: "test-runner",
                  warmUp: false,
                  dependsOn: [],
                },
              },
            ],
            conventionChecks: [],
            postJudge: {
              enabled: true,
              layers: ["deterministic"],
              model: "claude-haiku-4-5-20251001",
              failOnBuildError: true,
              failOnTestError: true,
              failOnLintError: false,
              maxSemanticTokens: 8000,
            },
          },
          git: { baseBranch: "main" },
        },
      } as unknown as ProjectAdapter;

      await runPostJudgeVerification("TASK-077", mockTask, adapter, "/test/project", mockEvents);

      // execSync should have been called for the host build command
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("npm run build"),
        expect.anything(),
      );

      // Docker runner for the Docker test command
      expect(mockDockerRun).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Backward compatibility ─────────────────────────────────────────

  describe("backward compatibility", () => {
    it("runs commands without environment field via execSync (host)", async () => {
      mockExecSync.mockReturnValue("Tests passed: 5");

      const adapter: ProjectAdapter = {
        projectRoot: "/test/project",
        config: {
          verification: {
            commands: [
              // Old-style: no phase or environment field
              { name: "test", command: "npm test", required: true, timeout: 60000 },
            ],
            conventionChecks: [],
            postJudge: {
              enabled: true,
              layers: ["deterministic"],
              model: "claude-haiku-4-5-20251001",
              failOnBuildError: true,
              failOnTestError: true,
              failOnLintError: false,
              maxSemanticTokens: 8000,
            },
          },
          git: { baseBranch: "main" },
        },
      } as unknown as ProjectAdapter;

      const result = await runPostJudgeVerification(
        "TASK-077",
        mockTask,
        adapter,
        "/test/project",
        mockEvents,
      );

      // Docker runner should NOT have been called
      expect(mockDockerRun).not.toHaveBeenCalled();

      // execSync should have been called
      expect(mockExecSync).toHaveBeenCalled();

      // Should pass
      expect(result.testsPassed).toBe(true);
    });
  });
});
