import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { readContainedRegularFile } from "../../src/dispatcher/safe-semantic-file-reader.js";

describe("safe semantic file reader", () => {
  let fixtureRoot: string;
  let worktree: string;
  let outside: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "quack-semantic-read-"));
    worktree = path.join(fixtureRoot, "worktree");
    outside = path.join(fixtureRoot, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("reads only the requested bounded bytes of a regular worktree file", async () => {
    const candidate = path.join(worktree, "safe.txt");
    writeFileSync(candidate, "abcdefghij", "utf8");
    const mutableFsPromises = jest.requireActual<typeof import("node:fs")>("node:fs").promises;
    const lstatSpy = jest.spyOn(mutableFsPromises, "lstat");

    try {
      await expect(readContainedRegularFile(worktree, "safe.txt", 4)).resolves.toBe("abcd");
      expect(lstatSpy).toHaveBeenCalledWith(candidate, { bigint: true });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("continues reading after short FileHandle reads", async () => {
    writeFileSync(path.join(worktree, "short-read.txt"), "abcdefghij", "utf8");
    const mutableFsPromises = jest.requireActual<typeof import("node:fs")>("node:fs").promises;
    const realOpen = mutableFsPromises.open.bind(mutableFsPromises);
    const openSpy = jest.spyOn(mutableFsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      return {
        read: (buffer: Buffer, offset: number, length: number, position: number) =>
          handle.read(buffer, offset, Math.min(length, 2), position),
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
      } as Awaited<ReturnType<typeof mutableFsPromises.open>>;
    });

    try {
      await expect(readContainedRegularFile(worktree, "short-read.txt", 10)).resolves.toBe(
        "abcdefghij",
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects an in-place same-size mutation during the read", async () => {
    const candidate = path.join(worktree, "mutated.txt");
    writeFileSync(candidate, "abcdefghij", "utf8");
    const originalMetadata = statSync(candidate);
    const mutableFsPromises = jest.requireActual<typeof import("node:fs")>("node:fs").promises;
    const realOpen = mutableFsPromises.open.bind(mutableFsPromises);
    let mutated = false;
    const openSpy = jest.spyOn(mutableFsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await handle.read(buffer, offset, length, position);
          if (!mutated) {
            mutated = true;
            writeFileSync(candidate, "ABCDEFGHIJ", "utf8");
            utimesSync(candidate, originalMetadata.atime, originalMetadata.mtime);
          }
          return result;
        },
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
      } as Awaited<ReturnType<typeof mutableFsPromises.open>>;
    });

    try {
      await expect(readContainedRegularFile(worktree, "mutated.txt", 10)).rejects.toThrow(
        "changed during secure read",
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects lexical traversal outside the worktree", async () => {
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");

    await expect(readContainedRegularFile(worktree, "../outside/secret.txt", 1024)).rejects.toThrow(
      "escapes the worktree",
    );
  });

  it("rejects an ancestor directory link into an external location", async () => {
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(
      outside,
      path.join(worktree, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(readContainedRegularFile(worktree, "linked/secret.txt", 1024)).rejects.toThrow(
      "symbolic link",
    );
  });

  it("rejects a hard link to content outside the worktree", async () => {
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "secret", "utf8");
    linkSync(secret, path.join(worktree, "hardlink.txt"));

    await expect(readContainedRegularFile(worktree, "hardlink.txt", 1024)).rejects.toThrow(
      "unlinked regular file",
    );
  });
});
