import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { runPostJudgeVerification } from "../../src/dispatcher/post-judge-verifier.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

// Mock fs
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

// Mock Agent SDK
jest.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: jest.fn(),
}));

describe("post-judge-verifier", () => {
  let mockAdapter: ProjectAdapter;
  let mockTask: ParsedTask;
  let mockEvents: IEventWriter;
  const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;
  const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);

    mockAdapter = {
      projectRoot: "/test/project",
      config: {
        verification: {
          commands: [
            { name: "build", command: "npm run build", required: true, timeout: 30000 },
            { name: "test", command: "npm test", required: true, timeout: 60000 },
            { name: "lint", command: "npm run lint", required: false, timeout: 30000 },
          ],
          conventionChecks: [],
          postJudge: {
            enabled: true,
            layers: ["deterministic", "structural", "semantic"],
            model: "claude-haiku-4-5-20251001",
            failOnBuildError: true,
            failOnTestError: true,
            failOnLintError: false,
            maxSemanticTokens: 8000,
          },
        },
      },
    } as unknown as ProjectAdapter;

    mockTask = {
      id: "TASK-065",
      successCriteria: ["Build succeeds", "Tests pass"],
      testingRequirements: ["Test Layer 1", "Test Layer 2"],
      filesToModify: [{ path: "src/test.ts", action: "Modify", notes: "" }],
    } as unknown as ParsedTask;

    mockEvents = {
      emit: jest.fn(),
    } as unknown as IEventWriter;
  });

  describe("Layer 1: Deterministic checks", () => {
    it("reports pass when build command succeeds", async () => {
      mockExecSync.mockReturnValue("Build successful");
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.buildPassed).toBe(true);
      expect(result.findings.some((f) => f.criterion === "build" && f.status === "pass")).toBe(
        true,
      );
    });

    it("runs POSIX adapter commands through Git Bash on Windows", async () => {
      mockAdapter.config.verification.commands = [
        { name: "build", command: "bash .quack/verify.sh build", required: true, timeout: 30000 },
      ];
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];
      mockExistsSync.mockImplementation(
        (filePath: string) => filePath === "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      );
      mockExecSync.mockReturnValue("Build successful");

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      if (process.platform === "win32") {
        expect(mockExecSync).toHaveBeenCalledWith(
          "bash .quack/verify.sh build",
          expect.objectContaining({
            shell: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
          }),
        );
        const execOptions = mockExecSync.mock.calls[0][1] as { env?: NodeJS.ProcessEnv };
        const pathValue = execOptions.env?.PATH ?? execOptions.env?.Path;
        expect(pathValue).toContain("C:\\Program Files\\Git\\usr\\bin");
      }
    });

    it("reports fail when test command fails", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("test")) {
          const error = new Error("Tests failed") as Error & { status: number; stderr: string };
          error.status = 1;
          error.stderr = "5 tests failed";
          throw error;
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(false);
      expect(result.testsPassed).toBe(false);
      expect(result.findings.some((f) => f.criterion === "test" && f.status === "fail")).toBe(true);
    });

    it("warns but passes when lint fails with failOnLintError=false", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("lint")) {
          const error = new Error("Lint errors") as Error & { status: number };
          error.status = 1;
          throw error;
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];
      mockAdapter.config.verification.postJudge!.failOnLintError = false;

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.lintPassed).toBe(false);
      expect(result.findings.some((f) => f.criterion === "lint" && f.status === "warn")).toBe(true);
      // Should still verify if failOnLintError is false
      expect(result.verified).toBe(true);
    });

    it("always fails on build error regardless of config", async () => {
      // Build/test failures always trigger REVISE — not configurable
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("build")) {
          throw new Error("Build failed");
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(false);
      expect(result.buildPassed).toBe(false);
    });

    it("always fails on test error regardless of config", async () => {
      // Test failures always trigger REVISE — not configurable
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("test")) {
          const error = new Error("Tests failed") as Error & { status: number; stderr: string };
          error.status = 1;
          error.stderr = "3 tests failed";
          throw error;
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(false);
      expect(result.testsPassed).toBe(false);
      expect(result.findings.some((f) => f.criterion === "test" && f.status === "fail")).toBe(true);
    });

    it("passes when full suite fails but scoped tests pass (pre-existing failures)", async () => {
      // Task has test files in filesToModify
      const taskWithTests = {
        ...mockTask,
        filesToModify: [
          { path: "src/routes/auth.ts", action: "Modify", notes: "" },
          { path: "tests/unit/routes/auth.routes.test.js", action: "Modify", notes: "" },
        ],
      } as unknown as ParsedTask;

      mockExecSync.mockImplementation((cmd: string) => {
        // Full "npm test" fails (pre-existing failures elsewhere)
        if (cmd === "npm test") {
          const error = new Error("Tests failed") as Error & {
            status: number;
            stderr: string;
          };
          error.status = 1;
          error.stderr = "12 tests failed";
          throw error;
        }
        // Scoped test command passes (task-related tests are fine)
        if (cmd.includes("tests/unit/routes/auth.routes.test.js")) {
          return "Tests: 8 passed, 8 total";
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        taskWithTests,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(
        result.findings.some(
          (f) =>
            f.criterion === "test" && f.status === "pass" && f.evidence.includes("pre-existing"),
        ),
      ).toBe(true);
    });

    it("fails when both full suite and scoped tests fail", async () => {
      const taskWithTests = {
        ...mockTask,
        filesToModify: [
          { path: "src/routes/auth.ts", action: "Modify", notes: "" },
          { path: "tests/unit/routes/auth.routes.test.js", action: "Modify", notes: "" },
        ],
      } as unknown as ParsedTask;

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("test")) {
          const error = new Error("Tests failed") as Error & {
            status: number;
            stderr: string;
          };
          error.status = 1;
          error.stderr = "3 tests failed";
          throw error;
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        taskWithTests,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(false);
      expect(result.testsPassed).toBe(false);
      expect(result.findings.some((f) => f.criterion === "test" && f.status === "fail")).toBe(true);
    });

    it("discovers test files from git diff when not in filesToModify", async () => {
      // Task spec has NO test files — but agent created one (visible in git diff)
      const taskNoTests = {
        ...mockTask,
        filesToModify: [
          { path: "src/middleware/enforce-view-as.js", action: "Create", notes: "" },
          { path: "src/routes/index.js", action: "Modify", notes: "" },
        ],
      } as unknown as ParsedTask;

      mockExecSync.mockImplementation((cmd: string) => {
        // Full "npm test" fails (pre-existing failures)
        if (cmd === "npm test") {
          const error = new Error("Tests failed") as Error & {
            status: number;
            stderr: string;
          };
          error.status = 1;
          error.stderr = "12 tests failed";
          throw error;
        }
        // Git diff returns test file the agent created
        if (cmd.includes("git diff --name-only")) {
          return "src/middleware/enforce-view-as.js\nsrc/routes/index.js\ntests/unit/middleware/enforce-view-as.test.js\n";
        }
        // Scoped test command passes
        if (cmd.includes("tests/unit/middleware/enforce-view-as.test.js")) {
          return "Tests: 17 passed, 17 total";
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        taskNoTests,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(
        result.findings.some(
          (f) =>
            f.criterion === "test" && f.status === "pass" && f.evidence.includes("pre-existing"),
        ),
      ).toBe(true);
    });

    it("maps frontend task tests to the package test runner when adapter scripts ignore scoped args", async () => {
      mockAdapter.config.verification.commands = [
        {
          name: "web-dashboard-test",
          command: "bash .quack/verify-web-dashboard.sh test",
          required: true,
          timeout: 60000,
        },
      ];
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const taskWithFrontendTest = {
        ...mockTask,
        filesToModify: [
          {
            path: "frontends/web-dashboard/src/components/inventory/ProductCard.test.jsx",
            action: "Modify",
            notes: "",
          },
        ],
      } as unknown as ParsedTask;

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "bash .quack/verify-web-dashboard.sh test") {
          const error = new Error("Full suite failed") as Error & {
            status: number;
            stderr: string;
          };
          error.status = 1;
          error.stderr = "ManagerBrief unrelated failure";
          throw error;
        }
        if (
          cmd ===
          'npm --prefix frontends/web-dashboard test -- "src/components/inventory/ProductCard.test.jsx"'
        ) {
          return "Tests: 20 passed, 20 total";
        }
        return "Success";
      });

      const result = await runPostJudgeVerification(
        "TASK-893",
        taskWithFrontendTest,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'npm --prefix frontends/web-dashboard test -- "src/components/inventory/ProductCard.test.jsx"',
        expect.any(Object),
      );
    });
  });

  describe("Layer 2: Structural checks", () => {
    it("detects missing files from spec", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      const fs = await import("node:fs");
      (fs.promises.access as ReturnType<typeof jest.fn>).mockRejectedValue(
        new Error("File not found"),
      );
      mockExecSync.mockReturnValue(""); // git diff empty

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      // Missing files are warnings (not failures) — the LLM judge evaluates
      // completeness; structural checks are advisory since spec filesToModify
      // can contradict success criteria.
      expect(
        result.findings.some((f) => f.criterion.includes("src/test.ts") && f.status === "warn"),
      ).toBe(true);
    });

    it("detects stub functions in new code", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("git diff")) {
          return `+function foo() {
+  // TODO: implement this
+  throw new Error("not implemented");
+}`;
        }
        return "";
      });

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(
        result.findings.some(
          (f) => f.criterion === "No stub implementations" && f.status === "warn",
        ),
      ).toBe(true);
    });

    it("detects any type usage in new TypeScript", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("git diff")) {
          return "+function foo(x: any) { return x; }";
        }
        return "";
      });

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(
        result.findings.some((f) => f.criterion === "No any type usage" && f.status === "warn"),
      ).toBe(true);
    });

    it("flags when no test files exist but testing requirements are specified", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--name-only")) {
          return "src/feature.ts"; // No test files at all
        }
        if (cmd.includes("git diff")) {
          return "+new code";
        }
        return "";
      });

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(
        result.findings.some((f) => f.criterion === "Test coverage" && f.status === "fail"),
      ).toBe(true);
    });

    it("warns when fewer test files than testing requirements", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      // 2 testing requirements but only 1 test file — should warn about shortfall
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--name-only")) {
          return "src/feature.ts\ntests/feature.test.ts"; // 1 test file
        }
        if (cmd.includes("git diff")) {
          return "+new code";
        }
        return "";
      });

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      // Should warn about count shortfall, not pass
      expect(
        result.findings.some((f) => f.criterion === "Test coverage" && f.status === "warn"),
      ).toBe(true);
      expect(
        result.findings.some((f) => f.criterion === "Test coverage" && f.evidence.includes("gaps")),
      ).toBe(true);
    });

    it("passes when test file count meets or exceeds requirements", async () => {
      mockAdapter.config.verification.postJudge!.layers = ["structural"];
      // 2 testing requirements and 2 test files
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--name-only")) {
          return "src/feature.ts\ntests/feature.test.ts\ntests/feature2.test.ts";
        }
        if (cmd.includes("git diff")) {
          return "+new code";
        }
        return "";
      });

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(
        result.findings.some((f) => f.criterion === "Test coverage" && f.status === "pass"),
      ).toBe(true);
    });
  });

  describe("Layer 3: Semantic verification", () => {
    it("calls LLM with proper prompt and parses response", async () => {
      const { _setQueryFn } = await import("../../src/dispatcher/post-judge-verifier.js");
      const fs = await import("node:fs");
      (fs.promises.readFile as ReturnType<typeof jest.fn>).mockResolvedValue("file content");
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQuery = jest.fn().mockImplementation(async function* () {
        yield {
          type: "result",
          subtype: "success",
          content: `CRITERION: Build succeeds
STATUS: pass
EVIDENCE: Build command ran successfully

CRITERION: Tests pass
STATUS: pass
EVIDENCE: All tests passed`,
        };
      });
      _setQueryFn(mockQuery as unknown as ReturnType<typeof jest.fn>);

      mockAdapter.config.verification.postJudge!.layers = ["semantic"];
      mockExecSync.mockReturnValue("+ some code changes");

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(mockQuery).toHaveBeenCalled();
      // Verify prompt includes file contents section
      const callArgs = mockQuery.mock.calls[0] as [{ prompt: string }];
      expect(callArgs[0].prompt).toContain("Full Modified File Contents");
      expect(
        result.findings.some((f) => f.criterion === "Build succeeds" && f.status === "pass"),
      ).toBe(true);
      expect(result.findings.some((f) => f.criterion === "Tests pass" && f.status === "pass")).toBe(
        true,
      );
    });

    it("adds warn findings for criteria the LLM skipped", async () => {
      const { _setQueryFn } = await import("../../src/dispatcher/post-judge-verifier.js");
      const fs = await import("node:fs");
      (fs.promises.readFile as ReturnType<typeof jest.fn>).mockResolvedValue("file content");
      // LLM only responds about "Build succeeds" but skips "Tests pass"
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQuery = jest.fn().mockImplementation(async function* () {
        yield {
          type: "result",
          subtype: "success",
          content: `CRITERION: Build succeeds
STATUS: pass
EVIDENCE: Build command ran successfully`,
        };
      });
      _setQueryFn(mockQuery as unknown as ReturnType<typeof jest.fn>);

      mockAdapter.config.verification.postJudge!.layers = ["semantic"];
      mockExecSync.mockReturnValue("+ some code changes");

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      // "Tests pass" criterion should have a warn finding because LLM didn't evaluate it
      expect(result.findings.some((f) => f.criterion === "Tests pass" && f.status === "warn")).toBe(
        true,
      );
      expect(
        result.findings.some(
          (f) => f.criterion === "Tests pass" && f.evidence.includes("did not evaluate"),
        ),
      ).toBe(true);
    });

    it("confirms all criteria met when LLM evaluates them all", async () => {
      const { _setQueryFn } = await import("../../src/dispatcher/post-judge-verifier.js");
      const fs = await import("node:fs");
      (fs.promises.readFile as ReturnType<typeof jest.fn>).mockResolvedValue("file content");
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQuery = jest.fn().mockImplementation(async function* () {
        yield {
          type: "result",
          subtype: "success",
          content: `CRITERION: Build succeeds
STATUS: pass
EVIDENCE: Build command ran successfully

CRITERION: Tests pass
STATUS: pass
EVIDENCE: All tests passed`,
        };
      });
      _setQueryFn(mockQuery as unknown as ReturnType<typeof jest.fn>);

      mockAdapter.config.verification.postJudge!.layers = ["semantic"];
      mockExecSync.mockReturnValue("+ some code changes");

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      // No "warn" findings for missing criteria since all were evaluated
      expect(result.findings.filter((f) => f.evidence.includes("did not evaluate")).length).toBe(0);
    });

    it("identifies integration gaps via LLM but defers to deterministic checks (authority inversion)", async () => {
      const { _setQueryFn } = await import("../../src/dispatcher/post-judge-verifier.js");
      const fs = await import("node:fs");
      (fs.promises.readFile as ReturnType<typeof jest.fn>).mockResolvedValue("file content");
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQuery = jest.fn().mockImplementation(async function* () {
        yield {
          type: "result",
          subtype: "success",
          content: `CRITERION: Endpoint is registered
STATUS: fail
EVIDENCE: New endpoint function created but not added to server.ts routes`,
        };
      });
      _setQueryFn(mockQuery as unknown as ReturnType<typeof jest.fn>);

      mockAdapter.config.verification.postJudge!.layers = ["semantic"];
      mockExecSync.mockReturnValue("+ new endpoint code");

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      // Authority inversion: LLM flags a fail, but deterministic checks all pass
      // (build/test/lint were not run in semantic-only mode, defaulting to pass).
      // Result is verified=true with needsReview=true.
      expect(result.verified).toBe(true);
      expect(result.needsReview).toBe(true);
      expect(
        result.findings.some(
          (f) => f.status === "fail" && f.evidence.includes("not added to server"),
        ),
      ).toBe(true);
    });
  });

  describe("Dispatcher integration", () => {
    it("triggers retry when verification fails", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("test")) {
          throw new Error("Tests failed");
        }
        return "Success";
      });
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(false);
      expect(result.summary).toContain("failed");
      // Verify feedback is structured for retry
      const failures = result.findings.filter((f) => f.status === "fail");
      expect(failures.length).toBeGreaterThan(0);
    });

    it("proceeds to PR when verification passes", async () => {
      mockExecSync.mockReturnValue("Success");
      mockAdapter.config.verification.postJudge!.layers = ["deterministic"];

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.summary).toContain("passed");
    });
  });

  describe("Configuration", () => {
    it("respects enabled=false", async () => {
      mockAdapter.config.verification.postJudge!.enabled = false;

      const result = await runPostJudgeVerification(
        "TASK-065",
        mockTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      expect(result.verified).toBe(true);
      expect(result.summary).toContain("disabled");
    });

    it("uses defaults when config is absent", async () => {
      // Config is undefined, but defaults should still run deterministic checks
      mockAdapter.config.verification.postJudge = undefined;
      mockExecSync.mockReturnValue("Success");

      // Use a simpler task without filesToModify or testingRequirements
      // to avoid structural check failures in tests
      const simpleTask = {
        id: "TASK-065",
        successCriteria: ["Build succeeds", "Tests pass"],
        testingRequirements: [],
        filesToModify: [],
      } as unknown as ParsedTask;

      // Mock query function for semantic layer
      const { _setQueryFn } = await import("../../src/dispatcher/post-judge-verifier.js");
      const fs = await import("node:fs");
      (fs.promises.readFile as ReturnType<typeof jest.fn>).mockResolvedValue("file content");
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQuery = jest.fn().mockImplementation(async function* () {
        yield {
          type: "result",
          subtype: "success",
          content: "CRITERION: All checks pass\nSTATUS: pass\nEVIDENCE: Everything looks good",
        };
      });
      _setQueryFn(mockQuery as unknown as ReturnType<typeof jest.fn>);

      const result = await runPostJudgeVerification(
        "TASK-065",
        simpleTask,
        mockAdapter,
        "/test/worktree",
        mockEvents,
      );

      // Should use defaults and run
      expect(result.verified).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockEvents.emit).toHaveBeenCalled();
    });
  });
});
