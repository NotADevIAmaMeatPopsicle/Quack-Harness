// ─── TASK-1305: verdict extraction + anchors audit matrix ───────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { auditFindingAnchors, extractReviewResult } from "../../src/review/verdict-extract";
import type { ReviewerFinding } from "../../src/review/reviewer-types";

const VALID = {
  verdict: "AMEND",
  summary: "two real findings",
  confidence: 0.8,
  findings: [
    {
      severity: "should_fix",
      summary: "finding one",
      detail: "evidence",
      anchors: ["src/a.ts:10"],
    },
  ],
};

describe("extractReviewResult", () => {
  it("parses direct JSON", () => {
    const result = extractReviewResult(JSON.stringify(VALID));
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("AMEND");
    expect(result!.findings).toHaveLength(1);
    expect(result!.confidence).toBe(0.8);
    expect(result!.summary).toBe("two real findings");
  });

  it("parses a fenced JSON block inside prose", () => {
    const text = `Here is my review.\n\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nDone.`;
    const result = extractReviewResult(text);
    expect(result?.verdict).toBe("AMEND");
  });

  it("skips an invalid fenced block and uses a later valid one", () => {
    const text = `\`\`\`json\n{"not": "a verdict"}\n\`\`\`\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    const result = extractReviewResult(text);
    expect(result?.verdict).toBe("AMEND");
  });

  it("finds a balanced object containing verdict in prose", () => {
    const text = `Thinking... {"nested": {"x": 1}} and then ${JSON.stringify(VALID)} trailing prose`;
    const result = extractReviewResult(text);
    expect(result?.verdict).toBe("AMEND");
  });

  it("handles braces inside JSON strings (string-aware walker)", () => {
    const withBraces = {
      ...VALID,
      summary: "code like `if (x) { y(); }` in a string",
    };
    const text = `prefix ${JSON.stringify(withBraces)} suffix`;
    const result = extractReviewResult(text);
    expect(result?.summary).toContain("y();");
  });

  it("normalizes verdict case and the spaced FIX FIRST form", () => {
    expect(extractReviewResult('{"verdict": "ship", "findings": []}')?.verdict).toBe("SHIP");
    expect(extractReviewResult('{"verdict": "FIX FIRST", "findings": []}')?.verdict).toBe(
      "FIX_FIRST",
    );
    expect(extractReviewResult('{"verdict": "fix-first", "findings": []}')?.verdict).toBe(
      "FIX_FIRST",
    );
  });

  it("rejects an unknown verdict value", () => {
    expect(extractReviewResult('{"verdict": "APPROVE", "findings": []}')).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(extractReviewResult("no json here at all")).toBeNull();
    expect(extractReviewResult("")).toBeNull();
  });

  it("drops findings without a summary and coerces unknown severities", () => {
    const text = JSON.stringify({
      verdict: "AMEND",
      findings: [
        { severity: "blocking", summary: "kept" },
        { severity: "CRITICAL", summary: "coerced severity" },
        { severity: "nit", summary: "   " },
        { severity: "nit" },
        "not-an-object",
      ],
    });
    const result = extractReviewResult(text);
    expect(result!.findings).toHaveLength(2);
    expect(result!.findings[0].severity).toBe("blocking");
    expect(result!.findings[1].severity).toBe("should_fix");
  });

  it("clamps confidence into [0,1] and omits non-numeric confidence", () => {
    expect(extractReviewResult('{"verdict":"SHIP","confidence":7,"findings":[]}')!.confidence).toBe(
      1,
    );
    expect(
      extractReviewResult('{"verdict":"SHIP","confidence":-2,"findings":[]}')!.confidence,
    ).toBe(0);
    expect(
      extractReviewResult('{"verdict":"SHIP","confidence":"high","findings":[]}')!.confidence,
    ).toBeUndefined();
  });

  it("defaults summary to the verdict when absent", () => {
    const result = extractReviewResult('{"verdict":"SHIP","findings":[]}');
    expect(result!.summary).toBe("SHIP");
  });
});

describe("auditFindingAnchors", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-review-audit-"));
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "src", "real.ts"), "export {};\n");
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports existing and missing anchor paths, stripping :line suffixes", () => {
    const findings: ReviewerFinding[] = [
      {
        severity: "blocking",
        summary: "a",
        anchors: ["src/real.ts:42", "src/ghost.ts:7"],
      },
      { severity: "nit", summary: "b", anchors: ["src/real.ts:1-9"] },
    ];
    const audit = auditFindingAnchors(findings, tmpRoot);
    expect(audit.total).toBe(2); // distinct paths after suffix strip
    expect(audit.missing).toEqual(["src/ghost.ts"]);
  });

  it("treats a throwing existence check (NUL-poisoned path) as missing, never throws", () => {
    const audit = auditFindingAnchors(
      [{ severity: "blocking", summary: "x", anchors: ["src/\u0000evil.ts:3"] }],
      tmpRoot,
    );
    expect(audit).toEqual({ total: 1, missing: ["src/\u0000evil.ts"] });
  });

  it("returns an empty audit when no findings carry anchors", () => {
    const audit = auditFindingAnchors([{ severity: "nit", summary: "no anchors" }], tmpRoot);
    expect(audit.total).toBe(0);
    expect(audit.missing).toEqual([]);
  });
});
