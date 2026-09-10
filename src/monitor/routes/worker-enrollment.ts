import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { loadGlobalConfig, type WorkerEnrollmentProfile } from "../../core/global-config.js";
import { ListenerRegistry, type ListenerRecord } from "../../federation/listener-registry.js";
import type { WorkerRuntimeRole } from "../../core/worker-protocol.js";
import type {
  WorkerCapabilityProbeResult,
  WorkerCapabilityProbeSpec,
  WorkerEnrollmentInstallStatus,
  WorkerEnrollmentListenerStatus,
  WorkerEnrollmentManifest,
  WorkerEnrollmentProgressEvent,
  WorkerEnrollmentProgressPhase,
  WorkerEnrollmentReadiness,
  WorkerEnrollmentSessionSummary,
  WorkerEnrollmentTargetRoots,
  WorkerInstallCommand,
} from "../../worker/enrollment-types.js";
import {
  deriveWorkerEnrollmentReadiness,
  extractRepoFreshnessFromProgress,
} from "../../worker/enrollment-readiness.js";
import type { AuthService } from "../auth.js";
import { hashServiceToken } from "../auth.js";

const DEFAULT_CONTROL_BASE_URL = process.env.QUACK_CONTROL_BASE_URL || "http://127.0.0.1:3333";
const DEFAULT_PROFILE_ID = "default-worker-profile";
const DEFAULT_ENROLLMENT_TTL_MINUTES = 60;
const MAX_ENROLLMENT_TTL_MINUTES = 24 * 60;

const createEnrollmentSchema = z.object({
  hostId: z.string().trim().min(1),
  alias: z.string().trim().min(1).optional(),
  profileId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  runtimePort: z.number().int().min(1).max(65535).optional(),
  maxConcurrentJobs: z.number().int().positive().max(16).optional(),
  capabilities: z.array(z.string().trim().min(1)).min(1).optional(),
  persistence: z
    .enum(["manual", "run-key", "scheduled-task-logon", "scheduled-task-startup"])
    .optional(),
  ttlMinutes: z.number().int().positive().max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
  targetRootWindows: z.string().trim().min(1).optional(),
  targetRootPosix: z.string().trim().min(1).optional(),
});

const enrollmentProgressPhaseSchema = z.enum([
  "bootstrap",
  "prerequisites",
  "repo_sync",
  "dependency_install",
  "env_write",
  "capability_probe",
  "runtime_start",
  "runtime_health",
  "listener_register",
  "completed",
] satisfies readonly WorkerEnrollmentProgressPhase[]);

const enrollmentProgressEventSchema = z.object({
  phase: enrollmentProgressPhaseSchema,
  state: z.enum(["running", "completed", "failed", "waiting"]),
  message: z.string().trim().min(1),
  detail: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().trim().min(1).optional(),
});

const capabilityResultSchema = z.object({
  capability: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "withheld", "deferred"]),
  projectId: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  command: z
    .object({
      cmd: z.string().trim().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().trim().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
      optional: z.boolean().optional(),
      description: z.string().trim().min(1).optional(),
    })
    .optional(),
});

interface WorkerEnrollmentProjectRef {
  id: string;
  label: string;
  pathAlias: string;
  repoId: string;
  primary?: boolean;
  installCommands: WorkerInstallCommand[];
  probeCommands: WorkerInstallCommand[];
  capabilityProbes?: WorkerCapabilityProbeSpec[];
}

interface WorkerEnrollmentProfileResolved {
  id: string;
  label: string;
  controlBaseUrl: string;
  runtimePort: number;
  maxConcurrentJobs: number;
  pollMs: number;
  persistence: WorkerEnrollmentManifest["worker"]["persistence"];
  capabilities: string[];
  repos: WorkerEnrollmentManifest["repos"];
  projects: WorkerEnrollmentProjectRef[];
  env: WorkerEnrollmentManifest["env"];
  secrets: WorkerEnrollmentManifest["secrets"];
  manualSteps: string[];
}

interface WorkerEnrollmentSessionRecord {
  enrollmentId: string;
  hostId: string;
  alias: string;
  profileId: string;
  projectId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  createdBy: string;
  runtimePort: number;
  capabilities: string[];
  persistence: WorkerEnrollmentManifest["worker"]["persistence"];
  bootstrapTokenHash: string;
  manifest: WorkerEnrollmentManifest;
  workerTokenId?: string;
  progressEvents?: WorkerEnrollmentProgressEvent[];
  capabilityResults?: WorkerCapabilityProbeResult[];
}

interface WorkerEnrollmentRouteProject {
  projectRoot?: string | null;
}

export interface WorkerEnrollmentRouteDeps {
  resolveProject: (req: Request) => WorkerEnrollmentRouteProject;
  authService: AuthService;
  requireServiceScope: (req: Request, res: Response, scope: string) => string | undefined;
  requireServiceScopeAny?: (req: Request, res: Response, scopes: string[]) => string | undefined;
}

interface WorkerEnrollmentSessionView extends WorkerEnrollmentSessionSummary {
  installStatus: WorkerEnrollmentInstallStatus;
  readiness: WorkerEnrollmentReadiness;
  listener?: WorkerEnrollmentListenerStatus | null;
}

const ENROLLMENT_PROGRESS_PHASES: WorkerEnrollmentProgressPhase[] = [
  "bootstrap",
  "prerequisites",
  "repo_sync",
  "dependency_install",
  "env_write",
  "capability_probe",
  "runtime_start",
  "runtime_health",
  "listener_register",
  "completed",
];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worker"
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function workerEnrollmentsDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "worker-enrollments");
}

function workerEnrollmentPath(projectRoot: string, enrollmentId: string): string {
  return path.join(workerEnrollmentsDir(projectRoot), `${enrollmentId}.json`);
}

function deriveSessionStatus(
  session: Pick<WorkerEnrollmentSessionRecord, "expiresAt" | "consumedAt">,
  nowMs = Date.now(),
): WorkerEnrollmentSessionSummary["status"] {
  if (session.consumedAt) return "consumed";
  if (Date.parse(session.expiresAt) <= nowMs) return "expired";
  return "pending";
}

function toSessionSummary(session: WorkerEnrollmentSessionRecord): WorkerEnrollmentSessionSummary {
  return {
    enrollmentId: session.enrollmentId,
    hostId: session.hostId,
    alias: session.alias,
    profileId: session.profileId,
    projectId: session.projectId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    consumedAt: session.consumedAt,
    createdBy: session.createdBy,
    status: deriveSessionStatus(session),
    runtimePort: session.runtimePort,
    capabilities: session.capabilities,
    persistence: session.persistence,
  };
}

function buildListenerStatus(
  listener: ListenerRecord | undefined,
): WorkerEnrollmentListenerStatus | null {
  if (!listener) return null;
  return {
    hostId: listener.id,
    alias: listener.alias,
    registeredAt: listener.registeredAt,
    lastHealthCheckAt: listener.lastHealthCheckAt,
    healthy: listener.healthy === true,
    currentLoad: listener.currentLoad,
    maxConcurrentJobs: listener.maxConcurrentJobs,
    capabilities: [...listener.capabilities],
    runtimeRole: listener.runtimeRole,
    protocolVersion: listener.protocolVersion,
    metadata: listener.metadata ? { ...listener.metadata } : undefined,
  };
}

function normalizedProgressEvents(
  record: WorkerEnrollmentSessionRecord,
): WorkerEnrollmentProgressEvent[] {
  return (record.progressEvents ?? []).map((event, index) => ({
    ...event,
    id: event.id || `${record.enrollmentId}:${index + 1}`,
  }));
}

function deriveAdvertisedCapabilities(
  record: WorkerEnrollmentSessionRecord,
  listener: ListenerRecord | undefined,
): string[] {
  const requested = [...record.manifest.worker.capabilities];
  const repoBlocked = extractRepoFreshnessFromProgress(normalizedProgressEvents(record)).some(
    (repo) => repo.blockers.length > 0,
  );
  const blockedBase = new Set(repoBlocked ? ["dispatch", "verify", "fix"] : []);
  if (listener?.capabilities?.length) {
    return listener.capabilities.filter((capability) => !blockedBase.has(capability));
  }
  if (!record.capabilityResults?.length) {
    return requested.filter((capability) => !blockedBase.has(capability));
  }
  const withheld = new Set(
    record.capabilityResults
      .filter((result) => result.status === "failed" || result.status === "withheld")
      .map((result) => result.capability),
  );
  return requested.filter(
    (capability) => !withheld.has(capability) && !blockedBase.has(capability),
  );
}

function deriveCapabilityWarnings(
  record: WorkerEnrollmentSessionRecord,
  listener: ListenerRecord | undefined,
): string[] {
  const warnings = new Set<string>();
  for (const result of record.capabilityResults ?? []) {
    if (result.status === "failed" || result.status === "withheld") {
      warnings.add(`${result.capability}: ${result.message}`);
    }
  }
  const capabilityWarning =
    typeof listener?.metadata?.capabilityWarning === "string"
      ? listener.metadata.capabilityWarning
      : undefined;
  if (capabilityWarning) {
    warnings.add(capabilityWarning);
  }
  return [...warnings];
}

function phaseProgressPercent(phase: WorkerEnrollmentProgressPhase | undefined): number {
  if (!phase) return 0;
  const index = ENROLLMENT_PROGRESS_PHASES.indexOf(phase);
  if (index < 0) return 0;
  return Math.min(95, Math.round(((index + 1) / ENROLLMENT_PROGRESS_PHASES.length) * 100));
}

function deriveInstallStatus(
  record: WorkerEnrollmentSessionRecord,
  listener: ListenerRecord | undefined,
): WorkerEnrollmentInstallStatus {
  const sessionState = deriveSessionStatus(record);
  const progressEvents = normalizedProgressEvents(record);
  const lastEvent = progressEvents.at(-1);
  const runtimeState = listener?.metadata?.localRuntime;
  const runtimeHealthy = listener?.healthy === true && runtimeState !== "offline";
  const listenerRegistered = Boolean(listener);
  const listenerHealthy = listener?.healthy === true;
  const manualFollowUpCount = record.manifest.manualSteps.length;
  const advertisedCapabilities = deriveAdvertisedCapabilities(record, listener);
  const capabilityWarnings = deriveCapabilityWarnings(record, listener);

  let state: WorkerEnrollmentInstallStatus["state"] = "pending";
  if (sessionState === "expired") {
    state = "expired";
  } else if (lastEvent?.state === "failed") {
    state = "failed";
  } else if (runtimeHealthy) {
    state = "healthy";
  } else if (listenerRegistered && listenerHealthy) {
    state = "registered";
  } else if (lastEvent) {
    state =
      record.consumedAt &&
      progressEvents.length === 1 &&
      lastEvent.phase === "bootstrap" &&
      lastEvent.state === "completed"
        ? "bootstrap_consumed"
        : "installing";
  } else if (record.consumedAt) {
    state = "bootstrap_consumed";
  }

  const progressPercent =
    state === "healthy"
      ? 100
      : state === "registered"
        ? 90
        : state === "expired" || state === "pending"
          ? 0
          : state === "bootstrap_consumed"
            ? 10
            : phaseProgressPercent(lastEvent?.phase);

  return {
    state,
    progressPercent,
    currentStep: state === "healthy" ? "completed" : lastEvent?.phase,
    lastMessage: lastEvent?.message,
    lastEventAt: lastEvent?.timestamp ?? listener?.lastHealthCheckAt ?? record.consumedAt,
    bootstrapConsumed: Boolean(record.consumedAt),
    listenerRegistered,
    listenerHealthy,
    runtimeHealthy,
    manualFollowUpPending: manualFollowUpCount > 0,
    manualFollowUpCount,
    requestedCapabilities: [...record.manifest.worker.capabilities],
    advertisedCapabilities,
    capabilityWarnings,
  };
}

function toSessionView(
  record: WorkerEnrollmentSessionRecord,
  listener: ListenerRecord | undefined,
): WorkerEnrollmentSessionView {
  const installStatus = deriveInstallStatus(record, listener);
  const listenerStatus = buildListenerStatus(listener);
  return {
    ...toSessionSummary(record),
    installStatus,
    readiness: deriveWorkerEnrollmentReadiness({
      manifest: record.manifest,
      installStatus,
      listener: listenerStatus,
      progressEvents: normalizedProgressEvents(record),
      capabilityResults: record.capabilityResults ?? [],
      repairCommand: `node dist/index.js worker install --control-base-url ${record.manifest.controlPlane.baseUrl} --bootstrap-token <fresh-qenr-token> --repair --start`,
    }),
    listener: listenerStatus,
  };
}

function appendProgressEvents(
  record: WorkerEnrollmentSessionRecord,
  events: Array<z.infer<typeof enrollmentProgressEventSchema>>,
): void {
  const existing = normalizedProgressEvents(record);
  const next = events.map((event, index) => ({
    id: `${record.enrollmentId}:${existing.length + index + 1}`,
    phase: event.phase,
    state: event.state,
    message: event.message,
    detail: event.detail,
    metadata: event.metadata,
    timestamp: event.timestamp ?? nowIso(),
  }));
  record.progressEvents = [...existing, ...next].slice(-200);
}

function ensureEnrollmentsDir(projectRoot: string): string {
  const dir = workerEnrollmentsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listEnrollmentRecords(projectRoot: string): WorkerEnrollmentSessionRecord[] {
  const dir = workerEnrollmentsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const fullPath = path.join(dir, entry);
      try {
        return JSON.parse(fs.readFileSync(fullPath, "utf-8")) as WorkerEnrollmentSessionRecord;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is WorkerEnrollmentSessionRecord => !!entry)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function loadEnrollmentRecord(
  projectRoot: string,
  enrollmentId: string,
): WorkerEnrollmentSessionRecord | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(workerEnrollmentPath(projectRoot, enrollmentId), "utf-8"),
    ) as WorkerEnrollmentSessionRecord;
  } catch {
    return undefined;
  }
}

function saveEnrollmentRecord(projectRoot: string, record: WorkerEnrollmentSessionRecord): void {
  ensureEnrollmentsDir(projectRoot);
  fs.writeFileSync(
    workerEnrollmentPath(projectRoot, record.enrollmentId),
    JSON.stringify(record, null, 2) + "\n",
    "utf-8",
  );
}

async function listenerForEnrollment(
  projectRoot: string,
  hostId: string,
): Promise<ListenerRecord | undefined> {
  return new ListenerRegistry(projectRoot).get(hostId);
}

function gitOutput(repoPath: string, args: string[]): string | undefined {
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

function detectRepoSourceUrl(repoPath: string): string {
  return gitOutput(repoPath, ["config", "--get", "remote.origin.url"]) || repoPath;
}

function sanitizeRepoSourceUrl(sourceUrl: string): {
  sourceUrl: string;
  credentialsRemoved: boolean;
} {
  const trimmed = sourceUrl.trim();
  if (!trimmed) {
    return { sourceUrl: trimmed, credentialsRemoved: false };
  }

  const hasGitPrefix = trimmed.startsWith("git+");
  const candidate = hasGitPrefix ? trimmed.slice(4) : trimmed;
  try {
    const parsed = new URL(candidate);
    const hadCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    if (!hadCredentials) {
      return { sourceUrl: trimmed, credentialsRemoved: false };
    }
    parsed.username = "";
    parsed.password = "";
    return {
      sourceUrl: `${hasGitPrefix ? "git+" : ""}${parsed.toString()}`,
      credentialsRemoved: true,
    };
  } catch {
    return { sourceUrl: trimmed, credentialsRemoved: false };
  }
}

function pushUniqueManualStep(manualSteps: string[], step: string): void {
  if (!manualSteps.includes(step)) {
    manualSteps.push(step);
  }
}

function buildManifestPreview(manifest: WorkerEnrollmentManifest): WorkerEnrollmentManifest {
  return {
    ...manifest,
    worker: { ...manifest.worker },
    controlPlane: { ...manifest.controlPlane },
    prerequisites: manifest.prerequisites.map((prerequisite) => ({
      ...prerequisite,
      checkCommand: prerequisite.checkCommand
        ? {
            ...prerequisite.checkCommand,
            args: [...prerequisite.checkCommand.args],
            env: prerequisite.checkCommand.env ? { ...prerequisite.checkCommand.env } : undefined,
          }
        : undefined,
    })),
    repos: manifest.repos.map((repo) => ({
      ...repo,
      sourceUrl: sanitizeRepoSourceUrl(repo.sourceUrl).sourceUrl,
    })),
    projects: manifest.projects.map((project) => ({
      ...project,
      installCommands: project.installCommands.map((command) => ({
        ...command,
        args: [...command.args],
        env: command.env ? { ...command.env } : undefined,
      })),
      probeCommands: project.probeCommands.map((command) => ({
        ...command,
        args: [...command.args],
        env: command.env ? { ...command.env } : undefined,
      })),
      capabilityProbes: project.capabilityProbes?.map((probe) => ({
        capability: probe.capability,
        description: probe.description,
        command: {
          ...probe.command,
          args: [...probe.command.args],
          env: probe.command.env ? { ...probe.command.env } : undefined,
        },
      })),
    })),
    env: manifest.env.map((entry) => ({
      ...entry,
      value: undefined,
    })),
    secrets: manifest.secrets.map((secret) => ({ ...secret })),
    manualSteps: [...manifest.manualSteps],
  };
}

function detectInstallCommands(repoPath: string): WorkerInstallCommand[] {
  const commands: WorkerInstallCommand[] = [];
  if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) {
    commands.push({
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile"],
      description: "Install pnpm dependencies",
    });
  } else if (fs.existsSync(path.join(repoPath, "yarn.lock"))) {
    commands.push({
      cmd: "yarn",
      args: ["install", "--frozen-lockfile"],
      description: "Install yarn dependencies",
    });
  } else if (fs.existsSync(path.join(repoPath, "package-lock.json"))) {
    commands.push({
      cmd: "npm",
      args: ["ci"],
      description: "Install npm dependencies from the lockfile",
    });
  } else if (fs.existsSync(path.join(repoPath, "package.json"))) {
    commands.push({
      cmd: "npm",
      args: ["install"],
      description: "Install npm dependencies",
    });
  }

  if (fs.existsSync(path.join(repoPath, "requirements.txt"))) {
    commands.push({
      cmd: "python",
      args: ["-m", "pip", "install", "-r", "requirements.txt"],
      description: "Install Python requirements",
    });
  }

  return commands;
}

function detectProbeCommands(_repoPath: string): WorkerInstallCommand[] {
  return [];
}

function detectQuackRepoPath(): string | undefined {
  const config = loadGlobalConfig();
  const match = config.projects.find((project) => /(^|[\\/])Quack$/i.test(project.path));
  if (match) return match.path;
  return process.cwd();
}

function registeredProjectCandidates(): Array<{ id: string; label: string; path: string }> {
  const config = loadGlobalConfig();
  return config.projects
    .map((project) => {
      const label = path.basename(project.path);
      return {
        id: slugify(label),
        label,
        path: project.path,
      };
    })
    .filter((project) => !/^quack(?:-quack)?$/i.test(project.label));
}

function projectRepoSpec(
  project: { id: string; label: string; path: string },
  destination = project.label,
  branchOverride?: string,
): WorkerEnrollmentManifest["repos"][number] {
  return {
    id: project.id,
    label: project.label,
    sourceUrl: detectRepoSourceUrl(project.path),
    branch: branchOverride || gitOutput(project.path, ["branch", "--show-current"]) || "main",
    destination,
    required: true,
  };
}

function quackRepoSpec(
  quackRepoPath: string | undefined,
  branchOverride?: string,
): WorkerEnrollmentManifest["repos"][number] | undefined {
  if (!quackRepoPath) return undefined;
  return {
    id: "quack",
    label: "Quack",
    sourceUrl: detectRepoSourceUrl(quackRepoPath),
    branch: branchOverride || gitOutput(quackRepoPath, ["branch", "--show-current"]) || "main",
    destination: "Quack",
    required: true,
  };
}

function resolveSecretEnv(profile: WorkerEnrollmentProfile | undefined): {
  env: WorkerEnrollmentManifest["env"];
  secrets: WorkerEnrollmentManifest["secrets"];
  manualSteps: string[];
} {
  const env = [...(profile?.env ?? [])];
  const secrets: WorkerEnrollmentManifest["secrets"] = [];
  const manualSteps: string[] = [];

  for (const secret of profile?.secrets ?? []) {
    const resolvedValue =
      secret.mode === "auto" && secret.sourceEnvVar ? process.env[secret.sourceEnvVar] : undefined;
    secrets.push({
      id: secret.id,
      mode: secret.mode,
      envName: secret.envName,
      sourceEnvVar: secret.sourceEnvVar,
      placeholder: secret.placeholder,
      description: secret.description,
    });

    if (secret.envName) {
      env.push({
        name: secret.envName,
        mode: resolvedValue ? "inline" : "manual",
        value: resolvedValue,
        placeholder: resolvedValue
          ? undefined
          : secret.placeholder || `TODO_${secret.id.toUpperCase()}`,
        description: secret.description,
        secretRef: secret.id,
      });
    }

    if (!resolvedValue) {
      manualSteps.push(
        `Fill ${secret.envName ?? secret.id} (${secret.id}) before advertising workloads that require it.`,
      );
    }
  }

  return { env, secrets, manualSteps };
}

function inferGenericProfile(): WorkerEnrollmentProfileResolved {
  const quackRepoPath = detectQuackRepoPath();
  const candidates = registeredProjectCandidates();
  const primaryProject = candidates[0];
  const repos: WorkerEnrollmentManifest["repos"] = [];
  const projects: WorkerEnrollmentProjectRef[] = [];
  const manualSteps: string[] = [];

  const quackRepo = quackRepoSpec(quackRepoPath);
  if (quackRepo) {
    repos.push(quackRepo);
  }

  if (primaryProject) {
    repos.push(projectRepoSpec(primaryProject));
    projects.push({
      id: primaryProject.id,
      label: primaryProject.label,
      repoId: primaryProject.id,
      pathAlias: primaryProject.id,
      primary: true,
      installCommands: detectInstallCommands(primaryProject.path),
      probeCommands: detectProbeCommands(primaryProject.path),
    });
  } else {
    manualSteps.push(
      "Add a non-Quack project to ~/.quack/config.json or define workerProfiles[] before using the default enrollment profile.",
    );
  }

  return {
    id: DEFAULT_PROFILE_ID,
    label: "Default worker profile",
    controlBaseUrl: DEFAULT_CONTROL_BASE_URL,
    runtimePort: 3337,
    maxConcurrentJobs: 1,
    pollMs: 15_000,
    persistence: process.platform === "win32" ? "scheduled-task-logon" : "manual",
    capabilities: ["dispatch", "verify", "fix"],
    repos,
    projects,
    env: [],
    secrets: [],
    manualSteps,
  };
}

function inferExampleWorkerProfile(): WorkerEnrollmentProfileResolved | undefined {
  const quackRepoPath = detectQuackRepoPath();
  const candidates = registeredProjectCandidates();
  const exampleProject = candidates.find(
    (candidate) => candidate.id === "example-service" || /example-service/i.test(candidate.label),
  );
  const quackRepo = quackRepoSpec(quackRepoPath, "main");
  if (!exampleProject || !quackRepo) {
    return undefined;
  }

  return {
    id: "example-worker",
    label: "Example worker",
    controlBaseUrl: DEFAULT_CONTROL_BASE_URL,
    runtimePort: 3337,
    maxConcurrentJobs: 1,
    pollMs: 15_000,
    persistence: process.platform === "win32" ? "scheduled-task-logon" : "manual",
    capabilities: ["dispatch", "verify", "fix", "backend"],
    repos: [quackRepo, projectRepoSpec(exampleProject, "example-service", "dev")],
    projects: [
      {
        id: "example-service",
        label: "Example Assistant MVP",
        repoId: exampleProject.id,
        pathAlias: "example",
        primary: true,
        installCommands: [
          {
            cmd: "npm",
            args: ["ci"],
            description: "Install root workspace dependencies",
          },
          {
            cmd: "npm",
            args: ["--prefix", "src", "ci"],
            description: "Install backend dependencies",
          },
          {
            cmd: "npm",
            args: ["--prefix", "frontends/web-dashboard", "ci"],
            description: "Install Web app dashboard dependencies",
          },
        ],
        probeCommands: [
          {
            cmd: "npm",
            args: ["--prefix", "frontends/web-dashboard", "run", "build"],
            description: "Build the Web app dashboard bundle",
          },
        ],
        capabilityProbes: [
          {
            capability: "backend",
            description: "Run a focused Example backend proof command",
            command: {
              cmd: "npm",
              args: [
                "--prefix",
                "src",
                "test",
                "--",
                "--runInBand",
                "--runTestsByPath",
                "tests/unit/services/waitlist.service.test.js",
              ],
            },
          },
        ],
      },
    ],
    env: [
      {
        name: "NODE_ENV",
        mode: "inline",
        value: "development",
        description: "Default worker runtime mode for Example local tooling",
      },
    ],
    secrets: [],
    manualSteps: [
      "Copy the approved Example env overrides (.env.test or equivalent) onto the worker host before enabling auth or staging-db workloads.",
      "Re-run the worker installer after adding extra browser, Docker, auth, or DB prerequisites so the worker can advertise newly-probed capabilities.",
    ],
  };
}

function resolveAvailableProfiles(): WorkerEnrollmentProfileResolved[] {
  const config = loadGlobalConfig();
  const storedProfiles = config.workerProfiles ?? [];
  if (storedProfiles.length > 0) {
    return storedProfiles.map((profile) => {
      const { env, secrets, manualSteps: secretManualSteps } = resolveSecretEnv(profile);
      return {
        id: profile.id,
        label: profile.label,
        controlBaseUrl: profile.controlBaseUrl || DEFAULT_CONTROL_BASE_URL,
        runtimePort: profile.runtimePort ?? 3337,
        maxConcurrentJobs: profile.maxConcurrentJobs ?? 1,
        pollMs: profile.pollMs ?? 15_000,
        persistence:
          profile.persistence ?? (process.platform === "win32" ? "scheduled-task-logon" : "manual"),
        capabilities: profile.capabilities?.length
          ? profile.capabilities
          : ["dispatch", "verify", "fix"],
        repos: profile.repos.map((repo) => ({
          id: repo.id,
          label: repo.label,
          sourceUrl: repo.sourceUrl,
          branch: repo.branch || "main",
          destination: repo.destination || repo.label,
          required: repo.required !== false,
        })),
        projects: profile.projects.map((project) => ({
          id: project.id,
          label: project.label,
          repoId: project.repoId,
          pathAlias: project.pathAlias,
          primary: project.primary,
          installCommands: project.installCommands ?? [],
          probeCommands: project.probeCommands ?? [],
          capabilityProbes: project.capabilityProbes?.map((probe) => ({
            capability: probe.capability,
            description: probe.description,
            command: {
              ...probe.command,
              args: [...probe.command.args],
              env: probe.command.env ? { ...probe.command.env } : undefined,
            },
          })),
        })),
        env,
        secrets,
        manualSteps: [...(profile.manualSteps ?? []), ...secretManualSteps],
      };
    });
  }

  const inferred: WorkerEnrollmentProfileResolved[] = [];
  const example = inferExampleWorkerProfile();
  if (example) {
    inferred.push(example);
  }
  inferred.push(inferGenericProfile());
  return inferred;
}

function resolveProfile(profileId?: string): WorkerEnrollmentProfileResolved {
  const available = resolveAvailableProfiles();
  return available.find((entry) => entry.id === profileId) ?? available[0] ?? inferGenericProfile();
}

function inferRequestBaseUrl(req: Request): string | undefined {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const proto =
    typeof forwardedProto === "string" && forwardedProto.trim().length > 0
      ? forwardedProto.split(",")[0]?.trim()
      : req.protocol;
  const host =
    typeof forwardedHost === "string" && forwardedHost.trim().length > 0
      ? forwardedHost.split(",")[0]?.trim()
      : req.get("host")?.trim();
  if (!proto || !host) {
    return undefined;
  }
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function resolveControlBaseUrlForRequest(
  req: Request,
  profile: WorkerEnrollmentProfileResolved,
): string {
  const requestBaseUrl = inferRequestBaseUrl(req);
  const configuredBaseUrl = profile.controlBaseUrl.trim().replace(/\/+$/, "");
  if (
    requestBaseUrl &&
    configuredBaseUrl === DEFAULT_CONTROL_BASE_URL &&
    requestBaseUrl !== configuredBaseUrl
  ) {
    return requestBaseUrl;
  }
  return configuredBaseUrl || requestBaseUrl || DEFAULT_CONTROL_BASE_URL;
}

function buildManifest(
  session: {
    enrollmentId: string;
    hostId: string;
    alias: string;
    expiresAt: string;
    runtimePort: number;
    maxConcurrentJobs: number;
    capabilities: string[];
    persistence: WorkerEnrollmentManifest["worker"]["persistence"];
    controlBaseUrl: string;
  },
  profile: WorkerEnrollmentProfileResolved,
): WorkerEnrollmentManifest {
  const issuedAt = nowIso();
  const manualSteps = [...profile.manualSteps];
  const repos = profile.repos.map((repo) => {
    const sanitized = sanitizeRepoSourceUrl(repo.sourceUrl);
    if (sanitized.credentialsRemoved) {
      pushUniqueManualStep(
        manualSteps,
        "Configure a git credential helper with secure storage before running the bootstrap command: run `gh auth login` (preferred) or use an operating-system-backed helper such as Git Credential Manager. The bootstrap will then clone the repository through the helper instead of embedding a PAT in the URL. For an existing clone whose remote URL contains credentials, replace it with the credential-free HTTPS URL and rotate the exposed token before reuse.",
      );
    }
    return {
      ...repo,
      sourceUrl: sanitized.sourceUrl,
    };
  });
  return {
    version: "worker-enrollment-v1",
    enrollmentId: session.enrollmentId,
    issuedAt,
    expiresAt: session.expiresAt,
    controlPlane: {
      baseUrl: session.controlBaseUrl,
      runtimeRole: "headnode" satisfies WorkerRuntimeRole,
    },
    worker: {
      hostId: session.hostId,
      alias: session.alias,
      capabilities: session.capabilities,
      maxConcurrentJobs: session.maxConcurrentJobs,
      runtimePort: session.runtimePort,
      persistence: session.persistence,
      pollMs: profile.pollMs,
    },
    prerequisites: [
      {
        id: "git",
        label: "Git",
        required: true,
        checkCommand: { cmd: "git", args: ["--version"] },
      },
      {
        id: "node",
        label: "Node.js 18+",
        required: true,
        checkCommand: { cmd: "node", args: ["--version"] },
      },
      {
        id: "tailscale",
        label: "Tailscale",
        required: true,
        checkCommand: { cmd: "tailscale", args: ["status"] },
      },
    ],
    repos,
    projects: profile.projects.map((project) => ({
      id: project.id,
      label: project.label,
      repoId: project.repoId,
      pathAlias: project.pathAlias,
      primary: project.primary,
      installCommands: project.installCommands,
      probeCommands: project.probeCommands,
      capabilityProbes: project.capabilityProbes,
    })),
    env: profile.env,
    secrets: profile.secrets,
    manualSteps,
  };
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toPosixSingleQuoted(value: string): string {
  // eslint-disable-next-line no-useless-escape
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function bootstrapCommand(
  manifest: WorkerEnrollmentManifest,
  bootstrapToken: string,
  platform: "windows" | "posix",
  options: {
    targetRoot?: string;
    repair?: boolean;
  } = {},
): string {
  const quackRepo = manifest.repos.find((repo) => repo.id === "quack") ?? manifest.repos[0];
  const cloneUrl = quackRepo?.sourceUrl || "<quack-repo-url>";
  const quackBranch = quackRepo?.branch || "main";
  const hostId = manifest.worker.hostId;
  const repairFlag = options.repair ? " --repair" : "";

  if (platform === "windows") {
    const workerRootAssignment = options.targetRoot?.trim()
      ? `$workerRoot = ${toPowerShellSingleQuoted(options.targetRoot.trim())}`
      : "$workerRoot = Join-Path $env:USERPROFILE 'QuackWorkers\\" + hostId + "'";
    return [
      workerRootAssignment,
      "New-Item -ItemType Directory -Force -Path $workerRoot | Out-Null",
      "if (-not (Test-Path (Join-Path $workerRoot 'Quack'))) { git clone --branch " +
        quackBranch +
        " " +
        cloneUrl +
        " (Join-Path $workerRoot 'Quack') }",
      "Set-Location (Join-Path $workerRoot 'Quack')",
      "npm ci",
      "npm --prefix frontend ci",
      "npm run build",
      "node .\\dist\\index.js worker install --control-base-url " +
        manifest.controlPlane.baseUrl +
        " --bootstrap-token " +
        bootstrapToken +
        " --target-root $workerRoot" +
        repairFlag +
        " --start",
    ].join("; ");
  }

  const workerRootExport = options.targetRoot?.trim()
    ? `export WORKER_ROOT=${toPosixSingleQuoted(options.targetRoot.trim())}`
    : `export WORKER_ROOT="$HOME/QuackWorkers/${hostId}"`;

  return [
    workerRootExport,
    'mkdir -p "$WORKER_ROOT"',
    `if [ ! -d "$WORKER_ROOT/Quack/.git" ]; then git clone --branch ${quackBranch} ${cloneUrl} "$WORKER_ROOT/Quack"; fi`,
    'cd "$WORKER_ROOT/Quack"',
    "npm ci",
    "npm --prefix frontend ci",
    "npm run build",
    `node dist/index.js worker install --control-base-url ${manifest.controlPlane.baseUrl} --bootstrap-token ${bootstrapToken} --target-root "$WORKER_ROOT"${repairFlag} --start`,
  ].join(" && ");
}

function createBootstrapToken(): string {
  return `qenr_${crypto.randomBytes(24).toString("hex")}`;
}

function bootstrapTokenFromRequest(req: Request): string | undefined {
  const header = req.headers["x-quack-bootstrap-token"];
  if (typeof header === "string" && header.trim().length > 0) return header.trim();
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const body = req.body as Record<string, unknown> | undefined;
  return typeof body?.bootstrapToken === "string" && body.bootstrapToken.trim().length > 0
    ? body.bootstrapToken.trim()
    : undefined;
}

export function registerWorkerEnrollmentRoutes(
  app: Express,
  deps: WorkerEnrollmentRouteDeps,
): void {
  const { resolveProject, authService, requireServiceScope, requireServiceScopeAny } = deps;

  app.get("/api/workers/enrollment-profiles", (_req: Request, res: Response) => {
    const profiles = resolveAvailableProfiles().map((profile) => ({
      id: profile.id,
      label: profile.label,
      runtimePort: profile.runtimePort,
      maxConcurrentJobs: profile.maxConcurrentJobs,
      persistence: profile.persistence,
      capabilities: profile.capabilities,
      projectIds: profile.projects.map((project) => project.id),
      defaultProjectId:
        profile.projects.find((project) => project.primary)?.id ?? profile.projects[0]?.id ?? null,
    }));
    res.json({ ok: true, profiles });
  });

  app.get("/api/workers/enrollments", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const records = listEnrollmentRecords(p.projectRoot);
    const sessions = await Promise.all(
      records.map(async (record) =>
        toSessionView(record, await listenerForEnrollment(p.projectRoot!, record.hostId)),
      ),
    );
    res.json({
      ok: true,
      sessions,
    });
  });

  app.get("/api/workers/enrollments/:enrollmentId", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }
    const record = loadEnrollmentRecord(p.projectRoot, req.params.enrollmentId as string);
    if (!record) {
      res.status(404).json({ error: "worker_enrollment_not_found" });
      return;
    }
    res.json({
      ok: true,
      session: toSessionView(record, await listenerForEnrollment(p.projectRoot, record.hostId)),
      manifestPreview: buildManifestPreview(record.manifest),
      progressEvents: normalizedProgressEvents(record),
      capabilityResults: record.capabilityResults ?? [],
    });
  });

  app.post("/api/workers/enrollments", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = createEnrollmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_worker_enrollment_payload",
        details: parsed.error.flatten(),
      });
      return;
    }

    const requested = parsed.data;
    const profile = resolveProfile(requested.profileId);
    const projectId =
      requested.projectId ??
      profile.projects.find((project) => project.primary)?.id ??
      profile.projects[0]?.id ??
      requested.profileId ??
      "project";

    const expiresAt = new Date(
      Date.now() +
        Math.min(
          requested.ttlMinutes ?? DEFAULT_ENROLLMENT_TTL_MINUTES,
          MAX_ENROLLMENT_TTL_MINUTES,
        ) *
          60_000,
    ).toISOString();
    const enrollmentId = `worker-enrollment-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const hostId = slugify(requested.hostId);
    const alias = requested.alias?.trim() || hostId;
    const bootstrapToken = createBootstrapToken();
    const targetRoots: WorkerEnrollmentTargetRoots = {
      windows: requested.targetRootWindows?.trim() || undefined,
      posix: requested.targetRootPosix?.trim() || undefined,
    };
    const controlBaseUrl = resolveControlBaseUrlForRequest(req, profile);
    const manifest = buildManifest(
      {
        enrollmentId,
        hostId,
        alias,
        expiresAt,
        runtimePort: requested.runtimePort ?? profile.runtimePort,
        maxConcurrentJobs: requested.maxConcurrentJobs ?? profile.maxConcurrentJobs,
        capabilities: requested.capabilities?.length
          ? requested.capabilities
          : profile.capabilities,
        persistence: requested.persistence ?? profile.persistence,
        controlBaseUrl,
      },
      profile,
    );
    const record: WorkerEnrollmentSessionRecord = {
      enrollmentId,
      hostId,
      alias,
      profileId: profile.id,
      projectId,
      createdAt: nowIso(),
      expiresAt,
      createdBy:
        (req as Request & { session?: { username?: string } }).session?.username ||
        (req as Request & { apiPrincipal?: { name?: string; id?: string } }).apiPrincipal?.name ||
        (req as Request & { apiPrincipal?: { id?: string } }).apiPrincipal?.id ||
        "operator",
      runtimePort: manifest.worker.runtimePort,
      capabilities: [...manifest.worker.capabilities],
      persistence: manifest.worker.persistence,
      bootstrapTokenHash: hashServiceToken(bootstrapToken),
      manifest,
    };
    saveEnrollmentRecord(p.projectRoot, record);
    const installCommand = bootstrapCommand(manifest, bootstrapToken, "posix", {
      targetRoot: targetRoots.posix,
    });
    const installCommandWindows = bootstrapCommand(manifest, bootstrapToken, "windows", {
      targetRoot: targetRoots.windows,
    });
    const repairCommand = bootstrapCommand(manifest, bootstrapToken, "posix", {
      targetRoot: targetRoots.posix,
      repair: true,
    });
    const repairCommandWindows = bootstrapCommand(manifest, bootstrapToken, "windows", {
      targetRoot: targetRoots.windows,
      repair: true,
    });
    res.status(201).json({
      ok: true,
      session: toSessionView(record, undefined),
      bootstrapToken,
      installCommand,
      installCommandWindows,
      repairCommand,
      repairCommandWindows,
      targetRoots,
      manifestPreview: buildManifestPreview(manifest),
      progressEvents: normalizedProgressEvents(record),
      capabilityResults: [],
    });
  });

  app.post(
    "/v1/workers/enrollments/:enrollmentId/progress",
    async (req: Request, res: Response) => {
      const tokenId = requireServiceScopeAny
        ? requireServiceScopeAny(req, res, ["listener:heartbeat", "federation:write"])
        : requireServiceScope(req, res, "listener:heartbeat");
      if (!tokenId) return;

      const p = resolveProject(req);
      if (!p.projectRoot) {
        res.status(404).json({ error: "Project root not configured" });
        return;
      }

      const record = loadEnrollmentRecord(p.projectRoot, req.params.enrollmentId as string);
      if (!record) {
        res.status(404).json({ error: "worker_enrollment_not_found" });
        return;
      }
      if (record.workerTokenId && record.workerTokenId !== tokenId) {
        res.status(403).json({
          error: "worker_enrollment_progress_forbidden",
          message: `Token ${tokenId} cannot update enrollment ${record.enrollmentId}.`,
        });
        return;
      }

      const parsed = z
        .object({
          events: z.array(enrollmentProgressEventSchema).min(1).max(50),
          capabilityResults: z.array(capabilityResultSchema).max(50).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_worker_enrollment_progress_payload",
          details: parsed.error.flatten(),
        });
        return;
      }

      appendProgressEvents(record, parsed.data.events);
      if (parsed.data.capabilityResults) {
        record.capabilityResults = parsed.data.capabilityResults.map((result) => ({
          capability: result.capability,
          status: result.status,
          projectId: result.projectId,
          message: result.message,
          command: result.command
            ? {
                ...result.command,
                args: [...result.command.args],
                env: result.command.env ? { ...result.command.env } : undefined,
              }
            : undefined,
        }));
      }
      saveEnrollmentRecord(p.projectRoot, record);

      const listener = await listenerForEnrollment(p.projectRoot, record.hostId);
      res.json({
        ok: true,
        session: toSessionView(record, listener),
        progressEvents: normalizedProgressEvents(record),
        capabilityResults: record.capabilityResults ?? [],
      });
    },
  );

  app.post("/v1/workers/bootstrap", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const bootstrapToken = bootstrapTokenFromRequest(req);
    if (!bootstrapToken) {
      res.status(401).json({
        error: "worker_bootstrap_token_required",
        message:
          "Provide the bootstrap token via Authorization: Bearer, X-Quack-Bootstrap-Token, or request body.",
      });
      return;
    }

    const tokenHash = hashServiceToken(bootstrapToken);
    const record = listEnrollmentRecords(p.projectRoot).find(
      (candidate) => candidate.bootstrapTokenHash === tokenHash,
    );
    if (!record) {
      res.status(401).json({
        error: "worker_bootstrap_token_invalid",
        message: "Bootstrap token is missing, invalid, or has already been rotated away.",
      });
      return;
    }
    if (record.consumedAt) {
      res.status(409).json({
        error: "worker_bootstrap_token_consumed",
        message: `Enrollment ${record.enrollmentId} has already been consumed.`,
      });
      return;
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      res.status(410).json({
        error: "worker_bootstrap_token_expired",
        message: `Enrollment ${record.enrollmentId} expired at ${record.expiresAt}.`,
      });
      return;
    }

    const workerTokenId = record.workerTokenId || `worker-${record.hostId}-${record.enrollmentId}`;
    const workerToken = authService.createServiceToken(workerTokenId, [
      "listener:register",
      "listener:read",
      "listener:heartbeat",
      "federation:write",
    ]);

    record.consumedAt = nowIso();
    record.workerTokenId = workerToken.id;
    appendProgressEvents(record, [
      {
        phase: "bootstrap",
        state: "completed",
        message: "Bootstrap token consumed and worker token issued.",
        metadata: {
          workerTokenId: workerToken.id,
        },
      },
    ]);
    saveEnrollmentRecord(p.projectRoot, record);

    res.json({
      ok: true,
      session: toSessionView(record, undefined),
      manifest: record.manifest,
      workerToken,
    });
  });
}
