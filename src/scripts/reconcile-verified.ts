import * as fs from "node:fs";
import * as path from "node:path";

import { QuackDB } from "../db/index.js";
import { loadFederationPeerConfig, pullVerifiedFromPeer } from "../monitor/federation/index.js";
import {
  reconcileVerifiedDrift,
  regenerateProjection,
  type VerificationStoreProject,
} from "../monitor/verification-store.js";
import { regenerateLatestByTaskIndex } from "../review/docs-gate.js";

interface CliOptions {
  apply: boolean;
  projectRoot: string;
}

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/scripts/reconcile-verified.js [--apply] [--project-root <path>]",
      "",
      "Options:",
      "  --apply                 Reconcile drift, regenerate projections, and pull from the configured peer.",
      "  --project-root <path>   Target project root (defaults to current working directory).",
      "  --project <path>        Alias for --project-root.",
      "  --help                  Show this help text.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  let apply = false;
  let projectRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return null;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--project-root" || arg === "--project") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`${arg} requires a path value.`);
      }
      projectRoot = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    apply,
    projectRoot: path.resolve(projectRoot),
  };
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const dbPath = path.join(options.projectRoot, ".quack", "quack.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Quack DB not found at ${dbPath}. Pass --project-root for the target repo.`);
  }

  let taskDir = "docs/tasks";
  try {
    const adapter = JSON.parse(
      fs.readFileSync(path.join(options.projectRoot, ".quack", "adapter.json"), "utf-8"),
    ) as { project?: { taskDir?: string } };
    if (adapter.project?.taskDir) taskDir = adapter.project.taskDir;
  } catch {
    // The default is the documented adapter fallback.
  }

  const db = new QuackDB(dbPath);
  try {
    const project: VerificationStoreProject = {
      projectRoot: options.projectRoot,
      db,
      taskDir: path.resolve(options.projectRoot, taskDir),
    };
    const peer = await loadFederationPeerConfig(options.projectRoot);

    if (!options.apply) {
      const summary = {
        ok: true,
        mode: "dry-run",
        projectRoot: options.projectRoot,
        dbPath,
        verifiedRows: project.db.getAllVerified().size,
        latestCursor: latestVerifiedCursor(project) ?? null,
        peer: peer
          ? {
              url: peer.url,
              remoteProjectId: peer.remoteProjectId ?? null,
              syncOnStartup: peer.syncOnStartup,
              pushOnWrite: peer.pushOnWrite,
              syncIntervalMs: peer.syncIntervalMs,
              limit: peer.limit,
            }
          : null,
        actions: [
          "Would rebuild .quack/reviews/latest-by-task.json from individual review bundles.",
          "Would reconcile .quack/verified.json against quack.db and repair task status drift.",
          "Would regenerate .quack/verified.json from the canonical DB state.",
          peer
            ? "Would pull verified rows from the configured federation peer."
            : "No federation peer configured; local-only reconcile.",
        ],
      };
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const latestByTask = await regenerateLatestByTaskIndex(options.projectRoot);
    const reconcile = await reconcileVerifiedDrift(project, {
      taskDir: path.resolve(options.projectRoot, taskDir),
      log: (message) => console.error(message),
    });
    let projection = await regenerateProjection(project);

    let peerPull: {
      fetched: number;
      applied: number;
      skipped: number;
      latestCursor?: string;
    } = {
      fetched: 0,
      applied: 0,
      skipped: 0,
    };

    if (peer) {
      peerPull = await pullVerifiedFromPeer(project, peer);
      if (peerPull.applied > 0) {
        projection = await regenerateProjection(project);
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "apply",
          projectRoot: options.projectRoot,
          dbPath,
          reviewIndexEntries: Object.keys(latestByTask).length,
          reconcile,
          projection,
          peerPull,
          finalVerifiedRows: project.db.getAllVerified().size,
          latestCursor: latestVerifiedCursor(project) ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[reconcile-verified] ${message}`);
  process.exitCode = 1;
});
