/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
// Tests for the structured (cmd+args) verifier path added in TASK-866.
// Exercises the live spawn() codepath end-to-end via runVerification, since
// runStructuredCommand is module-private. Each test uses node -e expressions
// as the structured executable so the test suite is portable across hosts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runVerification, formatVerificationResult } from "../../src/worker/tools/verify";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type {
  AdapterConfig,
  StructuredVerificationCommand,
  LegacyVerificationCommand,
} from "../../src/core/types";

function makeAdapter(
  commands: Array<StructuredVerificationCommand | LegacyVerificationCommand>,
  projectRoot?: string,
): ProjectAdapter {
  const cwd = projectRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "quack-struct-"));
  const config: AdapterConfig = {
    version: "1.0",
    project: { name: "test", root: ".", taskDir: "docs/tasks", conventionsDir: "docs/conventions" },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: { commands, conventionChecks: [] },
    sandbox: {
      writablePaths: ["src/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
  };
  return {
    config,
    projectRoot: cwd,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("Structured verifier (TASK-866)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
    tempDirs.length = 0;
  });

  test("structured command success: exit 0 from spawned node process", async () => {
    const cmd: StructuredVerificationCommand = {
      name: "echo-ok",
      cmd: "node",
      args: ["-e", "console.log('hello world')"],
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([cmd]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "echo-ok");
    expect(result.allPassed).toBe(true);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.passed).toBe(true);
    expect(result.commands[0]?.output).toMatch(/hello world/);
  });

  test("structured command non-zero exit is reported as failure", async () => {
    const cmd: StructuredVerificationCommand = {
      name: "exit-7",
      cmd: "node",
      args: ["-e", "process.exit(7)"],
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([cmd]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "exit-7");
    expect(result.allPassed).toBe(false);
    expect(result.commands[0]?.passed).toBe(false);
  });

  test("structured command env vars are propagated to the spawned process", async () => {
    const cmd: StructuredVerificationCommand = {
      name: "echo-env",
      cmd: "node",
      args: ["-e", "process.stdout.write(process.env.QUACK_T866_TEST || 'MISSING')"],
      env: { QUACK_T866_TEST: "propagated" },
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([cmd]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "echo-env");
    expect(result.allPassed).toBe(true);
    expect(result.commands[0]?.output).toMatch(/propagated/);
  });

  test("structured command cwd is resolved relative to projectRoot", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cwd-"));
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, "subdir"));

    const cmd: StructuredVerificationCommand = {
      name: "show-cwd",
      cmd: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: "subdir",
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([cmd], projectRoot);

    const result = await runVerification(adapter, "show-cwd");
    expect(result.allPassed).toBe(true);
    // cwd must end with /subdir or \subdir depending on platform
    expect(result.commands[0]?.output).toMatch(/subdir/);
  });

  test("structured command preserves args with whitespace (spawn shell:false)", async () => {
    // The whole point of spawn-with-args: an arg with internal whitespace must
    // arrive at the executable as ONE arg, not get word-split by a shell.
    const cmd: StructuredVerificationCommand = {
      name: "two-words",
      cmd: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", "hello world here"],
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([cmd]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "two-words");
    expect(result.allPassed).toBe(true);
    // The whole "hello world here" should appear together — the runner did
    // NOT word-split it via a shell.
    expect(result.commands[0]?.output).toMatch(/hello world here/);
  });

  test("missing executable surfaces as exit-1 with informative stderr", async () => {
    const cmd: StructuredVerificationCommand = {
      name: "no-such-bin",
      cmd: "this-binary-definitely-does-not-exist-quack-test",
      args: [],
      required: true,
      timeout: 5_000,
    };
    const adapter = makeAdapter([cmd]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "no-such-bin");
    expect(result.allPassed).toBe(false);
    expect(result.commands[0]?.passed).toBe(false);
    expect(result.commands[0]?.output).toMatch(
      /spawn|ENOENT|not found|execution|VERIFICATION FAILED/i,
    );
  });

  test("legacy and structured commands coexist in the same adapter", async () => {
    const legacy: LegacyVerificationCommand = {
      name: "legacy-echo",
      command: "node -e \"console.log('legacy-ok')\"",
      required: true,
      timeout: 10_000,
    };
    const structured: StructuredVerificationCommand = {
      name: "structured-echo",
      cmd: "node",
      args: ["-e", "console.log('structured-ok')"],
      required: true,
      timeout: 10_000,
    };
    const adapter = makeAdapter([legacy, structured]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "all");
    expect(result.allPassed).toBe(true);
    expect(result.commands).toHaveLength(2);
    expect(result.commands.every((c) => c.passed)).toBe(true);
  });

  test("formatVerificationResult prints both legacy + structured under one banner", async () => {
    const adapter = makeAdapter([
      {
        name: "legacy-pass",
        command: "node -e \"console.log('lp')\"",
        required: true,
        timeout: 10_000,
      } as LegacyVerificationCommand,
      {
        name: "structured-pass",
        cmd: "node",
        args: ["-e", "console.log('sp')"],
        required: true,
        timeout: 10_000,
      } as StructuredVerificationCommand,
    ]);
    tempDirs.push(adapter.projectRoot);

    const result = await runVerification(adapter, "all");
    const text = formatVerificationResult(result);
    expect(text).toMatch(/VERIFICATION PASSED/);
    expect(text).toMatch(/legacy-pass/);
    expect(text).toMatch(/structured-pass/);
  });
});

describe("verificationCommandShellString", () => {
  test("legacy command returns command string verbatim", async () => {
    const { verificationCommandShellString } = await import("../../src/core/types");
    const legacy: LegacyVerificationCommand = {
      name: "x",
      command: "npm test --",
      required: true,
      timeout: 1000,
    };
    expect(verificationCommandShellString(legacy)).toBe("npm test --");
  });

  test("structured command joins cmd + args, quoting args with whitespace", async () => {
    const { verificationCommandShellString } = await import("../../src/core/types");
    const structured: StructuredVerificationCommand = {
      name: "x",
      cmd: "npm",
      args: ["--prefix", "frontends/web-dashboard", "run", "build"],
      required: true,
      timeout: 1000,
    };
    expect(verificationCommandShellString(structured)).toBe(
      "npm --prefix frontends/web-dashboard run build",
    );
  });

  test("structured command quotes args containing whitespace or shell metas", async () => {
    const { verificationCommandShellString } = await import("../../src/core/types");
    const structured: StructuredVerificationCommand = {
      name: "x",
      cmd: "echo",
      args: ["hello world", "foo;bar", "$plain"],
      required: true,
      timeout: 1000,
    };
    const out = verificationCommandShellString(structured);
    expect(out).toMatch(/^echo /);
    expect(out).toMatch(/"hello world"/);
    expect(out).toMatch(/"foo;bar"/);
    expect(out).toMatch(/"\$plain"/);
  });
});

describe("isStructuredVerificationCommand type guard", () => {
  test("returns true only for { cmd, args[] } shape", async () => {
    const { isStructuredVerificationCommand } = await import("../../src/core/types");
    expect(
      isStructuredVerificationCommand({
        name: "x",
        cmd: "node",
        args: ["-v"],
        required: true,
        timeout: 1000,
      } as StructuredVerificationCommand),
    ).toBe(true);
    expect(
      isStructuredVerificationCommand({
        name: "x",
        command: "node -v",
        required: true,
        timeout: 1000,
      } as LegacyVerificationCommand),
    ).toBe(false);
  });
});
