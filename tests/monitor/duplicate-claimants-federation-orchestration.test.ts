import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { QuackDB } from "../../src/db/index.js";
import { buildFederationClaimantIndex } from "../../src/monitor/federation/scheduling.js";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs.js";
import { orchestrateFederatedCompletion } from "../../src/monitor/federation/orchestration.js";
import { listFederatedJobs, saveFederatedJob } from "../../src/monitor/federation/store.js";
import type { FederationProjectContext } from "../../src/monitor/federation/types.js";
import { TaskService } from "../../src/monitor/task-service.js";
import type { EventWriter } from "../../src/monitor/event-emitter.js";
import type { EventReader } from "../../src/monitor/event-reader.js";

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
});
