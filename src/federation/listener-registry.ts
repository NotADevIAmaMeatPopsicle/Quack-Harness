import * as fs from "node:fs/promises";
import * as path from "node:path";

import { normalizeCapabilities, type FederatedHost } from "./host-registry.js";
import type { WorkerCommandResultSummary, WorkerRuntimeRole } from "../core/worker-protocol.js";

export interface ListenerRegistrationInput {
  hostId: string;
  alias?: string;
  baseUrl?: string;
  capabilities: string[];
  projectPaths?: Record<string, string>;
  maxConcurrentJobs?: number;
  repoCommit?: string;
  runtimeRole?: WorkerRuntimeRole;
  protocolVersion?: string;
  lastCommand?: WorkerCommandResultSummary;
  metadata?: Record<string, unknown>;
}

export interface ListenerHeartbeatInput {
  healthy: boolean;
  currentLoad?: number;
  maxConcurrentJobs?: number;
  capabilities?: string[];
  repoCommit?: string;
  projectPaths?: Record<string, string>;
  runtimeRole?: WorkerRuntimeRole;
  protocolVersion?: string;
  lastCommand?: WorkerCommandResultSummary;
  metadata?: Record<string, unknown>;
}

export interface ListenerRecord extends FederatedHost {
  registeredAt: string;
  updatedAt: string;
  registeredBy?: string;
}

function listenersDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "listeners");
}

function listenerPath(projectRoot: string, hostId: string): string {
  return path.join(listenersDir(projectRoot), `${hostId}.json`);
}

function normalizeProjectPaths(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key.trim(), entryValue.trim()] as const)
    .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export class ListenerRegistry {
  constructor(private readonly projectRoot: string) {}

  async register(input: ListenerRegistrationInput, registeredBy?: string): Promise<ListenerRecord> {
    await fs.mkdir(listenersDir(this.projectRoot), { recursive: true });
    const now = new Date().toISOString();
    const existing = await this.get(input.hostId);
    const record: ListenerRecord = {
      id: input.hostId,
      alias: input.alias ?? existing?.alias,
      baseUrl: input.baseUrl ?? existing?.baseUrl,
      capabilities: normalizeCapabilities(input.capabilities),
      enabled: existing?.enabled ?? true,
      healthy: true,
      lastHealthCheckAt: now,
      currentLoad: 0,
      maxConcurrentJobs: input.maxConcurrentJobs ?? existing?.maxConcurrentJobs ?? 1,
      repoCommit: input.repoCommit ?? existing?.repoCommit,
      projectPaths: normalizeProjectPaths(input.projectPaths) ?? existing?.projectPaths,
      runtimeRole: input.runtimeRole ?? existing?.runtimeRole,
      protocolVersion: input.protocolVersion ?? existing?.protocolVersion,
      lastCommand: input.lastCommand ?? existing?.lastCommand,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      registeredBy: registeredBy ?? existing?.registeredBy,
    };
    await this.save(record);
    return record;
  }

  async heartbeat(
    hostId: string,
    input: ListenerHeartbeatInput,
  ): Promise<ListenerRecord | undefined> {
    const existing = await this.get(hostId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const record: ListenerRecord = {
      ...existing,
      healthy: input.healthy,
      lastHealthCheckAt: now,
      currentLoad: input.currentLoad ?? existing.currentLoad ?? 0,
      maxConcurrentJobs: input.maxConcurrentJobs ?? existing.maxConcurrentJobs ?? 1,
      capabilities: input.capabilities
        ? normalizeCapabilities(input.capabilities)
        : existing.capabilities,
      repoCommit: input.repoCommit ?? existing.repoCommit,
      projectPaths: normalizeProjectPaths(input.projectPaths) ?? existing.projectPaths,
      runtimeRole: input.runtimeRole ?? existing.runtimeRole,
      protocolVersion: input.protocolVersion ?? existing.protocolVersion,
      lastCommand: input.lastCommand ?? existing.lastCommand,
      metadata: { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) },
      updatedAt: now,
    };
    await this.save(record);
    return record;
  }

  async get(hostId: string): Promise<ListenerRecord | undefined> {
    try {
      const raw = await fs.readFile(listenerPath(this.projectRoot, hostId), "utf-8");
      return JSON.parse(raw) as ListenerRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<ListenerRecord[]> {
    try {
      const entries = await fs.readdir(listenersDir(this.projectRoot), { withFileTypes: true });
      const records = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => this.get(entry.name.replace(/\.json$/, ""))),
      );
      return records
        .filter((record): record is ListenerRecord => Boolean(record))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  }

  private async save(record: ListenerRecord): Promise<void> {
    await fs.mkdir(listenersDir(this.projectRoot), { recursive: true });
    await fs.writeFile(
      listenerPath(this.projectRoot, record.id),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
  }
}
