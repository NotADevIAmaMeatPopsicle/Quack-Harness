import type {
  WorkerCapabilityProbeResult,
  WorkerCapabilityReadiness,
  WorkerCapabilityTier,
  WorkerEnrollmentInstallStatus,
  WorkerEnrollmentListenerStatus,
  WorkerEnrollmentManifest,
  WorkerEnrollmentProgressEvent,
  WorkerEnrollmentReadiness,
  WorkerEnrollmentRepairAction,
  WorkerRepoFreshness,
  WorkerRepoFreshnessStatus,
} from "./enrollment-types.js";

const BASE_EXECUTION_CAPABILITIES = new Set(["dispatch", "verify", "fix"]);

export function capabilityTier(capability: string): WorkerCapabilityTier {
  const normalized = capability.toLowerCase();
  if (BASE_EXECUTION_CAPABILITIES.has(normalized)) return "base";
  if (normalized.includes("browser") || normalized.includes("playwright")) return "browser";
  if (normalized.includes("docker")) return "docker";
  if (normalized.includes("auth") || normalized.includes("secret") || normalized.includes("token"))
    return "auth";
  if (
    normalized.includes("db") ||
    normalized.includes("database") ||
    normalized.includes("staging")
  )
    return "staging-db";
  return "project";
}

function isRepoFreshness(value: unknown): value is WorkerRepoFreshness {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerRepoFreshness>;
  return (
    typeof candidate.repoId === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.expectedBranch === "string" &&
    typeof candidate.exists === "boolean" &&
    typeof candidate.dirty === "boolean" &&
    typeof candidate.ahead === "number" &&
    typeof candidate.behind === "number" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.blockers)
  );
}

function normalizeRepoFreshness(value: WorkerRepoFreshness): WorkerRepoFreshness {
  return {
    repoId: value.repoId,
    label: value.label,
    sourceUrl: value.sourceUrl,
    expectedBranch: value.expectedBranch,
    path: value.path,
    exists: value.exists,
    currentBranch: value.currentBranch,
    localCommit: value.localCommit,
    remoteCommit: value.remoteCommit,
    dirty: value.dirty,
    ahead: value.ahead,
    behind: value.behind,
    fastForwarded: value.fastForwarded,
    status: value.status,
    blockers: [...value.blockers],
    repairCommand: value.repairCommand,
  };
}

export function repoFreshnessFromManifest(
  manifest: WorkerEnrollmentManifest,
  workerRoot?: string,
): WorkerRepoFreshness[] {
  return manifest.repos.map((repo) => ({
    repoId: repo.id,
    label: repo.label,
    sourceUrl: repo.sourceUrl,
    expectedBranch: repo.branch,
    path: workerRoot ? `${workerRoot.replace(/[\\/]$/, "")}/${repo.destination}` : undefined,
    exists: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    status: "missing" as WorkerRepoFreshnessStatus,
    blockers: repo.required ? [`${repo.label} has not reported repo freshness yet.`] : [],
    repairCommand: `node dist/index.js worker install --control-base-url ${manifest.controlPlane.baseUrl} --bootstrap-token <fresh-qenr-token> --target-root <worker-root> --repair --start`,
  }));
}

export function extractRepoFreshnessFromProgress(
  events: WorkerEnrollmentProgressEvent[],
): WorkerRepoFreshness[] {
  for (const event of [...events].reverse()) {
    const raw = event.metadata?.repoFreshness;
    if (!Array.isArray(raw)) continue;
    const parsed = raw.filter(isRepoFreshness).map(normalizeRepoFreshness);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function manualEnvCapability(name: string): string {
  const normalized = name.toLowerCase();
  if (/(db|database|postgres|pg|mongo|redis)/.test(normalized)) return "staging-db";
  if (/(browser|playwright)/.test(normalized)) return "browser";
  return "auth";
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function uniqueRepairActions(
  actions: WorkerEnrollmentRepairAction[],
): WorkerEnrollmentRepairAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.id}:${action.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function deriveWorkerEnrollmentReadiness(options: {
  manifest: WorkerEnrollmentManifest;
  installStatus: WorkerEnrollmentInstallStatus;
  listener?: WorkerEnrollmentListenerStatus | null;
  progressEvents: WorkerEnrollmentProgressEvent[];
  capabilityResults: WorkerCapabilityProbeResult[];
  repoFreshness?: WorkerRepoFreshness[];
  repairCommand?: string;
  nowIso?: string;
}): WorkerEnrollmentReadiness {
  const repoFreshness = options.repoFreshness?.length
    ? options.repoFreshness.map(normalizeRepoFreshness)
    : extractRepoFreshnessFromProgress(options.progressEvents);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const blockedCapabilities: string[] = [];
  const repairActions: WorkerEnrollmentRepairAction[] = [];
  const requestedCapabilities = new Set(options.manifest.worker.capabilities);
  const advertisedCapabilities = new Set(options.installStatus.advertisedCapabilities);

  const repoBlockers = repoFreshness.flatMap((repo) => repo.blockers);
  for (const blocker of repoBlockers) {
    pushUnique(blockers, blocker);
  }
  if (repoBlockers.length > 0) {
    for (const capability of options.manifest.worker.capabilities) {
      if (BASE_EXECUTION_CAPABILITIES.has(capability)) {
        pushUnique(blockedCapabilities, capability);
      }
    }
  }
  for (const repo of repoFreshness) {
    if (repo.repairCommand && repo.blockers.length > 0) {
      repairActions.push({
        id: `repo:${repo.repoId}`,
        label: `Repair ${repo.label}`,
        command: repo.repairCommand,
        reason: repo.blockers.join(" "),
      });
    }
  }

  const manualEnvCapabilities = new Map<string, string[]>();
  for (const entry of options.manifest.env) {
    if (entry.mode !== "manual") continue;
    const capability = manualEnvCapability(entry.name);
    const names = manualEnvCapabilities.get(capability) ?? [];
    names.push(entry.name);
    manualEnvCapabilities.set(capability, names);
    pushUnique(blockedCapabilities, capability);
    pushUnique(blockers, `${entry.name} has unresolved manual worker env placeholder.`);
    repairActions.push({
      id: `env:${entry.name}`,
      label: `Fill ${entry.name}`,
      command: `Set ${entry.name} in .env.quack-worker, then rerun worker install --repair --start.`,
      reason: entry.description ?? `Manual value required for ${entry.name}.`,
    });
  }

  if (options.installStatus.state === "expired") {
    pushUnique(blockers, "Enrollment expired before the worker became trusted.");
    repairActions.push({
      id: "enrollment:expired",
      label: "Create fresh enrollment",
      command:
        options.repairCommand ??
        "Create a fresh worker enrollment and rerun the generated install command.",
      reason: "Bootstrap tokens are single-use and time-limited.",
    });
  } else if (!options.installStatus.bootstrapConsumed) {
    warnings.push("Bootstrap token has not been consumed yet.");
  }

  if (!options.installStatus.listenerRegistered) {
    warnings.push("Listener has not registered with the headnode yet.");
  }
  if (!options.installStatus.runtimeHealthy) {
    warnings.push("Local worker runtime has not reported healthy yet.");
  }
  if (options.installStatus.state === "failed" && options.installStatus.lastMessage) {
    pushUnique(blockers, options.installStatus.lastMessage);
    repairActions.push({
      id: "install:repair",
      label: "Rerun repair",
      command: options.repairCommand ?? "node dist/index.js worker install --repair --start",
      reason: options.installStatus.lastMessage,
    });
  }

  const latestResultByCapability = new Map<string, WorkerCapabilityProbeResult>();
  for (const result of options.capabilityResults) {
    latestResultByCapability.set(result.capability, result);
    if (result.status === "failed" || result.status === "withheld") {
      pushUnique(blockedCapabilities, result.capability);
      pushUnique(blockers, `${result.capability}: ${result.message}`);
      if (result.command) {
        repairActions.push({
          id: `capability:${result.capability}`,
          label: `Retry ${result.capability}`,
          command: [result.command.cmd, ...result.command.args].join(" "),
          reason: result.message,
        });
      }
    }
  }

  const capabilityNames = new Set<string>([
    ...options.manifest.worker.capabilities,
    ...options.capabilityResults.map((result) => result.capability),
    ...manualEnvCapabilities.keys(),
  ]);
  const capabilities: WorkerCapabilityReadiness[] = [...capabilityNames]
    .sort()
    .map((capability) => {
      const result = latestResultByCapability.get(capability);
      if (manualEnvCapabilities.has(capability)) {
        return {
          capability,
          tier: capabilityTier(capability),
          requested: requestedCapabilities.has(capability),
          status: "withheld",
          message: `${manualEnvCapabilities.get(capability)?.join(", ")} must be filled before advertising ${capability}.`,
          repairCommand: `Set ${manualEnvCapabilities.get(capability)?.join(", ")} in .env.quack-worker, then rerun worker install --repair --start.`,
        };
      }
      if (blockedCapabilities.includes(capability) && BASE_EXECUTION_CAPABILITIES.has(capability)) {
        return {
          capability,
          tier: "base",
          requested: requestedCapabilities.has(capability),
          status: "withheld",
          message: "Execution capability is withheld until repo freshness blockers are repaired.",
          repairCommand: options.repairCommand,
        };
      }
      if (result) {
        return {
          capability,
          tier: capabilityTier(capability),
          requested: requestedCapabilities.has(capability),
          status: result.status,
          projectId: result.projectId,
          message: result.message,
          command: result.command,
        };
      }
      if (BASE_EXECUTION_CAPABILITIES.has(capability)) {
        return {
          capability,
          tier: "base",
          requested: requestedCapabilities.has(capability),
          status: "deferred",
          message:
            "Execution capability is guarded by runtime health, listener heartbeat, and repo freshness.",
        };
      }
      return {
        capability,
        tier: capabilityTier(capability),
        requested: requestedCapabilities.has(capability),
        status: advertisedCapabilities.has(capability) ? "passed" : "withheld",
        message: advertisedCapabilities.has(capability)
          ? "Capability is advertised by the live listener."
          : "Capability has not passed a probe yet.",
      };
    });

  const hasCapabilityBlocker = blockedCapabilities.length > 0;
  const hasHardBlocker = blockers.length > 0 || hasCapabilityBlocker;
  let score = 100;
  if (options.installStatus.state === "expired") score = 0;
  if (!options.installStatus.bootstrapConsumed) score -= 25;
  if (!options.installStatus.listenerRegistered) score -= 20;
  if (!options.installStatus.runtimeHealthy) score -= 20;
  if (repoBlockers.length > 0) score -= 25;
  if (manualEnvCapabilities.size > 0) score -= 15;
  if (
    options.capabilityResults.some(
      (result) => result.status === "failed" || result.status === "withheld",
    )
  )
    score -= 15;
  score = Math.max(0, Math.min(100, score));

  const trustedForWork =
    !hasHardBlocker &&
    options.installStatus.bootstrapConsumed &&
    options.installStatus.listenerRegistered &&
    options.installStatus.listenerHealthy &&
    options.installStatus.runtimeHealthy;
  const status: WorkerEnrollmentReadiness["status"] =
    options.installStatus.state === "expired"
      ? "expired"
      : hasHardBlocker
        ? "blocked"
        : trustedForWork
          ? "ready"
          : score < 100
            ? "pending"
            : "degraded";

  return {
    status,
    score: trustedForWork ? 100 : score,
    trustedForWork,
    blockedCapabilities,
    blockers,
    warnings,
    repoFreshness,
    capabilities,
    repairActions: uniqueRepairActions(repairActions),
    updatedAt: options.nowIso ?? new Date().toISOString(),
  };
}
