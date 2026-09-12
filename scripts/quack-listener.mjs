#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3333";
const DEFAULT_LOCAL_RUNTIME_URL = "http://localhost:3337";
const WORKER_COMMAND_PROTOCOL_VERSION = "worker-command-v1";

function usage(exitCode = 0) {
  console.log(
    `
Usage:
  node scripts/quack-listener.mjs register [options]
  node scripts/quack-listener.mjs heartbeat [options]
  node scripts/quack-listener.mjs jobs [options]
  node scripts/quack-listener.mjs commands [options]
  node scripts/quack-listener.mjs ack --command-id ID [options]
  node scripts/quack-listener.mjs work [options]
  node scripts/quack-listener.mjs daemon [options]
  node scripts/quack-listener.mjs once [options]

Options:
  --base-url URL              Control monitor URL. Env: QUACK_BASE_URL
  --token TOKEN               Service token. Env: QUACK_SERVICE_TOKEN
  --host-id ID                Listener host id. Env: QUACK_HOST_ID
  --project-id ID             Headnode project id. Env: QUACK_PROJECT_ID
  --alias NAME                Human label. Env: QUACK_ALIAS
  --listener-url URL          This listener's URL. Env: QUACK_LISTENER_BASE_URL
  --capabilities csv          Capabilities. Env: QUACK_CAPABILITIES
  --project-path key=value    Repeatable project path entry.
  --repo-path PATH            Repo path for git commit probe. Env: QUACK_REPO_PATH
  --local-runtime-url URL     Local worker runtime URL. Env: QUACK_LOCAL_RUNTIME_URL
  --local-monitor-url URL     Legacy alias for --local-runtime-url. Env: QUACK_LOCAL_MONITOR_URL
  --max-concurrent N          Max jobs. Env: QUACK_MAX_CONCURRENT_JOBS
  --poll-ms N                 Worker poll interval. Env: QUACK_WORKER_POLL_MS
  --lease-renew-ms N          Lease renewal interval. Env: QUACK_LEASE_RENEW_MS
  --command-id ID             Command id to acknowledge; repeatable.
  --max-jobs N                Max jobs to process before daemon exits.
  --no-skip-gate              Run local dispatch gate even when Headnode assigned the job.
  --include-optional-verify   Run optional adapter verification commands for worker verify jobs.
  --json                      Print raw JSON.

Commands:
  register   POST /v1/listeners/register
  heartbeat  POST /v1/listeners/:hostId/heartbeat with load + commit probes
  jobs       GET /v1/listeners/:hostId/jobs
  commands   GET /v1/listeners/:hostId/commands
  ack        POST /v1/listeners/:hostId/commands/ack
  work       execute one assigned job via the local worker runtime and report evidence
  daemon     continuous heartbeat + job execution loop
  once       register, heartbeat, then commands
`.trim(),
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") usage(0);
  const options = {
    command,
    baseUrl: process.env.QUACK_BASE_URL || DEFAULT_BASE_URL,
    token: process.env.QUACK_SERVICE_TOKEN || "",
    hostId: process.env.QUACK_HOST_ID || "",
    projectId: process.env.QUACK_PROJECT_ID || "",
    alias: process.env.QUACK_ALIAS || "",
    listenerUrl: process.env.QUACK_LISTENER_BASE_URL || "",
    capabilities: csv(process.env.QUACK_CAPABILITIES || "intake,dispatch,verify,fix"),
    maxConcurrentJobs: Number(process.env.QUACK_MAX_CONCURRENT_JOBS || "1"),
    repoPath: process.env.QUACK_REPO_PATH || process.cwd(),
    localRuntimeUrl:
      process.env.QUACK_LOCAL_RUNTIME_URL ||
      process.env.QUACK_LOCAL_MONITOR_URL ||
      DEFAULT_LOCAL_RUNTIME_URL,
    projectPaths: parseProjectPathsJson(process.env.QUACK_PROJECT_PATHS_JSON),
    pollMs: Number(process.env.QUACK_WORKER_POLL_MS || "15000"),
    leaseRenewMs: Number(process.env.QUACK_LEASE_RENEW_MS || "60000"),
    commandIds: [],
    maxJobs: Number(process.env.QUACK_WORKER_MAX_JOBS || "0"),
    skipGate: process.env.QUACK_WORKER_SKIP_GATE !== "false",
    includeOptionalVerify: process.env.QUACK_WORKER_VERIFY_INCLUDE_OPTIONAL === "true",
    json: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--base-url") options.baseUrl = args.shift() || "";
    else if (arg === "--token") options.token = args.shift() || "";
    else if (arg === "--host-id") options.hostId = args.shift() || "";
    else if (arg === "--project-id") options.projectId = args.shift() || "";
    else if (arg === "--alias") options.alias = args.shift() || "";
    else if (arg === "--listener-url") options.listenerUrl = args.shift() || "";
    else if (arg === "--capabilities") options.capabilities = csv(args.shift() || "");
    else if (arg === "--max-concurrent") options.maxConcurrentJobs = Number(args.shift() || "1");
    else if (arg === "--repo-path") options.repoPath = args.shift() || "";
    else if (arg === "--local-runtime-url" || arg === "--local-monitor-url")
      options.localRuntimeUrl = args.shift() || "";
    else if (arg === "--poll-ms") options.pollMs = Number(args.shift() || "15000");
    else if (arg === "--lease-renew-ms") options.leaseRenewMs = Number(args.shift() || "60000");
    else if (arg === "--command-id") options.commandIds.push(args.shift() || "");
    else if (arg === "--max-jobs") options.maxJobs = Number(args.shift() || "0");
    else if (arg === "--no-skip-gate") options.skipGate = false;
    else if (arg === "--include-optional-verify") options.includeOptionalVerify = true;
    else if (arg === "--project-path") {
      const entry = args.shift() || "";
      const index = entry.indexOf("=");
      if (index <= 0) throw new Error("--project-path must be key=value");
      options.projectPaths[entry.slice(0, index)] = entry.slice(index + 1);
    } else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (
    !["register", "heartbeat", "jobs", "commands", "ack", "work", "daemon", "once"].includes(
      options.command,
    )
  ) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  if (!options.hostId) throw new Error("Missing --host-id or QUACK_HOST_ID.");
  if (!options.baseUrl) throw new Error("Missing --base-url or QUACK_BASE_URL.");
  return options;
}

function csv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProjectPathsJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function requestJson(options, method, pathName, body) {
  const response = await fetch(new URL(pathName, options.baseUrl), {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { "X-Quack-Service-Token": options.token } : {}),
      ...(options.projectId ? { "X-Project-Id": options.projectId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

function parseJsonText(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function localRequestTimeoutMs() {
  const raw = Number(process.env.QUACK_LOCAL_REQUEST_TIMEOUT_MS || "1200000");
  return Number.isFinite(raw) && raw > 0 ? raw : 1200000;
}

function requestLocalWithNodeHttp(url, method, body, additionalHeaders = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  const headers = {
    ...additionalHeaders,
    ...(payload
      ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        }
      : {}),
  };
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        const status = res.statusCode || 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          body: parseJsonText(text),
        });
      });
    });

    req.setTimeout(localRequestTimeoutMs(), () => {
      req.destroy(
        new Error(`Local worker runtime request timed out after ${localRequestTimeoutMs()}ms`),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function gitCommit(repoPath) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const WINDOWS_POSIX_TOOL_RE = /(?:^|[;&|()]\s*)(?:bash|sh|grep|sed|awk|xargs)\b/;

function runtimePlatform() {
  return process.env.QUACK_FORCE_PLATFORM || process.platform;
}

function splitWindowsPathList(value) {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function existingWindowsPosixDirs(env = process.env) {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const onlyConfigured = env.QUACK_POSIX_BIN_DIR_ONLY === "true";
  const configured = [
    ...splitWindowsPathList(env.QUACK_POSIX_BIN_DIR),
    env.QUACK_BASH_PATH ? path.win32.dirname(env.QUACK_BASH_PATH) : undefined,
  ].filter(Boolean);
  const defaults = onlyConfigured
    ? []
    : [
        path.win32.join(programFiles, "Git", "usr", "bin"),
        path.win32.join(programFiles, "Git", "bin"),
        path.win32.join(programFilesX86, "Git", "usr", "bin"),
        path.win32.join(programFilesX86, "Git", "bin"),
        "C:\\msys64\\usr\\bin",
      ];
  const seen = new Set();
  const dirs = [];

  for (const candidate of [...configured, ...defaults]) {
    const normalized = path.win32.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    if (
      existsSync(path.win32.join(normalized, "bash.exe")) ||
      existsSync(path.win32.join(normalized, "sh.exe")) ||
      existsSync(path.win32.join(normalized, "grep.exe"))
    ) {
      seen.add(key);
      dirs.push(normalized);
    }
  }

  return dirs;
}

function commandsNeedWindowsPosixToolchain(commands) {
  if (runtimePlatform() !== "win32") return false;
  return commands.some((command) =>
    WINDOWS_POSIX_TOOL_RE.test(String(command?.command || command || "").trim()),
  );
}

async function localCapabilityProbe(options) {
  let capabilities = [...options.capabilities];
  const requestedCapabilities = csv(
    process.env.QUACK_REQUESTED_CAPABILITIES || capabilities.join(","),
  );
  let capabilityReport;
  if (
    process.env.QUACK_CAPABILITY_REPORT_PATH &&
    existsSync(process.env.QUACK_CAPABILITY_REPORT_PATH)
  ) {
    try {
      capabilityReport = JSON.parse(
        readFileSync(process.env.QUACK_CAPABILITY_REPORT_PATH, "utf-8"),
      );
    } catch {
      capabilityReport = undefined;
    }
  }
  const metadata = {
    platform: runtimePlatform(),
    listenerVersion: "swarm-v2",
    runtimeRole: "worker",
    protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
    requestedCapabilities,
    advertisedCapabilities: capabilities,
    capabilityReport: capabilityReport?.results || undefined,
    capabilityWarning: null,
  };
  let effectiveMaxConcurrentJobs = options.maxConcurrentJobs;

  const executionCaps = new Set(["dispatch", "verify", "fix"]);
  const hasExecutionCap = capabilities.some((capability) => executionCaps.has(capability));
  if (!hasExecutionCap) return { capabilities, metadata, effectiveMaxConcurrentJobs };

  const health = await requestLocalJson(options, "GET", "/api/health");
  metadata.localRuntime = health.ok ? "online" : "offline";
  if (health.ok) {
    metadata.localRuntimeCommit = health.body?.commit;
    metadata.localRuntimeProjectRoot = health.body?.projectRoot;
    metadata.localRuntimeRole = health.body?.runtimeRole;
    metadata.worktreeDegraded = health.body?.worktreeDegraded === true;
    metadata.dbDegraded = health.body?.dbDegraded === true;
    if (health.body?.worktreeDegraded === true) {
      effectiveMaxConcurrentJobs = Math.min(effectiveMaxConcurrentJobs, 1);
      metadata.capacityWarning = "worktree_degraded";
    }
  } else {
    capabilities = capabilities.filter((capability) => !executionCaps.has(capability));
    metadata.capabilityWarning = "local_runtime_unreachable";
    return { capabilities, metadata, effectiveMaxConcurrentJobs: 0 };
  }

  if (
    !capabilities.includes("verify") &&
    !capabilities.includes("dispatch") &&
    !capabilities.includes("fix")
  ) {
    return { capabilities, metadata, effectiveMaxConcurrentJobs };
  }

  const commandResponse = await requestLocalJson(options, "GET", "/api/testing/commands");
  const commands = Array.isArray(commandResponse.body) ? commandResponse.body : [];
  const needsPosix = commandsNeedWindowsPosixToolchain(commands);
  metadata.verificationToolchain = needsPosix ? "required" : "not_required";

  if (needsPosix) {
    const dirs = existingWindowsPosixDirs();
    if (dirs.length === 0) {
      capabilities = capabilities.filter((capability) => !executionCaps.has(capability));
      metadata.verificationToolchain = "missing";
      metadata.capabilityWarning = "windows_posix_toolchain_missing";
    } else {
      metadata.verificationToolchain = "git_bash";
      metadata.verificationToolchainPath = dirs.join(";");
    }
  }

  metadata.advertisedCapabilities = capabilities;

  return { capabilities, metadata, effectiveMaxConcurrentJobs };
}

async function localLoad(localRuntimeUrl) {
  try {
    const response = await fetch(new URL("/api/dispatch/jobs", localRuntimeUrl));
    if (!response.ok) return 0;
    const jobs = await response.json();
    return Array.isArray(jobs) ? jobs.filter((job) => job && job.status === "running").length : 0;
  } catch {
    return 0;
  }
}

async function register(options) {
  const probe = await localCapabilityProbe(options);
  const payload = {
    hostId: options.hostId,
    alias: options.alias || options.hostId,
    baseUrl: options.listenerUrl || undefined,
    capabilities: probe.capabilities,
    maxConcurrentJobs: probe.effectiveMaxConcurrentJobs,
    repoCommit: gitCommit(options.repoPath),
    projectPaths: Object.keys(options.projectPaths).length > 0 ? options.projectPaths : undefined,
    runtimeRole: "worker",
    protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
    metadata: probe.metadata,
  };
  return requestJson(options, "POST", "/v1/listeners/register", payload);
}

async function heartbeat(options, lastCommand) {
  const probe = await localCapabilityProbe(options);
  const payload = {
    healthy: true,
    currentLoad: await localLoad(options.localRuntimeUrl),
    maxConcurrentJobs: probe.effectiveMaxConcurrentJobs,
    capabilities: probe.capabilities,
    repoCommit: gitCommit(options.repoPath),
    projectPaths: Object.keys(options.projectPaths).length > 0 ? options.projectPaths : undefined,
    runtimeRole: "worker",
    protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
    lastCommand: lastCommand || undefined,
    metadata: probe.metadata,
  };
  return requestJson(
    options,
    "POST",
    `/v1/listeners/${encodeURIComponent(options.hostId)}/heartbeat`,
    payload,
  );
}

async function commands(options) {
  return requestJson(
    options,
    "GET",
    `/v1/listeners/${encodeURIComponent(options.hostId)}/commands`,
  );
}

async function jobs(options) {
  return requestJson(options, "GET", `/v1/listeners/${encodeURIComponent(options.hostId)}/jobs`);
}

async function ack(options, commandIdsOverride, results) {
  const commandIds = (commandIdsOverride || options.commandIds).filter(Boolean);
  if (commandIds.length === 0) throw new Error("ack requires --command-id.");
  return requestJson(
    options,
    "POST",
    `/v1/listeners/${encodeURIComponent(options.hostId)}/commands/ack`,
    {
      commandIds,
      results,
    },
  );
}

async function renewLease(options, jobId, leaseId) {
  if (!leaseId) throw new Error(`Cannot renew ${jobId} without its exact lease id.`);
  return requestJson(
    options,
    "POST",
    `/v1/federation/jobs/${encodeURIComponent(jobId)}/lease/renew`,
    {
      hostId: options.hostId,
      leaseId,
      leaseTtlMs: Math.max(options.leaseRenewMs * 3, 120000),
    },
  );
}

async function postJobEvent(options, jobId, body) {
  const result = await requestJson(
    options,
    "POST",
    `/v1/federation/jobs/${encodeURIComponent(jobId)}/events`,
    {
      ...body,
      hostId: options.hostId,
      ...(options.leaseId ? { leaseId: options.leaseId } : {}),
    },
  );
  // TASK-1329 R1-3: every caller used to discard this result. A headnode that
  // REJECTS the status - an older one that does not know `awaiting_approval`,
  // say - would drop the update silently, leaving the job stuck in whatever
  // state it was last in until something reaped it as failed. That is the
  // version-skew shape of the very bug this task fixes, so it must be loud.
  // Deploy order: headnode first, then listeners.
  if (!result.ok) {
    console.error(
      `[dispatch] Headnode REJECTED the status post for job ${jobId} ` +
        `(status=${body?.status ?? "?"}, http=${result.status}). THIS UPDATE IS LOST: ` +
        `${JSON.stringify(result.body)}`,
    );
  }
  return result;
}

/** TASK-1329: ask the monitor whether THIS run is paused at a gate. The reader
 *  lives in TypeScript and this is a plain .mjs script, so it goes over HTTP
 *  (R1-5). `runStartedAt` is mandatory server-side: without a run boundary an
 *  older pend could mask a crash as a pause. */
async function fetchRunScopedPauseState(options, taskId, runStartedAt) {
  if (!runStartedAt) return null;
  const query = `?runStartedAt=${encodeURIComponent(runStartedAt)}`;
  const result = await requestLocalJson(
    options,
    "GET",
    `/api/tasks/${encodeURIComponent(taskId)}/pause-state${query}`,
  );
  if (!result.ok || !result.body || result.body.paused !== true) return null;
  return {
    gate: result.body.gate,
    createdAt: result.body.createdAt,
    identity: result.body.identity || null,
  };
}

async function requestLocalJson(options, method, pathName, body) {
  try {
    return await requestLocalWithNodeHttp(
      new URL(pathName, options.localRuntimeUrl),
      method,
      body,
      options.projectId ? { "X-Project-Id": options.projectId } : {},
    );
  } catch (err) {
    return {
      status: 0,
      ok: false,
      body: {
        error: "local_monitor_request_failed",
        message: err instanceof Error ? err.message : String(err),
        method,
        path: pathName,
        localRuntimeUrl: options.localRuntimeUrl,
      },
    };
  }
}

function taskVisibleResponse(result, taskId) {
  return result.ok && result.body && !result.body.error && result.body.id === taskId;
}

async function ensureLocalTaskProject(options, taskId) {
  const encoded = encodeURIComponent(taskId);
  const current = await requestLocalJson(options, "GET", `/api/tasks/${encoded}`);
  if (taskVisibleResponse(current, taskId)) {
    return { ok: true, switched: false };
  }

  const projectsResponse = await requestLocalJson(options, "GET", "/api/projects");
  const projects = Array.isArray(projectsResponse.body) ? projectsResponse.body : [];
  if (options.projectId) {
    const expected = projects.find((project) => project?.id === options.projectId);
    if (!expected) {
      return {
        ok: false,
        reason: "federated_project_not_found_in_local_monitor",
        expectedProjectId: options.projectId,
        currentStatus: current.status,
        currentBody: current.body,
        projects: projects.map((project) => ({
          id: project?.id,
          path: project?.path,
          active: project?.active,
        })),
      };
    }
    if (!expected.active) {
      const switched = await requestLocalJson(options, "POST", "/api/projects/active", {
        projectId: options.projectId,
      });
      if (!switched.ok) {
        return {
          ok: false,
          reason: "federated_project_switch_failed",
          expectedProjectId: options.projectId,
          currentStatus: switched.status,
          currentBody: switched.body,
          projects,
        };
      }
    }
    const check = await requestLocalJson(options, "GET", `/api/tasks/${encoded}`);
    return taskVisibleResponse(check, taskId)
      ? {
          ok: true,
          switched: !expected.active,
          projectId: expected.id,
          projectPath: expected.path,
        }
      : {
          ok: false,
          reason: "task_not_visible_in_expected_local_project",
          expectedProjectId: options.projectId,
          currentStatus: check.status,
          currentBody: check.body,
          projects,
        };
  }
  if (projects.length <= 1) {
    return {
      ok: false,
      reason: "task_not_visible_in_local_monitor",
      currentStatus: current.status,
      currentBody: current.body,
      projects,
    };
  }

  for (const project of projects) {
    if (!project?.id || project.active) continue;
    const switched = await requestLocalJson(options, "POST", "/api/projects/active", {
      projectId: project.id,
    });
    if (!switched.ok) continue;
    const check = await requestLocalJson(options, "GET", `/api/tasks/${encoded}`);
    if (taskVisibleResponse(check, taskId)) {
      return {
        ok: true,
        switched: true,
        projectId: project.id,
        projectPath: project.path,
      };
    }
  }

  return {
    ok: false,
    reason: "task_not_found_in_any_local_project",
    currentStatus: current.status,
    currentBody: current.body,
    projects: projects.map((project) => ({
      id: project?.id,
      path: project?.path,
      active: project?.active,
    })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TASK-899: retry an async operation with exponential backoff + jitter.
 *
 * Returns the operation's resolved value on success. Throws the last
 * error when all attempts are exhausted. Logs each retry attempt to
 * stderr with a structured prefix so operators can grep `[listener-retry]`
 * in the daemon log.
 *
 * @param {() => Promise<any>} op - The async operation to attempt.
 * @param {{ label: string, maxAttempts?: number, baseMs?: number, maxMs?: number }} opts
 *   - label: short string used in retry log lines (e.g. "register", "heartbeat").
 *   - maxAttempts: total attempts including the first try (default 5).
 *   - baseMs: initial backoff delay (default 1000).
 *   - maxMs: cap on backoff delay (default 30000).
 */
async function retryWithBackoff(op, opts) {
  const label = opts.label;
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 30000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Operator-config errors (4xx, bad token, missing flag) are flagged
      // as nonRetryable by the caller — fail loudly on the first attempt
      // so we don't paper over real misconfiguration with a long backoff.
      if (err && err.nonRetryable) {
        console.error(`[listener-retry] ${label} non-retryable error: ${msg}`);
        throw err;
      }
      if (attempt === maxAttempts) {
        console.error(
          `[listener-retry] ${label} attempt ${attempt}/${maxAttempts} failed (giving up): ${msg}`,
        );
        throw err;
      }
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(exp / 2, 1000));
      const delay = exp + jitter;
      console.error(
        `[listener-retry] ${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${msg}`,
      );
      await sleep(delay);
    }
  }
  // Unreachable, but keeps TypeScript-style checkers happy.
  throw lastErr;
}

function jobEvidence(job, localJob, extra = {}) {
  return {
    type: "worker_execution",
    hostId: job.hostId,
    jobId: job.jobId,
    taskId: job.taskId,
    jobType: job.jobType,
    localSessionId: localJob?.sessionId,
    localStatus: localJob?.status,
    worktreePath: localJob?.worktreePath,
    ...extra,
  };
}

function gitValue(repoPath, args) {
  if (!repoPath) return undefined;
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

function branchNameFromOutput(output) {
  if (!Array.isArray(output)) return undefined;
  for (const line of [...output].reverse()) {
    const match = String(line).match(/^\s*(?:Branch|Branch preserved):\s+(\S+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function metadataFromLocalJob(job) {
  const worktreePath = job?.worktreePath;
  const branchName =
    job?.branchName ||
    gitValue(worktreePath, ["branch", "--show-current"]) ||
    branchNameFromOutput(job?.output);
  const commitSha = job?.commitSha || gitValue(worktreePath, ["rev-parse", "HEAD"]);
  return {
    commitSha,
    branchName: branchName || undefined,
  };
}

function summarizeWorkerCompletion(sessionId, events) {
  const summary = {
    canonicalSessionId: sessionId,
  };

  for (const event of events) {
    const payload =
      event && typeof event === "object" && event.payload && typeof event.payload === "object"
        ? event.payload
        : undefined;
    if (!payload || typeof event?.stage !== "string") continue;

    if (event.stage === "lifecycle_verify_result") {
      if (typeof payload.workflowId === "string") {
        summary.verificationWorkflowId = payload.workflowId;
      }
      if (typeof payload.verified === "boolean") {
        summary.verified = payload.verified;
      }
      if (
        payload.verdict === "VERIFIED" ||
        payload.verdict === "FAILED" ||
        payload.verdict === "BLOCKED"
      ) {
        summary.verificationVerdict = payload.verdict;
      }
    }

    if (event.stage === "lifecycle_complete" && typeof payload.verified === "boolean") {
      summary.verified = payload.verified;
    }

    if (event.stage === "auto_merge_complete") {
      summary.autoMerged = true;
      if (typeof payload.targetBranch === "string" && payload.targetBranch.trim()) {
        summary.mergeTargetBranch = payload.targetBranch.trim();
      }
      if (typeof payload.mergeCommitSha === "string" && payload.mergeCommitSha.trim()) {
        summary.mergeCommitSha = payload.mergeCommitSha.trim();
      }
    }

    if (event.stage === "session_complete") {
      if (payload.autoMerged === true) summary.autoMerged = true;
      if (typeof payload.verified === "boolean") summary.verified = payload.verified;
      if (
        payload.verificationVerdict === "VERIFIED" ||
        payload.verificationVerdict === "FAILED" ||
        payload.verificationVerdict === "BLOCKED"
      ) {
        summary.verificationVerdict = payload.verificationVerdict;
      }
    }
  }

  return summary;
}

async function collectWorkerCompletion(options, taskId, sessionId, jobId, leaseId) {
  // A task's latest run may already belong to a replacement attempt. Only
  // the session carried by the exact settled observation can donate proof.
  if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  const events = await requestLocalJson(
    options,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!events.ok || !Array.isArray(events.body)) {
    return { canonicalSessionId: sessionId };
  }

  // The HTTP request is scoped to the canonical project. Raw event.project
  // can be the adapter's display name, so prove the remaining assignment from
  // the exact session_start envelope instead of comparing a name to a slug.
  const exactEvents = events.body.filter(
    (event) => event?.sessionId === sessionId && event?.taskId === taskId,
  );
  const boundStart = exactEvents.some(
    (event) =>
      event.stage === "session_start" &&
      event.payload?.jobId === jobId &&
      event.payload?.hostId === options.hostId &&
      event.payload?.leaseId === leaseId,
  );
  return boundStart
    ? summarizeWorkerCompletion(sessionId, exactEvents)
    : { canonicalSessionId: sessionId };
}

function clipText(value, maxLength = 500) {
  if (!value) return undefined;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
}

function localJobMissingGraceMs() {
  const raw = Number(process.env.QUACK_LOCAL_JOB_MISSING_GRACE_MS || "60000");
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

function localJobUnreachableGraceMs() {
  const raw = Number(process.env.QUACK_LOCAL_JOB_UNREACHABLE_GRACE_MS || "90000");
  return Number.isFinite(raw) && raw > 0 ? raw : 90000;
}

function summarizeCommandResult(result) {
  if (!result) return undefined;
  return {
    kind: result.kind,
    status: result.status,
    completedAt: result.completedAt || result.acknowledgedAt,
    durationMs: result.durationMs,
    errorCategory: result.errorCategory,
    message: result.message,
    metadata: result.kind === "worker.refresh" ? result.metadata : undefined,
  };
}

function isSuccessfulDispatchStatus(status) {
  return status === "completed" || status === "no_changes";
}

function buildCommandResult(command, status, startedAt, startedMs, extra = {}) {
  const completedAt = new Date().toISOString();
  return {
    commandId: command.commandId,
    protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
    kind: command.kind,
    status,
    acknowledgedAt: completedAt,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
    ...extra,
  };
}

function resolveCommandRepoPath(options, command, fallbackToRepo = true) {
  const repoPathKey = command?.payload?.repoPathKey || command?.targetProjectId;
  if (repoPathKey && options.projectPaths?.[repoPathKey]) {
    return options.projectPaths[repoPathKey];
  }
  if (repoPathKey === "quack") return options.repoPath;
  if (command.kind === "sync_wiki") {
    const wikiPath = process.env.QUACK_WIKI_REPO_PATH || options.projectPaths?.wiki;
    return wikiPath || undefined;
  }
  return fallbackToRepo ? options.repoPath : undefined;
}

function resolveRepoPathByKey(options, repoKey) {
  if (repoKey === "quack") return options.repoPath;
  return options.projectPaths?.[repoKey];
}

function selectedRefreshRepos(options, command) {
  const requested =
    Array.isArray(command.payload?.repos) && command.payload.repos.length > 0
      ? command.payload.repos
      : ["quack", ...Object.keys(options.projectPaths || {})];
  return [...new Set(requested)].map((repoKey) => ({
    repoKey,
    repoPath: resolveRepoPathByKey(options, repoKey),
    expectedBranch: command.payload?.branches?.[repoKey],
  }));
}

const REFRESH_IGNORED_UNTRACKED_PATHS = [
  ".quack/admin-runs/",
  ".quack/docs-pipeline/",
  ".quack/evidence/",
  ".quack/intake/",
  ".quack/reviews/review-task-",
  ".quack-from-clone/",
];

function isRefreshRuntimeDirtyLine(line) {
  if (!line.startsWith("?? ")) return false;
  const filePath = line.slice(3).trim().replace(/\\/g, "/");
  return REFRESH_IGNORED_UNTRACKED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

function filterWorkerRefreshDirtyStatus(dirtyStatus) {
  const lines = dirtyStatus.split(/\r?\n/).filter(Boolean);
  const blocking = [];
  let ignoredRuntimeDirtyCount = 0;

  for (const line of lines) {
    if (isRefreshRuntimeDirtyLine(line)) {
      ignoredRuntimeDirtyCount += 1;
      continue;
    }
    blocking.push(line);
  }

  return {
    dirtyStatus: blocking.join("\n"),
    ignoredRuntimeDirtyCount,
  };
}

function repoDriftSnapshot(repoPath, expectedBranch) {
  const currentBranch = gitValue(repoPath, ["branch", "--show-current"]) || "";
  const rawDirtyStatus =
    gitValue(repoPath, ["status", "--porcelain", "--untracked-files=all"]) || "";
  const filteredDirty = filterWorkerRefreshDirtyStatus(rawDirtyStatus);
  const branch = expectedBranch || currentBranch || "main";
  return {
    currentBranch,
    expectedBranch: branch,
    dirtyStatus: filteredDirty.dirtyStatus,
    rawDirtyStatus,
    ignoredRuntimeDirtyCount: filteredDirty.ignoredRuntimeDirtyCount,
    commitBefore: gitCommit(repoPath),
  };
}

function runWorkerRefreshCommand(options, command) {
  const repos = selectedRefreshRepos(options, command);
  const repoResults = [];
  const maxDirtyAction = command.payload?.maxDirtyAction || "block";

  for (const repo of repos) {
    if (!repo.repoPath || !existsSync(repo.repoPath)) {
      repoResults.push({
        repoKey: repo.repoKey,
        status: "blocked",
        blocker: "project_not_found",
        repoPath: repo.repoPath,
      });
      continue;
    }

    const snapshot = repoDriftSnapshot(repo.repoPath, repo.expectedBranch);
    if (snapshot.currentBranch && snapshot.currentBranch !== snapshot.expectedBranch) {
      repoResults.push({
        repoKey: repo.repoKey,
        status: "blocked",
        blocker: "wrong_branch",
        repoPath: repo.repoPath,
        currentBranch: snapshot.currentBranch,
        expectedBranch: snapshot.expectedBranch,
        commitBefore: snapshot.commitBefore,
      });
      continue;
    }

    const sequence = [
      { cmd: "git", args: ["fetch", "origin", snapshot.expectedBranch] },
      { cmd: "git", args: ["pull", "--ff-only", "origin", snapshot.expectedBranch] },
    ];
    let stashApplied = false;
    let stashRef;
    if (snapshot.dirtyStatus.trim().length > 0) {
      if (maxDirtyAction === "block") {
        repoResults.push({
          repoKey: repo.repoKey,
          status: "blocked",
          blocker: "dirty_worktree",
          repoPath: repo.repoPath,
          currentBranch: snapshot.currentBranch,
          expectedBranch: snapshot.expectedBranch,
          dirtyStatus: clipText(snapshot.dirtyStatus),
          commitBefore: snapshot.commitBefore,
        });
        continue;
      }
      sequence.unshift({
        cmd: "git",
        args: ["stash", "push", "-u", "-m", `quack-worker-refresh-${new Date().toISOString()}`],
      });
      stashApplied = true;
    }
    if (
      command.payload?.runInstall === true &&
      existsSync(path.join(repo.repoPath, "package.json"))
    ) {
      sequence.push({ cmd: "npm", args: ["install", "--ignore-scripts"] });
    }
    const result = runCommandSequence(sequence, repo.repoPath);
    if (stashApplied) {
      stashRef = gitValue(repo.repoPath, ["stash", "list", "-1", "--format=%gd"]);
    }
    repoResults.push({
      repoKey: repo.repoKey,
      status: result.ok ? "refreshed" : "blocked",
      blocker: result.ok ? undefined : result.errorCategory,
      repoPath: repo.repoPath,
      currentBranch: snapshot.currentBranch,
      expectedBranch: snapshot.expectedBranch,
      commitBefore: snapshot.commitBefore,
      commitAfter: gitCommit(repo.repoPath),
      dirtyAction: snapshot.dirtyStatus.trim().length > 0 ? maxDirtyAction : undefined,
      dirtyStatus:
        snapshot.dirtyStatus.trim().length > 0 ? clipText(snapshot.dirtyStatus) : undefined,
      ignoredRuntimeDirtyCount: snapshot.ignoredRuntimeDirtyCount || undefined,
      stashApplied,
      stashRef,
      executed: result.executed,
      message: result.message,
      stdoutSnippet: result.stdoutSnippet,
      stderrSnippet: result.stderrSnippet,
    });
  }

  return repoResults;
}

function workerRefreshRepairSuggestions(repoResults, probe) {
  const suggestions = [];
  if (
    (repoResults || []).some(
      (result) => result.blocker === "dirty_worktree" || result.blocker === "wrong_branch",
    )
  ) {
    suggestions.push(
      "Inspect local repo drift, preserve any local work, then rerun worker refresh or worker install --repair --start.",
    );
  }
  if ((repoResults || []).some((result) => result.blocker === "project_not_found")) {
    suggestions.push(
      "Rerun worker install --repair --start with a fresh bootstrap token so the worker profile rewrites missing repo paths.",
    );
  }
  if (probe?.metadata?.capabilityWarning) {
    suggestions.push(
      `Repair capability prerequisite: ${probe.metadata.capabilityWarning}; rerun worker install --repair --start after fixing it.`,
    );
  }
  return suggestions;
}

function runStructuredCommand(spec) {
  return spawnSync(spec.cmd, spec.args || [], {
    cwd: spec.cwd,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    encoding: "utf-8",
    shell: false,
    timeout: localRequestTimeoutMs(),
    windowsHide: true,
  });
}

function classifyCommandExecutionError(result) {
  if (result.error?.code === "ENOENT") {
    return {
      status: "non_retryable",
      errorCategory: "tool_missing",
      message: result.error.message,
    };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return {
      status: "failed",
      errorCategory: "execution_failed",
      message: `Command exited with code ${result.status}.`,
      exitCode: result.status,
      stdoutSnippet: clipText(result.stdout),
      stderrSnippet: clipText(result.stderr),
    };
  }
  return {
    status: "failed",
    errorCategory: "unknown",
    message: result.error?.message || "Structured command failed.",
    stdoutSnippet: clipText(result.stdout),
    stderrSnippet: clipText(result.stderr),
  };
}

function runCommandSequence(commands, cwd) {
  const executed = [];
  for (const command of commands || []) {
    const spec = {
      cmd: command.cmd,
      args: Array.isArray(command.args) ? command.args : [],
      cwd: command.cwd ? path.resolve(cwd, command.cwd) : cwd,
      env: command.env,
    };
    const result = runStructuredCommand(spec);
    executed.push({
      cmd: spec.cmd,
      args: spec.args,
      cwd: spec.cwd,
      status: typeof result.status === "number" ? result.status : null,
      stdout: clipText(result.stdout),
      stderr: clipText(result.stderr),
    });
    if (result.error || result.status !== 0) {
      const classified = classifyCommandExecutionError(result);
      return {
        ok: false,
        executed,
        ...classified,
      };
    }
  }
  return { ok: true, executed };
}

async function executeWorkerCommand(options, command) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  if (!command || command.protocolVersion !== WORKER_COMMAND_PROTOCOL_VERSION) {
    return buildCommandResult(
      command || { commandId: "unknown", kind: "collect_diagnostics" },
      "non_retryable",
      startedAt,
      startedMs,
      {
        errorCategory: "bad_payload",
        message: "Command payload is missing or uses an unsupported protocol version.",
      },
    );
  }

  try {
    if (command.kind === "git_pull") {
      const repoPath = resolveCommandRepoPath(options, command);
      if (!repoPath || !existsSync(repoPath)) {
        return buildCommandResult(command, "non_retryable", startedAt, startedMs, {
          errorCategory: "project_not_found",
          message: `Repo path not found for ${command.targetProjectId || command.payload?.repoPathKey || "git_pull"}.`,
        });
      }
      const remote = command.payload?.remote || "origin";
      const targetBranch = command.payload?.targetBranch;
      if (!targetBranch) {
        return buildCommandResult(command, "non_retryable", startedAt, startedMs, {
          errorCategory: "bad_payload",
          message: "git_pull requires payload.targetBranch.",
        });
      }

      const sequence = runCommandSequence(
        [
          { cmd: "git", args: ["fetch", remote, targetBranch] },
          { cmd: "git", args: ["checkout", "-B", targetBranch, `${remote}/${targetBranch}`] },
          {
            cmd: "git",
            args: [
              "pull",
              ...(command.payload?.ffOnly === false ? [] : ["--ff-only"]),
              remote,
              targetBranch,
            ],
          },
        ],
        repoPath,
      );
      if (!sequence.ok) {
        return buildCommandResult(command, sequence.status, startedAt, startedMs, {
          errorCategory: sequence.errorCategory,
          message: sequence.message,
          exitCode: sequence.exitCode,
          stdoutSnippet: sequence.stdoutSnippet,
          stderrSnippet: sequence.stderrSnippet,
          metadata: { repoPath, executed: sequence.executed },
        });
      }
      return buildCommandResult(command, "completed", startedAt, startedMs, {
        message: `Fast-forwarded ${targetBranch} in ${repoPath}.`,
        metadata: {
          repoPath,
          repoCommit: gitCommit(repoPath),
          executed: sequence.executed,
        },
      });
    }

    if (command.kind === "refresh_project") {
      const repoPath = resolveCommandRepoPath(options, command);
      if (!repoPath || !existsSync(repoPath)) {
        return buildCommandResult(command, "non_retryable", startedAt, startedMs, {
          errorCategory: "project_not_found",
          message: `Repo path not found for ${command.targetProjectId || command.payload?.repoPathKey || "refresh_project"}.`,
        });
      }
      const currentBranch = gitValue(repoPath, ["branch", "--show-current"]) || "main";
      const baseSequence = runCommandSequence(
        [
          { cmd: "git", args: ["fetch", "origin", currentBranch] },
          { cmd: "git", args: ["pull", "--ff-only", "origin", currentBranch] },
        ],
        repoPath,
      );
      if (!baseSequence.ok) {
        return buildCommandResult(command, baseSequence.status, startedAt, startedMs, {
          errorCategory: baseSequence.errorCategory,
          message: baseSequence.message,
          exitCode: baseSequence.exitCode,
          stdoutSnippet: baseSequence.stdoutSnippet,
          stderrSnippet: baseSequence.stderrSnippet,
          metadata: { repoPath, executed: baseSequence.executed },
        });
      }

      const execSequence = runCommandSequence(command.payload?.exec || [], repoPath);
      if (!execSequence.ok) {
        return buildCommandResult(command, execSequence.status, startedAt, startedMs, {
          errorCategory: execSequence.errorCategory,
          message: execSequence.message,
          exitCode: execSequence.exitCode,
          stdoutSnippet: execSequence.stdoutSnippet,
          stderrSnippet: execSequence.stderrSnippet,
          metadata: {
            repoPath,
            executed: [...baseSequence.executed, ...execSequence.executed],
          },
        });
      }

      return buildCommandResult(command, "completed", startedAt, startedMs, {
        message: `Refreshed ${command.targetProjectId || command.payload?.repoPathKey || repoPath}.`,
        metadata: {
          repoPath,
          repoCommit: gitCommit(repoPath),
          executed: [...baseSequence.executed, ...execSequence.executed],
        },
      });
    }

    if (command.kind === "probe_capabilities") {
      const probe = await localCapabilityProbe(options);
      options.capabilities = probe.capabilities;
      options.maxConcurrentJobs = probe.effectiveMaxConcurrentJobs;
      return buildCommandResult(command, "completed", startedAt, startedMs, {
        message: `Capabilities refreshed: ${probe.capabilities.join(", ") || "none"}.`,
        metadata: {
          capabilities: probe.capabilities,
          metadata: probe.metadata,
          maxConcurrentJobs: probe.effectiveMaxConcurrentJobs,
        },
      });
    }

    if (command.kind === "worker.refresh") {
      const repoResults = runWorkerRefreshCommand(options, command);
      const blockers = repoResults.filter((result) => result.status !== "refreshed");
      const probe =
        command.payload?.runCapabilityProbes === false
          ? undefined
          : await localCapabilityProbe(options);
      if (probe) {
        options.capabilities = probe.capabilities;
        options.maxConcurrentJobs = probe.effectiveMaxConcurrentJobs;
      }
      return buildCommandResult(
        command,
        blockers.length > 0 ? "failed" : "completed",
        startedAt,
        startedMs,
        {
          errorCategory: blockers.length > 0 ? "execution_failed" : undefined,
          message:
            blockers.length > 0
              ? `Worker refresh blocked by ${blockers.length} repo drift issue(s).`
              : "Worker refresh completed.",
          metadata: {
            reason: command.payload?.reason,
            applyProfile: command.payload?.applyProfile !== false,
            repos: repoResults,
            capabilities: probe?.capabilities,
            capabilityMetadata: probe?.metadata,
            maxConcurrentJobs: probe?.effectiveMaxConcurrentJobs,
            repairSuggestions: workerRefreshRepairSuggestions(repoResults, probe),
          },
        },
      );
    }

    if (command.kind === "collect_diagnostics") {
      const diagnostics = {};
      if (command.payload?.includeHealth !== false) {
        diagnostics.health = await requestLocalJson(options, "GET", "/api/health");
      }
      if (command.payload?.includeJobs !== false) {
        diagnostics.dispatchJobs = await requestLocalJson(options, "GET", "/api/dispatch/jobs");
      }
      return buildCommandResult(command, "completed", startedAt, startedMs, {
        message: "Collected worker diagnostics.",
        metadata: diagnostics,
      });
    }

    if (command.kind === "sync_wiki") {
      const wikiPath = resolveCommandRepoPath(options, command, false);
      if (!wikiPath || !existsSync(wikiPath)) {
        return buildCommandResult(command, "non_retryable", startedAt, startedMs, {
          errorCategory: "not_supported",
          message: "This worker does not have a configured wiki checkout to sync.",
        });
      }
      if (command.payload?.mode === "status") {
        const status = runStructuredCommand({
          cmd: "git",
          args: ["status", "--short", "--branch"],
          cwd: wikiPath,
        });
        if (status.error || status.status !== 0) {
          const classified = classifyCommandExecutionError(status);
          return buildCommandResult(command, classified.status, startedAt, startedMs, {
            errorCategory: classified.errorCategory,
            message: classified.message,
            exitCode: classified.exitCode,
            stdoutSnippet: classified.stdoutSnippet,
            stderrSnippet: classified.stderrSnippet,
          });
        }
        return buildCommandResult(command, "completed", startedAt, startedMs, {
          message: "Collected wiki git status.",
          stdoutSnippet: clipText(status.stdout),
          metadata: {
            wikiPath,
            repoCommit: gitCommit(wikiPath),
          },
        });
      }
      const pull = runStructuredCommand({
        cmd: "git",
        args: ["pull", "--ff-only", "origin", "main"],
        cwd: wikiPath,
      });
      if (pull.error || pull.status !== 0) {
        const classified = classifyCommandExecutionError(pull);
        return buildCommandResult(command, classified.status, startedAt, startedMs, {
          errorCategory: classified.errorCategory,
          message: classified.message,
          exitCode: classified.exitCode,
          stdoutSnippet: classified.stdoutSnippet,
          stderrSnippet: classified.stderrSnippet,
        });
      }
      return buildCommandResult(command, "completed", startedAt, startedMs, {
        message: "Fast-forwarded the worker wiki checkout.",
        stdoutSnippet: clipText(pull.stdout),
        metadata: {
          wikiPath,
          repoCommit: gitCommit(wikiPath),
        },
      });
    }

    return buildCommandResult(command, "non_retryable", startedAt, startedMs, {
      errorCategory: "not_supported",
      message: `Unsupported command kind: ${command.kind}.`,
    });
  } catch (err) {
    return buildCommandResult(command, "failed", startedAt, startedMs, {
      errorCategory: "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function processCommands(options) {
  const pending = await commands(options);
  if (!pending.ok) {
    return { processed: 0, lastCommand: undefined, response: pending };
  }

  const commandList = Array.isArray(pending.body?.commands) ? pending.body.commands : [];
  if (commandList.length === 0) {
    return { processed: 0, lastCommand: undefined, response: pending };
  }

  const results = [];
  const commandIds = [];
  for (const command of commandList) {
    const result = await executeWorkerCommand(options, command);
    results.push(result);
    commandIds.push(command.commandId);
  }

  const ackResult = await ack(options, commandIds, results);
  return {
    processed: results.length,
    lastCommand: summarizeCommandResult(results[results.length - 1]),
    response: pending,
    ack: ackResult,
    results,
  };
}

function failedLocalDispatchResult(taskId, message, details = {}) {
  return {
    taskId,
    sessionId: `failed-${taskId}-${Date.now()}`,
    status: "failed",
    exitCode: 1,
    output: [message],
    ...details,
  };
}

/** TASK-1329 round-2 R2-4/R2-5: announce a pause without ever letting the relay
 *  decide the RUN's outcome. requestJson throws on transport failure, and an
 *  escaping throw here used to land in the caller's failure path - turning a
 *  real pause into `failed`, which is the exact inversion this task exists to
 *  stop. Returns true only on an accepted (2xx) post, so the caller retries on
 *  the next poll instead of marking the pause announced-but-lost. */
async function announcePause(options, jobId, taskId, paused) {
  try {
    const result = await postJobEvent(options, jobId, {
      status: "awaiting_approval",
      message: `${options.hostId} paused ${taskId} at the ${paused.gate} gate awaiting a decision.`,
      pendingGate: { stage: paused.gate, since: paused.createdAt },
      ...(paused.identity
        ? {
            pauseIdentity: {
              ...paused.identity,
            },
          }
        : {}),
    });
    if (!result.ok || !paused.identity) {
      // Unknown identity keeps the legacy attached lease/slot. It is safer to
      // wedge visibly than to release a run that cannot be reclaimed.
      return { announced: result.ok === true, released: false };
    }
    const pause = result.body?.job?.pause;
    if (!pause || !pause.openedAt || pause.openedAt !== paused.createdAt) {
      return { announced: true, released: false };
    }
    if (
      ["released", "resume_requested", "resume_claimed", "approved_but_not_started"].includes(
        pause.state,
      )
    ) {
      return { announced: true, released: true, pause };
    }
    if (pause.state !== "attached") return { announced: true, released: false };
    const armed = await requestLocalJson(
      options,
      "POST",
      `/api/tasks/${encodeURIComponent(taskId)}/federated-resume/arm`,
      {
        projectId: paused.identity.projectId || options.projectId,
        jobType: paused.identity.jobType,
        gate: paused.gate,
        jobId,
        hostId: options.hostId,
        sessionId: paused.identity.sessionId,
        generation: pause.generation,
        releaseNonce: pause.releaseNonce,
        pauseOpenedAt: pause.openedAt,
      },
    );
    if (!armed.ok) return { announced: true, released: false };
    const released = await requestJson(
      options,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(jobId)}/pause/release`,
      {
        hostId: options.hostId,
        generation: pause.generation,
        releaseNonce: pause.releaseNonce,
        localStateArmed: true,
      },
    );
    return { announced: true, released: released.ok === true, pause: released.body?.job?.pause };
  } catch (err) {
    console.error(
      `[dispatch] Could not reach the headnode to announce the ${paused.gate} pause for ` +
        `${taskId}; will retry. The run is unaffected: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { announced: false, released: false };
  }
}

/** TASK-1329 round-2 R2-3: a resume must be reported, or the queue keeps showing
 *  the gate the operator already cleared while work is running. */
async function announceResumed(
  options,
  jobId,
  taskId,
  startGrant,
  resumedSessionId,
  resumeStartedAt,
) {
  try {
    const result = await postJobEvent(options, jobId, {
      status: "running",
      message: `${options.hostId} resumed ${taskId} after a human decision.`,
      ...(startGrant
        ? {
            resumeGrant: startGrant,
            resumeSessionId: resumedSessionId,
            remoteSessionId: resumedSessionId,
            ...(resumeStartedAt ? { resumeStartedAt } : {}),
          }
        : {}),
    });
    return result.ok === true;
  } catch {
    return false;
  }
}

async function announceResumeTerminal(
  options,
  jobId,
  taskId,
  startGrant,
  resumeStartedAt,
  status = "rejected",
  resumedSessionId,
  terminalDetails = {},
) {
  const { message: detailMessage, ...details } = terminalDetails;
  const body = {
    ...details,
    status,
    resumeGrant: startGrant,
    ...(resumedSessionId
      ? { resumeSessionId: resumedSessionId, remoteSessionId: resumedSessionId }
      : {}),
    ...(resumeStartedAt ? { resumeStartedAt } : {}),
    message:
      detailMessage ||
      (status === "rejected"
        ? `${options.hostId} recorded the blueprint rejection for ${taskId}.`
        : `${options.hostId} recorded resumed ${status} for ${taskId}.`),
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await postJobEvent(options, jobId, body);
      if (result.ok === true) return true;
    } catch {
      // The exact durable terminal reservation can be retried while its lease
      // epoch remains live. The headnode performs the authoritative checks.
    }
    if (attempt < 3) {
      try {
        await renewLease(options, jobId, startGrant.leaseId);
      } catch {
        // Still retry the event: the existing exact lease may remain live even
        // when a renewal response is lost.
      }
      await sleep(Math.max(10, Math.min(options.pollMs, 1000)));
    }
  }
  return false;
}

function exactUnconsumedResumeGrant(job, pause, claim, lease) {
  const grant = pause?.startGrant;
  if (
    pause?.state !== "approved_but_not_started" ||
    !grant ||
    grant.consumedAt ||
    grant.resumedSessionId ||
    grant.projectId !== job.projectId ||
    grant.jobId !== job.jobId ||
    grant.taskId !== job.taskId ||
    grant.jobType !== job.jobType ||
    grant.hostId !== job.hostId ||
    grant.hostId !== pause.originalHostId ||
    grant.originalSessionId !== pause.sessionId ||
    grant.generation !== pause.generation ||
    grant.releaseNonce !== pause.releaseNonce ||
    grant.claimToken !== claim?.token ||
    grant.leaseId !== lease?.leaseId ||
    claim?.hostId !== grant.hostId ||
    lease?.hostId !== grant.hostId
  ) {
    return null;
  }
  return grant;
}

async function fetchExactLocalResumeState(options, job, pause) {
  const query = new URLSearchParams({
    projectId: job.projectId,
    jobId: job.jobId,
    originalSessionId: pause.sessionId,
  });
  let result = await requestLocalJson(
    options,
    "GET",
    `/api/tasks/${encodeURIComponent(job.taskId)}/federated-resume-state?${query.toString()}`,
  );
  const resumedSessionId = result.body?.state?.resumedSessionId;
  if (!result.ok || typeof resumedSessionId !== "string" || !resumedSessionId.trim()) {
    return result;
  }
  query.set("resumedSessionId", resumedSessionId);
  result = await requestLocalJson(
    options,
    "GET",
    `/api/tasks/${encodeURIComponent(job.taskId)}/federated-resume-state?${query.toString()}`,
  );
  return result;
}

const DISPATCH_OBSERVATION_FIELDS = [
  "projectId",
  "taskId",
  "jobId",
  "hostId",
  "leaseId",
  "sessionId",
];

function exactDispatchObservationScope(options, taskId, jobId, leaseId, sessionId) {
  const identity = {
    projectId: options.projectId,
    taskId,
    jobId,
    hostId: options.hostId,
    leaseId,
    sessionId,
  };
  return DISPATCH_OBSERVATION_FIELDS.every(
    (field) =>
      typeof identity[field] === "string" &&
      identity[field].trim() === identity[field] &&
      identity[field].length > 0 &&
      identity[field].length <= 512,
  )
    ? identity
    : undefined;
}

function validExactDispatchObservation(body, identity) {
  return (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.identity &&
    DISPATCH_OBSERVATION_FIELDS.every((field) => body.identity[field] === identity[field]) &&
    typeof body.settled === "boolean" &&
    body.job &&
    body.job.taskId === identity.taskId &&
    body.job.sessionId === identity.sessionId &&
    ["running", "completed", "failed", "stopped", "awaiting_approval"].includes(body.job.status) &&
    (!body.settled ||
      (["completed", "failed", "stopped"].includes(body.job.status) &&
        typeof body.job.completedAt === "string" &&
        Number.isFinite(Date.parse(body.job.completedAt)) &&
        (body.job.status !== "completed" || (body.job.exitCode === 0 && !body.job.killedBySignal))))
  );
}

async function findExactActiveResumeSession(options, job, startGrant) {
  const result = await requestLocalJson(options, "GET", "/api/dispatch/jobs");
  if (!result.ok || !Array.isArray(result.body)) return undefined;
  const matches = result.body.filter(
    (entry) =>
      entry?.taskId === job.taskId &&
      entry.project === options.projectId &&
      typeof entry.sessionId === "string" &&
      entry.sessionId.trim() &&
      ["running", "awaiting_approval"].includes(entry.status) &&
      entry.federatedJobId === job.jobId &&
      entry.federatedHostId === options.hostId &&
      entry.federatedLeaseId === startGrant.leaseId,
  );
  return matches.length === 1 ? matches[0].sessionId : undefined;
}

async function pollLocalDispatch(options, taskId, jobId, leaseId, runStartedAt, recovery = {}) {
  let expectedSessionId = recovery.expectedSessionId;
  if (!exactDispatchObservationScope(options, taskId, jobId, leaseId, expectedSessionId)) {
    return failedLocalDispatchResult(
      taskId,
      "[dispatch] Local start returned no complete project/job/task/host/lease/session observation identity; operator recovery is required.",
    );
  }
  const observedSessions = new Set([expectedSessionId]);
  let lastRenewedAt = 0;
  let announcedPauseKey = null;
  let observedPause = null;
  let seenLocalJob = false;
  let missingSinceMs = 0;
  let unreachableSinceMs = 0;
  let unboundResumeObserved = false;
  for (;;) {
    if (recovery.beforePoll) await recovery.beforePoll();
    const identity = exactDispatchObservationScope(
      options,
      taskId,
      jobId,
      leaseId,
      expectedSessionId,
    );
    const query = new URLSearchParams({
      projectId: identity.projectId,
      jobId: identity.jobId,
      hostId: identity.hostId,
      leaseId: identity.leaseId,
      sessionId: identity.sessionId,
    });
    let result = await requestLocalJson(
      options,
      "GET",
      `/api/tasks/${encodeURIComponent(taskId)}/dispatch/observation?${query}`,
    );
    if (result.status === 404) result = { ...result, ok: true, body: undefined };
    else if (result.ok && !validExactDispatchObservation(result.body, identity)) {
      result = { ok: false, status: 503, body: { error: "invalid_exact_dispatch_observation" } };
    }
    if (!result.ok) {
      if (!unreachableSinceMs) unreachableSinceMs = Date.now();
      if (Date.now() - unreachableSinceMs >= localJobUnreachableGraceMs()) {
        return failedLocalDispatchResult(
          taskId,
          `[dispatch] Local worker runtime became unreachable while tracking ${taskId}.`,
          {
            output: [
              `[dispatch] Local worker runtime became unreachable while tracking ${taskId}.`,
              `[dispatch] ${JSON.stringify(result.body)}`,
            ],
          },
        );
      }
    } else {
      unreachableSinceMs = 0;
    }
    const localJob = result.ok ? result.body?.job : undefined;
    // A task list is used only to contain an unauthorized replacement after a
    // human pause. It must never select the completion of a newer attempt.
    const currentJobs = observedPause
      ? await requestLocalJson(options, "GET", "/api/dispatch/jobs")
      : undefined;
    const taskJobs = Array.isArray(currentJobs?.body)
      ? currentJobs.body.filter(
          (entry) =>
            entry.taskId === taskId &&
            entry.project === options.projectId &&
            entry.federatedJobId === jobId &&
            entry.federatedHostId === options.hostId &&
            entry.federatedLeaseId === leaseId,
        )
      : [];
    const unexpectedRunningJob = observedPause
      ? taskJobs.find(
          (entry) => entry.sessionId !== expectedSessionId && entry.status === "running",
        )
      : undefined;
    const observedJob = unexpectedRunningJob ?? localJob;
    if (observedJob) {
      seenLocalJob = true;
      missingSinceMs = 0;
      if (
        !["running", "awaiting_approval"].includes(observedJob.status) &&
        result.body?.settled === true
      ) {
        if (unboundResumeObserved && observedPause) {
          return {
            taskId,
            status: "awaiting_approval",
            pendingGate: { stage: observedPause.gate, since: observedPause.createdAt },
            output: [
              `[dispatch] Local child left the observed ${observedPause.gate} gate without an exact resume grant; headnode state remains paused for operator recovery.`,
            ],
          };
        }
        const replacement = observedJob.replacementSessionId;
        if (replacement !== undefined) {
          if (
            observedPause ||
            !exactDispatchObservationScope(options, taskId, jobId, leaseId, replacement) ||
            observedSessions.has(replacement)
          ) {
            return failedLocalDispatchResult(
              taskId,
              "[dispatch] Refused an invalid or cyclic API-key retry observation; operator recovery is required.",
            );
          }
          // This pointer was recorded by the host only after same-identity retry
          // admission. It is not inferred from task ID, timestamps, or recency.
          expectedSessionId = replacement;
          observedSessions.add(replacement);
          continue;
        }
        return observedJob;
      }
      // TASK-1329: a pause is the product, not an error - report it so the queue
      // can say "waiting on you" instead of leaving the job reading `running`.
      // We keep polling and keep the lease: releasing the slot would orphan the
      // job, because nothing re-binds an approved resume to this jobId yet
      // (that is TASK-1330).
      //
      // Round-2 R2-3: tracked PER GATE, not once per run. A run pauses at the
      // brief gate, gets approved, runs on, and pauses again at the judge gate;
      // a single boolean announced the first and silently swallowed the second,
      // leaving the queue pointing at a gate the operator had already cleared.
      // Round-2 R2-5: the classification must be EARNED - if disk cannot
      // positively identify the pend for this run, say nothing and look again.
      if (observedJob.status === "awaiting_approval") {
        const paused = await fetchRunScopedPauseState(options, taskId, runStartedAt);
        if (paused) {
          observedPause = paused;
          const pauseKey = `${paused.gate}:${paused.createdAt}`;
          if (announcedPauseKey === pauseKey) {
            // Keep observing the exact occurrence until its release is durable.
          } else {
            const announced = await announcePause(options, jobId, taskId, paused);
            if (announced.announced) {
              announcedPauseKey = pauseKey;
            }
            if (announced.released) {
              return {
                taskId,
                status: "awaiting_approval",
                pendingGate: { stage: paused.gate, since: paused.createdAt },
                pause: announced.pause,
                output: [],
              };
            }
          }
        }
      } else if (observedJob.status === "running" && observedPause) {
        // A pause that was announced but not durably armed/released has no
        // headnode-issued grant. A direct local approval must never become an
        // unbound federated resume. Contain it locally; if termination cannot
        // be proved, keep the exact lease and observation loop alive while the
        // head remains honestly paused for operator recovery.
        unboundResumeObserved = true;
        const stopped = await requestLocalJson(
          options,
          "POST",
          `/api/tasks/${encodeURIComponent(taskId)}/stop`,
          {
            projectId: options.projectId,
            resumedSessionId: observedJob.sessionId,
          },
        );
        if (stopped.ok || stopped.body?.terminationConfirmed === true) {
          return {
            taskId,
            status: "awaiting_approval",
            pendingGate: { stage: observedPause.gate, since: observedPause.createdAt },
            output: [
              `[dispatch] Contained an unbound local resume after the ${observedPause.gate} pause; an exact headnode grant is required before restart.`,
            ],
          };
        }
      }
    } else if (result.ok) {
      if (!missingSinceMs) missingSinceMs = Date.now();
      const graceMs = seenLocalJob
        ? localJobMissingGraceMs()
        : Math.min(localJobMissingGraceMs(), 30000);
      if (Date.now() - missingSinceMs >= graceMs) {
        // TASK-1329 / QPI-041, the dominant path: dispatch jobs are IN-MEMORY,
        // so a monitor restart erases the job while the approval record stays on
        // disk. Absence therefore does not mean death - it usually means the
        // monitor bounced under a run that is legitimately paused. Ask disk,
        // scoped to THIS run, before calling anything failed. A pend that does
        // not bind to this run, or no pend at all, still means failed.
        const pausedOnDisk = await fetchRunScopedPauseState(options, taskId, runStartedAt);
        if (pausedOnDisk) {
          observedPause = pausedOnDisk;
          // Round-2 R2-2: do NOT return here. Returning ends the execution, the
          // daemon drops the job from its in-flight set, lease renewal stops,
          // and the stale-lease sweep converts a perfectly healthy paused run
          // into blocked/manual recovery - while an approved resume has no
          // listener left to report its completion. That is the orphan class
          // round 1 split out as TASK-1330, reintroduced through the back door.
          // Announce, then keep polling and keep renewing until the local job
          // comes back or the pend genuinely goes away.
          missingSinceMs = 0;
          const pauseKey = `${pausedOnDisk.gate}:${pausedOnDisk.createdAt}`;
          if (announcedPauseKey !== pauseKey) {
            const announced = await announcePause(options, jobId, taskId, pausedOnDisk);
            if (announced.announced) {
              announcedPauseKey = pauseKey;
            }
            if (announced.released) {
              return {
                taskId,
                status: "awaiting_approval",
                pendingGate: { stage: pausedOnDisk.gate, since: pausedOnDisk.createdAt },
                pause: announced.pause,
                output: [],
              };
            }
          }
          if (Date.now() - lastRenewedAt >= options.leaseRenewMs) {
            try {
              await renewLease(options, jobId, leaseId);
            } catch (error) {
              if (!recovery.tolerateLeaseRenewalFailure?.()) throw error;
            }
            lastRenewedAt = Date.now();
          }
          await sleep(options.pollMs);
          continue;
        }
        return failedLocalDispatchResult(
          taskId,
          seenLocalJob
            ? `[dispatch] Local dispatch record for ${taskId} disappeared before reaching a terminal state.`
            : `[dispatch] Local dispatch record for ${taskId} never appeared after the start call.`,
          {
            output: [
              seenLocalJob
                ? `[dispatch] Local dispatch record for ${taskId} disappeared before reaching a terminal state.`
                : `[dispatch] Local dispatch record for ${taskId} never appeared after the start call.`,
            ],
          },
        );
      }
    }
    if (Date.now() - lastRenewedAt >= options.leaseRenewMs) {
      try {
        await renewLease(options, jobId, leaseId);
      } catch (error) {
        if (!recovery.tolerateLeaseRenewalFailure?.()) throw error;
      }
      lastRenewedAt = Date.now();
    }
    await sleep(options.pollMs);
  }
}

async function executeDispatchJob(options, job) {
  if (
    !exactDispatchObservationScope(
      options,
      job.taskId,
      job.jobId,
      job.lease?.leaseId,
      "pending-start",
    )
  ) {
    await postJobEvent(options, job.jobId, {
      status: "blocked",
      message:
        "Exact local dispatch observation scope is missing; operator recovery is required before start.",
    });
    return "failed";
  }
  const projectReady = await ensureLocalTaskProject(options, job.taskId);
  if (!projectReady.ok) {
    await postJobEvent(options, job.jobId, {
      status: "failed",
      message: `Local worker runtime cannot see ${job.taskId}: ${projectReady.reason}`,
      evidence: [
        jobEvidence(job, undefined, {
          error: projectReady.reason,
          localRuntimeUrl: options.localRuntimeUrl,
          projects: projectReady.projects,
        }),
      ],
    });
    return "failed";
  }
  await postJobEvent(options, job.jobId, {
    status: "running",
    message: `${options.hostId} starting local dispatch for ${job.taskId}${projectReady.switched ? ` on ${projectReady.projectId}` : ""}.`,
  });
  // TASK-1329: stamp the run boundary BEFORE the start call, so a pend opened by
  // this run is distinguishable from one an earlier run left behind.
  const runStartedAt = new Date().toISOString();
  const started = await requestLocalJson(
    options,
    "POST",
    `/api/tasks/${encodeURIComponent(job.taskId)}/start`,
    {
      skipGate: options.skipGate,
      federatedJobId: job.jobId,
      federatedHostId: options.hostId,
      federatedHostAlias: options.alias || options.hostId,
      federatedHostEndpoint: options.listenerUrl || options.localRuntimeUrl,
      federatedLeaseId: job.lease?.leaseId,
      // QPI-048 leg (f): the operator's swarm-wide decomposition override
      // rides the job record through to the local start.
      ...(job.skipDecomposeCheck === true ? { skipDecomposeCheck: true } : {}),
      // TASK-1323: advisory corroboration only — the monitor derives the
      // real channel from the request shape (fed job id + host id).
      claimedChannel: "listener-execution",
    },
  );
  if (!started.ok) {
    await postJobEvent(options, job.jobId, {
      status: "failed",
      message: `Local dispatch start failed: ${JSON.stringify(started.body)}`,
      evidence: [
        jobEvidence(job, undefined, { startStatus: started.status, startBody: started.body }),
      ],
    });
    return "failed";
  }

  const localJob = await pollLocalDispatch(
    options,
    job.taskId,
    job.jobId,
    job.lease?.leaseId,
    runStartedAt,
    { expectedSessionId: started.body?.sessionId },
  );
  const metadata = metadataFromLocalJob(localJob);
  const completed = isSuccessfulDispatchStatus(localJob.status);
  // TASK-1329: three states, not two. A pause is neither a success nor a
  // failure, and collapsing it into `failed` is what sent operators hunting a
  // crash that never happened and drove the re-POSTs behind QPI-040.
  const pausedAtGate = localJob.status === "awaiting_approval";
  // TASK-1332 round-3 (R3-1): FOUR states. A spec-staleness REFUSAL is not a
  // crash either, and collapsing it into `failed` is the same mistake TASK-1329
  // fixed for a pause, one task later. Federation maps `failed` to
  // `investigate_failed_worker`, which sends an operator hunting a crash that
  // never happened, and the honest recovery is a spec push or a replan.
  //
  // Reported as `blocked`, NOT a new status. `blocked` is already terminal
  // (federation/status.ts terminalFederatedStatus) and already routes to
  // `manual_handoff` (routes/federation.ts nextAction). Minting a new
  // FederatedRuntimeStatus member would be worse than the bug: the normalizer
  // coerces unknown strings, workflowStateForFederatedStatus DEFAULTS to
  // "assigned" and terminalFederatedStatus would not treat it as terminal, so
  // an unmapped status reads as freshly-assigned, non-terminal work.
  //
  // `job.specStale` reaches us because /api/dispatch/jobs spreads the whole
  // record; the monitor sets it from a durable on-disk marker, not a callback.
  const specStale = !completed && !pausedAtGate ? localJob.specStale : undefined;
  const workerCompletion = completed
    ? await collectWorkerCompletion(
        options,
        job.taskId,
        localJob.sessionId,
        job.jobId,
        job.lease?.leaseId,
      )
    : undefined;
  // Round-2 R2-4: the terminal post used to be fire-and-forget, so a transport
  // blip or a rejection left the job stranded in whatever status it last held -
  // including `awaiting_approval` for a run that had actually finished. Retry a
  // bounded number of times before giving up, and say so loudly if it never
  // lands, because at that point the queue and reality have diverged.
  const postTerminalStatus = async (payload) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const posted = await postJobEvent(options, job.jobId, payload);
        if (posted.ok) return true;
      } catch (err) {
        console.error(
          `[dispatch] Terminal status post attempt ${attempt} threw for ${job.taskId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (attempt < 3) await sleep(2000 * attempt);
    }
    console.error(
      `[dispatch] GIVING UP after 3 attempts to report the terminal status for ` +
        `${job.taskId} (job ${job.jobId}). The federation record no longer reflects reality.`,
    );
    return false;
  };
  await postTerminalStatus({
    status: completed
      ? "completed"
      : pausedAtGate
        ? "awaiting_approval"
        : specStale
          ? "blocked"
          : "failed",
    ...(specStale ? { blockReasonCode: "pending_manual_handoff" } : {}),
    ...(pausedAtGate && localJob.pendingGate ? { pendingGate: localJob.pendingGate } : {}),
    remoteSessionId: workerCompletion?.canonicalSessionId ?? localJob.sessionId,
    branchName: metadata.branchName ?? job.branchName,
    commitSha: workerCompletion?.mergeCommitSha ?? metadata.commitSha ?? job.commitSha,
    targetBranch: workerCompletion?.mergeTargetBranch,
    // Round 4 (R4-1): carry the monitor's verdict-aware reason verbatim rather
    // than restating a generic "push or replan". For a `diverged` verdict
    // replan REPRODUCES the refusal, so offering it here re-opened the loop the
    // refusal exists to close.
    message: specStale
      ? `${options.hostId} REFUSED ${job.taskId} (${specStale.verdict}), not a crash: ` +
        `${specStale.reason} Nothing was deleted. This needs an operator.`
      : `${options.hostId} local dispatch ${localJob.status} for ${job.taskId}.`,
    workerCompletion,
    evidence: [
      jobEvidence(job, localJob, {
        exitCode: localJob.exitCode,
        outputTail: Array.isArray(localJob.output) ? localJob.output.slice(-20) : [],
        workerCompletion,
      }),
    ],
  });
  return pausedAtGate ? "awaiting_approval" : completed ? "completed" : "failed";
}

async function executeResumedDispatchJob(options, job) {
  const pause = job.pause;
  if (!pause || job.status !== "awaiting_approval" || !job.projectId) {
    return "awaiting_approval";
  }
  const projectReady = await ensureLocalTaskProject(options, job.taskId);
  if (!projectReady.ok) return "awaiting_approval";
  const localStateResult = await fetchExactLocalResumeState(options, job, pause);
  const localState = localStateResult.body?.state;
  if (!localStateResult.ok || !localState?.decision) return "awaiting_approval";
  if (
    localState.projectId !== job.projectId ||
    localState.taskId !== job.taskId ||
    localState.jobType !== job.jobType ||
    localState.jobId !== job.jobId ||
    localState.hostId !== options.hostId ||
    localState.sessionId !== pause.sessionId ||
    localState.generation !== pause.generation ||
    localState.releaseNonce !== pause.releaseNonce ||
    localState.pauseOpenedAt !== pause.openedAt
  ) {
    return "awaiting_approval";
  }

  let current = job;
  if (pause.state === "released") {
    const requested = await requestJson(
      options,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(job.jobId)}/resume/request`,
      {
        hostId: options.hostId,
        generation: pause.generation,
        releaseNonce: pause.releaseNonce,
        decision: localState.decision,
      },
    );
    if (!requested.ok) return "awaiting_approval";
    current = requested.body.job;
  }
  if (current.pause?.state === "resume_requested") {
    const claimed = await requestJson(
      options,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(job.jobId)}/resume/claim`,
      {
        hostId: options.hostId,
        generation: pause.generation,
        releaseNonce: pause.releaseNonce,
      },
    );
    // A simultaneous daemon losing the claim is not a worker failure.
    if (!claimed.ok) return "awaiting_approval";
    current = claimed.body.job;
  }
  const claim = current.pause?.claim;
  const lease = current.lease;
  if (!claim || claim.hostId !== options.hostId || !lease || lease.hostId !== options.hostId) {
    return "awaiting_approval";
  }
  const resumeOptions = { ...options, leaseId: lease.leaseId };

  // Once a grant has been installed/reserved locally, a retry may arrive after
  // its wall-clock expiry. Reuse only the immutable exact headnode grant for
  // the current claim+lease epoch; re-acknowledging would reject the expired
  // grant before the listener could report the already-started child.
  let startGrant = exactUnconsumedResumeGrant(current, current.pause, claim, lease);
  if (!startGrant) {
    if (current.pause?.state === "approved_but_not_started" && current.pause.startGrant) {
      return "awaiting_approval";
    }
    const acknowledged = await requestJson(
      options,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(job.jobId)}/resume/ack`,
      {
        projectId: job.projectId,
        taskId: job.taskId,
        jobType: job.jobType,
        hostId: options.hostId,
        originalSessionId: pause.sessionId,
        generation: pause.generation,
        releaseNonce: pause.releaseNonce,
        claimToken: claim.token,
        leaseId: lease.leaseId,
        phase: "approved_but_not_started",
      },
    );
    if (!acknowledged.ok) return "awaiting_approval";
    startGrant = acknowledged.body?.startGrant || acknowledged.body?.job?.pause?.startGrant;
  }
  if (!startGrant) return "awaiting_approval";
  const observedResumedSessionId =
    localState.resumedSessionId ||
    (localState.startGrantConsumedAt
      ? await findExactActiveResumeSession(resumeOptions, job, startGrant)
      : undefined);
  if (localState.startGrantConsumedAt && !observedResumedSessionId) {
    return "awaiting_approval";
  }

  const installed = await requestLocalJson(
    resumeOptions,
    "POST",
    `/api/tasks/${encodeURIComponent(job.taskId)}/federated-resume/grant`,
    {
      projectId: job.projectId,
      originalSessionId: pause.sessionId,
      ...(observedResumedSessionId ? { resumedSessionId: observedResumedSessionId } : {}),
      startGrant,
    },
  );
  if (!installed.ok) return "awaiting_approval";

  const runStartedAt = new Date().toISOString();
  const started = await requestLocalJson(
    resumeOptions,
    "POST",
    `/api/tasks/${encodeURIComponent(job.taskId)}/federated-resume/start`,
    {
      projectId: job.projectId,
      originalSessionId: pause.sessionId,
      ...(observedResumedSessionId ? { resumedSessionId: observedResumedSessionId } : {}),
      startGrant,
    },
  );
  if (!started.ok) return "awaiting_approval";
  if (started.body?.terminal) {
    const resumeStartedAt =
      typeof started.body?.state?.startGrantConsumedAt === "string"
        ? started.body.state.startGrantConsumedAt
        : undefined;
    const accepted = await announceResumeTerminal(
      resumeOptions,
      job.jobId,
      job.taskId,
      startGrant,
      resumeStartedAt,
    );
    return accepted ? "completed" : "awaiting_approval";
  }
  const resumedSessionId = started.body?.sessionId;
  if (!resumedSessionId) return "awaiting_approval";
  const resumeStartedAt =
    typeof started.body?.state?.startGrantConsumedAt === "string"
      ? started.body.state.startGrantConsumedAt
      : undefined;

  let resumeAnnounced = await announceResumed(
    resumeOptions,
    job.jobId,
    job.taskId,
    startGrant,
    resumedSessionId,
    resumeStartedAt,
  );
  if (!resumeAnnounced) {
    const stopped = await requestLocalJson(
      resumeOptions,
      "POST",
      `/api/tasks/${encodeURIComponent(job.taskId)}/stop`,
      {
        projectId: job.projectId,
        resumedSessionId,
      },
    );
    if (stopped.ok || stopped.body?.terminationConfirmed === true) {
      const closed = await announceResumeTerminal(
        resumeOptions,
        job.jobId,
        job.taskId,
        startGrant,
        resumeStartedAt,
        "failed",
        resumedSessionId,
        {
          message: `${options.hostId} stopped ${job.taskId} after its running acknowledgement was lost.`,
        },
      );
      return closed ? "failed" : "awaiting_approval";
    }
  }
  const localJob = await pollLocalDispatch(
    resumeOptions,
    job.taskId,
    job.jobId,
    startGrant.leaseId,
    resumeStartedAt ?? runStartedAt,
    {
      expectedSessionId: resumedSessionId,
      ...(resumeAnnounced
        ? {}
        : {
            beforePoll: async () => {
              if (resumeAnnounced) return;
              resumeAnnounced = await announceResumed(
                resumeOptions,
                job.jobId,
                job.taskId,
                startGrant,
                resumedSessionId,
                resumeStartedAt,
              );
            },
            tolerateLeaseRenewalFailure: () => !resumeAnnounced,
          }),
    },
  );
  if (localJob.status === "awaiting_approval") return "awaiting_approval";
  if (localJob.sessionId !== resumedSessionId) {
    return "awaiting_approval";
  }
  if (!resumeAnnounced) return "awaiting_approval";
  const completed = isSuccessfulDispatchStatus(localJob.status);
  const metadata = metadataFromLocalJob(localJob);
  const workerCompletion = completed
    ? await collectWorkerCompletion(
        resumeOptions,
        job.taskId,
        localJob.sessionId,
        job.jobId,
        startGrant.leaseId,
      )
    : undefined;
  const status = completed ? "completed" : "failed";
  const terminalAccepted = await announceResumeTerminal(
    resumeOptions,
    job.jobId,
    job.taskId,
    startGrant,
    resumeStartedAt,
    status,
    resumedSessionId,
    {
      branchName: metadata.branchName ?? job.branchName,
      commitSha: workerCompletion?.mergeCommitSha ?? metadata.commitSha ?? job.commitSha,
      targetBranch: workerCompletion?.mergeTargetBranch,
      message: `${options.hostId} resumed local dispatch ${localJob.status} for ${job.taskId}.`,
      workerCompletion,
      evidence: [
        jobEvidence(job, localJob, {
          exitCode: localJob.exitCode,
          outputTail: Array.isArray(localJob.output) ? localJob.output.slice(-20) : [],
          workerCompletion,
        }),
      ],
    },
  );
  if (!terminalAccepted) return "awaiting_approval";
  return status;
}

async function executeVerifyJob(options, job) {
  const projectReady = await ensureLocalTaskProject(options, job.taskId);
  if (!projectReady.ok) {
    await postJobEvent(options, job.jobId, {
      status: "failed",
      message: `Local worker runtime cannot see ${job.taskId}: ${projectReady.reason}`,
      evidence: [
        {
          type: "worker_verify",
          hostId: options.hostId,
          jobId: job.jobId,
          taskId: job.taskId,
          status: 0,
          result: {
            allPassed: false,
            error: projectReady.reason,
            localRuntimeUrl: options.localRuntimeUrl,
            projects: projectReady.projects,
          },
        },
      ],
    });
    return false;
  }
  await postJobEvent(options, job.jobId, {
    status: "verifying",
    message: `${options.hostId} starting local verification for ${job.taskId}${projectReady.switched ? ` on ${projectReady.projectId}` : ""}.`,
  });
  const result = await requestLocalJson(
    options,
    "POST",
    `/api/tasks/${encodeURIComponent(job.taskId)}/verify`,
    {
      includeOptional: options.includeOptionalVerify,
    },
  );
  const passed = verificationPassed(result);
  await postJobEvent(options, job.jobId, {
    status: passed ? "completed" : "failed",
    message: `${options.hostId} local verify ${passed ? "passed" : "failed"} for ${job.taskId}.`,
    evidence: [
      {
        type: "worker_verify",
        hostId: options.hostId,
        jobId: job.jobId,
        taskId: job.taskId,
        status: result.status,
        result: result.body,
      },
    ],
  });
  return passed;
}

function verificationPassed(result) {
  if (!result.ok || !result.body) return false;
  if (typeof result.body.allPassed === "boolean") return result.body.allPassed;
  if (typeof result.body.passed === "boolean") return result.body.passed;
  if (Array.isArray(result.body.commands)) {
    return result.body.commands.every((command) => command?.passed !== false);
  }
  return true;
}

async function executeFixJob(options, job) {
  if (
    !exactDispatchObservationScope(
      options,
      job.taskId,
      job.jobId,
      job.lease?.leaseId,
      "pending-start",
    )
  ) {
    await postJobEvent(options, job.jobId, {
      status: "blocked",
      message:
        "Exact local fix observation scope is missing; operator recovery is required before start.",
    });
    return false;
  }
  const projectReady = await ensureLocalTaskProject(options, job.taskId);
  if (!projectReady.ok) {
    await postJobEvent(options, job.jobId, {
      status: "failed",
      message: `Local worker runtime cannot see ${job.taskId}: ${projectReady.reason}`,
      evidence: [
        jobEvidence(job, undefined, {
          error: projectReady.reason,
          localRuntimeUrl: options.localRuntimeUrl,
          projects: projectReady.projects,
        }),
      ],
    });
    return false;
  }
  await postJobEvent(options, job.jobId, {
    status: "fixing",
    message: `${options.hostId} starting local fix revision for ${job.taskId}${projectReady.switched ? ` on ${projectReady.projectId}` : ""}.`,
  });
  const feedback = [
    job.error,
    job.decision?.reason,
    job.decision?.verificationWorkflowId
      ? `verificationWorkflowId=${job.decision.verificationWorkflowId}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const started = await requestLocalJson(
    options,
    "POST",
    `/api/tasks/${encodeURIComponent(job.taskId)}/revise`,
    {
      feedback: feedback || "Federated verification requested a bounded fix pass.",
      federatedJobId: job.jobId,
      federatedHostId: options.hostId,
      federatedHostAlias: options.alias || options.hostId,
      federatedHostEndpoint: options.listenerUrl || options.localRuntimeUrl,
      federatedLeaseId: job.lease?.leaseId,
      // TASK-1323: advisory corroboration only — the monitor derives the
      // real channel from the request shape (fed job id + host id).
      claimedChannel: "listener-execution",
    },
  );
  if (!started.ok) {
    await postJobEvent(options, job.jobId, {
      status: "failed",
      message: `Local fix revision start failed: ${JSON.stringify(started.body)}`,
      evidence: [
        jobEvidence(job, undefined, { startStatus: started.status, startBody: started.body }),
      ],
    });
    return false;
  }
  const localJob = await pollLocalDispatch(
    options,
    job.taskId,
    job.jobId,
    job.lease?.leaseId,
    undefined,
    {
      expectedSessionId: started.body?.sessionId,
    },
  );
  const metadata = metadataFromLocalJob(localJob);
  const completed = localJob.status === "completed";
  await postJobEvent(options, job.jobId, {
    status: completed ? "completed" : "failed",
    remoteSessionId: localJob.sessionId,
    branchName: metadata.branchName ?? job.branchName,
    commitSha: metadata.commitSha ?? job.commitSha,
    message: `${options.hostId} local fix ${localJob.status} for ${job.taskId}.`,
    evidence: [
      jobEvidence(job, localJob, {
        exitCode: localJob.exitCode,
        outputTail: Array.isArray(localJob.output) ? localJob.output.slice(-20) : [],
      }),
    ],
  });
  return completed;
}

async function executeJob(options, job) {
  if (job.jobType === "dispatch" && job.status === "awaiting_approval") {
    return executeResumedDispatchJob(options, job);
  }
  if (job.jobType === "dispatch") return executeDispatchJob(options, job);
  if (job.jobType === "verify")
    return (await executeVerifyJob(options, job)) ? "completed" : "failed";
  if (job.jobType === "fix") return (await executeFixJob(options, job)) ? "completed" : "failed";
  await postJobEvent(options, job.jobId, {
    status: "blocked",
    message: `Worker executor does not run ${job.jobType} jobs locally.`,
  });
  return "failed";
}

async function runJob(options, job) {
  // TASK-1302: current headnodes attach projectId to each job. Scoping the
  // entire execution copy makes every event and lease renewal explicit while
  // retaining compatibility with an older headnode that does not send it yet.
  const jobOptions = {
    ...options,
    projectId: job.projectId || options.projectId,
    leaseId: job.lease?.leaseId,
  };
  if (!jobOptions.projectId) {
    console.warn(
      `[dispatch] Job ${job.jobId} has no projectId; using legacy unscoped lifecycle calls.`,
    );
  }
  try {
    const outcome = await executeJob(jobOptions, job);
    const ok = outcome !== "failed";
    return {
      status: outcome === "completed" ? 200 : outcome === "awaiting_approval" ? 202 : 500,
      ok,
      body: {
        ok,
        worked: outcome !== "awaiting_approval",
        outcome,
        jobId: job.jobId,
        taskId: job.taskId,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postJobEvent(jobOptions, job.jobId, {
      status: "failed",
      message: `${options.hostId} worker execution failed for ${job.taskId}: ${message}`,
      evidence: [
        jobEvidence(job, undefined, {
          error: "worker_execution_exception",
          message,
        }),
      ],
    });
    return {
      status: 500,
      ok: false,
      body: { ok: false, worked: true, jobId: job.jobId, taskId: job.taskId, error: message },
    };
  }
}

function assignedJobsToStart(jobsList, inflightJobIds, limit) {
  if (limit <= 0) return [];
  return jobsList
    .filter(
      (entry) => entry?.status === "assigned" && entry?.jobId && !inflightJobIds.has(entry.jobId),
    )
    .slice(0, limit);
}

function resumablePausedJobsToStart(jobsList, inflightJobIds, limit) {
  if (limit <= 0) return [];
  return jobsList
    .filter(
      (entry) =>
        entry?.status === "awaiting_approval" &&
        entry?.jobId &&
        entry.pause &&
        ["released", "resume_requested", "resume_claimed", "approved_but_not_started"].includes(
          entry.pause.state,
        ) &&
        !inflightJobIds.has(entry.jobId),
    )
    .slice(0, limit);
}

function exactLocalResumeGrantMatchesJob(state, job, hostId) {
  const pause = job?.pause;
  const grant = pause?.startGrant;
  const stored = state?.startGrant;
  const consumedAtMs = Date.parse(state?.startGrantConsumedAt || "");
  return Boolean(
    job?.projectId &&
    job?.jobType === "dispatch" &&
    job?.status === "awaiting_approval" &&
    pause?.state === "approved_but_not_started" &&
    grant &&
    stored &&
    Number.isFinite(consumedAtMs) &&
    ["approved_but_not_started", "started"].includes(state.status) &&
    state.projectId === job.projectId &&
    state.taskId === job.taskId &&
    state.jobType === job.jobType &&
    state.jobId === job.jobId &&
    state.hostId === hostId &&
    state.sessionId === pause.sessionId &&
    state.generation === pause.generation &&
    state.releaseNonce === pause.releaseNonce &&
    state.pauseOpenedAt === pause.openedAt &&
    stored.token === grant.token &&
    stored.projectId === grant.projectId &&
    stored.jobId === grant.jobId &&
    stored.taskId === grant.taskId &&
    stored.jobType === grant.jobType &&
    stored.hostId === grant.hostId &&
    stored.originalSessionId === grant.originalSessionId &&
    stored.generation === grant.generation &&
    stored.releaseNonce === grant.releaseNonce &&
    stored.claimToken === grant.claimToken &&
    stored.leaseId === grant.leaseId &&
    stored.issuedAt === grant.issuedAt &&
    stored.expiresAt === grant.expiresAt &&
    !grant.consumedAt &&
    !grant.resumedSessionId &&
    (!state.resumedSessionId || typeof state.resumedSessionId === "string"),
  );
}

/**
 * A daemon restart must reconcile a child that was durably admitted before it
 * spends a fresh worker slot. This probe is deliberately limited to an exact
 * consumed local grant: executeResumedDispatchJob can then only replay/finalize
 * that child, never reserve the capability and launch a new one.
 */
async function resumeReconciliationJobsToStart(options, jobsList, inflightJobIds, limit) {
  if (limit <= 0) return [];
  const matches = [];
  for (const job of jobsList) {
    if (
      matches.length >= limit ||
      !job?.jobId ||
      inflightJobIds.has(job.jobId) ||
      job.status !== "awaiting_approval" ||
      job.jobType !== "dispatch" ||
      job.pause?.state !== "approved_but_not_started" ||
      !job.pause?.startGrant ||
      !job.projectId
    ) {
      continue;
    }
    const jobOptions = { ...options, projectId: job.projectId, leaseId: job.lease?.leaseId };
    const projectReady = await ensureLocalTaskProject(jobOptions, job.taskId);
    if (!projectReady.ok) continue;
    const local = await fetchExactLocalResumeState(jobOptions, job, job.pause);
    if (local.ok && exactLocalResumeGrantMatchesJob(local.body?.state, job, options.hostId)) {
      matches.push(job);
    }
  }
  return matches;
}

async function work(options) {
  const commandResult = await processCommands(options);
  await heartbeat(options, commandResult.lastCommand);
  const assigned = await jobs(options);
  const jobsList = Array.isArray(assigned.body?.jobs) ? assigned.body.jobs : [];
  const job =
    assignedJobsToStart(jobsList, new Set(), 1)[0] ||
    resumablePausedJobsToStart(jobsList, new Set(), 1)[0];
  if (!job)
    return {
      status: 204,
      ok: true,
      body: { ok: true, worked: false, message: "No assigned jobs." },
    };
  return runJob(options, job);
}

async function daemon(options) {
  let completedJobs = 0;
  const inflightJobs = new Map();
  const reconciliationJobIds = new Set();
  let lastCommand;

  // TASK-899: registration can fail transiently when Headnode is briefly
  // unreachable or DNS is flaky. Retry with backoff before giving up.
  // requestJson() resolves with { ok: false, status } on 4xx/5xx instead
  // of throwing — retry on 5xx (server-side, likely transient) and on
  // network errors (fetch rejects). Don't retry on 4xx (operator config
  // issue — wrong URL, bad token, etc.) — fail loudly.
  await retryWithBackoff(
    async () => {
      const result = await register(options);
      if (!result.ok) {
        const body =
          typeof result.body === "object" ? JSON.stringify(result.body) : String(result.body);
        const err = new Error(`register returned HTTP ${result.status}: ${body}`);
        // Only mark 5xx as retryable; 4xx is a config error and should hard-fail.
        if (result.status >= 500 && result.status < 600) {
          throw err;
        }
        // Non-retryable HTTP error — wrap so retryWithBackoff sees a synchronous
        // failure but also marks it as non-retryable by short-circuiting.
        err.nonRetryable = true;
        throw err;
      }
      return result;
    },
    {
      label: "register",
      maxAttempts: 6,
      baseMs: 1000,
      maxMs: 30000,
    },
  );

  for (;;) {
    // TASK-899: wrap the per-iteration work so a transient network error
    // (heartbeat, command pull, job poll) backs off and retries instead of
    // killing the daemon. Local errors (Quack runtime startup, file system)
    // are rare in this loop body — we still log + back off so the next tick
    // can retry cleanly.
    try {
      const processedCommands = await processCommands(options);
      if (processedCommands.lastCommand) {
        lastCommand = processedCommands.lastCommand;
      }
      await heartbeat(options, lastCommand);
      const assigned = await jobs(options);
      const jobsList = Array.isArray(assigned.body?.jobs) ? assigned.body.jobs : [];
      const currentLoad = await localLoad(options.localRuntimeUrl);
      const capacityInflight = [...inflightJobs.keys()].filter(
        (jobId) => !reconciliationJobIds.has(jobId),
      ).length;
      const remainingSlots = Math.max(
        0,
        options.maxConcurrentJobs - Math.max(currentLoad, capacityInflight),
      );
      const remainingBudget =
        options.maxJobs > 0
          ? Math.max(0, options.maxJobs - completedJobs - inflightJobs.size)
          : Number.POSITIVE_INFINITY;
      const reconciliationJobs = await resumeReconciliationJobsToStart(
        options,
        jobsList,
        new Set(inflightJobs.keys()),
        remainingBudget,
      );
      const unavailableJobIds = new Set([
        ...inflightJobs.keys(),
        ...reconciliationJobs.map((job) => job.jobId),
      ]);
      const normalBudget = Math.max(0, remainingBudget - reconciliationJobs.length);
      const jobsToStart = assignedJobsToStart(
        jobsList,
        unavailableJobIds,
        Math.min(remainingSlots, normalBudget),
      );
      const resumeSlots = Math.max(0, Math.min(remainingSlots, normalBudget) - jobsToStart.length);
      jobsToStart.push(
        ...resumablePausedJobsToStart(
          jobsList,
          new Set([...unavailableJobIds, ...jobsToStart.map((job) => job.jobId)]),
          resumeSlots,
        ),
      );

      for (const job of [...reconciliationJobs, ...jobsToStart]) {
        const reconciliation = reconciliationJobs.some((entry) => entry.jobId === job.jobId);
        if (reconciliation) reconciliationJobIds.add(job.jobId);
        const promise = runJob(options, job)
          .then((result) => {
            if (result.body?.outcome !== "awaiting_approval") completedJobs += 1;
            return result;
          })
          .finally(() => {
            inflightJobs.delete(job.jobId);
            reconciliationJobIds.delete(job.jobId);
          });
        inflightJobs.set(job.jobId, promise);
      }

      if (options.maxJobs > 0 && completedJobs >= options.maxJobs && inflightJobs.size === 0) {
        return {
          status: 200,
          ok: true,
          body: {
            ok: true,
            worked: completedJobs > 0,
            completedJobs,
          },
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[listener-loop] iteration failed (transient, will retry): ${msg}`);
      // Back off a bit longer than the normal poll so we don't hammer a
      // broken Headnode in a tight loop.
      await sleep(Math.min(30000, options.pollMs * 4));
      continue;
    }

    await sleep(options.pollMs);
  }
}

function print(label, result, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify({ label, ...result }, null, 2));
    return;
  }
  console.log(`${label}: status=${result.status} ok=${result.ok}`);
  if (result.body?.listener) {
    const listener = result.body.listener;
    console.log(
      `  hostId=${listener.id} healthy=${listener.healthy} load=${listener.currentLoad ?? 0}/${listener.maxConcurrentJobs ?? 1}`,
    );
    console.log(`  capabilities=${(listener.capabilities || []).join(",")}`);
    if (listener.repoCommit) console.log(`  repoCommit=${listener.repoCommit}`);
  } else if (Array.isArray(result.body?.commands)) {
    console.log(`  commands=${result.body.commands.length}`);
  } else if (Array.isArray(result.body?.jobs)) {
    console.log(`  jobs=${result.body.jobs.length}`);
    for (const job of result.body.jobs) {
      console.log(
        `  - ${job.jobId} ${job.taskId} ${job.jobType} ${job.status} next=${job.nextAction ?? ""}`,
      );
    }
  } else if (result.body?.worked !== undefined) {
    console.log(
      `  worked=${result.body.worked} jobId=${result.body.jobId ?? ""} taskId=${result.body.taskId ?? ""}`,
    );
  } else if (!result.ok) {
    console.log(`  error=${JSON.stringify(result.body)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "register") {
    print("register", await register(options), options.json);
  } else if (options.command === "heartbeat") {
    print("heartbeat", await heartbeat(options), options.json);
  } else if (options.command === "jobs") {
    print("jobs", await jobs(options), options.json);
  } else if (options.command === "commands") {
    print("commands", await commands(options), options.json);
  } else if (options.command === "ack") {
    print("ack", await ack(options), options.json);
  } else if (options.command === "work") {
    print("work", await work(options), options.json);
  } else if (options.command === "daemon") {
    print("daemon", await daemon(options), options.json);
  } else if (options.command === "once") {
    print("register", await register(options), options.json);
    const processedCommands = await processCommands(options);
    if (processedCommands.processed > 0) {
      print("commands", processedCommands.response, options.json);
      if (processedCommands.ack) {
        print("ack", processedCommands.ack, options.json);
      }
    } else {
      print("commands", processedCommands.response, options.json);
    }
    print("heartbeat", await heartbeat(options, processedCommands.lastCommand), options.json);
    print("jobs", await jobs(options), options.json);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
