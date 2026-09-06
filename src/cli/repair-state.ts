import * as fs from "node:fs";
import * as path from "node:path";

import { QuackDB } from "../db/index.js";
import {
  loadFederationPeerConfig,
  pullVerifiedFromPeer,
  writeFederationPeerConfig,
} from "../monitor/federation/index.js";
import {
  reconcileVerifiedDrift,
  regenerateProjection,
  type ReconcileResult,
  type VerificationStoreProject,
} from "../monitor/verification-store.js";
import { regenerateLatestByTaskIndex } from "../review/docs-gate.js";
import { repairQuackDb, type RepairDbOptions, type RepairDbResult } from "./repair-db.js";
import { cleanCoreWorktreeIfLeaked } from "../dispatcher/worktree-cleanup.js";
import { sweepGhostPrepState, type GhostPrepSweepResult } from "./ghost-prep-sweep.js";
import {
  inspectGeneratedProjectionHygiene,
  migrateGeneratedProjectionHygiene,
  type ProjectionHygieneMigrationResult,
  type ProjectionHygieneResult,
} from "../monitor/projection-hygiene.js";

interface PeerPullResult {
  fetched: number;
  applied: number;
  skipped: number;
  latestCursor?: string;
}

export interface RepairStateOptions extends RepairDbOptions {
  rebuildDb?: boolean;
  pullPeer?: boolean;
  writePeerConfig?: boolean;
  peerUrl?: string;
  peerProjectId?: string;
  serviceToken?: string;
  serviceTokenEnv?: string;
  migrateGeneratedProjections?: boolean;
  dryRun?: boolean;
  apply?: boolean;
}

export interface RepairStateResult {
  projectRoot: string;
  dbPath: string;
  dbRepair: RepairDbResult;
  peerConfigPath?: string;
  reviewIndexEntries: number;
  reconcile: ReconcileResult;
  projection: {
    entryCount: number;
  };
  projectionHygiene: ProjectionHygieneResult;
  projectionMigration?: ProjectionHygieneMigrationResult;
  peerPull: PeerPullResult;
  finalVerifiedRows: number;
  latestCursor: string | null;
  coreWorktreeLeaked: boolean;
  coreWorktreeFixed: boolean;
  coreWorktreeLeakedValue?: string;
  /** QPI-048 leg (h): decompose-ghost prep artifacts (child prep whose
   *  spec was reverted while the parent remains). Reported always;
   *  removed only with --apply. */
  ghostPrep: GhostPrepSweepResult;
}

function resolveProjectRoot(options: RepairStateOptions): string {
  if (options.project?.trim()) {
    return path.resolve(options.project);
  }
  if (options.dbPath?.trim()) {
    return path.resolve(path.dirname(path.dirname(options.dbPath)));
  }
  return process.cwd();
}

function resolveDbPath(options: RepairStateOptions, projectRoot: string): string {
  if (options.dbPath?.trim()) {
    return path.resolve(options.dbPath);
  }
  return path.join(projectRoot, ".quack", "quack.db");
}

function latestVerifiedCursor(project: VerificationStoreProject): string | undefined {
  let latest: string | undefined;
  for (const row of project.db.getAllVerified().values()) {
    const cursor = row.updated_at ?? row.verified_at;
    if (!latest || cursor.localeCompare(latest) > 0) {
      latest = cursor;
    }
  }
  return latest;
}

function applyTransientServiceToken(options: RepairStateOptions): void {
  if (options.serviceToken?.trim() && options.serviceTokenEnv?.trim()) {
    process.env[options.serviceTokenEnv.trim()] = options.serviceToken.trim();
  }
}

async function maybeWritePeerConfig(
  projectRoot: string,
  options: RepairStateOptions,
): Promise<string | undefined> {
  if (!options.writePeerConfig) return undefined;
  const peerUrl = options.peerUrl?.trim();
  if (!peerUrl) {
    throw new Error("writePeerConfig requires --peer-url.");
  }

  const configPath = await writeFederationPeerConfig(projectRoot, {
    url: peerUrl,
    remoteProjectId: options.peerProjectId?.trim() || undefined,
    serviceToken: options.serviceTokenEnv?.trim()
      ? undefined
      : options.serviceToken?.trim() || undefined,
    serviceTokenEnv: options.serviceTokenEnv?.trim() || undefined,
    syncIntervalMs: 300_000,
    syncOnStartup: true,
    pushOnWrite: false,
    limit: 250,
  });
  return configPath;
}

export async function repairProjectState(
  options: RepairStateOptions = {},
): Promise<RepairStateResult> {
  if (options.dryRun && options.apply) {
    throw new Error(
      "Choose either --dry-run or --apply for generated projection migration, not both.",
    );
  }

  const projectRoot = resolveProjectRoot(options);
  const dbPath = resolveDbPath(options, projectRoot);

  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const dbRepair = repairQuackDb({
    project: projectRoot,
    dbPath: options.dbPath,
    rebuild: options.rebuildDb ?? options.rebuild,
  });

  const coreWorktreeCleanResult = await cleanCoreWorktreeIfLeaked(projectRoot);

  // QPI-048 leg (h): decompose ghost state rides the same repair path
  // as everything else prep-adjacent. Task dir from the adapter when
  // readable; the Quack default otherwise.
  let taskDir = "docs/tasks";
  try {
    const adapterJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "adapter.json"), "utf-8"),
    ) as { project?: { taskDir?: string } };
    if (adapterJson.project?.taskDir) taskDir = adapterJson.project.taskDir;
  } catch {
    /* no adapter — default holds */
  }
  const ghostPrep = sweepGhostPrepState(projectRoot, taskDir, options.apply === true);

  applyTransientServiceToken(options);
  const peerConfigPath = await maybeWritePeerConfig(projectRoot, options);

  const db = new QuackDB(dbPath);
  try {
    const project: VerificationStoreProject = {
      projectRoot,
      db,
      taskDir: path.resolve(projectRoot, taskDir),
    };

    const latestByTask = await regenerateLatestByTaskIndex(projectRoot);
    const reconcile = await reconcileVerifiedDrift(project, {
      taskDir: path.resolve(projectRoot, taskDir),
      log: (message) => console.error(message),
    });
    let projection = await regenerateProjection(project);

    const peer = await loadFederationPeerConfig(projectRoot);
    let peerPull: PeerPullResult = {
      fetched: 0,
      applied: 0,
      skipped: 0,
    };

    if (options.pullPeer !== false && peer) {
      peerPull = await pullVerifiedFromPeer(project, peer);
      if (peerPull.applied > 0) {
        projection = await regenerateProjection(project);
      }
    }

    let projectionMigration: ProjectionHygieneMigrationResult | undefined;
    if (options.migrateGeneratedProjections) {
      projectionMigration = migrateGeneratedProjectionHygiene(projectRoot, {
        dryRun: options.apply !== true,
      });
    }
    const projectionHygiene =
      projectionMigration?.after ?? inspectGeneratedProjectionHygiene(projectRoot);

    return {
      projectRoot,
      dbPath,
      dbRepair,
      peerConfigPath,
      reviewIndexEntries: Object.keys(latestByTask).length,
      reconcile,
      projection,
      projectionHygiene,
      projectionMigration,
      peerPull,
      finalVerifiedRows: project.db.getAllVerified().size,
      latestCursor: latestVerifiedCursor(project) ?? null,
      coreWorktreeLeaked: coreWorktreeCleanResult.leaked,
      coreWorktreeFixed: coreWorktreeCleanResult.cleaned,
      ...(coreWorktreeCleanResult.leakedValue !== undefined
        ? { coreWorktreeLeakedValue: coreWorktreeCleanResult.leakedValue }
        : {}),
      ghostPrep,
    };
  } finally {
    db.close();
  }
}

export async function repairStateCommand(options: RepairStateOptions = {}): Promise<void> {
  try {
    const result = await repairProjectState(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
