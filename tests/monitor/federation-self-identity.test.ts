import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  currentFederatedLockProcessIdentity, probeFederatedLockProcessIdentity,
  setFederatedJobLockOptionsForTests, type FederatedJobProcessProbe,
} from "../../src/monitor/federation/store";
import { acquireFederatedMergeLock } from "../../src/monitor/federation/orchestration";

describe("opt-in verified self process identity", () => {
  let root: string;
  const identity = { bootId: "native-boot", startedAt: "native-start" };
  const reuse = { reuseVerifiedSelfIdentity: true };
  beforeEach(() => {
    setFederatedJobLockOptionsForTests(undefined);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-self-identity-"));
  });
  afterEach(() => {
    setFederatedJobLockOptionsForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const warm = async () => {
    const probe = jest.fn<Promise<FederatedJobProcessProbe>, [number]>()
      .mockResolvedValueOnce({ state: "alive", identity }).mockResolvedValue({ state: "unknown" });
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe });
    await currentFederatedLockProcessIdentity(root);
    return probe;
  };

  it("reuses established native proof only for an opted-in self probe", async () => {
    const probe = await warm();
    const result = await probeFederatedLockProcessIdentity(root, process.pid, reuse);
    expect(result).toEqual({ state: "alive", identity });
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(probeFederatedLockProcessIdentity(root, process.pid)).resolves.toEqual({ state: "unknown" });
    expect(probe).toHaveBeenCalledTimes(2);
    if (result.state === "alive") result.identity.bootId = "caller-mutated-copy";
    await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse))
      .resolves.toEqual({ state: "alive", identity });
  });

  it.each(["unknown", "dead"] as const)("never uses self proof for another PID whose probe is %s", async (state) => {
    await warm();
    const probe = jest.fn(() => Promise.resolve({ state }));
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      currentProcessIdentityForTest: identity, processIdentityProbeForTest: probe });
    for (let i = 0; i < 2; i++) {
      await expect(probeFederatedLockProcessIdentity(root, process.pid + 1, reuse)).resolves.toEqual({ state });
    }
    expect(probe.mock.calls).toEqual([[process.pid + 1], [process.pid + 1]]);
  });

  it("respects explicit cache disabling after a successful native proof", async () => {
    await warm();
    const probe = jest.fn(() => Promise.resolve({ state: "unknown" as const }));
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: false,
      processIdentityProbeForTest: probe });
    await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse)).resolves.toEqual({ state: "unknown" });
    expect(probe).toHaveBeenCalledWith(process.pid);
  });

  it("does not treat the test-only identity override as native evidence", async () => {
    const probe = jest.fn(() => Promise.resolve({ state: "unknown" as const }));
    setFederatedJobLockOptionsForTests({ currentProcessIdentityForTest: identity,
      cacheCurrentProcessIdentityForTest: true, processIdentityProbeForTest: probe });
    await expect(currentFederatedLockProcessIdentity(root)).resolves.toEqual(identity);
    await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse)).resolves.toEqual({ state: "unknown" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "dead", "error"] as const)("cold %s proof cannot admit and a later successful proof can retry", async (state) => {
    const probe = jest.fn<Promise<FederatedJobProcessProbe>, [number]>();
    if (state === "error") probe.mockRejectedValue(new Error("OS unavailable"));
    else probe.mockResolvedValue({ state });
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe });
    if (state === "error") {
      await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse)).rejects.toThrow("OS unavailable");
    } else {
      await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse)).resolves.toEqual({ state });
    }
    await expect(currentFederatedLockProcessIdentity(root)).rejects.toThrow();
    probe.mockResolvedValue({ state: "alive", identity });
    await expect(currentFederatedLockProcessIdentity(root)).resolves.toEqual(identity);
    probe.mockResolvedValue({ state: "unknown" });
    await expect(probeFederatedLockProcessIdentity(root, process.pid, reuse)).resolves.toEqual({ state: "alive", identity });
  });

  it.each(["success", "error"] as const)("awaits in-flight native proof with %s and never invents identity", async (outcome) => {
    let complete!: (value: FederatedJobProcessProbe) => void;
    let fail!: (reason: Error) => void;
    const pending = new Promise<FederatedJobProcessProbe>((resolve, reject) => { complete = resolve; fail = reject; });
    const probe = jest.fn(() => pending);
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe });
    const initialization = currentFederatedLockProcessIdentity(root);
    const caught = initialization.catch(() => undefined);
    let settled = false;
    const recovery = probeFederatedLockProcessIdentity(root, process.pid, reuse).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (outcome === "success") complete({ state: "alive", identity });
    else fail(new Error("OS unavailable"));
    await expect(recovery).resolves.toEqual(outcome === "success" ? { state: "alive", identity } : { state: "unknown" });
    await caught;
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retains mismatched self-PID merge lock and orphan artifact on unknown despite warm native proof", async () => {
    const native = await currentFederatedLockProcessIdentity(root);
    const directory = path.join(root, ".quack", "federation");
    const lockPath = path.join(directory, "merge.lock");
    fs.mkdirSync(directory, { recursive: true });
    const record = (token: string) => ({ version: 2, jobId: "fed-old-self", taskId: "TASK-1362",
      ownerToken: token, host: os.hostname(), processId: process.pid,
      processIdentity: { ...native, startedAt: `${native.startedAt}-old` },
      ownerArtifact: `merge.lock.owner.${token}`, acquiredAt: "2020-01-01T00:00:00.000Z" });
    const canonical = record(randomUUID());
    const orphan = record(randomUUID());
    const ownerPath = path.join(directory, canonical.ownerArtifact);
    const orphanPath = path.join(directory, orphan.ownerArtifact);
    fs.writeFileSync(ownerPath, JSON.stringify(canonical));
    fs.linkSync(ownerPath, lockPath);
    fs.writeFileSync(orphanPath, JSON.stringify(orphan));
    const probe = jest.fn(() => Promise.resolve({ state: "unknown" as const }));
    setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe });
    await expect(acquireFederatedMergeLock(root, "fed-new-self", "TASK-NEW")).resolves.toBeUndefined();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(JSON.stringify(canonical));
    expect(fs.readFileSync(orphanPath, "utf8")).toBe(JSON.stringify(orphan));
    expect(probe.mock.calls).toEqual([[process.pid], [process.pid]]);
  });
});
