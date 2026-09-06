import * as fs from "node:fs";
import * as path from "node:path";

import { QuackDB } from "../db/index.js";

type IntegrityStatus = "ok" | "corrupt" | "missing";

export interface QuackDbIntegrityResult {
  status: IntegrityStatus;
  message: string;
  details: string[];
}

export interface RepairDbOptions {
  project?: string;
  dbPath?: string;
  rebuild?: boolean;
}

export interface RepairDbResult {
  dbPath: string;
  backupDir?: string;
  backedUpFiles: string[];
  initialIntegrity: QuackDbIntegrityResult;
  rebuilt: boolean;
  finalIntegrity: QuackDbIntegrityResult;
}

function getBetterSqlite3(): new (
  dbPath: string,
  options?: Record<string, unknown>,
) => {
  prepare: (sql: string) => {
    all: () => Array<Record<string, unknown>>;
  };
  close: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("better-sqlite3") as new (
    dbPath: string,
    options?: Record<string, unknown>,
  ) => {
    prepare: (sql: string) => {
      all: () => Array<Record<string, unknown>>;
    };
    close: () => void;
  };
}

function resolveDbPath(options: RepairDbOptions): string {
  if (options.dbPath?.trim()) {
    return path.resolve(options.dbPath);
  }
  const projectRoot = path.resolve(options.project ?? process.cwd());
  return path.join(projectRoot, ".quack", "quack.db");
}

function timestampId(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function sidecarPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function inspectQuackDb(dbPath: string): QuackDbIntegrityResult {
  if (!fs.existsSync(dbPath)) {
    return {
      status: "missing",
      message: "DB file does not exist.",
      details: [],
    };
  }

  const Database = getBetterSqlite3();
  let db: InstanceType<ReturnType<typeof getBetterSqlite3>> | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("PRAGMA integrity_check").all();
    const details = rows
      .map((row) => {
        const first = Object.values(row)[0];
        if (typeof first === "string") return first;
        if (typeof first === "number" || typeof first === "boolean" || typeof first === "bigint") {
          return String(first);
        }
        if (first === null || first === undefined) return "";
        return JSON.stringify(first);
      })
      .filter((entry) => entry.trim().length > 0);
    if (details.length === 1 && details[0] === "ok") {
      return {
        status: "ok",
        message: "Integrity check passed.",
        details,
      };
    }
    return {
      status: "corrupt",
      message: "Integrity check reported corruption.",
      details,
    };
  } catch (err: unknown) {
    return {
      status: "corrupt",
      message: err instanceof Error ? err.message : String(err),
      details: [],
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort only.
    }
  }
}

function backupDbArtifacts(dbPath: string): { backupDir?: string; backedUpFiles: string[] } {
  const artifacts = sidecarPaths(dbPath).filter((candidate) => fs.existsSync(candidate));
  if (artifacts.length === 0) {
    return { backupDir: undefined, backedUpFiles: [] };
  }

  const quackDir = path.dirname(dbPath);
  const backupDir = path.join(quackDir, "db-backups", timestampId());
  fs.mkdirSync(backupDir, { recursive: true });
  const backedUpFiles: string[] = [];
  for (const artifact of artifacts) {
    const destination = path.join(backupDir, path.basename(artifact));
    fs.copyFileSync(artifact, destination);
    backedUpFiles.push(destination);
  }
  return { backupDir, backedUpFiles };
}

function rebuildQuackDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const artifact of sidecarPaths(dbPath)) {
    fs.rmSync(artifact, { force: true });
  }
  const db = new QuackDB(dbPath);
  db.close();
}

export function repairQuackDb(options: RepairDbOptions = {}): RepairDbResult {
  const dbPath = resolveDbPath(options);
  const initialIntegrity = inspectQuackDb(dbPath);
  const { backupDir, backedUpFiles } = backupDbArtifacts(dbPath);

  let rebuilt = false;
  if (options.rebuild) {
    rebuildQuackDb(dbPath);
    rebuilt = true;
  }

  const finalIntegrity = inspectQuackDb(dbPath);
  return {
    dbPath,
    backupDir,
    backedUpFiles,
    initialIntegrity,
    rebuilt,
    finalIntegrity,
  };
}

function printIntegrity(label: string, result: QuackDbIntegrityResult): void {
  console.log(`${label}: ${result.status} — ${result.message}`);
  for (const detail of result.details) {
    if (detail !== "ok") {
      console.log(`  ${detail}`);
    }
  }
}

export function repairDbCommand(options: RepairDbOptions = {}): void {
  try {
    const result = repairQuackDb(options);
    console.log(`Quack DB: ${result.dbPath}`);
    printIntegrity("Initial integrity", result.initialIntegrity);

    if (result.backedUpFiles.length > 0) {
      console.log(`Backup: ${result.backupDir}`);
      for (const filePath of result.backedUpFiles) {
        console.log(`  saved ${filePath}`);
      }
    } else {
      console.log("Backup: no existing DB artifacts to preserve");
    }

    if (result.rebuilt) {
      console.log("Action: rebuilt SQLite state from a fresh schema");
    } else {
      console.log("Action: inspect + backup only (pass --rebuild to replace the DB)");
    }

    printIntegrity("Final integrity", result.finalIntegrity);

    if (result.finalIntegrity.status !== "ok") {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
