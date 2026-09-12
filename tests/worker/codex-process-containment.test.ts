import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LINUX_UNSHARE_BINARY,
  buildContainedCodexSpawn,
  verifyCodexDescendantsContained,
} from "../../src/worker/codex-process-containment";

const LINUX_NAMESPACE_ARGS = [
  "--user",
  "--map-current-user",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
  "--mount-proc",
] as const;

function linuxNamespaceAvailable(): boolean {
  if (process.platform !== "linux" || !existsSync("/usr/bin/setsid")) return false;
  const probe = spawnSync(LINUX_UNSHARE_BINARY, [...LINUX_NAMESPACE_ARGS, "--", "/bin/true"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0;
}

describe("Codex process containment", () => {
  test("launches Linux Codex inside a host-owned PID namespace", () => {
    const env = { PATH: "/usr/bin" };
    const plan = buildContainedCodexSpawn({
      binaryPath: "/opt/codex/bin/codex",
      args: ["exec", "--json", "-"],
      cwd: "/work/task",
      env,
      platform: "linux",
    });

    expect(plan).toEqual({
      command: LINUX_UNSHARE_BINARY,
      args: [...LINUX_NAMESPACE_ARGS, "--", "/opt/codex/bin/codex", "exec", "--json", "-"],
      options: {
        cwd: "/work/task",
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      },
      linuxPidNamespace: true,
    });
  });

  test("fails closed on POSIX platforms without a durable boundary", () => {
    expect(() =>
      buildContainedCodexSpawn({
        binaryPath: "/usr/bin/codex",
        args: ["exec", "-"],
        cwd: "/work/task",
        env: {},
        platform: "darwin",
      }),
    ).toThrow("containment is unavailable on darwin");
  });

  test("accepts only an uninterrupted Linux PID-namespace wrapper exit", async () => {
    await expect(
      verifyCodexDescendantsContained({
        pid: 8123,
        platform: "linux",
        interrupted: false,
        linuxPidNamespace: true,
        windowsCompletionObserved: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyCodexDescendantsContained({
        pid: 8123,
        platform: "linux",
        interrupted: true,
        linuxPidNamespace: true,
        windowsCompletionObserved: false,
      }),
    ).rejects.toThrow("did not prove");
    await expect(
      verifyCodexDescendantsContained({
        pid: 8123,
        platform: "linux",
        interrupted: false,
        linuxPidNamespace: false,
        windowsCompletionObserved: false,
      }),
    ).rejects.toThrow("did not prove");
  });

  test("requires an uninterrupted, nonce-bound Windows completion marker", async () => {
    await expect(
      verifyCodexDescendantsContained({
        pid: 8125,
        platform: "win32",
        interrupted: false,
        linuxPidNamespace: false,
        windowsCompletionObserved: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyCodexDescendantsContained({
        pid: 8125,
        platform: "win32",
        interrupted: false,
        linuxPidNamespace: false,
        windowsCompletionObserved: false,
      }),
    ).rejects.toThrow("did not prove");
    await expect(
      verifyCodexDescendantsContained({
        pid: 8125,
        platform: "win32",
        interrupted: true,
        linuxPidNamespace: false,
        windowsCompletionObserved: true,
      }),
    ).rejects.toThrow("did not prove");
  });

  test("encodes a Windows Job Object wrapper without mutating the source env", () => {
    const env = {
      PATH: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
    };
    const plan = buildContainedCodexSpawn({
      binaryPath: "C:\\Program Files\\Codex\\codex.exe",
      args: ["exec", "--cd", "C:\\work tree", 'quote"inside', "trailing\\"],
      cwd: process.cwd(),
      env,
      platform: "win32",
      nonce: "test-nonce",
    });
    const invocation = JSON.parse(
      Buffer.from(plan.options.env.QUACK_CODEX_WINDOWS_INVOCATION!, "base64").toString("utf8"),
    ) as {
      binaryPath: string;
      argumentLine: string;
      childPowerShellPath: string;
      childArgumentLine: string;
      cwd: string;
      completionNonce: string;
      startSignalPath: string;
      promptPath: string;
    };
    const wrapper = Buffer.from(plan.args.at(-1)!, "base64").toString("utf16le");

    expect(path.win32.isAbsolute(plan.command)).toBe(true);
    expect(plan.command.toLowerCase()).toContain(
      "\\system32\\windowspowershell\\v1.0\\powershell.exe",
    );
    expect(plan.options.detached).toBe(false);
    expect(plan.windowsCompletionMarker).toBe("QUACK_CODEX_WINDOWS_TREE_EMPTY:test-nonce");
    expect(invocation.binaryPath).toBe("C:\\Program Files\\Codex\\codex.exe");
    expect(invocation.argumentLine).toBe('exec --cd "C:\\work tree" "quote\\"inside" trailing\\');
    expect(path.win32.isAbsolute(invocation.childPowerShellPath)).toBe(true);
    expect(invocation.childArgumentLine).toContain("-EncodedCommand");
    expect(invocation.cwd).toBe(process.cwd());
    expect(invocation.completionNonce).toBe("test-nonce");
    expect(invocation.startSignalPath).toContain("quack-codex-start-test-nonce.signal");
    expect(invocation.promptPath).toContain("quack-codex-prompt-test-nonce.txt");
    expect(wrapper).toContain("Start-Process");
    expect(wrapper).toContain("CreateJobObject");
    expect(wrapper).toContain("LimitFlags = 0x2000");
    expect(wrapper).toContain("AssignProcessToJobObject");
    expect(wrapper).toContain("TerminateJobObject");
    expect(wrapper).toContain("QueryInformationJobObject");
    expect(wrapper).toContain("ActiveProcesses -eq 0");
    expect(wrapper).toContain("Remove-Item Env:QUACK_CODEX_WINDOWS_INVOCATION");
    expect(env).toEqual({
      PATH: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
    });
  });

  const linuxNamespaceTest = linuxNamespaceAvailable() ? test : test.skip;
  linuxNamespaceTest(
    "kills an env-scrubbing setsid descendant when namespace PID 1 exits",
    async () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "quack-pid-namespace-"));
      const survivalMarker = path.join(tempRoot, "escaped.txt");
      const escapedScript =
        `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(survivalMarker)},"escaped"),350);` +
        "setInterval(()=>{},1000);";
      const rootScript =
        'const {spawn}=require("node:child_process");' +
        `const child=spawn("/usr/bin/setsid",[process.execPath,"-e",${JSON.stringify(escapedScript)}],` +
        '{detached:true,stdio:"ignore",env:{PATH:process.env.PATH}});' +
        "child.unref();";
      const plan = buildContainedCodexSpawn({
        binaryPath: process.execPath,
        args: ["-e", rootScript],
        cwd: tempRoot,
        env: process.env,
        platform: "linux",
      });

      try {
        const child = spawn(plan.command, plan.args, plan.options);
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(existsSync(survivalMarker)).toBe(false);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    10_000,
  );

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest(
    "uses trusted PowerShell and kills a detached Windows descendant before completion",
    async () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "quack-powershell-shadow-"));
      const survivalMarker = path.join(tempRoot, "escaped.txt");
      const commandInterpreter = process.env.ComSpec;
      if (!commandInterpreter) {
        rmSync(tempRoot, { recursive: true, force: true });
        throw new Error("ComSpec is required for the Windows regression");
      }
      const localShadow = path.join(tempRoot, "powershell.exe");
      copyFileSync(commandInterpreter, localShadow);
      const descendantDelayMs = 550;
      const descendantScript =
        `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(survivalMarker)},"escaped"),${descendantDelayMs});` +
        "setInterval(()=>{},1000);";
      const script =
        'const {spawn}=require("node:child_process");' +
        'let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);' +
        'process.stdin.on("end",()=>{' +
        `const child=spawn(process.execPath,["-e",${JSON.stringify(descendantScript)}],` +
        '{detached:true,stdio:"ignore",env:{PATH:process.env.PATH}});' +
        'const names=["QUACK_CODEX_WINDOWS_INVOCATION","QUACK_CODEX_WINDOWS_START_SIGNAL",' +
        '"QUACK_CODEX_WINDOWS_BINARY","QUACK_CODEX_WINDOWS_ARGUMENT_LINE",' +
        '"QUACK_CODEX_WINDOWS_PROMPT_FILE"];' +
        "const leaked=names.filter(name=>process.env[name]!==undefined);" +
        'console.log((leaked.length===0?"clean-env":"payload-leaked:"+leaked.join(","))+":"+prompt);' +
        "child.unref();});";
      const plan = buildContainedCodexSpawn({
        binaryPath: process.execPath,
        args: ["-e", script],
        cwd: tempRoot,
        env: process.env,
        platform: "win32",
        nonce: "integration-nonce",
      });
      try {
        expect(path.isAbsolute(plan.command)).toBe(true);
        expect(path.normalize(plan.command)).not.toBe(path.normalize(localShadow));
        const child = spawn(plan.command, plan.args, plan.options);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.stdin.end("prompt-through-wrapper");

        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });

        expect(stderr).toContain(plan.windowsCompletionMarker!);
        expect(stdout).toContain("clean-env:prompt-through-wrapper");
        expect(stdout).not.toContain("payload-leaked");
        expect(code).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, descendantDelayMs + 350));
        expect(existsSync(survivalMarker)).toBe(false);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
