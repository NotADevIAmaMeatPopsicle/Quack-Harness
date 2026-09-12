import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  repairFederatedJobLockOffline,
  type OfflineFederatedLockRecoveryStage,
} from "../../src/monitor/federation/offline-lock-recovery";
import {
  currentFederatedLockProcessIdentity,
  FederatedJobLockBusyError,
  setFederatedJobLockOptionsForTests,
  withFederatedJobLock,
  type FederatedJobProcessIdentity,
  type FederatedJobProcessProbe,
} from "../../src/monitor/federation/store";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const STALE = new Date("2020-01-01T00:00:00.000Z");
const OWNER_TOKEN = "00000000-0000-4000-8000-000000000321";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("offline federation lock recovery", () => {
  let root: string;
  let jobsDir: string;
  let nativeIdentity: FederatedJobProcessIdentity | undefined;
  const pendingOperations = new Set<Promise<unknown>>();
  const pendingBodies = new Set<Promise<unknown>>();
  const releaseGates = new Set<() => void>();

  beforeEach(() => {
    if (pendingOperations.size > 0 || pendingBodies.size > 0) {
      throw new Error(`Previous recovery is still running; preserving fixture ${root}`);
    }
    return trackBody(
      (async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-offline-lock-"));
        jobsDir = path.join(root, ".quack", "federation", "jobs");
        fs.mkdirSync(jobsDir, { recursive: true });
        // Successful self-identity is immutable for this worker, just as in production.
        // Teardown resets the module cache; retain the real native evidence across fixtures.
        nativeIdentity ??= await currentFederatedLockProcessIdentity(root);
        setFederatedJobLockOptionsForTests({ currentProcessIdentityForTest: nativeIdentity });
      })(),
    );
  });

  afterEach(async () => {
    for (const release of releaseGates) release();
    await drainOperations(true);
    releaseGates.clear();
    setFederatedJobLockOptionsForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function own<T>(operation: Promise<T>, release?: () => void): Promise<T> {
    pendingOperations.add(operation);
    if (release) releaseGates.add(release);
    const settled = () => pendingOperations.delete(operation);
    void operation.then(settled, settled);
    return operation;
  }

  function trackBody<T>(body: Promise<T>): Promise<T> {
    pendingBodies.add(body);
    const settled = () => pendingBodies.delete(body);
    void body.then(settled, settled);
    return body;
  }

  function ownedTest(name: string, body: () => Promise<void>): void {
    test(name, () => trackBody(body()));
  }

  async function waitForStage(stage: Promise<void>, operation: Promise<unknown>): Promise<void> {
    await Promise.race([
      stage,
      operation.then(() => {
        throw new Error("Recovery completed before the expected fixture stage");
      }),
    ]);
  }

  async function drainOperations(includeBodies = false): Promise<void> {
    const outstanding = () => [...pendingOperations, ...(includeBodies ? pendingBodies : [])];
    if (outstanding().length === 0) return;
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(outstanding()),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 2_000);
        }),
      ]);
      if (outstanding().length > 0) {
        throw new Error(`Recovery did not settle; preserving fixture ${root}`);
      }
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  function lockPath(jobId: string): string {
    return path.join(jobsDir, `${jobId}.lock`);
  }

  function writeLegacy(jobId: string, bytes = Buffer.alloc(0), stale = true): string {
    const target = lockPath(jobId);
    fs.writeFileSync(target, bytes);
    if (stale) fs.utimesSync(target, STALE, STALE);
    else fs.utimesSync(target, new Date(NOW - 100), new Date(NOW - 100));
    return target;
  }

  function v1Record(host = os.hostname()): Record<string, unknown> {
    return {
      version: 1,
      ownerToken: OWNER_TOKEN,
      host,
      pid: process.pid,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
  }

  function writeV1File(jobId: string, host = os.hostname()): string {
    const target = lockPath(jobId);
    fs.writeFileSync(target, JSON.stringify(v1Record(host)), "utf8");
    fs.utimesSync(target, STALE, STALE);
    return target;
  }

  function writeV1Directory(jobId: string, extra = false): string {
    const target = lockPath(jobId);
    fs.mkdirSync(target);
    const owner = path.join(target, `owner-${OWNER_TOKEN}.json`);
    fs.writeFileSync(owner, JSON.stringify(v1Record()), "utf8");
    fs.utimesSync(owner, STALE, STALE);
    if (extra) fs.writeFileSync(path.join(target, "unexpected"), "evidence", "utf8");
    return target;
  }

  async function inspect(jobId: string) {
    return repairFederatedJobLockOffline({
      projectRoot: root,
      jobId,
      staleMs: 1_000,
      nowForTest: () => NOW,
    });
  }

  async function apply(jobId: string, fingerprint: string) {
    return repairFederatedJobLockOffline({
      projectRoot: root,
      jobId,
      staleMs: 1_000,
      nowForTest: () => NOW,
      apply: true,
      confirmOffline: true,
      expectedFingerprint: fingerprint,
    });
  }

  test("dry-runs without mutation and recovers the exact stale zero-byte legacy inode", async () => {
    const jobId = "legacy-stale";
    const target = writeLegacy(jobId);
    const before = fs.statSync(target);

    const preview = await inspect(jobId);
    expect(preview).toMatchObject({
      status: "eligible",
      applied: false,
      kind: "legacy-empty-file",
    });
    expect(fs.statSync(target).ino).toBe(before.ino);

    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
      status: "recovered",
      applied: true,
      resumed: false,
    });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock.`))).toEqual([]);
  });

  test("preserves recovery evidence on unavailable identity and retries the same probe", async () => {
    const jobId = "unavailable-identity";
    const target = writeLegacy(jobId);
    const before = fs.statSync(target);
    const bytes = fs.readFileSync(target);
    const entries = fs.readdirSync(jobsDir).sort();
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    if (!nativeIdentity) throw new Error("expected native fixture identity");

    const probe = jest
      .fn<Promise<FederatedJobProcessProbe>, [number]>()
      .mockResolvedValueOnce({ state: "unknown" })
      .mockResolvedValue({ state: "alive", identity: nativeIdentity });
    setFederatedJobLockOptionsForTests(undefined);
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: undefined,
      cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe,
    });
    const reached = deferred();
    const stage = jest.fn(() => reached.resolve());
    const failed = own(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: stage,
      }),
    );
    await expect(waitForStage(reached.promise, failed)).rejects.toThrow(
      "Unable to establish the federation lock process incarnation",
    );
    expect(stage).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenLastCalledWith(process.pid);
    expect(fs.statSync(target)).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(fs.readdirSync(jobsDir).sort()).toEqual(entries);

    // No reset between attempts: the failed production cache must evict itself.
    await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
      status: "recovered",
      applied: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(jobsDir)).toEqual([]);
  });

  test.each([
    ["file", writeV1File],
    ["directory", writeV1Directory],
  ] as const)(
    "recovers a stale same-host v1 %s despite its live/reused pid",
    async (_kind, seed) => {
      const jobId = `v1-${_kind}`;
      const target = seed.call(undefined, jobId);
      const preview = await inspect(jobId);
      expect(preview).toMatchObject({ status: "eligible", kind: `v1-${_kind}` });
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
        status: "recovered",
        kind: `v1-${_kind}`,
      });
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  test("requires the exact dry-run fingerprint and preserves a replacement inode", async () => {
    const jobId = "changed-after-preview";
    const target = writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    fs.unlinkSync(target);
    fs.writeFileSync(target, Buffer.alloc(0));
    const changed = new Date("2020-01-02T00:00:00.000Z");
    fs.utimesSync(target, changed, changed);

    await expect(apply(jobId, preview.fingerprint)).rejects.toThrow("exact dry-run inspection");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(jobsDir).filter((name) => name.includes("reclaim-request"))).toEqual([]);
  });

  test("requires offline attestation separately from the exact evidence fingerprint", async () => {
    const jobId = "missing-offline-attestation";
    const target = writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        expectedFingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow("--confirm-offline");
    expect(fs.existsSync(target)).toBe(true);
  });

  test("refuses unrelated control artifacts and leaves all evidence untouched", async () => {
    const jobId = "unknown-control";
    const target = writeLegacy(jobId);
    const control = `${target}.reclaim-request.foreign`;
    fs.writeFileSync(control, "untrusted", "utf8");

    const result = await inspect(jobId);
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("expected refusal");
    expect(result.reason).toContain("Unknown or malformed");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(control, "utf8")).toBe("untrusted");
  });

  test.each([
    ["fresh zero-byte lock", "fresh", () => writeLegacy("fresh", Buffer.alloc(0), false)],
    [
      "nonempty legacy lock",
      "nonempty",
      () => writeLegacy("nonempty", Buffer.from("legacy owner evidence")),
    ],
    ["foreign-host v1 lock", "foreign", () => writeV1File("foreign", "another-host")],
    [
      "v2 lock",
      "v2",
      () => {
        const target = lockPath("v2");
        fs.writeFileSync(
          target,
          JSON.stringify({
            ...v1Record(),
            version: 2,
            processIdentity: { bootId: "a", startedAt: "b" },
          }),
          "utf8",
        );
        fs.utimesSync(target, STALE, STALE);
        return target;
      },
    ],
    ["v1 directory with extra evidence", "extra", () => writeV1Directory("extra", true)],
  ] as const)("refuses a %s without changing it", async (_label, jobId, seed) => {
    const target = seed();
    const before = fs.statSync(target);
    await expect(inspect(jobId)).resolves.toMatchObject({ status: "refused" });
    const after = fs.statSync(target);
    expect(after.ino).toBe(before.ino);
  });

  const symlinkTest = process.platform === "win32" ? test.skip : test;
  symlinkTest("refuses a symbolic-link lock", async () => {
    const real = writeLegacy("real-target");
    fs.symlinkSync(real, lockPath("symlink-lock"));
    const result = await inspect("symlink-lock");
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("expected refusal");
    expect(result.reason).toContain("symbolic link");
    expect(fs.existsSync(real)).toBe(true);
  });

  test("keeps replacement evidence and the blocking request when identity changes before rename", async () => {
    const jobId = "replace-before-rename";
    const target = writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage !== "request_published") return;
          fs.unlinkSync(target);
          fs.writeFileSync(target, Buffer.alloc(0));
          const changed = new Date("2020-01-02T00:00:00.000Z");
          fs.utimesSync(target, changed, changed);
        },
      }),
    ).rejects.toThrow("Canonical lock no longer matches");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(jobsDir).some((name) => name.includes("reclaim-request.offline"))).toBe(
      true,
    );
    await expect(inspect(jobId)).resolves.toMatchObject({
      status: "refused",
      reason: "Canonical lock no longer matches the authorized inode and contents",
    });
  });

  test.each([
    "request_published",
    "quarantine_linked",
    "lock_quarantined",
    "delete_authorized",
    "quarantine_removed",
    "request_removed",
  ] as OfflineFederatedLockRecoveryStage[])(
    "resumes after a crash at %s without deleting unrelated evidence",
    async (crashStage) => {
      const jobId = `crash-${crashStage.replaceAll("_", "-")}`;
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      await expect(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: (stage) => {
            if (stage === crashStage) throw new Error(`crash after ${stage}`);
          },
        }),
      ).rejects.toThrow(`crash after ${crashStage}`);

      await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
        status: "recovered",
        applied: true,
        resumed: true,
      });
      expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
        [],
      );
    },
  );

  ownedTest(
    "a late pre-inspected apply cannot publish a fresh intent after its peer finishes",
    async () => {
      const jobId = "concurrent-singleton";
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      const peerAtCleanup = deferred();
      const releasePeer = deferred();
      const first = own(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: async (stage) => {
            if (stage !== "request_removed") return;
            peerAtCleanup.resolve();
            await releasePeer.promise;
          },
        }),
        releasePeer.resolve,
      );
      try {
        await waitForStage(peerAtCleanup.promise, first);

        let lateIntentPublications = 0;
        const late = own(
          repairFederatedJobLockOffline({
            projectRoot: root,
            jobId,
            staleMs: 1_000,
            nowForTest: () => NOW,
            apply: true,
            confirmOffline: true,
            expectedFingerprint: preview.fingerprint,
            afterStageForTest: (stage) => {
              if (stage === "request_published") lateIntentPublications += 1;
            },
          }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lateIntentPublications).toBe(0);

        releasePeer.resolve();
        await expect(first).resolves.toMatchObject({ status: "recovered" });
        await expect(late).resolves.toMatchObject({ status: "absent", applied: false });
        expect(lateIntentPublications).toBe(0);
        expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
          [],
        );
      } finally {
        releasePeer.resolve();
        await drainOperations();
      }
    },
  );

  ownedTest("serializes concurrent v1 directory quarantine transitions", async () => {
    const jobId = "concurrent-directory-quarantine";
    writeV1Directory(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    const quarantined = deferred();
    const release = deferred();
    const first = own(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: async (stage) => {
          if (stage !== "lock_quarantined") return;
          quarantined.resolve();
          await release.promise;
        },
      }),
      release.resolve,
    );
    try {
      await waitForStage(quarantined.promise, first);
      const second = own(apply(jobId, preview.fingerprint));
      release.resolve();
      await expect(first).resolves.toMatchObject({ status: "recovered" });
      await expect(second).resolves.toMatchObject({ status: "absent", applied: false });
      expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
        [],
      );
    } finally {
      release.resolve();
      await drainOperations();
    }
  });

  test("retries transient EPERM while unlinking the exact file quarantine", async () => {
    const jobId = "quarantine-unlink-retry";
    writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    const unlink = fs.promises.unlink.bind(fs.promises);
    let quarantineAttempts = 0;
    const unlinkSpy = jest.spyOn(fs.promises, "unlink").mockImplementation(async (target) => {
      if (String(target).includes(`${jobId}.lock.offline-recovery-quarantine.`)) {
        quarantineAttempts += 1;
        if (quarantineAttempts < 3) {
          const error = new Error("injected quarantine contention") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      }
      await unlink(target);
    });
    try {
      await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
        status: "recovered",
      });
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(quarantineAttempts).toBe(3);
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual([]);
  });

  ownedTest(
    "dry-run remains lock-free while a mutating recovery holds the internal claim",
    async () => {
      const jobId = "concurrent-late-winner";
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      let releaseLate: (() => void) | undefined;
      let reportInspected: (() => void) | undefined;
      const lateGate = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const lateInspected = new Promise<void>((resolve) => {
        reportInspected = resolve;
      });
      const late = own(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: async (stage) => {
            if (stage !== "target_inspected") return;
            reportInspected?.();
            await lateGate;
          },
        }),
        () => releaseLate?.(),
      );

      try {
        await waitForStage(lateInspected, late);
        await expect(inspect(jobId)).resolves.toMatchObject({ status: "eligible", applied: false });
        releaseLate?.();
        await expect(late).resolves.toMatchObject({ status: "recovered" });
        expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
          [],
        );
      } finally {
        releaseLate?.();
        await drainOperations();
      }
    },
  );

  ownedTest(
    "a second mutating recovery cannot enter while the whole-apply claim is held",
    async () => {
      const jobId = "concurrent-receipt-interleave";
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      const lateInspected = deferred();
      const releaseLate = deferred();
      const late = own(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: async (stage) => {
            if (stage !== "target_inspected") return;
            lateInspected.resolve();
            await releaseLate.promise;
          },
        }),
        releaseLate.resolve,
      );
      try {
        await waitForStage(lateInspected.promise, late);

        let peerEntered = false;
        const finisher = own(
          repairFederatedJobLockOffline({
            projectRoot: root,
            jobId,
            staleMs: 1_000,
            nowForTest: () => NOW,
            apply: true,
            confirmOffline: true,
            expectedFingerprint: preview.fingerprint,
            afterStageForTest: () => {
              peerEntered = true;
            },
          }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(peerEntered).toBe(false);
        releaseLate.resolve();
        await expect(late).resolves.toMatchObject({ status: "recovered" });
        await expect(finisher).resolves.toMatchObject({ status: "absent", applied: false });
        expect(peerEntered).toBe(false);
        expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
          [],
        );
      } finally {
        releaseLate.resolve();
        await drainOperations();
      }
    },
  );

  ownedTest(
    "releases the internal claim after a crash so receipt-backed recovery can resume",
    async () => {
      const jobId = "concurrent-receipt-handoff";
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");

      const lateInspected = deferred();
      const releaseLatePublish = deferred();
      const late = own(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: async (stage) => {
            if (stage === "target_inspected") {
              lateInspected.resolve();
              await releaseLatePublish.promise;
            }
            if (stage === "request_removed") throw new Error("crash while holding recovery claim");
          },
        }),
        releaseLatePublish.resolve,
      );
      try {
        await waitForStage(lateInspected.promise, late);
        releaseLatePublish.resolve();
        await expect(late).rejects.toThrow("crash while holding recovery claim");
        expect(
          fs.existsSync(`${lockPath(jobId)}.reclaim-request.offline.delete-authorized.json`),
        ).toBe(true);
        await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
          status: "recovered",
          resumed: true,
        });
        expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
          [],
        );
      } finally {
        releaseLatePublish.resolve();
        await drainOperations();
      }
    },
  );

  test("reclaims a stale reserved recovery claim before resuming", async () => {
    const jobId = "stale-recovery-claim";
    writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    const claimPath = path.join(jobsDir, "quack-internal-offline-recovery-claim.lock");
    const crashedSnapshot = path.join(root, "crashed-claim-snapshot");
    await withFederatedJobLock(root, "quack-internal-offline-recovery-claim", () => {
      fs.cpSync(claimPath, crashedSnapshot, { recursive: true });
      return Promise.resolve();
    });
    fs.renameSync(crashedSnapshot, claimPath);
    if (fs.statSync(claimPath).isDirectory()) {
      for (const entry of fs.readdirSync(claimPath)) {
        fs.utimesSync(path.join(claimPath, entry), STALE, STALE);
      }
    }
    fs.utimesSync(claimPath, STALE, STALE);
    setFederatedJobLockOptionsForTests({
      retryMs: 1,
      waitTimeoutMs: 1_000,
      staleMs: 5,
      heartbeatMs: 1,
      processIsAlive: () => false,
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
      currentProcessIdentityForTest: { bootId: "test", startedAt: "1" },
    });

    await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
      status: "recovered",
      applied: true,
    });
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual([]);
  });

  ownedTest(
    "fails closed without touching the target when the reserved recovery claim is busy",
    async () => {
      const jobId = "busy-recovery-claim";
      const target = writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");
      setFederatedJobLockOptionsForTests({
        retryMs: 1,
        waitTimeoutMs: 25,
        staleMs: 1_000,
        heartbeatMs: 10,
        currentProcessIdentityForTest: { bootId: "test", startedAt: "1" },
        processIdentityProbeForTest: () =>
          Promise.resolve({ state: "alive", identity: { bootId: "test", startedAt: "1" } }),
      });
      const acquired = deferred();
      const release = deferred();
      const holder = own(
        withFederatedJobLock(root, "quack-internal-offline-recovery-claim", async () => {
          acquired.resolve();
          await release.promise;
        }),
        release.resolve,
      );
      try {
        await waitForStage(acquired.promise, holder);
        await expect(apply(jobId, preview.fingerprint)).rejects.toBeInstanceOf(
          FederatedJobLockBusyError,
        );
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock.`))).toEqual(
          [],
        );
        release.resolve();
        await holder;
      } finally {
        release.resolve();
        await drainOperations();
      }
    },
  );

  test("preserves a replacement file introduced at the quarantine boundary", async () => {
    const jobId = "replace-file-at-quarantine";
    const target = writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    const replacement = "replacement file evidence";

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage !== "canonical_verified") return;
          fs.unlinkSync(target);
          fs.writeFileSync(target, replacement, "utf8");
        },
      }),
    ).rejects.toThrow("replacement evidence was preserved");
    expect(fs.readFileSync(target, "utf8")).toBe(replacement);
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock.`))).toEqual([]);
  });

  test("restores a replacement directory introduced at the quarantine boundary", async () => {
    const jobId = "replace-directory-at-quarantine";
    const target = writeV1Directory(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    const replacementName = "replacement-evidence.txt";

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage !== "canonical_verified") return;
          fs.rmSync(target, { recursive: true, force: true });
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, replacementName), "replacement directory", "utf8");
        },
      }),
    ).rejects.toThrow("replacement evidence was preserved");
    expect(fs.readFileSync(path.join(target, replacementName), "utf8")).toBe(
      "replacement directory",
    );
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock.`))).toEqual([]);
  });

  test("resumes by restoring a replacement directory after crashing immediately after its move", async () => {
    const jobId = "replace-directory-crash-after-move";
    const target = writeV1Directory(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    const replacementName = "replacement-evidence.txt";

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage === "canonical_verified") {
            fs.rmSync(target, { recursive: true, force: true });
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, replacementName), "replacement directory", "utf8");
          }
          if (stage === "directory_quarantine_moved") {
            throw new Error("crash after raw directory move");
          }
        },
      }),
    ).rejects.toThrow("crash after raw directory move");
    expect(fs.existsSync(target)).toBe(false);
    const captured = fs
      .readdirSync(jobsDir)
      .find((name) => name.startsWith(`${jobId}.lock.offline-recovery-quarantine.`));
    expect(captured).toBeDefined();
    expect(fs.readFileSync(path.join(jobsDir, captured!, replacementName), "utf8")).toBe(
      "replacement directory",
    );

    const resumed = await apply(jobId, preview.fingerprint);
    expect(resumed).toMatchObject({ status: "refused", applied: false });
    if (resumed.status !== "refused") throw new Error("expected refused recovery");
    expect(resumed.reason).toContain("captured replacement evidence was restored");
    expect(fs.readFileSync(path.join(target, replacementName), "utf8")).toBe(
      "replacement directory",
    );
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock.`))).toEqual([]);
  });

  test("refreshes a stale no-receipt directory snapshot before deciding to restore", async () => {
    const jobId = "directory-stale-no-receipt-snapshot";
    writeV1Directory(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");
    const receiptPath = `${lockPath(jobId)}.reclaim-request.offline.delete-authorized.json`;
    let receiptBytes: Buffer | undefined;

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage !== "directory_owner_removed") return;
          receiptBytes = fs.readFileSync(receiptPath);
          fs.unlinkSync(receiptPath);
          throw new Error("crash with stale no-receipt snapshot");
        },
      }),
    ).rejects.toThrow("crash with stale no-receipt snapshot");
    expect(receiptBytes).toBeDefined();

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage === "displaced_quarantine_reinspected") {
            fs.writeFileSync(receiptPath, receiptBytes!);
          }
        },
      }),
    ).resolves.toMatchObject({ status: "recovered" });
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual([]);
  });

  test("resumes an authorized v1 directory after crashing between owner unlink and rmdir", async () => {
    const jobId = "directory-owner-unlinked";
    writeV1Directory(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage === "directory_owner_removed") {
            throw new Error("crash after directory owner unlink");
          }
        },
      }),
    ).rejects.toThrow("crash after directory owner unlink");

    const quarantine = fs
      .readdirSync(jobsDir)
      .find((name) => name.startsWith(`${jobId}.lock.offline-recovery-quarantine.`));
    expect(quarantine).toBeDefined();
    expect(fs.readdirSync(path.join(jobsDir, quarantine!))).toEqual([]);
    await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
      status: "recovered",
      kind: "v1-directory",
      resumed: true,
    });
    expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual([]);
  });

  test("binds a hard-linked lock fingerprint to its canonical project and lock path", async () => {
    const jobId = "cross-project-hardlink";
    const firstTarget = writeLegacy(jobId);
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-offline-lock-peer-"));
    const secondJobs = path.join(secondRoot, ".quack", "federation", "jobs");
    fs.mkdirSync(secondJobs, { recursive: true });
    const secondTarget = path.join(secondJobs, `${jobId}.lock`);
    fs.linkSync(firstTarget, secondTarget);
    try {
      const firstPreview = await inspect(jobId);
      const secondPreview = await repairFederatedJobLockOffline({
        projectRoot: secondRoot,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
      });
      if (firstPreview.status !== "eligible" || secondPreview.status !== "eligible") {
        throw new Error("expected eligible previews");
      }
      expect(secondPreview.fingerprint).not.toBe(firstPreview.fingerprint);
      await expect(
        repairFederatedJobLockOffline({
          projectRoot: secondRoot,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: firstPreview.fingerprint,
        }),
      ).rejects.toThrow("exact dry-run inspection");
      expect(fs.existsSync(firstTarget)).toBe(true);
      expect(fs.existsSync(secondTarget)).toBe(true);
    } finally {
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["zero-byte", ""],
    ["partial", '{"version":'],
  ])(
    "an authorized apply, but not a dry-run, cleans %s transaction staging",
    async (label, bytes) => {
      const jobId = `publication-staging-${label}`;
      writeLegacy(jobId);
      const preview = await inspect(jobId);
      if (preview.status !== "eligible") throw new Error("expected eligible preview");
      const orphanId = "00000000-0000-4000-8000-000000000777";

      await expect(
        repairFederatedJobLockOffline({
          projectRoot: root,
          jobId,
          staleMs: 1_000,
          nowForTest: () => NOW,
          apply: true,
          confirmOffline: true,
          expectedFingerprint: preview.fingerprint,
          afterStageForTest: (stage) => {
            if (stage !== "intent_staged") return;
            const staging = fs
              .readdirSync(jobsDir)
              .find((name) => name.startsWith(`${jobId}.lock.offline-recovery-publish.intent.`));
            if (!staging) throw new Error("expected scoped staging artifact");
            const requestToken = /\.intent\.([0-9a-f-]{36})\.[0-9a-f-]{36}\.json$/iu.exec(
              staging,
            )?.[1];
            if (!requestToken) throw new Error("expected staging request token");
            fs.writeFileSync(
              path.join(
                jobsDir,
                `${jobId}.lock.offline-recovery-publish.intent.${requestToken}.${orphanId}.json`,
              ),
              bytes,
              "utf8",
            );
            throw new Error("injected publication failure");
          },
        }),
      ).rejects.toThrow("injected publication failure");

      expect(
        fs
          .readdirSync(jobsDir)
          .filter((name) => name.startsWith(`${jobId}.lock.offline-recovery-publish.`)),
      ).toHaveLength(1);
      await expect(inspect(jobId)).resolves.toMatchObject({ status: "eligible" });
      expect(
        fs
          .readdirSync(jobsDir)
          .filter((name) => name.startsWith(`${jobId}.lock.offline-recovery-publish.`)),
      ).toHaveLength(1);
      await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({
        status: "recovered",
      });
      expect(fs.readdirSync(jobsDir).filter((name) => name.startsWith(`${jobId}.lock`))).toEqual(
        [],
      );
    },
  );

  test("authorized apply cleans scoped staging left after recovery completes", async () => {
    const jobId = "publication-staging-after-completion";
    writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    const orphanId = "00000000-0000-4000-8000-000000000778";
    let orphanPath: string | undefined;
    const crashedPublisher = repairFederatedJobLockOffline({
      projectRoot: root,
      jobId,
      staleMs: 1_000,
      nowForTest: () => NOW,
      apply: true,
      confirmOffline: true,
      expectedFingerprint: preview.fingerprint,
      afterStageForTest: (stage) => {
        if (stage !== "intent_staged") return;
        const staging = fs
          .readdirSync(jobsDir)
          .find((name) => name.startsWith(`${jobId}.lock.offline-recovery-publish.intent.`));
        const requestToken = staging
          ? /\.intent\.([0-9a-f-]{36})\.[0-9a-f-]{36}\.json$/iu.exec(staging)?.[1]
          : undefined;
        if (!requestToken) throw new Error("expected staging request token");
        orphanPath = path.join(
          jobsDir,
          `${jobId}.lock.offline-recovery-publish.intent.${requestToken}.${orphanId}.json`,
        );
        throw new Error("injected crash after capturing scoped staging");
      },
    });

    await expect(crashedPublisher).rejects.toThrow("injected crash after capturing scoped staging");
    await expect(apply(jobId, preview.fingerprint)).resolves.toMatchObject({ status: "recovered" });
    expect(orphanPath).toBeDefined();
    fs.writeFileSync(orphanPath!, "", "utf8");
    expect(fs.existsSync(orphanPath!)).toBe(true);
    expect(fs.existsSync(lockPath(jobId))).toBe(false);

    const dryRun = await inspect(jobId);
    expect(dryRun.status).toBe("refused");
    if (dryRun.status !== "refused") throw new Error("expected staging debris refusal");
    expect(dryRun.reason).toContain("Orphaned offline recovery publication staging");
    expect(fs.existsSync(orphanPath!)).toBe(true);

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: "b".repeat(64),
      }),
    ).resolves.toMatchObject({ status: "refused", applied: false });
    expect(fs.existsSync(orphanPath!)).toBe(true);

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
      }),
    ).resolves.toMatchObject({
      status: "staging-cleaned",
      applied: true,
      fingerprint: preview.fingerprint,
      removedArtifacts: 1,
    });
    expect(fs.existsSync(orphanPath!)).toBe(false);
  });

  test.each([
    ["win32", "lock", (jobId: string) => writeLegacy(jobId.toUpperCase())],
    [
      "win32",
      "control artifact",
      (jobId: string) => {
        const target = writeLegacy(jobId);
        const alias = `${target}.Reclaim-Request.offline.json`;
        fs.writeFileSync(alias, "{}", "utf8");
        return alias;
      },
    ],
    ["darwin", "lock", (jobId: string) => writeLegacy(jobId.toUpperCase())],
    [
      "darwin",
      "control artifact",
      (jobId: string) => {
        const target = writeLegacy(jobId);
        const alias = `${target}.Reclaim-Request.offline.json`;
        fs.writeFileSync(alias, "{}", "utf8");
        return alias;
      },
    ],
  ] as const)(
    "refuses non-canonical %s casing on %s before mutation",
    async (platform, _label, seed) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const jobId = "case-offline-spelling";
      try {
        const artifact = seed(jobId);
        const result = await inspect(jobId);
        expect(result.status).toBe("refused");
        if (result.status !== "refused") throw new Error("expected refusal");
        expect(result.reason).toContain("non-canonical casing");
        expect(fs.existsSync(artifact)).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    },
  );

  test("the durable offline request keeps normal online acquisition fail closed", async () => {
    const jobId = "online-blocked";
    writeLegacy(jobId);
    const preview = await inspect(jobId);
    if (preview.status !== "eligible") throw new Error("expected eligible preview");

    await expect(
      repairFederatedJobLockOffline({
        projectRoot: root,
        jobId,
        staleMs: 1_000,
        nowForTest: () => NOW,
        apply: true,
        confirmOffline: true,
        expectedFingerprint: preview.fingerprint,
        afterStageForTest: (stage) => {
          if (stage === "request_published") throw new Error("simulated operator crash");
        },
      }),
    ).rejects.toThrow("simulated operator crash");

    await expect(
      withFederatedJobLock(root, jobId, () => Promise.resolve(undefined), {
        retryMs: 1,
        waitTimeoutMs: 10,
        staleMs: 5,
        heartbeatMs: 1,
        currentProcessIdentityForTest: { bootId: "test", startedAt: "1" },
        processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
        processIsAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
  });

  test("refuses unsafe job-id path traversal", async () => {
    await expect(
      repairFederatedJobLockOffline({ projectRoot: root, jobId: "../outside" }),
    ).rejects.toThrow("unsafe path characters");
  });
});
