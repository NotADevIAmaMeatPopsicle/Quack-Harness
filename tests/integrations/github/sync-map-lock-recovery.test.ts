import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  GitHubSyncMap,
  LegacyGitHubLockError,
  withGitHubPublicationLock,
} from "../../../src/integrations/github/sync-map";
import {
  setFederatedJobLockOptionsForTests,
  type FederatedJobLockOptions,
} from "../../../src/monitor/federation/store";

const PROCESS_IDENTITY = { bootId: "github-lock-test-boot", startedAt: "100" };
const LOCK_OPTIONS = { lockRetryMs: 2, lockTimeoutMs: 2_000, staleLockMs: 30 };
const OLD_TIME = new Date("2000-01-01T00:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Lock test did not reach its barrier")), 4_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function configureLock(options: FederatedJobLockOptions = {}): void {
  setFederatedJobLockOptionsForTests({
    currentProcessIdentityForTest: PROCESS_IDENTITY,
    processIdentityProbeForTest: () =>
      Promise.resolve({ state: "alive", identity: PROCESS_IDENTITY }),
    heartbeatMs: 5,
    ...options,
  });
}

describe.each(["sync map", "publication"] as const)("%s owner-fenced lock", (kind) => {
  let root: string;
  let syncPath: string;
  let lockPath: string;

  function runLocked(operation: () => Promise<void>): Promise<void> {
    return kind === "publication"
      ? withGitHubPublicationLock(root, operation, LOCK_OPTIONS)
      : new GitHubSyncMap(syncPath, LOCK_OPTIONS, root).withTransaction(operation);
  }

  async function seedDeadOwner(): Promise<void> {
    const ownerArtifact = `${path.basename(lockPath)}.owner.dead-00000000-0000-4000-8000-000000000901`;
    const ownerPath = path.join(path.dirname(lockPath), ownerArtifact);
    await fs.writeFile(
      ownerPath,
      JSON.stringify({
        version: 2,
        ownerToken: "00000000-0000-4000-8000-000000000901",
        host: os.hostname(),
        pid: 999_999_999,
        acquiredAt: OLD_TIME.toISOString(),
        processIdentity: { bootId: "dead-boot", startedAt: "1" },
        ownerArtifact,
      }),
    );
    await fs.link(ownerPath, lockPath);
    await fs.utimes(lockPath, OLD_TIME, OLD_TIME);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-github-lock-recovery-"));
    syncPath = path.join(root, ".quack", "sync", "github-sync.json");
    lockPath =
      kind === "publication"
        ? path.join(root, ".quack", "sync", "github-publication.lock")
        : `${syncPath}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    configureLock();
  });

  afterEach(async () => {
    setFederatedJobLockOptionsForTests(undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  test.each(["live", "dead", "malformed"] as const)(
    "preserves a %s legacy lock and gives an offline recovery refusal",
    async (state) => {
      const original =
        state === "malformed"
          ? "{incomplete legacy lock"
          : JSON.stringify({
              token: "legacy-owner",
              pid: state === "live" ? process.pid : 999_999_999,
              hostname: os.hostname(),
              createdAt: OLD_TIME.toISOString(),
            });
      await fs.writeFile(lockPath, original);
      await fs.utimes(lockPath, OLD_TIME, OLD_TIME);
      const operation = jest.fn(() => Promise.resolve());

      await expect(runLocked(operation)).rejects.toMatchObject({
        name: LegacyGitHubLockError.name,
        code: "github_legacy_lock_requires_offline_recovery",
        message: expect.stringContaining("archive this lock offline") as unknown as string,
      });

      expect(operation).not.toHaveBeenCalled();
      expect(await fs.readFile(lockPath, "utf-8")).toBe(original);
      expect(await fs.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
    },
  );

  test("recovers a dead current-format owner without a Git repository and releases after failure", async () => {
    await seedDeadOwner();
    await expect(fs.access(path.join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      runLocked(() => Promise.reject(new Error("injected operation failure"))),
    ).rejects.toThrow("injected operation failure");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const operation = jest.fn(() => Promise.resolve());
    await runLocked(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["before release publication", "after release publication"] as const)(
    "retains release proof when displaced %s and recovers after restart",
    async (stage) => {
      const quarantinePath = `${lockPath}.reclaim-quarantine.interrupted-00000000-0000-4000-8000-000000000902`;
      let ownerArtifact: string | undefined;
      let displaced = false;
      configureLock({
        linkPathForTest: async (source, destination) => {
          await fs.link(source, destination);
          if (
            stage === "after release publication" &&
            !displaced &&
            destination.includes(".release.")
          ) {
            displaced = true;
            await fs.rename(lockPath, quarantinePath);
          }
        },
      });

      const first = runLocked(async () => {
        const record = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
          ownerArtifact: string;
        };
        ownerArtifact = record.ownerArtifact;
        if (stage === "before release publication") {
          displaced = true;
          await fs.rename(lockPath, quarantinePath);
        }
      });
      if (stage === "before release publication") {
        await expect(first).rejects.toMatchObject({ actionCompleted: true });
      } else {
        await expect(first).resolves.toBeUndefined();
      }

      expect(displaced).toBe(true);
      await expect(fs.access(quarantinePath)).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(path.dirname(lockPath), ownerArtifact!)),
      ).resolves.toBeUndefined();
      expect(
        (await fs.readdir(path.dirname(lockPath))).filter((entry) =>
          entry.startsWith(`${path.basename(lockPath)}.release.`),
        ),
      ).toHaveLength(1);

      // A fresh process has only the durable files, not process-local fallback
      // maps. The exact release must finish even though the old PID remains live.
      setFederatedJobLockOptionsForTests(undefined);
      configureLock();
      const retried = jest.fn(() => Promise.resolve());
      await runLocked(retried);
      expect(retried).toHaveBeenCalledTimes(1);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(path.dirname(lockPath), ownerArtifact!)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test("keeps release evidence when a helper restores canonical during retirement", async () => {
    const quarantinePath = `${lockPath}.reclaim-quarantine.restoring-00000000-0000-4000-8000-000000000903`;
    const fsModule = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalLstat = fsModule.lstat;
    let ownerPath: string | undefined;
    let releasePublished = false;
    let retirementStarted = false;
    let restored = false;
    configureLock({
      linkPathForTest: async (source, destination) => {
        await fs.link(source, destination);
        if (destination.includes(".release.")) {
          releasePublished = true;
          await fs.rename(lockPath, quarantinePath);
        }
      },
      afterSnapshotReadForTest: (target) => {
        if (releasePublished && target === ownerPath) retirementStarted = true;
      },
    });
    const statSpy = jest.spyOn(fsModule, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.lstat>
    ) => {
      try {
        return await originalLstat(...args);
      } catch (error: unknown) {
        if (
          !restored &&
          retirementStarted &&
          args[0] === lockPath &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          restored = true;
          await fs.link(quarantinePath, lockPath);
          await fs.unlink(quarantinePath);
        }
        throw error;
      }
    }) as typeof fs.lstat);
    try {
      await runLocked(async () => {
        const record = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
          ownerArtifact: string;
        };
        ownerPath = path.join(path.dirname(lockPath), record.ownerArtifact);
      });
      expect(restored).toBe(true);
      await expect(fs.access(ownerPath!)).resolves.toBeUndefined();
      expect(
        (await fs.readdir(path.dirname(lockPath))).filter((entry) =>
          entry.startsWith(`${path.basename(lockPath)}.release.`),
        ),
      ).toHaveLength(1);
    } finally {
      statSpy.mockRestore();
    }
    setFederatedJobLockOptionsForTests(undefined);
    configureLock();
    const retried = jest.fn(() => Promise.resolve());
    await runLocked(retried);
    expect(retried).toHaveBeenCalledTimes(1);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a delayed stale reclaimer restores the replacement owner and cannot overlap it", async () => {
    await seedDeadOwner();
    const reclaimerPaused = deferred();
    const resumeReclaimer = deferred();
    const replacementEntered = deferred();
    const releaseReplacement = deferred();
    const replacementRestored = deferred();
    const replacementMoved = deferred();
    const allowReplacementRestore = deferred();
    const operations: Promise<void>[] = [];
    const track = (operation: Promise<void>): void => {
      void operation.catch(() => undefined);
      operations.push(operation);
    };
    let delayed = false;
    let firstEntered = false;
    let active = 0;
    let maxActive = 0;
    let replacementOwner: string | undefined;
    configureLock({
      renamePathForTest: async (source, destination) => {
        let delayedMove = false;
        if (!delayed && source === lockPath && destination.includes(".reclaim-quarantine.")) {
          delayed = true;
          delayedMove = true;
          reclaimerPaused.resolve();
          await resumeReclaimer.promise;
        }
        await fs.rename(source, destination);
        if (delayedMove) {
          replacementMoved.resolve();
          await allowReplacementRestore.promise;
        }
      },
      linkPathForTest: async (source, destination) => {
        await fs.link(source, destination);
        if (destination === lockPath && source.includes(".reclaim-quarantine.")) {
          replacementRestored.resolve();
        }
      },
    });

    try {
      track(
        runLocked(() => {
          firstEntered = true;
          active += 1;
          maxActive = Math.max(maxActive, active);
          active -= 1;
          return Promise.resolve();
        }),
      );
      await bounded(reclaimerPaused.promise);
      track(
        runLocked(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          replacementOwner = await fs.readFile(lockPath, "utf-8");
          replacementEntered.resolve();
          await releaseReplacement.promise;
          active -= 1;
        }),
      );
      await bounded(replacementEntered.promise);
      resumeReclaimer.resolve();
      await bounded(replacementMoved.promise);
      track(
        runLocked(() => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          active -= 1;
          return Promise.resolve();
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      allowReplacementRestore.resolve();
      await bounded(replacementRestored.promise);

      expect(firstEntered).toBe(false);
      expect(active).toBe(1);
      expect(await fs.readFile(lockPath, "utf-8")).toBe(replacementOwner);
      releaseReplacement.resolve();
      await bounded(Promise.all(operations));
      expect(firstEntered).toBe(true);
      expect(maxActive).toBe(1);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resumeReclaimer.resolve();
      allowReplacementRestore.resolve();
      releaseReplacement.resolve();
      await Promise.allSettled(operations);
    }
  });
});
