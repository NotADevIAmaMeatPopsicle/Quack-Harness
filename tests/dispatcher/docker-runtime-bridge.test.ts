import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DockerRuntimeBridge,
  inspectValidatedDockerPendingArchive,
  inspectValidatedDockerResumeArchive,
  isValidatedDockerResumeArchive,
  seedDockerResumeState,
  type DockerResumeGitBinding,
} from "../../src/dispatcher/docker-runtime-bridge";
import { EventReader } from "../../src/monitor/event-reader";
import { ProgressDetector } from "../../src/monitor/progress-detector";

const TASK_ID = "TASK-DOCKER-BRIDGE";
const PROJECT = "bridge-fixture";
const PROVENANCE = { channel: "api-direct" as const, principal: "test-operator" };

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function appendEvent(
  sourceDir: string,
  sessionId: string,
  stage: string,
  payload: Record<string, unknown>,
  overrides: Partial<{ taskId: string; project: string; sessionId: string }> = {},
): void {
  fs.appendFileSync(
    path.join(sourceDir, `events-${sessionId}.jsonl`),
    `${JSON.stringify({
      sessionId: overrides.sessionId ?? sessionId,
      taskId: overrides.taskId ?? TASK_ID,
      project: overrides.project ?? PROJECT,
      timestamp: new Date().toISOString(),
      stage,
      payload,
    })}\n`,
    "utf-8",
  );
}

function validBlueprint() {
  return {
    taskId: TASK_ID,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  };
}

function writeBlueprintPause(
  sourceDir: string,
  sessionId: string,
  createdAt: string,
  lineage: { parentTaskId?: string; sharedBranchName?: string } = {},
): void {
  writeJson(path.join(sourceDir, `checkpoint-${TASK_ID}.json`), {
    taskId: TASK_ID,
    sessionId,
    completedStages: ["gate", "blueprint"],
    totalCostUsd: 0,
    retriesUsed: 0,
    updatedAt: createdAt,
    startedAt: createdAt,
    ...(lineage.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
    ...(lineage.sharedBranchName ? { featureBranch: lineage.sharedBranchName } : {}),
  });
  writeJson(path.join(sourceDir, "approvals", `${TASK_ID}.json`), {
    taskId: TASK_ID,
    state: "pending",
    blueprint: validBlueprint(),
    createdAt,
  });
}

function gitState(ownershipId: string): DockerResumeGitBinding {
  return {
    authoritativeRef: `refs/heads/quack/${TASK_ID}`,
    baseHead: "a".repeat(40),
    candidateHead: "b".repeat(40),
    sealedRef: `refs/quack/docker-resume/${TASK_ID}/${ownershipId}`,
  };
}

function createFixture(options: { parentTaskId?: string; sharedBranchName?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-runtime-bridge-"));
  const sourceDir = path.join(root, "source");
  const logDir = path.join(root, "logs");
  const archiveRoot = path.join(logDir, "docker-import");
  fs.mkdirSync(sourceDir, { recursive: true });
  const ownershipId = randomUUID();
  const sessionId = `quack-${TASK_ID}-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const bridge = new DockerRuntimeBridge({
    sourceDir,
    archiveRoot,
    taskId: TASK_ID,
    dispatchSessionId: sessionId,
    ownershipId,
    startedAt,
    provenance: PROVENANCE,
    expectedProject: PROJECT,
    ...options,
  });
  return { root, sourceDir, logDir, ownershipId, sessionId, startedAt, bridge };
}

function writeSessionStart(sourceDir: string, sessionId: string): void {
  appendEvent(sourceDir, sessionId, "session_start", {
    model: "fixture-model",
    maxTurns: 10,
    maxBudget: 1,
    taskId: TASK_ID,
    federated: false,
    provenance: PROVENANCE,
  });
}

describe("DockerRuntimeBridge", () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.useRealTimers();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes only exact live telemetry for EventReader and stuck/cost tracking", () => {
    jest.useFakeTimers({ now: new Date("2026-09-09T12:00:00.000Z") });
    const fixture = createFixture();
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    appendEvent(fixture.sourceDir, fixture.sessionId, "agent_turn", {
      turnNumber: 1,
      role: "assistant",
      contentPreview: "working",
    });
    appendEvent(fixture.sourceDir, fixture.sessionId, "agent_complete", {
      outcome: "success",
      turnsUsed: 1,
      totalCostUsd: 0.25,
      filesModified: ["src/example.ts"],
    });
    appendEvent(fixture.sourceDir, fixture.sessionId, "session_complete", {
      outcome: "approved",
      durationMs: 1,
      totalCostUsd: 0,
    });
    appendEvent(
      fixture.sourceDir,
      fixture.sessionId,
      "agent_turn",
      { turnNumber: 2, role: "assistant", contentPreview: "wrong project" },
      { project: "forged-project" },
    );

    expect(fixture.bridge.pollOnce()).toBe(3);
    const reader = new EventReader(fixture.logDir);
    const imported = reader.getSessionEvents(fixture.sessionId);
    expect(imported.map((event) => event.stage)).toEqual([
      "session_start",
      "agent_turn",
      "agent_complete",
    ]);
    expect(imported).toHaveLength(3);
    expect(reader.getAllSessions()).toEqual([
      expect.objectContaining({
        sessionId: fixture.sessionId,
        taskId: TASK_ID,
        project: PROJECT,
        status: "active",
      }),
    ]);

    const progress = new ProgressDetector({
      enabled: true,
      warningMinutes: 0.001,
      criticalMinutes: 0.0015,
      killMinutes: 0.002,
      checkIntervalSeconds: 60,
      fileHeartbeat: false,
    });
    for (const event of imported) progress.processEvent(event);
    expect(progress.getHealth(TASK_ID)).toEqual(
      expect.objectContaining({ turnCount: 1, cumulativeCostUsd: 0.25 }),
    );
    // A completed assistant turn extends the silence threshold while the
    // detector considers the model in-response; cross the effective 2x bound.
    jest.advanceTimersByTime(241);
    expect(progress.shouldKill(TASK_ID).kill).toBe(true);

    fixture.bridge.sealAndImport();
    fixture.bridge.emitTrustedTerminal({ outcome: "approved", totalCostUsd: 0.25, turnsUsed: 1 });
    expect(reader.getSessionEvents(fixture.sessionId).map((event) => event.stage)).toEqual([
      "session_start",
      "agent_turn",
      "agent_complete",
      "session_complete",
    ]);
    expect(reader.getAllSessions()).toEqual([
      expect.objectContaining({
        sessionId: fixture.sessionId,
        status: "completed",
        outcome: "approved",
        totalCostUsd: 0.25,
        turnsUsed: 1,
      }),
    ]);
    expect(
      fs.readFileSync(
        path.join(fixture.bridge.archiveDir, "runtime-import-rejections.jsonl"),
        "utf-8",
      ),
    ).toMatch(/session_complete|untrusted Docker event/i);
  });

  test("refuses a mismatched session and provenance before live events become authoritative", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    appendEvent(fixture.sourceDir, fixture.sessionId, "session_start", {
      model: "fixture-model",
      maxTurns: 10,
      maxBudget: 1,
      taskId: TASK_ID,
      federated: false,
      provenance: { channel: "cli", principal: "forged" },
    });
    appendEvent(
      fixture.sourceDir,
      fixture.sessionId,
      "session_start",
      {
        model: "fixture-model",
        maxTurns: 10,
        maxBudget: 1,
        taskId: TASK_ID,
        federated: false,
        provenance: PROVENANCE,
      },
      { sessionId: `quack-${TASK_ID}-${randomUUID()}` },
    );

    expect(fixture.bridge.pollOnce()).toBe(0);
    expect(new EventReader(fixture.logDir).getSessionEvents(fixture.sessionId)).toEqual([]);
  });

  test("rejects duplicate session starts before they can reset live progress", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);

    expect(fixture.bridge.pollOnce()).toBe(1);
    const reader = new EventReader(fixture.logDir);
    expect(reader.getSessionEvents(fixture.sessionId).map((event) => event.stage)).toEqual([
      "session_start",
    ]);
    expect(
      fs.readFileSync(
        path.join(fixture.bridge.archiveDir, "runtime-import-rejections.jsonl"),
        "utf-8",
      ),
    ).toMatch(/duplicate Docker session_start/i);
  });

  test("rechecks the event stream size after opening it before allocating", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    const eventPath = path.join(fixture.sourceDir, `events-${fixture.sessionId}.jsonl`);
    const maxEventFileBytes = 16 * 1024 * 1024;
    fs.truncateSync(eventPath, maxEventFileBytes + 1);

    // Simulate growth in the lstat-to-open race window: the path check sees a
    // file at the limit while fstat on the opened descriptor sees the larger
    // authoritative size.
    const mutableFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const realLstatSync = mutableFs.lstatSync;
    const lstatSpy = jest.spyOn(mutableFs, "lstatSync").mockImplementation(((
      target: fs.PathLike,
    ) => {
      const stat = realLstatSync(target);
      if (path.resolve(String(target)) === path.resolve(eventPath)) {
        stat.size = maxEventFileBytes;
      }
      return stat;
    }) as typeof fs.lstatSync);

    try {
      expect(fixture.bridge.pollOnce()).toBe(0);
      expect(() => fixture.bridge.sealAndImport()).toThrow(/event stream exceeds the size limit/i);
      expect(
        fs.readFileSync(
          path.join(fixture.bridge.archiveDir, "runtime-import-rejections.jsonl"),
          "utf-8",
        ),
      ).toMatch(/event stream exceeds the size limit/i);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  test("rejects malformed approval artifacts atomically", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    fixture.bridge.pollOnce();
    writeBlueprintPause(fixture.sourceDir, fixture.sessionId, fixture.startedAt);
    const approvalPath = path.join(fixture.sourceDir, "approvals", `${TASK_ID}.json`);
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<string, unknown>;
    approval.decidedAt = new Date().toISOString();
    writeJson(approvalPath, approval);

    expect(() => fixture.bridge.sealAndImport()).toThrow(/pending decision fields/i);
    expect(
      fs.existsSync(path.join(fixture.bridge.archiveDir, "approvals", `${TASK_ID}.json`)),
    ).toBe(false);
    expect(fs.existsSync(path.join(fixture.bridge.archiveDir, `checkpoint-${TASK_ID}.json`))).toBe(
      false,
    );
  });

  test("rejects checkpoint fields that forge work from stages that never completed", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    fixture.bridge.pollOnce();
    writeBlueprintPause(fixture.sourceDir, fixture.sessionId, fixture.startedAt);
    const checkpointPath = path.join(fixture.sourceDir, `checkpoint-${TASK_ID}.json`);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as Record<
      string,
      unknown
    >;
    writeJson(checkpointPath, {
      ...checkpoint,
      agentResult: {
        taskId: TASK_ID,
        outcome: "success",
        filesModified: [],
        filesCreated: [],
        verification: null,
        turnsUsed: 1,
        totalCostUsd: 0,
        messages: [],
      },
    });

    expect(() => fixture.bridge.sealAndImport()).toThrow(/completed stages/i);
  });

  test("binds a judge approval to strict agent evidence and the exact approved diff", () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const diff = "diff --git a/src/example.ts b/src/example.ts\n";
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    appendEvent(fixture.sourceDir, fixture.sessionId, "agent_complete", {
      outcome: "success",
      turnsUsed: 2,
      totalCostUsd: 0.25,
      filesModified: ["src/example.ts"],
      claudeSessionId: "agent-session",
    });
    fixture.bridge.pollOnce();
    writeJson(path.join(fixture.sourceDir, `checkpoint-${TASK_ID}.json`), {
      taskId: TASK_ID,
      sessionId: fixture.sessionId,
      completedStages: ["gate", "blueprint", "approve", "branch", "context", "agent", "commit"],
      claudeSessionId: "agent-session",
      agentResult: {
        taskId: TASK_ID,
        outcome: "success",
        filesModified: ["src/example.ts"],
        filesCreated: [],
        verification: null,
        turnsUsed: 2,
        totalCostUsd: 0.25,
        messages: [],
        claudeSessionId: "agent-session",
      },
      branchName: `quack/${TASK_ID}`,
      gitDiff: diff,
      outputSnapshots: [
        {
          taskId: TASK_ID,
          attempt: 1,
          kind: "worker",
          sealedAt: fixture.startedAt,
          diffBase: "main",
          diffRef: "main",
          baseSha: "a".repeat(40),
          headShaBefore: "a".repeat(40),
          headShaAfter: "b".repeat(40),
          sealedCommitSha: "b".repeat(40),
          branchName: `quack/${TASK_ID}`,
          worktreePath: "/workspace",
          manifestPath: "/workspace/manifest.json",
          diffPath: "/workspace/diff.patch",
          statusPath: "/workspace/status.txt",
          nameStatusPath: "/workspace/name-status.txt",
          gitDiff: diff,
          diffStat: "1 file changed",
          statusShort: "",
          changedFiles: ["src/example.ts"],
          nameStatus: [{ status: "M", path: "src/example.ts" }],
          filesStaged: 1,
          excludedFiles: [],
          claudeSessionId: "agent-session",
          empty: false,
        },
      ],
      totalCostUsd: 0.25,
      retriesUsed: 0,
      updatedAt: fixture.startedAt,
      startedAt: fixture.startedAt,
    });
    writeJson(path.join(fixture.sourceDir, "approvals", `${TASK_ID}-judge.json`), {
      taskId: TASK_ID,
      state: "pending",
      diff,
      filesModified: ["src/example.ts"],
      filesCreated: [],
      verificationPassed: true,
      agentSessionId: "agent-session",
      createdAt: fixture.startedAt,
    });
    fixture.bridge.sealAndImport();
    fixture.bridge.recordGitResumeState(gitState(fixture.ownershipId));
    const approvalPath = path.join(fixture.bridge.archiveDir, "approvals", `${TASK_ID}-judge.json`);
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<string, unknown>;
    writeJson(approvalPath, {
      ...approval,
      state: "approved",
      approvedBy: "operator",
      decidedAt: new Date(Date.now() + 1).toISOString(),
    });

    const validated = inspectValidatedDockerResumeArchive(fixture.bridge.archiveDir, TASK_ID);
    expect(validated.approvedGate).toBe("judge");
    expect(validated.approvedDiffHash).toMatch(/^[a-f0-9]{64}$/);

    writeJson(approvalPath, {
      ...approval,
      diff: `${diff}forged`,
      state: "approved",
      approvedBy: "operator",
      decidedAt: new Date(Date.now() + 2).toISOString(),
    });
    expect(() => inspectValidatedDockerResumeArchive(fixture.bridge.archiveDir, TASK_ID)).toThrow(
      /checkpoint diff/i,
    );
  });

  test("resumes only the exact sealed, host-approved runtime and preserves shared lineage", () => {
    const parentTaskId = "TASK-PARENT";
    const sharedBranchName = `quack/${parentTaskId}`;
    const fixture = createFixture({ parentTaskId, sharedBranchName });
    roots.push(fixture.root);
    writeSessionStart(fixture.sourceDir, fixture.sessionId);
    fixture.bridge.pollOnce();
    writeBlueprintPause(fixture.sourceDir, fixture.sessionId, fixture.startedAt, {
      parentTaskId,
      sharedBranchName,
    });
    fixture.bridge.sealAndImport();
    fixture.bridge.recordGitResumeState({
      ...gitState(fixture.ownershipId),
      authoritativeRef: `refs/heads/${sharedBranchName}`,
    });

    const pending = inspectValidatedDockerPendingArchive(fixture.bridge.archiveDir, TASK_ID);
    expect(pending).toEqual(
      expect.objectContaining({ parentTaskId, sharedBranchName, ownershipId: fixture.ownershipId }),
    );
    const approvalPath = path.join(fixture.bridge.archiveDir, "approvals", `${TASK_ID}.json`);
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<string, unknown>;
    writeJson(approvalPath, {
      ...approval,
      state: "approved",
      approvedBy: "operator",
      decidedAt: new Date(Date.now() + 1).toISOString(),
    });

    expect(isValidatedDockerResumeArchive(fixture.bridge.archiveDir, TASK_ID)).toBe(true);
    const validated = inspectValidatedDockerResumeArchive(fixture.bridge.archiveDir, TASK_ID);
    expect(validated).toEqual(
      expect.objectContaining({
        archiveName: path.basename(fixture.bridge.archiveDir),
        dispatchSessionId: fixture.sessionId,
        parentTaskId,
        sharedBranchName,
      }),
    );

    const target = path.join(fixture.root, "next-runtime");
    fs.mkdirSync(target);
    const nextSession = `quack-${TASK_ID}-${randomUUID()}`;
    expect(seedDockerResumeState(fixture.bridge.archiveDir, target, TASK_ID, nextSession)).toEqual(
      expect.objectContaining({
        archiveName: validated.archiveName,
        dispatchSessionId: validated.dispatchSessionId,
        ownershipId: validated.ownershipId,
        parentTaskId,
        sharedBranchName,
      }),
    );
    const seededCheckpoint = JSON.parse(
      fs.readFileSync(path.join(target, `checkpoint-${TASK_ID}.json`), "utf-8"),
    ) as { sessionId: string; completedStages: string[] };
    expect(seededCheckpoint.sessionId).toBe(nextSession);
    expect(seededCheckpoint.completedStages).toEqual(["gate", "blueprint"]);

    const sibling = path.join(
      path.dirname(fixture.bridge.archiveDir),
      `${TASK_ID}-${randomUUID()}`,
    );
    fs.cpSync(fixture.bridge.archiveDir, sibling, { recursive: true });
    expect(isValidatedDockerResumeArchive(sibling, TASK_ID)).toBe(false);
  });
});
