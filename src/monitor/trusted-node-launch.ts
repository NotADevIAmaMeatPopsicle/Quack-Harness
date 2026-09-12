// Monitor-owned Node subprocesses run project code from mutable worktrees.
// Resolve Node before entering that cwd, and on Windows place the complete
// process tree in a non-breakaway Job Object that can be synchronously stopped
// and queried for zero active processes.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveTrustedExecutable } from "../worker/trusted-executable.js";

const WINDOWS_INVOCATION_ENV = "QUACK_MONITOR_WINDOWS_INVOCATION";
const WINDOWS_STOP_JOB_ENV = "QUACK_MONITOR_WINDOWS_STOP_JOB";
const WINDOWS_STOP_NONCE_ENV = "QUACK_MONITOR_WINDOWS_STOP_NONCE";
const WINDOWS_STOP_PROOF_PREFIX = "QUACK_MONITOR_WINDOWS_JOB_EMPTY:";
const WINDOWS_LAUNCH_STARTUP_TIMEOUT_MS = 30_000;

const WINDOWS_CHILD_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$signalPath = $env:QUACK_MONITOR_WINDOWS_START_SIGNAL
$nodePath = $env:QUACK_MONITOR_WINDOWS_NODE
$argumentLine = $env:QUACK_MONITOR_WINDOWS_ARGUMENT_LINE
$cwd = $env:QUACK_MONITOR_WINDOWS_CWD
$pidPath = $env:QUACK_MONITOR_WINDOWS_PID_FILE
$exitCodePath = $env:QUACK_MONITOR_WINDOWS_EXIT_CODE_FILE
Remove-Item Env:QUACK_MONITOR_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_CWD -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_PID_FILE -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_EXIT_CODE_FILE -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($signalPath) -or
    [string]::IsNullOrWhiteSpace($nodePath) -or
    [string]::IsNullOrWhiteSpace($cwd) -or
    [string]::IsNullOrWhiteSpace($pidPath) -or
    [string]::IsNullOrWhiteSpace($exitCodePath)) {
  throw "missing contained monitor child invocation"
}
while (-not (Test-Path -LiteralPath $signalPath -PathType Leaf)) {
  Start-Sleep -Milliseconds 10
}
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodePath
$startInfo.Arguments = $argumentLine
$startInfo.WorkingDirectory = $cwd
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw "contained Node process failed to start"
}
[IO.File]::WriteAllText($pidPath, [string]$process.Id)
$stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$stderrCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$process.WaitForExit()
$process.Refresh()
$nodeExitCode = [int]$process.ExitCode
[IO.File]::WriteAllText($exitCodePath, [string]$nodeExitCode)
$copyTasks = [Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy)
if (-not [Threading.Tasks.Task]::WaitAll($copyTasks, 1000)) {
  # A detached descendant can inherit the root process's stdout/stderr pipe.
  # Exit the intermediary once the actual Node root has exited so the outer
  # Job owner can terminate that descendant and prove the Job is empty.
  [Environment]::Exit($nodeExitCode)
}
exit $nodeExitCode
`.trim();

const WINDOWS_TREE_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class QuackMonitorJob {
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
    public long ThisPeriodKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
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
$startSignalPath = $null
$errorPath = $null
try {
  $encoded = $env:QUACK_MONITOR_WINDOWS_INVOCATION
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    throw "missing contained monitor invocation"
  }
  Remove-Item Env:QUACK_MONITOR_WINDOWS_INVOCATION -ErrorAction SilentlyContinue
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $invocation = $json | ConvertFrom-Json
  $startSignalPath = [string]$invocation.startSignalPath
  $errorPath = [string]$invocation.errorPath
  Add-Type -TypeDefinition $nativeSource
  $job = [QuackMonitorJob]::CreateJobObject([IntPtr]::Zero, [string]$invocation.jobName)
  if ($job -eq [IntPtr]::Zero) {
    throw "CreateJobObject failed"
  }
  $info = New-Object QuackMonitorJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  # KILL_ON_JOB_CLOSE only. Deliberately omit BREAKAWAY_OK and
  # SILENT_BREAKAWAY_OK so descendants cannot opt out of the boundary.
  $info.BasicLimitInformation.LimitFlags = 0x2000
  $size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
    if (-not [QuackMonitorJob]::SetInformationJobObject($job, 9, $buffer, $size)) {
      throw "SetInformationJobObject failed"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $env:QUACK_MONITOR_WINDOWS_START_SIGNAL = $startSignalPath
  $env:QUACK_MONITOR_WINDOWS_NODE = [string]$invocation.nodePath
  $env:QUACK_MONITOR_WINDOWS_ARGUMENT_LINE = [string]$invocation.argumentLine
  $env:QUACK_MONITOR_WINDOWS_CWD = [string]$invocation.cwd
  $env:QUACK_MONITOR_WINDOWS_PID_FILE = [string]$invocation.pidPath
  $env:QUACK_MONITOR_WINDOWS_EXIT_CODE_FILE = [string]$invocation.exitCodePath
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = [string]$invocation.childPowerShellPath
  $startInfo.Arguments = [string]$invocation.childArgumentLine
  $startInfo.WorkingDirectory = [string]$invocation.cwd
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "contained monitor wrapper failed to start"
  }
  $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderrCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  Remove-Item Env:QUACK_MONITOR_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_PID_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_EXIT_CODE_FILE -ErrorAction SilentlyContinue
  if (-not [QuackMonitorJob]::AssignProcessToJobObject($job, $process.Handle)) {
    $process.Kill()
    $process.WaitForExit()
    throw "AssignProcessToJobObject failed"
  }
  [IO.File]::WriteAllText($startSignalPath, "assigned")
  $process.WaitForExit()
  $process.Refresh()
  if (Test-Path -LiteralPath ([string]$invocation.exitCodePath) -PathType Leaf) {
    $exitCode = [int][IO.File]::ReadAllText([string]$invocation.exitCodePath)
  } elseif (Test-Path -LiteralPath ([string]$invocation.externalStopPath) -PathType Leaf) {
    $exitCode = 1
  } else {
    throw "contained Node exit code was not recorded"
  }
  if (-not [QuackMonitorJob]::TerminateJobObject($job, 1)) {
    throw "TerminateJobObject failed"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $accounting = New-Object QuackMonitorJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
    if (-not [QuackMonitorJob]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) {
      throw "QueryInformationJobObject failed"
    }
    if ($accounting.ActiveProcesses -eq 0) { break }
    Start-Sleep -Milliseconds 10
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($accounting.ActiveProcesses -ne 0) {
    throw "monitor job still has live descendants after termination"
  }
  [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy))
  [QuackMonitorJob]::CloseHandle($job) | Out-Null
  $job = [IntPtr]::Zero
  exit $exitCode
} catch {
  if (-not [string]::IsNullOrWhiteSpace($errorPath)) {
    [IO.File]::WriteAllText($errorPath, $_.Exception.Message)
  }
  if ($job -ne [IntPtr]::Zero) {
    [QuackMonitorJob]::TerminateJobObject($job, 125) | Out-Null
  } elseif ($null -ne $process -and -not $process.HasExited) {
    $process.Kill()
    $process.WaitForExit()
  }
  [Console]::Error.WriteLine("QUACK_MONITOR_WINDOWS_WRAPPER_ERROR: " + $_.Exception.Message)
  [Console]::Error.Flush()
  exit 125
} finally {
  Remove-Item Env:QUACK_MONITOR_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_PID_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_MONITOR_WINDOWS_EXIT_CODE_FILE -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($startSignalPath)) {
    Remove-Item -LiteralPath $startSignalPath -Force -ErrorAction SilentlyContinue
  }
  if ($job -ne [IntPtr]::Zero) {
    [QuackMonitorJob]::CloseHandle($job) | Out-Null
  }
}
`.trim();

const WINDOWS_STOP_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class QuackMonitorJobStop {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string name);

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
$jobName = $env:QUACK_MONITOR_WINDOWS_STOP_JOB
$nonce = $env:QUACK_MONITOR_WINDOWS_STOP_NONCE
Remove-Item Env:QUACK_MONITOR_WINDOWS_STOP_JOB -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_MONITOR_WINDOWS_STOP_NONCE -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($jobName) -or [string]::IsNullOrWhiteSpace($nonce)) {
  throw "missing monitor job stop identity"
}
Add-Type -TypeDefinition $nativeSource
$job = [QuackMonitorJobStop]::OpenJobObject(0x000C, $false, $jobName)
if ($job -eq [IntPtr]::Zero) {
  throw "OpenJobObject failed"
}
try {
  if (-not [QuackMonitorJobStop]::TerminateJobObject($job, 1)) {
    throw "TerminateJobObject failed"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $accounting = New-Object QuackMonitorJobStop+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
    if (-not [QuackMonitorJobStop]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) {
      throw "QueryInformationJobObject failed"
    }
    if ($accounting.ActiveProcesses -eq 0) { break }
    Start-Sleep -Milliseconds 10
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($accounting.ActiveProcesses -ne 0) {
    throw "monitor job still has live descendants after termination"
  }
  [Console]::Out.WriteLine("QUACK_MONITOR_WINDOWS_JOB_EMPTY:" + $nonce)
  [Console]::Out.Flush()
} finally {
  [QuackMonitorJobStop]::CloseHandle($job) | Out-Null
}
`.trim();

interface WindowsInvocationPayload {
  nodePath: string;
  argumentLine: string;
  childPowerShellPath: string;
  childArgumentLine: string;
  cwd: string;
  jobName: string;
  startSignalPath: string;
  pidPath: string;
  exitCodePath: string;
  errorPath: string;
  externalStopPath: string;
}

export interface WindowsNodeJobHandle {
  jobName: string;
  projectRoot: string;
  tempRoot: string;
}

export interface TrustedNodeLaunch {
  child: ChildProcess;
  executablePath: string;
  /** PID of the actual Node CLI, not the PowerShell job-owner wrapper. */
  processId: number;
  windowsJob?: WindowsNodeJobHandle;
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) return argument;
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

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const actualName = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return actualName ? environment[actualName] : undefined;
}

function trustedPowerShell(projectRoot: string, environment: NodeJS.ProcessEnv): string {
  const systemRoot =
    environmentValue(environment, "SYSTEMROOT") ?? environmentValue(environment, "WINDIR");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows monitor containment requires an absolute SystemRoot");
  }
  return resolveTrustedExecutable(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    projectRoot,
    "Windows PowerShell",
    environment,
  );
}

function stopEnvironment(
  powershellPath: string,
  source: NodeJS.ProcessEnv,
  jobName: string,
  nonce: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: path.dirname(powershellPath),
    [WINDOWS_STOP_JOB_ENV]: jobName,
    [WINDOWS_STOP_NONCE_ENV]: nonce,
  };
  for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] as const) {
    const value = environmentValue(source, name);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function waitForWindowsPayloadPid(pidPath: string, errorPath: string, timeoutMs: number): number {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(errorPath)) {
      const detail = fs.readFileSync(errorPath, "utf8").trim();
      throw new Error(`Contained Node launch failed: ${detail || "wrapper error"}`);
    }
    if (fs.existsSync(pidPath)) {
      const processId = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isSafeInteger(processId) && processId > 0) return processId;
      throw new Error("Contained Node launch returned an invalid process id");
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
  throw new Error("Timed out waiting for the contained Node process to start");
}

/** Launch the monitor's Node CLI without cwd/PATH executable resolution. */
export function spawnTrustedNode(input: {
  projectRoot: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Test seam; still receives only the resolved Node executable and canonical launch inputs. */
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
}): TrustedNodeLaunch {
  const canonicalProjectRoot = fs.realpathSync.native(path.resolve(input.projectRoot));
  const canonicalCwd = fs.realpathSync.native(path.resolve(input.cwd));
  const nodePath = resolveTrustedExecutable(
    process.execPath,
    canonicalProjectRoot,
    "Node.js",
    input.env,
  );
  const scriptPath = path.isAbsolute(input.scriptPath)
    ? path.resolve(input.scriptPath)
    : path.resolve(canonicalCwd, input.scriptPath);
  const nodeArgs = [scriptPath, ...input.args];

  // Tests inject a process handle so shutdown/recovery can be exercised
  // without launching an unowned real child. Keep that seam inside this
  // boundary: callers cannot choose the executable or mutable cwd, and the
  // child still receives the same trusted path, canonical cwd, args, and env.
  if (input.spawnProcess) {
    const child = input.spawnProcess(nodePath, nodeArgs, {
      cwd: canonicalCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: (input.platform ?? process.platform) !== "win32",
      env: input.env,
    });
    return { child, executablePath: nodePath, processId: child.pid ?? 0 };
  }

  if (process.platform !== "win32") {
    const child = spawn(nodePath, nodeArgs, {
      cwd: canonicalCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
      env: input.env,
    });
    return { child, executablePath: nodePath, processId: child.pid ?? 0 };
  }

  const powershellPath = trustedPowerShell(canonicalProjectRoot, input.env);
  const nonce = randomUUID().replace(/-/g, "");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-monitor-job-"));
  const startSignalPath = path.join(tempRoot, "assigned.signal");
  const pidPath = path.join(tempRoot, "node.pid");
  const exitCodePath = path.join(tempRoot, "node.exit");
  const errorPath = path.join(tempRoot, "wrapper.error");
  const externalStopPath = path.join(tempRoot, "external-stop.signal");
  const jobName = `QuackMonitor_${nonce}`;
  const childArgumentLine = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_CHILD_WRAPPER, "utf16le").toString("base64"),
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  const payload: WindowsInvocationPayload = {
    nodePath,
    argumentLine: nodeArgs.map(quoteWindowsArgument).join(" "),
    childPowerShellPath: powershellPath,
    childArgumentLine,
    cwd: canonicalCwd,
    jobName,
    startSignalPath,
    pidPath,
    exitCodePath,
    errorPath,
    externalStopPath,
  };
  const child = spawn(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_TREE_WRAPPER, "utf16le").toString("base64"),
    ],
    {
      cwd: path.dirname(powershellPath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
      env: {
        ...input.env,
        [WINDOWS_INVOCATION_ENV]: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      },
    },
  );

  try {
    const processId = waitForWindowsPayloadPid(
      pidPath,
      errorPath,
      WINDOWS_LAUNCH_STARTUP_TIMEOUT_MS,
    );
    fs.rmSync(pidPath, { force: true });
    return {
      child,
      executablePath: nodePath,
      processId,
      windowsJob: { jobName, projectRoot: canonicalProjectRoot, tempRoot },
    };
  } catch (error: unknown) {
    const stopped = terminateWindowsNodeJob(
      { jobName, projectRoot: canonicalProjectRoot, tempRoot },
      input.env,
    );
    if (!stopped.confirmed) child.kill("SIGKILL");
    const cleanup = (): void => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // The failed launch is already stopped; leave best-effort temp cleanup to the OS.
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) cleanup();
    else child.once("close", cleanup);
    throw error;
  }
}

/**
 * Terminate a Windows monitor Job Object and prove it contains zero active
 * processes before returning success. No PATH or mutable-cwd lookup occurs.
 */
export function terminateWindowsNodeJob(
  handle: WindowsNodeJobHandle,
  environment: NodeJS.ProcessEnv = process.env,
): { confirmed: boolean; warning?: string } {
  if (process.platform !== "win32") {
    return { confirmed: false, warning: "Windows Job Object termination is unavailable" };
  }
  try {
    fs.writeFileSync(path.join(handle.tempRoot, "external-stop.signal"), "requested", "utf8");
    const powershellPath = trustedPowerShell(handle.projectRoot, environment);
    const nonce = randomUUID().replace(/-/g, "");
    const output = execFileSync(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_STOP_WRAPPER, "utf16le").toString("base64"),
      ],
      {
        cwd: path.dirname(powershellPath),
        env: stopEnvironment(powershellPath, environment, handle.jobName, nonce),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 15_000,
      },
    );
    if (!output.includes(`${WINDOWS_STOP_PROOF_PREFIX}${nonce}`)) {
      return {
        confirmed: false,
        warning: "Windows Job Object stop returned without active-zero proof",
      };
    }
    return { confirmed: true };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      confirmed: false,
      warning: `Windows Job Object termination is unconfirmed (${detail})`,
    };
  }
}

function processIsAbsent(processId: number | undefined): boolean {
  if (!processId || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return code !== "EPERM";
  }
}

/**
 * A short-lived Node program can complete between admission and an operator
 * stop. In that race the named Job Object has already been destroyed, so
 * OpenJobObject correctly fails. Treat that as safe only when the trusted
 * wrapper's regular exit marker exists and both recorded processes are absent.
 * Closing the sole Job handle applies KILL_ON_JOB_CLOSE to any descendants.
 */
export function confirmWindowsNodeLaunchAlreadyExited(launch: TrustedNodeLaunch): boolean {
  if (process.platform !== "win32" || !launch.windowsJob) return false;
  try {
    const canonicalTempRoot = fs.realpathSync.native(launch.windowsJob.tempRoot);
    const exitCodePath = path.join(canonicalTempRoot, "node.exit");
    const metadata = fs.lstatSync(exitCodePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return false;
    const canonicalExitCodePath = fs.realpathSync.native(exitCodePath);
    const relative = path.relative(canonicalTempRoot, canonicalExitCodePath);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    const recordedExitCode = fs.readFileSync(canonicalExitCodePath, "utf8").trim();
    if (!/^-?\d+$/u.test(recordedExitCode)) return false;
    return processIsAbsent(launch.child.pid) && processIsAbsent(launch.processId);
  } catch {
    return false;
  }
}

export function cleanupTrustedNodeLaunch(launch: TrustedNodeLaunch): void {
  if (!launch.windowsJob) return;
  fs.rmSync(launch.windowsJob.tempRoot, { recursive: true, force: true });
}
