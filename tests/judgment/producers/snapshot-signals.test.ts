// ─── Snapshot signal re-derivation tests (TASK-1313, round-2 F10) ───
// The checkpoint restore path: producer blocks load from the typed
// snapshot first, fall back to a manifest re-read for pre-extension
// seals, and degrade to honest advisories — never silent absence.

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentOutputSnapshot } from "../../../src/core/types";
import {
  buildInjectedSignals,
  loadProducerBlocks,
  safetyStopRequested,
} from "../../../src/judgment/producers/snapshot-signals";
import type { SealConformanceSummary } from "../../../src/judgment/producers/seal-conformance";

const TIER_S_CONFORMANCE: SealConformanceSummary = {
  tierSCount: 1,
  tierRCount: 0,
  deniedPathCount: 0,
  outsideWritableCount: 0,
  cleanCount: 0,
  facts: [
    {
      kind: "seal_conformance_path",
      path: ".quack/verify.js",
      status: "M",
      classification: "machinery_tier_s",
      candidateSafetyCode: "machinery_tamper",
    },
  ],
};

function makeSnapshot(overrides: Partial<AgentOutputSnapshot> = {}): AgentOutputSnapshot {
  return {
    taskId: "TASK-042",
    attempt: 1,
    kind: "attempt",
    sealedAt: "2026-08-04T00:00:00.000Z",
    diffBase: "base",
    diffRef: "head",
    baseSha: "a".repeat(40),
    headShaBefore: "b".repeat(40),
    headShaAfter: "c".repeat(40),
    worktreePath: "/tmp/wt",
    manifestPath: path.join(os.tmpdir(), "quack-missing", "manifest.json"),
    diffPath: "/tmp/wt/diff.patch",
    statusPath: "/tmp/wt/status.txt",
    nameStatusPath: "/tmp/wt/name-status.txt",
    gitDiff: "",
    diffStat: "",
    statusShort: "",
    changedFiles: [],
    nameStatus: [],
    filesStaged: 0,
    excludedFiles: [],
    empty: false,
    ...overrides,
  } as AgentOutputSnapshot;
}

describe("loadProducerBlocks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "quack-snap-"));
  });

  afterEach(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("typed-carry: snapshot blocks win without touching the manifest", async () => {
    // manifestPath points nowhere — a disk read would degrade to the
    // unreadable advisory, so returning the block proves no read.
    const blocks = await loadProducerBlocks(makeSnapshot({ sealConformance: TIER_S_CONFORMANCE }));
    expect(blocks.sealConformance).toEqual(TIER_S_CONFORMANCE);
    expect(blocks.advisory).toBeUndefined();
  });

  it("manifest fallback: pre-extension checkpoint re-reads the manifest", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    fsSync.writeFileSync(manifestPath, JSON.stringify({ sealConformance: TIER_S_CONFORMANCE }));
    const blocks = await loadProducerBlocks(makeSnapshot({ manifestPath }));
    expect(blocks.sealConformance).toEqual(TIER_S_CONFORMANCE);
    expect(blocks.advisory).toBeUndefined();
  });

  it("conformance_unavailable: readable manifest without blocks is a genuinely pre-extension seal", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    fsSync.writeFileSync(manifestPath, JSON.stringify({ taskId: "TASK-042" }));
    const blocks = await loadProducerBlocks(makeSnapshot({ manifestPath }));
    expect(blocks.sealConformance).toBeUndefined();
    expect(blocks.advisory?.code).toBe("conformance_unavailable");
    expect(blocks.advisory?.disposition).toBe("advisory");
  });

  it("conformance_unreadable: missing/corrupt manifest degrades honestly", async () => {
    const blocks = await loadProducerBlocks(makeSnapshot());
    expect(blocks.advisory?.code).toBe("conformance_unreadable");
    expect(blocks.advisory?.disposition).toBe("advisory");
  });
});

describe("buildInjectedSignals", () => {
  it("off mode injects nothing even with safety-tier blocks present", async () => {
    const signals = await buildInjectedSignals(
      "judge",
      makeSnapshot({ sealConformance: TIER_S_CONFORMANCE }),
      undefined,
      "off",
    );
    expect(signals).toEqual([]);
  });

  it("enforce mode derives safety signals from the typed snapshot", async () => {
    const signals = await buildInjectedSignals(
      "loop_diff",
      makeSnapshot({ sealConformance: TIER_S_CONFORMANCE }),
      undefined,
      "enforce",
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].disposition).toBe("safety");
    expect(signals[0].safetyCode).toBe("machinery_tamper");
    expect(signals[0].source).toBe("loop_diff");
  });

  it("load advisories are re-tagged to the requesting stage", async () => {
    const signals = await buildInjectedSignals("judge", makeSnapshot(), undefined, "report");
    expect(signals).toHaveLength(1);
    expect(signals[0].code).toBe("conformance_unreadable");
    expect(signals[0].source).toBe("judge");
  });

  it("worker facts merge alongside snapshot blocks", async () => {
    const signals = await buildInjectedSignals(
      "judge",
      makeSnapshot({ sealConformance: TIER_S_CONFORMANCE }),
      [
        {
          kind: "deploy",
          tier: "shape_only",
          verb: "kubectl apply",
          segment: "kubectl apply -f x.yaml",
        },
      ],
      "report",
    );
    expect(signals.map((s) => s.code).sort()).toEqual([
      "deploy_shape_only",
      "seal_machinery_tier_s",
    ]);
  });
});

describe("safetyStopRequested", () => {
  const safetySignal = {
    source: "judge" as const,
    code: "seal_machinery_tier_s",
    disposition: "safety" as const,
    message: "tamper",
    deterministic: true,
    safetyCode: "machinery_tamper" as const,
  };

  it("never stops outside enforce mode", () => {
    expect(safetyStopRequested({ action: "stop" }, [safetySignal], "report")).toBe(false);
    expect(safetyStopRequested({ action: "stop" }, [safetySignal], "off")).toBe(false);
  });

  it("enforce follows the decision action when a decision exists", () => {
    expect(safetyStopRequested({ action: "stop" }, [], "enforce")).toBe(true);
    expect(safetyStopRequested({ action: "continue" }, [safetySignal], "enforce")).toBe(false);
  });

  it("enforce fails CLOSED on injected safety signals when the projection failed", () => {
    expect(safetyStopRequested(undefined, [safetySignal], "enforce")).toBe(true);
    expect(
      safetyStopRequested(
        undefined,
        [{ ...safetySignal, disposition: "advisory" as const }],
        "enforce",
      ),
    ).toBe(false);
  });
});
