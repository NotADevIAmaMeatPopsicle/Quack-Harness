import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DuplicateClaimantIndex } from "../../src/core/duplicate-claimants";
import {
  claimantDiagnosticSessionId,
  persistClaimantDiagnostic,
} from "../../src/monitor/claimant-diagnostic";
import { EventWriter } from "../../src/monitor/event-emitter";
import { EventReader } from "../../src/monitor/event-reader";
import {
  readCursor,
  runBackfillScan,
  runOnMergeScan,
  writeCursor,
  type BackfillDeps,
  type OnMergeScanDeps,
} from "../../src/monitor/on-merge-recorder";

const CLEAN_INDEX: DuplicateClaimantIndex = { status: "scanned", contested: new Map() };
const CONTESTED_INDEX: DuplicateClaimantIndex = {
  status: "scanned",
  contested: new Map([["TASK-610", ["TASK-610-a.md", "TASK-999-cross.md"]]]),
};
const UNAVAILABLE_INDEX: DuplicateClaimantIndex = {
  status: "unavailable",
  reason: "producer rejected",
};

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338d-recorder-"));
}

function liveGit(
  tip: string,
  subjects: Array<[string, string]>,
): (args: string[]) => Promise<string> {
  return (args) => {
    if (args[0] === "rev-parse") return Promise.resolve(`${tip}\n`);
    if (args[0] === "log") {
      return Promise.resolve(
        subjects.map(([sha, subject]) => `${sha}\tparent\t${subject}`).join("\n") + "\n",
      );
    }
    return Promise.reject(new Error(`unexpected git command: ${args.join(" ")}`));
  };
}

function backfillGit(subjects: Array<[string, string]>): (args: string[]) => Promise<string> {
  return (args) => {
    if (args[0] !== "log") {
      return Promise.reject(new Error(`unexpected git command: ${args.join(" ")}`));
    }
    return Promise.resolve(
      subjects
        .map(
          ([sha, subject], index) =>
            `${sha}\tparent\t${subject}\t2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        )
        .join("\n") + "\n",
    );
  };
}

async function seededCursor(root: string): Promise<void> {
  await writeCursor(root, {
    lastScannedSha: "tip-1",
    baseBranch: "main",
    projectRoot: root,
    updatedAt: "2026-08-18T00:00:00Z",
  });
}

function deps(
  root: string,
  index: DuplicateClaimantIndex,
  overrides: Partial<OnMergeScanDeps> = {},
): OnMergeScanDeps {
  return {
    projectRoot: root,
    baseBranch: "main",
    runGit: liveGit("tip-2", [["commit-610", "[TASK-610] merged"]]),
    taskExists: () => true,
    claimantIndexProvider: jest.fn(() => Promise.resolve(index)),
    record: jest.fn(() => Promise.resolve({ applied: true })),
    persistClaimantDiagnostic: jest.fn(() => Promise.resolve()),
    ...overrides,
    scannerMethod: overrides.scannerMethod ?? "on-merge",
  };
}

describe("TASK-1338-D recorder dispositions and per-invocation index", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("uses one fresh claimant snapshot for two candidates and passes it to every writer call", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const scan = deps(root, CLEAN_INDEX, {
      runGit: liveGit("tip-2", [
        ["commit-610", "[TASK-610] merged"],
        ["commit-611", "[TASK-611] merged"],
      ]),
    });

    await runOnMergeScan(scan);

    expect(scan.claimantIndexProvider).toHaveBeenCalledTimes(1);
    expect(scan.record).toHaveBeenCalledTimes(2);
    const record = scan.record as jest.MockedFunction<OnMergeScanDeps["record"]>;
    expect(record.mock.calls.map(([, claimantIndex]) => claimantIndex)).toEqual([
      CLEAN_INDEX,
      CLEAN_INDEX,
    ]);
  });

  it("persists a contested live diagnostic and holds the real cursor", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const order: string[] = [];
    const scan = deps(root, CONTESTED_INDEX, {
      persistClaimantDiagnostic: jest.fn(() => {
        order.push("diagnostic");
        return Promise.resolve();
      }),
    });

    const result = await runOnMergeScan(scan);
    order.push(`cursor:${(await readCursor(root))?.lastScannedSha}`);

    expect(result.contested).toEqual(["TASK-610"]);
    expect(scan.record).not.toHaveBeenCalled();
    expect(result.cursorMovedTo).toBeNull();
    expect(order).toEqual(["diagnostic", "cursor:tip-1"]);
  });

  it("rescans the same contested commit after ownership repair, records it, and advances", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const provider = jest
      .fn()
      .mockResolvedValueOnce(CONTESTED_INDEX)
      .mockResolvedValueOnce(CLEAN_INDEX);
    const scan = deps(root, CONTESTED_INDEX, {
      claimantIndexProvider: provider,
    });

    const held = await runOnMergeScan(scan);
    expect(held).toMatchObject({ contested: ["TASK-610"], cursorMovedTo: null });
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");

    const repaired = await runOnMergeScan(scan);
    expect(repaired).toMatchObject({ recorded: ["TASK-610"], cursorMovedTo: "tip-2" });
    expect(scan.record).toHaveBeenCalledTimes(1);
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-2");
  });

  it("leaves the real cursor unchanged when contested diagnostic persistence fails", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const scan = deps(root, CONTESTED_INDEX, {
      persistClaimantDiagnostic: jest.fn(() => Promise.reject(new Error("diagnostic disk full"))),
    });

    await expect(runOnMergeScan(scan)).rejects.toThrow("diagnostic disk full");
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
  });

  it("names an unavailable live index and does not advance past the candidate", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const scan = deps(root, UNAVAILABLE_INDEX, {
      record: jest.fn(() =>
        Promise.resolve({
          applied: false,
          skippedReason: "claimant-index-unavailable",
        }),
      ),
    });

    const result = await runOnMergeScan(scan);

    expect(result.claimantIndexUnavailable).toEqual(["TASK-610"]);
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
    expect(scan.persistClaimantDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claimant-index-unavailable",
        reason: "producer rejected",
      }),
    );
  });

  it("observes a claimant introduced between ticks through the same long-lived deps", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const provider = jest
      .fn()
      .mockResolvedValueOnce(CLEAN_INDEX)
      .mockResolvedValueOnce(CONTESTED_INDEX);
    let tick = 0;
    const scan = deps(root, CLEAN_INDEX, {
      claimantIndexProvider: provider,
      runGit: (args) => {
        if (args[0] === "rev-parse") {
          return Promise.resolve(`${tick === 0 ? "tip-2" : "tip-3"}\n`);
        }
        tick += 1;
        return Promise.resolve(
          `${tick === 1 ? "commit-clean" : "commit-contested"}\tparent\t[TASK-610] merged\n`,
        );
      },
    });

    expect((await runOnMergeScan(scan)).recorded).toEqual(["TASK-610"]);
    expect((await runOnMergeScan(scan)).contested).toEqual(["TASK-610"]);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["dry-run", false],
    ["apply", true],
  ])("backfill %s reports contested and never calls the writer", async (_label, apply) => {
    const root = tmpRoot();
    roots.push(root);
    const scan: BackfillDeps = {
      ...deps(root, CONTESTED_INDEX),
      runGit: backfillGit([["commit-610", "[TASK-610] merged"]]),
      hasProtectedRow: () => false,
    };

    const result = await runBackfillScan(scan, { since: "2026-08-01", apply });

    expect(result.candidates[0]?.disposition).toBe("contested");
    expect(scan.record).not.toHaveBeenCalled();
    expect(scan.claimantIndexProvider).toHaveBeenCalledTimes(1);
    expect(scan.persistClaimantDiagnostic).toHaveBeenCalledTimes(apply ? 1 : 0);
  });

  it.each([
    ["dry-run", false],
    ["apply", true],
  ])("backfill %s reports claimant-index-unavailable distinctly", async (_label, apply) => {
    const root = tmpRoot();
    roots.push(root);
    const scan: BackfillDeps = {
      ...deps(root, UNAVAILABLE_INDEX, {
        record: jest.fn(() =>
          Promise.resolve({
            applied: false,
            skippedReason: "claimant-index-unavailable",
          }),
        ),
      }),
      runGit: backfillGit([["commit-610", "[TASK-610] merged"]]),
      hasProtectedRow: () => true,
    };

    const result = await runBackfillScan(scan, { since: "2026-08-01", apply });

    expect(result.candidates[0]?.disposition).toBe("claimant-index-unavailable");
    expect(result.skippedExisting).toBe(0);
    expect(scan.record).toHaveBeenCalledTimes(apply ? 1 : 0);
  });
});

describe("TASK-1338-D durable claimant diagnostic", () => {
  const roots: string[] = [];
  const diagnostic = {
    kind: "duplicate-claimants" as const,
    taskId: "TASK-610",
    commitSha: "abc1234",
    claimants: ["TASK-999-cross.md", "TASK-610-a.md"],
    scannerMethod: "on-merge" as const,
    reason: "Task TASK-610 has a contested id.",
  };

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("is idempotent by normalized task id and commit and survives a fresh-reader restart", async () => {
    const root = tmpRoot();
    roots.push(root);
    const logDir = path.join(root, "custom", "operator-log");

    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });
    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });

    const sessionId = claimantDiagnosticSessionId("task-610", "abc1234", "duplicate-claimants");
    const freshReader = new EventReader(logDir);
    expect(freshReader.getSessionEvents(sessionId)).toHaveLength(1);
    expect(freshReader.getSessionEvents(sessionId)[0]?.payload).toMatchObject({
      taskId: "TASK-610",
      commitSha: "abc1234",
      claimants: ["TASK-610-a.md", "TASK-999-cross.md"],
      scannerMethod: "on-merge",
    });
    expect(
      freshReader.getAllSessions().filter((session) => session.sessionId === sessionId),
    ).toHaveLength(1);
  });

  it("persists unavailable and contested diagnostics separately for the same task and commit", async () => {
    const root = tmpRoot();
    roots.push(root);
    const logDir = path.join(root, ".quack", "logs");
    const unavailable = {
      ...diagnostic,
      kind: "claimant-index-unavailable" as const,
      claimants: [],
      reason: "claimant index producer rejected",
    };

    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic: unavailable });
    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });

    const freshReader = new EventReader(logDir);
    const durable = freshReader.getAllSessions().flatMap((session) =>
      freshReader
        .getSessionEvents(session.sessionId)
        .filter((event) => event.stage === "recording_claimant_diagnostic")
        .map((event) => event.payload),
    );
    expect(durable).toHaveLength(2);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "claimant-index-unavailable", claimants: [] }),
        expect.objectContaining({
          kind: "duplicate-claimants",
          claimants: ["TASK-610-a.md", "TASK-999-cross.md"],
        }),
      ]),
    );
  });

  it("accepts duplicate durable lines by presence and lets the held scan proceed", async () => {
    const root = tmpRoot();
    roots.push(root);
    await seededCursor(root);
    const logDir = path.join(root, ".quack", "logs");
    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });
    const sessionId = claimantDiagnosticSessionId("TASK-610", "abc1234", "duplicate-claimants");
    const eventPath = path.join(logDir, `events-${sessionId}.jsonl`);
    const existing = fs.readFileSync(eventPath, "utf-8");
    fs.appendFileSync(eventPath, existing, "utf-8");

    const scan = deps(root, CONTESTED_INDEX, {
      persistClaimantDiagnostic: (value) =>
        persistClaimantDiagnostic({
          logDir,
          project: "project-a",
          diagnostic: { ...value, commitSha: "abc1234" },
        }),
    });
    const result = await runOnMergeScan(scan);

    expect(result).toMatchObject({ contested: ["TASK-610"], cursorMovedTo: null });
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
  });

  it("repairs an event-only crash window after restart without duplicating either half", async () => {
    const root = tmpRoot();
    roots.push(root);
    const logDir = path.join(root, ".quack", "logs");
    const recordSpy = jest
      .spyOn(EventWriter.prototype, "recordSession")
      .mockImplementationOnce(() => {
        throw new Error("crash between appends");
      });

    await expect(
      persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic }),
    ).rejects.toThrow("crash between appends");
    recordSpy.mockRestore();

    const sessionId = claimantDiagnosticSessionId("TASK-610", "abc1234", "duplicate-claimants");
    const afterCrash = new EventReader(logDir);
    expect(afterCrash.getSessionEvents(sessionId)).toHaveLength(1);
    expect(afterCrash.getAllSessions()).toHaveLength(0);

    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });
    const afterRestart = new EventReader(logDir);
    expect(afterRestart.getSessionEvents(sessionId)).toHaveLength(1);
    expect(
      afterRestart.getAllSessions().filter((session) => session.sessionId === sessionId),
    ).toHaveLength(1);
  });

  it("repairs an indexed-session-only window without duplicating the index entry", async () => {
    const root = tmpRoot();
    roots.push(root);
    const logDir = path.join(root, ".quack", "logs");
    const sessionId = claimantDiagnosticSessionId("TASK-610", "abc1234", "duplicate-claimants");
    const writer = new EventWriter({
      sessionId,
      taskId: "TASK-610",
      project: "project-a",
      logDir,
    });
    writer.recordSession("completed", { outcome: "claimant_diagnostic" });

    await persistClaimantDiagnostic({ logDir, project: "project-a", diagnostic });

    const freshReader = new EventReader(logDir);
    expect(freshReader.getSessionEvents(sessionId)).toHaveLength(1);
    expect(
      freshReader.getAllSessions().filter((session) => session.sessionId === sessionId),
    ).toHaveLength(1);
  });
});
