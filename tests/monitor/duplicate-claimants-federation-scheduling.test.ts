import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TaskService } from "../../src/monitor/task-service";
import {
  buildFederationClaimantIndex,
  evaluateFederatedSchedulingGate,
  recoverStaleFederatedLeases,
  isRecoverableFederatedSchedulingBlock,
  recheckRecoverableFederatedBlocks,
  releaseFederatedDependencyBlocks,
  runSwarmSchedulerTick,
} from "../../src/monitor/federation/scheduling";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import {
  loadFederatedJob,
  saveFederatedJob,
  updateFederatedJob,
} from "../../src/monitor/federation/store";
import type {
  FederatedJobRecord,
  FederationProjectContext,
} from "../../src/monitor/federation/types";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import type { EventWriter } from "../../src/monitor/event-emitter";

function spec(id: string, blockedBy: string[] = []): string {
  return [
    `# ${id}: strict scheduling fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** SMALL",
    "- **Status:** READY",
    `- **Blocked By:** [${blockedBy.join(", ")}]`,
    "- **Tags:** [federation]",
    "",
    "## Problem Statement",
    "Strict scheduler fixture.",
    "",
    "## Success Criteria",
    "- [ ] gated",
    "",
    "## Testing Requirements",
    "- [ ] unit",
  ].join("\n");
}

function fixture(dependencyStatus = "COMPLETE"): {
  root: string;
  taskDir: string;
  context: FederationProjectContext;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-scheduler-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "TASK-100-a.md"), spec("TASK-100"));
  fs.writeFileSync(path.join(taskDir, "TASK-200.md"), spec("TASK-200", ["task-100"]));
  const taskService = new TaskService(root, "docs/tasks");
  const context = {
    projectId: "fixture",
    projectRoot: root,
    taskService,
    prepCache: null,
    reader: {},
    db: {
      getStatus: (id: string) =>
        id.toUpperCase() === "TASK-100" ? { status: dependencyStatus } : undefined,
    },
  } as unknown as FederationProjectContext;
  return { root, taskDir, context };
}

const provenance = { channel: "federation-queue" as const, tokenId: "test" };
const duplicateArms = [
  ["exact", "before-canonical"],
  ["exact", "after-canonical"],
  ["cross-population", "before-canonical"],
  ["cross-population", "after-canonical"],
] as const;

function addContest(
  f: ReturnType<typeof fixture>,
  shape: (typeof duplicateArms)[number][0],
  order: (typeof duplicateArms)[number][1],
): { duplicatePath: string; expectedClaimants: string[] } {
  const originalPath = path.join(f.taskDir, "TASK-100-a.md");
  const duplicateFileName =
    shape === "exact"
      ? order === "before-canonical"
        ? "TASK-100-0-contest.md"
        : "TASK-100-z-contest.md"
      : order === "before-canonical"
        ? "TASK-099-cross-contest.md"
        : "TASK-998-cross-contest.md";
  const duplicatePath = path.join(f.taskDir, duplicateFileName);
  const content = fs.readFileSync(originalPath, "utf-8");
  fs.writeFileSync(duplicatePath, content, "utf-8");
  return {
    duplicatePath,
    expectedClaimants:
      order === "before-canonical"
        ? [duplicateFileName, "TASK-100-a.md"]
        : ["TASK-100-a.md", duplicateFileName],
  };
}

async function expectBuiltClaimantOrder(
  f: ReturnType<typeof fixture>,
  expectedClaimants: string[],
): Promise<void> {
  const index = await buildFederationClaimantIndex(f.context);
  expect(index.status).toBe("scanned");
  if (index.status !== "scanned") throw new Error(`expected scanned index: ${index.reason}`);
  expect(index.contested.get("TASK-100")).toEqual(expectedClaimants);
}

describe("TASK-1338-F federation scheduler strict index", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when TaskService is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-unavailable-"));
    roots.push(root);
    const record = queueFederatedJobRecord({
      taskId: "TASK-100",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    const gate = await evaluateFederatedSchedulingGate(
      {
        projectRoot: root,
        taskService: null,
      } as FederationProjectContext,
      record,
      { allowMissingPreflight: true },
    );
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected unavailable gate refusal");
    expect(gate.error).toContain("TaskService is unavailable");
  });

  it("bypassDependencyGate cannot bypass target duplicate integrity", async () => {
    const f = fixture();
    roots.push(f.root);
    fs.writeFileSync(path.join(f.taskDir, "TASK-999-b.md"), spec("TASK-100"));
    const record = queueFederatedJobRecord({
      taskId: "task-100",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    const gate = await evaluateFederatedSchedulingGate(f.context, record, {
      bypassDependencyGate: true,
      allowMissingPreflight: true,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected duplicate gate refusal");
    expect(gate.error).toContain("duplicate_claimants");
  });

  it("checks the normalized completed dependency satisfier set", async () => {
    const f = fixture();
    roots.push(f.root);
    fs.writeFileSync(path.join(f.taskDir, "TASK-998-b.md"), spec("TASK-100"));
    const record = queueFederatedJobRecord({
      taskId: "TASK-200",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    const gate = await evaluateFederatedSchedulingGate(f.context, record, {
      allowMissingPreflight: true,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected dependency gate refusal");
    expect(gate.error).toContain("TASK-100");
  });

  it.each(duplicateArms)(
    "keeps dependency release blocked for a %s duplicate in %s order and releases it once clean",
    async (shape, order) => {
      const f = fixture();
      roots.push(f.root);
      const blocked = {
        ...queueFederatedJobRecord({
          taskId: "TASK-200",
          jobType: "verify",
          requiredCapabilities: ["verify"],
          provenance,
        }),
        status: "blocked" as const,
        decision: { dependencyBlockers: ["TASK-100"] },
      };
      await saveFederatedJob(f.root, blocked);
      const contest = addContest(f, shape, order);
      await expectBuiltClaimantOrder(f, contest.expectedClaimants);

      const refused = await releaseFederatedDependencyBlocks(f.context, "task-100");
      expect(refused).toEqual([]);
      const refusedJob = await loadFederatedJob(f.root, blocked.jobId);
      expect(refusedJob).toMatchObject({
        status: "blocked",
        decision: { dependencyBlockers: ["TASK-100"] },
      });
      expect(refusedJob?.error).toContain("duplicate_claimants:TASK-100");

      fs.rmSync(contest.duplicatePath);
      const released = await releaseFederatedDependencyBlocks(f.context, "TASK-100");
      expect(released).toEqual([
        expect.objectContaining({ jobId: blocked.jobId, status: "queued", lease: undefined }),
      ]);
    },
  );

  function legacyPendingDependencyBlock(
    change: Partial<FederatedJobRecord> = {},
  ): FederatedJobRecord {
    return {
      ...queueFederatedJobRecord({
        taskId: "TASK-200",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: "blocked_by_unresolved:TASK-100",
      nextAction: "wait_for_dependencies",
      decision: { dependencyBlockers: ["TASK-100"] },
      ...change,
    };
  }

  it("releases the historical dependency tuple only through current-authority completion replay", async () => {
    const f = fixture();
    roots.push(f.root);
    const blocked = legacyPendingDependencyBlock();
    await saveFederatedJob(f.root, blocked);
    const before = await loadFederatedJob(f.root, blocked.jobId);
    expect(before?.retryable).toBeUndefined();
    expect(isRecoverableFederatedSchedulingBlock(blocked)).toBe(false);
    expect(await recheckRecoverableFederatedBlocks(f.context)).toEqual([]);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toEqual(before);

    const released = await releaseFederatedDependencyBlocks(f.context, "TASK-100");
    expect(released).toHaveLength(1);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toMatchObject({
      jobId: blocked.jobId,
      status: "queued",
      nextAction: "schedule_after_dependency_verified",
      decision: { unblockedBy: "TASK-100" },
    });
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
  });

  it.each<Partial<FederatedJobRecord>>([
    { retryable: false },
    { nextAction: "manual_handoff" },
    { error: "operator_uncertainty" },
    { error: undefined },
    { nextAction: undefined },
    { hostId: "already-attached" },
    { remoteSessionId: "previous-session" },
    { assignedAt: "2026-09-11T00:00:00.000Z" },
    { pendingGate: { stage: "judge" } },
    { projectId: "different-project" },
    { decision: {}, error: "blocked_by_unresolved:" },
  ])("preserves a refused historical dependency tuple byte-for-byte: %j", async (change) => {
    const f = fixture();
    roots.push(f.root);
    const blocked = legacyPendingDependencyBlock(change);
    await saveFederatedJob(f.root, blocked);
    const jobPath = path.join(f.root, ".quack", "federation", "jobs", blocked.jobId + ".json");
    const before = fs.readFileSync(jobPath);
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
    expect(fs.readFileSync(jobPath)).toEqual(before);
  });

  it("keeps current DB state ahead of completion replay for the historical tuple", async () => {
    const f = fixture("IN_PROGRESS");
    roots.push(f.root);
    fs.writeFileSync(
      path.join(f.taskDir, "TASK-100-a.md"),
      spec("TASK-100").replace("- **Status:** READY", "- **Status:** COMPLETE"),
    );
    const blocked = legacyPendingDependencyBlock();
    await saveFederatedJob(f.root, blocked);
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toMatchObject({
      status: "blocked",
      error: "blocked_by_unresolved:TASK-100",
      nextAction: "wait_for_dependencies",
    });
  });

  it("retains a strict claimant refusal and retries the historical tuple after repair", async () => {
    const f = fixture();
    roots.push(f.root);
    const blocked = legacyPendingDependencyBlock();
    await saveFederatedJob(f.root, blocked);
    const contest = addContest(f, "cross-population", "after-canonical");
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toMatchObject({
      status: "blocked",
      nextAction: "resolve_duplicate_claimants",
      decision: { dependencyBlockers: ["TASK-100"] },
    });
    expect((await loadFederatedJob(f.root, blocked.jobId))?.error).toContain(
      "duplicate_claimants:TASK-100",
    );
    fs.rmSync(contest.duplicatePath);
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toHaveLength(1);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toMatchObject({
      status: "queued",
    });
  });

  it("does not overwrite a cancellation that wins after dependency discovery", async () => {
    const f = fixture();
    roots.push(f.root);
    const blocked = {
      ...queueFederatedJobRecord({
        taskId: "TASK-200",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "blocked" as const,
      error: "blocked_by_unresolved:TASK-100",
      decision: { dependencyBlockers: ["TASK-100"] },
    };
    await saveFederatedJob(f.root, blocked);
    const claimantIndex = await buildFederationClaimantIndex(f.context);
    let releaseDiscovery!: () => void;
    let continueRelease!: () => void;
    const discovered = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const mayContinue = new Promise<void>((resolve) => {
      continueRelease = resolve;
    });

    const releasePromise = releaseFederatedDependencyBlocks(f.context, "TASK-100", claimantIndex, {
      afterCandidateDiscoveredForTest: async () => {
        releaseDiscovery();
        await mayContinue;
      },
    });
    await discovered;
    await expect(
      updateFederatedJob(f.root, blocked.jobId, (current) => ({
        ...current,
        status: "canceled",
        error: "operator_canceled",
        nextAction: "none",
        updatedAt: "2026-09-10T00:00:01.000Z",
      })),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    continueRelease();

    await expect(releasePromise).resolves.toEqual([]);
    await expect(loadFederatedJob(f.root, blocked.jobId)).resolves.toMatchObject({
      status: "canceled",
      error: "operator_canceled",
      nextAction: "none",
    });
  });

  it.each([
    { nextAction: "manual_handoff", error: "operator_uncertainty" },
    { hostId: "already-attached" },
    { remoteSessionId: "previous-session" },
    { projectId: "different-project" },
  ])(
    "does not release a legacy dependency block with manual or active identity: %j",
    async (change) => {
      const f = fixture();
      roots.push(f.root);
      const blocked = {
        ...queueFederatedJobRecord({
          taskId: "TASK-200",
          jobType: "verify",
          requiredCapabilities: ["verify"],
          provenance,
        }),
        status: "blocked" as const,
        error: "blocked_by_unresolved:TASK-100",
        decision: { dependencyBlockers: ["TASK-100"] },
        ...change,
      };
      await saveFederatedJob(f.root, blocked);
      const before = await loadFederatedJob(f.root, blocked.jobId);
      expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
      expect(await loadFederatedJob(f.root, blocked.jobId)).toEqual(before);
    },
  );

  it("rereads declarations after completion discovery instead of using a stale clean index", async () => {
    const f = fixture();
    roots.push(f.root);
    const blocked = {
      ...queueFederatedJobRecord({
        taskId: "TASK-200",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "blocked" as const,
      decision: { dependencyBlockers: ["TASK-100"] },
    };
    await saveFederatedJob(f.root, blocked);
    const index = await buildFederationClaimantIndex(f.context);
    expect(
      await releaseFederatedDependencyBlocks(f.context, "TASK-100", index, {
        afterCandidateDiscoveredForTest: () => {
          fs.writeFileSync(path.join(f.taskDir, "TASK-999-contest.md"), spec("TASK-100"));
        },
      }),
    ).toEqual([]);
    expect((await loadFederatedJob(f.root, blocked.jobId))?.error).toContain(
      "duplicate_claimants:TASK-100",
    );
  });

  it("keeps canonical DB status ahead of a completed spec and completion notification", async () => {
    const f = fixture("IN_PROGRESS");
    roots.push(f.root);
    fs.writeFileSync(
      path.join(f.taskDir, "TASK-100-a.md"),
      spec("TASK-100").replace("- **Status:** READY", "- **Status:** COMPLETE"),
    );
    const blocked = {
      ...queueFederatedJobRecord({
        taskId: "TASK-200",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "blocked" as const,
      decision: { dependencyBlockers: ["TASK-100"] },
    };
    await saveFederatedJob(f.root, blocked);
    expect(await releaseFederatedDependencyBlocks(f.context, "TASK-100")).toEqual([]);
    expect(await loadFederatedJob(f.root, blocked.jobId)).toMatchObject({
      status: "blocked",
      error: "blocked_by_unresolved:TASK-100",
      nextAction: "wait_for_dependencies",
    });
  });

  it("reports an unavailable tick with zero admissions and no reconciliation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-tick-unavailable-"));
    roots.push(root);
    const queued = queueFederatedJobRecord({
      taskId: "TASK-100",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    const stale = {
      ...queueFederatedJobRecord({
        taskId: "TASK-101",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "assigned" as const,
      hostId: "host-1",
      lease: {
        leaseId: "lease-unavailable",
        hostId: "host-1",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-01T00:01:00.000Z",
      },
    };
    await Promise.all([saveFederatedJob(root, queued), saveFederatedJob(root, stale)]);
    const reconcileJobs = jest.fn().mockResolvedValue([]);
    const createWriter = jest.fn();

    const result = await runSwarmSchedulerTick(
      { projectRoot: root, taskService: null } as FederationProjectContext,
      { allowMissingPreflight: true },
      { createWriter, reconcileJobs },
    );

    expect(result.unavailable).toContain("TaskService is unavailable");
    expect(result.assigned).toEqual([]);
    expect(result.reconciled).toEqual([]);
    expect(result.blocked).toHaveLength(2);
    expect(reconcileJobs).not.toHaveBeenCalled();
    expect(createWriter).not.toHaveBeenCalled();
    expect((await loadFederatedJob(root, queued.jobId))?.status).toBe("blocked");
    expect((await loadFederatedJob(root, stale.jobId))?.status).toBe("blocked");
  });

  it("fails standalone dependency release closed when the strict scan is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-release-unavailable-"));
    roots.push(root);
    const blocked = {
      ...queueFederatedJobRecord({
        taskId: "TASK-200",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "blocked" as const,
      decision: { dependencyBlockers: ["TASK-100"] },
    };
    await saveFederatedJob(root, blocked);

    const released = await releaseFederatedDependencyBlocks(
      { projectRoot: root, taskService: null } as FederationProjectContext,
      "TASK-100",
    );

    expect(released).toEqual([]);
    const refusedJob = await loadFederatedJob(root, blocked.jobId);
    expect(refusedJob).toMatchObject({
      status: "blocked",
      decision: { dependencyBlockers: ["TASK-100"] },
    });
    expect(refusedJob?.error).toContain("duplicate_claimants_unavailable");
  });

  it("refuses an after-enqueue contest before stale recovery or assignment and scans once", async () => {
    const f = fixture();
    roots.push(f.root);
    const stale = {
      ...queueFederatedJobRecord({
        taskId: "TASK-100",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "assigned" as const,
      hostId: "host-1",
      lease: {
        leaseId: "lease-1",
        hostId: "host-1",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-01T00:01:00.000Z",
      },
    };
    await saveFederatedJob(f.root, stale);
    fs.writeFileSync(path.join(f.taskDir, "TASK-999-b.md"), spec("TASK-100"));
    let scans = 0;
    const result = await runSwarmSchedulerTick(
      f.context,
      {
        allowMissingPreflight: true,
      },
      {
        createWriter: jest.fn(),
        scanTaskClaimants: () => {
          scans += 1;
          return Promise.resolve([
            { fileName: "TASK-100-a.md", declaredId: "TASK-100" },
            { fileName: "TASK-999-b.md", declaredId: "TASK-100" },
          ]);
        },
        reconcileJobs: () => Promise.resolve([]),
      },
    );

    expect(scans).toBe(1);
    expect(result.assigned).toEqual([]);
    expect(
      result.blocked.some(
        (job) => job.taskId === "TASK-100" && job.error?.includes("duplicate_claimants"),
      ),
    ).toBe(true);
    expect((await loadFederatedJob(f.root, stale.jobId))?.status).toBe("blocked");
  });

  it.each(duplicateArms)(
    "refuses stale-lease auto-recovery for a %s duplicate in %s order",
    async (shape, order) => {
      const f = fixture();
      roots.push(f.root);
      const stale = {
        ...queueFederatedJobRecord({
          taskId: "TASK-100",
          jobType: "verify",
          requiredCapabilities: ["verify"],
          provenance,
        }),
        status: "assigned" as const,
        hostId: "host-1",
        lease: {
          leaseId: `lease-${shape}-${order}`,
          hostId: "host-1",
          acquiredAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2025-01-01T00:01:00.000Z",
        },
      };
      await saveFederatedJob(f.root, stale);
      const contest = addContest(f, shape, order);
      await expectBuiltClaimantOrder(f, contest.expectedClaimants);

      const recovered = await recoverStaleFederatedLeases(f.context);

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        jobId: stale.jobId,
        status: "blocked",
      });
      expect(recovered[0]?.error).toContain("duplicate_claimants:TASK-100");
      expect(recovered[0]?.lease).toBeUndefined();
      const persisted = await loadFederatedJob(f.root, stale.jobId);
      expect(persisted).toMatchObject({
        status: "blocked",
        hostId: "host-1",
        decision: { staleRecoveryMode: "manual_recovery" },
      });
      expect(persisted?.lease).toBeUndefined();
    },
  );

  it("stale recovery clean twin actually restores a queued job", async () => {
    const f = fixture();
    roots.push(f.root);
    const stale = {
      ...queueFederatedJobRecord({
        taskId: "TASK-100",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "assigned" as const,
      hostId: "host-1",
      lease: {
        leaseId: "lease-clean",
        hostId: "host-1",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-01T00:01:00.000Z",
      },
    };
    await saveFederatedJob(f.root, stale);
    const recovered = await recoverStaleFederatedLeases(f.context);
    expect(recovered).toEqual([expect.objectContaining({ status: "queued", lease: undefined })]);
  });

  it("enumerates the claimant producer once before stale recovery, reconciliation, and multiple assignments", async () => {
    const f = fixture();
    roots.push(f.root);
    await new ListenerRegistry(f.root).register({
      hostId: "host-wide",
      capabilities: ["verify", "fix"],
      maxConcurrentJobs: 10,
    });
    const stale = {
      ...queueFederatedJobRecord({
        taskId: "TASK-100",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        provenance,
      }),
      status: "assigned" as const,
      hostId: "host-stale",
      lease: {
        leaseId: "lease-performance",
        hostId: "host-stale",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-01T00:01:00.000Z",
      },
    };
    const queuedA = queueFederatedJobRecord({
      taskId: "TASK-100",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    const queuedB = queueFederatedJobRecord({
      taskId: "TASK-200",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance,
    });
    await Promise.all([
      saveFederatedJob(f.root, stale),
      saveFederatedJob(f.root, queuedA),
      saveFederatedJob(f.root, queuedB),
    ]);
    let scans = 0;
    let reconciliations = 0;
    const writer = {
      recordSession: jest.fn(),
      emit: jest.fn(),
    } as unknown as EventWriter;

    const result = await runSwarmSchedulerTick(
      f.context,
      { allowMissingPreflight: true },
      {
        createWriter: () => writer,
        scanTaskClaimants: () => {
          scans += 1;
          return Promise.resolve([
            { fileName: "TASK-100-a.md", declaredId: "TASK-100" },
            { fileName: "TASK-200.md", declaredId: "TASK-200" },
          ]);
        },
        reconcileJobs: async (_context, claimantIndex) => {
          reconciliations += 1;
          expect(claimantIndex?.status).toBe("scanned");
          const fix = queueFederatedJobRecord({
            taskId: "TASK-100",
            jobType: "fix",
            requiredCapabilities: ["fix"],
            provenance: { channel: "fix-orchestration" },
          });
          await saveFederatedJob(f.root, fix);
          return [fix];
        },
      },
    );

    expect(scans).toBe(1);
    expect(reconciliations).toBe(1);
    expect(result.recovered).toEqual([
      expect.objectContaining({ jobId: stale.jobId, status: "queued" }),
    ]);
    expect(result.assigned).toHaveLength(4);
    expect(result.assigned.map((job) => job.jobType)).toEqual(
      expect.arrayContaining(["verify", "verify", "verify", "fix"]),
    );
  });
});
