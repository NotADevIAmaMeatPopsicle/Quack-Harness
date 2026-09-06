import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { generateValidationSpec } from "../../src/intake/validation-spec-generator.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ValidationIntakePayload } from "../../src/intake/task-intake.js";

// ─── Test fixtures ──────────────────────────────────────────────────

function basePayload(overrides: Partial<ValidationIntakePayload> = {}): ValidationIntakePayload {
  return {
    schemaVersion: 1,
    project: "example-service",
    branch: "feature/client-detail-view-polish",
    commitRange: "origin/dev..HEAD",
    scope: ["src/web/pages/ClientDetailView.tsx", "src/api/clients/get-client.ts"],
    tests: [
      {
        name: "tests/web/pages/ClientDetailView.test.tsx",
        result: "PASS",
        evidence: "logs/2026-05-31-vitest-run.txt",
      },
    ],
    screenshots: [
      {
        file: "docs/handoffs/2026-05-31/client-detail-after.png",
        caption: "Client detail view with billing tab focused after fix",
      },
    ],
    nonClaims: [
      "package-lock.json changes are incidental npm refresh",
      "Auth refactor is NOT touched by this branch",
    ],
    knownRisks: ["Bedrock client cache not invalidated on this path"],
    submitter: "contributor@example.test",
    submittedAt: "2026-05-31T13:54:00-04:00",
    ...overrides,
  };
}

function buildAdapter(
  projectRoot: string,
  overrides: Partial<ProjectAdapter["config"]["project"]> = {},
): ProjectAdapter {
  return {
    projectRoot,
    config: {
      version: "1.0.0",
      project: {
        name: "example-service",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
        ...overrides,
      },
      agent: {
        model: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 30,
        maxBudgetPerTask: 5.0,
        maxRetries: 2,
      },
      verification: {
        commands: [],
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: [],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoCreatePr: true,
        autoPush: true,
      },
      logging: {
        dir: ".quack/logs",
        level: "info",
        retainDays: 30,
      },
    },
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "sha256:test",
      normalizedConfig: {} as ProjectAdapter["config"],
      machineLocalFields: [],
    },
  };
}

async function mkTmpProject(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "quack-validation-spec-gen-"));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("generateValidationSpec", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkTmpProject();
  });

  afterEach(async () => {
    await cleanup(projectRoot);
  });

  it("places the generated spec under the Quack-shape adapter task dir", async () => {
    const adapter = buildAdapter(projectRoot, { taskDir: "docs/tasks" });
    const intakeId = "intake-test0000000000001";

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload: basePayload(),
    });

    expect(result.taskId).toMatch(/^TASK-\d{4}$/);
    expect(result.specPath.startsWith(path.join(projectRoot, "docs", "tasks"))).toBe(true);

    const stat = await fs.stat(result.specPath);
    expect(stat.isFile()).toBe(true);
  });

  it("places the generated spec under the example-shape adapter task dir", async () => {
    const adapter = buildAdapter(projectRoot, {
      taskDir: "docs/page-by-page-audit/follow-up-tasks",
    });
    const intakeId = "intake-test0000000000002";

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload: basePayload(),
    });

    const expectedDir = path.join(projectRoot, "docs", "page-by-page-audit", "follow-up-tasks");
    expect(result.specPath.startsWith(expectedDir)).toBe(true);

    const stat = await fs.stat(result.specPath);
    expect(stat.isFile()).toBe(true);
  });

  it("writes Intake Type: validation in the generated spec metadata", async () => {
    const adapter = buildAdapter(projectRoot);
    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000003",
      payload: basePayload(),
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("## Metadata");
    expect(content).toContain("**Intake Type:** validation");
    expect(content).toContain("**Status:** VERIFYING");
    expect(content).toContain("**Schema Version:** 1");
    expect(content).toContain("**Submitter:** contributor@example.test");
  });

  it("renders Already Built with branch, commitRange, and scope verbatim", async () => {
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload();
    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000004",
      payload,
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("## Already Built");
    expect(content).toContain("`feature/client-detail-view-polish`");
    expect(content).toContain("`origin/dev..HEAD`");
    expect(content).toContain("`src/web/pages/ClientDetailView.tsx`");
    expect(content).toContain("`src/api/clients/get-client.ts`");
  });

  it("renders What This Task Validates checklist derived from scope and tests", async () => {
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload();
    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000005",
      payload,
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("## What This Task Validates");
    // Each scope file should appear as a checklist item.
    for (const file of payload.scope) {
      expect(content).toContain(`\`${file}\` — changes match the submitted scope`);
    }
    // Each test should appear as a checklist item with its result.
    for (const test of payload.tests) {
      expect(content).toContain(`Test \`${test.name}\``);
      expect(content).toContain(`result \`${test.result}\``);
    }
  });

  it("renders Evidence Bundle with each evidence path surfaced", async () => {
    const adapter = buildAdapter(projectRoot);

    // Provide real source files so the generator's "copied" path fires.
    const logRel = "logs/2026-05-31-vitest-run.txt";
    const shotRel = "docs/handoffs/2026-05-31/client-detail-after.png";
    await fs.mkdir(path.join(projectRoot, path.dirname(logRel)), {
      recursive: true,
    });
    await fs.writeFile(path.join(projectRoot, logRel), "vitest log");
    await fs.mkdir(path.join(projectRoot, path.dirname(shotRel)), {
      recursive: true,
    });
    await fs.writeFile(path.join(projectRoot, shotRel), "png bytes");

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000006",
      payload: basePayload(),
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("## Evidence Bundle");
    expect(content).toContain("| Category | Reference | Destination | Status |");
    expect(content).toContain("`logs/2026-05-31-vitest-run.txt`");
    expect(content).toContain("`docs/handoffs/2026-05-31/client-detail-after.png`");
    expect(content).toContain("copied");
  });

  it("allocates the next free TASK-NNNN id by scanning the task dir", async () => {
    const adapter = buildAdapter(projectRoot);
    const taskDirAbs = path.join(projectRoot, "docs", "tasks");
    await fs.mkdir(taskDirAbs, { recursive: true });
    // Existing high-water mark: TASK-1108 sits in the dir.
    await fs.writeFile(path.join(taskDirAbs, "TASK-1108-prior.md"), "# TASK-1108: prior\n");

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000007",
      payload: basePayload(),
    });

    expect(result.taskId).toBe("TASK-1109");
    expect(result.specPath).toContain("TASK-1109");
  });

  it("is idempotent — same payload returns the same taskId and spec path", async () => {
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload();
    const intakeId = "intake-test0000000000008";

    const first = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload,
    });
    const second = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload,
    });

    expect(second.taskId).toBe(first.taskId);
    expect(second.specPath).toBe(first.specPath);

    // No duplicate spec file under the task dir.
    const entries = await fs.readdir(path.join(projectRoot, "docs", "tasks"));
    const taskFiles = entries.filter((e) => e.startsWith(first.taskId));
    expect(taskFiles).toHaveLength(1);
  });

  it("copies referenced evidence files to .quack/intake/<intakeId>/evidence/", async () => {
    const adapter = buildAdapter(projectRoot);

    // Provide concrete source files for both test evidence + screenshot.
    const logRel = "logs/vitest.txt";
    const shotRel = "docs/screen.png";
    await fs.mkdir(path.join(projectRoot, "logs"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, logRel), "log content");
    await fs.writeFile(path.join(projectRoot, shotRel), "png bytes");

    const payload = basePayload({
      tests: [{ name: "tests/foo.test.ts", result: "PASS", evidence: logRel }],
      screenshots: [{ file: shotRel, caption: "Screen capture" }],
    });

    const intakeId = "intake-test0000000000009";
    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload,
    });

    const expectedEvidenceDir = path.join(projectRoot, ".quack", "intake", intakeId, "evidence");
    expect(result.evidencePath).toBe(expectedEvidenceDir);

    const evidenceEntries = await fs.readdir(expectedEvidenceDir);
    expect(evidenceEntries.length).toBeGreaterThanOrEqual(2);
    // Files should be flattened (path separators replaced with __).
    expect(evidenceEntries.some((name) => name.endsWith("vitest.txt"))).toBe(true);
    expect(evidenceEntries.some((name) => name.endsWith("screen.png"))).toBe(true);
  });

  it("records url-shaped evidence references verbatim without copying", async () => {
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload({
      tests: [
        {
          name: "CI run #4271",
          result: "PASS",
          evidence: "https://example.com/ci/run/4271",
        },
      ],
      screenshots: [
        {
          file: "https://example.com/handoffs/abc.png",
          caption: "remote",
        },
      ],
    });

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000010",
      payload,
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("https://example.com/ci/run/4271");
    expect(content).toContain("url-skipped");

    // Evidence dir is created but no files are copied for URL refs.
    const evidenceEntries = await fs.readdir(result.evidencePath);
    expect(evidenceEntries).toHaveLength(0);
  });

  it("renders Non-Claims and Known Risks sections verbatim", async () => {
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload({
      nonClaims: ["A nonclaim about package-lock.json", "Auth not touched"],
      knownRisks: ["Cache invalidation latency", "Mobile viewport untested"],
    });

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000011",
      payload,
    });

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("## Non-Claims");
    expect(content).toContain("- A nonclaim about package-lock.json");
    expect(content).toContain("- Auth not touched");
    expect(content).toContain("## Known Risks");
    expect(content).toContain("- Cache invalidation latency");
    expect(content).toContain("- Mobile viewport untested");
  });

  it("throws when the adapter task dir is empty/blank", async () => {
    const adapter = buildAdapter(projectRoot, { taskDir: "   " });

    await expect(
      generateValidationSpec({
        projectRoot,
        adapter,
        intakeId: "intake-test0000000000012",
        payload: basePayload(),
      }),
    ).rejects.toThrow(/taskDir/);
  });

  it("creates the evidence directory even when no evidence files exist on disk", async () => {
    const adapter = buildAdapter(projectRoot);
    const intakeId = "intake-test0000000000013";

    // Payload references nonexistent files; copies should be recorded as
    // missing-source but the directory must still exist.
    const payload = basePayload({
      tests: [
        {
          name: "tests/missing.test.ts",
          result: "PASS",
          evidence: "logs/never-existed.txt",
        },
      ],
      screenshots: [],
    });

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload,
    });

    const stat = await fs.stat(result.evidencePath);
    expect(stat.isDirectory()).toBe(true);

    const content = await fs.readFile(result.specPath, "utf-8");
    expect(content).toContain("missing-source");
  });

  it("releases the .plan.lock and cleans tmp artifacts on a successful write", async () => {
    // Happy-path cleanup contract (mirrors task-writer.ts:184-194):
    //  - tmp files removed,
    //  - .plan.lock released,
    //  - taskDir contains exactly the final TASK-NNNN-*.md.
    const adapter = buildAdapter(projectRoot);
    const taskDir = path.join(projectRoot, "docs", "tasks");
    const payload = basePayload();
    const intakeId = "intake-test0000000000014";

    const result = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId,
      payload,
    });
    expect(await fs.stat(result.specPath)).toBeDefined();

    const entries = await fs.readdir(taskDir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    await expect(fs.stat(path.join(taskDir, ".plan.lock"))).rejects.toThrow();
  });

  it("returns the existing taskId on idempotent replay even when re-run with a different intakeId", async () => {
    // The natural idempotency key is the (project, branch, commitRange)
    // fingerprint embedded in the spec metadata, NOT the intakeId. Two
    // submissions of the same submission shape with different intakeIds
    // must resolve to the same taskId.
    const adapter = buildAdapter(projectRoot);
    const payload = basePayload();

    const first = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000015a",
      payload,
    });
    const second = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000015b",
      payload,
    });

    expect(second.taskId).toBe(first.taskId);
    expect(second.specPath).toBe(first.specPath);
    // Different intakeIds should produce different evidence dirs, however.
    expect(second.evidencePath).not.toBe(first.evidencePath);
  });

  it("derives a different taskId when project, branch, or commitRange differ", async () => {
    // The fingerprint changes ⇒ the idempotency-by-fingerprint scan
    // misses ⇒ a new TASK-NNNN id is allocated.
    const adapter = buildAdapter(projectRoot);

    const first = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000016a",
      payload: basePayload({ branch: "feature/branch-a" }),
    });
    const second = await generateValidationSpec({
      projectRoot,
      adapter,
      intakeId: "intake-test0000000000016b",
      payload: basePayload({ branch: "feature/branch-b" }),
    });

    expect(second.taskId).not.toBe(first.taskId);
    expect(second.specPath).not.toBe(first.specPath);
  });
});
