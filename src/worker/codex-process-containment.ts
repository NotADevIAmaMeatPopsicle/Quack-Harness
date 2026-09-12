// Codex can start background processes that outlive the CLI process itself.
// Denied-path restoration must not begin until that complete process tree is
// either gone or has been terminated and verified absent.

import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS_INVOCATION_ENV = "QUACK_CODEX_WINDOWS_INVOCATION";
const WINDOWS_COMPLETION_PREFIX = "QUACK_CODEX_WINDOWS_TREE_EMPTY:";
export const LINUX_UNSHARE_BINARY = "/usr/bin/unshare";

const WINDOWS_CHILD_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$signalPath = $env:QUACK_CODEX_WINDOWS_START_SIGNAL
$binaryPath = $env:QUACK_CODEX_WINDOWS_BINARY
$argumentLine = $env:QUACK_CODEX_WINDOWS_ARGUMENT_LINE
$promptPath = $env:QUACK_CODEX_WINDOWS_PROMPT_FILE
Remove-Item Env:QUACK_CODEX_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_CODEX_WINDOWS_BINARY -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_CODEX_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
Remove-Item Env:QUACK_CODEX_WINDOWS_PROMPT_FILE -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($signalPath) -or
    [string]::IsNullOrWhiteSpace($binaryPath) -or
    [string]::IsNullOrWhiteSpace($argumentLine) -or
    [string]::IsNullOrWhiteSpace($promptPath)) {
  throw "missing contained Codex child invocation"
}
while (-not (Test-Path -LiteralPath $signalPath -PathType Leaf)) {
  Start-Sleep -Milliseconds 10
}
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $binaryPath
$startInfo.Arguments = $argumentLine
$startInfo.WorkingDirectory = (Get-Location).Path
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw "contained Codex process failed to start"
}
$promptStream = [IO.File]::OpenRead($promptPath)
try {
  $promptStream.CopyTo($process.StandardInput.BaseStream)
  $process.StandardInput.Close()
} finally {
  $promptStream.Dispose()
}
$process.WaitForExit()
$process.Refresh()
exit [int]$process.ExitCode
`.trim();

const WINDOWS_TREE_WRAPPER = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class QuackCodexJob {
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
$startSignalPath = $null
$promptPath = $null
try {
  $encoded = $env:QUACK_CODEX_WINDOWS_INVOCATION
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    throw "missing contained Codex invocation"
  }
  Remove-Item Env:QUACK_CODEX_WINDOWS_INVOCATION -ErrorAction SilentlyContinue
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $invocation = $json | ConvertFrom-Json
  $startSignalPath = [string]$invocation.startSignalPath
  $promptPath = [string]$invocation.promptPath
  Remove-Item -LiteralPath $startSignalPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
  $promptStream = [IO.File]::Create($promptPath)
  try {
    [Console]::OpenStandardInput().CopyTo($promptStream)
    $promptStream.Flush()
  } finally {
    $promptStream.Dispose()
  }
  Add-Type -TypeDefinition $nativeSource
  $job = [QuackCodexJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) {
    throw "CreateJobObject failed"
  }
  $info = New-Object QuackCodexJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $info.BasicLimitInformation.LimitFlags = 0x2000
  $size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
    if (-not [QuackCodexJob]::SetInformationJobObject($job, 9, $buffer, $size)) {
      throw "SetInformationJobObject failed"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $env:QUACK_CODEX_WINDOWS_START_SIGNAL = $startSignalPath
  $env:QUACK_CODEX_WINDOWS_BINARY = [string]$invocation.binaryPath
  $env:QUACK_CODEX_WINDOWS_ARGUMENT_LINE = [string]$invocation.argumentLine
  $env:QUACK_CODEX_WINDOWS_PROMPT_FILE = $promptPath
  $process = Start-Process \`
    -FilePath ([string]$invocation.childPowerShellPath) \`
    -ArgumentList ([string]$invocation.childArgumentLine) \`
    -WorkingDirectory ([string]$invocation.cwd) \`
    -NoNewWindow \`
    -PassThru
  Remove-Item Env:QUACK_CODEX_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_BINARY -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_PROMPT_FILE -ErrorAction SilentlyContinue
  if (-not [QuackCodexJob]::AssignProcessToJobObject($job, $process.Handle)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "AssignProcessToJobObject failed"
  }
  [IO.File]::WriteAllText($startSignalPath, "assigned")
  $process.WaitForExit()
  $process.Refresh()
  $exitCode = [int]$process.ExitCode
  if (-not [QuackCodexJob]::TerminateJobObject($job, 0)) {
    throw "TerminateJobObject failed"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $accounting = New-Object QuackCodexJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
    if (-not [QuackCodexJob]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) {
      throw "QueryInformationJobObject failed"
    }
    if ($accounting.ActiveProcesses -eq 0) { break }
    Start-Sleep -Milliseconds 10
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($accounting.ActiveProcesses -ne 0) {
    throw "Windows Codex job still has live descendants after termination"
  }
  [QuackCodexJob]::CloseHandle($job) | Out-Null
  $job = [IntPtr]::Zero
  [Console]::Error.WriteLine("QUACK_CODEX_WINDOWS_TREE_EMPTY:" + $invocation.completionNonce)
  [Console]::Error.Flush()
  exit $exitCode
} catch {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  [Console]::Error.WriteLine("QUACK_CODEX_WINDOWS_WRAPPER_ERROR: " + $_.Exception.Message)
  [Console]::Error.Flush()
  exit 125
} finally {
  Remove-Item Env:QUACK_CODEX_WINDOWS_START_SIGNAL -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_BINARY -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_ARGUMENT_LINE -ErrorAction SilentlyContinue
  Remove-Item Env:QUACK_CODEX_WINDOWS_PROMPT_FILE -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($startSignalPath)) {
    Remove-Item -LiteralPath $startSignalPath -Force -ErrorAction SilentlyContinue
  }
  if (-not [string]::IsNullOrWhiteSpace($promptPath)) {
    Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
  }
  if ($job -ne [IntPtr]::Zero) {
    [QuackCodexJob]::CloseHandle($job) | Out-Null
  }
}
`.trim();

export interface ContainedCodexSpawnPlan {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
    detached: boolean;
  };
  /**
   * Linux launches use a new user/PID/mount namespace. The trusted `unshare`
   * parent exits only after namespace PID 1 exits; Linux then synchronously
   * kills every remaining process in that PID namespace, including processes
   * that double-fork, call `setsid`, or scrub their environment.
   */
  linuxPidNamespace?: boolean;
  /**
   * Emitted only after a non-breakaway Windows Job Object has been terminated
   * and reports zero active processes. The nonce prevents child stderr from
   * spoofing the evidence marker.
   */
  windowsCompletionMarker?: string;
}

export interface CodexContainmentEvidence {
  pid: number;
  platform: NodeJS.Platform;
  interrupted: boolean;
  linuxPidNamespace: boolean;
  windowsCompletionObserved: boolean;
}

interface WindowsInvocationPayload {
  binaryPath: string;
  argumentLine: string;
  childPowerShellPath: string;
  childArgumentLine: string;
  cwd: string;
  completionNonce: string;
  startSignalPath: string;
  promptPath: string;
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;

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

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string,
): string | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toUpperCase() === requestedName.toUpperCase(),
  );
  return actualName ? environment[actualName] : undefined;
}

/** Resolve the host-owned Windows PowerShell executable without PATH lookup. */
export function resolveWindowsPowerShellPath(
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): string {
  const systemRoot =
    readEnvironmentValue(environment, "SYSTEMROOT") ?? readEnvironmentValue(environment, "WINDIR");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows Codex containment requires an absolute SystemRoot");
  }
  const candidate = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (process.platform !== "win32") {
    const relative = path.win32.relative(path.win32.resolve(projectRoot), candidate);
    if (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative))
    ) {
      throw new Error("Windows PowerShell resolves inside the mutable project");
    }
    return candidate;
  }

  try {
    const canonicalSystemRoot = realpathSync.native(systemRoot);
    const canonicalPowerShell = realpathSync.native(candidate);
    const canonicalProjectRoot = realpathSync.native(path.resolve(projectRoot));
    const relative = path.win32.relative(canonicalSystemRoot, canonicalPowerShell);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.win32.sep}`) ||
      path.win32.isAbsolute(relative)
    ) {
      throw new Error("PowerShell resolves outside SystemRoot");
    }
    const projectRelative = path.win32.relative(canonicalProjectRoot, canonicalPowerShell);
    if (
      projectRelative === "" ||
      (projectRelative !== ".." &&
        !projectRelative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(projectRelative))
    ) {
      throw new Error("PowerShell resolves inside the mutable project");
    }
    accessSync(canonicalPowerShell, fsConstants.X_OK);
    return canonicalPowerShell;
  } catch (error: unknown) {
    throw new Error(
      `Windows Codex containment cannot resolve trusted PowerShell: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Resolve the host-owned taskkill executable without PATH/cwd lookup. */
export function resolveWindowsTaskkillPath(
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): string {
  const systemRoot =
    readEnvironmentValue(environment, "SYSTEMROOT") ?? readEnvironmentValue(environment, "WINDIR");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows Codex containment requires an absolute SystemRoot");
  }
  const candidate = path.win32.join(systemRoot, "System32", "taskkill.exe");
  if (process.platform !== "win32") return candidate;

  try {
    const canonicalTaskkill = realpathSync.native(candidate);
    const canonicalProjectRoot = realpathSync.native(path.resolve(projectRoot));
    const relative = path.win32.relative(canonicalProjectRoot, canonicalTaskkill);
    if (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative))
    ) {
      throw new Error("taskkill resolves inside the mutable project");
    }
    accessSync(canonicalTaskkill, fsConstants.X_OK);
    return canonicalTaskkill;
  } catch (error: unknown) {
    throw new Error(
      `Windows Codex containment cannot resolve trusted taskkill: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Build a process launch that gives each supported platform an OS boundary. */
export function buildContainedCodexSpawn(input: {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nonce?: string;
}): ContainedCodexSpawnPlan {
  const platform = input.platform ?? process.platform;
  if (platform === "linux") {
    // A fixed, host-owned path prevents a writable PATH entry from replacing
    // the isolation launcher. Missing or non-executable unshare fails before
    // any uncontained Codex process can start.
    if (process.platform === "linux") {
      try {
        accessSync(LINUX_UNSHARE_BINARY, fsConstants.X_OK);
      } catch {
        throw new Error(`Linux Codex containment requires executable ${LINUX_UNSHARE_BINARY}`);
      }
    }
    return {
      command: LINUX_UNSHARE_BINARY,
      args: [
        "--user",
        "--map-current-user",
        "--pid",
        "--fork",
        "--kill-child=SIGKILL",
        "--mount-proc",
        "--",
        input.binaryPath,
        ...input.args,
      ],
      options: {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      },
      linuxPidNamespace: true,
    };
  }
  if (platform !== "win32") {
    throw new Error(`Codex descendant containment is unavailable on ${platform}`);
  }

  const completionNonce = input.nonce ?? randomUUID();
  const childPowerShellPath = resolveWindowsPowerShellPath(input.env, input.cwd);
  const payload: WindowsInvocationPayload = {
    binaryPath: input.binaryPath,
    argumentLine: input.args.map(quoteWindowsArgument).join(" "),
    childPowerShellPath,
    childArgumentLine: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_CHILD_WRAPPER, "utf16le").toString("base64"),
    ]
      .map(quoteWindowsArgument)
      .join(" "),
    cwd: input.cwd,
    completionNonce,
    startSignalPath: path.join(os.tmpdir(), `quack-codex-start-${completionNonce}.signal`),
    promptPath: path.join(os.tmpdir(), `quack-codex-prompt-${completionNonce}.txt`),
  };
  const env = {
    ...input.env,
    [WINDOWS_INVOCATION_ENV]: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  };
  return {
    command: childPowerShellPath,
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
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    },
    windowsCompletionMarker: `${WINDOWS_COMPLETION_PREFIX}${completionNonce}`,
  };
}

/**
 * Verify the platform containment boundary before denied paths are restored.
 * Interrupted wrappers are intentionally fail-closed because their teardown
 * is not synchronously observable from the worker process.
 */
export function verifyCodexDescendantsContained(evidence: CodexContainmentEvidence): Promise<void> {
  if (!Number.isSafeInteger(evidence.pid) || evidence.pid <= 0) {
    return Promise.reject(new Error(`invalid Codex containment process id ${evidence.pid}`));
  }
  if (evidence.platform === "win32") {
    if (!evidence.interrupted && evidence.windowsCompletionObserved) {
      return Promise.resolve();
    }
    return Promise.reject(
      new Error("Windows Codex process-tree wrapper did not prove that all descendants exited"),
    );
  }
  if (evidence.platform === "linux") {
    if (!evidence.interrupted && evidence.linuxPidNamespace) {
      return Promise.resolve();
    }
    return Promise.reject(
      new Error("Linux Codex PID-namespace wrapper did not prove that all descendants exited"),
    );
  }
  return Promise.reject(
    new Error(`Codex descendant containment is unavailable on ${evidence.platform}`),
  );
}
