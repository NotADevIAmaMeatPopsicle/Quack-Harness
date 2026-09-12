/**
 * TASK-922: tests for the `enrichment.autoCommit` adapter config wiring into
 * the legacy auto-enrich endpoints. Exercises `POST /api/tasks/:id/enrich/approve`
 * (the simpler integration point — the same `commitCanonicalTaskSpecChange`
 * call sits on `POST /api/tasks/:id/enrich` too, behind the same gating logic).
 *
 * Covers the five behaviors enumerated in TASK-922's Success Criteria:
 *   1. Flag off (default) — no git operations attempted.
 *   2. Flag on + clean tree + push:false — commit happens, push intentionally skipped.
 *   3. Flag on + clean tree + push:true + local origin — commit succeeds, unsafe push is refused.
 *   4. Flag on + dirty staged file — preexisting_staged_changes; file still written.
 *   5. Flag on + protected branch — protected_branch; no commit.
 *   6. Flag on + not a git repo — not_git_repository; file still written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { parseTaskFile } from "../../src/core/task-parser";
import type { GateResult } from "../../src/core/types";
import { runReadinessGate } from "../../src/gate/gate";
import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: jest.fn(),
}));

const mockedRunReadinessGate = runReadinessGate as jest.MockedFunction<typeof runReadinessGate>;

// Prevent tests from picking up real .quack/auth.json
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(prefix = "quack-enrich-autocommit-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function git(cwd: string, args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf-8") ?? ""),
      exitCode: e.status ?? 1,
    };
  }
}

const SPEC_BODY = [
  "# TASK-001: Test Task",
  "",
  "## Metadata",
  "- **Priority:** P1-HIGH",
  "- **Effort:** 2-4 hours",
  "- **Status:** READY",
  "- **Blocked By:** []",
  "- **Tags:** test",
  "",
  "## Problem Statement",
  "Test problem",
  "",
  "## Success Criteria",
  "- Criterion 1",
  "",
  "## Testing Requirements",
  "- Test it",
].join("\n");

interface EnrichmentAutoCommitFixture {
  /** Master switch. */
  enabled: boolean;
  /** When true, attempt push. */
  push?: boolean;
  /** Commit message template; `{taskId}` substituted at runtime. */
  commitMessageTemplate?: string;
  /** Branches on which auto-commit must not run. */
  skipBranches?: string[];
}

interface SetupOptions {
  initGit?: boolean;
  initialBranch?: string;
  baseBranch?: string;
  autoCommit?: EnrichmentAutoCommitFixture | null;
  /** When provided, configures origin to push to a bare repo at this path. */
  bareRemotePath?: string;
}

function setupTempProject(opts: SetupOptions = {}): { projectRoot: string; taskFile: string } {
  const projectRoot = makeTempDir();
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

  const taskFile = path.join(taskDir, "TASK-001-test.md");
  fs.writeFileSync(taskFile, SPEC_BODY, "utf-8");

  const adapterConfig: Record<string, unknown> = {
    version: "1.0.0",
    project: { name: "Test", root: projectRoot, taskDir: "docs/tasks", conventionsDir: ".quack" },
    agent: {
      model: "claude-opus-4-20250514",
      judgeModel: "claude-sonnet-4-20250514",
      enrichModel: "claude-sonnet-4-20250514",
      maxTurns: 30,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      branchPrefix: "quack",
      baseBranch: opts.baseBranch ?? opts.initialBranch ?? "main",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
  };
  if (opts.autoCommit) {
    adapterConfig.enrichment = {
      autoCommit: {
        enabled: opts.autoCommit.enabled,
        push: opts.autoCommit.push ?? true,
        commitMessageTemplate:
          opts.autoCommit.commitMessageTemplate ?? "spec(enrich): {taskId} auto-enrichment",
        skipBranches: opts.autoCommit.skipBranches ?? ["main", "production", "staging", "prod"],
      },
    };
  }
  fs.writeFileSync(
    path.join(projectRoot, ".quack", "adapter.json"),
    JSON.stringify(adapterConfig, null, 2),
    "utf-8",
  );

  if (opts.initGit) {
    git(projectRoot, ["init", `--initial-branch=${opts.initialBranch ?? "dev"}`]);
    git(projectRoot, ["config", "user.email", "quack-test@example.invalid"]);
    git(projectRoot, ["config", "user.name", "Quack Test"]);
    git(projectRoot, ["config", "commit.gpgsign", "false"]);
    git(projectRoot, ["add", "."]);
    git(projectRoot, ["commit", "-m", "initial"]);
    if (opts.bareRemotePath) {
      git(projectRoot, ["remote", "add", "origin", opts.bareRemotePath]);
    }
  }

  return { projectRoot, taskFile };
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

interface ApproveResponse {
  ok: boolean;
  taskId: string;
  filePath: string;
  baseSpecHash?: string;
  effectiveSpecHash?: string;
  git?: {
    attempted: boolean;
    committed: boolean;
    pushed: boolean;
    branch?: string;
    commitSha?: string;
    skippedReason?: string;
    error?: string;
  };
}

async function postEnrichApprove(
  port: number,
  taskId: string,
  content: string,
): Promise<ApproveResponse> {
  const { status, body } = await httpPost(
    `http://127.0.0.1:${port}/api/tasks/${taskId}/enrich/approve`,
    { content },
  );
  expect(status).toBe(200);
  return JSON.parse(body) as ApproveResponse;
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

interface ReadinessResponse {
  effectiveSpecs: Array<{
    status: string;
    effectiveSpecHash: string;
    commitSha?: string;
  }>;
  currentEffectiveSpec: { effectiveSpecHash: string; commitSha?: string } | null;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("TASK-922: /api/tasks/:id/enrich/approve enrichment.autoCommit", () => {
  let stopServer: (() => Promise<void>) | undefined;
  let logDir: string;
  let cleanupPaths: string[] = [];

  beforeEach(() => {
    mockedRunReadinessGate.mockReset();
    logDir = makeTempDir("quack-enrich-autocommit-log-");
    cleanupPaths = [logDir];
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    for (const p of cleanupPaths) removeTempDir(p);
  });

  async function startServer(projectRoot: string): Promise<number> {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
      taskDir: "docs/tasks",
    });
    const started = await serverObj.start();
    stopServer = started.stop;
    return started.port;
  }

  it("preserves TASK-923 Grounded By bytes through enrichment preview and cached approval", async () => {
    const { projectRoot, taskFile } = setupTempProject({ initGit: true });
    cleanupPaths.push(projectRoot);
    const original = parseTaskFile(fs.readFileSync(taskFile, "utf-8"), taskFile);
    const groundedBy = [
      "## Grounded By",
      "",
      "- Read: src/example.ts (signature: loadExample())",
      "- Grep: 'EXAMPLE_MODE' in src/config/ (environment variable: EXAMPLE_MODE)",
      "- Glob: src/example/*.ts",
      "",
    ].join("\n");
    const enrichedContent = `${SPEC_BODY}\n\n## Enriched Section\nUse loadExample() from src/example.ts.\n\n${groundedBy}`;
    const gateResult: GateResult = {
      outcome: "enriched",
      task: {
        original,
        enriched: {
          ...original,
          rawContent: `Here is the enriched specification:\n\n${enrichedContent}`,
        },
        diff: "fixture enrichment with grounding footer",
        approved: false,
      },
    };
    mockedRunReadinessGate.mockResolvedValue(gateResult);

    const port = await startServer(projectRoot);
    const preview = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-001/enrich`, {
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.body)).toMatchObject({
      outcome: "enriched",
      dryRun: true,
      persisted: false,
      enrichedContent,
    });
    expect(fs.readFileSync(taskFile)).toEqual(Buffer.from(SPEC_BODY, "utf-8"));

    // Omit content so approval must read the proposal stored by the real enrich route.
    const approval = await httpPost(
      `http://127.0.0.1:${port}/api/tasks/TASK-001/enrich/approve`,
      {},
    );
    expect(approval.status).toBe(200);
    expect(JSON.parse(approval.body)).toMatchObject({
      ok: true,
      taskId: "TASK-001",
      filePath: taskFile,
      contentSource: "cache",
    });
    expect(fs.readFileSync(taskFile)).toEqual(Buffer.from(enrichedContent, "utf-8"));
    expect(mockedRunReadinessGate).toHaveBeenCalledTimes(1);
  });

  it("does NOT attempt git operations when autoCommit config is absent (back-compat default)", async () => {
    const { projectRoot } = setupTempProject({ initGit: true });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nNew content.\n`,
    );

    expect(response.ok).toBe(true);
    expect(response.git).toBeUndefined();

    // File written, but the spec file is now dirty (no commit happened).
    const status = git(projectRoot, ["status", "--short"]);
    expect(status.stdout).toMatch(/docs\/tasks\/TASK-001-test\.md/);
  });

  it("does NOT attempt git operations when autoCommit.enabled is false", async () => {
    const { projectRoot } = setupTempProject({ initGit: true, autoCommit: { enabled: false } });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nNew content.\n`,
    );

    expect(response.ok).toBe(true);
    expect(response.git).toBeUndefined();
  });

  it("commits but skips push when autoCommit.enabled=true and push=false (clean tree)", async () => {
    const { projectRoot } = setupTempProject({
      initGit: true,
      initialBranch: "dev",
      autoCommit: {
        enabled: true,
        push: false,
        commitMessageTemplate: "spec(enrich): {taskId} auto-enrich",
      },
    });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nNew content.\n`,
    );

    expect(response.ok).toBe(true);
    expect(response.git).toBeDefined();
    expect(response.git?.attempted).toBe(true);
    expect(response.git?.committed).toBe(true);
    expect(response.git?.pushed).toBe(false);
    expect(response.git?.skippedReason).toBe("push_disabled_by_config");
    expect(response.git?.branch).toBe("dev");
    expect(response.git?.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // The spec file specifically should no longer be dirty (the commit absorbed it).
    // The monitor server creates other runtime artifacts under .quack/ during startup
    // which are expected to be untracked — only the spec file's dirty state matters here.
    const status = git(projectRoot, ["status", "--short", "--", "docs/tasks/TASK-001-test.md"]);
    expect(status.stdout.trim()).toBe("");

    // Commit message follows the template.
    const log = git(projectRoot, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("spec(enrich): TASK-001 auto-enrich");

    // The commit actually contains the spec file change.
    const showFiles = git(projectRoot, ["show", "--name-only", "--pretty=", "HEAD"]);
    expect(showFiles.stdout).toContain("docs/tasks/TASK-001-test.md");
  });

  it("commits but refuses a local-filesystem origin when push=true", async () => {
    const bareRemote = makeTempDir("quack-enrich-autocommit-bare-");
    cleanupPaths.push(bareRemote);
    git(bareRemote, ["init", "--bare", "--initial-branch=dev"]);

    const { projectRoot } = setupTempProject({
      initGit: true,
      initialBranch: "dev",
      bareRemotePath: bareRemote,
      autoCommit: { enabled: true, push: true },
    });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nPushed content.\n`,
    );

    expect(response.git?.attempted).toBe(true);
    expect(response.git?.committed).toBe(true);
    expect(response.git?.pushed).toBe(false);
    expect(response.git?.skippedReason).toBeUndefined();
    expect(response.git?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(response.git?.error).toMatch(/Refusing local or helper-backed Git transport URL/iu);

    // Repository detection and the local commit remain healthy, but the
    // untrusted local transport is never allowed to run receive-side hooks.
    expect(response.git?.skippedReason).not.toBe("not_git_repository");
    expect(git(bareRemote, ["show-ref", "--verify", "refs/heads/dev"]).exitCode).not.toBe(0);
  }, 30_000);

  it("reports skippedReason=protected_branch and does NOT commit when on a skipBranches branch", async () => {
    const { projectRoot, taskFile } = setupTempProject({
      initGit: true,
      initialBranch: "main",
      autoCommit: { enabled: true, push: false, skipBranches: ["main", "production"] },
    });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nProtected branch.\n`,
    );

    expect(response.git?.attempted).toBe(false);
    expect(response.git?.committed).toBe(false);
    expect(response.git?.skippedReason).toBe("protected_branch");
    expect(response.git?.branch).toBe("main");

    // The file was still written even though the commit was skipped.
    const onDisk = fs.readFileSync(taskFile, "utf-8");
    expect(onDisk).toContain("## Enriched Section");
    expect(onDisk).toContain("Protected branch.");
  });

  it("reports skippedReason=preexisting_staged_changes when an unrelated file is staged", async () => {
    const { projectRoot, taskFile } = setupTempProject({
      initGit: true,
      initialBranch: "dev",
      autoCommit: { enabled: true, push: false },
    });
    cleanupPaths.push(projectRoot);

    // Stage an unrelated file before the enrich call.
    const otherFile = path.join(projectRoot, "OTHER.md");
    fs.writeFileSync(otherFile, "unrelated\n", "utf-8");
    git(projectRoot, ["add", "OTHER.md"]);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nDirty tree.\n`,
    );

    expect(response.git?.committed).toBe(false);
    expect(response.git?.skippedReason).toBe("preexisting_staged_changes");

    // The spec file was still written.
    const onDisk = fs.readFileSync(taskFile, "utf-8");
    expect(onDisk).toContain("## Enriched Section");
    expect(onDisk).toContain("Dirty tree.");
  });

  it("refuses approve publication when the checked-out branch is not the configured base branch", async () => {
    const { projectRoot, taskFile } = setupTempProject({
      initGit: true,
      initialBranch: "feature/unsafe",
      baseBranch: "main",
      autoCommit: { enabled: true, push: false, skipBranches: [] },
    });
    cleanupPaths.push(projectRoot);
    const commitsBefore = git(projectRoot, ["rev-list", "--count", "HEAD"]).stdout.trim();

    const port = await startServer(projectRoot);
    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nWrong branch.\n`,
    );

    expect(response.git).toMatchObject({
      attempted: false,
      committed: false,
      pushed: false,
      branch: "feature/unsafe",
      skippedReason: "not_on_canonical_target_branch",
    });
    expect(git(projectRoot, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commitsBefore);
    expect(fs.readFileSync(taskFile, "utf-8")).toContain("Wrong branch.");
  });

  it("refuses auto-enrich publication when the checked-out branch is not the configured base branch", async () => {
    const { projectRoot, taskFile } = setupTempProject({
      initGit: true,
      initialBranch: "feature/unsafe",
      baseBranch: "main",
      autoCommit: { enabled: true, push: false, skipBranches: [] },
    });
    cleanupPaths.push(projectRoot);
    const original = parseTaskFile(fs.readFileSync(taskFile, "utf-8"), taskFile);
    const enrichedContent = `${SPEC_BODY}\n\n## Enriched Section\nWrong branch auto-enrich.\n`;
    const gateResult: GateResult = {
      outcome: "enriched",
      task: {
        original,
        enriched: { ...original, rawContent: enrichedContent },
        diff: "fixture enrichment diff",
        approved: false,
      },
    };
    mockedRunReadinessGate.mockResolvedValue(gateResult);
    const commitsBefore = git(projectRoot, ["rev-list", "--count", "HEAD"]).stdout.trim();

    const port = await startServer(projectRoot);
    const { status, body } = await httpPost(
      `http://127.0.0.1:${port}/api/tasks/TASK-001/enrich`,
      {},
    );
    const response = JSON.parse(body) as { git?: ApproveResponse["git"]; persisted?: boolean };

    expect(status).toBe(200);
    expect(response.persisted).toBe(true);
    expect(response.git).toMatchObject({
      attempted: false,
      committed: false,
      pushed: false,
      branch: "feature/unsafe",
      skippedReason: "not_on_canonical_target_branch",
    });
    expect(git(projectRoot, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commitsBefore);
    expect(fs.readFileSync(taskFile, "utf-8")).toContain("Wrong branch auto-enrich.");
  });

  it("persists commit SHA on the effective_specs DB row (visible via readiness API) when commit succeeded", async () => {
    const { projectRoot } = setupTempProject({
      initGit: true,
      initialBranch: "dev",
      autoCommit: { enabled: true, push: false },
    });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nCommit SHA persisted.\n`,
    );

    expect(response.git?.committed).toBe(true);
    const commitSha = response.git?.commitSha;
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

    // The readiness API surfaces commitSha on the effective-spec summary so
    // future audit queries can correlate enrichments to dev commits.
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/v1/tasks/TASK-001/readiness`);
    expect(status).toBe(200);
    const readiness = JSON.parse(body) as ReadinessResponse;

    expect(readiness.currentEffectiveSpec?.commitSha).toBe(commitSha);
    expect(readiness.effectiveSpecs[0]).toEqual(
      expect.objectContaining({
        status: "accepted",
        effectiveSpecHash: response.effectiveSpecHash,
        commitSha,
      }),
    );
  });

  it("reports skippedReason=not_git_repository when projectRoot is not a git repo", async () => {
    const { projectRoot, taskFile } = setupTempProject({
      initGit: false,
      autoCommit: { enabled: true, push: false },
    });
    cleanupPaths.push(projectRoot);

    const port = await startServer(projectRoot);

    const response = await postEnrichApprove(
      port,
      "TASK-001",
      `${SPEC_BODY}\n\n## Enriched Section\nNo repo.\n`,
    );

    expect(response.git?.attempted).toBe(false);
    expect(response.git?.committed).toBe(false);
    expect(response.git?.skippedReason).toBe("not_git_repository");

    const onDisk = fs.readFileSync(taskFile, "utf-8");
    expect(onDisk).toContain("## Enriched Section");
  });
});
