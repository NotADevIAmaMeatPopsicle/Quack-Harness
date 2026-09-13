import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

const federationPeerConfigSchema = z.object({
  url: z.string().trim().min(1),
  remoteProjectId: z.string().trim().min(1).optional(),
  serviceToken: z.string().trim().min(1).optional(),
  serviceTokenEnv: z.string().trim().min(1).optional(),
  startAuthority: z.object({ hostId: z.string().trim().min(1).max(256) }).optional(),
  syncIntervalMs: z.number().int().positive().default(300_000),
  syncOnStartup: z.boolean().default(true),
  pushOnWrite: z.boolean().default(true),
  limit: z.number().int().positive().max(1000).default(250),
}).refine((config) => !config.startAuthority || Boolean(config.remoteProjectId), {
  message: "startAuthority requires remoteProjectId",
});

export interface FederationPeerConfig {
  url: string;
  remoteProjectId?: string;
  serviceToken?: string;
  startAuthority?: { hostId: string };
  syncIntervalMs: number;
  syncOnStartup: boolean;
  pushOnWrite: boolean;
  limit: number;
}

export interface FederationPeerConfigInput {
  url: string;
  remoteProjectId?: string;
  serviceToken?: string;
  serviceTokenEnv?: string;
  startAuthority?: { hostId: string };
  syncIntervalMs?: number;
  syncOnStartup?: boolean;
  pushOnWrite?: boolean;
  limit?: number;
}

export class FederationPeerConfigWriteError extends Error {
  constructor(public readonly code: "existing_peer_config_unreadable" | "start_authority_retarget_required") {
    super(code === "existing_peer_config_unreadable"
      ? "Existing peer configuration is unreadable. Supply an explicit valid startAuthority configuration to replace it; implicit repair cannot safely preserve its authority."
      : "Explicit startAuthority is required to retarget an existing authority");
    this.name = "FederationPeerConfigWriteError";
  }
}

export function federationPeerConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "peer.json");
}

export async function loadFederationPeerConfig(
  projectRoot: string,
): Promise<FederationPeerConfig | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(federationPeerConfigPath(projectRoot), "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }

  const normalizedRaw = raw.replace(/^\uFEFF/u, "");
  const parsed = federationPeerConfigSchema.parse(JSON.parse(normalizedRaw));
  const serviceToken =
    parsed.serviceToken ??
    (parsed.serviceTokenEnv ? process.env[parsed.serviceTokenEnv] : undefined) ??
    undefined;

  return {
    url: parsed.url.replace(/\/+$/u, ""),
    remoteProjectId: parsed.remoteProjectId,
    serviceToken,
    startAuthority: parsed.startAuthority,
    syncIntervalMs: parsed.syncIntervalMs,
    syncOnStartup: parsed.syncOnStartup,
    pushOnWrite: parsed.pushOnWrite,
    limit: parsed.limit,
  };
}

export async function writeFederationPeerConfig(
  projectRoot: string,
  config: FederationPeerConfigInput,
): Promise<string> {
  const configPath = federationPeerConfigPath(projectRoot);
  // Provisioning/repair callers predate start authority. Their sync refresh
  // must neither erase it nor silently move it to a different headnode/project.
  let existing: FederationPeerConfig | undefined;
  try {
    existing = await loadFederationPeerConfig(projectRoot);
  } catch {
    // A corrupt file may contain authority that an older provisioning caller
    // does not know about. Explicit replacement can repair it; omission cannot.
    if (!config.startAuthority) {
      throw new FederationPeerConfigWriteError("existing_peer_config_unreadable");
    }
  }
  if (existing?.startAuthority && !config.startAuthority &&
      (config.url.replace(/\/+$/u, "") !== existing.url ||
       config.remoteProjectId !== existing.remoteProjectId)) {
    throw new FederationPeerConfigWriteError("start_authority_retarget_required");
  }
  const normalized = federationPeerConfigSchema.parse({
    ...config,
    startAuthority: config.startAuthority ?? existing?.startAuthority,
  });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return configPath;
}
