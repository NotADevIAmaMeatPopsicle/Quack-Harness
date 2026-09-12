import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  _setSandboxedVerificationRunner,
  buildVerificationPermissionArgs,
  runCodexSandboxedVerification,
} from "../../src/worker/verification-sandbox.js";

describe("verification sandbox", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-verification-sandbox-test-"));
    await fs.mkdir(path.join(root, ".quack"), { recursive: true });
  });

  afterEach(async () => {
    _setSandboxedVerificationRunner(undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  test("builds a network-off profile with a read-only authority and writable worktree", async () => {
    const worktree = path.join(root, ".quack", "worktrees", "TASK-TEST");
    await fs.mkdir(path.join(worktree, ".quack"), { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: elsewhere\n", "utf8");

    const args = buildVerificationPermissionArgs({
      authoritativeRoot: root,
      cwd: worktree,
    });
    const config = args[args.indexOf("-c") + 1];

    expect(args).toContain("quack_verify");
    expect(args).toContain("permissions.quack_verify.network.enabled=false");
    expect(config).toContain('":minimal"="read"');
    expect(config).toContain(`"${root.replace(/\\/g, "/")}"="read"`);
    expect(config).toContain(`"${worktree.replace(/\\/g, "/")}"="write"`);
    expect(config).toContain(`"${path.join(worktree, ".git").replace(/\\/g, "/")}"="read"`);
  });

  test("uses the contained runner and strips ambient secrets", async () => {
    const previousSecret = process.env.QUACK_VERIFY_TEST_SECRET;
    process.env.QUACK_VERIFY_TEST_SECRET = "must-not-cross";
    let captured:
      | Parameters<NonNullable<Parameters<typeof _setSandboxedVerificationRunner>[0]>>[0]
      | undefined;
    _setSandboxedVerificationRunner((input) => {
      captured = input;
      return Promise.resolve({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      });
    });

    try {
      const result = await runCodexSandboxedVerification({
        cwd: root,
        authoritativeRoot: root,
        codexBinaryPath: process.execPath,
        timeoutMs: 12_345,
        command: {
          executable: process.execPath,
          args: ["--version"],
          env: { DEMO_FLAG: "yes" },
        },
      });

      expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
      expect(captured).toBeDefined();
      expect(captured?.executable).toBe(path.resolve(process.execPath));
      expect(captured?.args).toContain("sandbox");
      expect(captured?.args).toContain("permissions.quack_verify.network.enabled=false");
      expect(captured?.env.QUACK_VERIFY_TEST_SECRET).toBeUndefined();
      expect(captured?.env.DEMO_FLAG).toBeUndefined();
      if (process.platform === "win32") {
        const capturedArgs = captured?.args ?? [];
        const encodedIndex = capturedArgs.indexOf("-EncodedCommand");
        expect(encodedIndex).toBeGreaterThanOrEqual(0);
        const encodedCommand = capturedArgs[encodedIndex + 1];
        expect(encodedCommand).toBeDefined();
        const innerScript = Buffer.from(encodedCommand ?? "", "base64").toString("utf16le");
        expect(innerScript).toContain(
          "[Environment]::SetEnvironmentVariable('DEMO_FLAG', 'yes', \"Process\")",
        );
      } else {
        expect(captured?.args).toContain("DEMO_FLAG=yes");
      }
      expect(captured?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(captured?.timeoutMs).toBe(12_345);
      expect(captured?.env.HOME).toContain(path.join(".quack", "verification-temp"));
    } finally {
      if (previousSecret === undefined) delete process.env.QUACK_VERIFY_TEST_SECRET;
      else process.env.QUACK_VERIFY_TEST_SECRET = previousSecret;
    }
  });

  test("rejects protected environment overrides before launching", async () => {
    const runner = jest.fn();
    _setSandboxedVerificationRunner(runner);

    const result = await runCodexSandboxedVerification({
      cwd: root,
      authoritativeRoot: root,
      codexBinaryPath: process.execPath,
      timeoutMs: 1_000,
      command: {
        executable: process.execPath,
        args: ["--version"],
        env: { PATH: root },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot override protected environment variable PATH");
    expect(runner).not.toHaveBeenCalled();
  });

  test.each(["LD_PRELOAD", "ld_audit", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "SHELLOPTS"])(
    "rejects loader or shell-control override %s before launching",
    async (name) => {
      const runner = jest.fn();
      _setSandboxedVerificationRunner(runner);

      const result = await runCodexSandboxedVerification({
        cwd: root,
        authoritativeRoot: root,
        codexBinaryPath: process.execPath,
        timeoutMs: 1_000,
        command: {
          executable: process.execPath,
          args: ["--version"],
          env: { [name]: path.join(root, "attacker-controlled") },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`protected environment variable ${name}`);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  test("fails closed when descendant containment is not proven", async () => {
    _setSandboxedVerificationRunner(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: "untrusted output",
        stderr: "",
        timedOut: false,
        descendantsContained: false,
      }),
    );

    const result = await runCodexSandboxedVerification({
      cwd: root,
      authoritativeRoot: root,
      codexBinaryPath: process.execPath,
      timeoutMs: 1_000,
      command: { command: "echo unsafe" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("descendant containment was not proven");
  });

  test("refuses a cwd outside the authoritative root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "quack-verification-outside-"));
    try {
      const runner = jest.fn();
      _setSandboxedVerificationRunner(runner);
      const result = await runCodexSandboxedVerification({
        cwd: outside,
        authoritativeRoot: root,
        codexBinaryPath: process.execPath,
        timeoutMs: 1_000,
        command: { command: "echo unsafe" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is outside");
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
