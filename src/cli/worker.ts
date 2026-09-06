import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import { loadAdapter } from "../core/adapter-loader.js";
import { getBuildInfo } from "../core/build-info.js";
import { registerProject } from "../core/global-config.js";
import { writeFederationPeerConfig } from "../monitor/federation/peer-config.js";
import { createMonitorServer } from "../monitor/server.js";
import {
  deriveWorkerEnrollmentReadiness,
  repoFreshnessFromManifest,
} from "../worker/enrollment-readiness.js";
import type {
  WorkerEnrollmentBootstrapResponse,
  WorkerEnrollmentCreateRequest,
  WorkerEnrollmentCreateResponse,
} from "../monitor/api-contracts.js";
import type {
  WorkerCapabilityProbeResult,
  WorkerEnrollmentManifest,
  WorkerEnrollmentProgressPhase,
  WorkerEnrollmentReadiness,
  WorkerRepoFreshness,
  WorkerInstallCommand,
} from "../worker/enrollment-types.js";

async function loadWorkerAdapters(options: {
  port?: string;
  project?: string | string[];
}): Promise<{
  adapters: ProjectAdapter[];
  port: number;
  skippedProjects: string[];
  fromGlobalConfig: boolean;
}> {
  let projectPaths: string[];
  let port: number;
  let fromGlobalConfig = false;

  if (options.project) {
    projectPaths = Array.isArray(options.project) ? options.project : [options.project];
    port = options.port ? parseInt(options.port, 10) : 3337;
  } else {
    try {
      const { loadGlobalConfig } = await import("../core/global-config.js");
      const globalConfig = loadGlobalConfig();
      if (globalConfig.projects.length > 0) {
        projectPaths = globalConfig.projects.map((entry) => entry.path);
        port = options.port ? parseInt(options.port, 10) : 3337;
        fromGlobalConfig = true;
      } else {
        projectPaths = [process.cwd()];
        port = options.port ? parseInt(options.port, 10) : 3337;
      }
    } catch {
      projectPaths = [process.cwd()];
      port = options.port ? parseInt(options.port, 10) : 3337;
    }
  }

  const adapters: ProjectAdapter[] = [];
  const skippedProjects: string[] = [];
  for (const projectPath of projectPaths) {
    try {
      const adapter = await loadAdapter(projectPath);
      adapters.push(adapter);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      skippedProjects.push(`${projectPath}: ${msg}`);
    }
  }

  return { adapters, port, skippedProjects, fromGlobalConfig };
}

export async function workerRuntimeCommand(options: {
  port?: string;
  host?: string;
  project?: string | string[];
}): Promise<void> {
  try {
    const { adapters, port, skippedProjects, fromGlobalConfig } = await loadWorkerAdapters(options);
    if (adapters.length === 0) {
      console.error("Error: No valid projects found for worker runtime.");
      for (const skip of skippedProjects) {
        console.error(`  Skipped: ${skip}`);
      }
      process.exit(1);
    }

    const build = getBuildInfo();
    console.log(`\nQuack Worker Runtime v${build.version} (${build.commit})`);
    console.log(`Built: ${build.builtAt}`);
    console.log(`${"=".repeat(40)}`);
    console.log(`Bind host: ${options.host ?? "127.0.0.1"}`);
    console.log(`Port:      ${port}`);
    console.log(`Projects:  ${adapters.map((adapter) => adapter.config.project.name).join(", ")}`);
    if (fromGlobalConfig) {
      console.log("Config:    ~/.quack/config.json");
    }
    if (skippedProjects.length > 0) {
      console.log(`Skipped ${skippedProjects.length} project(s):`);
      for (const skip of skippedProjects) {
        console.log(`  - ${skip}`);
      }
    }

    let server;
    if (adapters.length === 1 && !fromGlobalConfig) {
      const adapter = adapters[0];
      const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
      server = createMonitorServer({
        logDir,
        port,
        adapterPath: path.resolve(adapter.projectRoot, ".quack", "adapter.json"),
        projectRoot: adapter.projectRoot,
        taskDir: adapter.config.project.taskDir,
        runtimeRole: "worker",
        host: options.host ?? "127.0.0.1",
      });
    } else {
      server = createMonitorServer({
        port,
        projectAdapters: adapters,
        runtimeRole: "worker",
        host: options.host ?? "127.0.0.1",
      });
    }

    const { stop } = await server.start();
    console.log(`Health:    http://${options.host ?? "127.0.0.1"}:${port}/api/health`);
    console.log(`Dispatch:  http://${options.host ?? "127.0.0.1"}:${port}/api/dispatch/jobs`);
    console.log("\nPress Ctrl+C to stop.\n");

    const shutdown = async () => {
      console.log("\nShutting down worker runtime...");
      await stop();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      console.error(err.stack);
    } else {
      console.error(`Error: ${String(err)}`);
    }
    process.exit(1);
  }
}

interface WorkerInstallCliOptions {
  controlBaseUrl?: string;
  bootstrapToken?: string;
  targetRoot?: string;
  listenerBaseUrl?: string;
  persistence?: WorkerEnrollmentManifest["worker"]["persistence"];
  start?: boolean;
  dryRun?: boolean;
  repair?: boolean;
}

interface WorkerEnrollCliOptions {
  controlBaseUrl?: string;
  apiKey?: string;
  hostId?: string;
  alias?: string;
  profileId?: string;
  projectId?: string;
  runtimePort?: string | number;
  maxConcurrentJobs?: string | number;
  capabilities?: string;
  persistence?: WorkerEnrollmentManifest["worker"]["persistence"];
  ttlMinutes?: string | number;
  targetRootWindows?: string;
  targetRootPosix?: string;
  json?: boolean;
  bundle?: boolean;
}

function guessWorkerRoot(targetRoot?: string): string {
  if (targetRoot?.trim()) return path.resolve(targetRoot);
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === "quack") {
    return path.dirname(cwd);
  }
  return cwd;
}

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  }).then(async (response) => {
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body && "message" in body
          ? String((body as { message: unknown }).message)
          : typeof body === "object" && body && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  });
}

function parseOptionalInteger(
  value: string | number | undefined,
  label: string,
  options: {
    min?: number;
    max?: number;
  } = {},
): number | undefined {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`${label} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${label} must be at most ${options.max}.`);
  }
  return parsed;
}

function parseCapabilitiesCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function commandSection(title: string, command: string): string[] {
  return [title, command, ""];
}

function renderWorkerEnrollmentBundle(result: WorkerEnrollmentCreateResponse): string {
  const lines = [
    `Enrollment ID: ${result.session.enrollmentId}`,
    `Host ID: ${result.session.hostId}`,
    `Alias: ${result.session.alias}`,
    `Project ID: ${result.session.projectId}`,
    `Runtime port: ${result.session.runtimePort}`,
    `Persistence: ${result.session.persistence}`,
    `Expires: ${result.session.expiresAt}`,
    "",
    "Requested capabilities:",
    ...result.session.installStatus.requestedCapabilities.map((capability) => `- ${capability}`),
    "",
    "Advertised capabilities:",
    ...result.session.installStatus.advertisedCapabilities.map((capability) => `- ${capability}`),
    "",
    "Prerequisites:",
    ...(result.manifestPreview.prerequisites.length > 0
      ? result.manifestPreview.prerequisites.map(
          (prerequisite) =>
            `- ${prerequisite.label}${prerequisite.checkCommand ? ` :: ${[prerequisite.checkCommand.cmd, ...prerequisite.checkCommand.args].join(" ")}` : ""}`,
        )
      : ["- none declared"]),
    "",
    "Manual follow-up:",
    ...(result.manifestPreview.manualSteps.length > 0
      ? result.manifestPreview.manualSteps.map((step) => `- ${step}`)
      : ["- none"]),
    "",
    "Bootstrap token:",
    result.bootstrapToken,
    "",
    ...(result.targetRoots.windows
      ? [`Windows target root: ${result.targetRoots.windows}`, ""]
      : []),
    ...(result.targetRoots.posix ? [`POSIX target root: ${result.targetRoots.posix}`, ""] : []),
    ...commandSection("Windows install command:", result.installCommandWindows),
    ...commandSection("Windows repair command:", result.repairCommandWindows),
    ...commandSection("POSIX install command:", result.installCommand),
    ...commandSection("POSIX repair command:", result.repairCommand),
  ];
  return lines.join("\n").trimEnd();
}

function printWorkerEnrollmentSummary(result: WorkerEnrollmentCreateResponse): void {
  console.log(`Worker enrollment ${result.session.enrollmentId} created.`);
  console.log(`  Host:         ${result.session.hostId}`);
  console.log(`  Alias:        ${result.session.alias}`);
  console.log(`  Project:      ${result.session.projectId}`);
  console.log(`  Runtime port: ${result.session.runtimePort}`);
  console.log(`  Persistence:  ${result.session.persistence}`);
  console.log(`  Expires:      ${result.session.expiresAt}`);
  console.log(`  Token:        ${result.bootstrapToken}`);
  if (result.targetRoots.windows) {
    console.log(`  Windows root: ${result.targetRoots.windows}`);
  }
  if (result.targetRoots.posix) {
    console.log(`  POSIX root:   ${result.targetRoots.posix}`);
  }
  console.log("  Requested capabilities:");
  for (const capability of result.session.installStatus.requestedCapabilities) {
    console.log(`    - ${capability}`);
  }
  console.log("  Windows install:");
  console.log(`    ${result.installCommandWindows}`);
  console.log("  Windows repair:");
  console.log(`    ${result.repairCommandWindows}`);
  console.log("  POSIX install:");
  console.log(`    ${result.installCommand}`);
  console.log("  POSIX repair:");
  console.log(`    ${result.repairCommand}`);
  if (result.manifestPreview.manualSteps.length > 0) {
    console.log("  Manual follow-up:");
    for (const step of result.manifestPreview.manualSteps) {
      console.log(`    - ${step}`);
    }
  }
}

export async function workerEnrollCommand(options: WorkerEnrollCliOptions): Promise<void> {
  const hostId = options.hostId?.trim();
  if (!hostId) {
    throw new Error("Missing --host-id.");
  }

  const payload: WorkerEnrollmentCreateRequest = {
    hostId,
    alias: options.alias?.trim() || undefined,
    profileId: options.profileId?.trim() || undefined,
    projectId: options.projectId?.trim() || undefined,
    runtimePort: parseOptionalInteger(options.runtimePort, "--runtime-port", {
      min: 1,
      max: 65535,
    }),
    maxConcurrentJobs: parseOptionalInteger(options.maxConcurrentJobs, "--max-concurrent-jobs", {
      min: 1,
      max: 16,
    }),
    capabilities: parseCapabilitiesCsv(options.capabilities),
    persistence: options.persistence,
    ttlMinutes: parseOptionalInteger(options.ttlMinutes, "--ttl-minutes", { min: 1, max: 1440 }),
    targetRootWindows: options.targetRootWindows?.trim() || undefined,
    targetRootPosix: options.targetRootPosix?.trim() || undefined,
  };
  const controlBaseUrl = stripTrailingSlash(
    options.controlBaseUrl?.trim() || "http://127.0.0.1:3333",
  );
  const apiKey = options.apiKey?.trim() || process.env.QUACK_API_KEY?.trim();

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const response = await fetchJson<WorkerEnrollmentCreateResponse>(
    `${controlBaseUrl}/api/workers/enrollments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (options.bundle) {
    console.log(renderWorkerEnrollmentBundle(response));
    return;
  }

  printWorkerEnrollmentSummary(response);
}

interface WorkerEnrollmentProgressReporter {
  report: (
    phase: WorkerEnrollmentProgressPhase,
    state: "running" | "completed" | "failed" | "waiting",
    message: string,
    options?: {
      detail?: string;
      metadata?: Record<string, unknown>;
      capabilityResults?: WorkerCapabilityProbeResult[];
    },
  ) => Promise<void>;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function createProgressReporter(options: {
  controlBaseUrl: string;
  enrollmentId: string;
  workerToken: string;
  dryRun: boolean;
}): WorkerEnrollmentProgressReporter {
  return {
    async report(phase, state, message, eventOptions = {}) {
      if (options.dryRun) return;
      try {
        await fetchJson(
          `${stripTrailingSlash(options.controlBaseUrl)}/v1/workers/enrollments/${encodeURIComponent(options.enrollmentId)}/progress`,
          {
            method: "POST",
            headers: {
              "X-Quack-Service-Token": options.workerToken,
            },
            body: JSON.stringify({
              events: [
                {
                  phase,
                  state,
                  message,
                  detail: eventOptions.detail,
                  metadata: eventOptions.metadata,
                },
              ],
              capabilityResults: eventOptions.capabilityResults,
            }),
          },
        );
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to report worker enrollment progress (${phase}/${state}): ${reason}`);
      }
    },
  };
}

function runSyncOrThrow(command: WorkerInstallCommand, cwd: string, dryRun = false): void {
  const printable = [command.cmd, ...(command.args ?? [])].join(" ");
  console.log(`  ${dryRun ? "[dry-run] " : ""}${printable}`);
  if (dryRun) return;
  const result = spawnSyncResolved(command.cmd, command.args ?? [], {
    cwd: command.cwd ? path.resolve(cwd, command.cwd) : cwd,
    env: command.env ? { ...process.env, ...command.env } : process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${printable}`);
  }
}

function runSyncResult(
  command: WorkerInstallCommand,
  cwd: string,
  dryRun = false,
): { ok: true } | { ok: false; message: string } {
  const printable = [command.cmd, ...(command.args ?? [])].join(" ");
  console.log(`  ${dryRun ? "[dry-run] " : ""}${printable}`);
  if (dryRun) return { ok: true };
  const result = spawnSyncResolved(command.cmd, command.args ?? [], {
    cwd: command.cwd ? path.resolve(cwd, command.cwd) : cwd,
    env: command.env ? { ...process.env, ...command.env } : process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, message: `Command failed (${result.status}): ${printable}` };
  }
  return { ok: true };
}

function commandCandidates(command: string): string[] {
  if (process.platform !== "win32" || path.extname(command)) {
    return [command];
  }
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

function spawnSyncResolved(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
): ReturnType<typeof spawnSync> {
  let lastResult: ReturnType<typeof spawnSync> | undefined;
  for (const candidate of commandCandidates(command)) {
    const result = /\.(cmd|bat)$/i.test(candidate)
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", candidate, ...args], options)
      : spawnSync(candidate, args, options);
    lastResult = result;
    if (result.error && "code" in result.error && result.error.code === "ENOENT") {
      continue;
    }
    return result;
  }
  return lastResult ?? spawnSync(command, args, options);
}

function runPrerequisiteChecks(
  manifest: WorkerEnrollmentManifest,
  cwd: string,
  dryRun = false,
): void {
  for (const prerequisite of manifest.prerequisites) {
    if (!prerequisite.checkCommand) continue;
    console.log(`Checking prerequisite: ${prerequisite.label}`);
    const result = runSyncResult(prerequisite.checkCommand, cwd, dryRun);
    if (result.ok) continue;
    if (prerequisite.required) {
      throw new Error(`Required prerequisite failed: ${prerequisite.label}. ${result.message}`);
    }
    console.warn(`Optional prerequisite failed: ${prerequisite.label}. ${result.message}`);
  }
}

function runCapabilityProbes(
  manifest: WorkerEnrollmentManifest,
  repoPaths: Map<string, string>,
  dryRun = false,
): {
  advertisedCapabilities: string[];
  results: WorkerCapabilityProbeResult[];
} {
  const requested = [...manifest.worker.capabilities];
  const deferredCapabilities = new Set(["dispatch", "verify", "fix"]);
  const probeSpecs = manifest.projects.flatMap((project) =>
    (project.capabilityProbes ?? []).map((probe) => ({
      projectId: project.id,
      repoPath: repoPaths.get(project.repoId),
      probe,
    })),
  );

  const results: WorkerCapabilityProbeResult[] = [];
  const advertised = new Set<string>();
  for (const capability of requested) {
    if (deferredCapabilities.has(capability)) {
      advertised.add(capability);
      results.push({
        capability,
        status: "deferred",
        message: "Execution capability is guarded by the local runtime and listener heartbeat.",
      });
      continue;
    }

    const probes = probeSpecs.filter((entry) => entry.probe.capability === capability);
    if (probes.length === 0) {
      results.push({
        capability,
        status: "withheld",
        message:
          "No capability probe is defined for this label, so it stays withheld until the worker profile is upgraded.",
      });
      continue;
    }

    let allPassed = true;
    for (const { projectId, repoPath, probe } of probes) {
      if (!repoPath) {
        allPassed = false;
        results.push({
          capability,
          projectId,
          status: "failed",
          message: `Repo path missing for capability probe ${capability}.`,
          command: probe.command,
        });
        continue;
      }
      console.log(`Probing capability ${capability} on ${projectId}...`);
      const result = runSyncResult(probe.command, repoPath, dryRun);
      if (!result.ok) {
        allPassed = false;
        results.push({
          capability,
          projectId,
          status: "failed",
          message: result.message,
          command: probe.command,
        });
      } else {
        results.push({
          capability,
          projectId,
          status: "passed",
          message: probe.description || `Capability probe passed for ${capability}.`,
          command: probe.command,
        });
      }
    }

    if (allPassed) {
      advertised.add(capability);
    }
  }

  return {
    advertisedCapabilities: requested.filter((capability) => advertised.has(capability)),
    results,
  };
}

function git(repoPath: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: repoPath,
    stdio: "inherit",
  });
}

function gitText(repoPath: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function parseAheadBehind(value: string | undefined): { ahead: number; behind: number } {
  if (!value) return { ahead: 0, behind: 0 };
  const [aheadRaw, behindRaw] = value.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
  };
}

function inspectRepoFreshness(
  repo: WorkerEnrollmentManifest["repos"][number],
  destination: string,
  fastForwarded = false,
): WorkerRepoFreshness {
  const gitDir = path.join(destination, ".git");
  if (!fs.existsSync(gitDir)) {
    return {
      repoId: repo.id,
      label: repo.label,
      sourceUrl: repo.sourceUrl,
      expectedBranch: repo.branch,
      path: destination,
      exists: false,
      dirty: false,
      ahead: 0,
      behind: 0,
      fastForwarded,
      status: "missing",
      blockers: repo.required ? [`${repo.label} has not been cloned to ${destination}.`] : [],
      repairCommand: `git clone --branch ${repo.branch} ${repo.sourceUrl} ${destination}`,
    };
  }

  const currentBranch = gitText(destination, ["branch", "--show-current"]);
  const localCommit = gitText(destination, ["rev-parse", "HEAD"]);
  const remoteCommit = gitText(destination, ["rev-parse", `origin/${repo.branch}`]);
  const dirty = Boolean(gitText(destination, ["status", "--porcelain"]));
  const { ahead, behind } = parseAheadBehind(
    gitText(destination, ["rev-list", "--left-right", "--count", `HEAD...origin/${repo.branch}`]),
  );
  const blockers: string[] = [];
  let status: WorkerRepoFreshness["status"] = "current";

  if (currentBranch !== repo.branch) {
    status = "wrong_branch";
    blockers.push(
      `${repo.label} is on ${currentBranch || "(detached)"} instead of ${repo.branch}.`,
    );
  } else if (dirty) {
    status = "dirty";
    blockers.push(`${repo.label} has uncommitted changes.`);
  } else if (ahead > 0 && behind > 0) {
    status = "diverged";
    blockers.push(
      `${repo.label} diverged from origin/${repo.branch} (${ahead} ahead, ${behind} behind).`,
    );
  } else if (ahead > 0) {
    status = "ahead";
    blockers.push(`${repo.label} is ${ahead} commit(s) ahead of origin/${repo.branch}.`);
  } else if (behind > 0) {
    status = "behind";
    blockers.push(`${repo.label} is ${behind} commit(s) behind origin/${repo.branch}.`);
  }

  return {
    repoId: repo.id,
    label: repo.label,
    sourceUrl: repo.sourceUrl,
    expectedBranch: repo.branch,
    path: destination,
    exists: true,
    currentBranch,
    localCommit,
    remoteCommit,
    dirty,
    ahead,
    behind,
    fastForwarded,
    status,
    blockers,
    repairCommand:
      blockers.length > 0
        ? `git -C ${destination} status --short && git -C ${destination} fetch origin ${repo.branch}`
        : undefined,
  };
}

function syncRepo(
  repo: WorkerEnrollmentManifest["repos"][number],
  workerRoot: string,
  dryRun = false,
): { repoPath: string; freshness: WorkerRepoFreshness } {
  const destination = path.resolve(workerRoot, repo.destination);
  const gitDir = path.join(destination, ".git");
  console.log(`${fs.existsSync(gitDir) ? "Updating" : "Cloning"} ${repo.label} -> ${destination}`);
  if (dryRun) {
    return {
      repoPath: destination,
      freshness: {
        repoId: repo.id,
        label: repo.label,
        sourceUrl: repo.sourceUrl,
        expectedBranch: repo.branch,
        path: destination,
        exists: fs.existsSync(gitDir),
        dirty: false,
        ahead: 0,
        behind: 0,
        fastForwarded: false,
        status: fs.existsSync(gitDir) ? "unknown" : "missing",
        blockers: [],
        repairCommand: `node dist/index.js worker install --control-base-url <headnode> --bootstrap-token <fresh-qenr-token> --target-root ${workerRoot} --repair --start`,
      },
    };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(gitDir)) {
    execFileSync("git", ["clone", "--branch", repo.branch, repo.sourceUrl, destination], {
      stdio: "inherit",
    });
    return {
      repoPath: destination,
      freshness: inspectRepoFreshness(repo, destination),
    };
  }

  git(destination, ["fetch", "origin", repo.branch]);
  const before = inspectRepoFreshness(repo, destination);
  if (before.status === "behind") {
    const beforeCommit = before.localCommit;
    git(destination, ["pull", "--ff-only", "origin", repo.branch]);
    const after = inspectRepoFreshness(
      repo,
      destination,
      beforeCommit !== gitText(destination, ["rev-parse", "HEAD"]),
    );
    return { repoPath: destination, freshness: after };
  }
  return { repoPath: destination, freshness: before };
}

function detectListenerBaseUrl(runtimePort: number, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  try {
    const ip = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (ip) {
      return `http://${ip}:${runtimePort}`;
    }
  } catch {
    // Fall back to localhost-only.
  }
  return `http://localhost:${runtimePort}`;
}

function parseEnvFile(envFile: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(envFile, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

function writeProjectEnvStubFiles(
  manifest: WorkerEnrollmentManifest,
  projectPaths: Record<string, string>,
): string[] {
  const envTemplate = manifest.env.map((entry) => {
    if (entry.mode === "inline") {
      return `${entry.name}=${entry.value ?? ""}`;
    }
    return `${entry.name}=${entry.placeholder ?? ""}`;
  });
  if (envTemplate.length === 0) {
    return [];
  }

  const written: string[] = [];
  for (const project of manifest.projects) {
    const repoPath = projectPaths[project.pathAlias];
    if (!repoPath) continue;
    const stubPath = path.join(repoPath, ".env.quack-worker");
    const lines = [
      `# Quack worker stub for ${manifest.worker.hostId}`,
      "# Merge this with the project's committed .env.example / .env.test.example as needed.",
      ...manifest.manualSteps.map((step) => `# Manual: ${step}`),
      ...envTemplate,
      "",
    ];
    fs.writeFileSync(stubPath, lines.join("\n"), "utf-8");
    written.push(stubPath);
  }
  return written;
}

async function writePrimaryProjectPeerConfigs(
  manifest: WorkerEnrollmentManifest,
  projectPaths: Record<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const project of manifest.projects) {
    if (!project.primary) continue;
    const projectRoot = projectPaths[project.pathAlias];
    if (!projectRoot) continue;
    const configPath = await writeFederationPeerConfig(projectRoot, {
      url: manifest.controlPlane.baseUrl,
      remoteProjectId: project.id,
      serviceTokenEnv: "QUACK_SERVICE_TOKEN",
      syncIntervalMs: 300_000,
      syncOnStartup: true,
      pushOnWrite: false,
      limit: 250,
    });
    written.push(configPath);
  }
  return written;
}

function writeWorkerEnvFiles(
  workerRoot: string,
  quackRepoPath: string,
  manifest: WorkerEnrollmentManifest,
  workerToken: WorkerEnrollmentBootstrapResponse["workerToken"],
  projectPaths: Record<string, string>,
  listenerBaseUrl: string,
  advertisedCapabilities: string[],
  capabilityResults: WorkerCapabilityProbeResult[],
  repoFreshness: WorkerRepoFreshness[],
  readiness: WorkerEnrollmentReadiness,
): {
  envFile: string;
  projectEnvFile: string;
  capabilityReportFile: string;
  projectEnvStubFiles: string[];
} {
  const quackStateDir = path.join(quackRepoPath, ".quack");
  fs.mkdirSync(quackStateDir, { recursive: true });

  const localRuntimeUrl = `http://localhost:${manifest.worker.runtimePort}`;
  const envFile = path.join(quackStateDir, `${manifest.worker.hostId}-worker.env`);
  const capabilityReportFile = path.join(
    quackStateDir,
    `${manifest.worker.hostId}-capabilities.json`,
  );
  const envLines = [
    `QUACK_BASE_URL=${manifest.controlPlane.baseUrl}`,
    `QUACK_SERVICE_TOKEN=${workerToken.token}`,
    `QUACK_HOST_ID=${manifest.worker.hostId}`,
    `QUACK_ALIAS=${manifest.worker.alias}`,
    `QUACK_LISTENER_BASE_URL=${listenerBaseUrl}`,
    `QUACK_CAPABILITIES=${advertisedCapabilities.join(",")}`,
    `QUACK_REQUESTED_CAPABILITIES=${manifest.worker.capabilities.join(",")}`,
    `QUACK_REPO_PATH=${quackRepoPath}`,
    `QUACK_LOCAL_RUNTIME_URL=${localRuntimeUrl}`,
    `QUACK_MAX_CONCURRENT_JOBS=${manifest.worker.maxConcurrentJobs}`,
    `QUACK_WORKER_POLL_MS=${manifest.worker.pollMs}`,
    `QUACK_PROJECT_PATHS_JSON=${JSON.stringify(projectPaths)}`,
    `QUACK_CAPABILITY_REPORT_PATH=${capabilityReportFile}`,
  ];
  fs.writeFileSync(envFile, envLines.join("\n") + "\n", "utf-8");

  fs.writeFileSync(
    capabilityReportFile,
    JSON.stringify(
      {
        requestedCapabilities: manifest.worker.capabilities,
        advertisedCapabilities,
        results: capabilityResults,
        repoFreshness,
        readiness,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  const projectEnvFile = path.join(quackStateDir, `${manifest.worker.hostId}-project.env`);
  const envTemplate = manifest.env.map((entry) => {
    if (entry.mode === "inline") {
      return `${entry.name}=${entry.value ?? ""}`;
    }
    return `${entry.name}=${entry.placeholder ?? ""}`;
  });
  fs.writeFileSync(
    projectEnvFile,
    envTemplate.join("\n") + (envTemplate.length > 0 ? "\n" : ""),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(quackStateDir, `${manifest.enrollmentId}-manifest.json`),
    JSON.stringify({ workerRoot, manifest, workerTokenId: workerToken.id }, null, 2) + "\n",
    "utf-8",
  );

  const projectEnvStubFiles = writeProjectEnvStubFiles(manifest, projectPaths);
  return { envFile, projectEnvFile, capabilityReportFile, projectEnvStubFiles };
}

function resolvePrimaryProject(
  manifest: WorkerEnrollmentManifest,
): WorkerEnrollmentManifest["projects"][number] {
  return manifest.projects.find((project) => project.primary) ?? manifest.projects[0];
}

function persistenceForWindowsScript(
  persistence: WorkerEnrollmentManifest["worker"]["persistence"],
): "Auto" | "RunKey" | "ScheduledTaskLogon" | "ScheduledTaskStartup" {
  switch (persistence) {
    case "run-key":
      return "RunKey";
    case "scheduled-task-logon":
      return "ScheduledTaskLogon";
    case "scheduled-task-startup":
      return "ScheduledTaskStartup";
    default:
      return "Auto";
  }
}

function runtimeArgsForProjects(
  manifest: WorkerEnrollmentManifest,
  projectPaths: Record<string, string>,
): string[] {
  const runtimeArgs = [
    "./dist/index.js",
    "worker-runtime",
    "--host",
    "127.0.0.1",
    "--port",
    String(manifest.worker.runtimePort),
  ];
  for (const projectPath of Object.values(projectPaths)) {
    runtimeArgs.push("--project", projectPath);
  }
  return runtimeArgs;
}

function spawnDetachedWorkerRuntime(
  quackRepoPath: string,
  manifest: WorkerEnrollmentManifest,
  projectPaths: Record<string, string>,
  envFile: string,
): void {
  const env = {
    ...process.env,
    ...parseEnvFile(envFile),
  };

  const runtime = spawn("node", runtimeArgsForProjects(manifest, projectPaths), {
    cwd: quackRepoPath,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runtime.unref();
}

function spawnDetachedListenerDaemon(quackRepoPath: string, envFile: string): void {
  const listener = spawn("node", ["./scripts/quack-listener.mjs", "daemon"], {
    cwd: quackRepoPath,
    env: {
      ...process.env,
      ...parseEnvFile(envFile),
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  listener.unref();
}

function runListenerOnce(quackRepoPath: string, envFile: string): void {
  const listener = spawnSync("node", ["./scripts/quack-listener.mjs", "once", "--json"], {
    cwd: quackRepoPath,
    env: {
      ...process.env,
      ...parseEnvFile(envFile),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  if (listener.error) {
    throw listener.error;
  }
  if (listener.status !== 0) {
    throw new Error(`Listener bootstrap handshake exited with code ${listener.status}.`);
  }
}

function printWorkerInstallSummary(options: {
  enrollmentId: string;
  workerRoot: string;
  quackRepoPath: string;
  runtimePort: number;
  listenerBaseUrl: string;
  envFile: string;
  projectEnvFile: string;
  capabilityReportFile: string;
  projectEnvStubFiles: string[];
  peerConfigFiles: string[];
  requestedCapabilities: string[];
  advertisedCapabilities: string[];
  repoFreshness: WorkerRepoFreshness[];
  readiness: WorkerEnrollmentReadiness;
  manualSteps: string[];
  repair: boolean;
}): void {
  console.log("");
  console.log(
    `${options.repair ? "Worker repair" : "Worker enrollment"} ${options.enrollmentId} prepared.`,
  );
  console.log(`  Worker root:   ${options.workerRoot}`);
  console.log(`  Quack repo:    ${options.quackRepoPath}`);
  console.log(`  Runtime:       http://127.0.0.1:${options.runtimePort}/api/health`);
  console.log(`  Listener URL:  ${options.listenerBaseUrl}`);
  console.log(`  Env file:      ${options.envFile}`);
  console.log(`  Project env:   ${options.projectEnvFile}`);
  console.log(`  Capability report: ${options.capabilityReportFile}`);
  if (options.peerConfigFiles.length > 0) {
    console.log("  Federation peer config:");
    for (const peerConfigPath of options.peerConfigFiles) {
      console.log(`    - ${peerConfigPath}`);
    }
  }
  if (options.projectEnvStubFiles.length > 0) {
    console.log("  Project env stubs:");
    for (const stubPath of options.projectEnvStubFiles) {
      console.log(`    - ${stubPath}`);
    }
  }
  console.log(`  Requested capabilities:  ${options.requestedCapabilities.join(", ")}`);
  console.log(
    `  Advertised capabilities: ${options.advertisedCapabilities.join(", ") || "(none)"}`,
  );
  console.log(
    `  Readiness: ${options.readiness.status} (${options.readiness.score}/100), trusted=${options.readiness.trustedForWork ? "yes" : "no"}`,
  );
  if (options.readiness.blockedCapabilities.length > 0) {
    console.log(`  Blocked capabilities: ${options.readiness.blockedCapabilities.join(", ")}`);
  }
  if (options.repoFreshness.length > 0) {
    console.log("  Repo freshness:");
    for (const repo of options.repoFreshness) {
      const branch =
        repo.currentBranch && repo.currentBranch !== repo.expectedBranch
          ? `${repo.currentBranch} (expected ${repo.expectedBranch})`
          : repo.expectedBranch;
      const delta =
        repo.status === "current"
          ? "current"
          : `${repo.status}${repo.behind || repo.ahead ? ` (${repo.ahead} ahead, ${repo.behind} behind)` : ""}`;
      console.log(`    - ${repo.label} -> ${branch}: ${delta}`);
      for (const blocker of repo.blockers) {
        console.log(`      blocker: ${blocker}`);
      }
    }
  }
  if (options.readiness.repairActions.length > 0) {
    console.log("  Repair / retry:");
    for (const action of options.readiness.repairActions) {
      console.log(`    - ${action.label}: ${action.command}`);
    }
  }
  if (options.manualSteps.length > 0) {
    console.log("  Manual steps:");
    for (const step of options.manualSteps) {
      console.log(`    - ${step}`);
    }
  }
}

async function waitForLocalRuntimeHealth(
  runtimePort: number,
  timeoutMs = 45_000,
): Promise<boolean> {
  const healthUrl = `http://127.0.0.1:${runtimePort}/api/health`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // Wait and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function waitForHeadnodeListener(
  controlBaseUrl: string,
  workerToken: string,
  hostId: string,
  timeoutMs = 45_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchJson<{ listeners?: Array<{ id: string; healthy?: boolean }> }>(
        `${stripTrailingSlash(controlBaseUrl)}/v1/listeners`,
        {
          headers: {
            "X-Quack-Service-Token": workerToken,
          },
        },
      );
      if (
        response.listeners?.some((listener) => listener.id === hostId && listener.healthy !== false)
      ) {
        return true;
      }
    } catch {
      // Wait and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

export async function workerInstallCommand(options: WorkerInstallCliOptions): Promise<void> {
  if (!options.bootstrapToken?.trim()) {
    throw new Error("Missing --bootstrap-token.");
  }
  const controlBaseUrl = options.controlBaseUrl?.trim() || "http://127.0.0.1:3333";
  const workerRoot = guessWorkerRoot(options.targetRoot);
  const start = options.start !== false;
  const dryRun = options.dryRun === true;

  console.log(`Fetching worker bootstrap manifest from ${controlBaseUrl}...`);
  const bootstrap = await fetchJson<WorkerEnrollmentBootstrapResponse>(
    `${controlBaseUrl.replace(/\/+$/, "")}/v1/workers/bootstrap`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.bootstrapToken}`,
      },
      body: JSON.stringify({}),
    },
  );

  const manifest = bootstrap.manifest;
  const reporter = createProgressReporter({
    controlBaseUrl,
    enrollmentId: bootstrap.session.enrollmentId,
    workerToken: bootstrap.workerToken.token,
    dryRun,
  });
  const repoPaths = new Map<string, string>();
  let repoFreshness: WorkerRepoFreshness[] = repoFreshnessFromManifest(manifest, workerRoot);
  fs.mkdirSync(workerRoot, { recursive: true });
  let currentPhase: WorkerEnrollmentProgressPhase = "bootstrap";

  try {
    await reporter.report(
      "bootstrap",
      "completed",
      "Bootstrap manifest fetched and worker token issued.",
    );

    currentPhase = "prerequisites";
    await reporter.report("prerequisites", "running", "Checking worker prerequisites.");
    runPrerequisiteChecks(manifest, workerRoot, dryRun);
    await reporter.report("prerequisites", "completed", "Prerequisite checks passed.");

    currentPhase = "repo_sync";
    await reporter.report("repo_sync", "running", "Syncing Quack and project repositories.", {
      metadata: {
        repoCount: manifest.repos.length,
        repairMode: options.repair === true,
      },
    });
    if (options.repair) {
      console.log(`Refreshing existing worker root: ${workerRoot}`);
    } else {
      console.log(`Preparing worker root: ${workerRoot}`);
    }
    for (const repo of manifest.repos) {
      const synced = syncRepo(repo, workerRoot, dryRun);
      const repoPath = synced.repoPath;
      repoFreshness = repoFreshness
        .filter((entry) => entry.repoId !== repo.id)
        .concat(synced.freshness);
      repoPaths.set(repo.id, repoPath);
      if (!dryRun) {
        registerProject(repoPath, { autoPrep: false, autoPreflight: false });
      }
    }
    await reporter.report("repo_sync", "completed", "Repository sync completed.", {
      metadata: { repoFreshness },
    });

    currentPhase = "dependency_install";
    await reporter.report(
      "dependency_install",
      "running",
      "Running project install and probe commands.",
    );
    for (const project of manifest.projects) {
      const repoPath = repoPaths.get(project.repoId);
      if (!repoPath) {
        throw new Error(`Manifest repo ${project.repoId} is missing for project ${project.id}.`);
      }
      console.log(`Running install commands for ${project.label}...`);
      for (const command of project.installCommands) {
        runSyncOrThrow(command, repoPath, dryRun);
      }
      if (project.probeCommands.length > 0) {
        console.log(`Running project probe commands for ${project.label}...`);
        for (const command of project.probeCommands) {
          runSyncOrThrow(command, repoPath, dryRun);
        }
      }
    }
    await reporter.report(
      "dependency_install",
      "completed",
      "Project install and readiness probes completed.",
    );

    currentPhase = "capability_probe";
    await reporter.report(
      "capability_probe",
      "running",
      "Computing advertised capabilities from manifest probes.",
    );
    const capabilityProbe = runCapabilityProbes(manifest, repoPaths, dryRun);
    const repoExecutionBlocked = repoFreshness.some((repo) => repo.blockers.length > 0);
    const effectiveAdvertisedCapabilities = repoExecutionBlocked
      ? capabilityProbe.advertisedCapabilities.filter(
          (capability) => !["dispatch", "verify", "fix"].includes(capability),
        )
      : capabilityProbe.advertisedCapabilities;
    await reporter.report(
      "capability_probe",
      "completed",
      `Capability probes complete. Advertising ${effectiveAdvertisedCapabilities.join(", ") || "no optional capabilities"}.`,
      {
        metadata: {
          requestedCapabilities: manifest.worker.capabilities,
          advertisedCapabilities: effectiveAdvertisedCapabilities,
        },
        capabilityResults: capabilityProbe.results,
      },
    );

    const quackRepoPath = repoPaths.get("quack") || repoPaths.values().next().value;
    if (!quackRepoPath) {
      throw new Error("Manifest does not include a Quack repo checkout.");
    }

    const projectPathMap = Object.fromEntries(
      manifest.projects
        .map((project) => [project.pathAlias, repoPaths.get(project.repoId)] as const)
        .filter(([, value]) => !!value),
    ) as Record<string, string>;
    projectPathMap.quack = quackRepoPath;

    const listenerBaseUrl = detectListenerBaseUrl(
      manifest.worker.runtimePort,
      options.listenerBaseUrl,
    );
    const readinessBeforeStart = deriveWorkerEnrollmentReadiness({
      manifest,
      installStatus: {
        state: dryRun ? "installing" : "bootstrap_consumed",
        progressPercent: dryRun ? 90 : 80,
        currentStep: "capability_probe",
        bootstrapConsumed: true,
        listenerRegistered: false,
        listenerHealthy: false,
        runtimeHealthy: false,
        manualFollowUpPending: manifest.manualSteps.length > 0,
        manualFollowUpCount: manifest.manualSteps.length,
        requestedCapabilities: manifest.worker.capabilities,
        advertisedCapabilities: effectiveAdvertisedCapabilities,
        capabilityWarnings: capabilityProbe.results
          .filter((result) => result.status === "failed" || result.status === "withheld")
          .map((result) => `${result.capability}: ${result.message}`),
      },
      progressEvents: [],
      capabilityResults: capabilityProbe.results,
      repoFreshness,
      repairCommand: `node dist/index.js worker install --control-base-url ${manifest.controlPlane.baseUrl} --bootstrap-token <fresh-qenr-token> --target-root ${workerRoot} --repair --start`,
    });

    currentPhase = "env_write";
    await reporter.report(
      "env_write",
      "running",
      "Writing worker env files and project-local stubs.",
    );
    const { envFile, projectEnvFile, capabilityReportFile, projectEnvStubFiles } = dryRun
      ? {
          envFile: path.join(quackRepoPath, ".quack", `${manifest.worker.hostId}-worker.env`),
          projectEnvFile: path.join(
            quackRepoPath,
            ".quack",
            `${manifest.worker.hostId}-project.env`,
          ),
          capabilityReportFile: path.join(
            quackRepoPath,
            ".quack",
            `${manifest.worker.hostId}-capabilities.json`,
          ),
          projectEnvStubFiles: manifest.projects.map((project) =>
            path.join(projectPathMap[project.pathAlias] || workerRoot, ".env.quack-worker"),
          ),
        }
      : writeWorkerEnvFiles(
          workerRoot,
          quackRepoPath,
          manifest,
          bootstrap.workerToken,
          projectPathMap,
          listenerBaseUrl,
          effectiveAdvertisedCapabilities,
          capabilityProbe.results,
          repoFreshness,
          readinessBeforeStart,
        );
    const peerConfigFiles = dryRun
      ? manifest.projects
          .filter((project) => project.primary)
          .map((project) =>
            path.join(
              projectPathMap[project.pathAlias] || workerRoot,
              ".quack",
              "federation",
              "peer.json",
            ),
          )
      : await writePrimaryProjectPeerConfigs(manifest, projectPathMap);
    await reporter.report(
      "env_write",
      "completed",
      "Worker env files and project-local stubs written.",
      {
        metadata: {
          envFile,
          projectEnvFile,
          capabilityReportFile,
          projectEnvStubFiles,
          peerConfigFiles,
        },
      },
    );

    const primaryProject = resolvePrimaryProject(manifest);
    if (!primaryProject) {
      throw new Error("Manifest does not contain a primary project.");
    }

    if (!dryRun && start) {
      currentPhase = "runtime_start";
      await reporter.report("runtime_start", "running", "Starting the local worker runtime.");

      if (process.platform === "win32" && manifest.worker.persistence !== "manual") {
        const scriptPath = path.join(
          quackRepoPath,
          "scripts",
          "admin",
          "install-windows-worker.ps1",
        );
        const primaryProjectPath = projectPathMap[primaryProject.pathAlias];
        if (!primaryProjectPath) {
          throw new Error(`Primary project path missing for ${primaryProject.id}.`);
        }
        const args = [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-HostId",
          manifest.worker.hostId,
          "-Alias",
          manifest.worker.alias,
          "-ServiceToken",
          bootstrap.workerToken.token,
          "-PrimaryProjectPath",
          primaryProjectPath,
          "-ControlBaseUrl",
          manifest.controlPlane.baseUrl,
          "-RepoPath",
          quackRepoPath,
          "-PrimaryProjectKey",
          primaryProject.pathAlias,
          "-PrimaryProjectAlias",
          primaryProject.id,
          "-ListenerBaseUrl",
          listenerBaseUrl,
          "-LocalMonitorUrl",
          `http://localhost:${manifest.worker.runtimePort}`,
          "-Capabilities",
          effectiveAdvertisedCapabilities.join(","),
          "-RequestedCapabilities",
          manifest.worker.capabilities.join(","),
          "-CapabilityReportPath",
          capabilityReportFile,
          "-MonitorPort",
          String(manifest.worker.runtimePort),
          "-MaxConcurrentJobs",
          String(manifest.worker.maxConcurrentJobs),
          "-WorkerPollMs",
          String(manifest.worker.pollMs),
          "-Persistence",
          persistenceForWindowsScript(options.persistence || manifest.worker.persistence),
        ];
        console.log("Configuring Windows persistence + startup helper...");
        const install = spawnSync("powershell.exe", args, {
          cwd: quackRepoPath,
          stdio: "inherit",
          windowsHide: true,
        });
        if (install.error) throw install.error;
        if (install.status !== 0) {
          throw new Error(`Windows worker installer exited with code ${install.status}.`);
        }
      } else {
        spawnDetachedWorkerRuntime(quackRepoPath, manifest, projectPathMap, envFile);
      }
      await reporter.report(
        "runtime_start",
        "completed",
        "Worker runtime start command completed.",
      );

      currentPhase = "runtime_health";
      await reporter.report(
        "runtime_health",
        "running",
        "Waiting for the local worker runtime health endpoint.",
      );
      const runtimeHealthy = await waitForLocalRuntimeHealth(manifest.worker.runtimePort);
      if (!runtimeHealthy) {
        throw new Error(
          `Local worker runtime did not become healthy on port ${manifest.worker.runtimePort}.`,
        );
      }
      await reporter.report("runtime_health", "completed", "Local worker runtime is healthy.");

      currentPhase = "listener_register";
      await reporter.report(
        "listener_register",
        "running",
        "Registering the listener with the headnode.",
      );
      if (!(process.platform === "win32" && manifest.worker.persistence !== "manual")) {
        runListenerOnce(quackRepoPath, envFile);
        spawnDetachedListenerDaemon(quackRepoPath, envFile);
      }
      const listenerRegistered = await waitForHeadnodeListener(
        manifest.controlPlane.baseUrl,
        bootstrap.workerToken.token,
        manifest.worker.hostId,
      );
      if (!listenerRegistered) {
        throw new Error(
          `Headnode did not observe listener ${manifest.worker.hostId} within the expected time window.`,
        );
      }
      await reporter.report(
        "listener_register",
        "completed",
        "Listener registered and checked in with the headnode.",
        {
          metadata: {
            listenerBaseUrl,
          },
        },
      );

      currentPhase = "completed";
      const finalReadiness = deriveWorkerEnrollmentReadiness({
        manifest,
        installStatus: {
          state: "healthy",
          progressPercent: 100,
          currentStep: "completed",
          bootstrapConsumed: true,
          listenerRegistered: true,
          listenerHealthy: true,
          runtimeHealthy: true,
          manualFollowUpPending: manifest.manualSteps.length > 0,
          manualFollowUpCount: manifest.manualSteps.length,
          requestedCapabilities: manifest.worker.capabilities,
          advertisedCapabilities: effectiveAdvertisedCapabilities,
          capabilityWarnings: capabilityProbe.results
            .filter((result) => result.status === "failed" || result.status === "withheld")
            .map((result) => `${result.capability}: ${result.message}`),
        },
        progressEvents: [],
        capabilityResults: capabilityProbe.results,
        repoFreshness,
        repairCommand: `node dist/index.js worker install --control-base-url ${manifest.controlPlane.baseUrl} --bootstrap-token <fresh-qenr-token> --target-root ${workerRoot} --repair --start`,
      });
      await reporter.report("completed", "completed", "Worker install completed successfully.", {
        metadata: {
          advertisedCapabilities: effectiveAdvertisedCapabilities,
          readiness: finalReadiness,
          repoFreshness,
          repairMode: options.repair === true,
        },
        capabilityResults: capabilityProbe.results,
      });

      printWorkerInstallSummary({
        enrollmentId: bootstrap.session.enrollmentId,
        workerRoot,
        quackRepoPath,
        runtimePort: manifest.worker.runtimePort,
        listenerBaseUrl,
        envFile,
        projectEnvFile,
        capabilityReportFile,
        projectEnvStubFiles,
        peerConfigFiles,
        requestedCapabilities: manifest.worker.capabilities,
        advertisedCapabilities: effectiveAdvertisedCapabilities,
        repoFreshness,
        readiness: finalReadiness,
        manualSteps: manifest.manualSteps,
        repair: options.repair === true,
      });
      return;
    }

    await reporter.report(
      "completed",
      start ? "waiting" : "completed",
      start
        ? "Dry-run completed. Re-run without --dry-run to write files and start the worker."
        : "Install files prepared without starting the worker.",
      {
        metadata: {
          requestedCapabilities: manifest.worker.capabilities,
          advertisedCapabilities: effectiveAdvertisedCapabilities,
          readiness: readinessBeforeStart,
          repoFreshness,
          repairMode: options.repair === true,
        },
        capabilityResults: capabilityProbe.results,
      },
    );

    printWorkerInstallSummary({
      enrollmentId: bootstrap.session.enrollmentId,
      workerRoot,
      quackRepoPath,
      runtimePort: manifest.worker.runtimePort,
      listenerBaseUrl,
      envFile,
      projectEnvFile,
      capabilityReportFile,
      projectEnvStubFiles,
      peerConfigFiles,
      requestedCapabilities: manifest.worker.capabilities,
      advertisedCapabilities: effectiveAdvertisedCapabilities,
      repoFreshness,
      readiness: readinessBeforeStart,
      manualSteps: manifest.manualSteps,
      repair: options.repair === true,
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    await reporter.report(currentPhase, "failed", reason);
    throw err;
  }
}
