// TASK-1336-A preserved migration proofs from 2888b40e/088bab7a/d8bcce6f.
// The historical build used a throwing scaffold for its red baseline.
// This semantic port retains those fixtures; current validation is recorded separately.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  migrateGitHubSyncMap,
  type GitHubSyncMigrationReport,
  type GitHubSyncMigrationResult,
  type GitHubSyncMigrationDependencies,
} from "../../src/cli/migrate-github-sync-map";
import { listTaskClaimantDeclarations } from "../../src/core/task-file-resolver";
import type { TaskClaimantDeclaration } from "../../src/core/duplicate-claimants";
import type { SyncEntry } from "../../src/integrations/github/github-types";
import { GitHubSyncMap } from "../../src/integrations/github/sync-map";
import { taskSpec, writeTestAdapter } from "../helpers/divergent-task-fixture";

const RUN_AT_1 = new Date("2026-08-18T17:18:19.123Z");
const RUN_AT_2 = new Date("2026-08-18T17:18:20.456Z");
const ENTRY_TIME = "2026-08-18T00:00:00.000Z";

interface MigrationFixture {
  root: string;
  taskDir: string;
  mapFile: string;
  cleanup(): void;
}

function syncEntry(taskId: string, issueNumber: number): SyncEntry {
  return {
    taskId,
    issueNumber,
    direction: "published",
    createdAt: ENTRY_TIME,
    lastSyncedAt: ENTRY_TIME,
    issueState: "open",
    taskStatus: "BACKLOG",
  };
}

function createFixture(
  prefix: string,
  entries: SyncEntry[] | undefined,
  taskFiles: Record<string, string> = {},
): MigrationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const adapterPath = writeTestAdapter(root);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
    project: { root: string };
  };
  adapter.project.root = ".";
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2), "utf-8");
  for (const [fileName, content] of Object.entries(taskFiles)) {
    fs.writeFileSync(path.join(taskDir, fileName), content, "utf-8");
  }
  const mapFile = path.join(root, ".quack", "sync", "github-sync.json");
  if (entries) {
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, JSON.stringify({ entries }, null, 2), "utf-8");
  }
  return {
    root,
    taskDir,
    mapFile,
    cleanup: () =>
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
  };
}

function readMap(mapFile: string): { entries: SyncEntry[] } {
  return JSON.parse(fs.readFileSync(mapFile, "utf-8")) as { entries: SyncEntry[] };
}

function taskFile(id: string, status = "BACKLOG"): string {
  return taskSpec(id, { title: `${id} migration fixture`, status });
}

function filesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        found.push(`${relativePath}/`);
        visit(fullPath);
      } else {
        found.push(relativePath);
      }
    }
  };
  visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function migrationArtifacts(fixture: MigrationFixture): string[] {
  const syncDir = path.dirname(fixture.mapFile);
  return filesBelow(syncDir).filter((file) => file !== "github-sync.json");
}

async function runMigration(
  fixture: MigrationFixture,
  runAt: Date = RUN_AT_1,
  options: {
    dryRun?: boolean;
    declarationProducer?: (taskDir: string) => Promise<readonly TaskClaimantDeclaration[]>;
    renameMap?: (source: string, destination: string) => Promise<void>;
    writeReportTemp?: (tempPath: string, serialization: string) => Promise<void>;
    renameReport?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<{ result: GitHubSyncMigrationResult; output: string[] }> {
  const output: string[] = [];
  const dependencies: GitHubSyncMigrationDependencies = {
    now: () => runAt,
    writeOutput: (serialized: string) => output.push(serialized),
    declarationProducer: options.declarationProducer,
    renameMap: options.renameMap,
    writeReportTemp: options.writeReportTemp,
    renameReport: options.renameReport,
  };
  const result = await migrateGitHubSyncMap(
    { project: fixture.root, dryRun: options.dryRun },
    dependencies,
  );
  return { result, output };
}

function expectReportHeader(
  report: GitHubSyncMigrationReport,
  fixture: MigrationFixture,
  sourceBytes: string,
  runAt = RUN_AT_1,
): void {
  const sha = createHash("sha256").update(sourceBytes).digest("hex");
  expect(report.header).toEqual({
    runAt: runAt.toISOString(),
    mapFile: fixture.mapFile,
    reportPath: path.join(
      fixture.root,
      ".quack",
      "sync",
      "migrations",
      `github-sync-migration-${runAt.toISOString().replace(/[-:.]/g, "")}-${sha.slice(0, 12)}.json`,
    ),
    sourceMapSha256: sha,
  });
  expect(Object.keys(report)).toEqual(["header", "actions", "unresolved"]);
  expect(Object.keys(report.header)).toEqual(["runAt", "mapFile", "reportPath", "sourceMapSha256"]);
}

describe("TASK-1336-A: ordered sync-map migration decision table", () => {
  it("rule 1 reports the raw duplicate shadow and lets the last survivor continue", async () => {
    const legacyId = "TASK-601-descriptive-file";
    const shadowed = syncEntry(legacyId, 11);
    const survivor = syncEntry(legacyId, 12);
    const fixture = createFixture("quack-1336a-rule1-", [shadowed, survivor], {
      [`${legacyId}.md`]: taskFile("TASK-601"),
    });
    const sourceBytes = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const collapsed = new GitHubSyncMap(fixture.mapFile);
      await collapsed.load();
      expect(collapsed.getAllEntries()).toEqual([survivor]);

      const { result } = await runMigration(fixture);
      expectReportHeader(result.report, fixture, sourceBytes);
      expect(result.report.actions).toEqual([
        { rule: 1, reason: "raw_duplicate", entry: shadowed },
        {
          rule: 4,
          reason: "rewritten",
          fromTaskId: legacyId,
          toTaskId: "TASK-601",
          entry: survivor,
        },
      ]);
      expect(result.report.unresolved).toEqual([]);
      expect(readMap(fixture.mapFile).entries).toEqual([{ ...survivor, taskId: "TASK-601" }]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 2 leaves the TASK-1338 two-legacy-row claimant shape contested", async () => {
    const alpha = syncEntry("TASK-500-alpha", 21);
    const zeta = syncEntry("TASK-500-zeta", 22);
    const claimants = ["TASK-500-alpha.md", "TASK-500-zeta.md"];
    const fixture = createFixture("quack-1336a-rule2-", [zeta, alpha], {
      "TASK-500-alpha.md": taskFile("TASK-500"),
      "TASK-500-zeta.md": taskFile("TASK-500"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([]);
      expect(result.report.unresolved).toEqual([
        {
          rule: 2,
          reason: "contested",
          targetTaskId: "TASK-500",
          claimants,
          entry: alpha,
        },
        {
          rule: 2,
          reason: "contested",
          targetTaskId: "TASK-500",
          claimants,
          entry: zeta,
        },
      ]);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 3 leaves an uncontested current declared-id key untouched and unreported", async () => {
    const canonical = syncEntry("TASK-602", 31);
    const fixture = createFixture("quack-1336a-rule3-", [canonical], {
      "TASK-602-descriptive.md": taskFile("TASK-602"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([]);
      expect(result.report.unresolved).toEqual([]);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 4 rewrites a uniquely resolved legacy stem when the declared key is free", async () => {
    const legacyId = "TASK-603-descriptive";
    const legacy = syncEntry(legacyId, 41);
    const fixture = createFixture("quack-1336a-rule4-", [legacy], {
      [`${legacyId}.md`]: taskFile("TASK-603"),
    });
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([
        {
          rule: 4,
          reason: "rewritten",
          fromTaskId: legacyId,
          toTaskId: "TASK-603",
          entry: legacy,
        },
      ]);
      expect(result.report.unresolved).toEqual([]);
      expect(readMap(fixture.mapFile).entries).toEqual([{ ...legacy, taskId: "TASK-603" }]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 5 removes only a same-issue redundant legacy row and reports it", async () => {
    const legacyId = "TASK-604-descriptive";
    const canonical = syncEntry("TASK-604", 51);
    const redundant = syncEntry(legacyId, 51);
    const fixture = createFixture("quack-1336a-rule5-", [canonical, redundant], {
      [`${legacyId}.md`]: taskFile("TASK-604"),
    });
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([
        {
          rule: 5,
          reason: "merged_redundant",
          targetTaskId: "TASK-604",
          entry: redundant,
        },
      ]);
      expect(result.report.unresolved).toEqual([]);
      expect(readMap(fixture.mapFile).entries).toEqual([canonical]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 6 leaves a different-issue collision untouched and reports the conflict", async () => {
    const legacyId = "TASK-605-descriptive";
    const canonical = syncEntry("TASK-605", 61);
    const conflicting = syncEntry(legacyId, 62);
    const fixture = createFixture("quack-1336a-rule6-", [canonical, conflicting], {
      [`${legacyId}.md`]: taskFile("TASK-605"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([]);
      expect(result.report.unresolved).toEqual([
        {
          rule: 6,
          reason: "issue_conflict",
          targetTaskId: "TASK-605",
          targetIssueNumber: 61,
          entry: conflicting,
        },
      ]);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 7 distinguishes a present malformed current file from an orphan", async () => {
    const legacyId = "TASK-606-malformed-current";
    const legacy = syncEntry(legacyId, 71);
    const fixture = createFixture("quack-1336a-rule7-", [legacy], {
      [`${legacyId}.md`]: "not a parseable task\n",
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([]);
      expect(result.report.unresolved).toEqual([
        {
          rule: 7,
          reason: "unresolvable_current",
          entry: legacy,
        },
      ]);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("rule 8 leaves a stem with no matching current basename as an orphan", async () => {
    const orphan = syncEntry("TASK-607-removed", 81);
    const fixture = createFixture("quack-1336a-rule8-", [orphan], {
      "TASK-608-current.md": taskFile("TASK-608"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toEqual([]);
      expect(result.report.unresolved).toEqual([
        {
          rule: 8,
          reason: "orphan",
          entry: orphan,
        },
      ]);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("TASK-1336-A: migration preconditions and fail-closed input", () => {
  it("leaves the map unchanged and removes a partial staged report when report writing fails", async () => {
    const legacy = syncEntry("TASK-617-description", 88);
    const fixture = createFixture("quack-1336a-report-write-failure-", [legacy], {
      "TASK-617-description.md": taskFile("TASK-617"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    const writeFailure = Object.assign(new Error("injected report write failure"), {
      code: "EIO",
    });
    const writeReportTemp = jest.fn<Promise<void>, [string, string]>(
      async (tempPath, serialization) => {
        await fs.promises.writeFile(tempPath, serialization.slice(0, 24), "utf-8");
        throw writeFailure;
      },
    );
    try {
      await expect(runMigration(fixture, RUN_AT_1, { writeReportTemp })).rejects.toThrow(
        "sync_report_stage_failed: EIO: injected report write failure",
      );
      expect(writeReportTemp).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not publish a completed report when the map replacement fails", async () => {
    const legacy = syncEntry("TASK-619-description", 90);
    const fixture = createFixture("quack-1336a-rename-failure-", [legacy], {
      "TASK-619-description.md": taskFile("TASK-619"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    const renameFailure = Object.assign(new Error("injected map rename failure"), {
      code: "EPERM",
    });
    const renameMap = jest.fn<Promise<void>, [string, string]>(() => Promise.reject(renameFailure));
    try {
      await expect(runMigration(fixture, RUN_AT_1, { renameMap })).rejects.toThrow(
        "sync_map_replace_failed: EPERM: injected map rename failure",
      );
      expect(renameMap).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves the staged report and names it when publication fails after map commit", async () => {
    const legacy = syncEntry("TASK-618-description", 89);
    const fixture = createFixture("quack-1336a-report-rename-failure-", [legacy], {
      "TASK-618-description.md": taskFile("TASK-618"),
    });
    const renameFailure = Object.assign(new Error("injected report rename failure"), {
      code: "EBUSY",
    });
    let stagedReportPath = "";
    let officialReportPath = "";
    const renameReport = jest.fn<Promise<void>, [string, string]>((source, destination) => {
      stagedReportPath = source;
      officialReportPath = destination;
      return Promise.reject(renameFailure);
    });
    let failure: Error | undefined;
    try {
      await runMigration(fixture, RUN_AT_1, { renameReport });
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    try {
      expect(renameReport).toHaveBeenCalledTimes(1);
      expect(failure?.message).toContain("sync_report_publish_failed_after_map_commit");
      expect(failure?.message).toContain("The map replacement is committed");
      expect(failure?.message).toContain(stagedReportPath);
      expect(failure?.message).toContain("EBUSY: injected report rename failure");
      expect(readMap(fixture.mapFile).entries).toEqual([
        {
          ...legacy,
          taskId: "TASK-618",
        },
      ]);
      expect(fs.existsSync(officialReportPath)).toBe(false);
      expect(fs.existsSync(stagedReportPath)).toBe(true);
      const stagedReport = JSON.parse(fs.readFileSync(stagedReportPath, "utf-8")) as {
        header: { reportPath: string };
        actions: Array<{ rule: number; reason: string }>;
      };
      expect(stagedReport.header.reportPath).toBe(officialReportPath);
      expect(stagedReport.actions).toEqual([
        expect.objectContaining({ rule: 4, reason: "rewritten" }),
      ]);
      expect(migrationArtifacts(fixture)).toEqual([
        "migrations/",
        `migrations/${path.basename(stagedReportPath)}`,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("aborts an unavailable declaration scan before map, report, or temp writes", async () => {
    const legacy = syncEntry("TASK-620-description", 91);
    const fixture = createFixture("quack-1336a-scan-unavailable-", [legacy], {
      "TASK-620-description.md": taskFile("TASK-620"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    const producer = jest.fn<Promise<readonly TaskClaimantDeclaration[]>, [string]>(() =>
      Promise.reject(new Error("injected declaration scan failure")),
    );
    try {
      await expect(
        runMigration(fixture, RUN_AT_1, {
          declarationProducer: producer,
        }),
      ).rejects.toThrow("claimant_scan_unavailable");
      expect(producer).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("aborts a raw task inventory failure before creating the sync directory", async () => {
    const fixture = createFixture("quack-1336a-inventory-unavailable-", undefined);
    fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    try {
      await expect(runMigration(fixture)).rejects.toThrow("task_inventory_unavailable");
      expect(fs.existsSync(path.dirname(fixture.mapFile))).toBe(false);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      name: "missing map file",
      reason: "sync_map_missing",
      raw: undefined,
    },
    {
      name: "invalid JSON",
      reason: "sync_map_invalid_json",
      raw: "{not json",
    },
    {
      name: "missing entries array",
      reason: "sync_map_missing_entries",
      raw: JSON.stringify({ rows: [] }),
    },
    {
      name: "structurally invalid row",
      reason: "sync_map_invalid_entry",
      raw: JSON.stringify({ entries: [{ taskId: "TASK-621", issueNumber: "wrong" }] }),
    },
  ])("refuses $name with the named $reason reason before any write", async ({ reason, raw }) => {
    const fixture = createFixture(`quack-1336a-${reason}-`, undefined, {
      "TASK-621-current.md": taskFile("TASK-621"),
    });
    if (raw !== undefined) {
      fs.mkdirSync(path.dirname(fixture.mapFile), { recursive: true });
      fs.writeFileSync(fixture.mapFile, raw, "utf-8");
    }
    try {
      await expect(runMigration(fixture)).rejects.toThrow(reason);
      if (raw !== undefined) expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(raw);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("TASK-1336-A: migration stability, dry-run, paths, and registration", () => {
  it("keeps the second map byte-identical and the unresolved report body stable", async () => {
    const rewrite = syncEntry("TASK-630-description", 101);
    const orphan = syncEntry("TASK-631-removed", 102);
    const fixture = createFixture("quack-1336a-stability-", [rewrite, orphan], {
      "TASK-630-description.md": taskFile("TASK-630"),
    });
    try {
      const first = await runMigration(fixture, RUN_AT_1);
      const firstMapBytes = fs.readFileSync(fixture.mapFile, "utf-8");
      const second = await runMigration(fixture, RUN_AT_2);
      const secondMapBytes = fs.readFileSync(fixture.mapFile, "utf-8");

      expect(secondMapBytes).toBe(firstMapBytes);
      expect(second.result.report.unresolved).toEqual(first.result.report.unresolved);
      expect(first.result.report.header.runAt).not.toBe(second.result.report.header.runAt);
      expect(first.result.report.actions).toHaveLength(1);
      expect(second.result.report.actions).toEqual([]);
      expect(fs.existsSync(first.result.report.header.reportPath)).toBe(true);
      expect(fs.existsSync(second.result.report.header.reportPath)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("dry-run prints the exact would-be serialization and writes nothing", async () => {
    const legacy = syncEntry("TASK-632-description", 111);
    const fixture = createFixture("quack-1336a-dry-run-", [legacy], {
      "TASK-632-description.md": taskFile("TASK-632"),
    });
    const before = fs.readFileSync(fixture.mapFile, "utf-8");
    try {
      const { result, output } = await runMigration(fixture, RUN_AT_1, { dryRun: true });
      expect(output).toEqual([result.serialization]);
      expect(result.serialization).toBe(JSON.stringify(result.report, null, 2));
      expect(fs.readFileSync(fixture.mapFile, "utf-8")).toBe(before);
      expect(migrationArtifacts(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("migration uses the selected absolute adapter root and leaves a foreign-cwd decoy untouched", async () => {
    const legacy = syncEntry("TASK-633-description", 121);
    const fixture = createFixture("quack-1336a-migration-root-", [legacy], {
      "TASK-633-description.md": taskFile("TASK-633"),
    });
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336a-migration-cwd-"));
    const decoyMap = path.join(foreignCwd, ".quack", "sync", "github-sync.json");
    fs.mkdirSync(path.dirname(decoyMap), { recursive: true });
    fs.writeFileSync(
      decoyMap,
      JSON.stringify({ entries: [syncEntry("TASK-DECOY", 999)] }, null, 2),
    );
    const decoyBefore = fs.readFileSync(decoyMap, "utf-8");
    const originalCwd = process.cwd();
    try {
      process.chdir(foreignCwd);
      const { result } = await runMigration(fixture);
      expect(result.report.header.mapFile).toBe(fixture.mapFile);
      expect(readMap(fixture.mapFile).entries).toEqual([{ ...legacy, taskId: "TASK-633" }]);
      expect(fs.readFileSync(decoyMap, "utf-8")).toBe(decoyBefore);
    } finally {
      process.chdir(originalCwd);
      fixture.cleanup();
      fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("pins tmp-write plus rename atomicity without using GitHubSyncMap.save", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/cli/migrate-github-sync-map.ts"),
      "utf-8",
    );
    expect(source).toContain("await fs.writeFile(mapTempPath");
    expect(source).toContain("await renameMap(mapTempPath, mapFile)");
    expect(source).not.toContain("new GitHubSyncMap");
    expect(source).not.toContain(".save()");
  });

  it("pins the production command registration in src/index.ts", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/index.ts"), "utf-8");
    expect(source).toMatch(
      /import \{ migrateGitHubSyncMap \} from "\.\/cli\/migrate-github-sync-map\.js"/,
    );
    expect(source).toContain('.command("migrate-github-sync-map")');
    expect(source).toContain('.requiredOption("--project <path>"');
    expect(source).toContain('.option("--dry-run"');
    expect(source).toMatch(/void migrateGitHubSyncMap\(options\)/);
  });

  it("uses the real declaration producer by default", async () => {
    const legacy = syncEntry("TASK-634-description", 131);
    const fixture = createFixture("quack-1336a-real-producer-", [legacy], {
      "TASK-634-description.md": taskFile("TASK-634"),
    });
    try {
      const declarations = await listTaskClaimantDeclarations(fixture.taskDir);
      expect(declarations).toEqual([
        {
          fileName: "TASK-634-description.md",
          declaredId: "TASK-634",
        },
      ]);
      const { result } = await runMigration(fixture);
      expect(result.report.actions).toHaveLength(1);
      expect(readMap(fixture.mapFile).entries[0].taskId).toBe("TASK-634");
    } finally {
      fixture.cleanup();
    }
  });
});
