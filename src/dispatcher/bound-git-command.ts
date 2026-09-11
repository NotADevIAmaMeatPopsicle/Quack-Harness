import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;
const BOUND_REMOTE_PREFIX = "quack-bound-";
const BOUND_URL_SCHEME_PREFIX = "quack-publication-";
const INHERITED_COMMAND_CONFIG = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_[0-9]+|VALUE_[0-9]+)$/iu;

/** Placeholder replaced with a fresh random remote name for every Git child. */
export const BOUND_GIT_REMOTE = "__quack-publication-bound__";

export interface BoundGitCommand {
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export interface BoundGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecError {
  code?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function redactBoundUrl(value: string, pushUrl: string): string {
  return pushUrl ? value.split(pushUrl).join("[bound-origin]") : value;
}

/**
 * Build an execution-only Git remote whose transport URL cannot be redirected
 * by inherited url.*.insteadOf or url.*.pushInsteadOf configuration.
 *
 * Git applies URL rewrites once and chooses the longest matching prefix. The
 * child therefore sees a fresh unguessable pseudo-URL, plus an exact mapping
 * from that pseudo-URL to the already validated real URL. An inherited rule
 * for the real URL cannot run a second time, while an inherited rule for a
 * shorter pseudo-URL prefix loses to the exact per-child mapping.
 */
export function createBoundGitCommand(
  args: readonly string[],
  pushUrl: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): BoundGitCommand {
  const remoteName = `${BOUND_REMOTE_PREFIX}${randomUUID()}`;
  const pseudoUrl = `${BOUND_URL_SCHEME_PREFIX}${randomUUID()}://origin`;
  const environment = { ...baseEnvironment };

  for (const key of Object.keys(environment)) {
    if (INHERITED_COMMAND_CONFIG.test(key)) delete environment[key];
  }

  const entries: ReadonlyArray<readonly [string, string]> = [
    [`remote.${remoteName}.url`, pseudoUrl],
    [`remote.${remoteName}.pushurl`, pseudoUrl],
    [`url.${pushUrl}.insteadOf`, pseudoUrl],
    [`url.${pushUrl}.pushInsteadOf`, pseudoUrl],
  ];
  environment.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return {
    args: args.map((arg) => (arg === BOUND_GIT_REMOTE ? remoteName : arg)),
    environment,
  };
}

/** Execute a network-capable Git command against one immutable URL binding. */
export async function runBoundGitCommand(
  args: readonly string[],
  cwd: string,
  pushUrl: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<BoundGitResult> {
  const command = createBoundGitCommand(args, pushUrl, baseEnvironment);
  try {
    const { stdout, stderr } = await execFileAsync("git", command.args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: command.environment,
    });
    return {
      exitCode: 0,
      stdout: redactBoundUrl(outputText(stdout), pushUrl),
      stderr: redactBoundUrl(outputText(stderr), pushUrl),
    };
  } catch (error: unknown) {
    const failure = typeof error === "object" && error !== null ? (error as ExecError) : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: typeof failure?.code === "number" ? failure.code : 1,
      stdout: redactBoundUrl(outputText(failure?.stdout), pushUrl),
      stderr: redactBoundUrl(outputText(failure?.stderr) || `git error: ${message}`, pushUrl),
    };
  }
}
