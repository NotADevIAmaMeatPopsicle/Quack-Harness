// ─── TASK-1332 / QPI-045: a stale brief cannot be resumed into work ──
// REAL dispatcher path, no jest.mocks, no git remote, no network. The
// sequence is the actual defect, end to end:
//
//   run 1 pauses at the blueprint gate and stamps the pend with spec v1
//   a human approves it
//   the spec is amended to v2
//   run 2 resumes and MUST refuse, because dispatcher.ts restores the
//   brief FROM the approval record whenever the blueprint stage is
//   checkpointed, which is every gate-paused run
//
// The two controls matter as much as the refusal: a Status-only rewrite
// must NOT refuse (round-1 R1-2, the approval-control bypass), and an
// unstamped legacy record must NOT refuse (absence is UNKNOWN, and
// stranding every live pend on the deploy that ships this is not a fix).

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { dispatchTask } from "../../src/dispatcher/dispatcher";
import { _setQueryFn } from "../../src/blueprint/blueprint-agent";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { computeContentHash } from "../../src/monitor/prep-cache";
import { loadApproval, updateApprovalState } from "../../src/dispatcher/blueprint-approval";
import {
  readSpecStaleMarker,
  recoveryAdviceFor,
  specStaleMarkerPath,
} from "../../src/core/spec-identity";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";

jest.setTimeout(60_000);

const TASK_ID = "TASK-1332";

function spec(body: string, status = "READY"): string {
  return `# ${TASK_ID}: Stale brief fixture

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 1-2 hours
- **Status:** ${status}
- **Blocked By:** []
- **Blocks:** []
- **Tags:** fixture

## Problem Statement

${body}

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
}

const V1 = spec("Build the original thing.");

function structuredBlueprint(): Blueprint {
  return {
    taskId: TASK_ID,
    fileAnalyses: ["src/a.ts", "src/b.ts", "src/c.ts"].map((filePath) => ({
      filePath,
      action: "Modify" as const,
      currentStructure: "The fixture module exports its current behavior.",
      integrationPoints: "Update the fixture module in place.",
      patternToFollow: "Use the neighboring fixture modules as the pattern.",
    })),
    codeExamples: [],
    verificationPatterns: [
      {
        criterion: "The gate sees real counts",
        checkType: "grep",
        pattern: "fixture",
        fileGlob: "src/*.ts",
      },
    ],
    antiPatterns: [],
    preconditions: [],
  };
}

function installBlueprintQueryFixture(): void {
  _setQueryFn((() =>
    (async function* () {
      yield await Promise.resolve({
        type: "result",
        subtype: "success",
        result: JSON.stringify(structuredBlueprint()),
      });
    })()) as never);
}

function makePreflight(structured: Blueprint, contentHash: string): PreflightResult {
  return {
    taskId: TASK_ID,
    contentHash,
    preparedAt: new Date().toISOString(),
    gate: { score: 5, ready: true, dimensions: {}, feedback: [] },
    blueprint: {
      fileAnalyses: structured.fileAnalyses.length,
      codeExamples: structured.codeExamples.length,
      verificationPatterns: structured.verificationPatterns.length,
      antiPatterns: structured.antiPatterns.length,
      formattedMarkdown: "# brief",
      structured,
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
  } as unknown as PreflightResult;
}

async function makeProject(): Promise<{
  tmpDir: string;
  adapter: ProjectAdapter;
  specPath: string;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-stale-brief-"));
  const taskDir = path.join(tmpDir, "docs", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  const specPath = path.join(taskDir, `${TASK_ID}.md`);
  await fs.writeFile(specPath, V1, "utf-8");
  const sourceDir = path.join(tmpDir, "src");
  await fs.mkdir(sourceDir, { recursive: true });
  await Promise.all(
    ["a.ts", "b.ts", "c.ts"].map((fileName) =>
      fs.writeFile(path.join(sourceDir, fileName), "export const fixture = true;\n", "utf-8"),
    ),
  );

  const prepDir = path.join(tmpDir, ".quack", "prep");
  await fs.mkdir(prepDir, { recursive: true });
  await fs.writeFile(
    path.join(prepDir, `${TASK_ID}-preflight.json`),
    JSON.stringify(makePreflight(structuredBlueprint(), computeContentHash(V1)), null, 2),
    "utf-8",
  );

  const config = AdapterConfigSchema.parse({
    version: "1.0",
    project: {
      name: "stale-brief-fixture",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    verification: {
      commands: [{ name: "noop", command: "echo ok", required: false, timeout: 1000 }],
    },
    git: { commitFormat: "[{taskId}] {message}", commitTrailer: "" },
    logging: { dir: ".quack/logs" },
    preflight: {
      blueprintApproval: {
        enabled: true,
        // Run 1 pauses for a human. Note it pauses via the TASK-1324
        // fidelity refusal (the stubbed agent yields nothing, so the
        // brief falls back to the minimal stub, which is stamped
        // fidelity: failed and is therefore never auto-approvable),
        // not via this threshold. Either way a stamped pend exists,
        // which is all this suite needs; asserted rather than assumed
        // by the specIdentity check in pauseThenApprove.
        autoApproveWhen: {
          maxFiles: 1,
          maxCriteria: 5,
          minBlueprintScore: 0,
          requireDecomposition: false,
        },
      },
    },
  });

  return {
    tmpDir,
    specPath,
    adapter: {
      projectRoot: tmpDir,
      conventionsDoc: "",
      judgeCriteria: "",
      conventionCheckScripts: [],
      adrDocs: {},
      config,
      adapterBundle: {
        authority: "local",
        sharedHash: "stale-brief-test-hash",
        normalizedConfig: config,
        machineLocalFields: [],
      },
    } as unknown as ProjectAdapter,
  };
}

interface Captured {
  stage: string;
  payload: Record<string, unknown>;
}

/** Narrow the event payload rather than stringifying an unknown. */
function reasonOf(e: Captured | undefined): string {
  const r = e?.payload.reason;
  return typeof r === "string" ? r : "";
}

async function run(
  adapter: ProjectAdapter,
  events: Captured[],
  resume = false,
  afterEvent?: (stage: string, payload: Record<string, unknown>) => void,
) {
  return dispatchTask(TASK_ID, adapter, {
    skipGate: true,
    disableEvents: true,
    ...(resume ? { resumeFromCheckpoint: true } : {}),
    onEvent: (stage: string, payload: Record<string, unknown>) => {
      events.push({ stage, payload });
      afterEvent?.(stage, payload);
    },
  } as never);
}

describe("TASK-1332: a resume cannot consume a brief whose contract has moved", () => {
  const tmpDirs: string[] = [];

  beforeAll(() => {
    // Changed-spec and worktree controls intentionally miss the original
    // cache. Keep those paths substantive without making a real SDK call.
    installBlueprintQueryFixture();
  });
  afterAll(async () => {
    _setQueryFn(undefined as never);
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
  });

  async function pauseThenApprove() {
    const { tmpDir, adapter, specPath } = await makeProject();
    tmpDirs.push(tmpDir);
    const logDir = path.join(tmpDir, ".quack", "logs");

    const first: Captured[] = [];
    const r1 = await run(adapter, first);
    expect(r1.outcome).toBe("awaiting_approval");

    // The pend must be stamped, or the rest of this proves nothing.
    const pend = await loadApproval(TASK_ID, logDir);
    expect(pend?.specIdentity?.contractHash).toBeDefined();

    // What the approve route does.
    await updateApprovalState(TASK_ID, "approved", logDir);
    return { adapter, specPath, logDir, pend };
  }

  it("REFUSES when the spec's contract changed while the gate was open", async () => {
    const { adapter, specPath } = await pauseThenApprove();

    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT thing."), "utf-8");

    const events: Captured[] = [];
    const r2 = await run(adapter, events, true);

    // Round 2 (R2-5): a refusal is a RECOVERABLE outcome of its own, not
    // a crash. Reporting it as `error` repeats QPI-041's mistake about a
    // pause.
    expect(r2.outcome).toBe("spec_changed");
    expect(r2.error ?? "").toContain("contract has changed");
    // The advice must name an action that works on an ALREADY-EXITED job.
    // The first cut said "stop, then replan"; stop 404s here.
    expect(r2.error ?? "").toContain("replan");
    expect(r2.error ?? "").not.toContain("stop, then replan");
    expect(events.some((e) => e.stage === "spec_identity_stale")).toBe(true);
    // Non-destruction is the point: TASK-1326 hardened this seam.
    expect(r2.error ?? "").toContain("Nothing has been deleted or rejected");
    // Round 5 (R5-6): NO `session_error`. It used to ride alongside, and
    // the monitor's watcher turned it into an ERROR row that the session
    // APIs prefer over the log's `spec_changed`, so the one control
    // plane an operator looks at kept calling a deliberate refusal a
    // crash. R3-1 fixed the federation boundary and left this one.
    expect(events.some((e) => e.stage === "session_error")).toBe(false);
    // Round 6 (R6-2): but a TERMINAL event is still required, and round 5
    // shipped without one. Asserting only the absence was vacuous, the
    // whole replacement could be deleted and it would still pass, while
    // ProgressDetector kept the task (and could later raise a stuck
    // warning or a kill for a run that had deliberately stopped), the
    // dashboard left it visibly active, and the workflow projector never
    // left its previous state. `session_complete` with its own outcome is
    // the shape `gate_failed` has always used.
    const done = events.find((e) => e.stage === "session_complete");
    expect(done).toBeDefined();
    expect(done?.payload.outcome).toBe("spec_changed");
    // It must NOT have restored the stale brief on the way to refusing.
    expect(events.some((e) => e.stage === "stage_skipped" && e.payload.stage === "blueprint")).toBe(
      false,
    );
  });

  it("REFUSES to reuse an old approval for a NEWLY generated brief (R5-1)", async () => {
    // Round 5's sharpest finding, and it is round 4's own recovery advice
    // walking into it. "Push the amended spec, then start a FRESH
    // dispatch" does end the refusal loop, by generating a new brief and
    // then letting the PREVIOUS run's approval record authorize it. The
    // restore check above never runs on a fresh dispatch, because there
    // is nothing to restore.
    //
    // A human approved brief-v1. Nobody approved brief-v2.
    const { adapter, specPath } = await pauseThenApprove();

    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT thing."), "utf-8");

    const events: Captured[] = [];
    const fresh = await run(adapter, events); // NOT a resume

    expect(fresh.outcome).toBe("spec_changed");
    expect(fresh.error ?? "").toContain("contract has changed");
    expect(fresh.error ?? "").toContain("blueprint approval reuse");
    // The gate must NOT have been skipped as "already approved".
    expect(events.some((e) => e.stage === "stage_skipped" && e.payload.stage === "approve")).toBe(
      false,
    );
    const stale = events.find((e) => e.stage === "spec_identity_stale");
    expect(stale?.payload.stage).toBe("approve");
    expect(stale?.payload.verdict).toBe("stale");
  });

  it("retires a rejection after a contract change and opens a gate for the fresh brief", async () => {
    const { tmpDir, adapter, specPath } = await makeProject();
    tmpDirs.push(tmpDir);
    const logDir = path.join(tmpDir, ".quack", "logs");

    const first = await run(adapter, []);
    expect(first.outcome).toBe("awaiting_approval");
    const rejectedGeneration = await loadApproval(TASK_ID, logDir);
    expect(rejectedGeneration?.specIdentity?.contractHash).toBeDefined();
    await updateApprovalState(
      TASK_ID,
      "rejected",
      logDir,
      undefined,
      "Cross-provider review rejected generation one",
    );

    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT second generation."), "utf-8");

    const events: Captured[] = [];
    const fresh = await run(adapter, events);

    expect(fresh.outcome).toBe("awaiting_approval");
    expect(fresh.error).toBe("Awaiting blueprint approval");
    expect(events.some((event) => event.stage === "blueprint_generated")).toBe(true);
    expect(events.some((event) => event.stage === "blueprint_pending_approval")).toBe(true);
    expect(events.some((event) => event.stage === "session_error")).toBe(false);

    const freshGeneration = await loadApproval(TASK_ID, logDir);
    expect(freshGeneration).toMatchObject({ state: "pending" });
    expect(freshGeneration?.rejectionReason).toBeUndefined();
    expect(freshGeneration?.specIdentity?.contractHash).not.toBe(
      rejectedGeneration?.specIdentity?.contractHash,
    );
  });

  it("replaces a stale rejection when the fresh brief is auto-approved", async () => {
    const { tmpDir, adapter, specPath } = await makeProject();
    tmpDirs.push(tmpDir);
    const logDir = path.join(tmpDir, ".quack", "logs");

    expect((await run(adapter, [])).outcome).toBe("awaiting_approval");
    const rejectedGeneration = await loadApproval(TASK_ID, logDir);
    expect(rejectedGeneration?.specIdentity?.contractHash).toBeDefined();
    await updateApprovalState(
      TASK_ID,
      "rejected",
      logDir,
      undefined,
      "Generation one does not match the requested design",
    );

    // The replacement blueprint has three files. Widen the deterministic
    // threshold so the new, changed-spec generation takes the non-loop
    // auto-approval path that historically left the v1 rejection on disk.
    const rules = adapter.config.preflight?.blueprintApproval?.autoApproveWhen;
    if (!rules) throw new Error("fixture must configure blueprint auto-approval rules");
    rules.maxFiles = 3;
    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT second generation."), "utf-8");

    const events: Captured[] = [];
    const fresh = await run(adapter, events);

    expect(fresh.outcome).not.toBe("awaiting_approval");
    expect(events.some((event) => event.stage === "blueprint_pending_approval")).toBe(false);
    // The fixture is not a Git repository, so reaching branch setup proves
    // the fresh generation crossed the approval gate.
    expect(fresh.error ?? "").toMatch(
      /not a git repository|spawn EPERM|Refusing local or helper-backed Git transport target: origin/,
    );

    const replacement = await loadApproval(TASK_ID, logDir);
    expect(replacement).toMatchObject({ state: "auto-approved" });
    expect(replacement?.rejectionReason).toBeUndefined();
    expect(replacement?.specIdentity?.contractHash).not.toBe(
      rejectedGeneration?.specIdentity?.contractHash,
    );
  });

  it("keeps a same-contract rejection authoritative on a fresh dispatch", async () => {
    const { tmpDir, adapter } = await makeProject();
    tmpDirs.push(tmpDir);
    const logDir = path.join(tmpDir, ".quack", "logs");

    expect((await run(adapter, [])).outcome).toBe("awaiting_approval");
    await updateApprovalState(
      TASK_ID,
      "rejected",
      logDir,
      undefined,
      "The generated approach is unsafe",
    );

    const events: Captured[] = [];
    const repeated = await run(adapter, events);

    expect(repeated.outcome).toBe("error");
    expect(events.find((event) => event.stage === "session_error")?.payload.error).toContain(
      "The generated approach is unsafe",
    );
    expect((await loadApproval(TASK_ID, logDir))?.state).toBe("rejected");
  });

  it("DOES reuse an approval for a fresh brief when the contract has NOT moved", async () => {
    // The control for the arm above, and it is not vacuous: without it,
    // refusing every fresh dispatch that finds an approved record would
    // pass the test above while breaking ordinary redispatch entirely.
    const { adapter } = await pauseThenApprove();

    const events: Captured[] = [];
    const fresh = await run(adapter, events); // NOT a resume, spec untouched

    expect(fresh.outcome).not.toBe("spec_changed");
    expect(events.some((e) => e.stage === "stage_skipped" && e.payload.stage === "approve")).toBe(
      true,
    );
    // Went PAST the gate: the branch stage's Git fetch fails in this non-repo
    // temp directory. The trusted launcher may reject the unresolved `origin`
    // before Git itself emits its historical not-a-repository error.
    expect(fresh.error ?? "").toMatch(
      /not a git repository|spawn EPERM|Refusing local or helper-backed Git transport target: origin/,
    );
  });

  it("does NOT refuse when only the Status line moved (round-1 R1-2, the bypass)", async () => {
    const { adapter, specPath } = await pauseThenApprove();

    // Exactly what the reconciler, the task-reject API, enrichment and the
    // watcher all do. If this refused, a bookkeeping write could retire a
    // human decision and the check would be an approval-control bypass.
    await fs.writeFile(specPath, spec("Build the original thing.", "IN_PROGRESS"), "utf-8");

    const events: Captured[] = [];
    const r2 = await run(adapter, events, true);

    expect(r2.error ?? "").not.toContain("contract has changed");
    // Went PAST the gate: the branch stage's Git fetch fails in this non-repo
    // temp directory. The trusted launcher may reject the unresolved `origin`
    // before Git itself emits its historical not-a-repository error.
    expect(r2.error ?? "").toMatch(
      /not a git repository|spawn EPERM|Refusing local or helper-backed Git transport target: origin/,
    );
    const skipped = events.find(
      (e) => e.stage === "stage_skipped" && e.payload.stage === "blueprint",
    );
    expect(reasonOf(skipped)).toContain("only the Status line moved");
  });

  it("writes a durable, run-scoped marker so the monitor can tell a refusal from a crash", async () => {
    const { adapter, specPath, logDir } = await pauseThenApprove();
    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT thing."), "utf-8");

    const before = new Date().toISOString();
    await run(adapter, [], true);

    // Decided from DISK, not from a lifecycle callback: QPI-043's whole
    // lesson was that an SSE-only signal is not a signal.
    const marker = readSpecStaleMarker(logDir, TASK_ID, before);
    expect(marker?.verdict).toBe("stale");
    expect(marker?.reason).toContain("contract has changed");

    // Run-scoped: a marker from an earlier run must never explain a later
    // exit, the same rule TASK-1329 established for pause attribution.
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(readSpecStaleMarker(logDir, TASK_ID, later)).toBeNull();

    // Round 3 (R3-4): the OTHER bound. A corrupt marker dated absurdly in
    // the future is "after the start" of every run that will ever exist,
    // so without an upper clamp it would explain every later crash as a
    // deliberate refusal. paused-run-state learned this in its own r2.
    const markerFile = specStaleMarkerPath(logDir, TASK_ID);
    const corrupt = JSON.parse(await fs.readFile(markerFile, "utf-8")) as Record<string, unknown>;
    await fs.writeFile(
      markerFile,
      JSON.stringify({ ...corrupt, refusedAt: "9999-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    expect(readSpecStaleMarker(logDir, TASK_ID, before)).toBeNull();

    // And it must be about THIS task.
    await fs.writeFile(markerFile, JSON.stringify({ ...corrupt, taskId: "TASK-9999" }), "utf-8");
    expect(readSpecStaleMarker(logDir, TASK_ID, before)).toBeNull();
  });

  it("does NOT refuse an UNSTAMPED legacy record, even against a changed spec", async () => {
    const { adapter, specPath, logDir } = await pauseThenApprove();

    // Every record written before TASK-1332 looks like this. Treating it as
    // stale would strand every pend alive on the deploy that ships this.
    //
    // Round 5 (R5-3): BOTH fields go, and that is the point. A record with
    // no identity but WITH `specIdentityVersion` was written today by code
    // that tried to resolve the authoritative spec and failed, which is
    // `unverifiable` and refuses. Only a record with neither predates the
    // feature and earns the grandfather clause. The arm below is the
    // other half of that distinction.
    const file = path.join(logDir, "approvals", `${TASK_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    delete record.specIdentity;
    delete record.specIdentityVersion;
    await fs.writeFile(file, JSON.stringify(record, null, 2), "utf-8");

    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT thing."), "utf-8");

    const events: Captured[] = [];
    const r2 = await run(adapter, events, true);

    expect(r2.error ?? "").not.toContain("contract has changed");
    const skipped = events.find(
      (e) => e.stage === "stage_skipped" && e.payload.stage === "blueprint",
    );
    expect(reasonOf(skipped)).toContain("UNKNOWN");
  });

  it("DOES refuse a record written today whose identity could not be resolved (R5-3)", async () => {
    // The other half of the boundary, and the fail-open round 5 found:
    // `unknown_legacy` was inferred purely from a missing field, so a
    // record written NOW, by a run whose owning-clone spec was missing,
    // unreadable or ambiguous, was grandfathered exactly like a genuine
    // pre-1332 record and consumed. The version field is what tells them
    // apart, so here it STAYS while only the identity is removed.
    const { adapter, specPath, logDir } = await pauseThenApprove();

    const file = path.join(logDir, "approvals", `${TASK_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    delete record.specIdentity;
    expect(record.specIdentityVersion).toBeDefined();
    await fs.writeFile(file, JSON.stringify(record, null, 2), "utf-8");

    await fs.writeFile(specPath, spec("Build a MATERIALLY DIFFERENT thing."), "utf-8");

    const events: Captured[] = [];
    const r2 = await run(adapter, events, true);

    expect(r2.outcome).toBe("spec_changed");
    const stale = events.find((e) => e.stage === "spec_identity_stale");
    expect(stale?.payload.verdict).toBe("unverifiable");
    // And the advice must be the one an operator can actually follow.
    expect(r2.error ?? "").toContain("Restore the task spec");
  });
});

// ─── R3-2: the loop my own divergence check created ──────────────────
// A dispatch worktree is cut from origin/<base>, so it holds v1 while the
// owning clone holds an unpushed v2. Before this, the run generated a brief
// from v1, stamped it from the owner at v2, was born `diverged`, and refused
// at every consumption. Replan regenerated from the same worktree and
// reproduced it exactly, so the advertised recovery LOOPED.
//
// The fix refuses at the source instead: before the gate, before blueprint
// generation, and before a human is asked to approve something built from the
// wrong contract.
describe("TASK-1332 R3-2: a run whose spec is not the authoritative one refuses BEFORE the gate", () => {
  const tmpDirs: string[] = [];

  beforeAll(() => {
    // Worktree fixtures intentionally have no local preflight cache.
    installBlueprintQueryFixture();
  });
  afterAll(async () => {
    _setQueryFn(undefined as never);
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
  });

  /** Owner clone holding `owner`, with a dispatch worktree under it holding
   *  `inWorktree`. Mirrors the real topology: the worktree is a child of the
   *  owning root and only the owner carries `quack.db`. */
  async function makeDivergentPair(owner: string, inWorktree: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-diverge-"));
    tmpDirs.push(root);

    await fs.mkdir(path.join(root, "docs", "tasks"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "tasks", `${TASK_ID}.md`), owner, "utf-8");
    await fs.mkdir(path.join(root, ".quack"), { recursive: true });
    await fs.writeFile(path.join(root, ".quack", "quack.db"), "", "utf-8");

    const worktree = path.join(root, ".quack", "worktrees", TASK_ID);
    await fs.mkdir(path.join(worktree, "docs", "tasks"), { recursive: true });
    await fs.writeFile(path.join(worktree, "docs", "tasks", `${TASK_ID}.md`), inWorktree, "utf-8");

    const { adapter } = await makeProject();
    return {
      adapter: { ...adapter, projectRoot: worktree } as ProjectAdapter,
      root,
    };
  }

  it("REFUSES and hands back the one canonical recovery sequence (R6-1)", async () => {
    const { adapter } = await makeDivergentPair(
      spec("AMENDED: build the thing correctly."), // owner, unpushed
      V1, // worktree, cut before it
    );

    const events: Captured[] = [];
    const result = await run(adapter, events);

    expect(result.outcome).toBe("spec_changed");
    expect(result.error ?? "").toContain("does not match the authoritative one");
    expect(result.error ?? "").toContain("PUSH the amended spec");
    // Round 6 (R6-1): this arm used to assert "Replan will NOT clear
    // this" and so BLESSED the unsafe wording, an operator who pushed
    // and dispatched fresh without clearing an open approval walked into
    // the R5-1 bypass, and for a pre-1332 record (`unknown_legacy` by
    // design) the reuse check permits it, so the new brief skips the
    // gate. The message now carries the single advice source verbatim,
    // and this asserts THAT rather than a second copy of the words.
    expect(result.error ?? "").toContain(recoveryAdviceFor("diverged"));
    expect(result.error ?? "").not.toContain("Replan will NOT clear this");

    // Refused at the SOURCE: no gate, no blueprint, nothing billed.
    expect(events.some((e) => e.stage === "blueprint_generated")).toBe(false);
    expect(events.some((e) => e.stage === "blueprint_start")).toBe(false);
    const stale = events.find((e) => e.stage === "spec_identity_stale");
    expect(stale?.payload.stage).toBe("pre_gate");
    expect(stale?.payload.recoverable).toBe(true);
  });

  it("does NOT refuse when the worktree matches the owner", async () => {
    const { adapter } = await makeDivergentPair(V1, V1);
    const events: Captured[] = [];
    const result = await run(adapter, events);

    expect(result.outcome).not.toBe("spec_changed");
    expect(events.some((e) => e.stage === "spec_identity_stale")).toBe(false);
  });

  it("does NOT refuse on a Status-only difference, so bookkeeping cannot block a dispatch", async () => {
    // The R1-2 guarantee, one layer earlier: a reconciler write must not be
    // able to stop work from starting.
    const { adapter } = await makeDivergentPair(
      spec("Build the original thing.", "IN_PROGRESS"),
      V1,
    );
    const events: Captured[] = [];
    const result = await run(adapter, events);

    expect(result.outcome).not.toBe("spec_changed");
    expect(events.some((e) => e.stage === "spec_identity_stale")).toBe(false);
  });

  it("TASK-1338-D: refuses a contest introduced synchronously after admission with both claimants", async () => {
    const { tmpDir, adapter } = await makeProject();
    tmpDirs.push(tmpDir);
    const crossClaimant = path.join(tmpDir, "docs", "tasks", "TASK-999-cross.md");
    const events: Captured[] = [];

    const result = await run(adapter, events, false, (stage) => {
      if (stage === "session_start") {
        fsSync.writeFileSync(crossClaimant, V1, "utf-8");
      }
    });

    expect(result.outcome).toBe("spec_changed");
    expect(result.error).toContain("contested id");
    expect(result.error).toContain("TASK-1332.md");
    expect(result.error).toContain("TASK-999-cross.md");
    const refusal = events.find((event) => event.stage === "spec_identity_stale");
    expect(refusal?.payload).toMatchObject({
      stage: "pre_gate",
      verdict: "contested",
      recoverable: true,
    });
    expect(events.some((event) => event.stage === "blueprint_start")).toBe(false);
  });

  it("TASK-1338-D fix 1: refuses a contest introduced after pre-gate but before approval save", async () => {
    const { tmpDir, adapter } = await makeProject();
    tmpDirs.push(tmpDir);
    const crossClaimant = path.join(tmpDir, "docs", "tasks", "TASK-999-cross.md");
    const events: Captured[] = [];

    const result = await run(adapter, events, false, (stage) => {
      if (stage === "blueprint_generated") {
        fsSync.writeFileSync(crossClaimant, V1, "utf-8");
      }
    });

    expect(events.some((event) => event.stage === "blueprint_generated")).toBe(true);
    expect(result.outcome).toBe("spec_changed");
    expect(result.error).toContain("contested id");
    expect(result.error).toContain("TASK-1332.md");
    expect(result.error).toContain("TASK-999-cross.md");
    expect(events.find((event) => event.stage === "spec_identity_stale")?.payload).toMatchObject({
      stage: "approve",
      verdict: "contested",
      recoverable: true,
    });
    expect(events.some((event) => event.stage === "blueprint_pending_approval")).toBe(false);
  });
});
