// TASK-1333: record-scoped recycle preserves the expensive judge run before
// removing its live gate state. Real git is used because reachability is the
// property under test.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as pausedRunState from "../../src/dispatcher/paused-run-state.js";

type ArchiveAndMove = (
  projectRoot: string,
  logDir: string,
  taskId: string,
) => {
  branchRef: string;
  checkpointPath: string;
  approvalPath: string;
  manifestPath: string;
};

const archiveAndMoveJudgeRunState = (
  pausedRunState as unknown as { archiveAndMoveJudgeRunState: ArchiveAndMove }
).archiveAndMoveJudgeRunState;

describe("TASK-1333 judge run archive-and-move", () => {
  let projectRoot: string;
  let logDir: string;

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-judge-recycle-"));
    logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.test"]);
    git(["config", "user.name", "Quack Test"]);
    fs.writeFileSync(path.join(projectRoot, "seed.txt"), "seed\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "seed"]);

    git(["checkout", "-b", "quack/TASK-1333"]);
    fs.writeFileSync(path.join(projectRoot, "worker-output.txt"), "paid work\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "worker output"]);
    git(["checkout", "main"]);

    fs.writeFileSync(
      path.join(logDir, "approvals", "TASK-1333-judge.json"),
      JSON.stringify({
        taskId: "TASK-1333",
        state: "approved",
        diff: "diff",
        filesModified: ["worker-output.txt"],
        filesCreated: [],
        verificationPassed: true,
        createdAt: "2026-09-07T00:00:00.000Z",
        intentHold: {
          rationale: ["contract review"],
          diffFingerprint: "fp-1333",
          heldAt: "2026-09-07T00:00:00.000Z",
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(logDir, "checkpoint-TASK-1333.json"),
      JSON.stringify({
        taskId: "TASK-1333",
        sessionId: "quack-TASK-1333-old",
        branchName: "quack/TASK-1333",
        completedStages: ["gate", "blueprint", "approve", "branch", "agent", "commit"],
        totalCostUsd: 3.25,
        retriesUsed: 0,
        startedAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:10:00.000Z",
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("moves the record and checkpoint only after preserving the branch and intent hold", () => {
    const workerSha = git(["rev-parse", "quack/TASK-1333"]);
    const archive = archiveAndMoveJudgeRunState(projectRoot, logDir, "TASK-1333");

    expect(fs.existsSync(path.join(logDir, "approvals", "TASK-1333-judge.json"))).toBe(false);
    expect(fs.existsSync(path.join(logDir, "checkpoint-TASK-1333.json"))).toBe(false);
    expect(git(["rev-parse", archive.branchRef])).toBe(workerSha);
    expect(git(["rev-parse", "quack/TASK-1333"])).toBe(workerSha);

    const approval = JSON.parse(fs.readFileSync(archive.approvalPath, "utf-8")) as {
      intentHold?: { diffFingerprint?: string };
    };
    expect(approval.intentHold?.diffFingerprint).toBe("fp-1333");
    expect(fs.existsSync(archive.checkpointPath)).toBe(true);
    expect(fs.existsSync(archive.manifestPath)).toBe(true);
  });

  it("refuses before moving either live record when branch preservation fails", () => {
    git(["branch", "-D", "quack/TASK-1333"]);

    expect(() => archiveAndMoveJudgeRunState(projectRoot, logDir, "TASK-1333")).toThrow(/branch/i);
    expect(fs.existsSync(path.join(logDir, "approvals", "TASK-1333-judge.json"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "checkpoint-TASK-1333.json"))).toBe(true);
  });
});
