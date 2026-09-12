// Worktree initialization commands are trusted adapter policy, but the code
// they install is not trusted. Run each command inside a platform-specific
// process-tree boundary and do not return until descendants are gone.

import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_INVOCATION_ENV = "QUACK_WORKTREE_INIT_INVOCATION";
const WINDOWS_COMPLETION_PREFIX = "QUACK_WORKTREE_INIT_TREE_EMPTY:";
const CONTAINMENT_TIMEOUT_MS = 5_000;
const CONTAINMENT_POLL_MS = 25;
const CAPTURED_SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT;

const WINDOWS_TREE_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class QuackWorktreeInitJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
    uint informationLength,
    IntPtr returnLength);

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [IntPtr]::Zero
$process = $null
try {
  $encoded = $env:QUACK_WORKTREE_INIT_INVOCATION
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    throw "missing contained worktree-init invocation"
  }
  Remove-Item Env:QUACK_WORKTREE_INIT_INVOCATION -ErrorAction SilentlyContinue
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $invocation = $json | ConvertFrom-Json
  Add-Type -TypeDefinition $nativeSource
  $job = [QuackWorktreeInitJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) {
    throw "CreateJobObject failed"
  }
  $info = New-Object QuackWorktreeInitJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $info.BasicLimitInformation.LimitFlags = 0x2000
  $size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
    if (-not [QuackWorktreeInitJob]::SetInformationJobObject($job, 9, $buffer, $size)) {
      throw "SetInformationJobObject failed"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $process = Start-Process -FilePath ([string]$invocation.shellPath) -ArgumentList ([string]$invocation.argumentLine) -WorkingDirectory ([string]$invocation.cwd) -NoNewWindow -PassThru
  if (-not [QuackWorktreeInitJob]::AssignProcessToJobObject($job, $process.Handle)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "AssignProcessToJobObject failed"
  }
  New-Item -ItemType File -Path ([string]$invocation.startSignalPath) -Force | Out-Null
  $process.WaitForExit()
  $process.Refresh()
  $exitCode = [int]$process.ExitCode
  if (-not [QuackWorktreeInitJob]::TerminateJobObject($job, 0)) {
    throw "TerminateJobObject failed"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $accounting = New-Object QuackWorktreeInitJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
    if (-not [QuackWorktreeInitJob]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) {
      throw "QueryInformationJobObject failed"
    }
    if ($accounting.ActiveProcesses -eq 0) { break }
    Start-Sleep -Milliseconds 10
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($accounting.ActiveProcesses -ne 0) {
    throw "Windows job still has live descendants after termination"
  }
  [QuackWorktreeInitJob]::CloseHandle($job) | Out-Null
  $job = [IntPtr]::Zero
  [Console]::Error.WriteLine("QUACK_WORKTREE_INIT_TREE_EMPTY:" + $invocation.completionNonce)
  [Console]::Error.Flush()
  exit $exitCode
} catch {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  [Console]::Error.WriteLine("QUACK_WORKTREE_INIT_WRAPPER_ERROR: " + $_.Exception.Message)
  [Console]::Error.Flush()
  exit 125
} finally {
  if ($job -ne [IntPtr]::Zero) {
    [QuackWorktreeInitJob]::CloseHandle($job) | Out-Null
  }
}
`.trim();

export interface ContainedWorktreeInitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** False means Quack could not prove the process tree is empty. */
  descendantsContained: boolean;
}

export interface ContainedWorktreeInitInput {
  /** Legacy/trusted adapter shell string. Mutually exclusive with executable. */
  command?: string;
  /** Structured executable used for internally generated dependency installs. */
  executable?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  platform?: NodeJS.Platform;
}

interface SpawnPlan {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    detached: boolean;
    windowsHide: boolean;
    stdio: ["pipe", "pipe", "pipe"];
  };
  windowsCompletionMarker?: string;
  windowsTaskkillPath?: string;
  cleanupRoot?: string;
  containmentKind: "windows_job" | "linux_pid_namespace";
}

interface WindowsInvocation {
  shellPath: string;
  argumentLine: string;
  cwd: string;
  completionNonce: string;
  startSignalPath: string;
}

function quoteWindowsArgument(argument: string, alwaysQuote: boolean = false): string {
  if (!alwaysQuote && argument.length > 0 && !/[\s"]/.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

/** Quote one argv token as batch source, including batch-only `%` escaping. */
function quoteWindowsBatchArgument(argument: string): string {
  return quoteWindowsArgument(argument.replace(/%/g, "%%"), true);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function trustedWindowsExecutables(cwd: string): Promise<{
  powershellPath: string;
  shellPath: string;
  taskkillPath: string;
}> {
  if (!CAPTURED_SYSTEM_ROOT || !path.win32.isAbsolute(CAPTURED_SYSTEM_ROOT)) {
    throw new Error("SystemRoot is unavailable; cannot select trusted PowerShell");
  }
  const configuredShell = path.join(CAPTURED_SYSTEM_ROOT, "System32", "cmd.exe");
  const [canonicalCwd, powershellPath, shellPath, taskkillPath] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(
      path.join(CAPTURED_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ),
    fs.realpath(configuredShell),
    fs.realpath(path.join(CAPTURED_SYSTEM_ROOT, "System32", "taskkill.exe")),
  ]);
  if (
    [powershellPath, shellPath, taskkillPath].some((candidate) =>
      isPathInside(canonicalCwd, candidate),
    )
  ) {
    throw new Error("Trusted Windows process helper resolves inside the mutable worktree");
  }
  return { powershellPath, shellPath, taskkillPath };
}

async function buildSpawnPlan(input: ContainedWorktreeInitInput): Promise<SpawnPlan> {
  const platform = input.platform ?? process.platform;
  const structured = input.executable !== undefined;
  if (structured && input.command !== undefined) {
    throw new Error("contained command cannot specify both command and executable");
  }
  if (!structured && !input.command) {
    throw new Error("contained command requires command or executable");
  }
  if (platform !== "win32") {
    const executable = input.executable ?? "/bin/sh";
    const args = input.executable ? (input.args ?? []) : ["-c", input.command!];
    if (platform === "linux") {
      const unsharePath = "/usr/bin/unshare";
      await fs.access(unsharePath, fsConstants.X_OK);
      return {
        command: unsharePath,
        args: [
          "--user",
          "--map-current-user",
          "--pid",
          "--fork",
          "--kill-child=SIGKILL",
          "--mount-proc",
          "--",
          executable,
          ...args,
        ],
        options: {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
        containmentKind: "linux_pid_namespace",
      };
    }
    throw new Error(
      `Contained worktree-init requires Windows Job Objects or Linux PID namespaces; ${platform} is unsupported`,
    );
  }

  const { powershellPath, shellPath, taskkillPath } = await trustedWindowsExecutables(input.cwd);
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-init-command-"));
  const scriptPath = path.join(cleanupRoot, "command.cmd");
  const startSignalPath = path.join(cleanupRoot, "assigned.signal");
  const scriptCommand = input.executable
    ? [input.executable, ...(input.args ?? [])].map(quoteWindowsBatchArgument).join(" ")
    : input.command!;
  try {
    await fs.writeFile(
      scriptPath,
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n:quack_wait_for_job\r\nif not exist ${quoteWindowsBatchArgument(startSignalPath)} goto quack_wait_for_job\r\n${scriptCommand}\r\n`,
      "utf8",
    );
  } catch (error: unknown) {
    await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const completionNonce = randomUUID();
  const invocation: WindowsInvocation = {
    shellPath,
    argumentLine: ["/d", "/v:off", "/s", "/c", scriptPath]
      .map((argument) => quoteWindowsArgument(argument))
      .join(" "),
    cwd: input.cwd,
    completionNonce,
    startSignalPath,
  };
  const env = {
    ...input.env,
    [WINDOWS_INVOCATION_ENV]: Buffer.from(JSON.stringify(invocation), "utf8").toString("base64"),
  };

  return {
    command: powershellPath,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_TREE_WRAPPER, "utf16le").toString("base64"),
    ],
    options: {
      cwd: input.cwd,
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
    windowsCompletionMarker: `${WINDOWS_COMPLETION_PREFIX}${completionNonce}`,
    windowsTaskkillPath: taskkillPath,
    cleanupRoot,
    containmentKind: "windows_job",
  };
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ESRCH"
  );
}

function runTaskkill(taskkillPath: string, pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      taskkillPath,
      ["/PID", String(pid), "/T", "/F"],
      {
        cwd: path.dirname(taskkillPath),
        env: {
          ...(CAPTURED_SYSTEM_ROOT
            ? { SystemRoot: CAPTURED_SYSTEM_ROOT, WINDIR: CAPTURED_SYSTEM_ROOT }
            : {}),
        },
        windowsHide: true,
      },
      (error) => {
        if (error) reject(new Error(error.message));
        else resolve();
      },
    );
  });
}

async function terminatePosixProcessGroup(pid: number): Promise<void> {
  const groupId = -pid;
  try {
    process.kill(groupId, "SIGKILL");
  } catch (error: unknown) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }

  const deadline = Date.now() + CONTAINMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(groupId, 0);
    } catch (error: unknown) {
      if (isNoSuchProcess(error)) return;
      throw error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CONTAINMENT_POLL_MS);
    });
  }
  throw new Error(`process group ${pid} still has live descendants after SIGKILL`);
}

async function terminateTree(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  windowsTaskkillPath?: string,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    if (!windowsTaskkillPath) throw new Error("Trusted taskkill path is unavailable");
    await runTaskkill(windowsTaskkillPath, pid);
    return;
  }
  await terminatePosixProcessGroup(pid);
}

async function containNormalPosixExit(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error: unknown) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
  await terminatePosixProcessGroup(pid);
  return true;
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxBytes: number,
): { value: string; overflow: boolean } {
  const combined = current + chunk.toString();
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { value: combined, overflow: false };
  }
  return {
    value: Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8"),
    overflow: true,
  };
}

/**
 * Execute a shell command in an owned process tree. On Windows a PowerShell
 * `Start-Process -Wait` wrapper supplies positive completion evidence for the
 * full tree; timeout uses synchronous-to-completion `taskkill /T /F`. Linux
 * uses a PID namespace whose init death kills even setsid/double-fork escapes.
 * Other POSIX hosts fail closed because process groups alone do not contain
 * `setsid` or double-fork escapes.
 */
export async function runContainedWorktreeInitCommand(
  input: ContainedWorktreeInitInput,
): Promise<ContainedWorktreeInitResult> {
  const platform = input.platform ?? process.platform;
  let plan: SpawnPlan;
  try {
    plan = await buildSpawnPlan(input);
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unable to prepare contained command: ${
        error instanceof Error ? error.message : String(error)
      }`,
      timedOut: false,
      descendantsContained: true,
    };
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (error: unknown) {
      void (plan.cleanupRoot
        ? fs.rm(plan.cleanupRoot, { recursive: true, force: true })
        : Promise.resolve());
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: `Unable to spawn contained command: ${
          error instanceof Error ? error.message : String(error)
        }`,
        timedOut: false,
        descendantsContained: true,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let spawnError: string | undefined;
    let terminationPromise: Promise<void> | undefined;
    let terminationError: string | undefined;

    const requestTermination = (): void => {
      if (terminationPromise) return;
      terminationPromise = terminateTree(child, platform, plan.windowsTaskkillPath).catch(
        (error: unknown) => {
          terminationError = error instanceof Error ? error.message : String(error);
        },
      );
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stdout, chunk, input.maxBufferBytes);
      stdout = next.value;
      if (next.overflow && !overflow) {
        overflow = true;
        requestTermination();
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stderr, chunk, input.maxBufferBytes);
      stderr = next.value;
      if (next.overflow && !overflow) {
        overflow = true;
        requestTermination();
      }
    });
    child.once("error", (error: Error) => {
      spawnError = error.message;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, input.timeoutMs);
    timer.unref();

    child.once("close", (code: number | null) => {
      clearTimeout(timer);
      void (async () => {
        if (terminationPromise) await terminationPromise;

        let backgroundDescendants = false;
        if (!terminationPromise && platform !== "win32" && child.pid) {
          try {
            backgroundDescendants = await containNormalPosixExit(child.pid);
          } catch (error: unknown) {
            terminationError = error instanceof Error ? error.message : String(error);
          }
        }

        const completionObserved =
          platform !== "win32" ||
          (!!plan.windowsCompletionMarker && stderr.includes(plan.windowsCompletionMarker));
        if (plan.windowsCompletionMarker) {
          stderr = stderr.replace(plan.windowsCompletionMarker, "").trim();
        }

        if (plan.cleanupRoot) {
          await fs.rm(plan.cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
        }

        const descendantsContained =
          terminationError === undefined && (timedOut || overflow || completionObserved);
        const failures = [
          spawnError ? `Unable to run command: ${spawnError}` : undefined,
          timedOut ? `Command timed out after ${input.timeoutMs}ms` : undefined,
          overflow ? `Command output exceeded ${input.maxBufferBytes} bytes` : undefined,
          backgroundDescendants
            ? "Command left background descendants; Quack terminated them"
            : undefined,
          !completionObserved && platform === "win32" && !timedOut && !overflow
            ? "Windows process-tree wrapper did not prove that all descendants exited"
            : undefined,
          terminationError ? `Process-tree containment failed: ${terminationError}` : undefined,
        ].filter((message): message is string => !!message);
        if (failures.length > 0) {
          stderr = [stderr, ...failures].filter(Boolean).join("\n");
        }

        resolve({
          exitCode: failures.length > 0 ? 1 : (code ?? 1),
          stdout,
          stderr,
          timedOut,
          descendantsContained,
        });
      })();
    });
  });
}
