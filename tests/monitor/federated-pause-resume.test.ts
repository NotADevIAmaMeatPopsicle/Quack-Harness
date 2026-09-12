import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  advanceLocalFederatedResumeState,
  armLocalFederatedResume,
  finalizeLocalFederatedResumeStart,
  installLocalFederatedResumeStartGrant,
  reconcileLocalFederatedResumeDecision,
  reserveLocalFederatedResumeStart,
  recoverFederatedRunIdentity,
} from "../../src/dispatcher/federated-resume-state.js";
import {
  applyActiveFederatedLeases,
  acknowledgeFederatedResumeStart,
  claimFederatedResume,
  federatedJobHoldsWorkerAttachment,
  loadFederatedJob,
  markFederatedPauseManualRecovery,
  prepareFederatedPause,
  recoverStaleFederatedLeases,
  releaseFederatedPause,
  requestFederatedResume,
  saveFederatedJob,
  transitionFederatedResumeRunning,
  transitionFederatedResumeTerminal,
} from "../../src/monitor/federation/index.js";
import type {
  FederatedJobRecord,
  FederationProjectContext,
} from "../../src/monitor/federation/types.js";

function job(overrides: Partial<FederatedJobRecord> = {}): FederatedJobRecord {
  return {
    projectId: "demo",
    jobId: "fed-task-1330",
    taskId: "TASK-1330",
    jobType: "dispatch",
    status: "awaiting_approval",
    correlationId: "corr-1330",
    requiredCapabilities: ["dispatch"],
    hostId: "laptop",
    remoteSessionId: "session-original",
    lease: {
      leaseId: "lease-1",
      hostId: "laptop",
      acquiredAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2099-08-14T00:30:00.000Z",
    },
    pendingGate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
    decision: {},
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:05:00.000Z",
    ...overrides,
  };
}

describe("TASK-1330 federated pause/resume", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-pause-resume-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("recovers identity through checkpoint -> session_start and treats absence as unknown", () => {
    const logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "checkpoint-TASK-1330.json"),
      JSON.stringify({
        taskId: "TASK-1330",
        sessionId: "session-original",
      }),
    );
    fs.writeFileSync(
      path.join(logDir, "events-session-original.jsonl"),
      `${JSON.stringify({
        sessionId: "session-original",
        taskId: "TASK-1330",
        project: "demo",
        timestamp: "2026-08-14T00:00:00.000Z",
        stage: "session_start",
        payload: { jobId: "fed-task-1330", hostId: "laptop", federated: true },
      })}\n`,
    );

    expect(recoverFederatedRunIdentity(logDir, "TASK-1330")).toEqual({
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch",
      hostId: "laptop",
      sessionId: "session-original",
      source: "checkpoint_session_start",
    });
    expect(recoverFederatedRunIdentity(logDir, "TASK-OTHER")).toBeNull();
  });

  it("releases capacity only after an exact durable generation is armed", async () => {
    await saveFederatedJob(projectRoot, job());
    const prepared = await prepareFederatedPause(projectRoot, {
      identity: {
        projectId: "demo",
        jobId: "fed-task-1330",
        taskId: "TASK-1330",
        jobType: "dispatch",
        hostId: "laptop",
        sessionId: "session-original",
      },
      gate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
    });
    expect(prepared.pause?.state).toBe("attached");
    expect(federatedJobHoldsWorkerAttachment(prepared)).toBe(true);

    await saveFederatedJob(projectRoot, { ...prepared, hostId: "replacement-host" });
    await expect(
      releaseFederatedPause(projectRoot, {
        jobId: prepared.jobId,
        hostId: "laptop",
        generation: prepared.pause!.generation,
        releaseNonce: prepared.pause!.releaseNonce,
      }),
    ).rejects.toMatchObject({ code: "federated_pause_generation_mismatch" });
    await saveFederatedJob(projectRoot, prepared);

    const released = await releaseFederatedPause(projectRoot, {
      jobId: prepared.jobId,
      hostId: "laptop",
      generation: prepared.pause!.generation,
      releaseNonce: prepared.pause!.releaseNonce,
    });
    expect(released.pause?.state).toBe("released");
    expect(released.lease).toBeUndefined();
    expect(federatedJobHoldsWorkerAttachment(released)).toBe(false);

    const hosts = await applyActiveFederatedLeases(projectRoot, [
      {
        id: "laptop",
        capabilities: ["dispatch"],
        enabled: true,
        healthy: true,
        currentLoad: 0,
        maxConcurrentJobs: 1,
      },
    ]);
    expect(hosts[0]?.currentLoad).toBe(0);
  });

  it("allows exactly one simultaneous resume claim for the original job and host", async () => {
    await saveFederatedJob(projectRoot, job());
    const prepared = await prepareFederatedPause(projectRoot, {
      identity: {
        projectId: "demo",
        jobId: "fed-task-1330",
        taskId: "TASK-1330",
        jobType: "dispatch",
        hostId: "laptop",
        sessionId: "session-original",
      },
      gate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
    });
    const released = await releaseFederatedPause(projectRoot, {
      jobId: prepared.jobId,
      hostId: "laptop",
      generation: prepared.pause!.generation,
      releaseNonce: prepared.pause!.releaseNonce,
    });
    const requested = await requestFederatedResume(projectRoot, {
      jobId: released.jobId,
      hostId: "laptop",
      generation: released.pause!.generation,
      releaseNonce: released.pause!.releaseNonce,
      decision: { action: "approved" },
    });
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        claimFederatedResume(projectRoot, {
          jobId: requested.jobId,
          hostId: "laptop",
          generation: requested.pause!.generation,
          releaseNonce: requested.pause!.releaseNonce,
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const stored = await loadFederatedJob(projectRoot, requested.jobId);
    expect(stored?.jobId).toBe("fed-task-1330");
    expect(stored?.pause?.state).toBe("resume_claimed");
    expect(stored?.pause?.claim?.hostId).toBe("laptop");
  });

  it("mints a new generation for a later same-session same-gate pause occurrence", async () => {
    const previousNonce = "nonce-previous";
    await saveFederatedJob(
      projectRoot,
      job({
        remoteSessionId: "session-resumed",
        pause: {
          generation: 1,
          state: "approved_but_not_started",
          gate: "judge",
          sessionId: "session-original",
          originalHostId: "laptop",
          releaseNonce: previousNonce,
          openedAt: "2026-08-14T00:05:00.000Z",
          preparedAt: "2026-08-14T00:05:00.000Z",
          resumedAt: "2026-08-14T00:10:00.000Z",
          decision: { action: "rejected", recordedAt: "2026-08-14T00:06:00.000Z" },
          claim: {
            token: "claim-previous",
            hostId: "laptop",
            claimedAt: "2026-08-14T00:07:00.000Z",
            expiresAt: "2026-08-14T00:17:00.000Z",
          },
          startGrant: {
            token: "grant-previous",
            projectId: "demo",
            jobId: "fed-task-1330",
            taskId: "TASK-1330",
            jobType: "dispatch",
            hostId: "laptop",
            originalSessionId: "session-original",
            generation: 1,
            releaseNonce: previousNonce,
            claimToken: "claim-previous",
            leaseId: "lease-1",
            issuedAt: "2026-08-14T00:07:00.000Z",
            expiresAt: "2026-08-14T00:12:00.000Z",
            consumedAt: "2026-08-14T00:08:00.000Z",
            resumedSessionId: "session-resumed",
          },
        },
      }),
    );
    const identity = {
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      sessionId: "session-resumed",
    };
    const gate = { stage: "judge" as const, since: "2026-08-14T00:20:00.000Z" };

    const later = await prepareFederatedPause(projectRoot, { identity, gate });
    expect(later.pause).toMatchObject({
      generation: 2,
      state: "attached",
      gate: "judge",
      sessionId: "session-resumed",
      openedAt: gate.since,
    });
    expect(later.pause?.releaseNonce).not.toBe(previousNonce);
    expect(later.pause?.startGrant).toBeUndefined();

    const duplicate = await prepareFederatedPause(projectRoot, { identity, gate });
    expect(duplicate.pause?.generation).toBe(2);
    expect(duplicate.pause?.releaseNonce).toBe(later.pause?.releaseNonce);

    await expect(
      prepareFederatedPause(projectRoot, {
        identity,
        gate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "stale_federated_pause_generation" });
  });

  it("issues one exact start grant and rejects a stale lease epoch", async () => {
    await saveFederatedJob(projectRoot, job());
    const prepared = await prepareFederatedPause(projectRoot, {
      identity: {
        projectId: "demo",
        jobId: "fed-task-1330",
        taskId: "TASK-1330",
        jobType: "dispatch",
        hostId: "laptop",
        sessionId: "session-original",
      },
      gate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
      now: "2026-08-14T00:05:00.000Z",
    });
    const released = await releaseFederatedPause(projectRoot, {
      jobId: prepared.jobId,
      hostId: "laptop",
      generation: prepared.pause!.generation,
      releaseNonce: prepared.pause!.releaseNonce,
      now: "2026-08-14T00:05:01.000Z",
    });
    const requested = await requestFederatedResume(projectRoot, {
      jobId: released.jobId,
      hostId: "laptop",
      generation: released.pause!.generation,
      releaseNonce: released.pause!.releaseNonce,
      decision: { action: "approved" },
      now: "2026-08-14T00:05:02.000Z",
    });
    const claimed = await claimFederatedResume(projectRoot, {
      jobId: requested.jobId,
      hostId: "laptop",
      generation: requested.pause!.generation,
      releaseNonce: requested.pause!.releaseNonce,
      now: "2026-08-14T00:05:03.000Z",
    });
    const ackInput = {
      projectId: "demo",
      jobId: claimed.jobId,
      taskId: claimed.taskId,
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: claimed.pause!.generation,
      releaseNonce: claimed.pause!.releaseNonce,
      claimToken: claimed.pause!.claim!.token,
      leaseId: claimed.lease!.leaseId,
      now: "2026-08-14T00:05:04.000Z",
    };
    await expect(
      acknowledgeFederatedResumeStart(projectRoot, {
        ...ackInput,
        leaseId: "older-lease",
      }),
    ).rejects.toMatchObject({ code: "federated_resume_claim_mismatch" });

    const acknowledged = await acknowledgeFederatedResumeStart(projectRoot, ackInput);
    const replayedAck = await acknowledgeFederatedResumeStart(projectRoot, ackInput);
    expect(acknowledged.pause?.startGrant).toEqual(replayedAck.pause?.startGrant);
    expect(acknowledged.pause?.startGrant).toMatchObject({
      projectId: "demo",
      jobId: claimed.jobId,
      taskId: "TASK-1330",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: claimed.pause!.generation,
      releaseNonce: claimed.pause!.releaseNonce,
      claimToken: claimed.pause!.claim!.token,
      leaseId: claimed.lease!.leaseId,
    });
  });

  it("allows only an exact same-session running replay after grant expiry", () => {
    const startGrant = {
      token: "grant-1",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      pauseOpenedAt: "2026-08-14T00:05:00.000Z",
      claimToken: "claim-1",
      leaseId: "lease-1",
      issuedAt: "2026-08-14T00:05:00.000Z",
      expiresAt: "2026-08-14T00:10:00.000Z",
    };
    const acknowledged = job({
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: "nonce-1",
        openedAt: "2026-08-14T00:04:00.000Z",
        preparedAt: "2026-08-14T00:04:00.000Z",
        decision: { action: "approved", recordedAt: "2026-08-14T00:04:30.000Z" },
        claim: {
          token: "claim-1",
          hostId: "laptop",
          claimedAt: "2026-08-14T00:05:00.000Z",
          expiresAt: "2026-08-14T00:15:00.000Z",
        },
        startGrant,
      },
      lease: {
        leaseId: "lease-1",
        hostId: "laptop",
        acquiredAt: "2026-08-14T00:05:00.000Z",
        expiresAt: "2099-08-14T00:30:00.000Z",
      },
    });
    const running = transitionFederatedResumeRunning(acknowledged, {
      startGrant,
      resumedSessionId: "session-resumed",
      now: "2026-08-14T00:06:00.000Z",
    });
    expect(
      transitionFederatedResumeRunning(running, {
        startGrant,
        resumedSessionId: "session-resumed",
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toBe(running);
    expect(() =>
      transitionFederatedResumeRunning(running, {
        startGrant,
        resumedSessionId: "different-session",
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toThrow("already consumed");
  });

  it("reconciles a delayed first running observation only from an in-window reservation and live exact lease", () => {
    const startGrant = {
      token: "grant-delayed",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-delayed",
      claimToken: "claim-delayed",
      leaseId: "lease-delayed",
      issuedAt: "2026-08-14T00:05:00.000Z",
      expiresAt: "2026-08-14T00:10:00.000Z",
    };
    const acknowledged = job({
      lease: {
        leaseId: "lease-delayed",
        hostId: "laptop",
        acquiredAt: "2026-08-14T00:04:00.000Z",
        expiresAt: "2026-08-14T00:30:00.000Z",
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: "nonce-delayed",
        openedAt: "2026-08-14T00:04:00.000Z",
        preparedAt: "2026-08-14T00:04:00.000Z",
        decision: { action: "approved", recordedAt: "2026-08-14T00:04:30.000Z" },
        claim: {
          token: "claim-delayed",
          hostId: "laptop",
          claimedAt: "2026-08-14T00:04:45.000Z",
          expiresAt: "2026-08-14T00:10:00.000Z",
        },
        startGrant,
      },
    });

    expect(() =>
      transitionFederatedResumeRunning(acknowledged, {
        startGrant,
        resumedSessionId: "session-resumed",
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toThrow("expired");
    expect(() =>
      transitionFederatedResumeRunning(acknowledged, {
        startGrant,
        resumedSessionId: "session-resumed",
        resumeStartedAt: "2026-08-14T00:11:00.000Z",
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toThrow("outside the grant window");
    expect(() =>
      transitionFederatedResumeRunning(
        { ...acknowledged, lease: { ...acknowledged.lease!, leaseId: "reassigned" } },
        {
          startGrant,
          resumedSessionId: "session-resumed",
          resumeStartedAt: "2026-08-14T00:09:00.000Z",
          now: "2026-08-14T00:20:00.000Z",
        },
      ),
    ).toThrow("lease is not current");
    expect(() =>
      transitionFederatedResumeRunning(
        {
          ...acknowledged,
          lease: { ...acknowledged.lease!, expiresAt: "2026-08-14T00:19:59.000Z" },
        },
        {
          startGrant,
          resumedSessionId: "session-resumed",
          resumeStartedAt: "2026-08-14T00:09:00.000Z",
          now: "2026-08-14T00:20:00.000Z",
        },
      ),
    ).toThrow("expired");

    const reconciled = transitionFederatedResumeRunning(acknowledged, {
      startGrant,
      resumedSessionId: "session-resumed",
      resumeStartedAt: "2026-08-14T00:09:00.000Z",
      now: "2026-08-14T00:20:00.000Z",
    });
    expect(reconciled).toMatchObject({
      status: "running",
      remoteSessionId: "session-resumed",
      pause: {
        resumedAt: "2026-08-14T00:20:00.000Z",
        startGrant: {
          consumedAt: "2026-08-14T00:09:00.000Z",
          resumedSessionId: "session-resumed",
        },
      },
    });
  });

  it("reconciles a delayed blueprint rejection only from an in-window reservation and live exact lease", () => {
    const startGrant = {
      token: "grant-blueprint-delayed",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-blueprint-delayed",
      claimToken: "claim-blueprint-delayed",
      leaseId: "lease-blueprint-delayed",
      issuedAt: "2026-08-14T00:05:00.000Z",
      expiresAt: "2026-08-14T00:10:00.000Z",
    };
    const acknowledged = job({
      lease: {
        leaseId: startGrant.leaseId,
        hostId: "laptop",
        acquiredAt: "2026-08-14T00:04:00.000Z",
        expiresAt: "2026-08-14T00:30:00.000Z",
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "blueprint",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: startGrant.releaseNonce,
        openedAt: "2026-08-14T00:04:00.000Z",
        preparedAt: "2026-08-14T00:04:00.000Z",
        decision: { action: "rejected", recordedAt: "2026-08-14T00:04:30.000Z" },
        claim: {
          token: startGrant.claimToken,
          hostId: "laptop",
          claimedAt: "2026-08-14T00:04:45.000Z",
          expiresAt: "2026-08-14T00:10:00.000Z",
        },
        startGrant,
      },
    });

    expect(() =>
      transitionFederatedResumeTerminal(acknowledged, {
        startGrant,
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toThrow("not eligible");
    expect(() =>
      transitionFederatedResumeTerminal(acknowledged, {
        startGrant,
        resumeStartedAt: "2026-08-14T00:11:00.000Z",
        now: "2026-08-14T00:20:00.000Z",
      }),
    ).toThrow("outside the grant window");
    expect(() =>
      transitionFederatedResumeTerminal(
        { ...acknowledged, lease: { ...acknowledged.lease!, leaseId: "reassigned" } },
        {
          startGrant,
          resumeStartedAt: "2026-08-14T00:09:00.000Z",
          now: "2026-08-14T00:20:00.000Z",
        },
      ),
    ).toThrow("lease is not current");
    expect(() =>
      transitionFederatedResumeTerminal(
        {
          ...acknowledged,
          lease: { ...acknowledged.lease!, expiresAt: "2026-08-14T00:19:59.000Z" },
        },
        {
          startGrant,
          resumeStartedAt: "2026-08-14T00:09:00.000Z",
          now: "2026-08-14T00:20:00.000Z",
        },
      ),
    ).toThrow("not eligible");

    const reconciled = transitionFederatedResumeTerminal(acknowledged, {
      startGrant,
      resumeStartedAt: "2026-08-14T00:09:00.000Z",
      now: "2026-08-14T00:20:00.000Z",
    });
    expect(reconciled).toMatchObject({
      status: "rejected",
      lease: undefined,
      pause: {
        resumedAt: "2026-08-14T00:20:00.000Z",
        startGrant: { consumedAt: "2026-08-14T00:09:00.000Z" },
      },
    });
    expect(
      transitionFederatedResumeTerminal(reconciled, {
        startGrant,
        now: "2026-08-14T01:00:00.000Z",
      }),
    ).toBe(reconciled);
  });

  it("persists and reconciles a decision before the child start boundary", () => {
    const logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "checkpoint-TASK-1330.json"),
      JSON.stringify({
        taskId: "TASK-1330",
        sessionId: "session-original",
      }),
    );
    fs.writeFileSync(
      path.join(logDir, "events-session-original.jsonl"),
      `${JSON.stringify({
        sessionId: "session-original",
        taskId: "TASK-1330",
        project: "demo",
        timestamp: "2026-08-14T00:00:00.000Z",
        stage: "session_start",
        payload: { jobId: "fed-task-1330", hostId: "laptop", federated: true },
      })}\n`,
    );
    armLocalFederatedResume(logDir, {
      projectId: "demo",
      taskId: "TASK-1330",
      jobType: "dispatch",
      gate: "judge",
      jobId: "fed-task-1330",
      hostId: "laptop",
      sessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      pauseOpenedAt: "2026-08-14T00:05:00.000Z",
    });
    fs.writeFileSync(
      path.join(logDir, "approvals", "TASK-1330-judge.json"),
      JSON.stringify({
        state: "approved",
        createdAt: "2026-08-14T00:05:00.000Z",
      }),
    );
    const reconciled = reconcileLocalFederatedResumeDecision(logDir, "TASK-1330");
    expect(reconciled?.status).toBe("decision_recorded");
    expect(reconciled?.decision?.action).toBe("approved");
    const startGrant = {
      token: "grant-1",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      claimToken: "claim-1",
      leaseId: "lease-1",
      issuedAt: "2026-08-14T00:06:00.000Z",
      expiresAt: "2099-08-14T00:10:00.000Z",
    };
    installLocalFederatedResumeStartGrant(
      logDir,
      "TASK-1330",
      startGrant,
      "2026-08-14T00:06:01.000Z",
    );
    const pendingStart = advanceLocalFederatedResumeState(logDir, "TASK-1330", {
      startGrant,
      status: "approved_but_not_started",
      now: "2026-08-14T00:06:01.000Z",
    });
    expect(pendingStart.status).toBe("approved_but_not_started");
  });

  it.each(["approved", "rejected"] as const)(
    "does not reuse a stale %s decision for a later same-gate pause occurrence",
    (action) => {
      const logDir = path.join(projectRoot, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      const approvalPath = path.join(approvalDir, "TASK-1330-judge.json");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, "checkpoint-TASK-1330.json"),
        JSON.stringify({ taskId: "TASK-1330", sessionId: "session-original" }),
      );
      fs.writeFileSync(
        path.join(logDir, "events-session-original.jsonl"),
        `${JSON.stringify({
          sessionId: "session-original",
          taskId: "TASK-1330",
          project: "demo",
          timestamp: "2026-08-14T00:00:00.000Z",
          stage: "session_start",
          payload: { jobId: "fed-task-1330", hostId: "laptop", federated: true },
        })}\n`,
      );
      const writeDecision = (createdAt: string): void => {
        fs.writeFileSync(
          approvalPath,
          JSON.stringify({
            state: action,
            createdAt,
            ...(action === "rejected" ? { rejectionReason: "needs revision" } : {}),
          }),
        );
      };
      const armOccurrence = (generation: number, pauseOpenedAt: string): void => {
        armLocalFederatedResume(logDir, {
          projectId: "demo",
          taskId: "TASK-1330",
          jobType: "dispatch",
          gate: "judge",
          jobId: "fed-task-1330",
          hostId: "laptop",
          sessionId: "session-original",
          generation,
          releaseNonce: `nonce-${generation}`,
          pauseOpenedAt,
        });
      };

      const firstOpenedAt = "2026-08-14T00:05:00.000Z";
      writeDecision(firstOpenedAt);
      armOccurrence(1, firstOpenedAt);
      expect(reconcileLocalFederatedResumeDecision(logDir, "TASK-1330")?.decision?.action).toBe(
        action,
      );

      const secondOpenedAt = "2026-08-14T00:10:00.000Z";
      expect(() =>
        armLocalFederatedResume(logDir, {
          projectId: "other-project",
          taskId: "TASK-1330",
          jobType: "dispatch",
          gate: "judge",
          jobId: "fed-task-1330",
          hostId: "laptop",
          sessionId: "session-original",
          generation: 2,
          releaseNonce: "nonce-2",
          pauseOpenedAt: secondOpenedAt,
        }),
      ).toThrow("different live federated resume identity");
      armOccurrence(2, secondOpenedAt);
      expect(reconcileLocalFederatedResumeDecision(logDir, "TASK-1330")).toMatchObject({
        status: "armed",
        pauseOpenedAt: secondOpenedAt,
      });
      expect(reconcileLocalFederatedResumeDecision(logDir, "TASK-1330")?.decision).toBeUndefined();

      // A matching decision may legitimately land before the arm request.
      const thirdOpenedAt = "2026-08-14T00:15:00.000Z";
      writeDecision(thirdOpenedAt);
      armOccurrence(3, thirdOpenedAt);
      expect(reconcileLocalFederatedResumeDecision(logDir, "TASK-1330")).toMatchObject({
        status: "decision_recorded",
        pauseOpenedAt: thirdOpenedAt,
        decision: { action },
      });
    },
  );

  it("finalizes an exact reserved grant even when its clock expires during child start", () => {
    const logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "checkpoint-TASK-1330.json"),
      JSON.stringify({
        taskId: "TASK-1330",
        sessionId: "session-original",
      }),
    );
    fs.writeFileSync(
      path.join(logDir, "events-session-original.jsonl"),
      `${JSON.stringify({
        sessionId: "session-original",
        taskId: "TASK-1330",
        project: "demo",
        timestamp: "2026-08-14T00:00:00.000Z",
        stage: "session_start",
        payload: { jobId: "fed-task-1330", hostId: "laptop", federated: true },
      })}\n`,
    );
    armLocalFederatedResume(logDir, {
      projectId: "demo",
      taskId: "TASK-1330",
      jobType: "dispatch",
      gate: "judge",
      jobId: "fed-task-1330",
      hostId: "laptop",
      sessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      pauseOpenedAt: "2026-08-14T00:05:00.000Z",
    });
    fs.writeFileSync(
      path.join(logDir, "approvals", "TASK-1330-judge.json"),
      JSON.stringify({
        state: "approved",
        createdAt: "2026-08-14T00:05:00.000Z",
      }),
    );
    const startGrant = {
      token: "grant-boundary",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      claimToken: "claim-1",
      leaseId: "lease-1",
      issuedAt: "2026-08-14T00:05:00.000Z",
      expiresAt: "2026-08-14T00:05:01.000Z",
    };
    installLocalFederatedResumeStartGrant(
      logDir,
      "TASK-1330",
      startGrant,
      "2026-08-14T00:05:00.500Z",
    );
    reserveLocalFederatedResumeStart(logDir, "TASK-1330", startGrant, "2026-08-14T00:05:00.999Z");

    const finalized = finalizeLocalFederatedResumeStart(
      logDir,
      "TASK-1330",
      startGrant,
      "started",
      "session-resumed",
      "2026-08-14T00:05:01.001Z",
    );
    expect(finalized).toMatchObject({
      status: "started",
      resumedSessionId: "session-resumed",
      startGrantConsumedAt: "2026-08-14T00:05:00.999Z",
    });
  });

  it("sweeps an expired released pause to visible manual recovery without reviving blocked jobs", async () => {
    await saveFederatedJob(
      projectRoot,
      job({
        pause: {
          generation: 1,
          state: "released",
          gate: "judge",
          sessionId: "session-original",
          originalHostId: "laptop",
          releaseNonce: "nonce-1",
          openedAt: "2026-08-14T00:05:00.000Z",
          preparedAt: "2026-08-14T00:05:00.000Z",
          releasedAt: "2026-08-14T00:06:00.000Z",
          sweepAfter: "2026-08-14T00:07:00.000Z",
        },
        lease: undefined,
      }),
    );
    await saveFederatedJob(
      projectRoot,
      job({
        jobId: "fed-task-923-parked",
        taskId: "TASK-923",
        status: "blocked",
        hostId: undefined,
        lease: undefined,
        error: "parked_repro",
      }),
    );
    const context = {
      projectId: "demo",
      projectRoot,
      taskService: null,
      prepCache: null,
      db: {},
      reader: {},
    } as unknown as FederationProjectContext;
    const recovered = await recoverStaleFederatedLeases(context);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      jobId: "fed-task-1330",
      status: "blocked",
      nextAction: "recover_paused_worktree_on_original_host",
      pause: { state: "manual_recovery" },
    });
    expect(await loadFederatedJob(projectRoot, "fed-task-923-parked")).toMatchObject({
      status: "blocked",
      error: "parked_repro",
    });
  });

  it("defers expired-grant recovery only while the grant's exact lease epoch remains live", async () => {
    const startGrant = {
      token: "grant-supervised",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-supervised",
      claimToken: "claim-supervised",
      leaseId: "lease-supervised",
      issuedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-01-01T00:01:00.000Z",
    };
    const supervised = job({
      lease: {
        leaseId: "lease-supervised",
        hostId: "laptop",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: "nonce-supervised",
        openedAt: "2025-01-01T00:00:00.000Z",
        preparedAt: "2025-01-01T00:00:00.000Z",
        decision: { action: "approved", recordedAt: "2025-01-01T00:00:00.000Z" },
        claim: {
          token: "claim-supervised",
          hostId: "laptop",
          claimedAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2025-01-01T00:02:00.000Z",
        },
        startGrant,
      },
    });
    await saveFederatedJob(projectRoot, supervised);
    const context = {
      projectId: "demo",
      projectRoot,
      taskService: null,
      prepCache: null,
      db: {},
      reader: {},
    } as unknown as FederationProjectContext;

    expect(await recoverStaleFederatedLeases(context)).toEqual([]);
    expect(await loadFederatedJob(projectRoot, supervised.jobId)).toMatchObject({
      status: "awaiting_approval",
      lease: { leaseId: "lease-supervised" },
      pause: { state: "approved_but_not_started" },
    });

    await saveFederatedJob(projectRoot, {
      ...supervised,
      lease: { ...supervised.lease!, leaseId: "reassigned-live-lease" },
    });
    const recovered = await recoverStaleFederatedLeases(context);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "blocked",
      pause: { state: "manual_recovery" },
    });
  });

  it("does not let an old stale-recovery listing overwrite an acknowledged start", async () => {
    const startGrant = {
      token: "grant-race",
      projectId: "demo",
      jobId: "fed-task-1330",
      taskId: "TASK-1330",
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-race",
      claimToken: "claim-race",
      leaseId: "lease-race",
      issuedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-01-01T00:01:00.000Z",
    };
    const stale = job({
      status: "awaiting_approval",
      lease: {
        leaseId: "lease-race",
        hostId: "laptop",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-01T00:02:00.000Z",
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: "nonce-race",
        openedAt: "2025-01-01T00:00:00.000Z",
        preparedAt: "2025-01-01T00:00:00.000Z",
        decision: { action: "approved", recordedAt: "2025-01-01T00:00:00.000Z" },
        claim: {
          token: "claim-race",
          hostId: "laptop",
          claimedAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2025-01-01T00:02:00.000Z",
        },
        startGrant,
      },
    });
    await saveFederatedJob(projectRoot, stale);
    const jobsDir = path.join(projectRoot, ".quack", "federation", "jobs");
    const lockPath = path.join(jobsDir, `${stale.jobId}.lock`);
    const jobPath = path.join(jobsDir, `${stale.jobId}.json`);
    fs.writeFileSync(lockPath, "test holds the update fence", "utf-8");
    const context = {
      projectId: "demo",
      projectRoot,
      taskService: null,
      prepCache: null,
      db: {},
      reader: {},
    } as unknown as FederationProjectContext;
    const recovery = recoverStaleFederatedLeases(context);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const started: FederatedJobRecord = {
      ...stale,
      status: "running",
      remoteSessionId: "session-resumed",
      lease: {
        ...stale.lease!,
        expiresAt: "2099-01-01T00:02:00.000Z",
      },
      pause: {
        ...stale.pause!,
        resumedAt: "2026-09-09T00:00:00.000Z",
        startGrant: {
          ...startGrant,
          consumedAt: "2026-09-09T00:00:00.000Z",
          resumedSessionId: "session-resumed",
        },
      },
    };
    fs.writeFileSync(jobPath, JSON.stringify(started, null, 2), "utf-8");
    fs.rmSync(lockPath);

    expect(await recovery).toEqual([]);
    expect(await loadFederatedJob(projectRoot, stale.jobId)).toMatchObject({
      status: "running",
      remoteSessionId: "session-resumed",
      lease: { leaseId: "lease-race", expiresAt: "2099-01-01T00:02:00.000Z" },
      pause: { startGrant: { resumedSessionId: "session-resumed" } },
    });
  });

  it("does not let a delayed unavailable-host claim overwrite a resumed or terminal job", async () => {
    const resumeRequested = job({
      status: "awaiting_approval",
      pause: {
        generation: 1,
        state: "resume_requested",
        gate: "judge",
        sessionId: "session-original",
        originalHostId: "laptop",
        releaseNonce: "nonce-manual-race",
        openedAt: "2026-09-09T00:00:00.000Z",
        preparedAt: "2026-09-09T00:00:00.000Z",
        decision: { action: "approved", recordedAt: "2026-09-09T00:01:00.000Z" },
      },
    });
    await saveFederatedJob(projectRoot, resumeRequested);
    const jobsDir = path.join(projectRoot, ".quack", "federation", "jobs");
    const lockPath = path.join(jobsDir, `${resumeRequested.jobId}.lock`);
    const jobPath = path.join(jobsDir, `${resumeRequested.jobId}.json`);
    fs.writeFileSync(lockPath, "hold unavailable-host conversion", "utf-8");
    const delayed = markFederatedPauseManualRecovery(projectRoot, {
      jobId: resumeRequested.jobId,
      hostId: "laptop",
      generation: 1,
      releaseNonce: "nonce-manual-race",
      reason: "host became unavailable",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    fs.writeFileSync(
      jobPath,
      JSON.stringify({ ...resumeRequested, status: "running" }, null, 2),
      "utf-8",
    );
    fs.rmSync(lockPath);

    await expect(delayed).rejects.toMatchObject({ code: "federated_resume_not_recoverable" });
    expect(await loadFederatedJob(projectRoot, resumeRequested.jobId)).toMatchObject({
      status: "running",
      pause: { state: "resume_requested" },
    });

    await saveFederatedJob(projectRoot, { ...resumeRequested, status: "completed" });
    await expect(
      markFederatedPauseManualRecovery(projectRoot, {
        jobId: resumeRequested.jobId,
        hostId: "laptop",
        generation: 1,
        releaseNonce: "nonce-manual-race",
        reason: "late retry",
      }),
    ).rejects.toMatchObject({ code: "federated_resume_not_recoverable" });
    expect(await loadFederatedJob(projectRoot, resumeRequested.jobId)).toMatchObject({
      status: "completed",
    });
  });
});
