// Host-side verification executes code from a worker-mutated checkout.  This
// module puts that code behind two independent boundaries:
//   1. a Codex permission profile which can write only to the selected
//      verification root and cannot use the network; and
//   2. the same process-tree containment used by worktree initialization.
//
// The feature is adapter opt-in because not every Quack installation has the
// Codex CLI available.  Opted-in adapters fail closed; there is no direct-host
// fallback when the sandbox cannot be established.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { runContainedWorktreeInitCommand } from "../dispatcher/worktree-init-process.js";
import { resolveTrustedExecutable } from "./trusted-executable.js";

const PROFILE_NAME = "quack_verify";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const BLOCKED_ENV_NAMES = new Set([
  "APPDATA",
  "BASHOPTS",
  "BASH_ENV",
  "CODEX_HOME",
  "COMSPEC",
  "ENV",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "ZDOTDIR",
]);
const BLOCKED_ENV_PREFIXES = ["DYLD_", "GIT_", "LD_", "NPM_CONFIG_", "QUACK_"];

export interface SandboxedVerificationCommand {
  command?: string;
  executable?: string;
  args?: string[];
  shell?: string;
  env?: Record<string, string>;
}

export interface SandboxedVerificationInput {
  cwd: string;
  /** Read-only authoritative checkout containing the task worktree. */
  authoritativeRoot: string;
  codexBinaryPath?: string;
  timeoutMs: number;
  command: SandboxedVerificationCommand;
}

export interface SandboxedVerificationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type ContainedRunner = typeof runContainedWorktreeInitCommand;
let containedRunner: ContainedRunner = runContainedWorktreeInitCommand;

/** Test seam. Production always uses the OS-contained runner. */
export function _setSandboxedVerificationRunner(runner: ContainedRunner | undefined): void {
  containedRunner = runner ?? runContainedWorktreeInitCommand;
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  return (
    normalized === "" ||
    (normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized))
  );
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string,
): string | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toUpperCase() === requestedName.toUpperCase(),
  );
  return actualName ? environment[actualName] : undefined;
}

function safeToolDirectories(
  projectRoot: string,
  codexExecutable: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  const directories = new Set<string>();
  const addExecutableDirectory = (name: string): void => {
    try {
      directories.add(path.dirname(resolveTrustedExecutable(name, projectRoot, name, environment)));
    } catch {
      // A project does not necessarily need every optional tool. Commands that
      // need a missing tool fail naturally inside the sandbox.
    }
  };

  addExecutableDirectory("node");
  addExecutableDirectory("git");
  if (process.platform === "win32") {
    const systemRoot =
      environmentValue(environment, "SYSTEMROOT") ?? environmentValue(environment, "WINDIR");
    if (systemRoot && path.win32.isAbsolute(systemRoot)) {
      directories.add(path.win32.join(systemRoot, "System32"));
    }
    // npm/npx shipped with the trusted Node installation are command shims,
    // so include that already-trusted directory without accepting arbitrary
    // user-writable PATH entries.
    try {
      directories.add(
        path.dirname(resolveTrustedExecutable("node", projectRoot, "Node.js", environment)),
      );
    } catch {
      // Covered by the command's eventual non-zero result.
    }
  } else {
    directories.add("/usr/bin");
    directories.add("/bin");
  }
  directories.delete(path.dirname(codexExecutable));
  return [...directories];
}

function validateCommandEnvironment(
  overrides: Record<string, string> | undefined,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const normalized = name.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalized)) {
      throw new Error(`verification command environment variable has an invalid name: ${name}`);
    }
    if (
      BLOCKED_ENV_NAMES.has(normalized) ||
      BLOCKED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      throw new Error(
        `verification command cannot override protected environment variable ${name}`,
      );
    }
    entries.push([name, value]);
  }
  return entries;
}

async function buildSandboxEnvironment(input: {
  cwd: string;
  tempRoot: string;
  codexExecutable: string;
  source?: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const source = input.source ?? process.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    const value = environmentValue(source, name);
    if (value !== undefined) environment[name] = value;
  }

  const pathValue = safeToolDirectories(input.cwd, input.codexExecutable, source).join(
    path.delimiter,
  );
  environment.PATH = pathValue;
  environment.Path = pathValue;
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_CONFIG_GLOBAL = path.join(input.tempRoot, "gitconfig");
  environment.HOME = input.tempRoot;
  environment.USERPROFILE = input.tempRoot;
  environment.APPDATA = input.tempRoot;
  environment.LOCALAPPDATA = input.tempRoot;
  environment.TEMP = input.tempRoot;
  environment.TMP = input.tempRoot;
  environment.TMPDIR = input.tempRoot;
  environment.NPM_CONFIG_USERCONFIG = path.join(input.tempRoot, "npmrc");
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(input.tempRoot, "npmrc-global");
  environment.NPM_CONFIG_CACHE = path.join(input.tempRoot, "npm-cache");
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  await Promise.all([
    fs.writeFile(environment.GIT_CONFIG_GLOBAL, "[core]\n\thooksPath = NUL\n", "utf8"),
    fs.writeFile(environment.NPM_CONFIG_USERCONFIG, "audit=false\nfund=false\n", "utf8"),
    fs.writeFile(environment.NPM_CONFIG_GLOBALCONFIG, "audit=false\nfund=false\n", "utf8"),
  ]);
  return environment;
}

function buildPowerShellCommand(input: {
  cwd: string;
  command: SandboxedVerificationCommand;
  commandEnvironment: Array<[string, string]>;
}): string {
  const invocation = input.command;
  if (!!invocation.command === !!invocation.executable) {
    throw new Error("sandboxed verification requires exactly one of command or executable");
  }

  let executable: string;
  let args: string[];
  if (invocation.command) {
    executable =
      invocation.shell ??
      path.win32.join(
        environmentValue(process.env, "SYSTEMROOT") ??
          environmentValue(process.env, "WINDIR") ??
          "C:\\Windows",
        "System32",
        "cmd.exe",
      );
    args = invocation.shell
      ? ["--noprofile", "--norc", "-c", invocation.command]
      : ["/d", "/s", "/c", invocation.command];
  } else {
    executable = invocation.executable!;
    args = invocation.args ?? [];
  }

  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  return [
    '$ErrorActionPreference = "Stop"',
    `$cwd = ${powershellLiteral(input.cwd)}`,
    "Set-Location -LiteralPath $cwd",
    `$executable = ${powershellLiteral(executable)}`,
    `$argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellLiteral(encodedArgs)}))`,
    "$arguments = @($argumentJson | ConvertFrom-Json)",
    ...input.commandEnvironment.map(
      ([name, value]) =>
        `[Environment]::SetEnvironmentVariable(${powershellLiteral(name)}, ${powershellLiteral(value)}, "Process")`,
    ),
    "& $executable @arguments",
    "$exitCode = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { [int]$LASTEXITCODE }",
    "exit $exitCode",
  ].join("\n");
}

export function buildVerificationPermissionArgs(input: {
  authoritativeRoot: string;
  cwd: string;
}): string[] {
  const canonicalAuthoritativeRoot = realpathSync.native(path.resolve(input.authoritativeRoot));
  const canonicalCwd = realpathSync.native(path.resolve(input.cwd));
  if (!isInsidePath(canonicalAuthoritativeRoot, canonicalCwd)) {
    throw new Error(
      `verification cwd ${canonicalCwd} is outside authoritative root ${canonicalAuthoritativeRoot}`,
    );
  }

  const rules: Array<[string, "read" | "write"]> = [[":minimal", "read"]];
  if (canonicalAuthoritativeRoot !== canonicalCwd) {
    rules.push([canonicalAuthoritativeRoot, "read"]);
  }
  rules.push(
    [canonicalCwd, "write"],
    [path.join(canonicalCwd, ".git"), "read"],
    [path.join(canonicalCwd, ".codex"), "read"],
    [path.join(canonicalCwd, ".agents"), "read"],
    [path.join(canonicalCwd, ".quack"), "read"],
    [path.join(canonicalCwd, ".quack", "evidence"), "write"],
    [path.join(canonicalCwd, ".quack", "research"), "write"],
    [path.join(canonicalCwd, ".quack", "test-results"), "write"],
    [path.join(canonicalCwd, ".quack", "verification-temp"), "write"],
  );
  const inlineRules = rules
    .map(([filePath, access]) => `${tomlString(filePath)}=${tomlString(access)}`)
    .join(",");
  return [
    "sandbox",
    "-P",
    PROFILE_NAME,
    "-c",
    `permissions.${PROFILE_NAME}.filesystem={${inlineRules}}`,
    "-c",
    `permissions.${PROFILE_NAME}.network.enabled=false`,
    "-C",
    canonicalCwd,
  ];
}

/** Execute one adapter verification command without exposing host credentials. */
export async function runCodexSandboxedVerification(
  input: SandboxedVerificationInput,
): Promise<SandboxedVerificationResult> {
  const canonicalCwd = realpathSync.native(path.resolve(input.cwd));
  const canonicalAuthoritativeRoot = realpathSync.native(path.resolve(input.authoritativeRoot));
  if (!isInsidePath(canonicalAuthoritativeRoot, canonicalCwd)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox refusal: ${canonicalCwd} is outside ${canonicalAuthoritativeRoot}`,
    };
  }

  let codexExecutable: string;
  try {
    codexExecutable = resolveTrustedExecutable(
      input.codexBinaryPath ?? "codex",
      canonicalCwd,
      "Codex CLI",
    );
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox refusal: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let commandEnvironment: Array<[string, string]>;
  try {
    commandEnvironment = validateCommandEnvironment(input.command.env);
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox refusal: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const tempParent = path.join(canonicalCwd, ".quack", "verification-temp");
  const tempRoot = path.join(tempParent, randomUUID());
  try {
    await fs.mkdir(tempRoot, { recursive: true });
    const environment = await buildSandboxEnvironment({
      cwd: canonicalCwd,
      tempRoot,
      codexExecutable,
    });

    let executable: string;
    let args: string[];
    if (process.platform === "win32") {
      const systemRoot =
        environmentValue(environment, "SYSTEMROOT") ?? environmentValue(environment, "WINDIR");
      if (!systemRoot) throw new Error("Windows sandbox requires SystemRoot");
      executable = realpathSync.native(
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      );
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(
          buildPowerShellCommand({
            cwd: canonicalCwd,
            command: input.command,
            commandEnvironment,
          }),
          "utf16le",
        ).toString("base64"),
      ];
    } else {
      const targetExecutable = input.command.command
        ? (input.command.shell ?? "/bin/sh")
        : input.command.executable!;
      const targetArgs = input.command.command
        ? ["-c", input.command.command]
        : (input.command.args ?? []);
      if (commandEnvironment.length > 0) {
        executable = realpathSync.native("/usr/bin/env");
        args = [
          ...commandEnvironment.map(([name, value]) => `${name}=${value}`),
          targetExecutable,
          ...targetArgs,
        ];
      } else {
        executable = targetExecutable;
        args = targetArgs;
      }
    }

    const permissionArgs = buildVerificationPermissionArgs({
      authoritativeRoot: canonicalAuthoritativeRoot,
      cwd: canonicalCwd,
    });
    const result = await containedRunner({
      executable: codexExecutable,
      args: [...permissionArgs, "--", executable, ...args],
      cwd: canonicalCwd,
      env: environment,
      timeoutMs: input.timeoutMs,
      maxBufferBytes: MAX_OUTPUT_BYTES,
    });
    if (!result.descendantsContained) {
      return {
        exitCode: 1,
        stdout: result.stdout,
        stderr: [result.stderr, "Sandbox refusal: descendant containment was not proven"]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox refusal: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(tempParent).catch(() => undefined);
  }
}
