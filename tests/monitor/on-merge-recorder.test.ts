import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  extractMergeCandidates,
  readCursor,
  writeCursor,
  runBackfillScan,
  runOnMergeScan,
  selectUpgradeSample,
  startOnMergeRecorder,
  type BackfillDeps,
  type MergeScanCandidate,
  type OnMergeScanDeps,
} from "../../src/monitor/on-merge-recorder";

// ─── Helpers ───────────────────────────────────────────────────────────

function logLine(sha: string, parents: string[], subject: string): string {
  return `${sha}\t${parents.join(" ")}\t${subject}`;
}

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-on-merge-"));
}

interface FakeGit {
  runGit: (args: string[]) => Promise<string>;
  calls: string[][];
}

function makeFakeGit(tip: string, logLines: string[] | Error = []): FakeGit {
  const calls: string[][] = [];
  return {
    calls,
    runGit: (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return Promise.resolve(`${tip}\n`);
      if (args[0] === "log") {
        if (logLines instanceof Error) return Promise.reject(logLines);
        return Promise.resolve(logLines.join("\n") + "\n");
      }
      return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
    },
  };
}

function makeDeps(
  root: string,
  git: FakeGit,
  overrides: Partial<OnMergeScanDeps> = {},
): OnMergeScanDeps & {
  recorded: MergeScanCandidate[];
  emitted: Array<{ stage: string; payload: Record<string, unknown> }>;
  notified: string[];
} {
  const recorded: MergeScanCandidate[] = [];
  const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
  const notified: string[] = [];
  return {
    projectRoot: root,
    baseBranch: "main",
    runGit: git.runGit,
    taskExists: () => true,
    claimantIndexProvider: () => Promise.resolve({ status: "scanned", contested: new Map() }),
    persistClaimantDiagnostic: () => Promise.resolve(),
    scannerMethod: "on-merge",
    record: (candidate) => {
      recorded.push(candidate);
      return Promise.resolve({ applied: true });
    },
    onTaskRecorded: (taskId) => notified.push(taskId),
    emit: (stage, payload) => emitted.push({ stage, payload }),
    log: () => undefined,
    recorded,
    emitted,
    notified,
    ...overrides,
  };
}

// ─── extractMergeCandidates ────────────────────────────────────────────

describe("extractMergeCandidates", () => {
  test.each([
    ["bracket lead", logLine("a1", ["p1"], "[TASK-925] lifecycle: mark complete"), "TASK-925"],
    [
      "conventional lead",
      logLine("a2", ["p1"], "feat(judge): TASK-1200 enforcement verdict constraints"),
      "TASK-1200",
    ],
    ["bare id colon", logLine("a3", ["p1"], "TASK-096: fix stale reads"), "TASK-096"],
    ["bare id space", logLine("a4", ["p1"], "TASK-096 fix stale reads"), "TASK-096"],
    [
      "branch merge (2 parents)",
      logLine("a5", ["p1", "p2"], "Merge branch 'quack/TASK-086'"),
      "TASK-086",
    ],
    [
      "PR merge (2 parents)",
      logLine("a6", ["p1", "p2"], "Merge pull request #14 from owner/quack/TASK-123-slug"),
      "TASK-123",
    ],
    ["subtask suffix", logLine("a7", ["p1"], "[TASK-092-A] enrichment timeout"), "TASK-092-A"],
    ["saurus id", logLine("a8", ["p1"], "SAURUS-REM-013: remediation"), "SAURUS-REM-013"],
    [
      "conventional no scope",
      logLine("a9", ["p1"], "feat: TASK-055 progress artifact"),
      "TASK-055",
    ],
  ])("records %s", (_name, line, expectedId) => {
    const candidates = extractMergeCandidates([line]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].taskId).toBe(expectedId);
  });

  test.each([
    ["docs type", logLine("b1", ["p1"], "docs(tasks): TASK-1201 spec amendments")],
    ["chore type", logLine("b2", ["p1"], "chore: TASK-001 cleanup")],
    [
      "spec type (empirical)",
      logLine("b3", ["p1"], "spec: TASK-104/105/106 remote instance management"),
    ],
    [
      "specs scope (empirical)",
      logLine("b4", ["p1"], "fix(specs): TASK-899 add checkbox-list testing requirements"),
    ],
    ["tasks scope", logLine("b5", ["p1"], "feat(tasks): TASK-900 tweak metadata")],
    ["docs scope", logLine("b6", ["p1"], "feat(docs): TASK-901 document things")],
    ["mid-subject mention", logLine("b7", ["p1"], "fix typo, see TASK-054 for context")],
    ["conventional non-lead id", logLine("b8", ["p1"], "feat(x): see TASK-055 later")],
    ["quack branch in 1-parent subject", logLine("b9", ["p1"], "Merge branch 'quack/TASK-086'")],
    ["no id at all", logLine("b10", ["p1"], "Some squash-merged PR title (#123)")],
  ])("rejects %s", (_name, line) => {
    expect(extractMergeCandidates([line])).toHaveLength(0);
  });

  test("dedupes ids keeping the newest (first) occurrence", () => {
    const candidates = extractMergeCandidates([
      logLine("newer", ["p1"], "[TASK-925] lifecycle: mark complete"),
      logLine("older", ["p1"], "[TASK-925] auto-commit: sealed agent output"),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].commitSha).toBe("newer");
  });

  test("ignores malformed log lines", () => {
    expect(extractMergeCandidates(["", "not-a-log-line", "onlysha\t"])).toHaveLength(0);
  });
});

// ─── Cursor ────────────────────────────────────────────────────────────

describe("cursor persistence", () => {
  test("readCursor returns null when absent", async () => {
    const root = makeTmpRoot();
    expect(await readCursor(root)).toBeNull();
  });

  test("writeCursor + readCursor roundtrip, no temp file left behind", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "abc123",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const cursor = await readCursor(root);
    expect(cursor?.lastScannedSha).toBe("abc123");
    const files = fs.readdirSync(path.join(root, ".quack"));
    expect(files).toEqual(["on-merge-cursor.json"]);
  });
});

// ─── runOnMergeScan ────────────────────────────────────────────────────

describe("runOnMergeScan", () => {
  test("first run initializes the cursor at tip and records nothing", async () => {
    const root = makeTmpRoot();
    const git = makeFakeGit("tip-1", [
      logLine("x1", ["p1"], "[TASK-925] this must NOT be recorded on first run"),
    ]);
    const deps = makeDeps(root, git);

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual([]);
    expect(result.cursorMovedTo).toBe("tip-1");
    expect(deps.recorded).toHaveLength(0);
    // Only rev-parse ran; no log call on first run.
    expect(git.calls.map((c) => c[0])).toEqual(["rev-parse"]);
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
  });

  test("no-op when the tip has not moved", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-1");
    const deps = makeDeps(root, git);

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual([]);
    expect(git.calls.map((c) => c[0])).toEqual(["rev-parse"]);
  });

  test("records new completion-shaped merges, emits, notifies, moves cursor", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-2", [
      logLine("c1", ["p1"], "[TASK-925] lifecycle: mark complete"),
      logLine("c2", ["p1"], "docs(tasks): TASK-926 spec only, excluded"),
    ]);
    const deps = makeDeps(root, git);

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual(["TASK-925"]);
    expect(deps.recorded[0]).toMatchObject({ taskId: "TASK-925", commitSha: "c1" });
    expect(deps.notified).toEqual(["TASK-925"]);
    expect(deps.emitted).toEqual([expect.objectContaining({ stage: "recording_on_merge" })]);
    expect(result.cursorMovedTo).toBe("tip-2");
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-2");
    expect(git.calls[1]).toEqual(["log", "tip-1..main", "--format=%H%x09%P%x09%s"]);
  });

  test("writer-level skip lands in skippedExisting with no emit or notify", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-2", [logLine("c1", ["p1"], "[TASK-925] re-merged")]);
    const deps = makeDeps(root, git, {
      record: () => Promise.resolve({ applied: false, skippedReason: "existing-verdict" }),
    });

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual([]);
    expect(result.skippedExisting).toEqual(["TASK-925"]);
    expect(deps.emitted).toEqual([]);
    expect(deps.notified).toEqual([]);
  });

  test("unknown task ids emit an advisory and never reach the writer", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-2", [logLine("c1", ["p1"], "[TASK-999] merged but unregistered")]);
    const deps = makeDeps(root, git, { taskExists: () => false });

    const result = await runOnMergeScan(deps);

    expect(result.unregistered).toEqual(["TASK-999"]);
    expect(deps.recorded).toHaveLength(0);
    expect(deps.emitted).toEqual([
      expect.objectContaining({ stage: "recording_unregistered_merge" }),
    ]);
  });

  test("unreachable cursor re-initializes at tip and records nothing", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "gone-sha",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-3", new Error("fatal: bad revision 'gone-sha..main'"));
    const deps = makeDeps(root, git);

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual([]);
    expect(result.cursorMovedTo).toBe("tip-3");
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-3");
  });

  test("base-branch identity change re-initializes instead of scanning", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "dev",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-2", [
      logLine("c1", ["p1"], "[TASK-925] should not record on re-init"),
    ]);
    const deps = makeDeps(root, git); // baseBranch: "main" != cursor's "dev"

    const result = await runOnMergeScan(deps);

    expect(result.recorded).toEqual([]);
    expect((await readCursor(root))?.baseBranch).toBe("main");
  });

  test("a failing record leaves the cursor unmoved (crash-safe re-scan)", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    const git = makeFakeGit("tip-2", [logLine("c1", ["p1"], "[TASK-925] record will fail")]);
    const deps = makeDeps(root, git, {
      record: () => Promise.reject(new Error("db locked")),
    });

    await expect(runOnMergeScan(deps)).rejects.toThrow("db locked");
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
  });

  test("concurrent ticks are serialized: second call reports busy", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    let releaseRecord: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const git = makeFakeGit("tip-2", [logLine("c1", ["p1"], "[TASK-925] slow record")]);
    const deps = makeDeps(root, git, {
      record: async () => {
        await gate;
        return { applied: true };
      },
    });

    const first = runOnMergeScan(deps);
    const second = await runOnMergeScan(deps);
    expect(second.busy).toBe(true);

    releaseRecord?.();
    const firstResult = await first;
    expect(firstResult.recorded).toEqual(["TASK-925"]);
  });
});

// ─── runBackfillScan (TASK-1204) ───────────────────────────────────────

function logLine4(sha: string, parents: string[], subject: string, mergedAt: string): string {
  return `${sha}\t${parents.join(" ")}\t${subject}\t${mergedAt}`;
}

function makeBackfillGit(lines: string[]): FakeGit {
  const calls: string[][] = [];
  return {
    calls,
    runGit: (args: string[]) => {
      calls.push(args);
      if (args[0] === "log") return Promise.resolve(lines.join("\n") + "\n");
      return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
    },
  };
}

function makeBackfillDeps(
  root: string,
  git: FakeGit,
  overrides: Partial<BackfillDeps> = {},
): BackfillDeps & {
  recorded: MergeScanCandidate[];
  emitted: Array<{ stage: string; payload: Record<string, unknown> }>;
  notified: string[];
} {
  return { ...makeDeps(root, git), hasProtectedRow: () => false, ...overrides };
}

const BF_LINES = [
  logLine4("c3", ["p"], "[TASK-303] newest merge", "2026-06-10T12:00:00+00:00"),
  logLine4("c2", ["p"], "[TASK-302] middle merge", "2026-05-20T12:00:00+00:00"),
  logLine4("c1", ["p"], "[TASK-301] oldest merge", "2026-05-05T12:00:00+00:00"),
];

describe("runBackfillScan", () => {
  test("dry-run writes nothing, emits nothing, and reports dispositions", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit(BF_LINES);
    const deps = makeBackfillDeps(root, git, {
      hasProtectedRow: (taskId) => taskId === "TASK-302",
    });

    const result = await runBackfillScan(deps, { since: "2026-05-01" });

    expect(result.dryRun).toBe(true);
    expect(result.commitsScanned).toBe(3);
    expect(deps.recorded).toHaveLength(0);
    expect(deps.emitted).toHaveLength(0);
    expect(result.recorded).toBe(0);
    expect(result.skippedExisting).toBe(1);
    const byId = Object.fromEntries(result.candidates.map((c) => [c.taskId, c.disposition]));
    expect(byId).toEqual({
      "TASK-301": "would-record",
      "TASK-302": "skipped-existing",
      "TASK-303": "would-record",
    });
    expect(git.calls[0]).toEqual([
      "log",
      "main",
      "--since=2026-05-01",
      "--format=%H%x09%P%x09%s%x09%cI",
    ]);
  });

  test("apply records oldest-first, emits per write, and fires the queue hook", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit(BF_LINES);
    const deps = makeBackfillDeps(root, git);

    const result = await runBackfillScan(deps, { since: "2026-05-01", apply: true });

    expect(result.dryRun).toBe(false);
    expect(result.recorded).toBe(3);
    expect(deps.recorded.map((c) => c.taskId)).toEqual(["TASK-301", "TASK-302", "TASK-303"]);
    expect(deps.notified).toEqual(["TASK-301", "TASK-302", "TASK-303"]);
    expect(deps.emitted.every((e) => e.stage === "recording_on_merge")).toBe(true);
    expect(deps.emitted).toHaveLength(3);
  });

  test("maxWrites caps oldest-first; the newest remainder is over-cap", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit(BF_LINES);
    const deps = makeBackfillDeps(root, git);

    const result = await runBackfillScan(deps, { since: "2026-05-01", apply: true, maxWrites: 2 });

    expect(result.recorded).toBe(2);
    expect(result.overCap).toBe(1);
    expect(deps.recorded.map((c) => c.taskId)).toEqual(["TASK-301", "TASK-302"]);
    const over = result.candidates.find((c) => c.disposition === "over-cap");
    expect(over?.taskId).toBe("TASK-303");
  });

  test("idempotent re-apply: writer-guard skips land in skipped-existing without emits", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit(BF_LINES);
    const deps = makeBackfillDeps(root, git, {
      record: () => Promise.resolve({ applied: false, skippedReason: "existing-verdict" }),
    });

    const result = await runBackfillScan(deps, { since: "2026-05-01", apply: true });

    expect(result.recorded).toBe(0);
    expect(result.skippedExisting).toBe(3);
    expect(deps.emitted).toHaveLength(0);
    expect(deps.notified).toHaveLength(0);
  });

  test("unregistered ids advise on apply only and never reach the writer", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit([BF_LINES[2]]);
    const dryDeps = makeBackfillDeps(root, git, { taskExists: () => false });
    const dry = await runBackfillScan(dryDeps, { since: "2026-05-01" });
    expect(dry.unregistered).toBe(1);
    expect(dryDeps.emitted).toHaveLength(0);

    const applyDeps = makeBackfillDeps(root, makeBackfillGit([BF_LINES[2]]), {
      taskExists: () => false,
    });
    const applied = await runBackfillScan(applyDeps, { since: "2026-05-01", apply: true });
    expect(applied.unregistered).toBe(1);
    expect(applyDeps.recorded).toHaveLength(0);
    expect(applyDeps.emitted).toEqual([
      expect.objectContaining({ stage: "recording_unregistered_merge" }),
    ]);
  });

  test("never touches the live scanner's cursor", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit(BF_LINES);

    await runBackfillScan(makeBackfillDeps(root, git), { since: "2026-05-01", apply: true });

    expect(fs.existsSync(path.join(root, ".quack", "on-merge-cursor.json"))).toBe(false);
  });

  test("shares the per-project mutex with the tick scan", async () => {
    const root = makeTmpRoot();
    await writeCursor(root, {
      lastScannedSha: "tip-1",
      baseBranch: "main",
      projectRoot: root,
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tickGit = makeFakeGit("tip-2", [logLine("c1", ["p1"], "[TASK-925] slow")]);
    const tickDeps = makeDeps(root, tickGit, {
      record: async () => {
        await gate;
        return { applied: true };
      },
    });

    const tick = runOnMergeScan(tickDeps);
    const backfill = await runBackfillScan(makeBackfillDeps(root, makeBackfillGit(BF_LINES)), {
      since: "2026-05-01",
    });
    expect(backfill.busy).toBe(true);

    release?.();
    await tick;
  });

  test("dry-run without a hasProtectedRow dep treats known tasks as would-record", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit([BF_LINES[2]]);
    const deps = makeBackfillDeps(root, git, { hasProtectedRow: undefined });

    const result = await runBackfillScan(deps, { since: "2026-05-01" });

    expect(result.candidates[0]?.disposition).toBe("would-record");
  });

  test("a running backfill makes the tick scan report busy (reverse mutex direction)", async () => {
    const root = makeTmpRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeBackfillDeps(root, makeBackfillGit(BF_LINES), {
      record: async () => {
        await gate;
        return { applied: true };
      },
    });

    const backfill = runBackfillScan(deps, { since: "2026-05-01", apply: true });
    const tick = await runOnMergeScan(makeDeps(root, makeFakeGit("tip-9")));
    expect(tick.busy).toBe(true);

    release?.();
    await backfill;
  });

  test("the sample is identical between uncapped dry-run and capped apply of the same window", async () => {
    const root = makeTmpRoot();
    const dry = await runBackfillScan(makeBackfillDeps(root, makeBackfillGit(BF_LINES)), {
      since: "2026-05-01",
    });
    const capped = await runBackfillScan(makeBackfillDeps(root, makeBackfillGit(BF_LINES)), {
      since: "2026-05-01",
      apply: true,
      maxWrites: 1,
    });

    expect(capped.sample).toEqual(dry.sample);
  });

  test("lines missing the %cI field are dropped defensively", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit([
      "c1\tp\t[TASK-301] three-field line without a date",
      logLine4("c2", ["p"], "[TASK-302] proper line", "2026-05-20T12:00:00+00:00"),
    ]);
    const deps = makeBackfillDeps(root, git);

    const result = await runBackfillScan(deps, { since: "2026-05-01" });

    expect(result.candidates.map((c) => c.taskId)).toEqual(["TASK-302"]);
  });

  test("pre-splits %cI so tab-carrying subjects still extract", async () => {
    const root = makeTmpRoot();
    const git = makeBackfillGit([
      logLine4("c9", ["p"], "[TASK-390] subject\twith a tab", "2026-06-01T00:00:00+00:00"),
    ]);
    const deps = makeBackfillDeps(root, git);

    const result = await runBackfillScan(deps, { since: "2026-05-01" });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      taskId: "TASK-390",
      mergedAt: "2026-06-01T00:00:00+00:00",
    });
    expect(result.candidates[0].subject).toContain("subject\twith a tab");
  });
});

describe("selectUpgradeSample", () => {
  const candidates = [
    { taskId: "TASK-A1", mergedAt: "2026-05-01T00:00:00Z" },
    { taskId: "TASK-A2", mergedAt: "2026-05-02T00:00:00Z" },
    { taskId: "TASK-A3", mergedAt: "2026-05-03T00:00:00Z" },
    { taskId: "TASK-B1", mergedAt: "2026-06-01T00:00:00Z" },
    { taskId: "TASK-B2", mergedAt: "2026-06-02T00:00:00Z" },
  ];

  test("is deterministic and stratifies by merge month with ceil rounding", () => {
    const first = selectUpgradeSample(candidates, 20);
    const second = selectUpgradeSample(candidates, 20);

    expect([...first].sort()).toEqual([...second].sort());
    // ceil(3 * 0.2) = 1 from May, ceil(2 * 0.2) = 1 from June.
    expect(first.size).toBe(2);
    const may = [...first].filter((id) => id.startsWith("TASK-A"));
    const june = [...first].filter((id) => id.startsWith("TASK-B"));
    expect(may).toHaveLength(1);
    expect(june).toHaveLength(1);
  });

  test("empty input yields an empty sample", () => {
    expect(selectUpgradeSample([], 20).size).toBe(0);
  });
});

// ─── startOnMergeRecorder ──────────────────────────────────────────────

describe("startOnMergeRecorder", () => {
  test("runs a startup tick and returns a working stop function", async () => {
    const root = makeTmpRoot();
    const git = makeFakeGit("tip-1");
    const deps = makeDeps(root, git);

    const stop = startOnMergeRecorder({ ...deps, intervalMs: 3_600_000 });
    // Let the startup tick's promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(git.calls.length).toBeGreaterThanOrEqual(1);
    expect((await readCursor(root))?.lastScannedSha).toBe("tip-1");
    expect(() => stop()).not.toThrow();
  });
});
