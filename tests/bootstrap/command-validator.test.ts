import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { validateCommands } from "../../src/bootstrap/command-validator";

describe("command-validator", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-test-"));
  });

  afterEach(async () => {
    // Retry cleanup on Windows where EBUSY can occur after killing child processes
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  it("should validate a passing command", async () => {
    const commands = [{ name: "echo", command: "echo hello" }];

    const results = await validateCommands(tempRoot, commands);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("pass");
    expect(results[0].exitCode).toBe(0);
    expect(results[0].stdout).toContain("hello");
  });

  it("should detect a failing command", async () => {
    const commands = [{ name: "fail", command: "exit 1" }];

    const results = await validateCommands(tempRoot, commands);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].exitCode).toBe(1);
  });

  it("should timeout slow commands", async () => {
    // Use node to create a slow command that works cross-platform
    const commands = [{ name: "slow", command: 'node -e "setTimeout(() => {}, 35000)"' }];

    const results = await validateCommands(tempRoot, commands);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("timeout");
    expect(results[0].durationMs).toBeGreaterThanOrEqual(29000);
    expect(results[0].durationMs).toBeLessThan(35000);
  }, 45000);

  it("should parse test count from Jest output", async () => {
    // Create a mock Jest output
    const commands = [{ name: "jest", command: "echo 'Tests: 5 passed, 5 total'" }];

    const results = await validateCommands(tempRoot, commands);

    expect(results[0].testCount).toBe(5);
  });

  it("should fail a test command that explicitly reports zero tests", async () => {
    const commands = [{ name: "jest", command: "echo 'Tests: 0 passed, 0 total'" }];

    const results = await validateCommands(tempRoot, commands);

    expect(results[0].status).toBe("fail");
    expect(results[0].testCount).toBe(0);
    expect(results[0].stderr).toContain("zero tests");
  });

  it("should parse test count from pytest output", async () => {
    const commands = [{ name: "pytest", command: "echo '10 passed in 1.2s'" }];

    const results = await validateCommands(tempRoot, commands);

    expect(results[0].testCount).toBe(10);
  });

  it("should truncate long output", async () => {
    // Generate long output
    const longString = "a".repeat(3000);
    const commands = [{ name: "long", command: `echo "${longString}"` }];

    const results = await validateCommands(tempRoot, commands);

    expect(results[0].stdout.length).toBeLessThanOrEqual(2020); // 2000 + "... [truncated]"
    expect(results[0].stdout).toContain("... [truncated]");
  });

  it("should capture stderr on failure", async () => {
    const commands = [
      { name: "stderr", command: "node -e \"console.error('error message'); process.exit(1)\"" },
    ];

    const results = await validateCommands(tempRoot, commands);

    expect(results[0].status).toBe("fail");
    expect(results[0].stderr).toContain("error message");
  });

  it("should validate multiple commands in sequence", async () => {
    const commands = [
      { name: "pass1", command: "echo test1" },
      { name: "pass2", command: "echo test2" },
      { name: "fail", command: "exit 1" },
    ];

    const results = await validateCommands(tempRoot, commands);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("pass");
    expect(results[1].status).toBe("pass");
    expect(results[2].status).toBe("fail");
  });
});
