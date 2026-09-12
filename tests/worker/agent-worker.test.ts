/* eslint-disable @typescript-eslint/no-require-imports -- tests load modules after installing Jest mocks */
import { promisify } from "node:util";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, TaskContext } from "../../src/core/types";
import { buildSystemPrompt, buildTaskPrompt } from "../../src/worker/prompt-builder";
import { checkBashCommand, checkWritePath } from "../../src/hooks/bash-guard";

// ─── Mock child_process.exec for git tool tests ─────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

let mockGitResults: Record<string, MockExecResult> = {};

function findGitResult(command: string): MockExecResult | undefined {
  for (const [pattern, result] of Object.entries(mockGitResults)) {
    if (command.includes(pattern)) {
      return result;
    }
  }
  return undefined;
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const customPromisified = (
    command: string,
    _options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    const matchedResult = findGitResult(command);
    if (!matchedResult) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }

    if (matchedResult.error) {
      const err = Object.assign(new Error("Command failed"), {
        code: matchedResult.code ?? 1,
        killed: false,
        signal: null,
        stdout: matchedResult.stdout ?? "",
        stderr: matchedResult.stderr ?? "",
      });
      return Promise.reject(err);
    }

    return Promise.resolve({
      stdout: matchedResult.stdout ?? "",
      stderr: matchedResult.stderr ?? "",
    });
  };

  const mockExec = jest.fn(
    (command: string, optionsOrCallback?: unknown, callbackMaybe?: unknown) => {
      const callback =
        typeof optionsOrCallback === "function"
          ? (optionsOrCallback as ExecCallback)
          : typeof callbackMaybe === "function"
            ? (callbackMaybe as ExecCallback)
            : undefined;

      if (callback) {
        const matchedResult = findGitResult(command);
        setImmediate(() => {
          if (matchedResult?.error) {
            const err = Object.assign(new Error("Command failed"), {
              code: matchedResult.code ?? 1,
              killed: false,
              signal: null,
              stdout: matchedResult.stdout ?? "",
              stderr: matchedResult.stderr ?? "",
            });
            callback(err, matchedResult.stdout ?? "", matchedResult.stderr ?? "");
            return;
          }

          callback(null, matchedResult?.stdout ?? "", matchedResult?.stderr ?? "");
        });
      }

      return {
        pid: 12345,
        kill: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        stdout: null,
        stderr: null,
      };
    },
  );
  (mockExec as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

  return {
    ...actual,
    exec: mockExec,
  };
});

// ─── Import git tools after mocking ──────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gitStatus, gitDiff, gitAdd, gitCommit, gitLog } =
  require("../../src/worker/tools/git") as typeof import("../../src/worker/tools/git");

// ─── Test helpers ────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
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
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: ["npm test *", "npm run *"],
      deniedBashPatterns: ["rm *", "rm -rf *"],
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
    conventionsDoc: "Use Express + Sequelize. camelCase in JS.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: defaultConfig,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskSpec: "# TASK-042: Add email validation\n\n## Problem Statement\nValidation needed.",
    conventions: { "ADR-012": "Input validation must use zod schemas." },
    conventionsSummary: "Use Express + Sequelize. camelCase in JS.",
    relevantFiles: ["--- src/controllers/auth.ts ---\nexport function register() {}"],
    relatedPatterns: ["--- src/controllers/user.ts ---\nexport function getUser() {}"],
    existingTests: ["--- tests/controllers/auth.test.ts ---\ntest('register', () => {})"],
    claudeMd: ["--- CLAUDE.md ---\n# Project Guide\nUse TypeScript strict mode."],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGitResults = {};
});

// ─── Prompt Builder Tests ───────────────────────────────────────────

describe("buildSystemPrompt", () => {
  test("should include core agent instructions", () => {
    const adapter = makeAdapter();
    const prompt = buildSystemPrompt(adapter, []);

    expect(prompt).toContain("Quack Agent");
    expect(prompt).toContain("background coding agent");
    expect(prompt).toContain("You MUST follow all project conventions");
    expect(prompt).toContain("You MUST call the `verify` tool before finishing");
  });

  test("should include project conventions from adapter", () => {
    const adapter = makeAdapter({
      conventionsDoc: "Always use async/await. Never use callbacks.",
    });
    const prompt = buildSystemPrompt(adapter, []);

    expect(prompt).toContain("Project Conventions");
    expect(prompt).toContain("Always use async/await. Never use callbacks.");
  });

  test("should include CLAUDE.md content", () => {
    const adapter = makeAdapter();
    const claudeMd = [
      "--- CLAUDE.md ---\n# Project Guide\nUse TypeScript.",
      "--- docs/CLAUDE.md ---\n# Docs Guide\nFollow JSDoc.",
    ];
    const prompt = buildSystemPrompt(adapter, claudeMd);

    expect(prompt).toContain("Project Documentation (CLAUDE.md)");
    expect(prompt).toContain("Use TypeScript.");
    expect(prompt).toContain("Follow JSDoc.");
  });

  test("should include git commit format", () => {
    const adapter = makeAdapter();
    const prompt = buildSystemPrompt(adapter, []);

    expect(prompt).toContain("[{taskId}] {message}");
    expect(prompt).toContain("Implemented-by: Quack Agent");
  });

  test("should handle empty conventions gracefully", () => {
    const adapter = makeAdapter({ conventionsDoc: "" });
    const prompt = buildSystemPrompt(adapter, []);

    // Should not include conventions section header when empty
    expect(prompt).not.toContain("## Project Conventions");
  });

  test("should handle empty CLAUDE.md array gracefully", () => {
    const adapter = makeAdapter();
    const prompt = buildSystemPrompt(adapter, []);

    expect(prompt).not.toContain("Project Documentation (CLAUDE.md)");
  });

  test("should produce correct layered prompt with all three layers", () => {
    const adapter = makeAdapter({
      conventionsDoc: "Layer 2: Conventions content.",
    });
    const claudeMd = ["Layer 3: CLAUDE.md content."];
    const prompt = buildSystemPrompt(adapter, claudeMd);

    // All three layers present
    expect(prompt).toContain("Quack Agent"); // Layer 1
    expect(prompt).toContain("Layer 2: Conventions content."); // Layer 2
    expect(prompt).toContain("Layer 3: CLAUDE.md content."); // Layer 3

    // Layers are separated by dividers
    expect(prompt).toContain("---");
  });
});

describe("buildTaskPrompt", () => {
  test("should include task specification", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Task Assignment: TASK-042");
    expect(prompt).toContain("Add email validation");
  });

  test("should include referenced conventions", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Referenced Conventions");
    expect(prompt).toContain("ADR-012");
    expect(prompt).toContain("Input validation must use zod schemas");
  });

  test("should include conventions summary", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Conventions Summary");
    expect(prompt).toContain("Use Express + Sequelize");
  });

  test("should include existing code context", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Existing Code Context");
    expect(prompt).toContain("auth.ts");
  });

  test("should include related patterns", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Related Patterns");
    expect(prompt).toContain("user.ts");
  });

  test("should include existing test files", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Related Test Files");
    expect(prompt).toContain("auth.test.ts");
  });

  test("should include instructions", () => {
    const context = makeContext();
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Instructions");
    expect(prompt).toContain("Call `verify`");
    expect(prompt).toContain("the post-worker output sealer is the only commit writer");
    expect(prompt).not.toContain("DO NOT stop without committing");
  });

  test("should handle empty context arrays gracefully", () => {
    const context = makeContext({
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
    });
    const prompt = buildTaskPrompt("TASK-042", context);

    expect(prompt).toContain("Task Assignment: TASK-042");
    expect(prompt).not.toContain("Referenced Conventions");
    expect(prompt).not.toContain("Existing Code Context");
    expect(prompt).not.toContain("Related Patterns");
    expect(prompt).not.toContain("Related Test Files");
  });
});

// ─── Git MCP Tool Tests ─────────────────────────────────────────────

describe("git tools", () => {
  describe("gitStatus", () => {
    test("should return short status output", async () => {
      mockGitResults = {
        "git status --short": { stdout: "M  src/foo.ts\n?? src/bar.ts\n" },
      };

      const result = await gitStatus("/test/project");

      expect(result).toContain("M  src/foo.ts");
      expect(result).toContain("?? src/bar.ts");
    });

    test("should return 'Working tree clean' when no changes", async () => {
      mockGitResults = {
        "git status --short": { stdout: "" },
      };

      const result = await gitStatus("/test/project");

      expect(result).toBe("Working tree clean");
    });

    test("should return error message on failure", async () => {
      mockGitResults = {
        "git status": { error: true, stderr: "fatal: not a git repository" },
      };

      const result = await gitStatus("/test/project");

      expect(result).toContain("git status failed");
    });
  });

  describe("gitDiff", () => {
    test("should return unstaged diff", async () => {
      mockGitResults = {
        "git diff": { stdout: "diff --git a/foo.ts\n+added line\n-removed line" },
      };

      const result = await gitDiff("/test/project", false);

      expect(result).toBeTruthy();
    });

    test("should return staged diff with --cached", async () => {
      mockGitResults = {
        "git diff --cached": { stdout: "diff --git a/bar.ts\n+staged change" },
      };

      const result = await gitDiff("/test/project", true);

      expect(result).toBeTruthy();
    });

    test("should return 'No unstaged changes' when empty", async () => {
      mockGitResults = {
        "git diff": { stdout: "" },
      };

      const result = await gitDiff("/test/project", false);

      expect(result).toBe("No unstaged changes");
    });

    test("should return 'No staged changes' when empty and staged", async () => {
      mockGitResults = {
        "git diff --cached": { stdout: "" },
      };

      const result = await gitDiff("/test/project", true);

      expect(result).toBe("No staged changes");
    });
  });

  describe("gitAdd", () => {
    test("should add specified paths", async () => {
      mockGitResults = {
        "git add": { stdout: "" },
      };

      const result = await gitAdd("/test/project", ["src/foo.ts", "src/bar.ts"]);

      expect(result).toContain("Added 2 path(s)");
      expect(result).toContain("src/foo.ts");
      expect(result).toContain("src/bar.ts");
    });

    test("should refuse to add all files with '.'", async () => {
      const result = await gitAdd("/test/project", ["."]);

      expect(result).toContain("Refusing to add all files");
    });

    test("should refuse to add with -A flag", async () => {
      const result = await gitAdd("/test/project", ["-A"]);

      expect(result).toContain("Refusing to add all files");
    });

    test("should refuse to add with --all flag", async () => {
      const result = await gitAdd("/test/project", ["--all"]);

      expect(result).toContain("Refusing to add all files");
    });

    test("should return message for empty paths", async () => {
      const result = await gitAdd("/test/project", []);

      expect(result).toContain("No paths specified");
    });
  });

  describe("gitCommit", () => {
    test("should commit with message", async () => {
      mockGitResults = {
        "git commit": { stdout: "[main abc1234] feat: add validation" },
      };

      const result = await gitCommit("/test/project", "[TASK-042] Add email validation");

      expect(result).toContain("Committed");
    });

    test("should return error on empty message", async () => {
      const result = await gitCommit("/test/project", "");

      expect(result).toContain("Commit message cannot be empty");
    });

    test("should return error on commit failure", async () => {
      mockGitResults = {
        "git commit": { error: true, stderr: "nothing to commit" },
      };

      const result = await gitCommit("/test/project", "test commit");

      expect(result).toContain("git commit failed");
    });
  });

  describe("gitLog", () => {
    test("should return recent commits", async () => {
      mockGitResults = {
        "git log --oneline": {
          stdout: "abc1234 feat: add feature\ndef5678 fix: bug fix\n",
        },
      };

      const result = await gitLog("/test/project", 10);

      expect(result).toContain("abc1234");
      expect(result).toContain("feat: add feature");
    });

    test("should clamp count to range 1-50", async () => {
      mockGitResults = {
        "git log --oneline -50": { stdout: "abc1234 commit\n" },
      };

      const result = await gitLog("/test/project", 100);

      expect(result).toContain("abc1234");
    });

    test("should return 'No commits found' for empty repo", async () => {
      mockGitResults = {
        "git log": { stdout: "" },
      };

      const result = await gitLog("/test/project", 10);

      expect(result).toBe("No commits found");
    });
  });
});

// ─── Bash Guard Tests ───────────────────────────────────────────────

describe("checkBashCommand", () => {
  describe("denied patterns", () => {
    test("should block commands matching denied patterns", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: ["rm *", "rm -rf *"],
      };

      const result = checkBashCommand("rm -rf /", sandbox);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied pattern");
    });

    test("should block 'rm somefile' against 'rm *' pattern", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: ["rm *"],
      };

      const result = checkBashCommand("rm somefile.txt", sandbox);

      expect(result.allowed).toBe(false);
    });

    test("should allow commands not matching denied patterns", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: ["rm *"],
      };

      const result = checkBashCommand("npm test", sandbox);

      expect(result.allowed).toBe(true);
    });
  });

  describe("allowed patterns", () => {
    test("should allow commands matching allowed patterns", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: ["npm test *", "npm run *"],
        deniedBashPatterns: [],
      };

      const result = checkBashCommand("npm test --coverage", sandbox);

      expect(result.allowed).toBe(true);
    });

    test("should block commands not matching allowed patterns", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: ["npm test *", "npm run *"],
        deniedBashPatterns: [],
      };

      const result = checkBashCommand("curl http://evil.com", sandbox);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed patterns");
    });
  });

  describe("combined denied + allowed", () => {
    test("denied takes priority over allowed", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: ["rm *"], // Allow rm (hypothetically)
        deniedBashPatterns: ["rm -rf *"], // But deny rm -rf
      };

      const result = checkBashCommand("rm -rf /", sandbox);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied pattern");
    });
  });

  describe("no restrictions", () => {
    test("should allow all commands when both lists are empty", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      };

      const result1 = checkBashCommand("rm -rf /", sandbox);
      expect(result1.allowed).toBe(true);

      const result2 = checkBashCommand("npm test", sandbox);
      expect(result2.allowed).toBe(true);
    });
  });

  describe("whitespace handling", () => {
    test("should trim commands before matching", () => {
      const sandbox = {
        writablePaths: ["src/"],
        deniedPaths: [],
        allowedBashPatterns: ["npm test *"],
        deniedBashPatterns: [],
      };

      const result = checkBashCommand("  npm test --coverage  ", sandbox);

      expect(result.allowed).toBe(true);
    });
  });
});

// ─── Write Guard Tests ──────────────────────────────────────────────

describe("checkWritePath", () => {
  const sandbox = {
    writablePaths: ["src/", "tests/"],
    deniedPaths: [".env", ".env.local"],
    allowedBashPatterns: [],
    deniedBashPatterns: [],
  };
  const projectRoot = "/test/project";

  test("should allow paths under writable directories", () => {
    const result = checkWritePath("src/foo.ts", sandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });

  test("should allow paths under tests/", () => {
    const result = checkWritePath("tests/foo.test.ts", sandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });

  test("should allow the exact root of a writable directory", () => {
    const result = checkWritePath("tests", sandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });

  test("should not allow a prefix collision for a writable file", () => {
    const result = checkWritePath(
      "package.json.backup",
      { ...sandbox, writablePaths: ["package.json"] },
      projectRoot,
    );
    expect(result.allowed).toBe(false);
  });

  test("should block paths not under writable directories", () => {
    const result = checkWritePath("package.json", sandbox, projectRoot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any writable path");
  });

  test("should allow Quack-managed PROGRESS.md outside adapter writable directories", () => {
    const result = checkWritePath("PROGRESS.md", sandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });

  test("should keep an explicit PROGRESS.md denial authoritative", () => {
    const result = checkWritePath(
      "PROGRESS.md",
      { ...sandbox, deniedPaths: [...sandbox.deniedPaths, "PROGRESS.md"] },
      projectRoot,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denied paths");
  });

  test("should block denied paths", () => {
    const result = checkWritePath(".env", sandbox, projectRoot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denied paths");
  });

  test("should block paths outside project root", () => {
    const result = checkWritePath("/other/project/file.ts", sandbox, projectRoot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the project root");
  });

  test("should allow all paths when writablePaths is empty", () => {
    const openSandbox = { ...sandbox, writablePaths: [], deniedPaths: [] };
    const result = checkWritePath("anywhere/file.ts", openSandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });

  test("should handle absolute paths within project", () => {
    const result = checkWritePath("/test/project/src/foo.ts", sandbox, projectRoot);
    expect(result.allowed).toBe(true);
  });
});

// ─── Stop Hook Tests ─────────────────────────────────────────────────

describe("verifyBeforeStop", () => {
  // We test the stop hook indirectly through the verify mock
  // since verifyBeforeStop calls runVerification

  test("should return canStop=true when all checks pass", async () => {
    mockGitResults = {}; // Clear git mocks, not needed here

    // Import verifyBeforeStop - it internally uses runVerification which
    // calls child_process.exec which is mocked above
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyBeforeStop } =
      require("../../src/hooks/verify-before-stop") as typeof import("../../src/hooks/verify-before-stop");

    // Set up mock to make all verification commands pass
    mockGitResults = {
      "npm test": { stdout: "Tests: 10 passed, 10 total" },
    };

    const adapter = makeAdapter();
    const result = await verifyBeforeStop(adapter);

    expect(result.canStop).toBe(true);
    expect(result.feedback).toContain("VERIFICATION PASSED");
    expect(result.verification.allPassed).toBe(true);
  });

  test("should return canStop=false when a check fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyBeforeStop } =
      require("../../src/hooks/verify-before-stop") as typeof import("../../src/hooks/verify-before-stop");

    mockGitResults = {
      "npm test": {
        error: true,
        code: 1,
        stdout: "FAIL src/test.ts\nTests: 1 failed, 9 passed, 10 total",
        stderr: "",
      },
    };

    const adapter = makeAdapter();
    const result = await verifyBeforeStop(adapter);

    expect(result.canStop).toBe(false);
    expect(result.feedback).toContain("STOP BLOCKED");
    expect(result.feedback).toContain("VERIFICATION FAILED");
    expect(result.verification.allPassed).toBe(false);
  });
});

// ─── Agent Worker Tests ──────────────────────────────────────────────

describe("runAgent", () => {
  // Mock SDK types — must match real SDK message shapes:
  // SDKAssistantMessage has { message: BetaMessage } where BetaMessage.content
  // is an array of ContentBlocks, NOT a string.
  // SDKResultSuccess has total_cost_usd and num_turns (snake_case).
  interface MockSDKMessage {
    type: string;
    subtype?: string;
    result?: string;
    total_cost_usd?: number;
    num_turns?: number;
    message?: {
      content: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
    };
    [key: string]: unknown;
  }

  type MockQueryFn = (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }) => AsyncGenerator<MockSDKMessage, void>;

  function* makeSuccessGenerator(resultText: string): Generator<MockSDKMessage, void> {
    yield {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I will implement the task now." }],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      result: resultText,
      total_cost_usd: 1.5,
      num_turns: 5,
    };
  }

  function createMockQueryFn(resultText: string): {
    fn: MockQueryFn;
    calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
  } {
    const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

    const fn = function (params: {
      prompt: string;
      options?: Record<string, unknown>;
    }): AsyncGenerator<MockSDKMessage, void> {
      calls.push(params);
      const syncGen = makeSuccessGenerator(resultText);
      const asyncGen: AsyncGenerator<MockSDKMessage, void> = {
        next: () => Promise.resolve(syncGen.next()),
        return: (value: void) => Promise.resolve(syncGen.return(value)),
        throw: (e: unknown) => Promise.resolve(syncGen.throw(e)),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return asyncGen;
    };

    return { fn, calls };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runAgent, _setQueryFn } =
    require("../../src/worker/agent-worker") as typeof import("../../src/worker/agent-worker");

  afterEach(() => {
    _setQueryFn(undefined);
  });

  test("should pass correct options to SDK query", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    const context = makeContext();

    await runAgent("TASK-042", context, adapter, { skipMcpServers: true });

    expect(calls).toHaveLength(1);
    const callArgs = calls[0];

    // Check model
    expect(callArgs?.options).toEqual(
      expect.objectContaining({
        model: "claude-opus-4-6",
        maxTurns: 50,
        permissionMode: "bypassPermissions",
        cwd: "/test/project",
      }),
    );

    // Check disallowed tools
    expect(callArgs?.options?.disallowedTools).toEqual([
      "WebSearch",
      "WebFetch",
      "Task",
      "AskUserQuestion",
    ]);
  });

  test("does not expose the operator managed-Docker image allowlist to direct SDK agents", async () => {
    const priorAllowlist = process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES;
    const priorSentinel = process.env.QUACK_AGENT_ENV_SENTINEL;
    process.env.QuAcK_TrUsTeD_MaNaGeD_DoCkEr_ImAgEs = '["trusted@sha256:secret"]';
    process.env.QUACK_AGENT_ENV_SENTINEL = "visible";
    try {
      const { fn, calls } = createMockQueryFn("Task completed");
      _setQueryFn(fn);

      await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true });

      const env = calls[0]?.options?.env as NodeJS.ProcessEnv;
      expect(env.QUACK_AGENT_ENV_SENTINEL).toBe("visible");
      expect(
        Object.keys(env).some((key) => key.toUpperCase() === "QUACK_TRUSTED_MANAGED_DOCKER_IMAGES"),
      ).toBe(false);
    } finally {
      delete process.env.QuAcK_TrUsTeD_MaNaGeD_DoCkEr_ImAgEs;
      if (priorAllowlist === undefined) delete process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES;
      else process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES = priorAllowlist;
      if (priorSentinel === undefined) delete process.env.QUACK_AGENT_ENV_SENTINEL;
      else process.env.QUACK_AGENT_ENV_SENTINEL = priorSentinel;
    }
  });

  test("should use system prompt with all three layers", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter({
      conventionsDoc: "Test conventions layer.",
    });
    const context = makeContext({
      claudeMd: ["Test CLAUDE.md layer."],
    });

    await runAgent("TASK-042", context, adapter, { skipMcpServers: true });

    const systemPrompt = calls[0]?.options?.systemPrompt as string;
    expect(systemPrompt).toContain("Quack Agent"); // Layer 1
    expect(systemPrompt).toContain("Test conventions layer."); // Layer 2
    expect(systemPrompt).toContain("Test CLAUDE.md layer."); // Layer 3
  });

  test("should include task prompt with context", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const context = makeContext();

    await runAgent("TASK-042", context, makeAdapter(), { skipMcpServers: true });

    const taskPrompt = calls[0]?.prompt;
    expect(taskPrompt).toContain("Task Assignment: TASK-042");
    expect(taskPrompt).toContain("Add email validation");
  });

  test("should respect model override", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
      model: "claude-sonnet-4-6",
    });

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
      }),
    );
  });

  test("should respect maxTurns override", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
      maxTurns: 10,
    });

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        maxTurns: 10,
      }),
    );
  });

  test("should return success result on completion", async () => {
    const { fn } = createMockQueryFn("Task completed successfully");
    _setQueryFn(fn);

    const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.taskId).toBe("TASK-042");
    expect(result.outcome).toBe("success");
  });

  test("should return failure result on SDK error", async () => {
    const fn: MockQueryFn = function () {
      return {
        next: () => Promise.reject(new Error("SDK crashed")),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
        throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    _setQueryFn(fn);

    const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.taskId).toBe("TASK-042");
    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("SDK crashed");
  });

  test("should return timeout outcome for timeout errors", async () => {
    const fn: MockQueryFn = function () {
      return {
        next: () => Promise.reject(new Error("Agent timed out after 300s")),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
        throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    _setQueryFn(fn);

    const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.error).toContain("timed out");
  });

  test("should return budget_exceeded outcome for budget errors", async () => {
    const fn: MockQueryFn = function () {
      return {
        next: () => Promise.reject(new Error("API rate limit exceeded")),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
        throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    _setQueryFn(fn);

    const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("budget_exceeded");
    expect(result.error).toContain("rate limit");
  });

  test("should pass maxBudgetUsd from adapter maxBudgetPerTask", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    adapter.config.agent.maxBudgetPerTask = 3.5;

    await runAgent("TASK-042", makeContext(), adapter, { skipMcpServers: true });

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        maxBudgetUsd: 3.5,
      }),
    );
  });

  test("should not pass maxBudgetUsd when maxBudgetPerTask is 0", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    adapter.config.agent.maxBudgetPerTask = 0;

    await runAgent("TASK-042", makeContext(), adapter, { skipMcpServers: true });

    expect(calls[0]?.options?.maxBudgetUsd).toBeUndefined();
  });

  describe("TASK-1314: SDK result-subtype outcome mapping", () => {
    function makeResultGenerator(messages: MockSDKMessage[]): MockQueryFn {
      return function () {
        let index = 0;
        return {
          next: () =>
            Promise.resolve(
              index < messages.length
                ? { done: false as const, value: messages[index++] }
                : { done: true as const, value: undefined },
            ),
          return: () => Promise.resolve({ done: true as const, value: undefined }),
          throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };
    }

    function errorResult(subtype: string, errors: string[]): MockSDKMessage {
      return {
        type: "result",
        subtype,
        errors,
        total_cost_usd: 0.5,
        num_turns: 7,
        session_id: "err-session-1",
      };
    }

    const WORKING: MockSDKMessage = {
      type: "assistant",
      message: { content: [{ type: "text", text: "working" }] },
    };

    test.each([
      ["error_max_turns", "max_turns"],
      ["error_max_budget_usd", "budget_exceeded"],
      ["error_during_execution", "failure"],
      ["error_max_structured_output_retries", "failure"],
      ["error_completely_invented_subtype", "failure"], // fail-closed default
    ])("subtype %s maps to outcome %s, never success", async (subtype, expected) => {
      _setQueryFn(makeResultGenerator([WORKING, errorResult(subtype, ["boom detail"])]));

      const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
        skipMcpServers: true,
      });

      expect(result.outcome).toBe(expected);
      expect(result.error).toContain(subtype);
      expect(result.error).toContain("boom detail");
      // Field parity with the success return.
      expect(result.claudeSessionId).toBe("err-session-1");
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.totalCostUsd).toBe(0.5);
      expect(result.turnsUsed).toBe(7);
    });

    test("errors[] reaches the typed agent_complete payload with LITERAL bounds (round-2 F2)", async () => {
      const longItem = "x".repeat(600);
      const twelveItems = Array.from({ length: 12 }, (_, i) => `${i}-${longItem}`);
      _setQueryFn(makeResultGenerator([errorResult("error_during_execution", twelveItems)]));

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const events = {
        emit: (stage: string, payload: Record<string, unknown>) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

      const result = await runAgent(
        "TASK-042",
        makeContext(),
        makeAdapter(),
        { skipMcpServers: true },
        events,
      );

      expect(result.outcome).toBe("failure");
      const complete = emitted.find((e) => e.stage === "agent_complete");
      expect(complete).toBeDefined();
      expect(complete?.payload.outcome).toBe("failure");
      const errors = complete?.payload.errors as string[];
      // HARD caps, marker INSIDE them: ≤10 items, every item ≤500
      // chars, aggregate ≤4000 chars.
      expect(errors.length).toBeLessThanOrEqual(10);
      for (const item of errors) {
        expect(item.length).toBeLessThanOrEqual(500);
      }
      expect(errors.join("").length).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(errors)).toContain("…(truncated)");
    });

    test("nine 500-char items respect the aggregate cap exactly (round-2 F2 scenario)", async () => {
      const nineItems = Array.from({ length: 9 }, (_, i) => String(i).repeat(500));
      _setQueryFn(makeResultGenerator([errorResult("error_during_execution", nineItems)]));

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const events = {
        emit: (stage: string, payload: Record<string, unknown>) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

      await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true }, events);

      const complete = emitted.find((e) => e.stage === "agent_complete");
      const errors = complete?.payload.errors as string[];
      for (const item of errors) {
        expect(item.length).toBeLessThanOrEqual(500);
      }
      expect(errors.join("").length).toBeLessThanOrEqual(4000);
      expect(errors[errors.length - 1].endsWith("…(truncated)")).toBe(true);
    });

    test("count-overflow with a tiny last item at a nearly-full aggregate stays within BOTH caps (round-2b)", async () => {
      // Nine 444-char items (3996) + a 1-char item (3997 total, 10 kept)
      // + an 11th triggering count truncation: the naive marker rewrite
      // on the 1-char tail would emit 4006 chars. The tail walk must
      // drop it and mark the previous item instead.
      const items = [
        ...Array.from({ length: 9 }, (_, i) => String(i).repeat(444)),
        "x",
        "overflow-item",
      ];
      _setQueryFn(makeResultGenerator([errorResult("error_during_execution", items)]));

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const events = {
        emit: (stage: string, payload: Record<string, unknown>) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

      await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true }, events);

      const complete = emitted.find((e) => e.stage === "agent_complete");
      const errors = complete?.payload.errors as string[];
      expect(errors.length).toBeLessThanOrEqual(10);
      for (const item of errors) {
        expect(item.length).toBeLessThanOrEqual(500);
      }
      expect(errors.join("").length).toBeLessThanOrEqual(4000);
      expect(errors[errors.length - 1].endsWith("…(truncated)")).toBe(true);
    });

    test("error results carry mid-run safetyFacts (field parity, round-2 F3)", async () => {
      type HookFn = (
        input: Record<string, unknown>,
        toolUseID: string | undefined,
        options: { signal: AbortSignal },
      ) => Promise<unknown>;
      const fn: MockQueryFn = function (params) {
        async function* gen(): AsyncGenerator<MockSDKMessage, void> {
          const hooks = params.options?.hooks as {
            PreToolUse: Array<{ matcher?: string; hooks: HookFn[] }>;
          };
          const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
          await bashHook!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "git push --force origin main" },
            },
            "tool-1",
            { signal: new AbortController().signal },
          );
          yield WORKING;
          yield errorResult("error_max_turns", ["turns exhausted"]);
        }
        return gen();
      };
      _setQueryFn(fn);

      const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
        skipMcpServers: true,
      });

      expect(result.outcome).toBe("max_turns");
      expect(result.safetyFacts).toBeDefined();
      expect(result.safetyFacts!.some((fact) => fact.kind === "branch_mutation")).toBe(true);
      expect(result.verification).toBeNull();
      expect(Array.isArray(result.filesModified)).toBe(true);
    });

    test("success payload carries NO errors field, stays success, and cache metrics still emit (round-2 F3)", async () => {
      _setQueryFn(
        makeResultGenerator([
          WORKING,
          {
            type: "result",
            subtype: "success",
            result: "Task completed",
            total_cost_usd: 1.5,
            num_turns: 5,
            session_id: "ok-session",
            modelUsage: {
              "claude-opus-4-6": {
                inputTokens: 1000,
                outputTokens: 200,
                cacheReadInputTokens: 600,
                cacheCreationInputTokens: 100,
                costUSD: 1.5,
              },
            },
          },
        ]),
      );

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const events = {
        emit: (stage: string, payload: Record<string, unknown>) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

      const result = await runAgent(
        "TASK-042",
        makeContext(),
        makeAdapter(),
        { skipMcpServers: true },
        events,
      );

      expect(result.outcome).toBe("success");
      expect(result.error).toBeUndefined();
      const complete = emitted.find((e) => e.stage === "agent_complete");
      expect(complete?.payload.outcome).toBe("success");
      expect(complete?.payload.errors).toBeUndefined();
      // Success-path byte-identity: the cache-metrics emission survives.
      expect(emitted.some((e) => e.stage === "cache_metrics")).toBe(true);
    });

    test("a stream that ends WITHOUT a result message fails closed", async () => {
      _setQueryFn(makeResultGenerator([WORKING]));

      const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
        skipMcpServers: true,
      });

      expect(result.outcome).toBe("failure");
      expect(result.error).toContain("without a result message");
    });
  });

  test("should include hooks in SDK options", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    const options = calls[0]?.options;
    const hooks = options?.hooks as {
      PreToolUse: Array<{ matcher?: string; hooks: unknown[] }>;
      Stop: Array<{ hooks: unknown[] }>;
    };
    expect(hooks).toBeDefined();
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]?.matcher).toBe("Bash");
    expect(hooks.PreToolUse[1]?.matcher).toBe("Write|Edit");
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0]?.hooks).toHaveLength(1);
  });

  test("returned result carries PRE-FILTER safetyFacts fired mid-run (TASK-1313 F14, round-2 F10)", async () => {
    // The mock generator plays the SDK's part: it invokes the Bash
    // PreToolUse hook DURING iteration (the result snapshots the
    // accumulator at return time, so post-run hook calls would not
    // register — this proves mid-run accumulation for real).
    type HookFn = (
      input: Record<string, unknown>,
      toolUseID: string | undefined,
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
    const fn: MockQueryFn = function (params) {
      async function* gen(): AsyncGenerator<MockSDKMessage, void> {
        const hooks = params.options?.hooks as {
          PreToolUse: Array<{ matcher?: string; hooks: HookFn[] }>;
        };
        const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
        expect(bashHook).toBeDefined();
        // A floor-denied history rewrite AND an ALLOWED shape-only
        // deploy (deploy observation runs on allowed commands only —
        // the adapter below allowlists kubectl). The shape-only fact is
        // SSE-filtered but must still reach the carrier.
        for (const command of ["git push --force origin main", "kubectl apply -f x.yaml"]) {
          await bashHook!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command },
            },
            "tool-1",
            { signal: new AbortController().signal },
          );
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "working" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          total_cost_usd: 1.0,
          num_turns: 2,
        };
      }
      return gen();
    };
    _setQueryFn(fn);

    const adapter = makeAdapter();
    adapter.config.sandbox.allowedBashPatterns.push("kubectl *");
    const result = await runAgent("TASK-042", makeContext(), adapter, {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("success");
    expect(result.safetyFacts).toBeDefined();
    expect(result.safetyFacts!.some((fact) => fact.kind === "branch_mutation")).toBe(true);
    expect(
      result.safetyFacts!.some((fact) => fact.kind === "deploy" && fact.tier === "shape_only"),
    ).toBe(true);
  });

  test("should deny bash commands outside adapter allowlist through SDK hook shape", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: {
              permissionDecision?: string;
              permissionDecisionReason?: string;
            };
          }>
        >;
      }>;
    };

    const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
    expect(bashHook).toBeDefined();
    const result = await bashHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "find / -name enrichment-agent.ts" },
      },
      "tool-1",
      { signal: new AbortController().signal },
    );

    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(
      "not in allowed patterns",
    );
  });

  test.each([
    ["git add foo.ts"],
    ["git add ."],
    ["git commit -m 'msg'"],
    ["git push origin main"],
    ["git reset --hard"],
    ["git stash"],
    ["git checkout dev"],
    ["git switch -c new-branch"],
    ["git rebase -i HEAD~3"],
    ["git merge feature"],
    ["git revert HEAD"],
    ["git tag v1.0"],
    ["git branch -D old-branch"],
    ["  git add src/foo.ts"], // leading whitespace
    ["cd . && git push --force"], // TASK-1312: compound-command hardening
    ["git -C . push origin main"], // TASK-1312: option-prefix hardening
    ["git remote set-url origin https://example.com/x.git"], // TASK-1312
    ["git config alias.pf '!git push --force'"], // TASK-1312
  ])("should deny git write command via Bash hook: %s", async (command) => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);
    await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true });

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }>
        >;
      }>;
    };
    const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
    const result = await bashHook!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /post-worker output sealer/,
    );
  });

  test.each([
    ["git status"],
    ["git diff main..HEAD"],
    ["git log --oneline -5"],
    ["git rev-parse HEAD"],
    ["git merge-base origin/main HEAD"],
    ["git fetch origin"],
    ["git show abc123"],
  ])("should NOT deny git read/inspection command via Bash hook: %s", async (command) => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter({
      config: {
        ...makeAdapter().config,
        sandbox: {
          writablePaths: ["src/"],
          deniedPaths: [],
          // Allow these read/inspection patterns so the second-stage allowlist check passes.
          allowedBashPatterns: [
            "git status*",
            "git diff*",
            "git log*",
            "git rev-parse*",
            "git merge-base*",
            "git fetch*",
            "git show*",
          ],
          deniedBashPatterns: [],
        },
      },
    });

    await runAgent("TASK-042", makeContext(), adapter, { skipMcpServers: true });

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: { permissionDecision?: string };
          }>
        >;
      }>;
    };
    const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
    const result = await bashHook!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      "tool-1",
      { signal: new AbortController().signal },
    );
    // Either explicitly allow (no decision) or pass through — must not be "deny".
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  test("denied branch-mutation attempt emits a safety_fact (TASK-1312 attempt visibility)", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);
    const emit = jest.fn<void, [string, unknown]>();
    const events = { emit } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

    await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true }, events);

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: { permissionDecision?: string };
          }>
        >;
      }>;
    };
    const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
    const result = await bashHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
      },
      "tool-1",
      { signal: new AbortController().signal },
    );

    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    const safetyCalls = emit.mock.calls.filter(([stage]) => stage === "safety_fact");
    expect(safetyCalls).toHaveLength(1);
    const payload = safetyCalls[0][1] as {
      origin: string;
      facts: Array<{ mutationClass: string; candidateSafetyCode?: string }>;
    };
    expect(payload.origin).toBe("worker_bash_denial");
    expect(payload.facts[0].mutationClass).toBe("history_rewrite");
    expect(payload.facts[0].candidateSafetyCode).toBe("protected_branch_history_rewrite");
  });

  test("TASK-1313: Write to the ACTIVE task spec is refused (always-on)", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const context = { ...makeContext(), taskSpecPath: "docs/tasks/TASK-042-x.md" };
    await runAgent("TASK-042", context, makeAdapter(), { skipMcpServers: true });

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }>
        >;
      }>;
    };
    const writeHook = hooks.PreToolUse.find((h) => h.matcher === "Write|Edit")?.hooks[0];
    const denied = await writeHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "docs/tasks/TASK-042-x.md" },
      },
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain("own spec");

    const allowed = await writeHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "src/feature.ts" },
      },
      "tool-2",
      { signal: new AbortController().signal },
    );
    expect(allowed.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  test("plain git write denials stay event-silent (no safety_fact noise)", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);
    const emit = jest.fn<void, [string, unknown]>();
    const events = { emit } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

    await runAgent("TASK-042", makeContext(), makeAdapter(), { skipMcpServers: true }, events);

    const hooks = calls[0]?.options?.hooks as {
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            hookSpecificOutput?: { permissionDecision?: string };
          }>
        >;
      }>;
    };
    const bashHook = hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0];
    emit.mockClear();
    const result = await bashHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'x'" },
      },
      "tool-1",
      { signal: new AbortController().signal },
    );

    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(emit.mock.calls.filter(([stage]) => stage === "safety_fact")).toHaveLength(0);
  });

  test("createGitToolDefinitions exposes 3 read-only tools (no add/commit)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createGitToolDefinitions } =
      require("../../src/worker/tools/git") as typeof import("../../src/worker/tools/git");
    const defs = createGitToolDefinitions("/test/project");
    expect(defs).toHaveLength(3);
    const names = defs.map((d) => d.name);
    expect(names).toEqual(["git_status", "git_diff", "git_log"]);
    expect(names).not.toContain("git_add");
    expect(names).not.toContain("git_commit");
  });

  test("should use retryFeedback as resume prompt when resuming with feedback", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    const context = makeContext();

    await runAgent("TASK-042", context, adapter, {
      skipMcpServers: true,
      resumeSessionId: "session-abc-123",
      retryFeedback: "## REVISION REQUIRED\n\nFix the missing error handling.",
    });

    expect(calls).toHaveLength(1);
    // The prompt should be the retryFeedback, not the generic continue message
    expect(calls[0]?.prompt).toBe("## REVISION REQUIRED\n\nFix the missing error handling.");
    // No systemPrompt on resume (already in session history)
    expect(calls[0]?.options?.systemPrompt).toBeUndefined();
    // Session resume options should be set
    expect(calls[0]?.options?.resume).toBe("session-abc-123");
    expect(calls[0]?.options?.forkSession).toBe(true);
  });

  test("should use generic continue prompt when resuming without feedback", async () => {
    const { fn, calls } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    const context = makeContext();

    await runAgent("TASK-042", context, adapter, {
      skipMcpServers: true,
      resumeSessionId: "session-abc-456",
    });

    expect(calls).toHaveLength(1);
    // Should use the generic continue prompt
    expect(calls[0]?.prompt).toContain("Continue implementing the task");
    expect(calls[0]?.prompt).toContain("claude-progress.txt");
    // Session resume options should be set
    expect(calls[0]?.options?.resume).toBe("session-abc-456");
  });

  test("should track messages from agent", async () => {
    const { fn } = createMockQueryFn("Task completed");
    _setQueryFn(fn);

    const result = await runAgent("TASK-042", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    // Should have at least the assistant message from our mock generator
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe("I will implement the task now.");
  });
});
