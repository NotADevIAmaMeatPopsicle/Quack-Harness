import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

function isSupportedHost(value: string): boolean {
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/u.exec(value);
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export interface GitHubRepositoryBinding {
  /** Host-qualified gh selector. Ambient GH_REPO can never override this. */
  selector: string;
  host: string;
  nameWithOwner: string;
}

export interface GitOriginBinding {
  /** Exact push-URL identity without persisting credential-bearing URL text. */
  pushUrlHash: string;
  /** Present only when the generic Git remote is a GitHub repository. */
  github?: GitHubRepositoryBinding;
}

export interface GitOriginIdentity extends GitOriginBinding {
  pushUrl: string;
}

export interface GitHubRepositoryIdentity extends GitHubRepositoryBinding {
  pushUrl: string;
  pushUrlHash: string;
}

function hashPushUrl(pushUrl: string): string {
  return createHash("sha256").update(pushUrl, "utf8").digest("hex");
}

function repositoryPath(pathname: string): { owner: string; name: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const segments = decoded
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .split("/");
  if (
    segments.length !== 2 ||
    !segments[0] ||
    !segments[1] ||
    !REPOSITORY_SEGMENT.test(segments[0]) ||
    !REPOSITORY_SEGMENT.test(segments[1]) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return { owner: segments[0], name: segments[1] };
}

/**
 * Parse the exact Git `origin` push URL into a host-qualified GitHub identity.
 * Local paths, ambiguous paths, and repository names with extra path segments
 * are rejected rather than allowing gh's ambient repository selection.
 */
export function parseGitHubOrigin(remoteUrl: string): GitHubRepositoryIdentity | undefined {
  const value = remoteUrl.trim();
  if (!value || /[\r\n]/u.test(value)) return undefined;

  let host: string | undefined;
  let pathValue: string | undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    try {
      const parsed = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
      if (parsed.search || parsed.hash) return undefined;
      host = parsed.host.toLowerCase();
      pathValue = parsed.pathname;
    } catch {
      return undefined;
    }
  } else {
    // SCP-like Git URL, for example git@github.com:owner/repository.git.
    const match = /^(?:[^@/:\s]+@)?([^:/\s]+):(.+)$/u.exec(value);
    if (!match) return undefined;
    host = match[1]?.toLowerCase();
    pathValue = match[2];
  }

  if (!host || !pathValue || !isSupportedHost(host)) return undefined;
  const repository = repositoryPath(pathValue);
  if (!repository) return undefined;
  const nameWithOwner = `${repository.owner}/${repository.name}`;
  return {
    host,
    nameWithOwner,
    selector: `${host}/${nameWithOwner}`,
    pushUrl: value,
    pushUrlHash: hashPushUrl(value),
  };
}

async function readSingleOriginPushUrl(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["remote", "get-url", "--push", "--all", "origin"],
    {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  const urls = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length !== 1) {
    throw new Error("Git origin must have exactly one push URL for GitHub publication");
  }
  return urls[0];
}

/** Resolve GitHub identity from the same exact remote Git will push to. */
export async function resolveOriginGitHubRepository(
  cwd: string,
): Promise<GitHubRepositoryIdentity> {
  const origin = await resolveOriginRepository(cwd);
  if (!origin.github) {
    throw new Error("Could not resolve a GitHub repository from the exact origin push URL");
  }
  return {
    ...origin.github,
    pushUrl: origin.pushUrl,
    pushUrlHash: origin.pushUrlHash,
  };
}

/** Bind any single Git origin, including local/bare remotes used by adapters. */
export async function resolveOriginRepository(cwd: string): Promise<GitOriginIdentity> {
  const pushUrl = await readSingleOriginPushUrl(cwd);
  const github = parseGitHubOrigin(pushUrl);
  return {
    pushUrl,
    pushUrlHash: hashPushUrl(pushUrl),
    ...(github
      ? {
          github: {
            selector: github.selector,
            host: github.host,
            nameWithOwner: github.nameWithOwner,
          },
        }
      : {}),
  };
}

export async function originPushUrlMatches(cwd: string, expectedPushUrl: string): Promise<boolean> {
  try {
    return (await readSingleOriginPushUrl(cwd)) === expectedPushUrl;
  } catch {
    return false;
  }
}

export function persistentGitHubRepositoryBinding(
  repository: GitHubRepositoryIdentity,
): GitHubRepositoryBinding {
  return {
    selector: repository.selector,
    host: repository.host,
    nameWithOwner: repository.nameWithOwner,
  };
}

export function isGitHubRepositoryBinding(value: unknown): value is GitHubRepositoryBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.selector === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.nameWithOwner === "string" &&
    isSupportedHost(candidate.host) &&
    candidate.selector === `${candidate.host}/${candidate.nameWithOwner}` &&
    repositoryPath(candidate.nameWithOwner) !== undefined
  );
}

export function persistentOriginRepositoryBinding(origin: GitOriginIdentity): GitOriginBinding {
  return {
    pushUrlHash: origin.pushUrlHash,
    ...(origin.github ? { github: { ...origin.github } } : {}),
  };
}

export function isGitOriginBinding(value: unknown): value is GitOriginBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) => ["pushUrlHash", "github"].includes(key)) &&
    Object.keys(candidate).length >= 1 &&
    typeof candidate.pushUrlHash === "string" &&
    /^[a-f0-9]{64}$/iu.test(candidate.pushUrlHash) &&
    (candidate.github === undefined || isGitHubRepositoryBinding(candidate.github))
  );
}

export async function resolveBoundOriginRepository(
  cwd: string,
  expected: GitOriginBinding,
): Promise<GitOriginIdentity> {
  if (!isGitOriginBinding(expected)) {
    throw new Error("Persisted Git origin binding is invalid");
  }
  const current = await resolveOriginRepository(cwd);
  if (
    current.pushUrlHash !== expected.pushUrlHash ||
    Boolean(current.github) !== Boolean(expected.github) ||
    (current.github !== undefined &&
      expected.github !== undefined &&
      (current.github.selector !== expected.github.selector ||
        current.github.host !== expected.github.host ||
        current.github.nameWithOwner !== expected.github.nameWithOwner))
  ) {
    throw new Error("Git origin changed after publication was bound");
  }
  return current;
}

/**
 * Re-read origin, prove it still matches a persisted binding, and return the
 * concrete URL for a single bound Git operation. Callers pass that returned
 * URL directly to Git so a subsequent config change cannot redirect it.
 */
export async function resolveBoundOriginGitHubRepository(
  cwd: string,
  expected: GitOriginBinding,
): Promise<GitHubRepositoryIdentity> {
  const current = await resolveBoundOriginRepository(cwd, expected);
  if (!current.github) {
    throw new Error("Bound Git origin is not a GitHub repository");
  }
  return {
    ...current.github,
    pushUrl: current.pushUrl,
    pushUrlHash: current.pushUrlHash,
  };
}

export function pullRequestUrlMatchesOrigin(
  prUrl: string,
  repository: GitHubRepositoryIdentity,
): boolean {
  try {
    const parsed = new URL(prUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return (
      parsed.host.toLowerCase() === repository.host &&
      segments.length === 4 &&
      segments.at(-2) === "pull" &&
      /^\d+$/u.test(segments.at(-1) ?? "") &&
      `${segments.at(-4)}/${segments.at(-3)}`.toLowerCase() ===
        repository.nameWithOwner.toLowerCase()
    );
  } catch {
    return false;
  }
}
