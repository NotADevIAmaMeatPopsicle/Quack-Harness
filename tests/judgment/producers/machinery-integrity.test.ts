// ─── Machinery integrity tests (TASK-1313) ──────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkMachineryIntegrity,
  isTierSPath,
  readAuthoritativeSafetyFloor,
  resolveAuthoritativeRoot,
  restoreMachineryFile,
} from "../../../src/judgment/producers/machinery-integrity";

describe("machinery integrity", () => {
  let authoritative: string;
  let worktree: string;

  const write = (root: string, rel: string, content: string): void => {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  beforeEach(() => {
    authoritative = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auth-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "quack-wt-"));
    for (const root of [authoritative, worktree]) {
      write(root, ".quack/adapter.json", '{"version":"1.0"}');
      write(root, ".quack/conventions.md", "conventions");
    }
  });

  afterEach(() => {
    fs.rmSync(authoritative, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("clean when Tier-S files match", async () => {
    const result = await checkMachineryIntegrity(worktree, authoritative);
    expect(result.clean).toBe(true);
    expect(result.selfCompare).toBe(false);
  });

  it("self-compare is a structural no-op", async () => {
    const result = await checkMachineryIntegrity(authoritative, authoritative);
    expect(result).toEqual({ clean: true, selfCompare: true, mismatches: [] });
  });

  it("detects a hash mismatch", async () => {
    write(worktree, ".quack/adapter.json", '{"version":"tampered"}');
    const result = await checkMachineryIntegrity(worktree, authoritative);
    expect(result.clean).toBe(false);
    expect(result.mismatches).toEqual([{ path: ".quack/adapter.json", reason: "hash_mismatch" }]);
  });

  it("detects a worktree-only machinery file (the bash-write tamper)", async () => {
    write(worktree, ".quack/verify.js", "process.exit(0);");
    const result = await checkMachineryIntegrity(worktree, authoritative);
    expect(result.mismatches).toEqual([{ path: ".quack/verify.js", reason: "worktree_only" }]);
  });

  it("detects an authoritative-only file (worktree deletion)", async () => {
    fs.rmSync(path.join(worktree, ".quack/conventions.md"));
    const result = await checkMachineryIntegrity(worktree, authoritative);
    expect(result.mismatches).toEqual([
      { path: ".quack/conventions.md", reason: "authoritative_only" },
    ]);
  });

  it("covers Tier-S prefix directories", async () => {
    write(worktree, ".quack/convention-checks/x.js", "tampered");
    write(authoritative, ".quack/convention-checks/x.js", "original");
    const result = await checkMachineryIntegrity(worktree, authoritative);
    expect(result.mismatches).toEqual([
      { path: ".quack/convention-checks/x.js", reason: "hash_mismatch" },
    ]);
  });

  describe("restoreMachineryFile", () => {
    it("restores the authoritative version over a tamper", async () => {
      write(worktree, ".quack/adapter.json", "tampered");
      const result = await restoreMachineryFile(worktree, authoritative, ".quack/adapter.json");
      expect(result.restored).toBe(true);
      expect(fs.readFileSync(path.join(worktree, ".quack/adapter.json"), "utf-8")).toBe(
        '{"version":"1.0"}',
      );
    });

    it("removes a worktree-only file when the authoritative copy is absent", async () => {
      write(worktree, ".quack/verify.js", "planted");
      const result = await restoreMachineryFile(worktree, authoritative, ".quack/verify.js");
      expect(result.restored).toBe(true);
      expect(fs.existsSync(path.join(worktree, ".quack/verify.js"))).toBe(false);
    });

    it("refuses non-Tier-S paths and traversal", async () => {
      expect((await restoreMachineryFile(worktree, authoritative, "src/app.ts")).restored).toBe(
        false,
      );
      expect((await restoreMachineryFile(worktree, authoritative, "../outside.txt")).restored).toBe(
        false,
      );
    });
  });

  describe("resolveAuthoritativeRoot", () => {
    it("strips .quack/worktrees/<name>", () => {
      const wt = path.join("C:", "proj", ".quack", "worktrees", "TASK-9");
      expect(resolveAuthoritativeRoot(wt)).toBe(path.resolve(path.join("C:", "proj")));
    });

    it("returns ordinary roots unchanged", () => {
      expect(resolveAuthoritativeRoot(authoritative)).toBe(path.resolve(authoritative));
    });
  });

  describe("readAuthoritativeSafetyFloor", () => {
    it("absent config resolves to all off", async () => {
      const modes = await readAuthoritativeSafetyFloor(authoritative);
      expect(modes).toEqual({
        signalsMode: "off",
        preVerificationIntegrityMode: "off",
        resumeValidationMode: "off",
      });
    });

    it("reads configured modes from the authoritative adapter", async () => {
      write(
        authoritative,
        ".quack/adapter.json",
        JSON.stringify({
          judgment: {
            safetyFloor: {
              signals: { mode: "enforce" },
              preVerificationIntegrity: { mode: "warn" },
            },
          },
        }),
      );
      const modes = await readAuthoritativeSafetyFloor(authoritative);
      expect(modes.signalsMode).toBe("enforce");
      expect(modes.preVerificationIntegrityMode).toBe("warn");
      expect(modes.resumeValidationMode).toBe("off");
    });

    it("invalid config fails conservative to off", async () => {
      write(
        authoritative,
        ".quack/adapter.json",
        JSON.stringify({ judgment: { safetyFloor: { signals: { mode: "bogus" } } } }),
      );
      const modes = await readAuthoritativeSafetyFloor(authoritative);
      expect(modes.signalsMode).toBe("off");
    });
  });

  it("isTierSPath matches exact files and prefixes only", () => {
    expect(isTierSPath(".quack/verify.js")).toBe(true);
    expect(isTierSPath(".quack\\templates\\pr.md")).toBe(true);
    expect(isTierSPath("src/index.ts")).toBe(false);
    expect(isTierSPath(".quack/logs/x.jsonl")).toBe(false);
  });

  describe("restoreMachineryFile symlink safety (round-2 F3)", () => {
    it("refuses a directory-symlink parent chain and never writes outside the worktree", async () => {
      // The linked worktree's .quack is a junction pointing OUTSIDE:
      // a restore through it would land in the outside directory.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quack-outside-"));
      const victim = path.join(outside, "conventions.md");
      fs.writeFileSync(victim, "outside content");
      const linkedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "quack-wtlink-"));
      fs.symlinkSync(outside, path.join(linkedWorktree, ".quack"), "junction");
      try {
        const result = await restoreMachineryFile(
          linkedWorktree,
          authoritative,
          ".quack/conventions.md",
        );
        expect(result.restored).toBe(false);
        expect(result.reason).toContain("symlink");
        expect(fs.readFileSync(victim, "utf-8")).toBe("outside content");
      } finally {
        fs.rmSync(linkedWorktree, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses a file-symlink target (assertion runs where the host can create file symlinks)", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quack-outside-"));
      const victim = path.join(outside, "victim.md");
      fs.writeFileSync(victim, "outside content");
      const linkPath = path.join(worktree, ".quack", "judge-criteria.md");
      let linked = true;
      try {
        fs.symlinkSync(victim, linkPath, "file");
      } catch {
        // Windows without Developer Mode cannot create file symlinks;
        // the junction case above still exercises the guard class.
        linked = false;
      }
      try {
        if (linked) {
          const result = await restoreMachineryFile(
            worktree,
            authoritative,
            ".quack/judge-criteria.md",
          );
          expect(result.restored).toBe(false);
          expect(result.reason).toContain("symlink");
          expect(fs.readFileSync(victim, "utf-8")).toBe("outside content");
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
