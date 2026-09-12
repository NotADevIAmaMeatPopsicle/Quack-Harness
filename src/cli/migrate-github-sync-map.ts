import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import {
  buildStrictDuplicateClaimantIndex,
  groupTaskClaimantsByDeclaredId,
  type TaskClaimantDeclaration,
} from "../core/duplicate-claimants.js";
import { listTaskClaimantDeclarations } from "../core/task-file-resolver.js";
import type { SyncEntry } from "../integrations/github/github-types.js";
import { resolveGitHubSyncMapPath } from "../integrations/github/sync-map.js";

export interface GitHubSyncMigrationHeader {
  runAt: string;
  mapFile: string;
  reportPath: string;
  sourceMapSha256: string;
}

export type GitHubSyncMigrationAction =
  | { rule: 1; reason: "raw_duplicate"; entry: SyncEntry }
  | {
      rule: 4;
      reason: "rewritten";
      fromTaskId: string;
      toTaskId: string;
      entry: SyncEntry;
    }
  | {
      rule: 5;
      reason: "merged_redundant";
      targetTaskId: string;
      entry: SyncEntry;
    };

export type GitHubSyncMigrationUnresolved =
  | {
      rule: 2;
      reason: "contested";
      targetTaskId: string;
      claimants: string[];
      entry: SyncEntry;
    }
  | {
      rule: 6;
      reason: "issue_conflict";
      targetTaskId: string;
      targetIssueNumber: number;
      entry: SyncEntry;
    }
  | { rule: 7; reason: "unresolvable_current"; entry: SyncEntry }
  | { rule: 8; reason: "orphan"; entry: SyncEntry };

export interface GitHubSyncMigrationReport {
  header: GitHubSyncMigrationHeader;
  actions: GitHubSyncMigrationAction[];
  unresolved: GitHubSyncMigrationUnresolved[];
}

export interface GitHubSyncMigrationResult {
  report: GitHubSyncMigrationReport;
  serialization: string;
}

export interface GitHubSyncMigrationOptions {
  project?: string;
  dryRun?: boolean;
}

export interface GitHubSyncMigrationDependencies {
  now?: () => Date;
  writeOutput?: (serialized: string) => void;
  renameMap?: (source: string, destination: string) => Promise<void>;
  writeReportTemp?: (tempPath: string, serialization: string) => Promise<void>;
  renameReport?: (source: string, destination: string) => Promise<void>;
  declarationProducer?: (taskDir: string) => Promise<readonly TaskClaimantDeclaration[]>;
}

interface IndexedSyncEntry {
  entry: SyncEntry;
}

function migrationError(reason: string, detail: string): Error {
  return new Error(`${reason}: ${detail}`);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}: ${errorDetail(error)}` : errorDetail(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSyncEntry(value: unknown): value is SyncEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    typeof value.issueNumber === "number" &&
    Number.isInteger(value.issueNumber) &&
    (value.direction === "imported" || value.direction === "published") &&
    typeof value.createdAt === "string" &&
    typeof value.lastSyncedAt === "string" &&
    (value.issueState === "open" || value.issueState === "closed") &&
    typeof value.taskStatus === "string"
  );
}

async function readRawSyncEntries(mapFile: string): Promise<{
  sourceBytes: string;
  entries: SyncEntry[];
}> {
  let sourceBytes: string;
  try {
    sourceBytes = await fs.readFile(mapFile, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw migrationError("sync_map_missing", mapFile);
    }
    throw migrationError("sync_map_unreadable", errorDetail(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceBytes) as unknown;
  } catch (error: unknown) {
    throw migrationError("sync_map_invalid_json", errorDetail(error));
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw migrationError("sync_map_missing_entries", "Expected an entries array");
  }
  const entries: SyncEntry[] = [];
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const entry: unknown = parsed.entries[index] as unknown;
    if (!isSyncEntry(entry)) {
      throw migrationError(
        "sync_map_invalid_entry",
        `Entry at index ${index} is not a structurally valid SyncEntry`,
      );
    }
    entries.push(entry);
  }
  return { sourceBytes, entries };
}

async function listRawTaskBasenames(taskDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(taskDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error: unknown) {
    throw migrationError("task_inventory_unavailable", errorDetail(error));
  }
}

function reportComparator(
  left: GitHubSyncMigrationAction | GitHubSyncMigrationUnresolved,
  right: GitHubSyncMigrationAction | GitHubSyncMigrationUnresolved,
): number {
  if (left.rule !== right.rule) return left.rule - right.rule;
  const taskOrder = left.entry.taskId.localeCompare(right.entry.taskId);
  if (taskOrder !== 0) return taskOrder;
  if (left.entry.issueNumber !== right.entry.issueNumber) {
    return left.entry.issueNumber - right.entry.issueNumber;
  }
  return JSON.stringify(left.entry).localeCompare(JSON.stringify(right.entry));
}

function migrationTimestamp(runAt: Date): string {
  return runAt.toISOString().replace(/[-:.]/g, "");
}

async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await fs.unlink(tempPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeEmptyDirectory(directoryPath: string): Promise<void> {
  try {
    await fs.rmdir(directoryPath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

export async function migrateGitHubSyncMap(
  options: GitHubSyncMigrationOptions,
  dependencies: GitHubSyncMigrationDependencies = {},
): Promise<GitHubSyncMigrationResult> {
  if (!options.project) {
    throw migrationError("project_required", "Provide --project <path>");
  }

  const adapter = await loadAdapter(path.resolve(options.project));
  const projectRoot = adapter.projectRoot;
  const taskDir = path.resolve(projectRoot, adapter.config.project.taskDir);
  const mapFile = resolveGitHubSyncMapPath(projectRoot);

  const rawBasenames = await listRawTaskBasenames(taskDir);
  const rawBasenameSet = new Set(rawBasenames);
  const declarationProducer =
    dependencies.declarationProducer ??
    ((directory: string) => listTaskClaimantDeclarations(directory));
  let declarations: readonly TaskClaimantDeclaration[] | undefined;
  const claimantIndex = await buildStrictDuplicateClaimantIndex(async () => {
    declarations = await declarationProducer(taskDir);
    return declarations;
  });
  if (claimantIndex.status === "unavailable") {
    throw migrationError("claimant_scan_unavailable", claimantIndex.reason);
  }
  if (!declarations) {
    throw migrationError("claimant_scan_unavailable", "Declaration scan returned no result");
  }

  const { sourceBytes, entries } = await readRawSyncEntries(mapFile);
  const sourceMapSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const runAt = (dependencies.now ?? (() => new Date()))();
  const reportFileName = `github-sync-migration-${migrationTimestamp(runAt)}-${sourceMapSha256.slice(0, 12)}.json`;
  const reportPath = path.join(projectRoot, ".quack", "sync", "migrations", reportFileName);

  const declarationsByFile = new Map(
    declarations.map((declaration) => [declaration.fileName, declaration]),
  );
  const claimantsByDeclaredId = groupTaskClaimantsByDeclaredId(declarations);
  const lastIndexByTaskId = new Map<string, number>();
  entries.forEach((entry, index) => lastIndexByTaskId.set(entry.taskId, index));

  const actions: GitHubSyncMigrationAction[] = [];
  const unresolved: GitHubSyncMigrationUnresolved[] = [];
  const survivors: IndexedSyncEntry[] = [];
  entries.forEach((entry, index) => {
    if (lastIndexByTaskId.get(entry.taskId) !== index) {
      actions.push({ rule: 1, reason: "raw_duplicate", entry });
    } else {
      survivors.push({ entry });
    }
  });

  const survivorByTaskId = new Map(survivors.map(({ entry }) => [entry.taskId, entry]));
  const migratedEntries: SyncEntry[] = [];

  for (const { entry } of survivors) {
    const matchingFileName = entry.taskId + ".md";
    const matchingDeclaration = declarationsByFile.get(matchingFileName);
    const resolvedDeclaredId = matchingDeclaration?.declaredId;
    const contestedId = claimantIndex.contested.has(entry.taskId)
      ? entry.taskId
      : resolvedDeclaredId && claimantIndex.contested.has(resolvedDeclaredId)
        ? resolvedDeclaredId
        : undefined;

    if (contestedId) {
      unresolved.push({
        rule: 2,
        reason: "contested",
        targetTaskId: contestedId,
        claimants: [...(claimantIndex.contested.get(contestedId) ?? [])],
        entry,
      });
      migratedEntries.push(entry);
      continue;
    }

    if (claimantsByDeclaredId.has(entry.taskId)) {
      migratedEntries.push(entry);
      continue;
    }

    if (resolvedDeclaredId) {
      const targetEntry = survivorByTaskId.get(resolvedDeclaredId);
      if (!targetEntry) {
        actions.push({
          rule: 4,
          reason: "rewritten",
          fromTaskId: entry.taskId,
          toTaskId: resolvedDeclaredId,
          entry,
        });
        migratedEntries.push({ ...entry, taskId: resolvedDeclaredId });
        continue;
      }
      if (targetEntry.issueNumber === entry.issueNumber) {
        actions.push({
          rule: 5,
          reason: "merged_redundant",
          targetTaskId: resolvedDeclaredId,
          entry,
        });
        continue;
      }
      unresolved.push({
        rule: 6,
        reason: "issue_conflict",
        targetTaskId: resolvedDeclaredId,
        targetIssueNumber: targetEntry.issueNumber,
        entry,
      });
      migratedEntries.push(entry);
      continue;
    }

    if (rawBasenameSet.has(matchingFileName)) {
      unresolved.push({ rule: 7, reason: "unresolvable_current", entry });
    } else {
      unresolved.push({ rule: 8, reason: "orphan", entry });
    }
    migratedEntries.push(entry);
  }

  actions.sort(reportComparator);
  unresolved.sort(reportComparator);
  const report: GitHubSyncMigrationReport = {
    header: {
      runAt: runAt.toISOString(),
      mapFile,
      reportPath,
      sourceMapSha256,
    },
    actions,
    unresolved,
  };
  const serialization = JSON.stringify(report, null, 2);
  const result = { report, serialization };
  const writeOutput = dependencies.writeOutput ?? ((text: string) => console.log(text));

  if (options.dryRun) {
    writeOutput(serialization);
    return result;
  }

  const migratedMapBytes = JSON.stringify({ entries: migratedEntries }, null, 2);
  const mapChanged = actions.length > 0;
  const mapTempPath = `${mapFile}.${randomUUID()}.tmp`;
  const reportTempPath = `${reportPath}.${randomUUID()}.tmp`;
  const reportDirectory = path.dirname(reportPath);
  const renameMap = dependencies.renameMap ?? fs.rename;
  const writeReportTemp =
    dependencies.writeReportTemp ??
    ((tempPath: string, content: string) =>
      fs.writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" }));
  const renameReport = dependencies.renameReport ?? fs.rename;
  let reportDirectoryCreated = false;
  let preserveReportTemp = false;
  let completed = false;
  try {
    const createdDirectory = await fs.mkdir(reportDirectory, { recursive: true });
    reportDirectoryCreated = createdDirectory !== undefined;
    try {
      await writeReportTemp(reportTempPath, serialization);
    } catch (error: unknown) {
      throw migrationError("sync_report_stage_failed", errnoDetail(error));
    }

    if (mapChanged) {
      await fs.writeFile(mapTempPath, migratedMapBytes, "utf-8");
      try {
        await renameMap(mapTempPath, mapFile);
      } catch (error: unknown) {
        throw migrationError("sync_map_replace_failed", errnoDetail(error));
      }
    }

    try {
      await renameReport(reportTempPath, reportPath);
    } catch (error: unknown) {
      preserveReportTemp = true;
      const reason = mapChanged
        ? "sync_report_publish_failed_after_map_commit"
        : "sync_report_publish_failed";
      const mapState = mapChanged
        ? "The map replacement is committed"
        : "The map did not require replacement";
      throw migrationError(
        reason,
        `${mapState}; the staged report is preserved at ${reportTempPath} for recovery. ${errnoDetail(error)}`,
      );
    }
    completed = true;
  } finally {
    await removeTempFile(mapTempPath);
    if (!preserveReportTemp) {
      await removeTempFile(reportTempPath);
      if (!completed && reportDirectoryCreated) {
        await removeEmptyDirectory(reportDirectory);
      }
    }
  }

  writeOutput(serialization);
  return result;
}
