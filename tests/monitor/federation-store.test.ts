import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  currentFederatedLockProcessIdentity,
  FederatedJobLockCompletedActionError,
  FederatedJobLockBusyError,
  federationDir,
  loadFederatedJob,
  saveFederatedJob,
  setFederatedJobLockOptionsForTests,
  setFederatedJobPersistenceHookForTests,
  probeFederatedLockProcessIdentity,
  updateFederatedJob,
  updateFederatedJobExclusive,
  updateFederatedJobWithPostPersistEffect,
  withFederatedJobLock,
  type FederatedJobLockOptions,
  type FederatedJobProcessIdentity,
} from "../../src/monitor/federation/store.js";
import type { FederatedJobRecord } from "../../src/monitor/federation/types.js";

const TEST_LOCK_OPTIONS: FederatedJobLockOptions = {
  retryMs: 2,
  waitTimeoutMs: 1_000,
  staleMs: 40,
  heartbeatMs: 5,
};
const TEST_PROCESS_IDENTITY: FederatedJobProcessIdentity = {
  bootId: "test-boot-a",
  startedAt: "100",
};
const TEST_DARWIN_BOOT_ID = "9d13a267-3d30-42cc-a084-15d8750d699b";
const TEST_DARWIN_PROCESS_START = "Thu Sep 11 14:08:42 2025";
const TEST_DARWIN_PROCESS_IDENTITY: FederatedJobProcessIdentity = {
  bootId: TEST_DARWIN_BOOT_ID,
  startedAt: "2025-09-11T14:08:42.000Z",
};
const LOCK_RELEASE_QUARANTINE_TEST_TAG = ".release-quarantine.";

function makeJob(jobId = "fed-store-lock"): FederatedJobRecord {
  return {
    jobId,
    taskId: "TASK-LOCK",
    jobType: "dispatch",
    status: "completed",
    correlationId: "corr-lock",
    requiredCapabilities: ["dispatch"],
    decision: {},
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lock test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function ownerPath(root: string, jobId: string): string {
  const lockPath = path.join(federationDir(root), `${jobId}.lock`);
  if (fs.statSync(lockPath).isFile()) return lockPath;
  const owner = fs.readdirSync(lockPath).find((entry) => entry.startsWith("owner-"));
  if (!owner) throw new Error("Federation job lock did not publish its owner record");
  return path.join(lockPath, owner);
}

function jobLockPath(root: string, jobId: string): string {
  return path.join(federationDir(root), `${jobId}.lock`);
}

function writeV2Owner(
  lockPath: string,
  options: {
    ownerToken?: string;
    host?: string;
    pid?: number;
    identity?: FederatedJobProcessIdentity;
    stale?: boolean;
  } = {},
): { ownerPath: string; ownerToken: string } {
  const ownerToken = options.ownerToken ?? "00000000-0000-4000-8000-000000000099";
  const ownerFile = path.join(lockPath, `owner-${ownerToken}.json`);
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    ownerFile,
    JSON.stringify({
      version: 2,
      ownerToken,
      host: options.host ?? os.hostname(),
      pid: options.pid ?? 999_999,
      acquiredAt: "2020-01-01T00:00:00.000Z",
      processIdentity: options.identity ?? TEST_PROCESS_IDENTITY,
    }),
    "utf-8",
  );
  if (options.stale !== false) {
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(ownerFile, stale, stale);
  }
  return { ownerPath: ownerFile, ownerToken };
}

describe("federation job store lock", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-store-"));
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
      processIdentityProbeForTest: () =>
        Promise.resolve({
          state: "alive",
          identity: TEST_PROCESS_IDENTITY,
        }),
    });
  });

  afterEach(() => {
    setFederatedJobPersistenceHookForTests(undefined);
    setFederatedJobLockOptionsForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each(["win32", "darwin"] as const)(
    "blocks a casing-aliased %s caller on the actual offline intent path",
    async (platform) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const canonicalJobId = "Fed-Store-Case-Alias";
      const callerJobId = canonicalJobId.toLowerCase();
      const directory = federationDir(root);
      fs.mkdirSync(directory, { recursive: true });
      const intentPath = path.join(
        directory,
        `${canonicalJobId}.lock.reclaim-request.offline.json`,
      );
      fs.writeFileSync(intentPath, "{}", "utf8");
      let entered = false;
      try {
        await expect(
          withFederatedJobLock(
            root,
            callerJobId,
            () => {
              entered = true;
              return Promise.resolve(undefined);
            },
            { ...TEST_LOCK_OPTIONS, waitTimeoutMs: 20 },
          ),
        ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
        expect(entered).toBe(false);
        expect(fs.existsSync(intentPath)).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    },
  );

  test("reports only durability boundaries the current platform actually completes", async () => {
    const initial = makeJob("fed-store-durable-persist");
    const observed: string[] = [];
    setFederatedJobPersistenceHookForTests((stage) => {
      observed.push(stage);
    });

    await saveFederatedJob(root, initial);

    expect(observed).toEqual([
      "record_file_synced",
      "record_published",
      "record_published_file_synced",
      ...(process.platform === "win32" ? [] : ["record_directory_synced"]),
      "record_durability_acknowledged",
      "audit_file_synced",
      ...(process.platform === "win32" ? [] : ["audit_directory_synced"]),
      "audit_durability_acknowledged",
    ]);
    if (process.platform === "win32") {
      expect(observed).not.toContain("record_directory_synced");
      expect(observed).not.toContain("audit_directory_synced");
    }
    await expect(loadFederatedJob(root, initial.jobId)).resolves.toEqual(initial);
  });

  test("leaves no unpublished temp file when persistence stops after the file sync", async () => {
    const initial = makeJob("fed-store-file-sync-crash");
    let injected = false;
    setFederatedJobPersistenceHookForTests((stage) => {
      if (!injected && stage === "record_file_synced") {
        injected = true;
        throw new Error("injected crash after record file sync");
      }
    });

    await expect(saveFederatedJob(root, initial)).rejects.toThrow(
      "injected crash after record file sync",
    );
    expect(fs.existsSync(path.join(federationDir(root), `${initial.jobId}.json`))).toBe(false);
    expect(fs.readdirSync(federationDir(root)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

    setFederatedJobPersistenceHookForTests(undefined);
    await expect(saveFederatedJob(root, initial)).resolves.toBeUndefined();
    await expect(loadFederatedJob(root, initial.jobId)).resolves.toEqual(initial);
  });

  test("keeps the published record replayable when persistence stops before its durable ack", async () => {
    const initial = makeJob("fed-store-published-file-sync-crash");
    let injected = false;
    setFederatedJobPersistenceHookForTests((stage) => {
      if (!injected && stage === "record_published") {
        injected = true;
        throw new Error("injected crash before published record sync");
      }
    });

    await expect(saveFederatedJob(root, initial)).rejects.toThrow(
      "injected crash before published record sync",
    );
    await expect(loadFederatedJob(root, initial.jobId)).resolves.toEqual(initial);

    setFederatedJobPersistenceHookForTests(undefined);
    await expect(saveFederatedJob(root, initial)).resolves.toBeUndefined();
    expect(
      fs
        .readFileSync(path.join(federationDir(root), "records.jsonl"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  test("does not run a post-persist effect before the published record durable ack", async () => {
    const initial = makeJob("fed-store-effect-after-published-sync");
    await saveFederatedJob(root, initial);
    const effect = jest.fn().mockResolvedValue(undefined);
    let injected = false;
    setFederatedJobPersistenceHookForTests((stage) => {
      if (!injected && stage === "record_published") {
        injected = true;
        throw new Error("injected pre-ack publication failure");
      }
    });

    await expect(
      updateFederatedJobWithPostPersistEffect(root, initial.jobId, (current) => ({
        record: { ...current, status: "canceled" },
        effect,
      })),
    ).rejects.toThrow("injected pre-ack publication failure");
    expect(effect).not.toHaveBeenCalled();
    await expect(loadFederatedJob(root, initial.jobId)).resolves.toMatchObject({
      status: "canceled",
    });

    setFederatedJobPersistenceHookForTests(undefined);
    await expect(
      updateFederatedJobWithPostPersistEffect(root, initial.jobId, (current) => ({
        record: current,
        effect,
      })),
    ).resolves.toMatchObject({ record: { status: "canceled" } });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["exclusive transition", "cancellation"],
    ["cancellation", "exclusive transition"],
  ])("keeps a slow live %s ahead of a waiting %s", async (firstLabel, secondLabel) => {
    const initial = makeJob();
    await saveFederatedJob(root, initial);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    let active = 0;
    let maxActive = 0;

    const first = updateFederatedJobExclusive(
      root,
      initial.jobId,
      async (current) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        firstEntered.resolve();
        await releaseFirst.promise;
        active -= 1;
        return {
          ...current,
          status: firstLabel === "cancellation" ? "canceled" : "completed",
          updatedAt: "2026-09-10T00:00:01.000Z",
        };
      },
      TEST_LOCK_OPTIONS,
    );
    await firstEntered.promise;

    const liveOwnerPath = ownerPath(root, initial.jobId);
    const firstHeartbeat = fs.statSync(liveOwnerPath).mtimeMs;
    await waitFor(() => fs.statSync(liveOwnerPath).mtimeMs > firstHeartbeat);
    await new Promise<void>((resolve) => setTimeout(resolve, (TEST_LOCK_OPTIONS.staleMs ?? 0) * 2));

    const second = updateFederatedJob(
      root,
      initial.jobId,
      (current) => {
        secondEntered = true;
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        if (current.status === "canceled") return undefined;
        return {
          ...current,
          status: secondLabel === "cancellation" ? "canceled" : "completed",
          updatedAt: "2026-09-10T00:00:02.000Z",
        };
      },
      TEST_LOCK_OPTIONS,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, (TEST_LOCK_OPTIONS.staleMs ?? 0) * 2));
    expect(secondEntered).toBe(false);
    expect(fs.statSync(liveOwnerPath).mtimeMs).toBeGreaterThan(firstHeartbeat);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect((await loadFederatedJob(root, initial.jobId))?.status).toBe("canceled");
    expect(fs.existsSync(path.join(federationDir(root), `${initial.jobId}.lock`))).toBe(false);
  });

  test("lets a second helper finish an exact release quarantine without losing owner proof", async () => {
    const initial = makeJob("fed-store-release-helper-race");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const quarantineMoved = deferred();
    const resumeFirstHelper = deferred();
    const secondEntered = deferred();
    let pausedFirstHelper = false;
    setFederatedJobLockOptionsForTests({
      ...TEST_LOCK_OPTIONS,
      currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
      processIdentityProbeForTest: () =>
        Promise.resolve({ state: "alive", identity: TEST_PROCESS_IDENTITY }),
      renamePathForTest: async (source, destination) => {
        await fs.promises.rename(source, destination);
        if (
          !pausedFirstHelper &&
          source === lockPath &&
          destination.includes(LOCK_RELEASE_QUARANTINE_TEST_TAG)
        ) {
          pausedFirstHelper = true;
          quarantineMoved.resolve();
          await resumeFirstHelper.promise;
        }
      },
    });

    const first = updateFederatedJobExclusive(root, initial.jobId, (current) =>
      Promise.resolve(current),
    );
    await quarantineMoved.promise;
    const second = updateFederatedJob(root, initial.jobId, (current) => {
      secondEntered.resolve();
      return current;
    });

    try {
      await Promise.race([
        secondEntered.promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("second release helper did not progress")), 1_000),
        ),
      ]);
      await second;
    } finally {
      resumeFirstHelper.resolve();
    }
    await first;
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(federationDir(root))
        .filter(
          (entry) =>
            entry.startsWith(`${initial.jobId}.lock.owner.`) ||
            entry.startsWith(`${initial.jobId}.lock.release`),
        ),
    ).toEqual([]);
  });

  test.each(["malformed", "foreign", "live", "unknown"] as const)(
    "returns retryable busy without deleting %s ownership evidence",
    async (ownerKind) => {
      const initial = makeJob(`fed-store-busy-${ownerKind}`);
      await saveFederatedJob(root, initial);
      const lockPath = path.join(federationDir(root), `${initial.jobId}.lock`);
      fs.mkdirSync(lockPath);
      const ownerToken = "00000000-0000-4000-8000-000000000088";
      const evidencePath =
        ownerKind === "malformed"
          ? path.join(lockPath, "foreign-owner.txt")
          : path.join(lockPath, `owner-${ownerToken}.json`);
      fs.writeFileSync(
        evidencePath,
        ownerKind === "malformed"
          ? "unverifiable"
          : JSON.stringify({
              version: 1,
              ownerToken,
              host: ownerKind === "foreign" ? "remote-host" : os.hostname(),
              pid: 999_998,
              acquiredAt: "2020-01-01T00:00:00.000Z",
            }),
        "utf-8",
      );
      const stale = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(evidencePath, stale, stale);

      let failure: unknown;
      try {
        await updateFederatedJob(
          root,
          initial.jobId,
          (current) => ({ ...current, status: "canceled" }),
          {
            ...TEST_LOCK_OPTIONS,
            waitTimeoutMs: 25,
            processIsAlive: () =>
              ownerKind === "live" ? true : ownerKind === "unknown" ? undefined : false,
          },
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(FederatedJobLockBusyError);
      expect(failure).toMatchObject({
        name: "FederatedJobLockBusyError",
        code: "federated_job_lock_busy",
        retryable: true,
        jobId: initial.jobId,
      });
      expect((await loadFederatedJob(root, initial.jobId))?.status).toBe("completed");
      expect(fs.existsSync(evidencePath)).toBe(true);
    },
  );

  test("retries current-process identity resolution after a transient failure", async () => {
    const initial = makeJob("fed-store-identity-retry");
    await saveFederatedJob(root, initial);

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        currentProcessIdentityForTest: undefined,
        cacheCurrentProcessIdentityForTest: true,
        processIdentityProbeForTest: () => Promise.resolve({ state: "unknown" }),
      }),
    ).rejects.toThrow("Unable to establish the federation lock process incarnation");

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        currentProcessIdentityForTest: undefined,
        cacheCurrentProcessIdentityForTest: true,
        processIdentityProbeForTest: () =>
          Promise.resolve({ state: "alive", identity: TEST_PROCESS_IDENTITY }),
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
  });

  test("establishes a stable Darwin process incarnation through trusted absolute commands", async () => {
    const runCommand = jest.fn(
      (executable: string, _args: string[], _options: unknown): Promise<{ stdout: string }> =>
        Promise.resolve({
          stdout:
            executable === "/usr/sbin/sysctl"
              ? `${TEST_DARWIN_BOOT_ID.toUpperCase()}\n`
              : ` ${TEST_DARWIN_PROCESS_START}\n`,
        }),
    );
    setFederatedJobLockOptionsForTests({
      cacheCurrentProcessIdentityForTest: false,
      platformForTest: "darwin",
      processIdentityCommandForTest: runCommand,
      processIsAlive: () => true,
    });

    await expect(currentFederatedLockProcessIdentity(root)).resolves.toEqual(
      TEST_DARWIN_PROCESS_IDENTITY,
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
      ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
      ["/bin/ps", ["-o", "lstart=", "-p", String(process.pid)]],
    ]);
    for (const [, , options] of runCommand.mock.calls) {
      expect(options).toEqual({
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
        maxBuffer: 16 * 1024,
        shell: false,
        timeout: 2_000,
        windowsHide: true,
      });
    }
  });

  test("reports a Darwin process as dead only after a failed probe and negative liveness proof", async () => {
    const processIsAlive = jest.fn(() => false);
    setFederatedJobLockOptionsForTests({
      platformForTest: "darwin",
      processIdentityCommandForTest: () => Promise.reject(new Error("process not found")),
      processIsAlive,
    });

    await expect(probeFederatedLockProcessIdentity(root, 4242)).resolves.toEqual({
      state: "dead",
    });
    expect(processIsAlive).toHaveBeenCalledWith(4242);
  });

  test.each([true, undefined])(
    "keeps denied Darwin process evidence fail closed when liveness is %s",
    async (liveness) => {
      setFederatedJobLockOptionsForTests({
        platformForTest: "darwin",
        processIdentityCommandForTest: () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          return Promise.reject(error);
        },
        processIsAlive: () => liveness,
      });

      await expect(probeFederatedLockProcessIdentity(root, 4243)).resolves.toEqual({
        state: "unknown",
      });
    },
  );

  test.each([
    ["malformed boot UUID", "not-a-uuid", TEST_DARWIN_PROCESS_START],
    [
      "multiple boot UUID lines",
      `${TEST_DARWIN_BOOT_ID}\n${TEST_DARWIN_BOOT_ID}`,
      TEST_DARWIN_PROCESS_START,
    ],
    ["impossible process date", TEST_DARWIN_BOOT_ID, "Wed Feb 31 14:08:42 2025"],
    ["unexpected process columns", TEST_DARWIN_BOOT_ID, `${TEST_DARWIN_PROCESS_START} extra`],
  ])("keeps %s fail closed", async (_label, bootOutput, startOutput) => {
    setFederatedJobLockOptionsForTests({
      platformForTest: "darwin",
      processIdentityCommandForTest: (executable) =>
        Promise.resolve({
          stdout: executable === "/usr/sbin/sysctl" ? bootOutput : startOutput,
        }),
      processIsAlive: () => true,
    });

    await expect(probeFederatedLockProcessIdentity(root, 4244)).resolves.toEqual({
      state: "unknown",
    });
  });

  test.each([
    ["same", TEST_DARWIN_PROCESS_START, false],
    ["different", "Thu Sep 11 14:08:43 2025", true],
  ] as const)(
    "treats a Darwin PID with the %s incarnation at %s as reclaimable=%s",
    async (_label, observedStart, reclaimable) => {
      const initial = makeJob(`fed-store-darwin-pid-${reclaimable ? "reused" : "same"}`);
      await saveFederatedJob(root, initial);
      const lockPath = jobLockPath(root, initial.jobId);
      const seeded = writeV2Owner(lockPath, {
        identity: TEST_DARWIN_PROCESS_IDENTITY,
        pid: 4245,
      });
      const operation = updateFederatedJob(
        root,
        initial.jobId,
        (current) => ({ ...current, status: "canceled" }),
        {
          ...TEST_LOCK_OPTIONS,
          currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
          platformForTest: "darwin",
          processIdentityCommandForTest: (executable) =>
            Promise.resolve({
              stdout: executable === "/usr/sbin/sysctl" ? TEST_DARWIN_BOOT_ID : observedStart,
            }),
          processIdentityProbeForTest: undefined,
          processIsAlive: () => true,
          waitTimeoutMs: 30,
        },
      );

      if (reclaimable) {
        await expect(operation).resolves.toMatchObject({
          changed: true,
          record: { status: "canceled" },
        });
        expect(fs.existsSync(lockPath)).toBe(false);
      } else {
        await expect(operation).rejects.toBeInstanceOf(FederatedJobLockBusyError);
        expect(fs.existsSync(seeded.ownerPath)).toBe(true);
      }
    },
  );

  test("preserves a legacy file lock byte-for-byte instead of replacing it on Windows", async () => {
    const initial = makeJob("fed-store-legacy-file");
    await saveFederatedJob(root, initial);
    const lockPath = path.join(federationDir(root), `${initial.jobId}.lock`);
    const legacyEvidence = Buffer.from("legacy-lock\r\nowner=unverified\0", "utf-8");
    fs.writeFileSync(lockPath, legacyEvidence);

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        waitTimeoutMs: 25,
        staleMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(fs.readFileSync(lockPath)).toEqual(legacyEvidence);
    expect((await loadFederatedJob(root, initial.jobId))?.status).toBe("completed");
  });

  test("keeps a stale open legacy lock fail closed without ownership evidence", async () => {
    const initial = makeJob("fed-store-legacy-empty");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    fs.writeFileSync(lockPath, Buffer.alloc(0));
    const liveLegacyHandle = fs.openSync(lockPath, "r+");
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, stale, stale);
    let renameAttempts = 0;

    try {
      await expect(
        updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          renamePathForTest: async (source, destination) => {
            renameAttempts += 1;
            await fs.promises.rename(source, destination);
          },
        }),
      ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    } finally {
      fs.closeSync(liveLegacyHandle);
    }
    expect(renameAttempts).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect((await loadFederatedJob(root, initial.jobId))?.status).toBe("completed");
  });

  test("keeps a fresh empty legacy file lock fail closed", async () => {
    const initial = makeJob("fed-store-legacy-fresh");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    fs.writeFileSync(lockPath, Buffer.alloc(0));

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        waitTimeoutMs: 25,
        staleMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(fs.statSync(lockPath).size).toBe(0);
  });

  test("never replaces a legacy file that appears at the canonical name during acquisition", async () => {
    const initial = makeJob("fed-store-acquire-cas");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    let injected = false;
    let callbackEntered = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          callbackEntered = true;
          return { ...current, status: "canceled" };
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          staleMs: 5_000,
          linkPathForTest: async (source, destination) => {
            if (!injected && destination === lockPath && source.includes(".owner.")) {
              fs.writeFileSync(lockPath, Buffer.alloc(0));
              injected = true;
            }
            await fs.promises.link(source, destination);
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(injected).toBe(true);
    expect(callbackEntered).toBe(false);
    expect(fs.statSync(lockPath).size).toBe(0);
  });

  test("restores displaced ownership after a temporary canonical occupant clears", async () => {
    const initial = makeJob("fed-store-displaced-restore");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, {
      ownerToken: "00000000-0000-4000-8000-000000000070",
      pid: 45_002,
    });
    const displacedToken = "00000000-0000-4000-8000-000000000076";
    const temporaryToken = "00000000-0000-4000-8000-000000000077";
    let injected = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        () => {
          throw new Error("a blocked reclaim must not enter the callback");
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: (pid) => pid === process.pid,
          renamePathForTest: async (source, destination) => {
            if (!injected && source === lockPath && destination.includes(".reclaim-quarantine.")) {
              injected = true;
              fs.rmSync(lockPath, { recursive: true, force: true });
              writeV2Owner(lockPath, {
                ownerToken: displacedToken,
                pid: process.pid,
                identity: TEST_PROCESS_IDENTITY,
                stale: false,
              });
              await fs.promises.rename(source, destination);
              writeV2Owner(lockPath, {
                ownerToken: temporaryToken,
                pid: process.pid,
                identity: TEST_PROCESS_IDENTITY,
                stale: false,
              });
              return;
            }
            await fs.promises.rename(source, destination);
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);

    fs.rmSync(lockPath, { recursive: true, force: true });
    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        () => {
          throw new Error("restored live ownership must remain exclusive");
        },
        { ...TEST_LOCK_OPTIONS, waitTimeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
      ownerToken: displacedToken,
    });
    expect(
      fs
        .readdirSync(federationDir(root))
        .filter(
          (entry) => entry.includes(".reclaim-request.") || entry.includes(".reclaim-quarantine."),
        ),
    ).toEqual([]);
  });

  test("clears the exact stale expected owner before restoring displaced ownership", async () => {
    const initial = makeJob("fed-store-displaced-expected");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const expectedToken = "00000000-0000-4000-8000-000000000074";
    const displacedToken = "00000000-0000-4000-8000-000000000075";
    writeV2Owner(lockPath, { ownerToken: expectedToken, pid: 45_001 });
    let injected = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        () => {
          throw new Error("restored live ownership must remain exclusive");
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: (pid) => pid === process.pid,
          renamePathForTest: async (source, destination) => {
            if (!injected && source === lockPath && destination.includes(".reclaim-quarantine.")) {
              injected = true;
              fs.rmSync(lockPath, { recursive: true, force: true });
              writeV2Owner(lockPath, {
                ownerToken: displacedToken,
                pid: process.pid,
                identity: TEST_PROCESS_IDENTITY,
                stale: false,
              });
              await fs.promises.rename(source, destination);
              writeV2Owner(lockPath, { ownerToken: expectedToken, pid: 45_001 });
              return;
            }
            await fs.promises.rename(source, destination);
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
      ownerToken: displacedToken,
    });
    expect(
      fs
        .readdirSync(federationDir(root))
        .filter(
          (entry) =>
            entry.includes(".reclaim-request.") ||
            entry.includes(".reclaim-quarantine.") ||
            entry.endsWith(".occupant"),
        ),
    ).toEqual([]);
  });

  test("keeps stale legacy evidence fail closed during displaced-quarantine recovery", async () => {
    const initial = makeJob("fed-store-displaced-legacy-occupant");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, {
      ownerToken: "00000000-0000-4000-8000-000000000068",
      pid: 45_003,
    });
    let injected = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        () => {
          throw new Error("legacy evidence must keep the transition fenced");
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: (pid) => pid === process.pid,
          renamePathForTest: async (source, destination) => {
            if (!injected && source === lockPath && destination.includes(".reclaim-quarantine.")) {
              injected = true;
              fs.rmSync(lockPath, { recursive: true, force: true });
              writeV2Owner(lockPath, {
                ownerToken: "00000000-0000-4000-8000-000000000069",
                pid: process.pid,
                identity: TEST_PROCESS_IDENTITY,
                stale: false,
              });
              await fs.promises.rename(source, destination);
              fs.writeFileSync(lockPath, Buffer.alloc(0));
              const stale = new Date("2020-01-01T00:00:00.000Z");
              fs.utimesSync(lockPath, stale, stale);
              return;
            }
            await fs.promises.rename(source, destination);
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(fs.statSync(lockPath).size).toBe(0);
    expect(
      fs
        .readdirSync(federationDir(root))
        .some(
          (entry) => entry.includes(".reclaim-request.") || entry.includes(".reclaim-quarantine."),
        ),
    ).toBe(true);
  });

  test.each([
    [
      "different incarnation",
      { state: "alive", identity: { bootId: "test-boot-b", startedAt: "1" } },
      true,
    ],
    ["same incarnation", { state: "alive", identity: TEST_PROCESS_IDENTITY }, false],
    ["unknown incarnation", { state: "unknown" }, false],
  ] as const)("handles a stale live PID with %s", async (_label, probe, reclaimable) => {
    const initial = makeJob(`fed-store-pid-reuse-${reclaimable ? "yes" : probe.state}`);
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const seeded = writeV2Owner(lockPath, { pid: 43210 });
    const operation = updateFederatedJob(
      root,
      initial.jobId,
      (current) => ({ ...current, status: "canceled" }),
      {
        ...TEST_LOCK_OPTIONS,
        waitTimeoutMs: 30,
        processIsAlive: () => true,
        processIdentityProbeForTest: () => Promise.resolve(probe),
      },
    );

    if (reclaimable) {
      await expect(operation).resolves.toMatchObject({
        changed: true,
        record: { status: "canceled" },
      });
      expect(fs.existsSync(lockPath)).toBe(false);
    } else {
      await expect(operation).rejects.toBeInstanceOf(FederatedJobLockBusyError);
      expect(fs.existsSync(seeded.ownerPath)).toBe(true);
    }
  });

  test("recovers a stale owner despite a malformed old canonical reclaim marker", async () => {
    const initial = makeJob("fed-store-malformed-reclaim");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, { pid: 54321 });
    fs.writeFileSync(path.join(lockPath, "reclaim.json"), "{partial", "utf-8");

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        processIsAlive: () => false,
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("preserves a malformed reclaim marker owned by the exact live incarnation", async () => {
    const initial = makeJob("fed-store-live-malformed-reclaim");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, { pid: process.pid });
    const reclaimPath = path.join(lockPath, "reclaim.json");
    fs.writeFileSync(reclaimPath, "{partial", "utf-8");

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        waitTimeoutMs: 30,
        processIsAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(fs.readFileSync(reclaimPath, "utf-8")).toBe("{partial");
  });

  test("scavenges only stale, same-host, provably inactive crash artifacts", async () => {
    const initial = makeJob("fed-store-crash-artifacts");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const ownerToken = "00000000-0000-4000-8000-000000000071";
    const deadOwnerName = `${initial.jobId}.lock.owner.dead-${ownerToken}`;
    const deadOwnerPath = path.join(federationDir(root), deadOwnerName);
    const deadPublishPath = `${lockPath}.publish.dead`;
    const malformedPublishPath = `${lockPath}.publish.malformed`;
    const foreignOwnerName = `${initial.jobId}.lock.owner.foreign-${ownerToken}`;
    const foreignOwnerPath = path.join(federationDir(root), foreignOwnerName);
    const record = {
      version: 2,
      ownerToken,
      host: os.hostname(),
      pid: 54_321,
      acquiredAt: "2020-01-01T00:00:00.000Z",
      processIdentity: TEST_PROCESS_IDENTITY,
    };
    fs.writeFileSync(deadOwnerPath, JSON.stringify({ ...record, ownerArtifact: deadOwnerName }));
    fs.writeFileSync(deadPublishPath, JSON.stringify(record));
    fs.writeFileSync(malformedPublishPath, "{partial");
    fs.writeFileSync(
      foreignOwnerPath,
      JSON.stringify({ ...record, host: "remote-host", ownerArtifact: foreignOwnerName }),
    );
    const leadingMalformedOwners = Array.from({ length: 20 }, (_, index) =>
      path.join(
        federationDir(root),
        `${initial.jobId}.lock.owner.aaa-${String(index).padStart(2, "0")}`,
      ),
    );
    for (const malformedOwner of leadingMalformedOwners) {
      fs.writeFileSync(malformedOwner, "{partial");
    }
    const stale = new Date("2020-01-01T00:00:00.000Z");
    for (const artifact of [
      deadOwnerPath,
      deadPublishPath,
      malformedPublishPath,
      foreignOwnerPath,
      ...leadingMalformedOwners,
    ]) {
      fs.utimesSync(artifact, stale, stale);
    }

    let probeCount = 0;
    let examinedCount = 0;
    for (let pass = 0; pass < 3 && fs.existsSync(deadOwnerPath); pass += 1) {
      const before = probeCount;
      const examinedBefore = examinedCount;
      await updateFederatedJob(
        root,
        initial.jobId,
        (current) => ({ ...current, status: "canceled" }),
        {
          ...TEST_LOCK_OPTIONS,
          processIsAlive: () => {
            probeCount += 1;
            return false;
          },
          onCrashArtifactExaminedForTest: () => {
            examinedCount += 1;
          },
        },
      );
      expect(probeCount - before).toBeLessThanOrEqual(16);
      expect(examinedCount - examinedBefore).toBeLessThanOrEqual(16);
    }
    expect(fs.existsSync(deadOwnerPath)).toBe(false);
    expect(fs.existsSync(deadPublishPath)).toBe(false);
    expect(fs.existsSync(malformedPublishPath)).toBe(true);
    expect(fs.existsSync(foreignOwnerPath)).toBe(true);
  });

  test("publishes reclaim metadata as complete JSON with an atomic no-replace link", async () => {
    const initial = makeJob("fed-store-atomic-reclaim");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, { pid: 54322 });
    let observedAtomicLink = false;

    await updateFederatedJob(
      root,
      initial.jobId,
      (current) => ({ ...current, status: "canceled" }),
      {
        ...TEST_LOCK_OPTIONS,
        processIsAlive: () => false,
        linkPathForTest: async (source, destination) => {
          if (destination === path.join(lockPath, "reclaim.json")) {
            expect(fs.existsSync(destination)).toBe(false);
            expect(JSON.parse(fs.readFileSync(source, "utf-8"))).toMatchObject({
              version: 2,
              kind: "reclaim",
            });
            await fs.promises.link(source, destination);
            expect(JSON.parse(fs.readFileSync(destination, "utf-8"))).toMatchObject({
              version: 2,
              kind: "reclaim",
            });
            observedAtomicLink = true;
            return;
          }
          await fs.promises.link(source, destination);
        },
      },
    );
    expect(observedAtomicLink).toBe(true);
  });

  test.each(["EPERM", "EACCES", "EBUSY"])(
    "retries transient %s while reclaiming an old directory owner",
    async (code) => {
      const initial = makeJob(`fed-store-reclaim-retry-${code.toLowerCase()}`);
      await saveFederatedJob(root, initial);
      const lockPath = jobLockPath(root, initial.jobId);
      writeV2Owner(lockPath, { pid: 54_320 });
      let attempts = 0;

      await expect(
        updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
          ...TEST_LOCK_OPTIONS,
          processIsAlive: () => false,
          renamePathForTest: async (source, destination) => {
            if (source === lockPath && destination.includes(".reclaim-quarantine.")) {
              attempts += 1;
              if (attempts < 3) {
                const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
                error.code = code;
                throw error;
              }
            }
            await fs.promises.rename(source, destination);
          },
        }),
      ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
      expect(attempts).toBe(3);
    },
  );

  test("finishes an interrupted reclaim from its durable request and partial quarantine", async () => {
    const initial = makeJob("fed-store-reclaim-partial-cleanup");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    writeV2Owner(lockPath, { pid: 54323 });
    let quarantinePath: string | undefined;

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        processIsAlive: () => false,
        renamePathForTest: async (source, destination) => {
          await fs.promises.rename(source, destination);
          if (source === lockPath && destination.includes(".reclaim-quarantine.")) {
            quarantinePath = destination;
            fs.writeFileSync(path.join(destination, "unexpected.tmp"), "hold", "utf-8");
          }
        },
      }),
    ).rejects.toThrow("unexpected evidence");
    expect(quarantinePath).toBeDefined();
    for (const entry of fs.readdirSync(quarantinePath!)) {
      fs.unlinkSync(path.join(quarantinePath!, entry));
    }

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => ({ ...current, status: "canceled" }),
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("lets a peer finish a durable reclaim while the original requester remains live", async () => {
    const initial = makeJob("fed-store-live-requester-reclaim");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const staleOwnerPid = 54_324;
    writeV2Owner(lockPath, { pid: staleOwnerPid });
    const requesterIdentity = { bootId: "requester-boot", startedAt: "100" };
    let requestPublished = false;
    let interruptAfterPublication = true;

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        currentProcessIdentityForTest: requesterIdentity,
        processIdentityProbeForTest: (pid) =>
          Promise.resolve(
            pid === staleOwnerPid
              ? { state: "dead" }
              : { state: "alive", identity: requesterIdentity },
          ),
        linkPathForTest: async (source, destination) => {
          await fs.promises.link(source, destination);
          if (destination.includes(".reclaim-request.")) requestPublished = true;
        },
        renamePathForTest: async (source, destination) => {
          if (
            interruptAfterPublication &&
            source === lockPath &&
            destination.includes(".reclaim-quarantine.")
          ) {
            interruptAfterPublication = false;
            const error = new Error("injected post-request interruption") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
          await fs.promises.rename(source, destination);
        },
      }),
    ).rejects.toThrow("injected post-request interruption");
    expect(requestPublished).toBe(true);
    expect(
      fs
        .readdirSync(federationDir(root))
        .some((entry) => entry.startsWith(`${initial.jobId}.lock.reclaim-request.`)),
    ).toBe(true);

    const peerIdentity = { bootId: "peer-boot", startedAt: "200" };
    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        currentProcessIdentityForTest: peerIdentity,
        processIdentityProbeForTest: (pid) =>
          Promise.resolve(
            pid === staleOwnerPid
              ? { state: "dead" }
              : { state: "alive", identity: requesterIdentity },
          ),
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(
      fs
        .readdirSync(federationDir(root))
        .some((entry) => entry.startsWith(`${initial.jobId}.lock.reclaim-request.`)),
    ).toBe(false);
  });

  test.each(["EPERM", "EACCES", "EBUSY"])(
    "retries transient %s while releasing the canonical lock",
    async (code) => {
      const initial = makeJob(`fed-store-release-retry-${code.toLowerCase()}`);
      await saveFederatedJob(root, initial);
      const lockPath = jobLockPath(root, initial.jobId);
      let attempts = 0;

      await expect(
        updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
          ...TEST_LOCK_OPTIONS,
          renamePathForTest: async (source, destination) => {
            if (source === lockPath && destination.includes(LOCK_RELEASE_QUARANTINE_TEST_TAG)) {
              attempts += 1;
              if (attempts < 3) {
                const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
                error.code = code;
                throw error;
              }
            }
            await fs.promises.rename(source, destination);
          },
        }),
      ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
      expect(attempts).toBe(3);
      expect(fs.existsSync(lockPath)).toBe(false);
    },
  );

  test.each(["EPERM", "EACCES", "EBUSY"])(
    "retries transient %s while publishing durable release evidence",
    async (code) => {
      const initial = makeJob(`fed-store-release-publish-${code.toLowerCase()}`);
      await saveFederatedJob(root, initial);
      let attempts = 0;

      await expect(
        updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
          ...TEST_LOCK_OPTIONS,
          linkPathForTest: async (source, destination) => {
            if (destination.includes(`${initial.jobId}.lock.release.`)) {
              attempts += 1;
              if (attempts < 3) {
                const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
                error.code = code;
                throw error;
              }
            }
            await fs.promises.link(source, destination);
          },
        }),
      ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
      expect(attempts).toBe(3);
      expect(fs.existsSync(jobLockPath(root, initial.jobId))).toBe(false);
    },
  );

  test("rejects copied release JSON that is not hard-linked to owner evidence", async () => {
    const initial = makeJob("fed-store-forged-release");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    const first = updateFederatedJobExclusive(
      root,
      initial.jobId,
      async (current) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return current;
      },
      TEST_LOCK_OPTIONS,
    );
    await firstEntered.promise;
    const ownerJson = fs.readFileSync(lockPath, "utf-8");
    const owner = JSON.parse(ownerJson) as { ownerToken: string };
    const forgedReleasePath = `${lockPath}.release.forged-${owner.ownerToken}`;
    fs.writeFileSync(forgedReleasePath, ownerJson, "utf-8");

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          secondEntered = true;
          return { ...current, status: "canceled" };
        },
        { ...TEST_LOCK_OPTIONS, waitTimeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(secondEntered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);

    fs.unlinkSync(forgedReleasePath);
    releaseFirst.resolve();
    await first;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("drains a process-local release after durable publication and fallback both fail", async () => {
    const initial = makeJob("fed-store-release-local-pending");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    let firstCallbackCount = 0;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          firstCallbackCount += 1;
          return { ...current, status: "canceled" };
        },
        {
          ...TEST_LOCK_OPTIONS,
          retryMs: 1,
          renameRetryTimeoutMs: 5,
          linkPathForTest: async (source, destination) => {
            if (destination.includes(`${initial.jobId}.lock.release.`)) {
              const error = new Error(
                "injected persistent marker contention",
              ) as NodeJS.ErrnoException;
              error.code = "EPERM";
              throw error;
            }
            await fs.promises.link(source, destination);
          },
          renamePathForTest: async (source, destination) => {
            if (source === lockPath && destination.includes(".release-quarantine.local-")) {
              const error = new Error(
                "injected persistent fallback contention",
              ) as NodeJS.ErrnoException;
              error.code = "EPERM";
              throw error;
            }
            await fs.promises.rename(source, destination);
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockCompletedActionError);
    expect(firstCallbackCount).toBe(1);
    expect((await loadFederatedJob(root, initial.jobId))?.status).toBe("canceled");
    expect(fs.existsSync(lockPath)).toBe(true);

    let secondCallbackCount = 0;
    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          secondCallbackCount += 1;
          return { ...current, status: "failed" };
        },
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toMatchObject({ changed: true, record: { status: "failed" } });
    expect(secondCallbackCount).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("retires process-local fallback owner artifacts across repeated successful releases", async () => {
    const initial = makeJob("fed-store-local-owner-retirement");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);

    for (let index = 0; index < 24; index += 1) {
      await expect(
        updateFederatedJob(
          root,
          initial.jobId,
          (current) => ({
            ...current,
            updatedAt: `2026-09-10T00:00:${String(index).padStart(2, "0")}.000Z`,
          }),
          {
            ...TEST_LOCK_OPTIONS,
            renameRetryTimeoutMs: 1,
            linkPathForTest: async (source, destination) => {
              if (destination.includes(`${initial.jobId}.lock.release.`)) {
                const error = new Error("force process-local release") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
              }
              await fs.promises.link(source, destination);
            },
          },
        ),
      ).resolves.toMatchObject({ changed: true });
    }

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(federationDir(root))
        .filter((entry) => entry.startsWith(`${initial.jobId}.lock.owner.`)),
    ).toEqual([]);
  });

  test("bounds live-process owner artifacts when fallback retirement is interrupted", async () => {
    const initial = makeJob("fed-store-local-owner-retry");
    await saveFederatedJob(root, initial);
    const jobsDir = federationDir(root);
    const ownerArtifacts = (): string[] =>
      fs.readdirSync(jobsDir).filter((entry) => entry.startsWith(`${initial.jobId}.lock.owner.`));

    for (let index = 0; index < 24; index += 1) {
      let observed: unknown;
      try {
        await withFederatedJobLock(root, initial.jobId, () => Promise.resolve(index), {
          ...TEST_LOCK_OPTIONS,
          renameRetryTimeoutMs: 1,
          linkPathForTest: async (source, destination) => {
            if (destination.includes(`${initial.jobId}.lock.release.`)) {
              const error = new Error("force process-local release") as NodeJS.ErrnoException;
              error.code = "EPERM";
              throw error;
            }
            await fs.promises.link(source, destination);
          },
          unlinkPathForTest: (target) => {
            if (target.includes(".retired.")) {
              const error = new Error("interrupt retired owner cleanup") as NodeJS.ErrnoException;
              error.code = "EPERM";
              return Promise.reject(error);
            }
            return fs.promises.unlink(target);
          },
        });
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
      expect((observed as FederatedJobLockCompletedActionError).result).toBe(index);
      expect(ownerArtifacts()).toHaveLength(1);

      await expect(
        withFederatedJobLock(
          root,
          initial.jobId,
          () => Promise.resolve("drained"),
          TEST_LOCK_OPTIONS,
        ),
      ).resolves.toBe("drained");
      expect(ownerArtifacts()).toEqual([]);
    }
  });

  test("does not report process-local fallback durable before its final directory sync", async () => {
    const initial = makeJob("fed-store-local-release-sync");
    await saveFederatedJob(root, initial);
    const completed = { persisted: true };
    let syncCalls = 0;
    let observed: unknown;

    try {
      await withFederatedJobLock(root, initial.jobId, () => Promise.resolve(completed), {
        ...TEST_LOCK_OPTIONS,
        renameRetryTimeoutMs: 1,
        linkPathForTest: async (source, destination) => {
          if (destination.includes(`${initial.jobId}.lock.release.`)) {
            const error = new Error("force process-local release") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          await fs.promises.link(source, destination);
        },
        syncDirectoryForTest: () => {
          syncCalls += 1;
          if (syncCalls === 2) {
            return Promise.reject(new Error("injected fallback final sync failure"));
          }
          return Promise.resolve();
        },
      });
    } catch (error: unknown) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
    expect((observed as FederatedJobLockCompletedActionError).result).toBe(completed);
    expect(syncCalls).toBe(2);
    setFederatedJobLockOptionsForTests(undefined);
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
    });
    await expect(
      withFederatedJobLock(
        root,
        initial.jobId,
        () => Promise.resolve("recovered"),
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toBe("recovered");
  });

  test("restores a replacement displaced by release after a temporary occupant clears", async () => {
    const initial = makeJob("fed-store-release-displaced");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const displacedToken = "00000000-0000-4000-8000-000000000072";
    const temporaryToken = "00000000-0000-4000-8000-000000000073";
    let injected = false;
    const writeCanonical = (ownerToken: string): void => {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          version: 2,
          ownerToken,
          host: os.hostname(),
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          processIdentity: TEST_PROCESS_IDENTITY,
        }),
        "utf-8",
      );
    };

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        renamePathForTest: async (source, destination) => {
          if (!injected && source === lockPath && destination.includes(".release-quarantine.")) {
            injected = true;
            fs.unlinkSync(lockPath);
            writeCanonical(displacedToken);
            await fs.promises.rename(source, destination);
            writeCanonical(temporaryToken);
            return;
          }
          await fs.promises.rename(source, destination);
        },
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    fs.unlinkSync(lockPath);

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        () => {
          throw new Error("restored live ownership must remain exclusive");
        },
        { ...TEST_LOCK_OPTIONS, waitTimeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
      ownerToken: displacedToken,
    });
    expect(
      fs
        .readdirSync(federationDir(root))
        .filter((entry) => entry.includes(".release.") || entry.includes(".release-quarantine.")),
    ).toEqual([]);
  });

  test("returns a persisted action result while durable release cleanup is retried later", async () => {
    const initial = makeJob("fed-store-release-recovery");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const observedErrors: unknown[] = [];

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        retryMs: 1,
        renameRetryTimeoutMs: 5,
        onReleaseError: (error) => observedErrors.push(error),
        renamePathForTest: async (source, destination) => {
          if (source === lockPath && destination.includes(LOCK_RELEASE_QUARANTINE_TEST_TAG)) {
            const error = new Error(
              "injected persistent release contention",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          await fs.promises.rename(source, destination);
        },
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(observedErrors).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(true);
    const releaseArtifact = fs
      .readdirSync(federationDir(root))
      .find((entry) => entry.startsWith(`${initial.jobId}.lock.release.`));
    expect(releaseArtifact).toBeDefined();
    const releaseRecord = JSON.parse(
      fs.readFileSync(path.join(federationDir(root), releaseArtifact!), "utf-8"),
    ) as unknown;
    expect(releaseRecord).toMatchObject({ version: 2 });
    expect(typeof (releaseRecord as { ownerToken?: unknown }).ownerToken).toBe("string");

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "failed" }), {
        ...TEST_LOCK_OPTIONS,
        processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "failed" } });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("does not let an empty release quarantine block a later owner", async () => {
    const initial = makeJob("fed-store-release-partial-cleanup");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    let cleanedForCrashSimulation = false;

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        onReleaseError: () => {
          const quarantine = fs
            .readdirSync(federationDir(root))
            .find((entry) => entry.includes(".release-quarantine."));
          if (!quarantine) return;
          const quarantinePath = path.join(federationDir(root), quarantine);
          fs.unlinkSync(quarantinePath);
          cleanedForCrashSimulation = true;
        },
        renamePathForTest: async (source, destination) => {
          await fs.promises.rename(source, destination);
          if (source === lockPath && destination.includes(LOCK_RELEASE_QUARANTINE_TEST_TAG)) {
            throw new Error("injected crash after release rename");
          }
        },
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(cleanedForCrashSimulation).toBe(true);

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => ({ ...current, status: "failed" }),
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toMatchObject({ changed: true, record: { status: "failed" } });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("reclaims only a stale, well-formed, same-host, provably dead owner", async () => {
    const initial = makeJob("fed-store-stale");
    await saveFederatedJob(root, initial);
    const lockPath = path.join(federationDir(root), `${initial.jobId}.lock`);
    const staleToken = "00000000-0000-4000-8000-000000000099";
    const staleOwnerPath = path.join(lockPath, `owner-${staleToken}.json`);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      staleOwnerPath,
      JSON.stringify({
        version: 1,
        ownerToken: staleToken,
        host: os.hostname(),
        pid: 999_999,
        acquiredAt: "2020-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(staleOwnerPath, stale, stale);

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        processIsAlive: () => false,
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("removes its exact published lock when opening the heartbeat handle fails", async () => {
    const initial = makeJob("fed-store-open-failure");
    await saveFederatedJob(root, initial);
    const lockPath = path.join(federationDir(root), `${initial.jobId}.lock`);

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        openOwnerHandleForTest: () => Promise.reject(new Error("injected owner open failure")),
      }),
    ).rejects.toThrow("injected owner open failure");
    expect(fs.existsSync(lockPath)).toBe(false);

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => ({ ...current, status: "canceled" }),
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
  });

  test("a delayed predecessor release cannot delete a replacement owner's lock", async () => {
    const initial = makeJob("fed-store-release-fence");
    await saveFederatedJob(root, initial);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    const lockPath = path.join(federationDir(root), `${initial.jobId}.lock`);
    let second: ReturnType<typeof updateFederatedJobExclusive> | undefined;

    const first = updateFederatedJobExclusive(
      root,
      initial.jobId,
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return undefined;
      },
      {
        ...TEST_LOCK_OPTIONS,
        beforeReleaseForTest: async () => {
          const displacedPath = `${lockPath}.displaced`;
          fs.renameSync(lockPath, displacedPath);
          second = updateFederatedJobExclusive(
            root,
            initial.jobId,
            async () => {
              secondEntered.resolve();
              await releaseSecond.promise;
              return undefined;
            },
            TEST_LOCK_OPTIONS,
          );
          await secondEntered.promise;
        },
      },
    );
    await firstEntered.promise;

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ changed: false });
    const replacementOwnerPath = ownerPath(root, initial.jobId);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(replacementOwnerPath)).toBe(true);

    releaseSecond.resolve();
    await expect(second).resolves.toMatchObject({ changed: false });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("recovers a dead process-local release quarantine after restart", async () => {
    const initial = makeJob("fed-store-orphan-local-release");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const ownerToken = "00000000-0000-4000-8000-000000000093";
    const ownerArtifact = `${path.basename(lockPath)}.owner.dead-${ownerToken}`;
    const ownerFile = path.join(federationDir(root), ownerArtifact);
    const quarantinePath = `${lockPath}.release-quarantine.local-dead-${ownerToken}`;
    fs.writeFileSync(
      ownerFile,
      JSON.stringify({
        version: 2,
        ownerToken,
        host: os.hostname(),
        pid: 93_993,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        processIdentity: TEST_PROCESS_IDENTITY,
        ownerArtifact,
      }),
      "utf-8",
    );
    fs.linkSync(ownerFile, quarantinePath);
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(ownerFile, stale, stale);

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        processIsAlive: () => false,
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(fs.existsSync(quarantinePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("preserves a frozen action error when advisory release annotation fails", async () => {
    const initial = makeJob("fed-store-frozen-error");
    await saveFederatedJob(root, initial);
    const original = Object.freeze(new Error("original action failure"));
    let observed: unknown;

    try {
      await updateFederatedJobExclusive(root, initial.jobId, () => Promise.reject(original), {
        ...TEST_LOCK_OPTIONS,
        beforeReleaseForTest: () => {
          throw new Error("advisory cleanup failure");
        },
      });
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBe(original);
    expect(fs.existsSync(jobLockPath(root, initial.jobId))).toBe(false);
  });

  test("preserves the exact completed result when the post-action owner fence fails", async () => {
    const jobId = "fed-store-post-action-fence";
    const lockPath = jobLockPath(root, jobId);
    const completed = { persisted: true, jobId };
    let observed: unknown;

    try {
      await withFederatedJobLock(
        root,
        jobId,
        async () => {
          await fs.promises.unlink(lockPath);
          return completed;
        },
        TEST_LOCK_OPTIONS,
      );
    } catch (error: unknown) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
    expect((observed as FederatedJobLockCompletedActionError).result).toBe(completed);
  });

  test("recovers after directory sync fails immediately after canonical publication", async () => {
    const initial = makeJob("fed-store-post-link-sync");
    await saveFederatedJob(root, initial);
    let callbackCount = 0;
    const syncFailure = new Error("injected post-link directory sync failure");

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          callbackCount += 1;
          return { ...current, status: "canceled" };
        },
        {
          ...TEST_LOCK_OPTIONS,
          syncDirectoryForTest: () => Promise.reject(syncFailure),
        },
      ),
    ).rejects.toThrow("injected post-link directory sync failure");
    expect(callbackCount).toBe(0);

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          callbackCount += 1;
          return { ...current, status: "canceled" };
        },
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(callbackCount).toBe(1);
    expect(fs.existsSync(jobLockPath(root, initial.jobId))).toBe(false);
  });

  test("surfaces a completed result when the published release file cannot be flushed", async () => {
    const initial = makeJob("fed-store-release-sync");
    await saveFederatedJob(root, initial);
    const completed = { persisted: true };
    let observed: unknown;

    try {
      await withFederatedJobLock(root, initial.jobId, () => Promise.resolve(completed), {
        ...TEST_LOCK_OPTIONS,
        syncPublishedReleaseFileForTest: () =>
          Promise.reject(new Error("injected release file flush failure")),
      });
    } catch (error: unknown) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(FederatedJobLockCompletedActionError);
    expect((observed as FederatedJobLockCompletedActionError).result).toBe(completed);
    expect(
      fs
        .readdirSync(federationDir(root))
        .some((entry) => entry.includes(`${initial.jobId}.lock.release.`)),
    ).toBe(true);

    // Simulate restart: process-local fallback state disappears, while the
    // visible-but-previously-unsynced marker is reconciled if it survived.
    setFederatedJobLockOptionsForTests(undefined);
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
    });
    await expect(
      withFederatedJobLock(
        root,
        initial.jobId,
        () => Promise.resolve("recovered"),
        TEST_LOCK_OPTIONS,
      ),
    ).resolves.toBe("recovered");
    expect(fs.existsSync(jobLockPath(root, initial.jobId))).toBe(false);
  });

  test("retries transient Windows link and quarantine-unlink contention", async () => {
    const initial = makeJob("fed-store-link-unlink-retry");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    let linkFailures = 2;
    let unlinkFailures = 2;

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        renameRetryTimeoutMs: 50,
        linkPathForTest: async (source, destination) => {
          if (destination === lockPath && linkFailures > 0) {
            linkFailures -= 1;
            const error = new Error("injected link contention") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          await fs.promises.link(source, destination);
        },
        unlinkPathForTest: async (target) => {
          if (target.includes(LOCK_RELEASE_QUARANTINE_TEST_TAG) && unlinkFailures > 0) {
            unlinkFailures -= 1;
            const error = new Error("injected unlink contention") as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }
          await fs.promises.unlink(target);
        },
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });
    expect(linkFailures).toBe(0);
    expect(unlinkFailures).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("does not let an authentic release intent delete a byte-identical replacement inode", async () => {
    const initial = makeJob("fed-store-release-replacement-inode");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    let replacementCreated = false;
    let observedReplacementIdentity: { dev: number; ino: number } | undefined;
    let observedOwnerIdentity: { dev: number; ino: number } | undefined;

    await expect(
      updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
        ...TEST_LOCK_OPTIONS,
        linkPathForTest: async (source, destination) => {
          await fs.promises.link(source, destination);
          if (!replacementCreated && destination.includes(`${initial.jobId}.lock.release.`)) {
            const original = fs.readFileSync(lockPath);
            const record = JSON.parse(original.toString("utf-8")) as { ownerArtifact: string };
            const ownerStat = fs.lstatSync(path.join(federationDir(root), record.ownerArtifact));
            fs.unlinkSync(lockPath);
            fs.writeFileSync(lockPath, original);
            const replacementStat = fs.lstatSync(lockPath);
            observedOwnerIdentity = { dev: ownerStat.dev, ino: ownerStat.ino };
            observedReplacementIdentity = {
              dev: replacementStat.dev,
              ino: replacementStat.ino,
            };
            replacementCreated = true;
          }
        },
      }),
    ).resolves.toMatchObject({ changed: true, record: { status: "canceled" } });

    expect(replacementCreated).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(observedReplacementIdentity).toBeDefined();
    expect(observedReplacementIdentity).not.toEqual(observedOwnerIdentity);
  });

  test("does not let a reclaim request delete a byte-identical replacement inode", async () => {
    const initial = makeJob("fed-store-reclaim-replacement-inode");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const ownerToken = "00000000-0000-4000-8000-000000000091";
    const ownerArtifact = `${path.basename(lockPath)}.owner.dead-${ownerToken}`;
    const ownerFile = path.join(federationDir(root), ownerArtifact);
    const staleRecord = {
      version: 2,
      ownerToken,
      host: os.hostname(),
      pid: 91_991,
      acquiredAt: "2020-01-01T00:00:00.000Z",
      processIdentity: TEST_PROCESS_IDENTITY,
      ownerArtifact,
    };
    fs.writeFileSync(ownerFile, JSON.stringify(staleRecord), "utf-8");
    fs.linkSync(ownerFile, lockPath);
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(ownerFile, stale, stale);
    let replacementCreated = false;
    let callbackEntered = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          callbackEntered = true;
          return { ...current, status: "canceled" };
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: () => false,
          linkPathForTest: async (source, destination) => {
            await fs.promises.link(source, destination);
            if (!replacementCreated && destination.includes(".reclaim-request.")) {
              const original = fs.readFileSync(lockPath);
              fs.unlinkSync(lockPath);
              fs.writeFileSync(lockPath, original);
              replacementCreated = true;
            }
          },
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);

    expect(replacementCreated).toBe(true);
    expect(callbackEntered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    const replacementStat = fs.lstatSync(lockPath);
    const ownerStat = fs.lstatSync(ownerFile);
    expect({ dev: replacementStat.dev, ino: replacementStat.ino }).not.toEqual({
      dev: ownerStat.dev,
      ino: ownerStat.ino,
    });
  });

  test.each(["file", "directory"] as const)(
    "binds %s lock bytes and inode through one snapshot handle",
    async (layout) => {
      const initial = makeJob(`fed-store-snapshot-${layout}`);
      await saveFederatedJob(root, initial);
      const lockPath = jobLockPath(root, initial.jobId);
      const ownerToken =
        layout === "file"
          ? "00000000-0000-4000-8000-000000000093"
          : "00000000-0000-4000-8000-000000000094";
      let ownerPath: string;
      if (layout === "file") {
        const ownerArtifact = `${path.basename(lockPath)}.owner.dead-${ownerToken}`;
        ownerPath = path.join(federationDir(root), ownerArtifact);
        fs.writeFileSync(
          ownerPath,
          JSON.stringify({
            version: 2,
            ownerToken,
            host: os.hostname(),
            pid: 993_000,
            acquiredAt: "2020-01-01T00:00:00.000Z",
            processIdentity: TEST_PROCESS_IDENTITY,
            ownerArtifact,
          }),
          "utf-8",
        );
        fs.linkSync(ownerPath, lockPath);
      } else {
        ownerPath = writeV2Owner(lockPath, { ownerToken, pid: 994_000 }).ownerPath;
      }
      const stale = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(ownerPath, stale, stale);
      let replacementIdentity: { dev: number; ino: number } | undefined;
      let swapped = false;
      setFederatedJobLockOptionsForTests({
        ...TEST_LOCK_OPTIONS,
        processIsAlive: (pid) => pid === process.pid,
        currentProcessIdentityForTest: TEST_PROCESS_IDENTITY,
        processIdentityProbeForTest: (pid) =>
          Promise.resolve(
            pid === process.pid
              ? { state: "alive", identity: TEST_PROCESS_IDENTITY }
              : { state: "dead" },
          ),
        afterSnapshotReadForTest: (target, observedLayout) => {
          if (swapped || observedLayout !== layout) return;
          if (layout === "file" && target !== lockPath) return;
          if (layout === "directory" && target !== ownerPath) return;
          swapped = true;
          const replacement = {
            ...(JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>),
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            processIdentity: TEST_PROCESS_IDENTITY,
          };
          fs.unlinkSync(target);
          fs.writeFileSync(target, JSON.stringify(replacement), "utf-8");
          const stat = fs.lstatSync(target);
          replacementIdentity = { dev: stat.dev, ino: stat.ino };
        },
      });

      await expect(
        updateFederatedJob(root, initial.jobId, (current) => ({ ...current, status: "canceled" }), {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: (pid) => pid === process.pid,
        }),
      ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
      expect(swapped).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
      const surviving = fs.lstatSync(layout === "file" ? lockPath : ownerPath);
      expect({ dev: surviving.dev, ino: surviving.ino }).toEqual(replacementIdentity);
    },
  );

  test("refuses a v2 owner artifact that is not scoped to the exact lock", async () => {
    const initial = makeJob("fed-store-owner-path-scope");
    await saveFederatedJob(root, initial);
    const lockPath = jobLockPath(root, initial.jobId);
    const ownerToken = "00000000-0000-4000-8000-000000000092";
    const ownerArtifact = `different.lock.owner.dead-${ownerToken}`;
    const ownerFile = path.join(federationDir(root), ownerArtifact);
    fs.writeFileSync(
      ownerFile,
      JSON.stringify({
        version: 2,
        ownerToken,
        host: os.hostname(),
        pid: 92_992,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        processIdentity: TEST_PROCESS_IDENTITY,
        ownerArtifact,
      }),
      "utf-8",
    );
    fs.linkSync(ownerFile, lockPath);
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(ownerFile, stale, stale);
    let callbackEntered = false;

    await expect(
      updateFederatedJob(
        root,
        initial.jobId,
        (current) => {
          callbackEntered = true;
          return { ...current, status: "canceled" };
        },
        {
          ...TEST_LOCK_OPTIONS,
          waitTimeoutMs: 30,
          processIsAlive: () => false,
        },
      ),
    ).rejects.toBeInstanceOf(FederatedJobLockBusyError);
    expect(callbackEntered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
