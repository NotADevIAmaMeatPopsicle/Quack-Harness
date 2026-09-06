// ─── Validation-intake orchestrator tests ──────────────────────────
// Per Blueprint §9: ≥6 cases covering composition rules and
// adapter-driftThreshold resolution. Gates are mocked so this suite
// stays pure-unit (no git, no file system fixtures).

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { EvidenceGateResult } from "../../src/intake/evidence-gate.js";
import type { ScopeHygieneResult } from "../../src/intake/scope-hygiene-gate.js";
import type { ValidationIntakePayload } from "../../src/intake/task-intake.js";

jest.mock("../../src/core/adapter-loader.js", () => ({
  loadAdapter: jest.fn(),
}));
jest.mock("../../src/intake/scope-hygiene-gate.js", () => ({
  runScopeHygieneGate: jest.fn(),
}));
jest.mock("../../src/intake/evidence-gate.js", () => ({
  runEvidenceGate: jest.fn(),
}));

import {
  resolveDriftThreshold,
  runValidationIntakeDryRun,
  runValidationIntakePersist,
} from "../../src/intake/validation-intake.js";
import { loadAdapter } from "../../src/core/adapter-loader.js";
import { runScopeHygieneGate } from "../../src/intake/scope-hygiene-gate.js";
import { runEvidenceGate } from "../../src/intake/evidence-gate.js";

const loadAdapterMock = loadAdapter as unknown as ReturnType<typeof jest.fn>;
const runScopeHygieneGateMock = runScopeHygieneGate as unknown as ReturnType<typeof jest.fn>;
const runEvidenceGateMock = runEvidenceGate as unknown as ReturnType<typeof jest.fn>;

// ─── Fixtures ──────────────────────────────────────────────────────

function makePayload(overrides: Partial<ValidationIntakePayload> = {}): ValidationIntakePayload {
  return {
    schemaVersion: 1,
    project: "demo",
    branch: "feature/test",
    commitRange: "HEAD~1..HEAD",
    scope: ["src/a.ts"],
    tests: [{ name: "spec", result: "PASS", evidence: "log.txt" }],
    screenshots: [],
    nonClaims: ["package-lock.json"],
    knownRisks: [],
    submitter: "tester",
    submittedAt: "2026-05-31T00:00:00Z",
    ...overrides,
  } as ValidationIntakePayload;
}

function makeAdapter(driftThreshold?: number): ProjectAdapter {
  const config: ProjectAdapter["config"] = {
    version: "1.0",
    project: {
      name: "demo",
      root: "/tmp/demo",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 100,
      maxBudgetPerTask: 10,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: { requireCleanTree: true, protectedBranches: [], allowedRemotes: ["origin"] },
    logging: { logDir: ".quack/logs", writeEvents: true },
  } as unknown as ProjectAdapter["config"];

  if (driftThreshold !== undefined) {
    (config as { validationIntake?: { driftThreshold: number } }).validationIntake = {
      driftThreshold,
    };
  }

  return {
    config,
    projectRoot: "/tmp/demo",
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "headnode",
      sharedHash: "sha256:test",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  } as ProjectAdapter;
}

function passScope(): ScopeHygieneResult {
  return {
    verdict: "PASS",
    confirmed: ["src/a.ts"],
    claimed_but_unchanged: [],
    changed_but_unclaimed: [],
    driftThreshold: 5,
    reasons: [],
  };
}

function reviseScope(): ScopeHygieneResult {
  return {
    verdict: "REVISE",
    confirmed: [],
    claimed_but_unchanged: ["src/a.ts"],
    changed_but_unclaimed: [],
    driftThreshold: 5,
    reasons: ["scope_inflation"],
  };
}

function passEvidence(): EvidenceGateResult {
  return { verdict: "PASS", deficiencies: [] };
}

function reviseEvidence(): EvidenceGateResult {
  return {
    verdict: "REVISE",
    deficiencies: ["evidence.nonClaims must be non-empty (TASK-1106 non-bypass rule)"],
  };
}

beforeEach(() => {
  loadAdapterMock.mockReset();
  runScopeHygieneGateMock.mockReset();
  runEvidenceGateMock.mockReset();
});

// ─── resolveDriftThreshold ─────────────────────────────────────────

describe("resolveDriftThreshold", () => {
  it("returns 5 when adapter has no validationIntake block", () => {
    expect(resolveDriftThreshold(makeAdapter())).toBe(5);
  });

  it("returns the adapter-declared driftThreshold when present", () => {
    expect(resolveDriftThreshold(makeAdapter(2))).toBe(2);
  });

  it("supports a non-default override (e.g. 12)", () => {
    expect(resolveDriftThreshold(makeAdapter(12))).toBe(12);
  });
});

// ─── runValidationIntakeDryRun ─────────────────────────────────────

describe("runValidationIntakeDryRun", () => {
  it("composes both PASS verdicts into overall PASS", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter());
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(passEvidence());

    const result = await runValidationIntakeDryRun({
      projectRoot: "/tmp/demo",
      payload: makePayload(),
    });

    expect(result.verdict).toBe("PASS");
    expect(result.scopeHygiene.verdict).toBe("PASS");
    expect(result.evidence.verdict).toBe("PASS");
    expect(result.driftThreshold).toBe(5);
    expect(runScopeHygieneGateMock).toHaveBeenCalledWith("/tmp/demo", expect.any(Object), 5);
    expect(runEvidenceGateMock).toHaveBeenCalledWith("/tmp/demo", expect.any(Object));
  });

  it("composes REVISE when scope-hygiene is REVISE even if evidence is PASS", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter());
    runScopeHygieneGateMock.mockResolvedValue(reviseScope());
    runEvidenceGateMock.mockResolvedValue(passEvidence());

    const result = await runValidationIntakeDryRun({
      projectRoot: "/tmp/demo",
      payload: makePayload(),
    });

    expect(result.verdict).toBe("REVISE");
    expect(result.scopeHygiene.verdict).toBe("REVISE");
    expect(result.evidence.verdict).toBe("PASS");
  });

  it("composes REVISE when evidence is REVISE even if scope-hygiene is PASS", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter());
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(reviseEvidence());

    const result = await runValidationIntakeDryRun({
      projectRoot: "/tmp/demo",
      payload: makePayload(),
    });

    expect(result.verdict).toBe("REVISE");
    expect(result.evidence.deficiencies[0]).toContain("nonClaims must be non-empty");
  });

  it("passes adapter-declared driftThreshold through to the scope-hygiene gate", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter(3));
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(passEvidence());

    const result = await runValidationIntakeDryRun({
      projectRoot: "/tmp/demo",
      payload: makePayload(),
    });

    expect(result.driftThreshold).toBe(3);
    expect(runScopeHygieneGateMock).toHaveBeenCalledWith("/tmp/demo", expect.any(Object), 3);
  });

  it("propagates loadAdapter failure (no .quack/adapter.json)", async () => {
    loadAdapterMock.mockRejectedValue(new Error("No .quack/adapter.json found. Run 'quack init'."));
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(passEvidence());

    await expect(
      runValidationIntakeDryRun({ projectRoot: "/tmp/demo", payload: makePayload() }),
    ).rejects.toThrow(/No \.quack\/adapter\.json found/);
  });
});

// ─── runValidationIntakePersist ────────────────────────────────────

describe("runValidationIntakePersist", () => {
  it("runs both gates and returns the same composition as the dry-run", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter());
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(passEvidence());

    const result = await runValidationIntakePersist({
      projectRoot: "/tmp/demo",
      projectId: "demo",
      payload: makePayload(),
      intakeRecordId: "intake-abc123",
    });

    expect(result.verdict).toBe("PASS");
    expect(result.scopeHygiene.verdict).toBe("PASS");
    expect(result.evidence.verdict).toBe("PASS");
    // The route layer is responsible for setting taskId/specPath/evidencePath
    // after invoking the spec generator — orchestrator leaves them undefined.
    expect(result.taskId).toBeUndefined();
    expect(result.specPath).toBeUndefined();
    expect(result.evidencePath).toBeUndefined();
  });

  it("returns REVISE without spec artifacts when either gate fails", async () => {
    loadAdapterMock.mockResolvedValue(makeAdapter());
    runScopeHygieneGateMock.mockResolvedValue(passScope());
    runEvidenceGateMock.mockResolvedValue(reviseEvidence());

    const result = await runValidationIntakePersist({
      projectRoot: "/tmp/demo",
      projectId: "demo",
      payload: makePayload(),
      intakeRecordId: "intake-abc123",
    });

    expect(result.verdict).toBe("REVISE");
    expect(result.taskId).toBeUndefined();
    expect(result.specPath).toBeUndefined();
    expect(result.evidencePath).toBeUndefined();
  });
});
