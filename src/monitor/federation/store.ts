// ─── Federation Job Store ──────────────────────────────────────────
// File-backed ledger of FederatedJobRecord under
// `<projectRoot>/.quack/federation/jobs/`. Each job is `<jobId>.json`;
// `records.jsonl` is an append-only audit trail.

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";

import type { FederatedJobRecord } from "./types.js";

export function federationDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "jobs");
}

export async function saveFederatedJob(
  projectRoot: string,
  record: FederatedJobRecord,
): Promise<void> {
  const dir = federationDir(projectRoot);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, `${record.jobId}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  await fsPromises.appendFile(
    path.join(dir, "records.jsonl"),
    JSON.stringify(record) + "\n",
    "utf-8",
  );
}

export async function loadFederatedJob(
  projectRoot: string,
  jobId: string,
): Promise<FederatedJobRecord | undefined> {
  try {
    const raw = await fsPromises.readFile(
      path.join(federationDir(projectRoot), `${jobId}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as FederatedJobRecord;
  } catch {
    return undefined;
  }
}

export async function listFederatedJobs(projectRoot: string): Promise<FederatedJobRecord[]> {
  try {
    const dir = federationDir(projectRoot);
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = await fsPromises.readFile(path.join(dir, entry.name), "utf-8");
            return JSON.parse(raw) as FederatedJobRecord;
          } catch {
            return undefined;
          }
        }),
    );
    return jobs.filter((job): job is FederatedJobRecord => Boolean(job));
  } catch {
    return [];
  }
}
