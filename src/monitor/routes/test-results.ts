// ─── Test Results Routes ──────────────────────────────────────────
// REST API routes for accessing smart test runner results and baselines.

import type { Express, Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
  RetentionConfig,
  TestDashboardData,
  TestFailure,
  TestRunResult,
  TestSuiteResult,
} from "../../core/types.js";
import { saveBaseline } from "../../testing/baseline-manager.js";
import type { TieredTestResult } from "../../testing/types.js";

export interface ProjectContext {
  projectRoot?: string;
  adapterPath?: string;
}

const DEFAULT_RETENTION_CONFIG: Required<RetentionConfig> = {
  maxResults: 50,
  maxAgeDays: 30,
  keepBaselines: true,
};

function loadRetentionConfig(projectRoot: string, adapterPath?: string): Required<RetentionConfig> {
  const configPath = adapterPath ?? path.join(projectRoot, ".quack", "adapter.json");
  if (!fs.existsSync(configPath)) {
    return DEFAULT_RETENTION_CONFIG;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const verification = raw.verification as Record<string, unknown> | undefined;
    const retention = verification?.retention as Partial<RetentionConfig> | undefined;
    if (!retention) return DEFAULT_RETENTION_CONFIG;
    return {
      maxResults:
        typeof retention.maxResults === "number" && retention.maxResults > 0
          ? Math.floor(retention.maxResults)
          : DEFAULT_RETENTION_CONFIG.maxResults,
      maxAgeDays:
        typeof retention.maxAgeDays === "number" && retention.maxAgeDays > 0
          ? Math.floor(retention.maxAgeDays)
          : DEFAULT_RETENTION_CONFIG.maxAgeDays,
      keepBaselines:
        typeof retention.keepBaselines === "boolean"
          ? retention.keepBaselines
          : DEFAULT_RETENTION_CONFIG.keepBaselines,
    };
  } catch {
    return DEFAULT_RETENTION_CONFIG;
  }
}

export interface ArtifactPruneResult {
  removedResults: number;
  removedBaselines: number;
}

export function pruneTestArtifacts(
  resultsDir: string,
  retention: Required<RetentionConfig>,
): ArtifactPruneResult {
  if (!fs.existsSync(resultsDir)) {
    return { removedResults: 0, removedBaselines: 0 };
  }

  const now = Date.now();
  const cutoffMs = now - retention.maxAgeDays * 24 * 60 * 60 * 1000;

  const resultFiles = fs
    .readdirSync(resultsDir)
    .filter((file) => file.endsWith("-result.json"))
    .map((file) => {
      const fullPath = path.join(resultsDir, file);
      const stat = fs.statSync(fullPath);
      return { file, fullPath, mtimeMs: stat.mtimeMs, taskId: file.replace("-result.json", "") };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepByCount = new Set(
    resultFiles.slice(0, retention.maxResults).map((entry) => entry.file),
  );
  const keptTaskIds = new Set<string>();
  let removedResults = 0;
  for (const entry of resultFiles) {
    const shouldRemoveByAge = entry.mtimeMs < cutoffMs;
    const shouldRemoveByCount = !keepByCount.has(entry.file);
    if (shouldRemoveByAge || shouldRemoveByCount) {
      try {
        fs.unlinkSync(entry.fullPath);
        removedResults += 1;
      } catch {
        // best-effort
      }
      continue;
    }
    keptTaskIds.add(entry.taskId);
  }

  let removedBaselines = 0;
  if (!retention.keepBaselines) {
    const baselineFiles = fs
      .readdirSync(resultsDir)
      .filter((file) => file.endsWith("-baseline.json"))
      .map((file) => {
        const fullPath = path.join(resultsDir, file);
        const stat = fs.statSync(fullPath);
        return {
          file,
          fullPath,
          mtimeMs: stat.mtimeMs,
          taskId: file.replace("-baseline.json", ""),
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const baselineKeepByCount = new Set(
      baselineFiles
        .filter((entry) => keptTaskIds.has(entry.taskId))
        .slice(0, retention.maxResults)
        .map((entry) => entry.file),
    );

    for (const entry of baselineFiles) {
      const shouldRemoveByAge = entry.mtimeMs < cutoffMs;
      const shouldRemoveByCount = !baselineKeepByCount.has(entry.file);
      const shouldRemoveOrphan = !keptTaskIds.has(entry.taskId);
      if (shouldRemoveByAge || shouldRemoveByCount || shouldRemoveOrphan) {
        try {
          fs.unlinkSync(entry.fullPath);
          removedBaselines += 1;
        } catch {
          // best-effort
        }
      }
    }
  }

  return { removedResults, removedBaselines };
}

export function registerTestResultsRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
): void {
  /**
   * GET /api/tasks/:id/test-results
   * Returns the latest TestSuiteResult for a task.
   */
  app.get("/api/tasks/:id/test-results", (req: Request, res: Response) => {
    try {
      const { projectRoot } = resolveProject(req);
      if (!projectRoot) {
        res.status(400).json({ error: "No project root configured" });
        return;
      }

      const taskId = String(req.params.id);
      const resultsDir = path.join(projectRoot, ".quack", "test-results");
      const resultPath = path.join(resultsDir, `${taskId}-result.json`);

      if (!fs.existsSync(resultPath)) {
        res.status(404).json({ error: "No test results found for this task" });
        return;
      }

      const raw = fs.readFileSync(resultPath, "utf-8");
      const result = JSON.parse(raw) as Record<string, unknown>;
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/tasks/:id/test-results/baseline
   * Returns the baseline TestSuiteResult captured before the agent ran.
   */
  app.get("/api/tasks/:id/test-results/baseline", (req: Request, res: Response) => {
    try {
      const { projectRoot } = resolveProject(req);
      if (!projectRoot) {
        res.status(400).json({ error: "No project root configured" });
        return;
      }

      const taskId = String(req.params.id);
      const resultsDir = path.join(projectRoot, ".quack", "test-results");
      const baselinePath = path.join(resultsDir, `${taskId}-baseline.json`);

      if (!fs.existsSync(baselinePath)) {
        res.status(404).json({ error: "No baseline found for this task" });
        return;
      }

      const raw = fs.readFileSync(baselinePath, "utf-8");
      const baseline = JSON.parse(raw) as Record<string, unknown>;
      res.json(baseline);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Dashboard cache: Map<projectRoot, { data, timestamp }>
  const dashboardCache = new Map<string, { data: TestDashboardData; timestamp: number }>();
  const CACHE_TTL_MS = 30_000;

  /**
   * POST /api/test/full-suite
   * Trigger a Tier 3 full-suite test run. Runs asynchronously via child process.
   * Saves result as new baseline if test count improves or stays stable.
   */
  app.post("/api/test/full-suite", (req: Request, res: Response) => {
    try {
      const { projectRoot } = resolveProject(req);
      if (!projectRoot) {
        res.status(400).json({ error: "No project root configured" });
        return;
      }

      // Load adapter to check tiered testing config
      const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
      if (!fs.existsSync(adapterPath)) {
        res.status(400).json({ error: "No adapter.json found — tiered testing not configured" });
        return;
      }

      const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>;
      const verification = adapter.verification as Record<string, unknown> | undefined;
      const tieredConfig = verification?.tieredTesting as
        | { enabled?: boolean; dockerCommand?: string; outputDir?: string }
        | undefined;

      if (!tieredConfig?.enabled) {
        res.status(400).json({ error: "Tiered testing is not enabled in adapter.json" });
        return;
      }

      // Run Tier 3 asynchronously via child process
      const outputDir = tieredConfig.outputDir ?? ".quack/test-results";
      const fullOutputDir = path.join(projectRoot, outputDir);
      fs.mkdirSync(fullOutputDir, { recursive: true });
      const jsonOutputFile = path.join(fullOutputDir, "tier3-latest.json");

      const dockerCmd = tieredConfig.dockerCommand;
      const command = dockerCmd
        ? `${dockerCmd} npx jest --json --outputFile="${jsonOutputFile}" --forceExit`
        : `npx jest --json --outputFile="${jsonOutputFile}" --forceExit`;

      const child = spawn(command, [], {
        cwd: projectRoot,
        shell: true,
        stdio: "ignore",
        detached: false,
      });

      // Track completion and save baseline if results are clean or improving
      child.on("close", () => {
        try {
          if (fs.existsSync(jsonOutputFile)) {
            const raw = fs.readFileSync(jsonOutputFile, "utf-8");
            const json = JSON.parse(raw) as {
              success?: boolean;
              testResults?: Array<{
                name?: string;
                assertionResults?: Array<{
                  ancestorTitles?: string[];
                  title?: string;
                  fullName?: string;
                  status?: string;
                  failureMessages?: string[];
                }>;
              }>;
            };

            const failures: TestFailure[] = [];
            let totalPassed = 0;
            let totalFailed = 0;
            let totalSkipped = 0;

            for (const suite of json.testResults ?? []) {
              const suitePath = suite.name ?? "";
              for (const test of suite.assertionResults ?? []) {
                if (test.status === "passed") {
                  totalPassed++;
                } else if (test.status === "failed") {
                  totalFailed++;
                  failures.push({
                    suitePath,
                    ancestorTitles: test.ancestorTitles ?? [],
                    testName: test.title ?? "",
                    fullName: test.fullName ?? "",
                    message: (test.failureMessages ?? []).join("\n"),
                    stack: (test.failureMessages ?? []).join("\n"),
                  });
                } else {
                  totalSkipped++;
                }
              }
            }

            const tier3Result: TieredTestResult = {
              tier: 3,
              ran: totalPassed + totalFailed + totalSkipped,
              passed: totalPassed,
              failed: totalFailed,
              skipped: totalSkipped,
              files: [],
              durationMs: 0,
              exitCode: json.success ? 0 : 1,
              failures,
            };

            saveBaseline(projectRoot, tier3Result, outputDir);
          }
        } catch {
          // Best-effort baseline save — don't crash if parsing fails
        }
      });

      child.unref();

      res.json({
        status: "started",
        message: "Tier 3 full-suite test run started",
        outputFile: jsonOutputFile,
        pid: child.pid,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/testing/dashboard", (req: Request, res: Response) => {
    try {
      const { projectRoot, adapterPath } = resolveProject(req);
      if (!projectRoot) {
        res.status(400).json({ error: "No project root configured" });
        return;
      }

      // Check cache
      const now = Date.now();
      const cached = dashboardCache.get(projectRoot);
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        res.json(cached.data);
        return;
      }

      const resultsDir = path.join(projectRoot, ".quack", "test-results");
      const retention = loadRetentionConfig(projectRoot, adapterPath);
      pruneTestArtifacts(resultsDir, retention);

      // Compute aggregate metrics
      const data = computeDashboardData(resultsDir, projectRoot);

      // Update cache
      dashboardCache.set(projectRoot, { data, timestamp: now });
      res.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}

export function computeDashboardData(resultsDir: string, projectRoot: string): TestDashboardData {
  // Return empty structure if directory doesn't exist
  if (!fs.existsSync(resultsDir)) {
    return {
      latest: null,
      taskResults: [],
      slowestSuites: [],
      flakyTests: [],
      recentManualRuns: [],
      commandHealth: [],
    };
  }

  // Read all result files
  const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith("-result.json"));
  const results: Array<{ taskId: string; data: TestSuiteResult }> = [];

  for (const file of files) {
    try {
      const taskId = file.replace("-result.json", "");
      const raw = fs.readFileSync(path.join(resultsDir, file), "utf-8");
      const data = JSON.parse(raw) as TestSuiteResult;
      results.push({ taskId, data });
    } catch {
      // Skip malformed files
    }
  }

  // Sort by timestamp descending (newest first)
  results.sort(
    (a, b) => new Date(b.data.timestamp).getTime() - new Date(a.data.timestamp).getTime(),
  );

  // Compute latest snapshot
  const latest =
    results.length > 0
      ? {
          totalTests: results[0].data.totalTests,
          passed: results[0].data.passed,
          failed: results[0].data.failed,
          skipped: results[0].data.skipped,
          passRate:
            results[0].data.totalTests > 0
              ? (results[0].data.passed / results[0].data.totalTests) * 100
              : 0,
          durationMs: results[0].data.durationMs,
          timestamp: results[0].data.timestamp,
          taskId: results[0].taskId,
        }
      : null;

  // Compute per-task results (last 50)
  const taskResults = results.slice(0, 50).map((r) => ({
    taskId: r.taskId,
    timestamp: r.data.timestamp,
    totalTests: r.data.totalTests,
    passed: r.data.passed,
    failed: r.data.failed,
    newFailures: r.data.baseline?.newFailures.length ?? 0,
    preExisting: r.data.baseline?.preExisting.length ?? 0,
    fixed: r.data.baseline?.newlyFixed.length ?? 0,
    allPreExisting: r.data.baseline?.allFailuresPreExisting ?? false,
    durationMs: r.data.durationMs,
  }));

  // Compute slowest suites
  const suiteStats = new Map<string, { totalDuration: number; count: number; testCount: number }>();
  for (const r of results) {
    for (const suite of r.data.suites) {
      const existing = suiteStats.get(suite.path) ?? { totalDuration: 0, count: 0, testCount: 0 };
      suiteStats.set(suite.path, {
        totalDuration: existing.totalDuration + suite.duration,
        count: existing.count + 1,
        testCount: suite.passed + suite.failed + suite.skipped,
      });
    }
  }
  const slowestSuites = Array.from(suiteStats.entries())
    .map(([path, stats]) => ({
      path,
      avgDurationMs: stats.totalDuration / stats.count,
      testCount: stats.testCount,
    }))
    .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
    .slice(0, 10);

  // Compute flaky tests (failures appearing in multiple task results)
  const failureMap = new Map<string, { suitePath: string; taskIds: string[] }>();
  for (const r of results) {
    for (const failure of r.data.failures) {
      const key = failure.fullName;
      const existing = failureMap.get(key);
      if (existing) {
        if (!existing.taskIds.includes(r.taskId)) {
          existing.taskIds.push(r.taskId);
        }
      } else {
        failureMap.set(key, { suitePath: failure.suitePath, taskIds: [r.taskId] });
      }
    }
  }
  const flakyTests = Array.from(failureMap.entries())
    .filter(([, stats]) => stats.taskIds.length > 1)
    .map(([fullName, stats]) => ({
      fullName,
      suitePath: stats.suitePath,
      failureCount: stats.taskIds.length,
      taskIds: stats.taskIds,
    }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 20);

  // Load manual run history from JSONL
  const historyFile = path.join(projectRoot, ".quack", "logs", "test-history.jsonl");
  const recentManualRuns: TestRunResult[] = [];
  if (fs.existsSync(historyFile)) {
    try {
      const lines = fs
        .readFileSync(historyFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      const entries = lines.slice(-50).map((l) => JSON.parse(l) as TestRunResult);
      recentManualRuns.push(...entries);
    } catch {
      // Ignore parse errors
    }
  }

  // Compute command health from manual run history
  const commandStats = new Map<string, { exitCodes: number[]; runs: TestRunResult[] }>();
  for (const run of recentManualRuns) {
    const existing = commandStats.get(run.name) ?? { exitCodes: [], runs: [] };
    if (run.exitCode !== null) {
      existing.exitCodes.push(run.exitCode);
    }
    existing.runs.push(run);
    commandStats.set(run.name, existing);
  }
  const commandHealth = Array.from(commandStats.entries()).map(([name, stats]) => {
    const lastRun = stats.runs[stats.runs.length - 1];
    const last10 = stats.exitCodes.slice(-10);
    const passCount = last10.filter((code) => code === 0).length;
    return {
      name,
      lastExitCode: lastRun.exitCode,
      lastRunAt: lastRun.finishedAt,
      lastDurationMs: lastRun.durationMs,
      recentPassRate: last10.length > 0 ? (passCount / last10.length) * 100 : 0,
    };
  });

  return {
    latest,
    taskResults,
    slowestSuites,
    flakyTests,
    recentManualRuns: recentManualRuns.slice(-20),
    commandHealth,
  };
}
