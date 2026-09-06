// ─── TASK-1306: cache-hit dispatch → approval gate integration ──────
// REAL dispatcher path, no jest.mocks: a seeded preflight cache with a
// STRUCTURED blueprint must reach the approval gate with real counts and
// persist the real object in the approval file. Returns at the gate
// (awaiting_approval) BEFORE branch creation and before any SDK call, so
// this needs no git remote and no network. The legacy case (no structured)
// preserves today's behavior: the gate auto-approves the empty stub.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchTask } from "../../src/dispatcher/dispatcher";
import { _setQueryFn } from "../../src/blueprint/blueprint-agent";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { computeContentHash } from "../../src/monitor/prep-cache";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import type { BlueprintApproval } from "../../src/dispatcher/blueprint-approval";

jest.setTimeout(30_000);

const TASK_ID = "TASK-810";

const SPEC = `# ${TASK_ID}: Cached gate integration fixture

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 1-2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** fixture

## Problem Statement

Integration fixture for the cached-blueprint approval gate path.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/a.ts | Modify | first |
| src/b.ts | Modify | second |
| src/c.ts | Modify | third |

## Success Criteria
- [ ] The gate sees real counts

## Testing Requirements
- [ ] None (fixture)

## Anti-Patterns
- None
`;

const STRUCTURED: Blueprint = {
  taskId: TASK_ID,
  fileAnalyses: ["src/a.ts", "src/b.ts", "src/c.ts"].map((filePath) => ({
    filePath,
    action: "Modify" as const,
    currentStructure: "structure",
    integrationPoints: "points",
    patternToFollow: "pattern",
  })),
  codeExamples: [],
  verificationPatterns: [
    {
      criterion: "The gate sees real counts",
      checkType: "grep",
      pattern: "realCounts",
      fileGlob: "src/*.ts",
    },
  ],
  antiPatterns: [],
  preconditions: [],
  briefSchemaVersion: 1,
  generatedAt: "2026-07-15T00:00:00.000Z",
};

function makePreflight(structured: Blueprint | undefined, contentHash: string): PreflightResult {
  return {
    taskId: TASK_ID,
    timestamp: "2026-07-15T00:00:00.000Z",
    contentHash,
    gate: { ready: true, score: 5, dimensions: {} },
    blueprint: {
      fileAnalyses: structured ? structured.fileAnalyses.length : 3,
      codeExamples: 0,
      verificationPatterns: 1,
      antiPatterns: 0,
      formattedMarkdown: "## Implementation Blueprint\n\ncached content",
      ...(structured ? { structured } : {}),
    },
    contextEstimate: {
      taskSpec: 100,
      blueprint: 100,
      repoMap: 0,
      relevantFiles: 0,
      relatedPatterns: 0,
      existingTests: 0,
      conventions: 0,
      claudeMd: 0,
      total: 200,
      withinBudget: true,
    },
    complexity: {
      filesToModify: 3,
      successCriteria: 1,
      estimatedContextTokens: 200,
      independentFeatures: 1,
      featureClusters: [],
      recommendDecomposition: false,
      reason: "",
    },
  };
}

async function makeProject(
  structured: Blueprint | undefined,
  executionMode?: "loop",
): Promise<{
  tmpDir: string;
  adapter: ProjectAdapter;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-cached-gate-"));

  const taskDir = path.join(tmpDir, "docs", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, `${TASK_ID}.md`), SPEC, "utf-8");

  const prepDir = path.join(tmpDir, ".quack", "prep");
  await fs.mkdir(prepDir, { recursive: true });
  const contentHash = computeContentHash(SPEC);
  await fs.writeFile(
    path.join(prepDir, `${TASK_ID}-preflight.json`),
    JSON.stringify(makePreflight(structured, contentHash), null, 2),
    "utf-8",
  );

  const config = AdapterConfigSchema.parse({
    version: "1.0",
    // Loop mode fail-closes without a loop block (dispatcher.ts guard);
    // the schema defaults fill in the reviewers. The QPI-043 test's
    // early-return path never reaches evaluateLoopReview, so no real
    // reviewer runs.
    ...(executionMode ? { executionMode, loop: { briefReview: {}, diffReview: {} } } : {}),
    project: {
      name: "cached-gate-fixture",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    verification: {
      commands: [{ name: "noop", command: "echo ok", required: false, timeout: 1000 }],
    },
    git: {
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
    },
    logging: { dir: ".quack/logs" },
    preflight: {
      blueprintApproval: {
        enabled: true,
        autoApproveWhen: {
          maxFiles: 1, // 3 structured analyses EXCEED this → human approval
          maxCriteria: 5,
          minBlueprintScore: 0,
          requireDecomposition: false,
        },
      },
    },
  });

  const adapter: ProjectAdapter = {
    projectRoot: tmpDir,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    config,
    adapterBundle: {
      authority: "local",
      sharedHash: "cached-gate-test-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };

  return { tmpDir, adapter };
}

describe("cache-hit dispatch reaches the approval gate with real content (TASK-1306)", () => {
  const tmpDirs: string[] = [];

  beforeAll(() => {
    // Safety net: if the cache seed ever misses, the blueprint agent must not
    // make a real SDK call — an empty generator falls back to the minimal
    // blueprint and the assertions below fail loudly instead.
    _setQueryFn(() =>
      (async function* (): AsyncGenerator<{ type: string }, void> {
        yield await Promise.resolve({ type: "system" });
      })(),
    );
  });

  afterAll(async () => {
    _setQueryFn(undefined);
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("pauses at the gate with real counts and persists the REAL object in the approval file", async () => {
    const { tmpDir, adapter } = await makeProject(STRUCTURED);
    tmpDirs.push(tmpDir);

    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const result = await dispatchTask(TASK_ID, adapter, {
      skipGate: true,
      disableEvents: true,
      onEvent: (stage, payload) => events.push({ stage, payload }),
    });

    expect(result.outcome).toBe("awaiting_approval");

    // the cached blueprint_generated event reports real counts + structured flag
    const generated = events.find((e) => e.stage === "blueprint_generated");
    expect(generated).toBeDefined();
    expect(generated!.payload.cached).toBe(true);
    expect(generated!.payload.structured).toBe(true);
    expect(generated!.payload.fileAnalyses).toBe(3);

    // the approval file persists the REAL object — the dashboard shows a real plan
    const approvalRaw = await fs.readFile(
      path.join(tmpDir, ".quack", "logs", "approvals", `${TASK_ID}.json`),
      "utf-8",
    );
    const approval = JSON.parse(approvalRaw) as BlueprintApproval;
    expect(approval.state).toBe("pending");
    expect(approval.blueprint.fileAnalyses).toHaveLength(3);
    expect(approval.blueprint.verificationPatterns).toHaveLength(1);
    expect(approval.blueprint.briefSchemaVersion).toBe(1);
  });

  it("legacy cache (no structured) keeps today's behavior: the stub auto-approves", async () => {
    const { tmpDir, adapter } = await makeProject(undefined);
    tmpDirs.push(tmpDir);

    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const result = await dispatchTask(TASK_ID, adapter, {
      skipGate: true,
      disableEvents: true,
      onEvent: (stage, payload) => events.push({ stage, payload }),
    });

    // The empty stub trivially auto-approves (documented legacy parity) and the
    // dispatch proceeds until the BRANCH stage's git fetch fails in this
    // non-repo temp dir — proving it went PAST the gate rather than pausing.
    expect(result.outcome).toBe("error");
    expect(result.error ?? "").toContain("not a git repository");

    const generated = events.find((e) => e.stage === "blueprint_generated");
    expect(generated!.payload.structured).toBe(false);

    // no pending approval file was written
    await expect(
      fs.access(path.join(tmpDir, ".quack", "logs", "approvals", `${TASK_ID}.json`)),
    ).rejects.toBeDefined();
  });

  it("a loop-mode dispatch that re-encounters an existing pending approval pauses LOUDLY (QPI-043)", async () => {
    const { tmpDir, adapter } = await makeProject(STRUCTURED, "loop");
    tmpDirs.push(tmpDir);

    // Seed the live defect shape: a pending approval from an EARLIER
    // dispatch (1 hour old — well inside the 24h expiry, well before
    // this dispatch's start), carrying loop review evidence.
    const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
    await fs.mkdir(approvalDir, { recursive: true });
    const staleApproval: BlueprintApproval = {
      taskId: TASK_ID,
      state: "pending",
      blueprint: STRUCTURED,
      preflightResult: undefined,
      createdAt: staleCreatedAt,
      executionMode: "loop",
      review: {
        status: "completed",
        verdict: "FIX_FIRST",
        findings: [],
        summary: "needs a human",
        rawText: "{}",
        runner: "codex-cli",
        durationMs: 10,
      },
      reviewedAt: staleCreatedAt,
      reviewGate: {
        crossModelSatisfied: true,
        anchorAuditPassed: true,
        treeClean: true,
        fidelityPassed: true,
        eligibleForAutoApproval: false,
        reasons: ["review verdict is FIX_FIRST"],
      },
    };
    await fs.writeFile(
      path.join(approvalDir, `${TASK_ID}.json`),
      JSON.stringify(staleApproval, null, 2),
      "utf-8",
    );

    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const dispatchStart = Date.now();
    const result = await dispatchTask(TASK_ID, adapter, {
      skipGate: true,
      onEvent: (stage, payload) => events.push({ stage, payload }),
    });

    // Outcome unchanged — the fix makes the pause LOUD, not different.
    expect(result.outcome).toBe("awaiting_approval");

    // Silence #1 closed: the pending event fires on the re-encounter.
    const pending = events.find((e) => e.stage === "blueprint_pending_approval");
    expect(pending).toBeDefined();
    // TASK-1326 moved this pause EARLIER (ahead of the gate) and gave it
    // its own wording; the QPI-043 contract is unchanged, so the
    // assertion tracks the contract rather than the old sentence: the
    // reason must still name the pause and when it opened.
    expect(String(pending!.payload.reason)).toContain("paused at the blueprint gate");
    expect(String(pending!.payload.reason)).toContain(staleCreatedAt);

    // TASK-1326 (QPI-042's waste chain): the re-encounter must no longer
    // pay for a fresh gate + blueprint before pausing. Four TASK-1273
    // dispatches each re-billed both stages here.
    expect(events.some((e) => e.stage === "blueprint_generated")).toBe(false);
    expect(events.some((e) => e.stage === "checkpoint_saved")).toBe(false);

    // Silence #2 closed: the record is re-stamped so the monitor's
    // recency check (createdAt >= job.startedAt) classifies this exit
    // as awaiting_approval — with the review evidence preserved.
    const approvalRaw = await fs.readFile(path.join(approvalDir, `${TASK_ID}.json`), "utf-8");
    const resaved = JSON.parse(approvalRaw) as BlueprintApproval;
    expect(resaved.state).toBe("pending");
    expect(new Date(resaved.createdAt).getTime()).toBeGreaterThanOrEqual(dispatchStart);
    expect(resaved.reviewedAt).toBe(staleCreatedAt);
    expect(resaved.review).toMatchObject({ verdict: "FIX_FIRST" });

    // Silence #3 closed: the session records itself as awaiting approval
    // instead of staying "active" for the orphan sweeper.
    const sessionsRaw = await fs.readFile(
      path.join(tmpDir, ".quack", "logs", "sessions.jsonl"),
      "utf-8",
    );
    const sessionEntries = sessionsRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; outcome?: string });
    expect(
      sessionEntries.some((s) => s.status === "completed" && s.outcome === "awaiting_approval"),
    ).toBe(true);
  });
});
