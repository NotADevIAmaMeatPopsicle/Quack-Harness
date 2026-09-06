import * as fs from "node:fs";
import * as path from "node:path";

import {
  DuplicateClaimantAdmissionError,
  formatDuplicateClaimantsMessage,
} from "../../src/core/duplicate-claimants";
import {
  buildRegistry,
  loadRegistry,
  saveRegistry,
  updateRegistry,
} from "../../src/templates/template-registry";
import type { TemplateRegistry } from "../../src/templates/template-types";
import type { FixtureCreationOrder } from "../helpers/divergent-task-fixture";
import {
  createContestedTaskFixture,
  writeSessionLog,
  type ClaimantPopulation,
} from "../helpers/task-1338e-fixture";

describe("TASK-1338-E: template registry duplicate vetoes", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<[ClaimantPopulation, FixtureCreationOrder]>([
    ["candidate", "child-first"],
    ["candidate", "parent-first"],
    ["cross-population", "child-first"],
    ["cross-population", "parent-first"],
  ])(
    "updateRegistry refuses %s claimants created %s and preserves prior bytes",
    async (population, order) => {
      const fixture = createContestedTaskFixture(order, population, { status: "COMPLETE" });
      writeSessionLog(fixture.root, [fixture.taskId]);
      const registryPath = path.join(fixture.root, ".quack", "templates", "task-templates.json");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      const priorBytes = JSON.stringify(
        {
          updatedAt: "2026-08-18T00:00:00.000Z",
          templates: [],
          categoryStats: {
            "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
            infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          },
        },
        null,
        2,
      );
      fs.writeFileSync(registryPath, priorBytes, "utf-8");

      try {
        await expect(
          updateRegistry(fixture.root, fixture.taskId, fixture.relativeTaskDir),
        ).rejects.toMatchObject<Partial<DuplicateClaimantAdmissionError>>({
          name: "DuplicateClaimantAdmissionError",
          code: "duplicate_claimants",
          taskId: fixture.taskId,
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        });
        expect(fs.readFileSync(registryPath, "utf-8")).toBe(priorBytes);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("keeps a single claimant update writable", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      status: "COMPLETE",
    });
    fs.rmSync(fixture.claimantPaths[1]);
    writeSessionLog(fixture.root, [fixture.taskId]);
    try {
      await updateRegistry(fixture.root, fixture.taskId, fixture.relativeTaskDir);
      const registry = await loadRegistry(fixture.root);
      expect(registry.templates).toHaveLength(1);
      expect(registry.templates[0]?.sourceTaskId).toBe(fixture.taskId);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps buildRegistry ungated but refuses the custom-taskDir save path", async () => {
    const fixture = createContestedTaskFixture("parent-first", "cross-population", {
      status: "COMPLETE",
      relativeTaskDir: "project/custom-task-specs",
    });
    writeSessionLog(fixture.root, [fixture.taskId]);
    const registryPath = path.join(fixture.root, ".quack", "templates", "task-templates.json");
    try {
      const registry = await buildRegistry(fixture.root, fixture.relativeTaskDir);
      expect(registry.templates).toHaveLength(1);

      const saveWithTaskDir = saveRegistry as unknown as (
        value: TemplateRegistry,
        projectRoot: string,
        registryPath: string | undefined,
        taskDir: string,
      ) => Promise<void>;
      await expect(
        saveWithTaskDir(registry, fixture.root, undefined, fixture.relativeTaskDir),
      ).rejects.toMatchObject({
        name: "DuplicateClaimantAdmissionError",
        taskId: fixture.taskId,
        claimants: fixture.claimants,
      });
      expect(fs.existsSync(registryPath)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
