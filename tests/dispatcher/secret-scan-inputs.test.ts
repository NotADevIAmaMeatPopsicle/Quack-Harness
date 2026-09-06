// ─── buildSecretScanInputs integration (TASK-1312 round-2) ──────────
// Quoted diff headers, rename-only content reads, and binary surfacing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildSecretScanInputs } from "../../src/dispatcher/output-snapshot";

describe("buildSecretScanInputs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses plain and quoted diff --git headers into per-file added lines", async () => {
    const gitDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "+added line one",
      " diff context noise",
      'diff --git "a/src/sp ace.ts" "b/src/sp ace.ts"',
      '--- "a/src/sp ace.ts"',
      '+++ "b/src/sp ace.ts"',
      "@@ -0,0 +1 @@",
      "+quoted added line",
    ].join("\n");

    const result = await buildSecretScanInputs(gitDiff, [], tmpDir);
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]).toEqual({ file: "src/a.ts", content: "added line one" });
    expect(result.inputs[1].file).toBe("src/sp ace.ts");
    expect(result.inputs[1].content).toBe("quoted added line");
  });

  it("+++ metadata lines are never treated as added content", async () => {
    const gitDiff = ["diff --git a/x.ts b/x.ts", "+++ b/x.ts", "+real"].join("\n");
    const result = await buildSecretScanInputs(gitDiff, [], tmpDir);
    expect(result.inputs[0].content).toBe("real");
  });

  it("reads full content for rename-only files (no added hunks)", async () => {
    fs.writeFileSync(path.join(tmpDir, "renamed.ts"), "const x = 1;\n");
    const result = await buildSecretScanInputs(
      "",
      [{ status: "R100", path: "renamed.ts", previousPath: "old.ts" }],
      tmpDir,
    );
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toEqual({ file: "renamed.ts", content: "const x = 1;\n" });
    expect(result.unscannedBinaries).toHaveLength(0);
  });

  it("surfaces added binary files instead of silently skipping (round-2)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "blob.bin"),
      Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]),
    );
    const result = await buildSecretScanInputs("", [{ status: "A", path: "blob.bin" }], tmpDir);
    expect(result.inputs).toHaveLength(0);
    expect(result.unscannedBinaries).toEqual(["blob.bin"]);
  });

  it("modified-only files are not content-read (added lines cover them)", async () => {
    fs.writeFileSync(path.join(tmpDir, "m.ts"), "content\n");
    const result = await buildSecretScanInputs("", [{ status: "M", path: "m.ts" }], tmpDir);
    expect(result.inputs).toHaveLength(0);
  });

  it("unreadable files never throw", async () => {
    const result = await buildSecretScanInputs(
      "",
      [{ status: "A", path: "does-not-exist.ts" }],
      tmpDir,
    );
    expect(result.inputs).toHaveLength(0);
  });
});
