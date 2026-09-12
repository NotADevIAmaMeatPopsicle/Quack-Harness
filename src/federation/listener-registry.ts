import { randomUUID } from "node:crypto";
import { z } from "zod";
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

export class ListenerTokenBindingError extends Error {
  constructor(
    readonly code: "listener_not_found" | "listener_token_host_mismatch",
    readonly hostId: string,
    readonly expectedTokenId?: string,
  ) {
    super(
      code === "listener_not_found"
        ? `Listener ${hostId} is not registered.`
        : `Listener ${hostId} is bound to a different worker token.`,
    );
    this.name = "ListenerTokenBindingError";
  }
}

export const LISTENER_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ListenerRegistryIssue {
  file: string;
  hostId?: string;
  code:
    | "malformed_json"
    | "invalid_record"
    | "identity_mismatch"
    | "read_failed"
    | "registry_unavailable";
  reason: string;
}

export interface ListenerRegistrySnapshot {
  records: ListenerRecord[];
  issues: ListenerRegistryIssue[];
  unavailable: boolean;
  /** File identities reserve a registration even when its body cannot be trusted. */
  reservedHostIds: string[];
}

export class ListenerRecordReadError extends Error {
  constructor(readonly issue: ListenerRegistryIssue) {
    super(`Listener registry ${issue.file}: ${issue.reason}`);
    this.name = "ListenerRecordReadError";
  }
}

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const listenerRecordSchema = z.object({
  id: z.string().regex(LISTENER_HOST_ID_PATTERN),
  alias: z.string().optional(),
  baseUrl: z.string().optional(),
  capabilities: z.array(z.string().trim().min(1)),
  enabled: z.boolean(),
  healthy: z.boolean(),
  lastHealthCheckAt: timestamp.optional(),
  currentLoad: z.number().int().nonnegative().optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  repoCommit: z.string().optional(),
  projectPaths: z.record(z.string(), z.string().trim().min(1)).optional(),
  runtimeRole: z.enum(["headnode", "worker"]).optional(),
  protocolVersion: z.string().optional(),
  lastCommand: z
    .object({
      kind: z.enum([
        "git_pull",
        "refresh_project",
        "worker.refresh",
        "probe_capabilities",
        "collect_diagnostics",
        "sync_wiki",
      ]),
      status: z.enum(["accepted", "running", "completed", "failed", "retryable", "non_retryable"]),
      completedAt: timestamp.optional(),
      durationMs: z.number().nonnegative().optional(),
      errorCategory: z
        .enum([
          "transport",
          "auth",
          "tool_missing",
          "bad_payload",
          "project_not_found",
          "platform_mismatch",
          "execution_failed",
          "not_supported",
          "unknown",
        ])
        .optional(),
      message: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  registeredAt: timestamp,
  updatedAt: timestamp,
  registeredBy: z.string().min(1).optional(),
});

function assertListenerHostId(hostId: string): void {
  if (!LISTENER_HOST_ID_PATTERN.test(hostId)) {
    throw new ListenerRecordReadError({
      file: `${hostId}.json`,
      code: "invalid_record",
      reason: "Invalid listener host ID",
    });
  }
}

const LISTENER_LOCK_RETRY_MS = 10;
const LISTENER_LOCK_ATTEMPTS = 500;
const STALE_LISTENER_LOCK_MS = 30_000;

function listenersDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "listeners");
}

function listenerPath(projectRoot: string, hostId: string): string {
  assertListenerHostId(hostId);
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

  private async withListenerLock<T>(hostId: string, action: () => Promise<T>): Promise<T> {
    assertListenerHostId(hostId);
    const dir = listenersDir(this.projectRoot);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, `${hostId}.lock`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < LISTENER_LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LISTENER_LOCK_MS) {
            await fs.unlink(lockPath);
            continue;
          }
        } catch (inspectionError: unknown) {
          if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw inspectionError;
          }
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, LISTENER_LOCK_RETRY_MS));
      }
    }
    if (!handle) throw new Error(`Timed out acquiring listener lock for ${hostId}`);
    try {
      return await action();
    } finally {
      await handle.close();
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  async register(input: ListenerRegistrationInput, registeredBy?: string): Promise<ListenerRecord> {
    return this.withListenerLock(input.hostId, async () => {
      const now = new Date().toISOString();
      const existing = await this.get(input.hostId);
      if (existing && existing.registeredBy !== registeredBy) {
        throw new ListenerTokenBindingError(
          "listener_token_host_mismatch",
          input.hostId,
          existing.registeredBy,
        );
      }
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
        registeredBy: existing?.registeredBy ?? registeredBy,
      };
      await this.save(record);
      return record;
    });
  }

  async heartbeat(
    hostId: string,
    input: ListenerHeartbeatInput,
    registeredBy?: string,
  ): Promise<ListenerRecord | undefined> {
    return this.withListenerLock(hostId, async () => {
      const existing = await this.get(hostId);
      if (!existing) return undefined;
      if (existing.registeredBy !== registeredBy) {
        throw new ListenerTokenBindingError(
          "listener_token_host_mismatch",
          hostId,
          existing.registeredBy,
        );
      }
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
    });
  }

  async assertTokenBinding(hostId: string, tokenId: string): Promise<ListenerRecord> {
    const existing = await this.get(hostId);
    if (!existing) {
      throw new ListenerTokenBindingError("listener_not_found", hostId);
    }
    if (!existing.registeredBy || existing.registeredBy !== tokenId) {
      throw new ListenerTokenBindingError(
        "listener_token_host_mismatch",
        hostId,
        existing.registeredBy,
      );
    }
    return existing;
  }

  async get(hostId: string): Promise<ListenerRecord | undefined> {
    const filename = listenerPath(this.projectRoot, hostId);
    const issue = (code: ListenerRegistryIssue["code"], reason: string) =>
      new ListenerRecordReadError({ file: path.basename(filename), hostId, code, reason });
    let raw: string;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw issue("invalid_record", "Listener record is not a bounded regular file");
      raw = await fs.readFile(filename, "utf-8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ListenerRecordReadError) throw error;
      throw issue("read_failed", "Listener record could not be read");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw issue("malformed_json", "Listener record is not valid JSON");
    }
    const parsed = listenerRecordSchema.safeParse(value);
    if (!parsed.success) throw issue("invalid_record", "Listener record fields are invalid");
    if (parsed.data.id !== hostId)
      throw issue("identity_mismatch", "Listener body ID does not match its registry filename");
    return parsed.data;
  }

  async listWithDiagnostics(): Promise<ListenerRegistrySnapshot> {
    let entries: string[];
    try {
      entries = await fs.readdir(listenersDir(this.projectRoot));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { records: [], issues: [], unavailable: false, reservedHostIds: [] };
      return {
        records: [],
        issues: [
          {
            file: "listeners",
            code: "registry_unavailable",
            reason: "Listener registry directory could not be read",
          },
        ],
        unavailable: true,
        reservedHostIds: [],
      };
    }
    const filenames = entries.filter((entry) => entry.endsWith(".json")).sort();
    const records: ListenerRecord[] = [];
    const issues: ListenerRegistryIssue[] = [];
    const reservedHostIds = filenames.map((filename) => filename.slice(0, -5));
    for (const hostId of reservedHostIds) {
      try {
        const record = await this.get(hostId);
        if (record) records.push(record);
      } catch (error: unknown) {
        issues.push(
          error instanceof ListenerRecordReadError
            ? error.issue
            : {
                file: `${hostId}.json`,
                hostId,
                code: "read_failed",
                reason: "Listener record could not be read",
              },
        );
      }
    }
    return {
      records: records.sort((a, b) => a.id.localeCompare(b.id)),
      issues,
      unavailable: false,
      reservedHostIds,
    };
  }

  async list(): Promise<ListenerRecord[]> {
    return (await this.listWithDiagnostics()).records;
  }

  private async save(record: ListenerRecord): Promise<void> {
    const parsed = listenerRecordSchema.safeParse(record);
    if (!parsed.success) throw new Error("Refusing invalid listener registry write");
    const filename = listenerPath(this.projectRoot, record.id);
    await fs.mkdir(listenersDir(this.projectRoot), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(parsed.data, null, 2), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, filename);
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
