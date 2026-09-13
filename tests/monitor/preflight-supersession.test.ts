import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { assertNoPreflightSupersession, consumesReplacement, replacementForRejection } from "../../src/monitor/preflight-supersession";
import { PreflightJobStore, createPreflightOwner } from "../../src/monitor/preflight-job-store";
import { computeContentHash } from "../../src/monitor/prep-cache";
import type { BlueprintApproval } from "../../src/dispatcher/blueprint-approval";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";
import { writeAdapter } from "../helpers/duplicate-claimants-fixture";

const taskId = "TASK-1355";
describe("replan supersession at dispatch authority reads", () => {
  let root: string;
  let adapter: ProjectAdapter;
  let store: PreflightJobStore;
  let logDir: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-replan-authority-"));
    writeAdapter(root);
    adapter = await loadAdapter(root);
    store = new PreflightJobStore(root, "duplicate-claimants-fixture");
    logDir = path.join(root, ".quack/logs");
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  it("a managed worktree's local DB cannot hide the owning project's active barrier", async () => {
    await store.reserve(taskId, preflightInput, { owner: await createPreflightOwner(root), force: true,
      replan: { approvalDigest: "b".repeat(64), approvalLogDir: logDir } });
    const worktree = path.join(root, ".quack/worktrees/fixture");
    fs.mkdirSync(path.join(worktree, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(worktree, ".quack/quack.db"), "");
    await expect(assertNoPreflightSupersession({ ...adapter, projectRoot: worktree }, taskId))
      .rejects.toThrow("PREFLIGHT_REPLAN_PENDING");
  });

  it("retires only the exact rejected bytes and only when consuming the replacement report", async () => {
    const filename = path.join(logDir, "approvals", `${taskId}.json`);
    const approval = { taskId, state: "rejected", createdAt: new Date().toISOString(), blueprint: {} } as BlueprintApproval;
    const bytes = JSON.stringify(approval, null, 2);
    fs.writeFileSync(filename, bytes);
    const owner = await createPreflightOwner(root);
    const accepted = await store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { approvalDigest: computeContentHash(bytes), approvalLogDir: logDir } });
    const report = fullPreflightReport();
    await store.update(taskId, accepted.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: report }));
    const replacement = replacementForRejection(adapter, taskId, logDir, approval, preflightInput.contentHash);
    expect(replacement?.jobId).toBe(accepted.job.jobId);
    expect(consumesReplacement(report, replacement)).toBe(true);
    expect(consumesReplacement({ ...report, blueprint: { ...report.blueprint, formattedMarkdown: "Old cached blueprint" } }, replacement)).toBe(false);
    for (const state of ["pending", "approved"] as const) {
      const newer = { ...approval, state, createdAt: new Date().toISOString() };
      const newerBytes = JSON.stringify(newer); fs.writeFileSync(filename, newerBytes);
      expect(replacementForRejection(adapter, taskId, logDir, newer, preflightInput.contentHash)).toBeUndefined();
      expect(fs.readFileSync(filename, "utf8")).toBe(newerBytes);
    }
    fs.writeFileSync(filename, bytes + "\n");
    expect(replacementForRejection(adapter, taskId, logDir, approval, preflightInput.contentHash)).toBeUndefined();
  });
});
