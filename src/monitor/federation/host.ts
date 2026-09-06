// ─── Federation Host Helpers ───────────────────────────────────────
// Default host roster (registered listeners + remoteInstances), active-
// lease aggregation, host event-detail derivation, host-commands ledger
// (read/append/ack), and the broadcast-pull-dev fan-out.

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";

import { ListenerRegistry } from "../../federation/listener-registry.js";
import type { FederatedHost } from "../../federation/host-registry.js";
import {
  WORKER_COMMAND_PROTOCOL_VERSION,
  isWorkerCommandEnvelope,
  type WorkerCommandEnvelope,
  type WorkerCommandResult,
} from "../../core/worker-protocol.js";
import { listFederatedJobs } from "./store.js";
import { holdsWorkerAttachment } from "./status.js";
import { federationNow } from "./lease.js";
import type { FederatedHostEventDetails, FederationProjectContext } from "./types.js";

export function federatedHostEventDetailsFromHost(
  host: FederatedHost | undefined,
): FederatedHostEventDetails {
  return {
    hostAlias: host?.alias,
    hostEndpoint: host?.baseUrl,
  };
}

export async function applyActiveFederatedLeases(
  projectRoot: string,
  hosts: FederatedHost[],
): Promise<FederatedHost[]> {
  const now = Date.now();
  const activeCounts = new Map<string, number>();
  for (const job of await listFederatedJobs(projectRoot)) {
    // TASK-1329: host LOAD is about attachment, not assignability. A run paused
    // at a human gate still occupies its host (the listener holds the lease and
    // keeps polling, `quack-listener.mjs:1264`), so counting only "active"
    // statuses under-reports load and lets the scheduler assign into a slot that
    // is really wedged. This is the over-assignment direction, so it fails unsafe.
    if (!holdsWorkerAttachment(job.status) || !job.hostId) continue;
    const leaseExpiresAt = job.lease?.expiresAt;
    if (leaseExpiresAt && Date.parse(leaseExpiresAt) <= now) continue;
    activeCounts.set(job.hostId, (activeCounts.get(job.hostId) ?? 0) + 1);
  }

  return hosts.map((host) => ({
    ...host,
    currentLoad: Math.max(host.currentLoad ?? 0, activeCounts.get(host.id) ?? 0),
    maxConcurrentJobs: host.maxConcurrentJobs ?? 1,
  }));
}

export async function defaultFederatedHosts(projectRoot: string): Promise<FederatedHost[]> {
  const listenerRegistry = new ListenerRegistry(projectRoot);
  const registeredListeners = await listenerRegistry.list();
  const byId = new Map<string, FederatedHost>();
  for (const listener of registeredListeners) {
    byId.set(listener.id, listener);
  }

  try {
    const { loadGlobalConfig: load } = await import("../../core/global-config.js");
    const config = load();
    for (const remote of config.remoteInstances ?? []) {
      if (byId.has(remote.id)) continue;
      byId.set(remote.id, {
        id: remote.id,
        alias: remote.alias,
        baseUrl: `http://${remote.host}:${remote.remotePort}`,
        capabilities: ["intake", "verify", "fix", "dispatch"],
        enabled: remote.enabled !== false,
        healthy: remote.enabled !== false,
        currentLoad: 0,
        maxConcurrentJobs: 1,
      });
    }
  } catch {
    // Fall through with persisted listener records only.
  }

  return applyActiveFederatedLeases(projectRoot, [...byId.values()]);
}

export async function resolveFederatedHostEventDetails(
  p: FederationProjectContext,
  hostId: string | undefined,
): Promise<FederatedHostEventDetails> {
  if (!p.projectRoot || !hostId) return {};
  const hosts = await defaultFederatedHosts(p.projectRoot);
  return federatedHostEventDetailsFromHost(hosts.find((host) => host.id === hostId));
}

// ─── Host commands ledger ────────────────────────────────────────

export function federationHostCommandsDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "host-commands");
}

export type FederatedHostCommandRecord = WorkerCommandEnvelope & {
  hostId: string;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  result?: WorkerCommandResult;
};

function generatedCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeFederatedHostCommand(
  hostId: string,
  command: Record<string, unknown>,
): FederatedHostCommandRecord {
  if (isWorkerCommandEnvelope(command)) {
    return {
      ...command,
      commandId: command.commandId || generatedCommandId(),
      hostId,
      createdAt: typeof command.issuedAt === "string" ? command.issuedAt : federationNow(),
    };
  }

  const targetBranch =
    typeof command.targetBranch === "string" && command.targetBranch.trim().length > 0
      ? command.targetBranch.trim()
      : "dev";
  const taskId = typeof command.taskId === "string" ? command.taskId : undefined;
  const targetProjectId =
    typeof command.targetProjectId === "string" ? command.targetProjectId : undefined;

  return {
    commandId: typeof command.commandId === "string" ? command.commandId : generatedCommandId(),
    hostId,
    createdAt: typeof command.createdAt === "string" ? command.createdAt : federationNow(),
    acknowledgedAt: typeof command.acknowledgedAt === "string" ? command.acknowledgedAt : undefined,
    acknowledgedBy: typeof command.acknowledgedBy === "string" ? command.acknowledgedBy : undefined,
    protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
    kind: "git_pull",
    issuedAt: typeof command.createdAt === "string" ? command.createdAt : federationNow(),
    taskId,
    targetProjectId,
    notes: typeof command.command === "string" ? command.command : undefined,
    payload: {
      remote: "origin",
      targetBranch,
      ffOnly: true,
      repoPathKey: targetProjectId,
    },
    result:
      typeof command.result === "object" && command.result
        ? (command.result as WorkerCommandResult)
        : undefined,
  };
}

export async function appendFederatedHostCommand(
  projectRoot: string,
  hostId: string,
  command: WorkerCommandEnvelope,
): Promise<void> {
  const dir = federationHostCommandsDir(projectRoot);
  const normalized = normalizeFederatedHostCommand(
    hostId,
    command as unknown as Record<string, unknown>,
  );
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.appendFile(
    path.join(dir, `${hostId}.jsonl`),
    JSON.stringify(normalized) + "\n",
    "utf-8",
  );
}

export async function readFederatedHostCommands(
  projectRoot: string,
  hostId: string,
  includeAcknowledged = false,
): Promise<FederatedHostCommandRecord[]> {
  try {
    const raw = await fsPromises.readFile(
      path.join(federationHostCommandsDir(projectRoot), `${hostId}.jsonl`),
      "utf-8",
    );
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) =>
        normalizeFederatedHostCommand(hostId, JSON.parse(line) as Record<string, unknown>),
      )
      .filter((command) => includeAcknowledged || !command.acknowledgedAt);
  } catch {
    return [];
  }
}

export async function acknowledgeFederatedHostCommands(
  projectRoot: string,
  hostId: string,
  commandIds: string[],
  acknowledgedBy: string,
  resultsByCommandId: Record<string, WorkerCommandResult> = {},
): Promise<FederatedHostCommandRecord[]> {
  const filePath = path.join(federationHostCommandsDir(projectRoot), `${hostId}.jsonl`);
  const commands = await readFederatedHostCommands(projectRoot, hostId, true);
  const commandIdSet = new Set(commandIds);
  const now = federationNow();
  const updated = commands.map((command) => {
    if (!commandIdSet.has(String(command.commandId))) return command;
    const result = resultsByCommandId[String(command.commandId)];
    return {
      ...command,
      acknowledgedAt: command.acknowledgedAt ?? now,
      acknowledgedBy: command.acknowledgedBy ?? acknowledgedBy,
      result: result ?? command.result,
    };
  });
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(
    filePath,
    updated.map((command) => JSON.stringify(command)).join("\n") + (updated.length > 0 ? "\n" : ""),
    "utf-8",
  );
  return updated.filter((command) => commandIdSet.has(String(command.commandId)));
}

export async function broadcastPullDevCommand(
  projectRoot: string,
  taskId: string,
  targetBranch: string,
  targetProjectId?: string,
): Promise<number> {
  const listeners = await new ListenerRegistry(projectRoot).list();
  await Promise.all(
    listeners.map((listener) =>
      appendFederatedHostCommand(projectRoot, listener.id, {
        commandId: generatedCommandId(),
        protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
        kind: "git_pull",
        issuedAt: federationNow(),
        taskId,
        targetProjectId,
        notes: `Refresh ${targetBranch} after federated merge closeout.`,
        payload: {
          remote: "origin",
          targetBranch,
          ffOnly: true,
          repoPathKey: targetProjectId,
        },
      }),
    ),
  );
  return listeners.length;
}

export async function broadcastWorkerRefreshCommand(
  projectRoot: string,
  taskId: string,
  targetBranch: string,
  targetProjectId?: string,
  reason = "post-merge",
): Promise<number> {
  const listeners = await new ListenerRegistry(projectRoot).list();
  await Promise.all(
    listeners.map((listener) =>
      appendFederatedHostCommand(projectRoot, listener.id, {
        commandId: generatedCommandId(),
        protocolVersion: WORKER_COMMAND_PROTOCOL_VERSION,
        kind: "worker.refresh",
        issuedAt: federationNow(),
        taskId,
        targetProjectId,
        notes: `Refresh worker after ${taskId} merged to ${targetBranch}.`,
        payload: {
          reason,
          repos: targetProjectId ? [targetProjectId] : undefined,
          branches: targetProjectId ? { [targetProjectId]: targetBranch } : undefined,
          runInstall: false,
          runCapabilityProbes: true,
          applyProfile: true,
          maxDirtyAction: "block",
        },
      }),
    ),
  );
  return listeners.length;
}
