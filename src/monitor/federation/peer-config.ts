import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

const federationPeerConfigSchema = z.object({
  url: z.string().trim().min(1),
  remoteProjectId: z.string().trim().min(1).optional(),
  serviceToken: z.string().trim().min(1).optional(),
  serviceTokenEnv: z.string().trim().min(1).optional(),
  syncIntervalMs: z.number().int().positive().default(300_000),
  syncOnStartup: z.boolean().default(true),
  pushOnWrite: z.boolean().default(true),
  limit: z.number().int().positive().max(1000).default(250),
});

export interface FederationPeerConfig {
  url: string;
  remoteProjectId?: string;
  serviceToken?: string;
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
  syncIntervalMs?: number;
  syncOnStartup?: boolean;
  pushOnWrite?: boolean;
  limit?: number;
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) return undefined;
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
  const normalized = federationPeerConfigSchema.parse(config);
  const configPath = federationPeerConfigPath(projectRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return configPath;
}
