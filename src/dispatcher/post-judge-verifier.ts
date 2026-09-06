// ─── Post-Judge Verification Agent ────────────────────────────────
// Runs independent verification after judge APPROVE to catch quality
// gaps that the LLM judge misses: runtime integration issues, stub
// implementations, missing tests, and build/test failures.
//
// Three-layer approach:
// 1. Deterministic checks (build, test, lint) - runs adapter's verifyCommands
// 2. Structural checks (file existence, stubs, any types) - grep/file checks
// 3. Semantic verification (LLM-based) - evaluates criteria satisfaction

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  isStructuredVerificationCommand,
  verificationCommandShellString,
  type ParsedTask,
  type VerificationFinding,
  type PostJudgeResult,
} from "../core/types.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { execFileSync, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { worktreeEnv } from "../utils/worktree-env.js";
import { isDockerAvailable, run as dockerRun } from "../testing/docker-test-runner.js";
import { analyzeTestOutput, isTestCommand } from "../testing/test-output-analysis.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { prepareVerificationCommandRuntime } from "../worker/tools/verify.js";
import { buildScopedTestCommand, collectScopedTestFiles } from "../testing/scoped-test-command.js";

/**
 * Type for the SDK query function.
 */
type QueryFn = (args: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<{ type: string; subtype?: string; [key: string]: unknown }, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 */
let _queryFn: QueryFn | undefined;

function execAdapterCommandSync(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: BufferEncoding;
    timeout?: number;
    stdio: ["pipe", "pipe", "pipe"];
  },
): string {
  const runtime = prepareVerificationCommandRuntime(command, { env: options.env });
  if (runtime.error) {
    const err = new Error(runtime.error) as Error & { stderr?: string; stdout?: string };
    err.stderr = runtime.error;
    err.stdout = "";
    throw err;
  }

  return execSync(runtime.command, {
    cwd: options.cwd,
    env: runtime.env,
    encoding: options.encoding,
    timeout: options.timeout,
    stdio: options.stdio,
    shell: runtime.shell,
  });
}

/**
 * Sync execution of a structured (cmd+args) verification command via
 * {@link execFileSync} with `shell: false`. Mirrors the legacy shell-string
 * `execAdapterCommandSync` contract — same stdio + cwd + env semantics —
 * minus the Windows POSIX-PATH fix-up step (not needed when no shell parses
 * the args).
 */
function execStructuredAdapterCommandSync(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: BufferEncoding;
    timeout?: number;
    stdio: ["pipe", "pipe", "pipe"];
    structuredCwd?: string;
  },
): string {
  const resolvedCwd = options.structuredCwd
    ? pathResolve(options.cwd, options.structuredCwd)
    : options.cwd;
  return execFileSync(cmd, args, {
    cwd: resolvedCwd,
    env: options.env,
    encoding: options.encoding,
    timeout: options.timeout,
    stdio: options.stdio,
    shell: false,
    windowsHide: true,
  });
}

/**
 * Dynamically imports the Claude Agent SDK's query function.
 */
async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

// ─── Layer 1: Deterministic Checks ─────────────────────────────────

function shouldUseMappedTestRunner(command: string): boolean {
  const normalized = command.trim();

  // Project adapters may provide purpose-built verification scripts. Those
  // commands are the contract and must run as written; smart/tiered mapping is
  // only a fallback for generic test commands such as `npm test`.
  if (/\.quack\/verify-[^\s]+\.sh/.test(normalized)) {
    return false;
  }

  return true;
}

async function runDeterministicChecks(
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
  taskId = "",
  task?: ParsedTask,
): Promise<{
  buildPassed: boolean;
  testsPassed: boolean;
  lintPassed: boolean;
  testCount: number;
  findings: VerificationFinding[];
  smartTestDetails?: string;
}> {
  const findings: VerificationFinding[] = [];
  let buildPassed = true;
  let testsPassed = true;
  let lintPassed = true;
  let testCount = 0;
  let smartTestDetails: string | undefined;

  const env = worktreeEnv(workDir);
  const smartConfig = adapter.config.verification.smartTesting;
  const smartEnabled = smartConfig?.enabled ?? false;
  const tieredConfig = adapter.config.verification.tieredTesting;
  const tieredEnabled = tieredConfig?.enabled ?? false;
  const baseBranch = adapter.config.git?.baseBranch ?? "main";

  for (const cmd of adapter.config.verification.commands) {
    // Shell-string view of the command for pattern-matching, scoped-test
    // building, and human-readable evidence. Same value for both legacy and
    // structured forms.
    const cmdString = verificationCommandShellString(cmd);
    const isTestCmd = isTestCommand(cmd.name, cmdString);

    // ── Tiered testing path ───────────────────────────────────────
    // Takes precedence over smart testing when enabled.
    if (isTestCmd && shouldUseMappedTestRunner(cmdString) && tieredEnabled && tieredConfig) {
      try {
        const { mapChangedFilesToTests, mapChangedFilesToModuleTests } =
          await import("../testing/test-mapper.js");
        const { runTieredTests } = await import("../testing/test-runner.js");
        const { loadBaseline: loadTieredBaseline, diffAgainstBaseline } =
          await import("../testing/baseline-manager.js");
        const { writeFileSync, mkdirSync } = await import("node:fs");

        events.emit("test_run_start", { taskId, mode: "tiered" });

        // Get changed files from git diff
        let diffFiles: string[] = [];
        try {
          const mergeBase = execSync(`git merge-base ${baseBranch} HEAD`, {
            cwd: workDir,
            env,
            encoding: "utf-8",
          }).trim();
          const diffRef = mergeBase || "HEAD";
          diffFiles = execSync(`git diff --name-only ${diffRef}..HEAD`, {
            cwd: workDir,
            env,
            encoding: "utf-8",
          })
            .trim()
            .split("\n")
            .filter(Boolean);
        } catch {
          // git diff failed — fall through to regular test path
        }

        // ── Tier 1: Changed-file unit tests ──
        const tier1Files = mapChangedFilesToTests(diffFiles, workDir);
        const tier1Result = await runTieredTests(taskId, 1, tier1Files, adapter, workDir);

        // ── Tier 2: Module integration tests (deduplicated against Tier 1) ──
        const tier2Files = mapChangedFilesToModuleTests(diffFiles, workDir, tier1Files);
        const tier2Result = await runTieredTests(taskId, 2, tier2Files, adapter, workDir);

        // ── Baseline comparison ──
        const outputDir = tieredConfig.outputDir ?? ".quack/test-results";
        const baseline = loadTieredBaseline(workDir, outputDir);

        let tier1NewFailures = tier1Result.failures.length;
        let tier2NewFailures = tier2Result.failures.length;
        let tier2PreExisting = 0;

        if (baseline) {
          const tier1Diff = diffAgainstBaseline(tier1Result.failures, baseline);
          tier1NewFailures = tier1Diff.newFailures.length;

          const tier2Diff = diffAgainstBaseline(tier2Result.failures, baseline);
          tier2NewFailures = tier2Diff.newFailures.length;
          tier2PreExisting = tier2Diff.preExisting.length;
        }

        const totalNewFailures = tier1NewFailures + tier2NewFailures;
        testCount = tier1Result.ran + tier2Result.ran;

        // ── Write results artifact ──
        const resultReport = {
          taskId,
          timestamp: new Date().toISOString(),
          tier1: {
            ran: tier1Result.ran,
            passed: tier1Result.passed,
            failed: tier1Result.failed,
            skipped: tier1Result.skipped,
            newFailures: tier1NewFailures,
            files: tier1Files,
          },
          tier2: {
            ran: tier2Result.ran,
            passed: tier2Result.passed,
            failed: tier2Result.failed,
            skipped: tier2Result.skipped,
            newFailures: tier2NewFailures,
            preExisting: tier2PreExisting,
            details: tier2Result.failures,
          },
          baseline: baseline
            ? {
                source: baseline.source,
                date: baseline.timestamp,
                totalTests: baseline.totalTests,
                totalFailing: baseline.totalFailing,
              }
            : null,
          verdict: totalNewFailures === 0 ? ("pass" as const) : ("fail" as const),
        };

        const fullOutputDir = join(workDir, outputDir);
        mkdirSync(fullOutputDir, { recursive: true });
        const resultPath = join(fullOutputDir, `${taskId}-results.json`);
        writeFileSync(resultPath, JSON.stringify(resultReport, null, 2));

        // ── Set test criterion ──
        if (testCount === 0) {
          if (cmd.required !== false) {
            testsPassed = false;
          }
          findings.push({
            criterion: cmd.name,
            status: cmd.required !== false ? "fail" : "warn",
            evidence:
              cmd.required !== false
                ? "Tiered testing ran 0 tests. Required test commands cannot pass with 0/0 coverage."
                : "Optional tiered test command ran 0 tests.",
          });
        } else if (totalNewFailures === 0) {
          findings.push({
            criterion: cmd.name,
            status: "pass",
            evidence: `Tiered testing: Tier 1 (${tier1Result.passed}/${tier1Result.ran} passed), Tier 2 (${tier2Result.passed}/${tier2Result.ran} passed). ${totalNewFailures} new failures.`,
          });
        } else {
          if (cmd.required !== false) {
            testsPassed = false;
          }
          smartTestDetails =
            `Tiered testing found ${totalNewFailures} new failure(s):\n` +
            [...tier1Result.failures, ...tier2Result.failures]
              .map((f) => `- ${f.fullName}: ${f.message.slice(0, 200)}`)
              .join("\n");
          findings.push({
            criterion: cmd.name,
            status: cmd.required !== false ? "fail" : "warn",
            evidence: `Tiered testing: ${totalNewFailures} new failure(s). Tier 1: ${tier1Result.failed} failed, Tier 2: ${tier2Result.failed} failed.`,
          });
        }

        events.emit("test_run_complete", {
          taskId,
          totalTests: testCount,
          passed: tier1Result.passed + tier2Result.passed,
          failed: tier1Result.failed + tier2Result.failed,
          newFailures: totalNewFailures,
          preExisting: tier2PreExisting,
        });

        events.emit("post_judge_verify_finding", {
          taskId,
          criterion: cmd.name,
          status: findings[findings.length - 1].status,
          evidence: findings[findings.length - 1].evidence,
        });

        continue; // Skip the regular execSync path
      } catch (tieredErr) {
        // Tiered testing failed — fall through to smart/regular path
        const msg = tieredErr instanceof Error ? tieredErr.message : String(tieredErr);
        events.emit("session_error", {
          error: `Tiered test runner failed (falling back): ${msg}`,
          failedStage: "tiered_test_runner",
        });
      }
    }

    // ── Smart test runner path ────────────────────────────────────
    if (isTestCmd && shouldUseMappedTestRunner(cmdString) && smartEnabled && smartConfig) {
      try {
        const { runSmartTests } = await import("../testing/smart-test-runner.js");
        const { loadBaseline, compareWithBaseline } = await import("../testing/test-baseline.js");
        const { formatTestSummary, formatTestDetails, writeTestArtifact } =
          await import("../testing/test-formatter.js");

        events.emit("test_run_start", { taskId, mode: smartConfig.mode });

        const result = runSmartTests({
          mode: smartConfig.mode,
          workDir,
          baseBranch,
          outputDir: smartConfig.outputDir,
          taskId,
          timeout: cmd.timeout,
        });

        // Baseline comparison
        let baselineUnavailable = false;
        if (smartConfig.baselineEnabled) {
          const baselineDir = join(workDir, smartConfig.outputDir);
          const baseline = loadBaseline(baselineDir, taskId);
          if (baseline && baseline.totalTests > 0) {
            result.baseline = compareWithBaseline(result, baseline);
          } else if (baseline && baseline.totalTests === 0) {
            // Baseline captured 0 tests — comparison is unreliable.
            // ALL current failures would be classified as "new" which is
            // misleading. Treat as baseline_unavailable instead.
            baselineUnavailable = true;
          }
        }

        testCount = result.totalTests;

        // Write artifact
        const artifactPath = join(workDir, smartConfig.outputDir, `${taskId}-result.json`);
        writeTestArtifact(result, artifactPath);

        // Determine pass/fail based on baseline comparison
        if (result.totalTests === 0) {
          if (cmd.required !== false) {
            testsPassed = false;
          }
          findings.push({
            criterion: cmd.name,
            status: cmd.required !== false ? "fail" : "warn",
            evidence:
              cmd.required !== false
                ? `Smart test runner reported 0 tests. Required test commands cannot pass with zero coverage: ${formatTestSummary(result)}`
                : `Optional smart test command reported 0 tests: ${formatTestSummary(result)}`,
          });
        } else if (result.baseline) {
          if (result.baseline.allFailuresPreExisting && !smartConfig.failOnPreExisting) {
            // All failures are pre-existing — tests pass from the agent's perspective
            // Keep testsPassed sticky-false if an earlier required test command
            // already failed in this verification run.
            findings.push({
              criterion: cmd.name,
              status: "pass",
              evidence: `Smart test runner: ${formatTestSummary(result)}. All failures pre-existing.`,
            });
          } else if (result.baseline.newFailures.length > 0) {
            if (cmd.required !== false) {
              testsPassed = false;
            }
            smartTestDetails = formatTestDetails(result);
            findings.push({
              criterion: cmd.name,
              status: cmd.required !== false ? "fail" : "warn",
              evidence: `Smart test runner: ${formatTestSummary(result)}`,
            });
          } else {
            if (result.exitCode !== 0 && cmd.required !== false) testsPassed = false;
            findings.push({
              criterion: cmd.name,
              status: result.exitCode === 0 ? "pass" : cmd.required !== false ? "fail" : "warn",
              evidence: `Smart test runner: ${formatTestSummary(result)}`,
            });
          }
        } else if (baselineUnavailable && result.failed > 0) {
          // Baseline had 0 tests — cannot distinguish pre-existing from new.
          // Don't count failures as "new" — warn instead of fail.
          // Don't block on unreliable baseline comparison, but keep any earlier
          // required test failure sticky.
          smartTestDetails = formatTestDetails(result);
          findings.push({
            criterion: cmd.name,
            status: "warn",
            evidence: `Smart test runner (baseline_unavailable): ${formatTestSummary(result)}. Baseline had 0 tests — failures may be pre-existing. Manual review recommended.`,
          });
        } else {
          // No baseline available — fall back to exit code
          if (result.exitCode !== 0 && cmd.required !== false) testsPassed = false;
          if (result.failed > 0) {
            smartTestDetails = formatTestDetails(result);
          }
          findings.push({
            criterion: cmd.name,
            status: result.exitCode === 0 ? "pass" : cmd.required !== false ? "fail" : "warn",
            evidence: `Smart test runner (no baseline): ${formatTestSummary(result)}`,
          });
        }

        events.emit("test_run_complete", {
          taskId,
          totalTests: result.totalTests,
          passed: result.passed,
          failed: result.failed,
          newFailures: result.baseline?.newFailures.length ?? result.failed,
          preExisting: result.baseline?.preExisting.length ?? 0,
        });

        events.emit("test_result_summary", {
          taskId,
          summary: formatTestSummary(result),
          allFailuresPreExisting: result.baseline?.allFailuresPreExisting ?? false,
        });

        events.emit("test_dashboard_update", {
          taskId,
          projectRoot: workDir,
        });

        events.emit("post_judge_verify_finding", {
          taskId,
          criterion: cmd.name,
          status: findings[findings.length - 1].status,
          evidence: findings[findings.length - 1].evidence,
        });

        continue; // Skip the regular execSync path for this command
      } catch (smartErr) {
        // Smart runner failed — fall through to regular execSync
        const msg = smartErr instanceof Error ? smartErr.message : String(smartErr);
        events.emit("session_error", {
          error: `Smart test runner failed (falling back to execSync): ${msg}`,
          failedStage: "smart_test_runner",
        });
      }
    }

    // ── Docker command path ───────────────────────────────────────
    if (cmd.environment === "docker" && cmd.docker) {
      if (!isDockerAvailable()) {
        events.emit("post_judge_verify_finding", {
          taskId,
          criterion: cmd.name,
          status: "warn",
          evidence: "Docker unavailable — skipping Docker command (fallback to host only)",
        });
        findings.push({
          criterion: cmd.name,
          status: "warn",
          evidence: "Docker unavailable — command skipped",
        });
        events.emit("session_error", {
          error: `Docker unavailable: skipping Docker command "${cmd.name}"`,
          failedStage: "docker_test",
        });
        continue;
      }

      const dockerResult = dockerRun({
        composeFile: cmd.docker.composeFile,
        service: cmd.docker.service,
        command: cmdString,
        workDir,
        timeout: cmd.timeout,
        dependsOn: cmd.docker.dependsOn,
      });

      const dockerOutput = [dockerResult.stdout, dockerResult.stderr].filter(Boolean).join("\n");
      const dockerTestAnalysis = isTestCmd ? analyzeTestOutput(dockerOutput) : undefined;
      const dockerPassed =
        dockerResult.exitCode === 0 &&
        !(isTestCmd && cmd.required !== false && dockerTestAnalysis?.explicitNoTests);
      const dockerTruncated =
        dockerOutput.length > 500 ? dockerOutput.slice(0, 500) + "..." : dockerOutput;
      const dockerStatus = dockerPassed ? "pass" : cmd.required !== false ? "fail" : "warn";

      if (isTestCmd) {
        if (dockerTestAnalysis?.count !== undefined) {
          testCount += dockerTestAnalysis.count;
        } else if (dockerPassed) {
          testCount++;
        }
        if (!dockerPassed && cmd.required !== false) {
          testsPassed = false;
        }
      } else if (cmd.name.toLowerCase().includes("build")) {
        if (!dockerPassed && cmd.required !== false) buildPassed = false;
      }

      findings.push({
        criterion: cmd.name,
        status: dockerStatus,
        evidence: dockerPassed
          ? `Docker command succeeded: ${cmdString}`
          : `Docker command failed: ${dockerTruncated}`,
      });

      events.emit("post_judge_verify_finding", {
        taskId,
        criterion: cmd.name,
        status: dockerStatus,
        evidence: dockerPassed ? "Docker command succeeded" : dockerTruncated,
      });

      continue;
    }

    // ── Regular execSync path ─────────────────────────────────────
    try {
      const output = isStructuredVerificationCommand(cmd)
        ? execStructuredAdapterCommandSync(cmd.cmd, cmd.args, {
            cwd: workDir,
            env: cmd.env ? { ...env, ...cmd.env } : env,
            encoding: "utf-8",
            timeout: cmd.timeout,
            stdio: ["pipe", "pipe", "pipe"],
            structuredCwd: cmd.cwd,
          })
        : execAdapterCommandSync(cmd.command, {
            cwd: workDir,
            env,
            encoding: "utf-8",
            timeout: cmd.timeout,
            stdio: ["pipe", "pipe", "pipe"],
          });

      // Count tests if this is a test command
      if (isTestCmd) {
        // Try to extract test count from output (Jest/Vitest pattern)
        const testAnalysis = analyzeTestOutput(output);
        if (testAnalysis.explicitNoTests) {
          if (cmd.required !== false) {
            testsPassed = false;
          }
          findings.push({
            criterion: cmd.name,
            status: cmd.required !== false ? "fail" : "warn",
            evidence: `Command reported zero tests: ${cmdString}`,
          });
          events.emit("post_judge_verify_finding", {
            taskId,
            criterion: cmd.name,
            status: cmd.required !== false ? "fail" : "warn",
            evidence:
              cmd.required !== false
                ? "Required test command reported zero tests"
                : "Optional test command reported zero tests",
          });
          continue;
        }

        if (testAnalysis.count !== undefined) {
          testCount += testAnalysis.count;
        } else {
          testCount++; // At least one test ran
        }
      }

      findings.push({
        criterion: cmd.name,
        status: "pass",
        evidence: `Command succeeded: ${cmdString}`,
      });

      events.emit("post_judge_verify_finding", {
        taskId,
        criterion: cmd.name,
        status: "pass",
        evidence: `Command succeeded`,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = error.stderr?.toString() ?? "";
      const stdout = error.stdout?.toString() ?? "";
      const output = stderr || stdout || String(err);
      const truncated = output.length > 500 ? output.slice(0, 500) + "..." : output;

      // ── Scoped test fallback ─────────────────────────────────────
      // When a full test suite fails, check if the task has scoped test
      // files. If so, re-run only those files. If scoped tests pass,
      // the failure is pre-existing and should not block the agent.
      if (isTestCmd) {
        // Collect test files from two sources:
        // 1. Task spec's filesToModify (planned test files)
        // 2. Git diff (test files the agent actually created/modified)
        const testFiles = collectScopedTestFiles(
          task,
          workDir,
          adapter.config.git?.baseBranch ?? "main",
        );
        const scopedCmd = buildScopedTestCommand(cmdString, testFiles);

        if (scopedCmd) {
          try {
            const scopedOutput = execAdapterCommandSync(scopedCmd, {
              cwd: workDir,
              env,
              encoding: "utf-8",
              timeout: cmd.timeout,
              stdio: ["pipe", "pipe", "pipe"],
            });

            // Scoped tests passed — pre-existing failures in full suite
            const scopedMatch = scopedOutput.match(/(\d+)\s+passed/i);
            if (scopedMatch) testCount += parseInt(scopedMatch[1], 10);

            findings.push({
              criterion: cmd.name,
              status: "pass",
              evidence: `Full suite failed (pre-existing failures), but scoped tests passed: ${testFiles.join(", ")}`,
            });

            events.emit("post_judge_verify_finding", {
              taskId,
              criterion: cmd.name,
              status: "pass",
              evidence: `Scoped tests passed via ${scopedCmd}. Full suite has pre-existing failures.`,
            });

            // Do NOT mark testsPassed = false — scoped tests passed
            continue;
          } catch {
            // Scoped tests also failed — this is a real failure, fall through
          }
        }
      }

      // ── Frontend-unchanged build-skip ────────────────────────────
      // When a build command fails with errors in frontend/ but the diff
      // does NOT touch any frontend/ files, this is a pre-existing
      // infrastructure failure unrelated to the agent's work.
      // Emit a non-blocking warning instead of failing the build.
      if (
        cmd.required !== false &&
        cmd.name.toLowerCase().includes("build") &&
        (output.includes("frontend/") || output.includes("frontend\\"))
      ) {
        // Check if the diff touches any frontend/ files
        let diffTouchesFrontend = false;
        try {
          const diffBase = getDiffBase(workDir, adapter.config.git?.baseBranch ?? "main");
          const diffFiles = execSync(`git diff --name-only ${diffBase}..HEAD`, {
            cwd: workDir,
            env,
            encoding: "utf-8",
          })
            .trim()
            .split("\n")
            .filter(Boolean);
          diffTouchesFrontend = diffFiles.some(
            (f) => f.startsWith("frontend/") || f.startsWith("frontend\\"),
          );
        } catch {
          // If git diff fails, assume frontend IS touched (safe default — fail loudly)
          diffTouchesFrontend = true;
        }

        if (!diffTouchesFrontend) {
          findings.push({
            criterion: cmd.name,
            status: "warn",
            evidence:
              `post_judge_frontend_unchanged_skip: Build failed in frontend/ but diff ` +
              `does not touch frontend/. This is a pre-existing infrastructure failure ` +
              `(frontend/node_modules may be missing or incomplete). Agent changes are ` +
              `unaffected. Operator should run 'npm --prefix frontend install' on the host.\n` +
              truncated,
          });
          events.emit("post_judge_verify_finding", {
            taskId,
            criterion: cmd.name,
            status: "warn",
            evidence:
              "post_judge_frontend_unchanged_skip: pre-existing frontend build failure, diff does not touch frontend/",
          });
          // Do NOT set buildPassed = false — this is not the agent's failure
          continue;
        }
      }

      // Determine which category failed. Optional commands are advisory:
      // they should surface host/project drift without rejecting unrelated
      // task branches.
      const status = cmd.required !== false ? "fail" : "warn";
      if (cmd.name.toLowerCase().includes("lint")) lintPassed = false;
      if (cmd.required !== false) {
        if (cmd.name.toLowerCase().includes("build")) buildPassed = false;
        if (isTestCmd) testsPassed = false;
      }

      findings.push({
        criterion: cmd.name,
        status,
        evidence: `${cmd.required !== false ? "Command failed" : "Optional command failed"}: ${cmdString}\n${truncated}`,
      });

      events.emit("post_judge_verify_finding", {
        taskId,
        criterion: cmd.name,
        status,
        evidence: `${cmd.required !== false ? "Command failed" : "Optional command failed"}: ${truncated}`,
      });
    }
  }

  return { buildPassed, testsPassed, lintPassed, testCount, findings, smartTestDetails };
}

/**
 * Get the git diff reference for comparing agent changes.
 * In worktrees, the agent commits its work, so `git diff HEAD` returns nothing.
 * Instead, diff against the merge-base with the base branch to see all branch changes.
 * Falls back to HEAD if merge-base detection fails.
 */
function getDiffBase(workDir: string, baseBranch = "main"): string {
  const env = worktreeEnv(workDir);
  try {
    execSync(`git fetch origin ${baseBranch}:refs/remotes/origin/${baseBranch}`, {
      cwd: workDir,
      env,
      stdio: "ignore",
    });
  } catch {
    // Non-fatal: an existing remote-tracking ref is still better than a stale
    // local branch when the host is offline or fetch is transiently blocked.
  }

  try {
    const mergeBase = execSync(`git merge-base origin/${baseBranch} HEAD`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    }).trim();
    if (mergeBase.length > 0) return mergeBase;
  } catch {
    // Fall through to local branch below.
  }

  try {
    const mergeBase = execSync(`git merge-base ${baseBranch} HEAD`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    }).trim();
    if (mergeBase.length > 0) return mergeBase;
    return "HEAD";
  } catch {
    // merge-base failed (detached HEAD, no main branch, etc.) — fall back to HEAD
    return "HEAD";
  }
}

// ─── Layer 2: Structural Checks ────────────────────────────────────

async function runStructuralChecks(
  task: ParsedTask,
  workDir: string,
  events: IEventWriter,
  baseBranch: string,
): Promise<VerificationFinding[]> {
  const findings: VerificationFinding[] = [];
  const diffBase = getDiffBase(workDir, baseBranch);
  const env = worktreeEnv(workDir);

  // Check 1: Verify files from "Files to Modify" exist and were changed
  // Build a list of actually-changed files from git diff for fuzzy matching
  // when the spec path doesn't match exactly (e.g. spec says "src/types/foo.ts"
  // but agent correctly created "frontends/app/src/types/foo.ts").
  let changedFiles: string[] = [];
  try {
    const diffOutput = execSync(`git diff --name-only ${diffBase}`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    });
    changedFiles = diffOutput.trim().split("\n").filter(Boolean);
  } catch {
    // If git diff fails, fall back to exact-path-only checks
  }

  if (task.filesToModify && task.filesToModify.length > 0) {
    for (const fileEntry of task.filesToModify) {
      const filePath = join(workDir, fileEntry.path);
      try {
        await fs.access(filePath);
        // File exists at exact path - check if it was actually modified
        try {
          const gitDiff = execSync(`git diff ${diffBase} -- "${fileEntry.path}"`, {
            cwd: workDir,
            env,
            encoding: "utf-8",
          });
          if (gitDiff.trim().length === 0) {
            findings.push({
              criterion: `File modified: ${fileEntry.path}`,
              status: "warn",
              evidence: `File exists but has no changes in git diff`,
            });
          } else {
            findings.push({
              criterion: `File modified: ${fileEntry.path}`,
              status: "pass",
              evidence: `File exists and has changes`,
            });
          }
        } catch {
          // Git diff failed - file might be new
          findings.push({
            criterion: `File modified: ${fileEntry.path}`,
            status: "pass",
            evidence: `File exists (may be newly created)`,
          });
        }
      } catch {
        // File not at exact spec path — check if agent created it at a
        // different (but valid) path by matching the filename in the diff.
        // This handles monorepo path mismatches (e.g. spec says "src/types/foo.ts"
        // but the correct path is "frontends/app/src/types/foo.ts").
        const basename = fileEntry.path.split("/").pop() ?? "";
        const matchedPath = changedFiles.find((f) => f.endsWith(`/${basename}`) || f === basename);

        if (matchedPath) {
          // File was created/modified at a different path — pass with a note
          findings.push({
            criterion: `File modified: ${fileEntry.path}`,
            status: "pass",
            evidence: `File found at alternate path: ${matchedPath} (spec path may be imprecise)`,
          });
        } else {
          // Downgrade to warn, not fail. The spec's filesToModify can contradict
          // success criteria (e.g. spec lists a file to create but criteria say
          // "do NOT create X"). The LLM judge evaluates completeness — structural
          // checks should be advisory, not blocking.
          findings.push({
            criterion: `File modified: ${fileEntry.path}`,
            status: "warn",
            evidence: `File not found at ${filePath} and not in git diff. May be intentionally omitted if success criteria override filesToModify.`,
          });
        }
      }
    }
  }

  // Check 2: Detect stub functions in new/modified files
  try {
    const gitDiff = execSync(`git diff ${diffBase}`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    });

    const stubPatterns = [
      /not implemented/i,
      /TODO:/i,
      /FIXME:/i,
      /throw new Error.*stub/i,
      /\/\/ stub/i,
    ];

    // Parse diff to find added lines with stubs
    const addedLines = gitDiff.split("\n").filter((line) => line.startsWith("+"));
    const stubsFound: string[] = [];

    for (const line of addedLines) {
      for (const pattern of stubPatterns) {
        if (pattern.test(line)) {
          stubsFound.push(line.slice(0, 100));
          break;
        }
      }
    }

    if (stubsFound.length > 0) {
      // Warn instead of fail — stubs may be intentional deliverables
      // (e.g. route scaffolding). The LLM judge can evaluate intent.
      findings.push({
        criterion: "No stub implementations",
        status: "warn",
        evidence: `Found ${stubsFound.length} stub pattern(s): ${stubsFound.slice(0, 3).join("; ")}`,
      });
    } else {
      findings.push({
        criterion: "No stub implementations",
        status: "pass",
        evidence: "No stub patterns detected in new code",
      });
    }
  } catch {
    // Git diff failed - skip this check
  }

  // Check 3: Detect 'any' type usage in new TypeScript files
  try {
    const gitDiff = execSync(`git diff ${diffBase}`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    });

    // Find TypeScript added lines with : any
    const addedLines = gitDiff.split("\n").filter((line) => line.startsWith("+"));
    const anyUsage: string[] = [];

    for (const line of addedLines) {
      if (/:\s*any[^a-zA-Z]/.test(line)) {
        anyUsage.push(line.slice(0, 100));
      }
    }

    if (anyUsage.length > 0) {
      findings.push({
        criterion: "No any type usage",
        status: "warn",
        evidence: `Found ${anyUsage.length} 'any' type usage(s) in new code`,
      });
    } else {
      findings.push({
        criterion: "No any type usage",
        status: "pass",
        evidence: "No 'any' type detected in new TypeScript code",
      });
    }
  } catch {
    // Git diff failed - skip this check
  }

  // Check 4: Count test files vs testing requirements and flag shortfalls
  const testingReqs = task.testingRequirements?.length ?? 0;
  if (testingReqs > 0) {
    try {
      const gitDiffNames = execSync(`git diff ${diffBase} --name-only`, {
        cwd: workDir,
        env,
        encoding: "utf-8",
      });

      const testFiles = gitDiffNames
        .split("\n")
        .filter((f) => f.includes("test") || f.includes("spec"));

      const testCount = testFiles.length;

      if (testCount === 0) {
        findings.push({
          criterion: "Test coverage",
          status: "fail",
          evidence: `No test files found in changes, but ${testingReqs} testing requirement(s) specified. At least one test file is expected.`,
        });
      } else if (testCount < testingReqs) {
        // Test files exist but fewer than requirements — warn about shortfall
        findings.push({
          criterion: "Test coverage",
          status: "warn",
          evidence: `${testCount} test file(s) found for ${testingReqs} testing requirement(s). One test file may cover multiple requirements, but review for gaps.`,
        });
      } else {
        findings.push({
          criterion: "Test coverage",
          status: "pass",
          evidence: `${testCount} test file(s) found for ${testingReqs} testing requirement(s)`,
        });
      }
    } catch {
      // Git diff failed - skip this check
    }
  }

  // Emit findings
  for (const finding of findings) {
    events.emit("post_judge_verify_finding", {
      taskId: "",
      criterion: finding.criterion,
      status: finding.status,
      evidence: finding.evidence,
    });
  }

  return findings;
}

// ─── Layer 3: Helpers ──────────────────────────────────────────────

/**
 * Read full contents of modified files within a token budget.
 * This allows the LLM to verify integration wiring and runtime behavior
 * beyond what the diff alone shows.
 */
async function getModifiedFileContents(
  workDir: string,
  maxTokens: number,
  baseBranch: string,
): Promise<string> {
  try {
    const diffBase = getDiffBase(workDir, baseBranch);
    const env = worktreeEnv(workDir);
    const fileList = execSync(`git diff ${diffBase} --name-only`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    });

    const files = fileList.split("\n").filter((f) => f.trim().length > 0);
    const maxChars = Math.floor(maxTokens * 0.5) * 3; // half the budget, ~3 chars/token
    let totalChars = 0;
    const sections: string[] = [];

    for (const file of files) {
      if (totalChars >= maxChars) break;
      try {
        const filePath = join(workDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const remaining = maxChars - totalChars;
        const truncated =
          content.length > remaining
            ? content.slice(0, remaining) + "\n[... file truncated ...]"
            : content;
        sections.push(`── ${file} ──\n${truncated}`);
        totalChars += truncated.length;
      } catch {
        // File might not exist (deleted) — skip
      }
    }

    return sections.join("\n\n");
  } catch {
    return "";
  }
}

// ─── Layer 3: Semantic Verification ────────────────────────────────

function splitDiffByFile(gitDiff: string): Array<{ path: string; content: string }> {
  const parts = gitDiff.split(/(?=^diff --git )/m);
  return parts
    .filter((p) => p.trim())
    .map((p) => {
      const m = p.match(/^diff --git a\/.+ b\/(.+)$/m);
      return { path: m ? m[1] : "unknown", content: p };
    });
}

interface TruncationResult {
  diff: string;
  note: string | null;
  skipped: boolean;
  originalTokens: number;
  retainedTokens: number;
  fileCount: number;
}

function applyTwoModeTruncation(gitDiff: string, maxSemanticTokens: number): TruncationResult {
  const originalChars = gitDiff.length;
  const originalTokens = Math.ceil(originalChars / 3);
  const noTruncateLimit = maxSemanticTokens * 3; // 1× budget in chars
  const skipLimit = maxSemanticTokens * 9; // 3× budget in chars

  if (originalChars <= noTruncateLimit) {
    return {
      diff: gitDiff,
      note: null,
      skipped: false,
      originalTokens,
      retainedTokens: originalTokens,
      fileCount: 0,
    };
  }

  if (originalChars >= skipLimit) {
    return { diff: "", note: null, skipped: true, originalTokens, retainedTokens: 0, fileCount: 0 };
  }

  // Mode A: per-file proportional truncation
  const files = splitDiffByFile(gitDiff);
  const fullFiles: string[] = [];
  const truncFiles: string[] = [];
  const truncatedParts: string[] = [];

  for (const file of files) {
    const ratio = file.content.length / originalChars;
    const fileBudget = Math.floor(noTruncateLimit * ratio);
    if (file.content.length <= fileBudget) {
      truncatedParts.push(file.content);
      fullFiles.push(file.path);
    } else {
      truncatedParts.push(file.content.slice(0, fileBudget) + `\n[... ${file.path} truncated ...]`);
      truncFiles.push(file.path);
    }
  }

  const truncatedDiff = truncatedParts.join("\n");
  const retainedTokens = Math.ceil(truncatedDiff.length / 3);
  const noteLines = [
    `[NOTE: this diff was truncated to fit the ${maxSemanticTokens}-token semantic budget.`,
    fullFiles.length > 0 ? `Files shown in full: ${fullFiles.join(", ")}.` : null,
    truncFiles.length > 0 ? `Files truncated: ${truncFiles.join(", ")}.` : null,
    `DO NOT mark a criterion FAIL solely because you cannot find supporting`,
    `evidence in the truncated portion — flag it as \`partial_evidence\` and`,
    `let the LLM judge's prior verdict stand.]`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    diff: truncatedDiff,
    note: noteLines,
    skipped: false,
    originalTokens,
    retainedTokens,
    fileCount: files.length,
  };
}

async function runSemanticVerification(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  workDir: string,
  layer1Findings: VerificationFinding[],
  layer2Findings: VerificationFinding[],
  events: IEventWriter,
): Promise<VerificationFinding[]> {
  const config = adapter.config.verification.postJudge;
  if (!config) return [];

  const findings: VerificationFinding[] = [];

  try {
    // Get git diff
    const env = worktreeEnv(workDir);
    const gitDiff = execSync("git diff HEAD", {
      cwd: workDir,
      env,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 5, // 5MB max
    });

    // Mode B: skip semantic layer for diffs >3× token budget
    const truncation = applyTwoModeTruncation(gitDiff, config.maxSemanticTokens);
    if (truncation.skipped) {
      events.emit("post_judge_semantic_truncated", {
        taskId,
        originalTokens: truncation.originalTokens,
        retainedTokens: 0,
        fileCount: 0,
        mode: "skipped",
      });
      findings.push({
        criterion: "Semantic verification",
        status: "warn",
        evidence: `semantic_skipped_too_large: diff is ~${truncation.originalTokens} tokens (>${config.maxSemanticTokens * 3} token skip threshold). Deterministic + structural layers + LLM judge already evaluated.`,
      });
      return findings;
    }

    // Get list of modified files and read their full contents for integration checking
    const modifiedFileContents = await getModifiedFileContents(
      workDir,
      config.maxSemanticTokens,
      adapter.config.git?.baseBranch ?? "main",
    );

    // Emit truncation event for Mode A
    if (truncation.note) {
      events.emit("post_judge_semantic_truncated", {
        taskId,
        originalTokens: truncation.originalTokens,
        retainedTokens: truncation.retainedTokens,
        fileCount: truncation.fileCount,
        mode: "truncated",
      });
    }

    // Build prompt for semantic verification
    const prompt = buildSemanticVerificationPrompt(
      task,
      truncation.diff,
      layer1Findings,
      layer2Findings,
      modifiedFileContents,
      truncation.note,
    );

    // Call LLM via Agent SDK with 3-minute timeout cap (anti-pattern: don't block forever)
    const SEMANTIC_TIMEOUT_MS = 180_000; // 3 minutes
    const query = await getQueryFn();
    const stream = query({
      prompt,
      options: {
        model: config.model,
        maxTurns: 3,
        tools: [],
        ...getSdkPermissionOptions(),
      },
    });

    // Collect response text from result message, with timeout
    let responseText = "";
    const llmPromise = (async () => {
      for await (const message of stream) {
        if (message.type === "result" && message.subtype === "success") {
          const content = (message as { content?: string }).content;
          if (content) {
            return content;
          }
        }
      }
      return "";
    })();

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error("Layer 3 semantic verification timed out (3 minute cap)")),
        SEMANTIC_TIMEOUT_MS,
      ),
    );

    try {
      responseText = await Promise.race([llmPromise, timeoutPromise]);
    } catch (timeoutErr) {
      // Timeout — fall back to Layer 1+2 results only
      findings.push({
        criterion: "Semantic verification",
        status: "warn",
        evidence:
          timeoutErr instanceof Error ? timeoutErr.message : "Semantic verification timed out",
      });
      return findings;
    }

    if (responseText) {
      findings.push(...parseSemanticResponse(responseText, task));
    }

    // Emit findings
    for (const finding of findings) {
      events.emit("post_judge_verify_finding", {
        taskId,
        criterion: finding.criterion,
        status: finding.status,
        evidence: finding.evidence,
      });
    }
  } catch (err) {
    // LLM call failed - emit warning but don't fail verification
    const error = err instanceof Error ? err.message : String(err);
    findings.push({
      criterion: "Semantic verification",
      status: "warn",
      evidence: `Layer 3 verification failed: ${error}`,
    });
  }

  return findings;
}

function buildSemanticVerificationPrompt(
  task: ParsedTask,
  gitDiff: string,
  layer1Findings: VerificationFinding[],
  layer2Findings: VerificationFinding[],
  modifiedFileContents?: string,
  truncationNote?: string | null,
): string {
  const layer1Summary = layer1Findings.map((f) => `- ${f.criterion}: ${f.status}`).join("\n");
  const layer2Summary = layer2Findings.map((f) => `- ${f.criterion}: ${f.status}`).join("\n");

  const fileContentsSection = modifiedFileContents
    ? `\nFull Modified File Contents (for integration verification):\n${modifiedFileContents}\n`
    : "";

  const truncationSection = truncationNote ? `\n${truncationNote}\n` : "";

  return `You are verifying a task implementation for quality and integration issues.

Task Success Criteria:
${task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Testing Requirements:
${task.testingRequirements?.map((r, i) => `${i + 1}. ${r}`).join("\n") ?? "None specified"}

Git Diff:
\`\`\`diff
${gitDiff}
\`\`\`
${truncationSection}${fileContentsSection}
Layer 1 Results (Build/Test/Lint):
${layer1Summary}

Layer 2 Results (Structural):
${layer2Summary}

Evaluate each success criterion against the actual code (not just the diff).
For each criterion:
1. Does the code ACTUALLY satisfy this criterion at runtime, not just syntactically?
2. Are new endpoints/functions wired into the existing initialization and lifecycle code?
3. Does the code reference paths correctly (worktree paths, not hardcoded paths)?
4. Are new features accessible from the API/UI?
5. Are there any integration gaps or missing wiring?

Known failure patterns to check:
- Standalone modules with no integration (not imported, not called, not registered)
- Worktree path bugs (using wrong base paths)
- Required fields changed to optional (or vice versa) breaking compatibility
- Missing error handling in new endpoints
- Tests that don't actually test the new feature

For each success criterion, respond with:
CRITERION: <criterion text>
STATUS: pass | fail | warn
EVIDENCE: <specific reasoning>

Be thorough and skeptical. If something looks disconnected or incomplete, flag it.`;
}

function parseSemanticResponse(text: string, task: ParsedTask): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const lines = text.split("\n");

  let currentCriterion = "";
  let currentStatus: "pass" | "fail" | "warn" = "pass";
  let currentEvidence = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("CRITERION:")) {
      // Save previous finding if exists
      if (currentCriterion) {
        findings.push({
          criterion: currentCriterion,
          status: currentStatus,
          evidence: currentEvidence,
        });
      }
      // Start new finding
      currentCriterion = trimmed.slice("CRITERION:".length).trim();
      currentStatus = "pass";
      currentEvidence = "";
    } else if (trimmed.startsWith("STATUS:")) {
      const status = trimmed.slice("STATUS:".length).trim().toLowerCase();
      if (status === "pass" || status === "fail" || status === "warn") {
        currentStatus = status;
      }
    } else if (trimmed.startsWith("EVIDENCE:")) {
      currentEvidence = trimmed.slice("EVIDENCE:".length).trim();
    } else if (currentEvidence && trimmed) {
      // Continue evidence on next line
      currentEvidence += " " + trimmed;
    }
  }

  // Save last finding
  if (currentCriterion) {
    findings.push({
      criterion: currentCriterion,
      status: currentStatus,
      evidence: currentEvidence,
    });
  }

  // Verify that every success criterion from the task received a response.
  // If the LLM skipped a criterion, add a warn finding for it.
  const respondedCriteria = new Set(findings.map((f) => f.criterion.toLowerCase()));
  for (const criterion of task.successCriteria) {
    const criterionLower = criterion.toLowerCase();
    // Check if any responded finding matches this criterion (substring or exact)
    const matched = Array.from(respondedCriteria).some(
      (rc) => rc.includes(criterionLower) || criterionLower.includes(rc),
    );
    if (!matched) {
      findings.push({
        criterion,
        status: "warn",
        evidence:
          "LLM semantic verification did not evaluate this criterion — manual review recommended",
      });
    }
  }

  return findings;
}

// ─── Main Verification Function ────────────────────────────────────

export async function runPostJudgeVerification(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
): Promise<PostJudgeResult> {
  const config = adapter.config.verification.postJudge ?? {
    enabled: true,
    layers: ["deterministic", "structural", "semantic"],
    model: "claude-haiku-4-5-20251001",
    failOnBuildError: true,
    failOnTestError: true,
    failOnLintError: false,
    maxSemanticTokens: 8000,
  };

  if (!config.enabled) {
    // Verification disabled - return pass
    return {
      verified: true,
      buildPassed: true,
      testsPassed: true,
      lintPassed: true,
      testCount: 0,
      findings: [],
      summary: "Post-judge verification disabled",
    };
  }

  const allFindings: VerificationFinding[] = [];
  let buildPassed = true;
  let testsPassed = true;
  let lintPassed = true;
  let testCount = 0;

  // Layer 1: Deterministic checks
  if (config.layers.includes("deterministic")) {
    const layer1 = await runDeterministicChecks(adapter, workDir, events, taskId, task);
    allFindings.push(...layer1.findings);
    buildPassed = layer1.buildPassed;
    testsPassed = layer1.testsPassed;
    lintPassed = layer1.lintPassed;
    testCount = layer1.testCount;
  }

  // Layer 2: Structural checks
  let layer2Findings: VerificationFinding[] = [];
  if (config.layers.includes("structural")) {
    layer2Findings = await runStructuralChecks(
      task,
      workDir,
      events,
      adapter.config.git?.baseBranch ?? "main",
    );
    allFindings.push(...layer2Findings);
  }

  // Layer 3: Semantic verification
  if (config.layers.includes("semantic")) {
    const layer3Findings = await runSemanticVerification(
      taskId,
      task,
      adapter,
      workDir,
      allFindings.filter((f) => f.criterion.match(/build|test|lint/i)),
      layer2Findings,
      events,
    );
    allFindings.push(...layer3Findings);
  }

  // Determine overall verification result
  // Exclude lint failures from critical failures if failOnLintError is false
  const criticalFailures = allFindings.filter((f) => {
    if (f.status !== "fail") return false;
    if (f.criterion.toLowerCase().includes("lint") && !config.failOnLintError) return false;
    return true;
  });
  // Build/test failures always trigger REVISE — failOnBuildError and failOnTestError
  // default to true and should not be set to false (the spec mandates this).
  // Only lint failure respects the failOnLintError config flag.
  const buildTestLintFailed =
    (config.failOnBuildError && !buildPassed) ||
    (config.failOnTestError && !testsPassed) ||
    (config.failOnLintError && !lintPassed);

  // ── Authority Inversion ──────────────────────────────────────────
  // When all deterministic checks (build, test, lint) PASS but LLM-based
  // layers (semantic/structural) have critical failures, deterministic
  // evidence takes priority. Set verified=true but flag needsReview so
  // the dispatcher surfaces it for human review instead of auto-rejecting.
  const allDeterministicPass = buildPassed && testsPassed && lintPassed;
  const hasNonDeterministicFailures = criticalFailures.length > 0 && !buildTestLintFailed;
  const needsReview = allDeterministicPass && hasNonDeterministicFailures;

  const verified = needsReview
    ? true // Deterministic checks are authoritative — don't auto-reject
    : criticalFailures.length === 0 && !buildTestLintFailed;

  // Build summary
  const failCount = criticalFailures.length;
  const warnCount = allFindings.filter((f) => f.status === "warn").length;
  const passCount = allFindings.filter((f) => f.status === "pass").length;

  let summary = "";
  if (needsReview) {
    summary = `Post-judge verification needs review: deterministic checks passed but ${failCount} LLM-based issue(s) flagged`;
    if (warnCount > 0) {
      summary += `, ${warnCount} warning(s)`;
    }
    summary += "\n\nFlagged issues (deterministic checks override):\n";
    summary += criticalFailures.map((f) => `- ${f.criterion}: ${f.evidence}`).join("\n");
  } else if (verified) {
    summary = `Post-judge verification passed: ${passCount} checks passed`;
    if (warnCount > 0) {
      summary += `, ${warnCount} warning(s)`;
    }
  } else {
    summary = `Post-judge verification failed: ${failCount} critical issue(s) found`;
    if (warnCount > 0) {
      summary += `, ${warnCount} warning(s)`;
    }
    summary += "\n\nFailures:\n";
    summary += criticalFailures.map((f) => `- ${f.criterion}: ${f.evidence}`).join("\n");
  }

  return {
    verified,
    buildPassed,
    testsPassed,
    lintPassed,
    testCount,
    findings: allFindings,
    summary,
    needsReview,
  };
}
