// ─── Spec anchor audit (TASK-1322) ──────────────────────────────────
// The tool exists to make a 444-spec bulk repair SAFE. Operator's
// requirement: before adding a Files-to-Modify section to old specs,
// check whether the code they point at has moved since they were
// written.
//
// So the failure that matters most is a FALSE "ok": a spec reported
// clean whose anchors have actually drifted gets repaired mechanically
// and ships a plausible-looking file list pointing at the wrong places.
// The second-worst is false drift, which buries the real signal.

import {
  auditSpecAnchors,
  extractSpecAnchors,
  hasFilesToModifySection,
  type SpecAnchorFacts,
} from "../../src/core/spec-anchor-audit";

function facts(overrides: Partial<SpecAnchorFacts> = {}): SpecAnchorFacts {
  return {
    exists: () => true,
    lineCount: () => 10_000,
    lastChangedAt: () => undefined,
    ...overrides,
  };
}

describe("extractSpecAnchors", () => {
  it("finds paths with and without line numbers, deduped", () => {
    const anchors = extractSpecAnchors(`
Writer lives at \`scripts/phorest-import-appointments.js:502\` and again
at scripts/phorest-import-appointments.js:502 (same anchor, once).
The DTO is src/dto/appointment.dto.js.
    `);
    expect(anchors.map((a) => a.raw).sort()).toEqual([
      "scripts/phorest-import-appointments.js:502",
      "src/dto/appointment.dto.js",
    ]);
    expect(anchors.find((a) => a.line === 502)?.file).toBe(
      "scripts/phorest-import-appointments.js",
    );
  });

  it("SKIPS fenced code blocks", () => {
    // A spec routinely quotes sample code and command output. Those
    // paths are illustrative, not claims about this repository, and
    // auditing them buries the real drift in noise.
    const anchors = extractSpecAnchors(
      [
        "Real anchor: src/real/thing.ts",
        "```ts",
        "import x from 'src/example/not-real.ts';",
        "```",
        "```",
        "cat some/other/example.js",
        "```",
      ].join("\n"),
    );
    expect(anchors.map((a) => a.raw)).toEqual(["src/real/thing.ts"]);
  });

  it("requires a directory separator, so prose filenames are not anchors", () => {
    // "package.json" and ".env" in a sentence are narrative. A false
    // anchor makes the whole report untrustworthy.
    const anchors = extractSpecAnchors(
      "Update package.json and the .env file, then edit src/a/b.ts.",
    );
    expect(anchors.map((a) => a.raw)).toEqual(["src/a/b.ts"]);
  });

  it("skips review-round sections, whose paths are historical", () => {
    const anchors = extractSpecAnchors(
      [
        "## Files to Modify",
        "- src/current/target.ts",
        "## Round 2 - CROSS-MODEL review",
        "R2-1 pointed at src/old/moved-away.ts",
      ].join("\n"),
    );
    expect(anchors.map((a) => a.raw)).toEqual(["src/current/target.ts"]);
  });
});

describe("hasFilesToModifySection", () => {
  it("detects the section the example gate requires, case and level insensitive", () => {
    expect(hasFilesToModifySection("## Files to Modify\n| f |")).toBe(true);
    expect(hasFilesToModifySection("### files to modify")).toBe(true);
    expect(hasFilesToModifySection("Some prose about files to modify")).toBe(false);
    expect(hasFilesToModifySection("## Problem Statement")).toBe(false);
  });
});

describe("auditSpecAnchors", () => {
  const md = "See src/gone.ts and src/here.ts:9000 and src/fine.ts";

  it("reports a missing file as missing, not as changed", () => {
    // Precedence: the caller needs the strongest TRUE statement. A path
    // that is not there cannot meaningfully also be "changed".
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: md,
      specChangedAt: "2026-01-01T00:00:00Z",
      facts: facts({
        exists: (f) => f !== "src/gone.ts",
        lastChangedAt: () => "2026-06-01T00:00:00Z",
      }),
    });
    const gone = result.rows.find((r) => r.anchor.file === "src/gone.ts");
    expect(gone?.status).toBe("file_missing");
  });

  it("catches a line that no longer exists", () => {
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: md,
      facts: facts({ lineCount: () => 100 }),
    });
    const row = result.rows.find((r) => r.anchor.line === 9000);
    expect(row?.status).toBe("line_out_of_range");
    expect(row?.detail).toContain("100");
  });

  it("flags a file changed AFTER the spec was written", () => {
    // The staleness check Operator asked for: the spec may still describe
    // a file that has since moved on underneath it.
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "See src/fine.ts",
      specChangedAt: "2026-01-01T00:00:00Z",
      facts: facts({ lastChangedAt: () => "2026-06-01T00:00:00Z" }),
    });
    expect(result.rows[0].status).toBe("file_changed_since_spec");
    expect(result.drifted).toBe(true);
  });

  it("does NOT flag a file changed BEFORE the spec", () => {
    // The spec was written with knowledge of that change, so it is not
    // drift. Getting this backwards would mark the entire backlog stale
    // and make the report useless.
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "See src/fine.ts",
      specChangedAt: "2026-06-01T00:00:00Z",
      facts: facts({ lastChangedAt: () => "2026-01-01T00:00:00Z" }),
    });
    expect(result.rows[0].status).toBe("ok");
    expect(result.drifted).toBe(false);
  });

  it("an unparseable timestamp never invents drift", () => {
    // A report that manufactures drift is worse than one that misses
    // some: it destroys trust in every other row.
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "See src/fine.ts",
      specChangedAt: "not a date",
      facts: facts({ lastChangedAt: () => "also not a date" }),
    });
    expect(result.rows[0].status).toBe("ok");
  });

  it("with no spec timestamp, staleness is simply not assessed", () => {
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "See src/fine.ts",
      facts: facts({ lastChangedAt: () => "2099-01-01T00:00:00Z" }),
    });
    expect(result.rows[0].status).toBe("ok");
  });

  it("summarises counts and reports the gate section", () => {
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: `## Files to Modify\n${md}`,
      specChangedAt: "2026-01-01T00:00:00Z",
      facts: facts({
        exists: (f) => f !== "src/gone.ts",
        lineCount: () => 100,
        lastChangedAt: (f) => (f === "src/fine.ts" ? "2026-06-01T00:00:00Z" : undefined),
      }),
    });
    expect(result.hasFilesToModify).toBe(true);
    expect(result.summary).toEqual({
      ok: 0,
      file_missing: 1,
      line_out_of_range: 1,
      file_changed_since_spec: 1,
    });
    expect(result.drifted).toBe(true);
  });

  it("a spec with NO anchors is not drifted, and is honest about it", () => {
    // Most of the 444 will look like this: prose with no code
    // references. Not drifted, but also not evidence of anything, and
    // the empty row list says so rather than implying a clean audit.
    const result = auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "## Problem Statement\nSomething is wrong with the thing.",
      facts: facts(),
    });
    expect(result.rows).toEqual([]);
    expect(result.drifted).toBe(false);
    expect(result.hasFilesToModify).toBe(false);
  });
});

describe("relative anchors resolve against the spec's own directory", () => {
  // Found by running the audit against the REAL 1283-spec backlog, not
  // by thinking about it. Every `../../architecture/decisions/x.md`
  // resolved against the repo ROOT, did not exist there, and was
  // reported `file_missing`. That inflated drift and would have pushed
  // specs into the "a human must re-read this" pile for no reason,
  // which is the number an operator actually plans around.
  const SPEC_DIR = "docs/page-by-page-audit/follow-up-tasks";

  it("resolves ../.. against the spec directory, not the repo root", () => {
    const seen: string[] = [];
    auditSpecAnchors({
      specPath: "TASK-006.md",
      specDir: SPEC_DIR,
      markdown: "See ../../architecture/decisions/002-field-naming.md",
      facts: facts({
        exists: (f) => {
          seen.push(f);
          return true;
        },
      }),
    });
    expect(seen).toEqual(["docs/architecture/decisions/002-field-naming.md"]);
  });

  it("leaves repo-root-relative anchors untouched", () => {
    const seen: string[] = [];
    auditSpecAnchors({
      specPath: "TASK-1.md",
      specDir: SPEC_DIR,
      markdown: "See src/services/thing.ts",
      facts: facts({
        exists: (f) => {
          seen.push(f);
          return true;
        },
      }),
    });
    expect(seen).toEqual(["src/services/thing.ts"]);
  });

  it("refuses to climb above the repo root, reporting honestly instead", () => {
    // A path that escapes the repo is not resolvable here. Leaving it
    // as written makes it report missing honestly, rather than silently
    // resolving to some unrelated file.
    const seen: string[] = [];
    auditSpecAnchors({
      specPath: "TASK-1.md",
      specDir: "docs",
      markdown: "See ../../../outside/the/repo.ts",
      facts: facts({
        exists: (f) => {
          seen.push(f);
          return true;
        },
      }),
    });
    expect(seen).toEqual(["../../../outside/the/repo.ts"]);
  });

  it("without specDir, nothing changes", () => {
    const seen: string[] = [];
    auditSpecAnchors({
      specPath: "TASK-1.md",
      markdown: "See ../../architecture/x.md",
      facts: facts({
        exists: (f) => {
          seen.push(f);
          return true;
        },
      }),
    });
    expect(seen).toEqual(["../../architecture/x.md"]);
  });
});
