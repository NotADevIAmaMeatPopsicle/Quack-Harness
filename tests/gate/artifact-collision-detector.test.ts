import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectArtifactCollisions,
  collisionsToDeficiencies,
  collisionsToAdvisories,
} from "../../src/gate/artifact-collision-detector";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { ParsedTask, TaskPriority, TaskStatus } from "../../src/core/types";

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
  const config = {} as ProjectAdapter["config"];
  return {
    config,
    projectRoot: "/tmp/no-such-dir",
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "TASK-999",
    title: "Test fixture",
    priority: "P1-HIGH" as TaskPriority,
    effort: "1 hour",
    status: "READY" as TaskStatus,
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "",
    ...overrides,
  };
}

describe("detectArtifactCollisions — ADR collisions", () => {
  test("flags create-intent collision with the next-free recommendation", () => {
    const adapter = makeAdapter({
      adrDocs: {
        "035": "# ADR-035: Vapi voice AI integration\n\nUse Vapi for the call layer.",
        "036": "# ADR-036: Auth strategy\n\nCognito.",
      },
    });
    const task = makeTask({
      rawContent:
        "## Recommended Approach\n\n" +
        "Create ADR-035 capturing the Web app vs Example-Management role boundaries.",
    });

    const report = detectArtifactCollisions(task, adapter);

    expect(report.blockers).toHaveLength(1);
    const blocker = report.blockers[0];
    expect(blocker?.artifact).toBe("ADR-035");
    expect(blocker?.intent).toBe("create");
    expect(blocker?.existingScope).toMatch(/Vapi voice AI/);
    // Next free is 037 (035 and 036 occupied)
    expect(blocker?.recommendedAction).toMatch(/ADR-037/);
    expect(report.warnings).toHaveLength(0);
  });

  test("does not flag reference-intent mentions", () => {
    const adapter = makeAdapter({
      adrDocs: { "035": "# ADR-035: Vapi voice AI integration" },
    });
    const task = makeTask({
      rawContent: "Implementation must follow ADR-035 conventions for the call layer.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  test("flags ambiguous mentions as warnings", () => {
    const adapter = makeAdapter({
      adrDocs: { "035": "# ADR-035: Vapi voice AI integration" },
    });
    const task = makeTask({
      rawContent: "ADR-035 is relevant.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.artifact).toBe("ADR-035");
  });

  test("does not flag references to ADRs that don't exist", () => {
    const adapter = makeAdapter({ adrDocs: { "010": "# ADR-010" } });
    const task = makeTask({
      rawContent: "Create ADR-999 for the new pattern.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  test("multiple distinct ADR-create collisions produce one blocker each", () => {
    const adapter = makeAdapter({
      adrDocs: {
        "010": "# ADR-010: Existing one",
        "020": "# ADR-020: Existing two",
      },
    });
    const task = makeTask({
      rawContent: "Create ADR-010 for thing A.\nAlso, define ADR-020 for thing B.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(2);
    expect(report.blockers.map((b) => b.artifact).sort()).toEqual(["ADR-010", "ADR-020"]);
  });

  test("repeated ADR mentions in one spec collapse to one blocker", () => {
    const adapter = makeAdapter({
      adrDocs: { "010": "# ADR-010: Existing" },
    });
    const task = makeTask({
      rawContent:
        "Create ADR-010 for X.\nThe new ADR-010 will document Y.\nADR-010 must include Z.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.artifact).toBe("ADR-010");
  });

  test("zero-pads single/double-digit ADR numbers correctly", () => {
    const adapter = makeAdapter({
      adrDocs: { "005": "# ADR-005: Existing" },
    });
    // Spec uses ADR-005 (3-digit padded). Verify the pad lookup matches.
    const task = makeTask({
      rawContent: "Create ADR-005 for the topic.",
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.artifact).toBe("ADR-005");
  });
});

describe("detectArtifactCollisions — file Create collisions", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-collision-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("flags Create action when file already exists", () => {
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "docs", "foo.md"), "existing content");

    const adapter = makeAdapter({ projectRoot: tempDir });
    const task = makeTask({
      filesToModify: [{ path: "docs/foo.md", action: "Create", notes: "" }],
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.artifact).toBe("docs/foo.md");
    expect(report.blockers[0]?.recommendedAction).toMatch(/Modify/);
  });

  test("does not flag Create when file does not exist", () => {
    const adapter = makeAdapter({ projectRoot: tempDir });
    const task = makeTask({
      filesToModify: [{ path: "docs/never-existed.md", action: "Create", notes: "" }],
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
  });

  test("does not flag Modify or Delete actions for existing files", () => {
    fs.writeFileSync(path.join(tempDir, "src.ts"), "");
    const adapter = makeAdapter({ projectRoot: tempDir });
    const task = makeTask({
      filesToModify: [
        { path: "src.ts", action: "Modify", notes: "" },
        { path: "src.ts", action: "Delete", notes: "" },
      ],
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
  });

  test("refuses to stat absolute or path-traversing entries", () => {
    fs.writeFileSync(path.join(tempDir, "real.txt"), "");
    const adapter = makeAdapter({ projectRoot: tempDir });
    const task = makeTask({
      filesToModify: [
        { path: "/etc/passwd", action: "Create", notes: "" },
        { path: "../escape.md", action: "Create", notes: "" },
      ],
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers).toHaveLength(0);
  });
});

describe("collisionsToDeficiencies + collisionsToAdvisories", () => {
  test("collisionsToDeficiencies maps blockers to operator-readable strings", () => {
    const report = {
      blockers: [
        {
          artifact: "ADR-035",
          intent: "create" as const,
          existingAt: "docs/architecture/decisions/035-foo.md",
          existingScope: "Vapi voice AI",
          recommendedAction: "Use ADR-047 instead.",
        },
      ],
      warnings: [],
    };
    const deficiencies = collisionsToDeficiencies(report);
    expect(deficiencies).toHaveLength(1);
    // ADVISORY prefix is the contract: never matches the gate's BLOCKING filter (TASK-1300).
    expect(deficiencies[0]).toMatch(/^ADVISORY: artifact collision — ADR-035/);
    expect(deficiencies[0]).toMatch(/Use ADR-047 instead/);
    expect(deficiencies[0].toUpperCase().startsWith("BLOCKING")).toBe(false);
  });

  test("collisionsToAdvisories includes both blockers and warnings", () => {
    const report = {
      blockers: [
        {
          artifact: "ADR-035",
          intent: "create" as const,
          existingAt: "docs/architecture/decisions/035-foo.md",
          existingScope: "Vapi voice AI",
          recommendedAction: "Use ADR-047 instead.",
        },
      ],
      warnings: [{ artifact: "ADR-040", note: "Verify whether spec creates or references." }],
    };
    const advisories = collisionsToAdvisories(report);
    expect(advisories).toHaveLength(2);
    expect(advisories[0]?.severity).toBe("blocker");
    expect(advisories[1]?.severity).toBe("warning");
  });
});

describe("detectArtifactCollisions — TASK-885 reproduction", () => {
  test("the exact TASK-885 manifestation produces the right advisory", () => {
    // Reproduce the historical scenario: ADR-035 is occupied by Vapi voice AI;
    // a new spec wants to create ADR-035 for a different decision.
    const adapter = makeAdapter({
      adrDocs: {
        "035": "# ADR-035: Vapi voice AI integration\n\nUse Vapi for inbound voice routing.",
      },
    });
    const task = makeTask({
      id: "TASK-885",
      rawContent: [
        "# TASK-885: Web app vs Example-Management role coordination",
        "",
        "## Files to Modify",
        "| File | Action | Notes |",
        "|------|--------|-------|",
        "| docs/architecture/decisions/035-web-app-vs-admin-portal-roles.md | Create | New ADR |",
        "",
        "## Recommended Approach",
        "",
        "Author ADR-035 capturing the role boundaries between Web app and Example-Management surfaces.",
      ].join("\n"),
      filesToModify: [
        {
          path: "docs/architecture/decisions/035-web-app-vs-admin-portal-roles.md",
          action: "Create",
          notes: "New ADR",
        },
      ],
    });

    const report = detectArtifactCollisions(task, adapter);
    expect(report.blockers.length).toBeGreaterThanOrEqual(1);
    const adrBlocker = report.blockers.find((b) => b.artifact === "ADR-035");
    expect(adrBlocker).toBeDefined();
    expect(adrBlocker?.intent).toBe("create");
    expect(adrBlocker?.recommendedAction).toMatch(/ADR-036/);
  });
});
