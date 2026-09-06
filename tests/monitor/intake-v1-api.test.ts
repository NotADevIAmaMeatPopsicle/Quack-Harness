import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-intake-v1-api-"));
}

function writeTaskFile(projectRoot: string, taskId: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = [
    `# ${taskId}: Intake Projection Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Tags:** [api, intake]",
    "",
    "## Problem Statement",
    "Projection fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project intake events.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/intake/task-intake.ts` | Modify | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Projection returns state",
    "",
    "## Testing Requirements",
    "- [ ] API test passes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
}

function writeCcusageCache(projectRoot: string): void {
  const cacheDir = path.join(projectRoot, ".quack", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "ccusage.json"),
    JSON.stringify(
      {
        daily: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0,
          totalTokens: 0,
        },
        lastRefreshedAt: "2026-04-26T12:00:00.000Z",
        lastFetchedDate: "20260426",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 75,
      });
      return;
    } catch {
      await pause(125);
    }
  }
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function httpPost(
  url: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
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
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

describe("v1 intake task API", () => {
  let projectRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-836");

    const port = 43000 + Math.floor(Math.random() * 2000);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port,
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${port}`;
    await pause(150);
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await pause(150);
    await cleanupDir(projectRoot);
  });

  it("creates, classifies, persists, and replays intake records", async () => {
    const payload = {
      taskId: "TASK-836",
      title: "Remote intake task",
      description: "Add deterministic task intake API.",
      source: "slack",
      requestedBy: "echo",
      idempotencyKey: "slack-123",
      priority: "P1-HIGH",
      tags: ["api"],
      files: ["src/intake/task-intake.ts"],
    };

    const created = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(created.status).toBe(201);
    const createdBody = JSON.parse(created.body) as {
      intakeId: string;
      replayed: boolean;
      classification: { lane: string; riskLevel: string; reasons: string[] };
      projection: { state: string; intakeId: string; lane: string };
    };

    expect(createdBody.replayed).toBe(false);
    expect(createdBody.classification).toMatchObject({
      lane: "guarded_auto",
      riskLevel: "medium",
      reasons: ["guarded_code_change"],
    });
    expect(createdBody.projection).toMatchObject({
      state: "classified",
      intakeId: createdBody.intakeId,
      lane: "guarded_auto",
    });
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "intake", `${createdBody.intakeId}.json`)),
    ).toBe(true);

    const fetched = await httpGet(`${baseUrl}/v1/intake/tasks/${createdBody.intakeId}`);
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toMatchObject({
      ok: true,
      intakeId: createdBody.intakeId,
      record: { source: "slack", taskId: "TASK-836" },
    });

    const replayed = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(replayed.status).toBe(200);
    expect(JSON.parse(replayed.body)).toMatchObject({
      replayed: true,
      intakeId: createdBody.intakeId,
    });
  });

  it("validates contributor payloads without persisting intake records", async () => {
    const payload = {
      taskId: "TASK-953",
      title: "Waitlist live-data protocol",
      description: [
        "Run the waitlist live-data protocol against a reachable dev/staging database.",
        "Boot the backend with valid DB env, mint a example-scoped token, seed one waitlist entry,",
        "call matches and near-misses endpoints, then deliberately break provider eligibility.",
      ].join(" "),
      source: "contributor-claude-code",
      requestedBy: "contributor",
      priority: "P1-HIGH",
      tags: ["verification", "backend", "database", "waitlist"],
      files: ["src/src/routes/waitlist.routes.js"],
      metadata: {
        successCriteria: [
          "Match evidence includes real gate checks.",
          "Near-miss evidence explains deliberately broken eligibility.",
        ],
        testingRequirements: [
          "GET /api/waitlist/matches?days=7",
          "GET /api/waitlist/near-misses?days=7",
        ],
        evidenceProtocol: [
          "Seed one appointment waitlist entry.",
          "Clean up seeded rows after verification.",
        ],
      },
    };

    const validated = await httpPost(`${baseUrl}/v1/intake/tasks/validate`, payload);
    expect(validated.status).toBe(200);
    expect(JSON.parse(validated.body)).toMatchObject({
      ok: true,
      valid: true,
      accepted: false,
      dryRun: true,
      classification: {
        lane: "guarded_auto",
        riskLevel: "high",
      },
      assessment: {
        qualityGate: {
          ready: true,
          status: "ready_for_intake",
        },
        suggestedFederationJob: {
          jobType: "verify",
          preferredHostId: "headnode",
        },
      },
    });
    expect(fs.existsSync(path.join(projectRoot, ".quack", "intake"))).toBe(false);
  });

  it("rejects invalid payloads with structured validation details", async () => {
    const resp = await httpPost(`${baseUrl}/v1/intake/tasks`, {
      title: "",
      description: "Missing a usable title.",
    });

    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as {
      error: string;
      details: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBe("invalid_intake_payload");
    expect(body.details.some((detail) => detail.path === "title")).toBe(true);
  });

  // ─── TASK-1106: Validation Intake integration tests ──────────────
  // Each case provisions a real git repo, writes a minimal adapter.json,
  // POSTs a validation-intake bundle, then asserts the wired stack
  // (route → orchestrator → gates → spec gen → IntakeStore) end-to-end.

  function initValidationProject(
    root: string,
    scopeFile: string,
  ): {
    branch: string;
    commitRange: string;
  } {
    // Bare origin + working clone so evidence-gate's `git ls-remote --heads origin`
    // resolves the feature branch after push. Keep origin under .quack/ so the
    // existing cleanupDir(projectRoot) handles teardown — no leaked tmpdirs.
    const originRoot = path.join(root, ".quack", "origin.git");
    fs.mkdirSync(originRoot, { recursive: true });
    execSync("git init -q --bare -b main", { cwd: originRoot, stdio: "ignore" });

    execSync("git init -q -b main", { cwd: root, stdio: "ignore" });
    execSync("git config user.email test@quack.local", { cwd: root, stdio: "ignore" });
    execSync("git config user.name Quack-Test", { cwd: root, stdio: "ignore" });
    execSync("git config commit.gpgsign false", { cwd: root, stdio: "ignore" });
    execSync(`git remote add origin "${originRoot.replace(/\\/g, "/")}"`, {
      cwd: root,
      stdio: "ignore",
    });

    // Base commit on main.
    fs.mkdirSync(path.join(root, path.dirname(scopeFile)), { recursive: true });
    fs.writeFileSync(path.join(root, scopeFile), "// base\n", "utf-8");
    execSync(`git add ${JSON.stringify(scopeFile)}`, { cwd: root, stdio: "ignore" });
    execSync("git commit -q -m base", { cwd: root, stdio: "ignore" });
    execSync("git push -q origin main", { cwd: root, stdio: "ignore" });

    // Feature branch with one additional commit touching the scope file.
    const branch = "feature/intake-validation-it";
    execSync(`git checkout -q -b ${branch}`, { cwd: root, stdio: "ignore" });
    fs.writeFileSync(path.join(root, scopeFile), "// modified\n", "utf-8");
    execSync(`git add ${JSON.stringify(scopeFile)}`, { cwd: root, stdio: "ignore" });
    execSync("git commit -q -m feature-change", { cwd: root, stdio: "ignore" });
    execSync(`git push -q origin ${branch}`, { cwd: root, stdio: "ignore" });

    return { branch, commitRange: "main..HEAD" };
  }

  function writeAdapterJson(
    root: string,
    taskDir: string,
    extras: Record<string, unknown> = {},
  ): void {
    const quackDir = path.join(root, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    const adapter = {
      version: "1.0.0",
      project: {
        name: "demo-validation",
        root: ".",
        taskDir,
        conventionsDir: "docs/conventions",
      },
      verification: {
        commands: [
          {
            name: "noop",
            command: "echo ok",
            required: false,
            timeout: 5_000,
          },
        ],
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: ["src/", "tests/"],
        deniedPaths: [".env"],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {summary}",
        commitTrailer: "Co-authored-by: Quack <quack@local>",
      },
      logging: { dir: ".quack/logs" },
      workerOverlay: {},
      ...extras,
    };
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify(adapter, null, 2),
      "utf-8",
    );
  }

  function makeValidationPayload(overrides: {
    branch: string;
    commitRange: string;
    scopeFile: string;
    project?: string;
    nonClaims?: string[];
  }): Record<string, unknown> {
    return {
      intakeType: "validation",
      schemaVersion: 1,
      project: overrides.project ?? "demo-validation",
      branch: overrides.branch,
      commitRange: overrides.commitRange,
      scope: [overrides.scopeFile],
      tests: [
        {
          name: "tests/sample.test.ts",
          result: "PASS",
          evidence: "logs/sample.txt",
        },
      ],
      screenshots: [],
      nonClaims: overrides.nonClaims ?? ["package-lock.json changes are incidental"],
      knownRisks: [],
      submitter: "tester@quack.local",
      submittedAt: "2026-05-31T13:54:00-04:00",
      // Minimum required fields on the parent remoteTaskIntakeSchema. These
      // coexist on the same body with the validation payload fields.
      title: `Validate ${overrides.branch}`,
      description: "Validation intake integration test.",
      source: "test",
    };
  }

  it("persists a validation intake, runs gates, writes a spec, and returns 201", async () => {
    const scopeFile = "src/web/sample.ts";
    writeAdapterJson(projectRoot, "docs/page-by-page-audit/follow-up-tasks");
    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    const payload = makeValidationPayload({ branch, commitRange, scopeFile });
    const created = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(created.status).toBe(201);

    const body = JSON.parse(created.body) as {
      ok: boolean;
      accepted: boolean;
      replayed: boolean;
      intakeId: string;
      taskId: string;
      status: string;
      intakeType: string;
      specPath: string;
      evidencePath: string;
      handoff: string;
      scopeHygiene: { verdict: string; confirmed: string[] };
      evidence: { verdict: string; deficiencies: string[] };
      driftThreshold: number;
    };

    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.intakeType).toBe("validation");
    expect(body.status).toBe("VERIFYING");
    expect(body.handoff).toBe("admin-verify");
    expect(body.taskId).toMatch(/^TASK-\d+/);
    expect(body.scopeHygiene.verdict).toBe("PASS");
    expect(body.evidence.verdict).toBe("PASS");

    // The persisted intake record exists on disk and reflects intakeType.
    const intakeRecordPath = path.join(projectRoot, ".quack", "intake", `${body.intakeId}.json`);
    expect(fs.existsSync(intakeRecordPath)).toBe(true);
    const persistedRecord = JSON.parse(fs.readFileSync(intakeRecordPath, "utf-8")) as {
      intakeType?: string;
      validationPayload?: { branch?: string };
    };
    expect(persistedRecord.intakeType).toBe("validation");
    expect(persistedRecord.validationPayload?.branch).toBe(branch);

    // The generated spec lives at the adapter-declared taskDir (example-shape).
    expect(body.specPath.replace(/\\/g, "/")).toContain("docs/page-by-page-audit/follow-up-tasks/");
    expect(fs.existsSync(body.specPath)).toBe(true);
    const specBody = fs.readFileSync(body.specPath, "utf-8");
    expect(specBody).toContain("Intake Type:** validation");
    expect(specBody).toContain(branch);

    // The evidence directory was created under .quack/intake/<intakeId>/evidence/.
    expect(fs.existsSync(body.evidencePath)).toBe(true);
  }, 30000);

  it("rejects a validation intake with empty nonClaims as 422 REVISE", async () => {
    const scopeFile = "src/web/sample.ts";
    writeAdapterJson(projectRoot, "docs/tasks");
    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    const payload = makeValidationPayload({
      branch,
      commitRange,
      scopeFile,
      nonClaims: [],
    });
    const resp = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(resp.status).toBe(422);
    const body = JSON.parse(resp.body) as {
      ok: boolean;
      reason: string;
      deficiencies: string[];
      evidence: { verdict: string; deficiencies: string[] };
    };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("validation-intake-revise");
    expect(body.deficiencies.some((d) => /nonClaims/i.test(d))).toBe(true);
    expect(body.evidence.verdict).toBe("REVISE");
  }, 30000);

  // ─── TASK-1106 Blueprint §9 Case 1 / SC1 ────────────────────────────
  // POST /v1/intake/tasks/validate with intakeType="validation" must
  // return dry-run gate results (PASS) without persisting anything.
  // Validation dry-run intentionally does NOT allocate a taskId — that
  // happens only on the persist path (per blueprint §3 spec-generator
  // section + routes/intake.ts L201-211 response shape).
  it("TASK-1106 §9 Case 1 / SC1: validates a validation-intake dry-run without persisting", async () => {
    const scopeFile = "src/web/sample.ts";
    writeAdapterJson(projectRoot, "docs/tasks");
    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    const payload = makeValidationPayload({ branch, commitRange, scopeFile });

    const validated = await httpPost(`${baseUrl}/v1/intake/tasks/validate`, payload);
    expect(validated.status).toBe(200);

    const body = JSON.parse(validated.body) as {
      ok: boolean;
      valid: boolean;
      accepted: boolean;
      dryRun: boolean;
      intakeType: string;
      verdict: string;
      scopeHygiene: {
        verdict: string;
        confirmed: string[];
        claimed_but_unchanged: string[];
        changed_but_unclaimed: string[];
        driftThreshold: number;
        reasons: string[];
      };
      evidence: { verdict: string; deficiencies: string[] };
      driftThreshold: number;
    };

    // Dry-run contract: scope-hygiene result, evidence result, drift-
    // threshold, and the dryRun flag all surface in the response. The
    // validation dry-run intentionally does not return a would-be taskId
    // (taskId allocation is the persist-path's job, not the gates').
    expect(body.ok).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.accepted).toBe(false);
    expect(body.dryRun).toBe(true);
    expect(body.intakeType).toBe("validation");
    expect(body.verdict).toBe("PASS");
    expect(body.scopeHygiene.verdict).toBe("PASS");
    expect(body.scopeHygiene.confirmed).toContain(scopeFile);
    expect(typeof body.driftThreshold).toBe("number");
    expect(body.evidence.verdict).toBe("PASS");

    // No persistence side-effects from the dry-run call: no IntakeStore
    // record, no new validation-intake spec under the adapter taskDir,
    // no row in verified.json. The fixture leaves `TASK-836-fixture.md`
    // under docs/tasks from beforeEach setup — assert ONLY that the
    // dry-run did not append a new TASK-NNNN-*.md from the validation
    // path. verified.json may exist as an empty projection seeded by
    // server startup; the contract is that no validation-intake row
    // was appended.
    expect(fs.existsSync(path.join(projectRoot, ".quack", "intake"))).toBe(false);
    const taskDirContents = fs.readdirSync(path.join(projectRoot, "docs", "tasks"));
    // The only entry should be the fixture file from beforeEach setup.
    expect(taskDirContents).toEqual(["TASK-836-fixture.md"]);
    const verifiedJsonPath = path.join(projectRoot, ".quack", "verified.json");
    if (fs.existsSync(verifiedJsonPath)) {
      const ledger = JSON.parse(fs.readFileSync(verifiedJsonPath, "utf-8")) as {
        tasks?: Record<string, unknown>;
      };
      // Dry-run must not have appended any row; an empty ledger is fine.
      expect(Object.keys(ledger.tasks ?? {})).toEqual([]);
    }
  }, 30000);

  // ─── TASK-1106 Blueprint §9 Case 4 / SC15 ───────────────────────────
  // Idempotency: re-POST with identical (project, branch, commitRange)
  // tuple returns 200 + replayed:true + same taskId. The natural-key
  // derivation is sha256("validation:<project>:<branch>:<commitRange>")
  // .slice(0, 16) (see routes/intake.ts::deriveValidationIdempotencyKey).
  it("TASK-1106 §9 Case 4 / SC15: replays a validation-intake persist with the natural-key idempotency", async () => {
    const scopeFile = "src/web/sample.ts";
    writeAdapterJson(projectRoot, "docs/page-by-page-audit/follow-up-tasks");
    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    const payload = makeValidationPayload({ branch, commitRange, scopeFile });

    const first = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(first.status).toBe(201);
    const firstBody = JSON.parse(first.body) as {
      accepted: boolean;
      replayed: boolean;
      intakeId: string;
      taskId: string;
      specPath: string;
    };
    expect(firstBody.accepted).toBe(true);
    expect(firstBody.replayed).toBe(false);

    // Replay: identical body, identical (project, branch, commitRange) →
    // same idempotencyKey → same intakeId → same taskId. Status flips
    // 201→200 and accepted flips true→false to match the existing
    // IntakeStore.create() replay contract.
    const second = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(second.status).toBe(200);
    const secondBody = JSON.parse(second.body) as {
      accepted: boolean;
      replayed: boolean;
      intakeId: string;
      taskId: string;
      specPath: string;
    };
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.accepted).toBe(false);
    expect(secondBody.intakeId).toBe(firstBody.intakeId);
    expect(secondBody.taskId).toBe(firstBody.taskId);

    // The IntakeStore key derivation lives at routes/intake.ts
    // deriveValidationIdempotencyKey: sha256(seed).slice(0,16), where
    // seed = `validation:${project}:${branch}:${commitRange}`. The
    // resulting `intakeId` is `intake-<sha256(idempotencyKey).slice(0,16)>`
    // (see intake-store.ts::intakeIdFor). We verify the chain by
    // recomputing the derived key + intakeId and asserting both layers
    // match the persisted record.
    const seed = `validation:demo-validation:${branch}:${commitRange}`;
    const idempotencyKey = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
    const expectedIntakeId = `intake-${crypto
      .createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 16)}`;
    expect(firstBody.intakeId).toBe(expectedIntakeId);

    // The persisted record carries the idempotencyKey field — sanity
    // check the natural-key derivation made it into the record.
    const intakeRecordPath = path.join(
      projectRoot,
      ".quack",
      "intake",
      `${firstBody.intakeId}.json`,
    );
    const persisted = JSON.parse(fs.readFileSync(intakeRecordPath, "utf-8")) as {
      idempotencyKey?: string;
    };
    expect(persisted.idempotencyKey).toBe(idempotencyKey);
  }, 30000);

  // ─── TASK-1106 Blueprint §9 Case 6 / SC6 ────────────────────────────
  // Scope-drift integration: when the diff touches > driftThreshold files
  // outside the claimed scope AND nonClaims is empty, the gate REVISEs
  // with the three-set scope-hygiene structure and the canonical reason
  // string "scope_drift_without_nonclaims" (see scope-hygiene-gate.ts).
  it("TASK-1106 §9 Case 6 / SC6: rejects scope drift above threshold without nonClaims (422 REVISE)", async () => {
    const scopeFile = "src/web/sample.ts";
    writeAdapterJson(projectRoot, "docs/tasks");

    // Initialize the project. Then add an extra commit on the feature
    // branch that touches 7 additional files outside the claimed scope.
    // With default driftThreshold=5, this trips the
    // `changed_but_unclaimed.length > driftThreshold` rule. nonClaims
    // is empty so the suppression rule does not apply.
    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    // Add 7 unclaimed-touched files on the feature branch.
    const unclaimedFiles = [
      "src/extra/a.ts",
      "src/extra/b.ts",
      "src/extra/c.ts",
      "src/extra/d.ts",
      "src/extra/e.ts",
      "src/extra/f.ts",
      "src/extra/g.ts",
    ];
    fs.mkdirSync(path.join(projectRoot, "src", "extra"), { recursive: true });
    for (const f of unclaimedFiles) {
      fs.writeFileSync(path.join(projectRoot, f), "// extra\n", "utf-8");
    }
    execSync("git add src/extra/", { cwd: projectRoot, stdio: "ignore" });
    execSync('git commit -q -m "drift commit"', { cwd: projectRoot, stdio: "ignore" });
    execSync(`git push -q origin ${branch}`, { cwd: projectRoot, stdio: "ignore" });

    // Build a payload with nonClaims = [] — the non-bypass would also
    // REVISE the evidence gate independently, which is fine: this case
    // asserts that the scope-hygiene "drift_without_nonclaims" reason
    // is the canonical string surfaced, even when the evidence gate is
    // also unhappy. The combined deficiencies list captures both.
    const payload = makeValidationPayload({
      branch,
      commitRange,
      scopeFile,
      nonClaims: [],
    });
    const resp = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(resp.status).toBe(422);

    const body = JSON.parse(resp.body) as {
      ok: boolean;
      reason: string;
      deficiencies: string[];
      scopeHygiene: {
        verdict: string;
        confirmed: string[];
        claimed_but_unchanged: string[];
        changed_but_unclaimed: string[];
        driftThreshold: number;
        reasons: string[];
      };
      evidence: { verdict: string };
      driftThreshold: number;
    };

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("validation-intake-revise");
    // SC6 contract: response surfaces all three sets + threshold.
    expect(body.scopeHygiene.verdict).toBe("REVISE");
    expect(body.scopeHygiene.confirmed).toEqual(expect.arrayContaining([scopeFile]));
    expect(body.scopeHygiene.claimed_but_unchanged).toEqual([]);
    expect(body.scopeHygiene.changed_but_unclaimed.length).toBeGreaterThan(
      body.scopeHygiene.driftThreshold,
    );
    // All 7 extra files end up in changed_but_unclaimed (they are NOT
    // in scope and NOT in nonClaims).
    for (const f of unclaimedFiles) {
      expect(body.scopeHygiene.changed_but_unclaimed).toContain(f);
    }
    // Canonical reason string from scope-hygiene-gate.ts L144.
    expect(body.scopeHygiene.reasons).toContain("scope_drift_without_nonclaims");
    // Default driftThreshold is 5 (no adapter override on this project).
    expect(body.driftThreshold).toBe(5);
    expect(body.scopeHygiene.driftThreshold).toBe(5);
  }, 30000);

  // ─── TASK-1106 Blueprint §9 Case 9 / SC6 ────────────────────────────
  // Adapter driftThreshold override flows end-to-end through
  // loadAdapter → orchestrator → gate. Setting driftThreshold=2 in
  // .quack/adapter.json must cause a payload with 3 unclaimed touched
  // files to REVISE, even though the same payload would PASS at the
  // default threshold of 5.
  it("TASK-1106 §9 Case 9 / SC6: respects adapter.validationIntake.driftThreshold override end-to-end", async () => {
    const scopeFile = "src/web/sample.ts";

    // Write an adapter.json with driftThreshold: 2 BEFORE git-initing.
    // Uses the shared helper so the verification.commands + git fields
    // match the strict adapter schema's required shape.
    writeAdapterJson(projectRoot, "docs/tasks", {
      validationIntake: { driftThreshold: 2 },
    });

    const { branch, commitRange } = initValidationProject(projectRoot, scopeFile);

    // Add 3 unclaimed files — exceeds override (2) but well below
    // default (5), so this is the load-bearing case for the override.
    const unclaimedFiles = ["src/extra/a.ts", "src/extra/b.ts", "src/extra/c.ts"];
    fs.mkdirSync(path.join(projectRoot, "src", "extra"), { recursive: true });
    for (const f of unclaimedFiles) {
      fs.writeFileSync(path.join(projectRoot, f), "// extra\n", "utf-8");
    }
    execSync("git add src/extra/", { cwd: projectRoot, stdio: "ignore" });
    execSync('git commit -q -m "below-default-drift"', {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execSync(`git push -q origin ${branch}`, { cwd: projectRoot, stdio: "ignore" });

    // nonClaims=[] so the suppression rule does not apply. Without the
    // override, 3 unclaimed files would PASS (3 < default 5). With the
    // override, 3 > 2 → REVISE. Hits the override-respected contract.
    const payload = makeValidationPayload({
      branch,
      commitRange,
      scopeFile,
      nonClaims: [],
    });
    const resp = await httpPost(`${baseUrl}/v1/intake/tasks`, payload);
    expect(resp.status).toBe(422);

    const body = JSON.parse(resp.body) as {
      reason: string;
      scopeHygiene: {
        verdict: string;
        changed_but_unclaimed: string[];
        driftThreshold: number;
        reasons: string[];
      };
      driftThreshold: number;
    };
    expect(body.reason).toBe("validation-intake-revise");
    // The override flowed all the way to the gate's threshold.
    expect(body.driftThreshold).toBe(2);
    expect(body.scopeHygiene.driftThreshold).toBe(2);
    // And the gate REVISEd specifically on drift-without-nonclaims at
    // the override threshold.
    expect(body.scopeHygiene.verdict).toBe("REVISE");
    expect(body.scopeHygiene.reasons).toContain("scope_drift_without_nonclaims");
    expect(body.scopeHygiene.changed_but_unclaimed.length).toBe(3);
  }, 30000);

  // ─── TASK-1106 Blueprint §9 Case 8 / SC9 ────────────────────────────
  // Non-bypass guard: a POST /api/tasks/:id/verified with
  // method="validation-intake", verdict="VERIFIED", and NO reviewId
  // must be rejected with 409 review_required. The guard lives at
  // server.ts:3303-3308 (the OR chain that adds
  // `|| method === "validation-intake"` to the require-review set).
  // No row may be written to the verified table.
  it("TASK-1106 §9 Case 8 / SC9: refuses VERIFIED writes with method=validation-intake when reviewId is missing", async () => {
    const taskId = "TASK-1106";

    const resp = await httpPost(`${baseUrl}/api/tasks/${taskId}/verified`, {
      verdict: "VERIFIED",
      method: "validation-intake",
      commit: "deadbeefcafef00d",
    });

    // The guard short-circuits with 409 review_required.
    expect(resp.status).toBe(409);
    const body = JSON.parse(resp.body) as {
      error: string;
      message: string;
      taskId: string;
      method: string;
    };
    expect(body.error).toBe("review_required");
    expect(body.taskId).toBe(taskId);
    expect(body.method).toBe("validation-intake");

    // No row was written: neither the per-project .quack/verified.json
    // ledger NOR a verified row visible via the per-task GET endpoint.
    const verifiedJsonPath = path.join(projectRoot, ".quack", "verified.json");
    // Either the file was never created (most likely) OR it exists with
    // no entry for this taskId.
    if (fs.existsSync(verifiedJsonPath)) {
      const ledger = JSON.parse(fs.readFileSync(verifiedJsonPath, "utf-8")) as {
        tasks?: Record<string, unknown>;
      };
      expect(ledger.tasks?.[taskId]).toBeUndefined();
    }
  }, 30000);

  it("routes intake records and exposes routed state through workflow projection", async () => {
    const created = await httpPost(`${baseUrl}/v1/intake/tasks`, {
      taskId: "TASK-836",
      title: "Host deployment follow-up",
      description: "Deployment should be operator-routed.",
      source: "remote",
      idempotencyKey: "route-123",
      priority: "P1-HIGH",
      tags: ["api"],
      files: ["src/intake/intake-store.ts"],
    });
    const createdBody = JSON.parse(created.body) as { intakeId: string };

    const routed = await httpPost(`${baseUrl}/v1/intake/tasks/${createdBody.intakeId}/route`, {
      lane: "human_required",
      riskLevel: "high",
      actor: "operator",
      reason: "Requires host deployment.",
      reasons: ["operator_route"],
      metadata: { host: "headnode" },
    });

    expect(routed.status).toBe(200);
    expect(JSON.parse(routed.body)).toMatchObject({
      route: {
        lane: "human_required",
        riskLevel: "high",
        actor: "operator",
      },
      projection: {
        state: "routed",
        lane: "human_required",
        riskLevel: "high",
        intakeId: createdBody.intakeId,
      },
    });

    const projection = await httpGet(`${baseUrl}/v1/tasks/TASK-836/workflow-state`);
    expect(projection.status).toBe(200);
    expect(JSON.parse(projection.body)).toMatchObject({
      state: "routed",
      lane: "human_required",
      riskLevel: "high",
      intakeId: createdBody.intakeId,
    });
  });
});
