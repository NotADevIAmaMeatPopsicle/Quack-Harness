// ─── buildSecretScanInputs integration (TASK-1312 round-2) ──────────
// Quoted diff headers, rename-only content reads, and binary surfacing.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildSecretScanInputs } from "../../src/dispatcher/output-snapshot";
import { resolveTrustedExecutable } from "../../src/worker/trusted-executable";

const TEST_GIT_EXECUTABLE = resolveTrustedExecutable(
  "git",
  path.resolve(__dirname, "..", ".."),
  "test Git",
);

function git(cwd: string, args: string[]): string {
  return execFileSync(TEST_GIT_EXECUTABLE, ["-C", cwd, ...args], {
    cwd: path.dirname(TEST_GIT_EXECUTABLE),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("buildSecretScanInputs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-scan-"));
    git(tmpDir, ["init", "-b", "main"]);
    git(tmpDir, ["config", "user.email", "quack@example.test"]);
    git(tmpDir, ["config", "user.name", "Quack Test"]);
    fs.writeFileSync(path.join(tmpDir, ".baseline"), "baseline\n");
    git(tmpDir, ["add", ".baseline"]);
    git(tmpDir, ["commit", "-m", "baseline"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function commitAll(message: string): string {
    git(tmpDir, ["add", "-A"]);
    git(tmpDir, ["commit", "-m", message]);
    return git(tmpDir, ["rev-parse", "HEAD"]);
  }

  function headSha(): string {
    return git(tmpDir, ["rev-parse", "HEAD"]);
  }

  it.each([39, 41, 63, 65])(
    "rejects a %i-character pseudo object ID instead of treating it as immutable",
    async (length) => {
      await expect(buildSecretScanInputs("", [], tmpDir, "a".repeat(length))).rejects.toThrow(
        "immutable sealed commit identity",
      );
    },
  );

  it.each([40, 64])("accepts an exact %i-character Git object ID", async (length) => {
    await expect(buildSecretScanInputs("", [], tmpDir, "a".repeat(length))).resolves.toMatchObject({
      inputs: [],
      unscannedBinaries: [],
      unscannedSafetyFiles: [],
    });
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

    const result = await buildSecretScanInputs(gitDiff, [], tmpDir, headSha());
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]).toEqual({ file: "src/a.ts", content: "added line one" });
    expect(result.inputs[1].file).toBe("src/sp ace.ts");
    expect(result.inputs[1].content).toBe("quoted added line");
  });

  it("+++ metadata lines are never treated as added content", async () => {
    const gitDiff = ["diff --git a/x.ts b/x.ts", "+++ b/x.ts", "+real"].join("\n");
    const result = await buildSecretScanInputs(gitDiff, [], tmpDir, headSha());
    expect(result.inputs[0].content).toBe("real");
  });

  it("reads full content for rename-only files (no added hunks)", async () => {
    fs.writeFileSync(path.join(tmpDir, "renamed.ts"), "const x = 1;\n");
    const sealedCommitSha = commitAll("add renamed file");
    const result = await buildSecretScanInputs(
      "",
      [{ status: "R100", path: "renamed.ts", previousPath: "old.ts" }],
      tmpDir,
      sealedCommitSha,
    );
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toEqual({ file: "renamed.ts", content: "const x = 1;\n" });
    expect(result.unscannedBinaries).toHaveLength(0);
    expect(result.unscannedSafetyFiles).toHaveLength(0);
  });

  it("surfaces added binary files instead of silently skipping (round-2)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "blob.bin"),
      Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]),
    );
    const sealedCommitSha = commitAll("add binary");
    const result = await buildSecretScanInputs(
      "",
      [{ status: "A", path: "blob.bin" }],
      tmpDir,
      sealedCommitSha,
    );
    expect(result.inputs).toHaveLength(0);
    expect(result.unscannedBinaries).toEqual(["blob.bin"]);
  });

  it("modified-only files are not content-read (added lines cover them)", async () => {
    fs.writeFileSync(path.join(tmpDir, "m.ts"), "content\n");
    const result = await buildSecretScanInputs(
      "",
      [{ status: "M", path: "m.ts" }],
      tmpDir,
      headSha(),
    );
    expect(result.inputs).toHaveLength(0);
  });

  it("fails closed in evidence when an added file cannot be read", async () => {
    const result = await buildSecretScanInputs(
      "",
      [{ status: "A", path: "does-not-exist.ts" }],
      tmpDir,
      headSha(),
    );
    expect(result.inputs).toHaveLength(0);
    expect(result.unscannedSafetyFiles).toEqual([
      { path: "does-not-exist.ts", reason: "unreadable" },
    ]);
  });

  it("fails closed in evidence when a rename-only file exceeds the scan limit", async () => {
    const oversized = path.join(tmpDir, "renamed-large.txt");
    fs.writeFileSync(oversized, "x");
    fs.truncateSync(oversized, 512 * 1024 + 1);
    const sealedCommitSha = commitAll("add oversized rename target");

    const result = await buildSecretScanInputs(
      "",
      [{ status: "R100", path: "renamed-large.txt", previousPath: "old.txt" }],
      tmpDir,
      sealedCommitSha,
    );

    expect(result.inputs).toHaveLength(0);
    expect(result.unscannedSafetyFiles).toEqual([
      { path: "renamed-large.txt", reason: "oversized" },
    ]);
  });

  it("does not follow an added directory link to a file outside the worktree", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quack-scan-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "PRIVATE_SENTINEL\n");
      fs.symlinkSync(
        outside,
        path.join(tmpDir, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const result = await buildSecretScanInputs(
        "",
        [{ status: "A", path: "linked/secret.txt" }],
        tmpDir,
        headSha(),
      );
      expect(result.inputs).toHaveLength(0);
      expect(result.unscannedSafetyFiles).toEqual([
        { path: "linked/secret.txt", reason: "unreadable" },
      ]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read an added hard link to a file outside the worktree", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quack-scan-hardlink-"));
    try {
      const secret = path.join(outside, "secret.txt");
      fs.writeFileSync(secret, "PRIVATE_SENTINEL\n");
      fs.linkSync(secret, path.join(tmpDir, "hardlink.txt"));

      const result = await buildSecretScanInputs(
        "",
        [{ status: "A", path: "hardlink.txt" }],
        tmpDir,
        headSha(),
      );
      expect(result.inputs).toHaveLength(0);
      expect(result.unscannedSafetyFiles).toEqual([{ path: "hardlink.txt", reason: "unreadable" }]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads rename-only content from the sealed commit after a worktree swap", async () => {
    const renamed = path.join(tmpDir, "renamed-secret.txt");
    fs.writeFileSync(renamed, "ANTHROPIC_API_KEY=sealed-secret\n");
    const sealedCommitSha = commitAll("seal renamed secret");
    fs.writeFileSync(renamed, "benign worktree replacement\n");

    const result = await buildSecretScanInputs(
      "",
      [{ status: "R100", path: "renamed-secret.txt", previousPath: "old-secret.txt" }],
      tmpDir,
      sealedCommitSha,
    );

    expect(result.inputs).toEqual([
      { file: "renamed-secret.txt", content: "ANTHROPIC_API_KEY=sealed-secret\n" },
    ]);
  });
});
