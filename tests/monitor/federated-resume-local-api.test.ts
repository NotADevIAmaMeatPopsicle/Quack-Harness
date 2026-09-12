import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { createMonitorServer } from "../../src/monitor/server";
import type { FederatedResumeStartGrant } from "../../src/monitor/federation/types";
import {
  createDivergentTaskFixture,
  taskSpec,
  writeTestAdapter,
  type DivergentTaskFixture,
} from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

async function postJson(
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

async function getJson(
  port: number,
  pathname: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: pathname }, (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          }),
        );
      })
      .on("error", reject);
  });
}

describe("federated resume local start grant", () => {
  const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
  let fixture: DivergentTaskFixture;
  let logDir: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    fixture = createDivergentTaskFixture("parent-first", {
      prefix: "quack-federated-resume-local-",
    });
    writeTestAdapter(fixture.root);
    logDir = path.join(fixture.root, ".quack", "logs");
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
    execFileSync("git", ["init"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "quack-tests@example.invalid"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Tests"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
    jest.restoreAllMocks();
    fixture.cleanup();
  });

  async function startMonitor(): Promise<number> {
    const monitor = createMonitorServer({
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      logDir,
      adapterPath: path.join(fixture.root, ".quack", "adapter.json"),
      quackRoot: fixture.root,
      port: 0,
      host: "127.0.0.1",
    });
    const started = await monitor.start();
    stop = started.stop;
    return started.port;
  }

  function writeOriginalRun(decision: "approved" | "rejected"): void {
    const sessionId = "session-original";
    fs.writeFileSync(
      path.join(logDir, "checkpoint-TASK-100.json"),
      JSON.stringify({ taskId: "TASK-100", sessionId }),
    );
    fs.writeFileSync(
      path.join(logDir, `events-${sessionId}.jsonl`),
      `${JSON.stringify({
        sessionId,
        taskId: "TASK-100",
        project: "prefix-selection-fixture",
        timestamp: new Date().toISOString(),
        stage: "session_start",
        payload: { jobId: "fed-resume-100", hostId: "laptop", federated: true },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(logDir, "approvals", "TASK-100.json"),
      JSON.stringify({ state: decision, createdAt: pauseOpenedAt }),
    );
  }

  async function arm(port: number): Promise<void> {
    const response = await postJson(port, "/api/tasks/TASK-100/federated-resume/arm", {
      projectId: "prefix-selection-fixture",
      taskId: "TASK-100",
      jobType: "dispatch",
      gate: "blueprint",
      jobId: "fed-resume-100",
      hostId: "laptop",
      sessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      pauseOpenedAt,
    });
    expect(response.status).toBe(201);
  }

  function grant(overrides: Partial<FederatedResumeStartGrant> = {}): FederatedResumeStartGrant {
    return {
      token: "grant-1",
      projectId: "prefix-selection-fixture",
      jobId: "fed-resume-100",
      taskId: "TASK-100",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 1,
      releaseNonce: "nonce-1",
      claimToken: "claim-1",
      leaseId: "lease-1",
      issuedAt: "2026-09-09T00:00:00.000Z",
      expiresAt: "2099-09-09T00:05:00.000Z",
      ...overrides,
    };
  }

  async function installGrant(
    port: number,
    startGrant: FederatedResumeStartGrant = grant(),
    resumedSessionId?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return postJson(port, "/api/tasks/TASK-100/federated-resume/grant", {
      projectId: "prefix-selection-fixture",
      originalSessionId: "session-original",
      ...(resumedSessionId ? { resumedSessionId } : {}),
      startGrant,
    });
  }

  function resumeRequest(
    startGrant: FederatedResumeStartGrant,
    resumedSessionId?: string,
  ): Record<string, unknown> {
    return {
      projectId: "prefix-selection-fixture",
      originalSessionId: "session-original",
      ...(resumedSessionId ? { resumedSessionId } : {}),
      startGrant,
    };
  }

  it("validates the exact grant before start and allows only an observed exact replay", async () => {
    writeOriginalRun("approved");
    let started = false;
    const resumedJob: DispatchJob = {
      taskId: "TASK-100",
      sessionId: "session-resumed",
      pid: 1234,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      federatedJobId: "fed-resume-100",
      federatedHostId: "laptop",
      federatedLeaseId: "lease-1",
    };
    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockImplementation(() => {
      started = true;
      return resumedJob;
    });
    jest
      .spyOn(DispatchManager.prototype, "getActiveJob")
      .mockImplementation(() => (started ? resumedJob : undefined));
    const port = await startMonitor();
    await arm(port);

    const missingGrant = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {});
    expect(missingGrant.status).toBe(400);

    const uninstalled = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant()),
    });
    expect(uninstalled.status).toBe(409);
    expect(uninstalled.body).toMatchObject({ error: "federated_resume_grant_not_installed" });
    expect(startSpy).not.toHaveBeenCalled();

    const wrongIdentity = await installGrant(port, grant({ originalSessionId: "wrong-session" }));
    expect(wrongIdentity.status).toBe(409);
    expect(startSpy).not.toHaveBeenCalled();

    for (const invalidGrant of [
      grant({ projectId: "other-project" }),
      grant({ taskId: "TASK-OTHER" }),
      grant({ hostId: "other-host" }),
      grant({
        issuedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
      }),
    ]) {
      const refused = await installGrant(port, invalidGrant);
      expect(refused.status).toBe(409);
      expect(startSpy).not.toHaveBeenCalled();
    }

    const installed = await installGrant(port);
    expect(installed.status).toBe(201);
    expect(installed.body).toMatchObject({
      ok: true,
      state: { startGrant: { token: "grant-1", leaseId: "lease-1" } },
    });
    const installedAgain = await installGrant(port);
    expect(installedAgain.status).toBe(201);

    const preselectedChild = await postJson(
      port,
      "/api/tasks/TASK-100/federated-resume/start",
      resumeRequest(grant(), "attacker-selected-session"),
    );
    expect(preselectedChild.status).toBe(409);
    expect(preselectedChild.body).toMatchObject({ error: "federated_resume_session_mismatch" });
    expect(startSpy).not.toHaveBeenCalled();

    const wrongLease = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant({ leaseId: "old-lease" })),
    });
    expect(wrongLease.status).toBe(409);
    expect(startSpy).not.toHaveBeenCalled();

    const simultaneousStarts = await Promise.all([
      postJson(port, "/api/tasks/TASK-100/federated-resume/start", resumeRequest(grant())),
      postJson(port, "/api/tasks/TASK-100/federated-resume/start", resumeRequest(grant())),
    ]);
    expect(simultaneousStarts.map((response) => response.status).sort()).toEqual([202, 409]);
    const accepted = simultaneousStarts.find((response) => response.status === 202)!;
    const concurrentReplay = simultaneousStarts.find((response) => response.status === 409)!;
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ ok: true, sessionId: "session-resumed" });
    expect(concurrentReplay.body).toMatchObject({
      error: "federated_resume_session_mismatch",
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[1]).toMatchObject({
      federatedJobId: "fed-resume-100",
      federatedHostId: "laptop",
      federatedLeaseId: "lease-1",
    });
    expect(startSpy.mock.calls[0]?.[1]?.admittedTaskContentHash).toMatch(/^[0-9a-f]{64}$/);

    const replay = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant(), "session-resumed"),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ alreadyStarted: true, sessionId: "session-resumed" });
    expect(startSpy).toHaveBeenCalledTimes(1);

    const mismatchedGrantReplay = await postJson(
      port,
      "/api/tasks/TASK-100/federated-resume/grant",
      {
        projectId: "prefix-selection-fixture",
        originalSessionId: "session-original",
        resumedSessionId: "different-resumed-session",
        startGrant: grant(),
      },
    );
    expect(mismatchedGrantReplay.status).toBe(409);
    expect(mismatchedGrantReplay.body).toMatchObject({
      error: "federated_resume_session_mismatch",
    });

    const wrongSessionGrant = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant({ originalSessionId: "different-original" })),
    });
    expect(wrongSessionGrant.status).toBe(409);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("requires exact project, job, original-session, and resumed-session scope for state reads", async () => {
    writeOriginalRun("approved");
    const port = await startMonitor();
    await arm(port);

    expect((await getJson(port, "/api/tasks/TASK-100/federated-resume-state")).status).toBe(400);
    expect(
      (
        await getJson(
          port,
          "/api/tasks/TASK-100/federated-resume-state?projectId=prefix-selection-fixture&jobId=wrong-job&originalSessionId=session-original",
        )
      ).status,
    ).toBe(409);
    const stateAfterMismatchedRead = JSON.parse(
      fs.readFileSync(path.join(logDir, "federated-resume", "TASK-100.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(stateAfterMismatchedRead).toMatchObject({ status: "armed" });
    expect(stateAfterMismatchedRead).not.toHaveProperty("decision");
    const exact = await getJson(
      port,
      "/api/tasks/TASK-100/federated-resume-state?projectId=prefix-selection-fixture&jobId=fed-resume-100&originalSessionId=session-original",
    );
    expect(exact.status).toBe(200);
    expect(exact.body).toMatchObject({ state: { projectId: "prefix-selection-fixture" } });

    const wrongResumed = await getJson(
      port,
      "/api/tasks/TASK-100/federated-resume-state?projectId=prefix-selection-fixture&jobId=fed-resume-100&originalSessionId=session-original&resumedSessionId=wrong-session",
    );
    expect(wrongResumed.status).toBe(409);
  });

  it("allows an expired exact observed-child replay but rejects an expired mismatch", async () => {
    writeOriginalRun("approved");
    const resumedJob: DispatchJob = {
      taskId: "TASK-100",
      sessionId: "session-resumed",
      pid: 1234,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      federatedJobId: "fed-resume-100",
      federatedHostId: "laptop",
      federatedLeaseId: "lease-1",
    };
    let started = false;
    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockImplementation(() => {
      started = true;
      return resumedJob;
    });
    jest
      .spyOn(DispatchManager.prototype, "getActiveJob")
      .mockImplementation(() => (started ? resumedJob : undefined));
    const port = await startMonitor();
    await arm(port);
    const issuedAtMs = Date.now() - 1_000;
    const expiringGrant = grant({
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect((await installGrant(port, expiringGrant)).status).toBe(201);
    expect(
      (
        await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
          ...resumeRequest(expiringGrant),
        })
      ).status,
    ).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const mismatchedInstall = await installGrant(port, {
      ...expiringGrant,
      leaseId: "stale-lease",
    });
    expect(mismatchedInstall.status).toBe(409);
    const reinstalled = await installGrant(port, expiringGrant, "session-resumed");
    expect(reinstalled.status).toBe(201);

    const exactReplay = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(expiringGrant, "session-resumed"),
    });
    expect(exactReplay.status).toBe(200);
    expect(exactReplay.body).toMatchObject({
      alreadyStarted: true,
      sessionId: "session-resumed",
    });

    const mismatch = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest({ ...expiringGrant, leaseId: "stale-lease" }, "session-resumed"),
    });
    expect(mismatch.status).toBe(409);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a genuinely first local start after the installed grant expires", async () => {
    writeOriginalRun("approved");
    const startSpy = jest.spyOn(DispatchManager.prototype, "start");
    jest.spyOn(DispatchManager.prototype, "getActiveJob").mockReturnValue(undefined);
    const port = await startMonitor();
    await arm(port);
    const expiringGrant = grant({
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 500).toISOString(),
    });
    expect((await installGrant(port, expiringGrant)).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const refused = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(expiringGrant),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "federated_resume_grant_expired" });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("reconciles an exact active child after started-state persistence fails", async () => {
    writeOriginalRun("approved");
    const resumedJob: DispatchJob = {
      taskId: "TASK-100",
      sessionId: "session-resumed",
      pid: 1234,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      federatedJobId: "fed-resume-100",
      federatedHostId: "laptop",
      federatedLeaseId: "lease-1",
    };
    let observedJob: DispatchJob | undefined;
    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockImplementation(() => {
      observedJob = resumedJob;
      return resumedJob;
    });
    jest.spyOn(DispatchManager.prototype, "getActiveJob").mockImplementation(() => observedJob);
    const port = await startMonitor();
    await arm(port);
    const faultGrant = grant({
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    });
    expect((await installGrant(port, faultGrant)).status).toBe(201);

    const mutableFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const realRenameSync = mutableFs.renameSync.bind(mutableFs);
    let resumeStateRenames = 0;
    jest.spyOn(mutableFs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (
        String(newPath).includes(`${path.sep}federated-resume${path.sep}`) &&
        String(newPath).endsWith(`${path.sep}TASK-100.json`)
      ) {
        resumeStateRenames += 1;
        if (resumeStateRenames === 2) throw new Error("injected started projection failure");
      }
      return realRenameSync(oldPath, newPath);
    });

    const launched = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(faultGrant),
    });
    expect(launched.status).toBe(202);
    expect(launched.body).toMatchObject({ sessionId: "session-resumed" });
    expect(launched.body.warning).toEqual(
      expect.stringContaining("injected started projection failure"),
    );
    expect(startSpy).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const unscopedRetry = await postJson(
      port,
      "/api/tasks/TASK-100/federated-resume/start",
      resumeRequest(faultGrant),
    );
    expect(unscopedRetry.status).toBe(409);
    expect(unscopedRetry.body).toMatchObject({ error: "federated_resume_session_missing" });

    observedJob = { ...resumedJob, federatedLeaseId: "different-lease" };
    const mismatched = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(faultGrant, "session-resumed"),
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body).toMatchObject({
      error: "federated_resume_child_observation_mismatch",
    });
    expect(startSpy).toHaveBeenCalledTimes(1);

    observedJob = resumedJob;
    const reconciled = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(faultGrant, "session-resumed"),
    });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({
      alreadyStarted: true,
      sessionId: "session-resumed",
      state: { status: "started", resumedSessionId: "session-resumed" },
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("records a blueprint rejection without starting a child or scanning unrelated claimants", async () => {
    writeOriginalRun("rejected");
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-200-a.md"), taskSpec("TASK-200"));
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-200-b.md"), taskSpec("TASK-200"));
    const startSpy = jest.spyOn(DispatchManager.prototype, "start");
    const port = await startMonitor();
    await arm(port);
    expect((await installGrant(port)).status).toBe(201);

    const response = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant()),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      terminal: true,
    });
    const terminalState = response.body.state as { status?: string; startGrantConsumedAt?: string };
    expect(terminalState.status).toBe("terminal");
    expect(typeof terminalState.startGrantConsumedAt).toBe("string");
    expect(startSpy).not.toHaveBeenCalled();

    expect((await installGrant(port)).status).toBe(201);
    const replay = await postJson(port, "/api/tasks/TASK-100/federated-resume/start", {
      ...resumeRequest(grant()),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, terminal: true });
    expect(startSpy).not.toHaveBeenCalled();
  });
});
