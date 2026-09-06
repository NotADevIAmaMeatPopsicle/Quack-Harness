// ─── Producer D tests (TASK-1312) ───────────────────────────────────

import { evaluateSealConformance } from "../../../src/judgment/producers/seal-conformance";
import type { AdapterSandboxConfig } from "../../../src/core/types";

const SANDBOX: AdapterSandboxConfig = {
  writablePaths: ["src/", "tests/"],
  deniedPaths: [".env", ".env.*"],
  allowedBashPatterns: [],
  deniedBashPatterns: [],
};

function evaluate(
  changed: Array<{ path: string; status: string }>,
  sandbox: AdapterSandboxConfig = SANDBOX,
  activeSpecPrefix?: string,
) {
  return evaluateSealConformance({ changedFiles: changed, sandbox, activeSpecPrefix });
}

describe("evaluateSealConformance — Tier-S machinery (machinery_tamper candidates)", () => {
  it.each([
    ".quack/verify.js",
    ".quack/adapter.json",
    ".quack/judge-criteria.md",
    ".quack/conventions.md",
    ".quack/convention-checks/check.js",
    ".quack/templates/pr.md",
  ])("classifies %s as machinery_tier_s with candidate code", (path) => {
    const summary = evaluate([{ path, status: "M" }]);
    expect(summary.tierSCount).toBe(1);
    expect(summary.facts[0].classification).toBe("machinery_tier_s");
    expect(summary.facts[0].candidateSafetyCode).toBe("machinery_tamper");
  });

  it("the simulated bash-write tamper case: verify.js added via redirect", () => {
    // Producer D is outcome verification: HOW the file was written is
    // irrelevant — an added .quack/verify.js in the sealed change-set is
    // the fact.
    const summary = evaluate([{ path: ".quack/verify.js", status: "A" }]);
    expect(summary.facts[0].candidateSafetyCode).toBe("machinery_tamper");
    expect(summary.facts[0].status).toBe("A");
  });

  it("the active task's own spec file matches by prefix", () => {
    const summary = evaluate(
      [{ path: "docs/tasks/TASK-1312-safety-floor-signal-producers.md", status: "M" }],
      SANDBOX,
      "docs/tasks/TASK-1312",
    );
    expect(summary.tierSCount).toBe(1);
  });

  it("OTHER task specs are not machinery for this run", () => {
    const summary = evaluate(
      [{ path: "docs/tasks/TASK-9999-other.md", status: "M" }],
      SANDBOX,
      "docs/tasks/TASK-1312",
    );
    expect(summary.tierSCount).toBe(0);
  });

  it("windows-style separators normalize", () => {
    const summary = evaluate([{ path: ".quack\\verify.js", status: "M" }]);
    expect(summary.tierSCount).toBe(1);
  });

  it("round-2: case-evasion closed — .QUACK/adapter.json classifies on Windows-style FS", () => {
    const summary = evaluate([{ path: ".QUACK/Adapter.JSON", status: "M" }]);
    expect(summary.tierSCount).toBe(1);
  });

  it("round-2: active-spec prefix has an id boundary — TASK-131 does not match TASK-1312", () => {
    const summary = evaluate(
      [{ path: "docs/tasks/TASK-1312-safety.md", status: "M" }],
      SANDBOX,
      "docs/tasks/TASK-131",
    );
    expect(summary.tierSCount).toBe(0);
  });
});

describe("evaluateSealConformance — Tier-R verification-transitive (flag, never stop)", () => {
  it.each([
    "package.json",
    "package-lock.json",
    "jest.config.js",
    "tsconfig.json",
    "tsconfig.eslint.json",
    ".eslintrc.json",
    "eslint.config.mjs",
    ".github/workflows/ci.yml",
  ])("classifies %s as verification_tier_r WITHOUT candidate code", (path) => {
    const summary = evaluate([{ path, status: "M" }]);
    expect(summary.tierRCount).toBe(1);
    expect(summary.facts[0].classification).toBe("verification_tier_r");
    expect(summary.facts[0].candidateSafetyCode).toBeUndefined();
  });
});

describe("evaluateSealConformance — sandbox conformance", () => {
  it("denied-path hits classify", () => {
    const summary = evaluate([{ path: ".env", status: "M" }]);
    expect(summary.deniedPathCount).toBe(1);
    expect(summary.facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("outside-writable hits classify when writablePaths is non-empty", () => {
    const summary = evaluate([{ path: "scripts/tool.mjs", status: "A" }]);
    expect(summary.outsideWritableCount).toBe(1);
  });

  it("empty writablePaths means no outside-writable classification", () => {
    const summary = evaluate([{ path: "scripts/tool.mjs", status: "A" }], {
      ...SANDBOX,
      writablePaths: [],
    });
    expect(summary.outsideWritableCount).toBe(0);
    expect(summary.cleanCount).toBe(1);
  });

  it("clean pass: in-sandbox source changes produce no facts", () => {
    const summary = evaluate([
      { path: "src/feature.ts", status: "M" },
      { path: "tests/feature.test.ts", status: "A" },
    ]);
    expect(summary.facts).toHaveLength(0);
    expect(summary.cleanCount).toBe(2);
  });
});

describe("evaluateSealConformance — precedence and counts", () => {
  it("Tier-S wins over sandbox classification for the same path", () => {
    // .quack/ is outside writablePaths too; machinery classification wins.
    const summary = evaluate([{ path: ".quack/verify.js", status: "M" }]);
    expect(summary.tierSCount).toBe(1);
    expect(summary.outsideWritableCount).toBe(0);
  });

  it("mixed change-set counts add up", () => {
    const summary = evaluate([
      { path: ".quack/verify.js", status: "M" },
      { path: "package.json", status: "M" },
      { path: ".env", status: "M" },
      { path: "scripts/x.mjs", status: "A" },
      { path: "src/ok.ts", status: "M" },
    ]);
    expect(summary.tierSCount).toBe(1);
    expect(summary.tierRCount).toBe(1);
    expect(summary.deniedPathCount).toBe(1);
    expect(summary.outsideWritableCount).toBe(1);
    expect(summary.cleanCount).toBe(1);
    expect(summary.facts).toHaveLength(4);
  });
});
