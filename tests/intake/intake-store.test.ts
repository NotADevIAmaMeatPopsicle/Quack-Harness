import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { IntakeStore } from "../../src/intake/intake-store";
import type { LaneClassification } from "../../src/intake/lane-classifier";
import type { RemoteTaskIntakeRequest } from "../../src/intake/task-intake";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-intake-store-"));
}

const classification: LaneClassification = {
  lane: "guarded_auto",
  riskLevel: "medium",
  reasons: ["guarded_code_change"],
};

const request: RemoteTaskIntakeRequest = {
  intakeType: "forward",
  taskId: "TASK-836",
  title: "Implement intake",
  description: "Add remote intake contract.",
  source: "test",
  idempotencyKey: "idem-836",
  priority: "P1-HIGH",
  tags: ["api"],
  files: ["src/intake/task-intake.ts"],
  metadata: {},
};

describe("IntakeStore", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("replays idempotency keys without creating a new intake record", async () => {
    const store = new IntakeStore(projectRoot);
    const first = await store.create(request, classification, "quack");
    const second = await store.create(request, classification, "quack");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.record.intakeId).toBe(first.record.intakeId);
    expect(second.record.classification).toEqual(classification);
  });

  it("persists route decisions with actor audit fields", async () => {
    const store = new IntakeStore(projectRoot);
    const { record } = await store.create(request, classification, "quack");

    const routed = await store.route(record.intakeId, {
      lane: "human_required",
      actor: "operator",
      reason: "Needs host deployment.",
      reasons: ["operator_route"],
      metadata: { host: "headnode" },
    });

    expect(routed?.status).toBe("routed");
    expect(routed?.route).toMatchObject({
      lane: "human_required",
      riskLevel: "medium",
      actor: "operator",
      reason: "Needs host deployment.",
      reasons: ["operator_route"],
      metadata: { host: "headnode" },
    });
  });
});
