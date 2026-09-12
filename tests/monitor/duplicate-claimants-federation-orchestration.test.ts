import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { QuackDB } from "../../src/db/index.js";
import {
  buildFederationClaimantIndex,
  releaseFederatedDependencyBlocks,
} from "../../src/monitor/federation/scheduling.js";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs.js";
import {
  acquireFederatedMergeLock,
  orchestrateFederatedCompletion,
  reconcileFederatedJobs,
  setFederatedMergeLockRuntimeForTests,
  type FederatedMergeBoundary,
} from "../../src/monitor/federation/orchestration.js";
import {
  FederatedJobLockCompletedActionError,
  listFederatedJobs,
  loadFederatedJob,
  saveFederatedJob,
  setFederatedJobLockOptionsForTests,
  setFederatedJobPersistenceHookForTests,
  updateFederatedJob,
} from "../../src/monitor/federation/store.js";
import type {
  FederatedJobRecord,
  FederationProjectContext,
} from "../../src/monitor/federation/types.js";
import { TaskService } from "../../src/monitor/task-service.js";
import type { EventWriter } from "../../src/monitor/event-emitter.js";
import type { EventReader } from "../../src/monitor/event-reader.js";
import { runVerifyWorkflow } from "../../src/workflows/verify-orchestrator.js";

function taskSpec(taskId: string): string {
  return [
    `# ${taskId}: Orchestration fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Tags:** [federation]",
    "",
    "## Problem Statement",
    "Fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Keep terminal evidence writable.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/example.ts` | Modify | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Fixture works",
    "",
    "## Testing Requirements",
    "- [ ] Unit test passes",
  ].join("\n");
}

function makePublishingJob(
  jobId: string,
  taskId: string,
  sourceCommitSha: string,
): FederatedJobRecord {
  const queued = queueFederatedJobRecord({
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    projectId: "fixture",
    taskId,
    jobType: "dispatch",
    requiredCapabilities: ["dispatch"],
    provenance: { channel: "federation-queue" },
  });
  return {
    ...queued,
    jobId,
    status: "completed",
    completedAt: "2026-08-18T12:00:00.000Z",
    autoMerge: true,
    branchName: `quack/${taskId}`,
    commitSha: sourceCommitSha,
    targetBranch: "dev",
    mergeStatus: "publishing",
    nextAction: "merge_gate",
    mergeBinding: {
      version: 1,
      repository: { host: "github.com", owner: "fixture", repo: "project" },
      sourceBranch: `quack/${taskId}`,
      sourceCommitSha,
      targetBranch: "dev",
      publicationNonce:
        taskId === "TASK-710"
          ? "00000000-0000-4000-8000-000000000710"
          : "00000000-0000-4000-8000-000000000711",
      sealedAt: "2026-08-18T12:00:00.000Z",
    },
  };
}

describe("TASK-1338-F terminal orchestration token gate", () => {
  let root: string;
  let db: QuackDB;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-orchestration-"));
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    db = new QuackDB(path.join(root, ".quack", "quack.db"));
  });

  afterEach(() => {
    setFederatedJobPersistenceHookForTests(undefined);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "persists terminal evidence for a %s duplicate in %s order but authorizes no verification, fix, or reconciliation",
    async (shape, order) => {
      const taskDir = path.join(root, "docs", "tasks");
      const first = ["TASK-710-a.md", taskSpec("TASK-710")] as const;
      const second = [
        shape === "exact" ? "TASK-710-b.md" : "TASK-999-b.md",
        taskSpec("TASK-710"),
      ] as const;
      for (const [name, content] of order === "first-created" ? [second, first] : [first, second]) {
        fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
      }
      const p: FederationProjectContext = {
        projectId: "fixture",
        projectRoot: root,
        reader: {} as EventReader,
        taskService: new TaskService(root, "docs/tasks"),
        prepCache: null,
        db,
      };
      const initial = {
        ...queueFederatedJobRecord({
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          taskId: "TASK-710",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
        }),
        status: "completed" as const,
        completedAt: "2026-08-18T12:00:00.000Z",
        nextAction: "record_merge_ready_review",
      };
      await saveFederatedJob(root, initial);
      const claimantIndex = await buildFederationClaimantIndex(p);
      expect(claimantIndex.status).toBe("scanned");
      if (claimantIndex.status === "scanned") {
        expect(claimantIndex.contested.get("TASK-710")).toEqual(
          [first[0], second[0]].sort((a, b) => a.localeCompare(b)),
        );
      }
      const writer = { emit: jest.fn() } as unknown as EventWriter;
      const createWriter = jest.fn(() => writer);

      const result = await orchestrateFederatedCompletion(
        p,
        initial,
        {
          autoVerify: true,
          autoMerge: false,
          maxFixAttempts: 1,
          verification: {
            requireReview: false,
            criteriaChecked: 1,
            criteriaPassed: 0,
            phaseResults: [{ name: "tests", status: "failed", summary: "fixture" }],
          },
        },
        { createWriter },
        claimantIndex,
      );

      expect(result.job.status).toBe("completed");
      expect(result.job.error).toContain("duplicate_claimants:TASK-710");
      expect(result.fixJob).toBeUndefined();
      expect(result.verification).toBeUndefined();
      expect(createWriter).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, ".quack", "workflows"))).toBe(false);
      expect(db.getVerified("TASK-710")).toBeUndefined();
      const jobs = await listFederatedJobs(root);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.error).toContain("duplicate_claimants:TASK-710");
    },
  );

  test("clean control runs verification and creates the bounded fix job", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const writer = { emit: jest.fn() } as unknown as EventWriter;
    const createWriter = jest.fn(() => writer);

    const result = await orchestrateFederatedCompletion(
      p,
      initial,
      {
        autoVerify: true,
        autoMerge: false,
        maxFixAttempts: 1,
        verification: {
          requireReview: false,
          criteriaChecked: 1,
          criteriaPassed: 0,
          phaseResults: [{ name: "tests", status: "failed", summary: "fixture" }],
        },
      },
      { createWriter },
      claimantIndex,
    );

    expect(result.verification?.verdict).toBe("FAILED");
    expect(result.fixJob?.jobType).toBe("fix");
    expect(createWriter).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, ".quack", "workflows"))).toBe(true);
    expect(await listFederatedJobs(root)).toHaveLength(2);
  });

  test.each(["fix_intent_persisted", "fix_parent_persisted", "fix_child_persisted"] as const)(
    "reconciles one deterministic fix child after the %s crash point",
    async (crashStage) => {
      fs.writeFileSync(
        path.join(root, "docs", "tasks", "TASK-710-a.md"),
        taskSpec("TASK-710"),
        "utf-8",
      );
      const p: FederationProjectContext = {
        projectId: "fixture",
        projectRoot: root,
        reader: {} as EventReader,
        taskService: new TaskService(root, "docs/tasks"),
        prepCache: null,
        db,
      };
      const initial = {
        ...queueFederatedJobRecord({
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          taskId: "TASK-710",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
        }),
        status: "completed" as const,
        completedAt: "2026-08-18T12:00:00.000Z",
        nextAction: "record_merge_ready_review",
      };
      await saveFederatedJob(root, initial);
      const claimantIndex = await buildFederationClaimantIndex(p);
      const verification = {
        requireReview: false,
        criteriaChecked: 1,
        criteriaPassed: 0,
        phaseResults: [{ name: "tests", status: "failed" as const, summary: "fixture" }],
      };

      await expect(
        orchestrateFederatedCompletion(
          p,
          initial,
          { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
          {
            createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
            afterCompletionEffectForTest: (stage) => {
              if (stage === crashStage) throw new Error(`simulated crash at ${crashStage}`);
            },
          },
          claimantIndex,
        ),
      ).rejects.toThrow(`simulated crash at ${crashStage}`);

      const afterCrash = await listFederatedJobs(root);
      const parent = afterCrash.find((job) => job.jobId === initial.jobId);
      const children = afterCrash.filter((job) => job.parentJobId === initial.jobId);
      const intentName = fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .find((entry) => entry.endsWith(".intent"));
      expect(intentName).toEqual(expect.any(String));
      const intent = JSON.parse(
        fs.readFileSync(path.join(root, ".quack", "federation", "jobs", intentName!), "utf-8"),
      ) as { childRecord: { jobId: string } };
      const childId = intent.childRecord.jobId;
      expect(childId).toEqual(expect.any(String));
      if (crashStage === "fix_intent_persisted") {
        expect(parent).toMatchObject({
          status: "completed",
          nextAction: "record_merge_ready_review",
        });
        expect(parent?.fixJobIds).toBeUndefined();
      } else {
        expect(parent).toMatchObject({
          status: "blocked",
          error: "verification_failed_fix_queued",
          fixJobIds: [childId],
        });
      }
      expect(children).toHaveLength(crashStage === "fix_child_persisted" ? 1 : 0);
      if (children[0]) expect(children[0]).toMatchObject({ status: "queued", jobType: "fix" });
      expect(
        fs
          .readdirSync(path.join(root, ".quack", "federation", "jobs"))
          .some((entry) => entry.endsWith(".intent")),
      ).toBe(true);

      await expect(
        orchestrateFederatedCompletion(
          p,
          parent!,
          { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
          { createWriter: jest.fn() },
          claimantIndex,
        ),
      ).resolves.toMatchObject({
        job: { jobId: initial.jobId, fixJobIds: [childId] },
        fixJob: { jobId: childId },
      });
      expect(
        (await listFederatedJobs(root)).filter((job) => job.parentJobId === initial.jobId),
      ).toEqual([expect.objectContaining({ jobId: childId, status: "queued" })]);
      expect(
        fs
          .readdirSync(path.join(root, ".quack", "federation", "jobs"))
          .some((entry) => entry.endsWith(".intent")),
      ).toBe(false);
    },
  );

  test("retains and replays the completion intent when publication stops before durable ack", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };
    let injected = false;
    setFederatedJobPersistenceHookForTests((stage, target) => {
      if (
        !injected &&
        stage === "record_published" &&
        path.basename(target) === `${initial.jobId}.json`
      ) {
        injected = true;
        throw new Error("simulated crash before durable parent ack");
      }
    });

    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        { createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter) },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated crash before durable parent ack");
    expect(db.getVerified("TASK-710")).toBeUndefined();
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(true);

    setFederatedJobPersistenceHookForTests(undefined);
    const replayParent = await loadFederatedJob(root, initial.jobId);
    await expect(
      orchestrateFederatedCompletion(
        p,
        replayParent!,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        { createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter) },
        claimantIndex,
      ),
    ).resolves.toMatchObject({ job: { status: "completed", nextAction: "admin_review_merge" } });
    expect(db.getVerified("TASK-710")).toMatchObject({ verdict: "VERIFIED" });
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(false);
  });

  test("retains a verified intent while the claimant scan is unavailable and retires it after recovery", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };

    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "verification_row_persisted") {
              throw new Error("simulated crash after verification row");
            }
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated crash after verification row");
    expect(db.getVerified("TASK-710")).toMatchObject({ verdict: "VERIFIED" });
    expect(db.getStatus("TASK-710")).toBeUndefined();

    const intentDirectory = path.join(root, ".quack", "federation", "jobs");
    const hasIntent = (): boolean =>
      fs.readdirSync(intentDirectory).some((entry) => entry.endsWith(".intent"));
    expect(hasIntent()).toBe(true);

    await expect(
      reconcileFederatedJobs(
        p,
        { createWriter: jest.fn() },
        { status: "unavailable", reason: "simulated claimant scan outage" },
      ),
    ).resolves.toEqual([]);
    expect(hasIntent()).toBe(true);
    expect(db.getStatus("TASK-710")?.status).toBe("COMPLETE");
    expect(
      (
        JSON.parse(fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf-8")) as {
          tasks: Record<string, unknown>;
        }
      ).tasks["TASK-710"],
    ).toBeDefined();

    await expect(
      reconcileFederatedJobs(p, { createWriter: jest.fn() }, claimantIndex),
    ).resolves.toEqual([
      expect.objectContaining({
        jobId: initial.jobId,
        status: "completed",
        nextAction: "admin_review_merge",
      }),
    ]);
    expect(hasIntent()).toBe(false);
  });

  test("retains a verified intent until atomic projection publication is durably acknowledged", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };
    const intentDirectory = path.join(root, ".quack", "federation", "jobs");
    const hasIntent = (): boolean =>
      fs.readdirSync(intentDirectory).some((entry) => entry.endsWith(".intent"));

    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(),
          afterVerificationProjectionPersistenceStageForTest: (stage) => {
            if (stage === "projection_published") {
              throw new Error("simulated crash before published projection flush");
            }
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated crash before published projection flush");
    expect(hasIntent()).toBe(true);
    expect(db.getVerified("TASK-710")).toMatchObject({ verdict: "VERIFIED" });
    expect(db.getStatus("TASK-710")?.status).toBe("COMPLETE");

    const replayParent = await loadFederatedJob(root, initial.jobId);
    await expect(
      orchestrateFederatedCompletion(
        p,
        replayParent!,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        { createWriter: jest.fn() },
        claimantIndex,
      ),
    ).resolves.toMatchObject({ job: { status: "completed", nextAction: "admin_review_merge" } });
    expect(hasIntent()).toBe(false);
    expect(
      fs.readdirSync(path.join(root, ".quack")).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
    expect(
      (
        JSON.parse(fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf-8")) as {
          tasks: Record<string, unknown>;
        }
      ).tasks["TASK-710"],
    ).toBeDefined();
  });

  test("serializes verified projections across concurrent parent-job locks", async () => {
    for (const taskId of ["TASK-710", "TASK-711"]) {
      fs.writeFileSync(
        path.join(root, "docs", "tasks", `${taskId}-a.md`),
        taskSpec(taskId),
        "utf-8",
      );
    }
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const parents = ["TASK-710", "TASK-711"].map((taskId) => ({
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId,
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    }));
    await Promise.all(parents.map((parent) => saveFederatedJob(root, parent)));
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };
    let announceFirstRead!: () => void;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      announceFirstRead = resolve;
    });
    const mayWriteFirst = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let secondRead = false;

    const first = orchestrateFederatedCompletion(
      p,
      parents[0],
      { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
      {
        createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
        afterVerificationProjectionReadForTest: async () => {
          announceFirstRead();
          await mayWriteFirst;
        },
      },
      claimantIndex,
    );
    await firstRead;
    const second = orchestrateFederatedCompletion(
      p,
      parents[1],
      { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
      {
        createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
        afterVerificationProjectionReadForTest: () => {
          secondRead = true;
        },
      },
      claimantIndex,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondReadBeforeRelease = secondRead;
    releaseFirstRead();
    await Promise.all([first, second]);

    expect(secondReadBeforeRelease).toBe(false);
    const projection = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, unknown> };
    expect(Object.keys(projection.tasks).sort()).toEqual(["TASK-710", "TASK-711"]);
    expect(db.getAllVerified().size).toBe(2);
  });

  test.each([
    "verification_intent_persisted",
    "verification_parent_persisted",
    "verification_row_persisted",
    "verification_status_persisted",
    "verification_projection_persisted",
    "verification_dependencies_persisted",
    "verification_effects_persisted",
  ] as const)(
    "replays verified and dependency effects after the %s crash point without duplication",
    async (crashStage) => {
      fs.writeFileSync(
        path.join(root, "docs", "tasks", "TASK-710-a.md"),
        taskSpec("TASK-710"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(root, "docs", "tasks", "TASK-711-a.md"),
        taskSpec("TASK-711").replace("- **Blocked By:** []", "- **Blocked By:** [TASK-710]"),
        "utf-8",
      );
      const p: FederationProjectContext = {
        projectId: "fixture",
        projectRoot: root,
        reader: {} as EventReader,
        taskService: new TaskService(root, "docs/tasks"),
        prepCache: null,
        db,
      };
      const initial = {
        ...queueFederatedJobRecord({
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          taskId: "TASK-710",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
        }),
        status: "completed" as const,
        completedAt: "2026-08-18T12:00:00.000Z",
        nextAction: "record_merge_ready_review",
      };
      const dependent = {
        ...queueFederatedJobRecord({
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          taskId: "TASK-711",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
        }),
        status: "blocked" as const,
        error: "blocked_by_unresolved:TASK-710",
        decision: { dependencyBlockers: ["TASK-710"] },
      };
      await saveFederatedJob(root, initial);
      await saveFederatedJob(root, dependent);
      const claimantIndex = await buildFederationClaimantIndex(p);
      const verification = {
        requireReview: false,
        criteriaChecked: 1,
        criteriaPassed: 1,
        phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
      };

      await expect(
        orchestrateFederatedCompletion(
          p,
          initial,
          { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
          {
            createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
            afterCompletionEffectForTest: (stage) => {
              if (stage === crashStage) throw new Error(`simulated crash at ${crashStage}`);
            },
          },
          claimantIndex,
        ),
      ).rejects.toThrow(`simulated crash at ${crashStage}`);

      const verificationAfterCrash = db.getVerified("TASK-710");
      const rowWasPersisted = [
        "verification_row_persisted",
        "verification_status_persisted",
        "verification_projection_persisted",
        "verification_dependencies_persisted",
        "verification_effects_persisted",
      ].includes(crashStage);
      const statusWasPersisted = [
        "verification_status_persisted",
        "verification_projection_persisted",
        "verification_dependencies_persisted",
        "verification_effects_persisted",
      ].includes(crashStage);
      const projectionWasPersisted = [
        "verification_projection_persisted",
        "verification_dependencies_persisted",
        "verification_effects_persisted",
      ].includes(crashStage);
      const dependenciesWereProcessed = [
        "verification_dependencies_persisted",
        "verification_effects_persisted",
      ].includes(crashStage);
      if (rowWasPersisted) {
        expect(db.getVerified("TASK-710")).toMatchObject({ verdict: "VERIFIED" });
      } else {
        expect(db.getVerified("TASK-710")).toBeUndefined();
      }
      expect(db.getStatus("TASK-710")?.status).toBe(statusWasPersisted ? "COMPLETE" : undefined);
      const verifiedProjectionPath = path.join(root, ".quack", "verified.json");
      const projectedTasks = fs.existsSync(verifiedProjectionPath)
        ? (
            JSON.parse(fs.readFileSync(verifiedProjectionPath, "utf-8")) as {
              tasks?: Record<string, unknown>;
            }
          ).tasks
        : undefined;
      expect(Boolean(projectedTasks?.["TASK-710"])).toBe(projectionWasPersisted);
      expect(await loadFederatedJob(root, dependent.jobId)).toMatchObject({
        status: "blocked",
        error: dependenciesWereProcessed
          ? "preflight_gate_missing"
          : "blocked_by_unresolved:TASK-710",
      });
      const parent = await loadFederatedJob(root, initial.jobId);
      expect(parent).toMatchObject(
        crashStage === "verification_intent_persisted"
          ? { status: "completed", nextAction: "record_merge_ready_review" }
          : { status: "completed", nextAction: "admin_review_merge" },
      );

      await expect(
        orchestrateFederatedCompletion(
          p,
          parent!,
          { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
          { createWriter: jest.fn() },
          claimantIndex,
        ),
      ).resolves.toMatchObject({ job: { status: "completed", nextAction: "admin_review_merge" } });
      expect(db.getAllVerified().size).toBe(1);
      expect(db.getStatus("TASK-710")?.status).toBe("COMPLETE");
      expect(
        (
          JSON.parse(fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf-8")) as {
            tasks: Record<string, unknown>;
          }
        ).tasks["TASK-710"],
      ).toBeDefined();
      if (verificationAfterCrash) {
        expect(db.getVerified("TASK-710")).toEqual(verificationAfterCrash);
      }
      expect(await loadFederatedJob(root, dependent.jobId)).toMatchObject({
        status: "blocked",
        error: "preflight_gate_missing",
      });
      expect(
        fs
          .readdirSync(path.join(root, ".quack", "federation", "jobs"))
          .some((entry) => entry.endsWith(".intent")),
      ).toBe(false);
    },
  );

  test("replays dependency release when verification persisted before a crash", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-711-a.md"),
      taskSpec("TASK-711").replace("- **Blocked By:** []", "- **Blocked By:** [TASK-710]"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-712-a.md"),
      taskSpec("TASK-712").replace("- **Blocked By:** []", "- **Blocked By:** [TASK-710]"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    const dependent = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-711",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "blocked" as const,
      error: "blocked_by_unresolved:TASK-710",
      decision: { dependencyBlockers: ["TASK-710"] },
    };
    const secondDependent = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-712",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "blocked" as const,
      error: "blocked_by_unresolved:TASK-710",
      decision: { dependencyBlockers: ["TASK-710"] },
    };
    await saveFederatedJob(root, initial);
    await saveFederatedJob(root, dependent);
    await saveFederatedJob(root, secondDependent);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };

    let releaseAttempts = 0;
    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          releaseDependencyBlocks: async (context, taskId, index) => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              await updateFederatedJob(root, dependent.jobId, (current) => ({
                ...current,
                error: "preflight_gate_missing",
                nextAction: "run_preflight",
              }));
              throw new Error("dependency write interrupted");
            }
            return releaseFederatedDependencyBlocks(context, taskId, index);
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("dependency write interrupted");
    expect(db.getVerified("TASK-710")).toMatchObject({ verdict: "VERIFIED" });
    expect(await loadFederatedJob(root, dependent.jobId)).toMatchObject({
      error: "preflight_gate_missing",
    });

    const parent = await loadFederatedJob(root, initial.jobId);
    await updateFederatedJob(root, initial.jobId, (current) => ({
      ...current,
      status: "canceled",
      canceledBy: "operator-after-partial-verification",
      nextAction: "canceled",
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
    }));
    await expect(
      orchestrateFederatedCompletion(
        p,
        (await loadFederatedJob(root, initial.jobId))!,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(),
          releaseDependencyBlocks: (context, taskId, index) =>
            releaseFederatedDependencyBlocks(context, taskId, index),
        },
        claimantIndex,
      ),
    ).resolves.toMatchObject({ job: { status: "canceled", nextAction: "canceled" } });
    expect(db.getAllVerified().size).toBe(1);
    expect(await loadFederatedJob(root, dependent.jobId)).toMatchObject({
      error: "preflight_gate_missing",
    });
    expect(await loadFederatedJob(root, secondDependent.jobId)).toMatchObject({
      error: "preflight_gate_missing",
    });
    expect(releaseAttempts).toBe(1);
    expect(parent).toMatchObject({ status: "completed", nextAction: "admin_review_merge" });
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(false);
  });

  test("keeps a completion intent fail closed when newer verification evidence wins", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };
    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "verification_parent_persisted") {
              throw new Error("simulated pre-verification crash");
            }
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated pre-verification crash");

    const newer = {
      task_id: "TASK-710",
      verified_at: "2099-01-01",
      updated_at: "2099-01-01T00:00:00.000Z",
      commit_sha: "ffffffffffffffffffffffffffffffffffffffff",
      method: "operator-review",
      verdict: "VERIFIED" as const,
      criteria_checked: 1,
      criteria_passed: 1,
      notes: "newer independent evidence",
    };
    db.setVerified(newer);
    const parent = await loadFederatedJob(root, initial.jobId);
    await expect(
      orchestrateFederatedCompletion(
        p,
        parent!,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        { createWriter: jest.fn() },
        claimantIndex,
      ),
    ).rejects.toThrow("completion_intent_verification_conflict:stale");
    expect(db.getVerified("TASK-710")).toEqual(newer);
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(true);
  });

  test("reconciliation contains a retained verification conflict and advances a later job", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-711-a.md"),
      taskSpec("TASK-711"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const conflicted = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      jobId: "aaa-conflicted-job",
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    const eligible = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-711",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      jobId: "zzz-eligible-after-conflict",
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, conflicted);
    await saveFederatedJob(root, eligible);
    const claimantIndex = await buildFederationClaimantIndex(p);
    const verification = {
      requireReview: false,
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
    };

    await expect(
      orchestrateFederatedCompletion(
        p,
        conflicted,
        { autoVerify: true, autoMerge: false, maxFixAttempts: 1, verification },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "verification_parent_persisted") {
              throw new Error("simulated pre-verification crash");
            }
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated pre-verification crash");

    db.setVerified({
      task_id: "TASK-710",
      verified_at: "2099-01-01",
      updated_at: "2099-01-01T00:00:00.000Z",
      commit_sha: "ffffffffffffffffffffffffffffffffffffffff",
      method: "operator-review",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: "newer independent evidence",
    });

    await expect(
      reconcileFederatedJobs(
        p,
        { createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter) },
        claimantIndex,
      ),
    ).resolves.toEqual([expect.objectContaining({ jobId: eligible.jobId, status: "blocked" })]);
    expect(await loadFederatedJob(root, eligible.jobId)).toMatchObject({
      status: "blocked",
      nextAction: "record_merge_ready_review",
    });
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(true);
  });

  test.each([
    ["missing", undefined],
    ["invalid", "probe"],
  ] as const)(
    "contains %s positive proof without changing its intent and advances a later valid intent",
    async (_label, commitSha) => {
      const taskDir = path.join(root, "docs", "tasks");
      for (const taskId of ["TASK-710", "TASK-711"])
        fs.writeFileSync(path.join(taskDir, `${taskId}.md`), taskSpec(taskId));
      const p: FederationProjectContext = {
        projectId: "fixture",
        projectRoot: root,
        reader: {} as EventReader,
        taskService: new TaskService(root, "docs/tasks"),
        prepCache: null,
        db,
      };
      const makeJob = (
        taskId: string,
        jobId: string,
        sourceCommit: string | undefined,
      ): FederatedJobRecord => ({
        ...queueFederatedJobRecord({
          taskId,
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
          commitSha: sourceCommit,
        }),
        jobId,
        status: "completed",
        nextAction: "record_merge_ready_review",
      });
      const invalid = makeJob("TASK-710", "aaa-invalid-proof", commitSha);
      const valid = makeJob(
        "TASK-711",
        "zzz-valid-proof",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );
      await saveFederatedJob(root, invalid);
      await saveFederatedJob(root, valid);
      db.setStatus(invalid.taskId, "IN_PROGRESS", "fixture");
      const statusBefore = db.getStatus(invalid.taskId);
      const projectionPath = path.join(root, ".quack", "verified.json");
      const projectionBefore = JSON.stringify({ tasks: {}, retained: "original projection" });
      fs.writeFileSync(projectionPath, projectionBefore);
      const verification = {
        requireReview: false,
        criteriaChecked: 1,
        criteriaPassed: 1,
        phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
      };
      const createWriter = () => ({ emit: jest.fn() }) as unknown as EventWriter;
      await expect(
        orchestrateFederatedCompletion(
          p,
          invalid,
          { autoVerify: true, autoMerge: false, verification },
          { createWriter },
        ),
      ).rejects.toThrow("Positive verification requires");
      const invalidIntentPath = path.join(
        root,
        ".quack",
        "federation",
        "jobs",
        `.completion-effect-${createHash("sha256").update(invalid.jobId).digest("hex")}.intent`,
      );
      const intentBefore = fs.readFileSync(invalidIntentPath);
      const parentBefore = await loadFederatedJob(root, invalid.jobId);
      expect(db.getVerified(invalid.taskId)).toBeUndefined();
      expect(db.getVerifiedHistory(invalid.taskId)).toEqual([]);
      expect(db.getStatus(invalid.taskId)).toEqual(statusBefore);
      expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
      await expect(
        orchestrateFederatedCompletion(
          p,
          valid,
          { autoVerify: true, autoMerge: false, verification },
          {
            createWriter,
            afterCompletionEffectForTest(stage) {
              if (stage === "verification_parent_persisted")
                throw new Error("retain valid intent for sweep");
            },
          },
        ),
      ).rejects.toThrow("retain valid intent for sweep");
      const reconciled = await reconcileFederatedJobs(p, { createWriter });
      expect(reconciled.map((job) => job.jobId)).toEqual([valid.jobId]);
      expect(reconciled[0]?.status).toBe("completed");
      expect(fs.readFileSync(invalidIntentPath)).toEqual(intentBefore);
      expect(await loadFederatedJob(root, invalid.jobId)).toEqual(parentBefore);
      expect(db.getVerified(invalid.taskId)).toBeUndefined();
      expect(db.getVerifiedHistory(invalid.taskId)).toEqual([]);
      expect(db.getStatus(invalid.taskId)).toEqual(statusBefore);
      expect(db.getVerified(valid.taskId)?.commit_sha).toBe(valid.commitSha);
      const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as {
        retained: string;
        tasks: Record<string, { commit: string }>;
      };
      expect(projection.retained).toBe("original projection");
      expect(projection.tasks[invalid.taskId]).toBeUndefined();
      expect(projection.tasks[valid.taskId].commit).toBe(valid.commitSha);
    },
  );

  test("materializes a canceled fix child when cancellation follows the parent journal cut", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        {
          autoVerify: true,
          autoMerge: false,
          maxFixAttempts: 1,
          verification: {
            requireReview: false,
            criteriaChecked: 1,
            criteriaPassed: 0,
            phaseResults: [{ name: "tests", status: "failed", summary: "fixture" }],
          },
        },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "fix_parent_persisted") throw new Error("simulated fix crash");
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated fix crash");

    await updateFederatedJob(root, initial.jobId, (current) => ({
      ...current,
      status: "canceled",
      canceledBy: "operator-after-crash",
      nextAction: "canceled",
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
    }));
    await expect(
      reconcileFederatedJobs(p, { createWriter: jest.fn() }, claimantIndex),
    ).resolves.toEqual([expect.objectContaining({ jobId: initial.jobId, status: "canceled" })]);

    const jobs = await listFederatedJobs(root);
    expect(jobs.find((job) => job.jobId === initial.jobId)).toMatchObject({ status: "canceled" });
    expect(jobs.filter((job) => job.parentJobId === initial.jobId)).toEqual([
      expect.objectContaining({ status: "canceled", error: "parent_completion_canceled" }),
    ]);
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(false);
  });

  test("retires a pre-child fix intent after cancellation even when claimant scanning is unavailable", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        {
          autoVerify: true,
          autoMerge: false,
          maxFixAttempts: 1,
          verification: {
            requireReview: false,
            criteriaChecked: 1,
            criteriaPassed: 0,
            phaseResults: [{ name: "tests", status: "failed", summary: "fixture" }],
          },
        },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "fix_intent_persisted") throw new Error("simulated pre-child crash");
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated pre-child crash");

    await updateFederatedJob(root, initial.jobId, (current) => ({
      ...current,
      status: "canceled",
      canceledBy: "operator-after-crash",
      nextAction: "canceled",
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
    }));

    await expect(
      reconcileFederatedJobs(
        p,
        { createWriter: jest.fn() },
        { status: "unavailable", reason: "fixture scan outage" },
      ),
    ).resolves.toEqual([expect.objectContaining({ jobId: initial.jobId, status: "canceled" })]);
    expect(
      (await listFederatedJobs(root)).filter((job) => job.parentJobId === initial.jobId),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(false);
  });

  test("retires a pre-effect verified intent after cancellation while claimant scanning is unavailable", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, initial);
    const claimantIndex = await buildFederationClaimantIndex(p);
    await expect(
      orchestrateFederatedCompletion(
        p,
        initial,
        {
          autoVerify: true,
          autoMerge: false,
          maxFixAttempts: 1,
          verification: {
            requireReview: false,
            criteriaChecked: 1,
            criteriaPassed: 1,
            phaseResults: [{ name: "tests", status: "passed", summary: "fixture" }],
          },
        },
        {
          createWriter: jest.fn(() => ({ emit: jest.fn() }) as unknown as EventWriter),
          afterCompletionEffectForTest: (stage) => {
            if (stage === "verification_intent_persisted") {
              throw new Error("simulated pre-effect crash");
            }
          },
        },
        claimantIndex,
      ),
    ).rejects.toThrow("simulated pre-effect crash");

    await updateFederatedJob(root, initial.jobId, (current) => ({
      ...current,
      status: "canceled",
      canceledBy: "operator-after-crash",
      nextAction: "canceled",
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
    }));
    await expect(
      reconcileFederatedJobs(
        p,
        { createWriter: jest.fn() },
        { status: "unavailable", reason: "fixture scan outage" },
      ),
    ).resolves.toEqual([expect.objectContaining({ jobId: initial.jobId, status: "canceled" })]);
    expect(db.getVerified("TASK-710")).toBeUndefined();
    expect(
      fs
        .readdirSync(path.join(root, ".quack", "federation", "jobs"))
        .some((entry) => entry.endsWith(".intent")),
    ).toBe(false);
  });

  test.each([
    {
      label: "failed verification",
      phaseResults: [{ name: "tests", status: "failed" as const, summary: "fixture" }],
      criteriaPassed: 0,
      requireReview: false,
      autoMerge: false,
    },
    {
      label: "successful verification",
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
      criteriaPassed: 1,
      requireReview: false,
      autoMerge: true,
    },
    {
      label: "blocked review linkage",
      phaseResults: [{ name: "tests", status: "passed" as const, summary: "fixture" }],
      criteriaPassed: 1,
      requireReview: true,
      autoMerge: true,
    },
  ])(
    "lets cancellation win during $label without creating fix or verified state",
    async ({ phaseResults, criteriaPassed, requireReview, autoMerge }) => {
      fs.writeFileSync(
        path.join(root, "docs", "tasks", "TASK-710-a.md"),
        taskSpec("TASK-710"),
        "utf-8",
      );
      const p: FederationProjectContext = {
        projectId: "fixture",
        projectRoot: root,
        reader: {} as EventReader,
        taskService: new TaskService(root, "docs/tasks"),
        prepCache: null,
        db,
      };
      const initial = {
        ...queueFederatedJobRecord({
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          taskId: "TASK-710",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
          provenance: { channel: "federation-queue" },
        }),
        status: "completed" as const,
        completedAt: "2026-08-18T12:00:00.000Z",
        nextAction: "record_merge_ready_review",
      };
      await saveFederatedJob(root, initial);
      const claimantIndex = await buildFederationClaimantIndex(p);
      const writer = { emit: jest.fn() } as unknown as EventWriter;
      const createWriter = jest.fn(() => writer);
      const mergeBoundary: FederatedMergeBoundary = {
        seal: jest.fn(() => Promise.reject(new Error("canceled verification reached merge seal"))),
        merge: jest.fn(() => Promise.reject(new Error("canceled verification reached merge"))),
      };
      let verificationFinished!: () => void;
      const verificationFinishedPromise = new Promise<void>((resolve) => {
        verificationFinished = resolve;
      });
      let releaseVerification!: () => void;
      const verificationRelease = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      const verifyWorkflow = jest.fn(async (input: Parameters<typeof runVerifyWorkflow>[0]) => {
        const result = await runVerifyWorkflow(input);
        verificationFinished();
        await verificationRelease;
        return result;
      });

      const orchestration = orchestrateFederatedCompletion(
        p,
        initial,
        {
          autoVerify: true,
          autoMerge,
          maxFixAttempts: 1,
          verification: {
            requireReview,
            criteriaChecked: 1,
            criteriaPassed,
            phaseResults,
          },
        },
        { createWriter, verifyWorkflow, mergeBoundary },
        claimantIndex,
      );
      await verificationFinishedPromise;
      await updateFederatedJob(root, initial.jobId, (current) => ({
        ...current,
        status: "canceled",
        canceledBy: "race-test",
        nextAction: "canceled",
        updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
      }));
      releaseVerification();

      const result = await orchestration;
      expect(result.job).toMatchObject({ status: "canceled", canceledBy: "race-test" });
      expect(result.fixJob).toBeUndefined();
      expect(createWriter).not.toHaveBeenCalled();
      expect(mergeBoundary.seal).not.toHaveBeenCalled();
      expect(mergeBoundary.merge).not.toHaveBeenCalled();
      expect(await listFederatedJobs(root)).toEqual([
        expect.objectContaining({ jobId: initial.jobId, status: "canceled" }),
      ]);
      expect(db.getVerified("TASK-710")).toBeUndefined();
    },
  );

  test("unavailable strict scan preserves terminal evidence and creates no automatic fix", async () => {
    const p = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    } as FederationProjectContext;
    const initial = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
    };
    await saveFederatedJob(root, initial);
    const createWriter = jest.fn();

    const result = await orchestrateFederatedCompletion(
      p,
      initial,
      {
        autoVerify: true,
        autoMerge: false,
        maxFixAttempts: 1,
        verification: {
          criteriaChecked: 1,
          criteriaPassed: 0,
          phaseResults: [{ name: "tests", status: "failed" }],
        },
      },
      { createWriter },
    );

    expect(result.job.status).toBe("completed");
    expect(result.job.error).toContain("duplicate_claimants_unavailable");
    expect(result.verification).toBeUndefined();
    expect(result.fixJob).toBeUndefined();
    expect(createWriter).not.toHaveBeenCalled();
    expect(await listFederatedJobs(root)).toHaveLength(1);
    expect(db.getVerified("TASK-710")).toBeUndefined();
  });

  test("holds the heartbeat-backed admission lease through publication receipt", async () => {
    const sourceA = "1111111111111111111111111111111111111111";
    const sourceB = "2222222222222222222222222222222222222222";
    const mergeA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const mergeB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = makePublishingJob("fed-publishing-710", "TASK-710", sourceA);
    const second = makePublishingJob("fed-publishing-711", "TASK-711", sourceB);
    await saveFederatedJob(root, first);
    await saveFederatedJob(root, second);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    let firstMergeEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstMergeEntered = resolve;
    });
    let releaseFirstMerge!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstMerge = resolve;
    });
    const mergeBoundary: FederatedMergeBoundary = {
      seal: jest.fn(() => Promise.reject(new Error("recovery must reuse the durable binding"))),
      merge: jest.fn(async (input) => {
        if (input.taskId === first.taskId) {
          firstMergeEntered();
          await firstRelease;
          return { ok: true as const, commitSha: mergeA, commands: 1 };
        }
        return { ok: true as const, commitSha: mergeB, commands: 1 };
      }),
    };
    const deps = {
      createWriter: jest.fn(),
      mergeBoundary,
      broadcastRefresh: jest.fn(() => Promise.resolve(0)),
    };
    setFederatedJobLockOptionsForTests({
      retryMs: 1,
      waitTimeoutMs: 100,
      staleMs: 10,
      heartbeatMs: 2,
    });

    try {
      const firstRun = orchestrateFederatedCompletion(
        p,
        first,
        { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
        deps,
      );
      await firstEntered;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      const secondRun = await orchestrateFederatedCompletion(
        p,
        second,
        { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
        deps,
      );
      expect(secondRun.merge).toEqual({ ok: false, error: "merge_lane_busy", commands: 0 });
      expect(mergeBoundary.merge).toHaveBeenCalledTimes(1);

      releaseFirstMerge();
      await expect(firstRun).resolves.toMatchObject({
        job: { jobId: first.jobId, mergeStatus: "merged", mergeCommitSha: mergeA },
        merge: { ok: true, commitSha: mergeA },
      });
      expect(mergeBoundary.merge).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstMerge();
      setFederatedJobLockOptionsForTests(undefined);
    }
  });

  test("delegates a blocked merge-lock release durably and reconciles it before reuse", async () => {
    const sourceA = "1111111111111111111111111111111111111111";
    const sourceB = "2222222222222222222222222222222222222222";
    const mergeA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const mergeB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = makePublishingJob("fed-release-710", "TASK-710", sourceA);
    const second = makePublishingJob("fed-release-711", "TASK-711", sourceB);
    await saveFederatedJob(root, first);
    await saveFederatedJob(root, second);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    const mergeBoundary: FederatedMergeBoundary = {
      seal: jest.fn(() => Promise.reject(new Error("recovery must reuse the durable binding"))),
      merge: jest.fn((input) =>
        Promise.resolve({
          ok: true as const,
          commitSha: input.taskId === first.taskId ? mergeA : mergeB,
          commands: 1,
        }),
      ),
    };
    const deps = {
      createWriter: jest.fn(),
      mergeBoundary,
      broadcastRefresh: jest.fn(() => Promise.resolve(0)),
    };
    const lockPath = path.join(root, ".quack", "federation", "merge.lock");
    let blockCanonicalRename = true;
    let blockQuarantineUnlink = false;
    let transientQuarantineUnlinkFailures = 0;
    let blockedRenameAttempts = 0;
    let blockedUnlinkAttempts = 0;
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    setFederatedMergeLockRuntimeForTests({
      retryMs: 1,
      retryTimeoutMs: 50,
      renamePath: async (source, destination) => {
        if (blockCanonicalRename && source === lockPath) {
          blockedRenameAttempts += 1;
          const error = new Error("simulated Windows sharing violation") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await fs.promises.rename(source, destination);
      },
      unlinkPath: async (target) => {
        if (
          path.basename(target).startsWith("merge.lock.release-quarantine.") &&
          (blockQuarantineUnlink || transientQuarantineUnlinkFailures > 0)
        ) {
          blockedUnlinkAttempts += 1;
          if (transientQuarantineUnlinkFailures > 0) {
            transientQuarantineUnlinkFailures -= 1;
          }
          const error = new Error(
            "simulated Windows quarantine sharing violation",
          ) as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        await fs.promises.unlink(target);
      },
    });

    try {
      await expect(
        orchestrateFederatedCompletion(
          p,
          first,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          deps,
        ),
      ).resolves.toMatchObject({
        job: { jobId: first.jobId, mergeStatus: "merged", mergeCommitSha: mergeA },
        merge: { ok: true, commitSha: mergeA },
      });
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(blockedRenameAttempts).toBeGreaterThan(1);
      expect(
        fs
          .readdirSync(path.dirname(lockPath))
          .filter((entry) => entry.startsWith("merge.lock.release.")),
      ).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("durably pending"));

      blockCanonicalRename = false;
      blockQuarantineUnlink = true;
      await expect(
        orchestrateFederatedCompletion(
          p,
          second,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          deps,
        ),
      ).rejects.toMatchObject({ code: "EBUSY" });
      expect(blockedUnlinkAttempts).toBeGreaterThan(1);
      expect(mergeBoundary.merge).toHaveBeenCalledTimes(1);
      expect(await loadFederatedJob(root, first.jobId)).toMatchObject({
        mergeStatus: "merged",
        mergeCommitSha: mergeA,
      });

      blockQuarantineUnlink = false;
      transientQuarantineUnlinkFailures = 2;
      await expect(
        orchestrateFederatedCompletion(
          p,
          second,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          deps,
        ),
      ).resolves.toMatchObject({
        job: { jobId: second.jobId, mergeStatus: "merged", mergeCommitSha: mergeB },
        merge: { ok: true, commitSha: mergeB },
      });
      expect(transientQuarantineUnlinkFailures).toBe(0);
      expect(mergeBoundary.merge).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(
        fs
          .readdirSync(path.dirname(lockPath))
          .filter(
            (entry) =>
              entry.startsWith("merge.lock.release.") ||
              entry.startsWith("merge.lock.release-quarantine.") ||
              entry.startsWith("merge.lock.owner."),
          ),
      ).toEqual([]);
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      warning.mockRestore();
    }
  });

  test("surfaces nondurable merge-lock cleanup without losing the completed result", async () => {
    const source = "1111111111111111111111111111111111111111";
    const mergeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const job = makePublishingJob("fed-release-undurable", "TASK-710", source);
    await saveFederatedJob(root, job);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    const mergeBoundary: FederatedMergeBoundary = {
      seal: jest.fn(() => Promise.reject(new Error("recovery must reuse the durable binding"))),
      merge: jest.fn(() =>
        Promise.resolve({ ok: true as const, commitSha: mergeCommit, commands: 1 }),
      ),
    };
    setFederatedMergeLockRuntimeForTests({
      retryMs: 1,
      retryTimeoutMs: 5,
      linkPath: async (sourcePath, destinationPath) => {
        if (path.basename(destinationPath).startsWith("merge.lock.release.")) {
          const error = new Error("release intent unavailable") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await fs.promises.link(sourcePath, destinationPath);
      },
    });

    try {
      let observed: unknown;
      try {
        await orchestrateFederatedCompletion(
          p,
          job,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          {
            createWriter: jest.fn(),
            mergeBoundary,
            broadcastRefresh: jest.fn(() => Promise.resolve(0)),
          },
        );
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
      expect((observed as FederatedJobLockCompletedActionError).result).toMatchObject({
        acquired: true,
        value: {
          job: { jobId: job.jobId, mergeStatus: "merged", mergeCommitSha: mergeCommit },
          merge: { ok: true, commitSha: mergeCommit },
        },
      });
      expect(await loadFederatedJob(root, job.jobId)).toMatchObject({
        mergeStatus: "merged",
        mergeCommitSha: mergeCommit,
      });

      setFederatedMergeLockRuntimeForTests({});
      await expect(
        acquireFederatedMergeLock(root, "fed-release-recovered", "TASK-711"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
    }
  });

  test("treats a release hard link as nondurable until its published file flush succeeds", async () => {
    const source = "1111111111111111111111111111111111111111";
    const mergeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const job = makePublishingJob("fed-release-sync-undurable", "TASK-710", source);
    await saveFederatedJob(root, job);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    setFederatedMergeLockRuntimeForTests({
      syncPublishedReleaseFile: () =>
        Promise.reject(new Error("injected merge release file flush failure")),
    });
    let observed: unknown;

    try {
      try {
        await orchestrateFederatedCompletion(
          p,
          job,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          {
            createWriter: jest.fn(),
            mergeBoundary: {
              seal: jest.fn(() => Promise.reject(new Error("must reuse durable binding"))),
              merge: jest.fn(() =>
                Promise.resolve({ ok: true as const, commitSha: mergeCommit, commands: 1 }),
              ),
            },
            broadcastRefresh: jest.fn(() => Promise.resolve(0)),
          },
        );
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
      expect((observed as FederatedJobLockCompletedActionError).result).toMatchObject({
        acquired: true,
        value: { job: { mergeStatus: "merged", mergeCommitSha: mergeCommit } },
      });
      expect(await loadFederatedJob(root, job.jobId)).toMatchObject({
        mergeStatus: "merged",
        mergeCommitSha: mergeCommit,
      });

      setFederatedMergeLockRuntimeForTests(undefined);
      await expect(
        acquireFederatedMergeLock(root, "fed-release-sync-recovered", "TASK-711"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
    }
  });

  test("does not report merge cleanup durable before its final directory sync", async () => {
    const source = "1111111111111111111111111111111111111111";
    const mergeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const job = makePublishingJob("fed-release-final-sync", "TASK-710", source);
    await saveFederatedJob(root, job);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    let syncCalls = 0;
    setFederatedMergeLockRuntimeForTests({
      syncDirectory: () => {
        syncCalls += 1;
        if (syncCalls === 3) return Promise.reject(new Error("injected merge final sync failure"));
        return Promise.resolve();
      },
    });
    let observed: unknown;

    try {
      try {
        await orchestrateFederatedCompletion(
          p,
          job,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          {
            createWriter: jest.fn(),
            mergeBoundary: {
              seal: jest.fn(() => Promise.reject(new Error("must reuse durable binding"))),
              merge: jest.fn(() =>
                Promise.resolve({ ok: true as const, commitSha: mergeCommit, commands: 1 }),
              ),
            },
            broadcastRefresh: jest.fn(() => Promise.resolve(0)),
          },
        );
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
      expect((observed as FederatedJobLockCompletedActionError).result).toMatchObject({
        acquired: true,
        value: { job: { mergeStatus: "merged", mergeCommitSha: mergeCommit } },
      });
      expect(syncCalls).toBe(3);

      setFederatedMergeLockRuntimeForTests(undefined);
      await expect(
        acquireFederatedMergeLock(root, "fed-release-final-sync-recovered", "TASK-711"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
    }
  });

  test("retires only an old release inode when canonical has byte-identical replacement bytes", async () => {
    const source = "1111111111111111111111111111111111111111";
    const mergeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const job = makePublishingJob("fed-release-replacement", "TASK-710", source);
    await saveFederatedJob(root, job);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    const lockPath = path.join(root, ".quack", "federation", "merge.lock");
    let replacementIdentity: { dev: number; ino: number } | undefined;
    setFederatedMergeLockRuntimeForTests({
      linkPath: async (sourcePath, destinationPath) => {
        await fs.promises.link(sourcePath, destinationPath);
        if (
          !replacementIdentity &&
          path.basename(destinationPath).startsWith("merge.lock.release.")
        ) {
          const bytes = fs.readFileSync(lockPath);
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, bytes);
          const stat = fs.lstatSync(lockPath);
          replacementIdentity = { dev: stat.dev, ino: stat.ino };
        }
      },
    });

    try {
      await expect(
        orchestrateFederatedCompletion(
          p,
          job,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          {
            createWriter: jest.fn(),
            mergeBoundary: {
              seal: jest.fn(() => Promise.reject(new Error("must reuse durable binding"))),
              merge: jest.fn(() =>
                Promise.resolve({ ok: true as const, commitSha: mergeCommit, commands: 1 }),
              ),
            },
            broadcastRefresh: jest.fn(() => Promise.resolve(0)),
          },
        ),
      ).resolves.toMatchObject({ merge: { ok: true, commitSha: mergeCommit } });
      expect(replacementIdentity).toBeDefined();
      expect(fs.existsSync(lockPath)).toBe(true);
      const survivingReplacement = fs.lstatSync(lockPath);
      expect({ dev: survivingReplacement.dev, ino: survivingReplacement.ino }).toEqual(
        replacementIdentity,
      );
      expect(
        fs
          .readdirSync(path.dirname(lockPath))
          .filter(
            (entry) =>
              entry.startsWith("merge.lock.release.") || entry.startsWith("merge.lock.owner."),
          ),
      ).toEqual([]);

      const stale = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
      stale.acquiredAt = "2020-01-01T00:00:00.000Z";
      fs.writeFileSync(lockPath, JSON.stringify(stale), "utf-8");
      fs.utimesSync(lockPath, new Date(0), new Date(0));
      setFederatedJobLockOptionsForTests({
        currentProcessIdentityForTest: { bootId: "replacement-next", startedAt: "2" },
        processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
      });
      setFederatedMergeLockRuntimeForTests({});
      await expect(
        acquireFederatedMergeLock(root, "fed-release-replacement-next", "TASK-711"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      setFederatedJobLockOptionsForTests(undefined);
    }
  });

  test("preserves a byte-identical replacement owner sidecar during merge release", async () => {
    const source = "1111111111111111111111111111111111111111";
    const mergeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const job = makePublishingJob("fed-release-owner-replacement", "TASK-710", source);
    await saveFederatedJob(root, job);
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: null,
      prepCache: null,
      db,
    };
    let ownerPath: string | undefined;
    let replacementIdentity: { dev: number; ino: number } | undefined;
    let swapped = false;
    setFederatedMergeLockRuntimeForTests({
      linkPath: async (sourcePath, destinationPath) => {
        if (path.basename(destinationPath) === "merge.lock") ownerPath = sourcePath;
        await fs.promises.link(sourcePath, destinationPath);
      },
      renamePath: async (sourcePath, destinationPath) => {
        if (!swapped && ownerPath === sourcePath && destinationPath.includes(".retired.")) {
          swapped = true;
          const bytes = fs.readFileSync(sourcePath);
          fs.unlinkSync(sourcePath);
          fs.writeFileSync(sourcePath, bytes);
          const stat = fs.lstatSync(sourcePath);
          replacementIdentity = { dev: stat.dev, ino: stat.ino };
        }
        await fs.promises.rename(sourcePath, destinationPath);
      },
    });

    try {
      await expect(
        orchestrateFederatedCompletion(
          p,
          job,
          { autoVerify: true, autoMerge: true, maxFixAttempts: 0 },
          {
            createWriter: jest.fn(),
            mergeBoundary: {
              seal: jest.fn(() => Promise.reject(new Error("must reuse durable binding"))),
              merge: jest.fn(() =>
                Promise.resolve({ ok: true as const, commitSha: mergeCommit, commands: 1 }),
              ),
            },
            broadcastRefresh: jest.fn(() => Promise.resolve(0)),
          },
        ),
      ).resolves.toMatchObject({ merge: { ok: true, commitSha: mergeCommit } });
      expect(swapped).toBe(true);
      expect(ownerPath).toEqual(expect.any(String));
      expect(replacementIdentity).toBeDefined();
      const survivingReplacement = fs.lstatSync(ownerPath!);
      expect({ dev: survivingReplacement.dev, ino: survivingReplacement.ino }).toEqual(
        replacementIdentity,
      );
      expect(
        fs
          .readdirSync(path.join(root, ".quack", "federation"))
          .filter((entry) => entry.startsWith("merge.lock.release.")),
      ).toEqual([]);
      await expect(
        acquireFederatedMergeLock(root, "fed-owner-replacement-next", "TASK-711"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
    }
  });

  test("reconciliation skips a busy job and continues to another eligible job", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-710-a.md"),
      taskSpec("TASK-710"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-711-a.md"),
      taskSpec("TASK-711"),
      "utf-8",
    );
    const p: FederationProjectContext = {
      projectId: "fixture",
      projectRoot: root,
      reader: {} as EventReader,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: null,
      db,
    };
    const busy = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-710",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      jobId: "aaa-busy-job",
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    const eligible = {
      ...queueFederatedJobRecord({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskId: "TASK-711",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" },
      }),
      jobId: "zzz-eligible-job",
      status: "completed" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(root, busy);
    await saveFederatedJob(root, eligible);
    const busyLockPath = path.join(root, ".quack", "federation", "jobs", `${busy.jobId}.lock`);
    fs.writeFileSync(busyLockPath, "unverifiable owner", "utf-8");
    setFederatedJobLockOptionsForTests({
      retryMs: 2,
      waitTimeoutMs: 25,
      staleMs: 10,
      heartbeatMs: 2,
    });
    const writer = { emit: jest.fn() } as unknown as EventWriter;

    try {
      const reconciled = await reconcileFederatedJobs(p, {
        createWriter: jest.fn(() => writer),
      });
      expect(reconciled).toEqual([
        expect.objectContaining({ jobId: eligible.jobId, status: "blocked" }),
      ]);
      expect(await loadFederatedJob(root, busy.jobId)).toMatchObject({
        jobId: busy.jobId,
        status: "completed",
        nextAction: "record_merge_ready_review",
      });
      expect(await loadFederatedJob(root, eligible.jobId)).toMatchObject({
        jobId: eligible.jobId,
        status: "blocked",
        nextAction: "record_merge_ready_review",
      });
    } finally {
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(busyLockPath, { force: true });
    }
  });
});
