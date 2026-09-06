import { Command } from "commander";

// ─── Tests: CLI argument parsing ──────────────────────────────────────

describe("CLI argument parsing", () => {
  function createProgram(): Command {
    const program = new Command();
    program.name("quack").description("Test CLI").version("0.1.0").exitOverride(); // Prevent process.exit in tests

    return program;
  }

  describe("run command", () => {
    test("should parse task ID argument", () => {
      const program = createProgram();
      let capturedTaskId = "";
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("run <taskId>")
        .option("--dry-run", "Show what would happen without executing")
        .option("--project <path>", "Path to project root")
        .action((taskId: string, options: Record<string, unknown>) => {
          capturedTaskId = taskId;
          capturedOptions = options;
        });

      program.parse(["node", "quack", "run", "TASK-042"]);

      expect(capturedTaskId).toBe("TASK-042");
      expect(capturedOptions.dryRun).toBeUndefined();
    });

    test("should parse --dry-run flag", () => {
      const program = createProgram();
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("run <taskId>")
        .option("--dry-run", "Show what would happen without executing")
        .option("--project <path>", "Path to project root")
        .action((_taskId: string, options: Record<string, unknown>) => {
          capturedOptions = options;
        });

      program.parse(["node", "quack", "run", "TASK-042", "--dry-run"]);

      expect(capturedOptions.dryRun).toBe(true);
    });

    test("should parse --project option", () => {
      const program = createProgram();
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("run <taskId>")
        .option("--dry-run", "Show what would happen without executing")
        .option("--project <path>", "Path to project root")
        .action((_taskId: string, options: Record<string, unknown>) => {
          capturedOptions = options;
        });

      program.parse(["node", "quack", "run", "TASK-042", "--project", "/my/project"]);

      expect(capturedOptions.project).toBe("/my/project");
    });

    test("should fail without task ID", () => {
      const program = createProgram();

      program.command("run <taskId>").action((_taskId: string) => {
        // Should not reach here
      });

      expect(() => {
        program.parse(["node", "quack", "run"]);
      }).toThrow();
    });
  });

  describe("wave command", () => {
    test("should parse wave number and default parallel to 1", () => {
      const program = createProgram();
      let capturedWaveNumber = "";
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("wave <waveNumber>")
        .option("--parallel <count>", "Number of parallel tasks", "1")
        .option("--project <path>", "Path to project root")
        .action((waveNumber: string, options: Record<string, unknown>) => {
          capturedWaveNumber = waveNumber;
          capturedOptions = options;
        });

      program.parse(["node", "quack", "wave", "1"]);

      expect(capturedWaveNumber).toBe("1");
      expect(capturedOptions.parallel).toBe("1");
    });

    test("should parse --parallel option", () => {
      const program = createProgram();
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("wave <waveNumber>")
        .option("--parallel <count>", "Number of parallel tasks", "1")
        .option("--project <path>", "Path to project root")
        .action((_waveNumber: string, options: Record<string, unknown>) => {
          capturedOptions = options;
        });

      program.parse(["node", "quack", "wave", "2", "--parallel", "4"]);

      expect(capturedOptions.parallel).toBe("4");
    });
  });

  describe("verify command", () => {
    test("should parse task ID", () => {
      const program = createProgram();
      let capturedTaskId = "";

      program
        .command("verify <taskId>")
        .option("--project <path>", "Path to project root")
        .action((taskId: string) => {
          capturedTaskId = taskId;
        });

      program.parse(["node", "quack", "verify", "TASK-007"]);

      expect(capturedTaskId).toBe("TASK-007");
    });
  });

  describe("enrich command", () => {
    test("should parse task ID", () => {
      const program = createProgram();
      let capturedTaskId = "";

      program
        .command("enrich <taskId>")
        .option("--project <path>", "Path to project root")
        .action((taskId: string) => {
          capturedTaskId = taskId;
        });

      program.parse(["node", "quack", "enrich", "TASK-009"]);

      expect(capturedTaskId).toBe("TASK-009");
    });
  });

  describe("init command", () => {
    test("should parse project path", () => {
      const program = createProgram();
      let capturedPath = "";

      program.command("init <projectPath>").action((projectPath: string) => {
        capturedPath = projectPath;
      });

      program.parse(["node", "quack", "init", "/path/to/project"]);

      expect(capturedPath).toBe("/path/to/project");
    });
  });

  describe("status command", () => {
    test("should parse without arguments", () => {
      const program = createProgram();
      let actionCalled = false;

      program
        .command("status")
        .option("--project <path>", "Path to project root")
        .action(() => {
          actionCalled = true;
        });

      program.parse(["node", "quack", "status"]);

      expect(actionCalled).toBe(true);
    });

    test("should parse --project option", () => {
      const program = createProgram();
      let capturedOptions: Record<string, unknown> = {};

      program
        .command("status")
        .option("--project <path>", "Path to project root")
        .action((options: Record<string, unknown>) => {
          capturedOptions = options;
        });

      program.parse(["node", "quack", "status", "--project", "/my/project"]);

      expect(capturedOptions.project).toBe("/my/project");
    });
  });
});
