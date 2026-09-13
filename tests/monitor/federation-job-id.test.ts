import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSafeFederatedJobId, InvalidFederatedJobIdError, FederatedJobIdentityMismatchError } from "../../src/monitor/federation/job-id";
import { federationDir, loadFederatedJob, listFederatedJobs, saveFederatedJob,
  updateFederatedJob, updateFederatedJobExclusive, updateFederatedJobWithPostPersistEffect,
  withFederatedJobLock, withOwnerFencedFileLock } from "../../src/monitor/federation/store";
import { mintFederatedJobRecord, federatedJobId } from "../../src/monitor/federation/jobs";

const unsafe = ["", ".", "..", "../peer", "..\\peer", "/tmp/peer", "C:\\peer", "\\\\host\\share",
  "fed:stream", "bad\0id", "bad\nid", "bad\n", "bad\r", "bad\u2028", "has space", "é", "CON", "con.txt", "NUL", "NUL.json", "PRN",
  "AUX", "COM1", "com9.txt", "LPT1", "LPT9.json", "x".repeat(97)];

function job(jobId: string) {
  return mintFederatedJobRecord({ jobId, taskId: "TASK-1366", jobType: "dispatch",
    requiredCapabilities: ["dispatch"], status: "queued", provenance: { channel: "federation-queue" } });
}

describe("portable federation job identity", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-job-id-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it.each(unsafe)("refuses unsafe ID %j before directories, callbacks or writes", async (id) => {
    expect(isSafeFederatedJobId(id)).toBe(false);
    expect(await loadFederatedJob(root, id)).toBeUndefined();
    const action = jest.fn();
    await expect(saveFederatedJob(root, job(id))).rejects.toBeInstanceOf(InvalidFederatedJobIdError);
    await expect(withFederatedJobLock(root, id, action)).rejects.toBeInstanceOf(InvalidFederatedJobIdError);
    await expect(updateFederatedJob(root, id, action)).rejects.toBeInstanceOf(InvalidFederatedJobIdError);
    await expect(updateFederatedJobExclusive(root, id, action)).rejects.toBeInstanceOf(InvalidFederatedJobIdError);
    await expect(updateFederatedJobWithPostPersistEffect(root, id, action)).rejects.toBeInstanceOf(InvalidFederatedJobIdError);
    expect(action).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["fed-TASK-001", "legacy_job.1", "__federated-merge-admission__", "__federated-verification-projection__", federatedJobId("TASK-1366"), "x".repeat(96)])(
    "round trips portable current and legacy ID %s", async (id) => {
      expect(isSafeFederatedJobId(id)).toBe(true);
      const record = job(id);
      await saveFederatedJob(root, record);
      expect(await loadFederatedJob(root, id)).toEqual(record);
      expect(await listFederatedJobs(root)).toEqual([record]);
    });

  it.each(["sync", "exclusive", "post-persist"])("refuses %s callback redirection under the wrong lock", async (mode) => {
    const original = job("fed-original");
    const neighbor = job("fed-neighbor");
    await saveFederatedJob(root, original);
    await saveFederatedJob(root, neighbor);
    const dir = federationDir(root);
    const before = await Promise.all(["fed-original.json", "fed-neighbor.json", "records.jsonl"].map(name => fs.readFile(path.join(dir, name), "utf8")));
    const effect = jest.fn(() => Promise.resolve(undefined));
    const operation = mode === "sync"
      ? updateFederatedJob(root, original.jobId, () => neighbor)
      : mode === "exclusive"
        ? updateFederatedJobExclusive(root, original.jobId, () => Promise.resolve(neighbor))
        : updateFederatedJobWithPostPersistEffect(root, original.jobId, () => ({ record: neighbor, effect }));
    await expect(operation).rejects.toBeInstanceOf(FederatedJobIdentityMismatchError);
    expect(effect).not.toHaveBeenCalled();
    expect(await Promise.all(["fed-original.json", "fed-neighbor.json", "records.jsonl"].map(name => fs.readFile(path.join(dir, name), "utf8")))).toEqual(before);
  });

  it("loads minimal legacy records but omits malformed or mismatched objects from reads and listing", async () => {
    const dir = federationDir(root);
    await fs.mkdir(dir, { recursive: true });
    const legacy = { jobId: "fed-legacy", taskId: "TASK-1", status: "queued" };
    for (const [id, value] of Object.entries({ "fed-legacy": legacy, "fed-wrong": job("fed-other"), "fed-array": [], "fed-null": null, "fed-missing": {} })) {
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(value));
    }
    expect(await loadFederatedJob(root, "fed-wrong")).toBeUndefined();
    expect(await listFederatedJobs(root)).toEqual([legacy]);
  });

  it("keeps the generic path-addressed lock usable by non-job consumers", async () => {
    const action = jest.fn(() => Promise.resolve("completed"));
    const result = await withOwnerFencedFileLock(path.join(root, "nested", "non-job.lock"), root, action);
    expect(result).toBe("completed");
    expect(action).toHaveBeenCalledTimes(1);
  });
});
