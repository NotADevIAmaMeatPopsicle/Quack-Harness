import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";

function comparablePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(
  left: { size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return (
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  );
}

function checkedSizeNumber(size: bigint, filePath: string): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Modified file size is not safely representable: ${filePath}`);
  }
  return Number(size);
}

async function readExact(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) throw new Error("unexpected EOF");
    offset += bytesRead;
  }
}

/**
 * Read a bounded regular file without following worker-created links outside
 * the worktree. The pre/open/post identity checks also reject hard links and
 * path replacement during the read setup.
 */
export interface ContainedRegularFileRead {
  content: Buffer;
  size: number;
}

export async function readContainedRegularFileBuffer(
  worktreeRoot: string,
  gitRelativePath: string,
  maxBytes: number,
): Promise<ContainedRegularFileRead> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    gitRelativePath.includes("\0") ||
    path.isAbsolute(gitRelativePath)
  ) {
    throw new Error("Unsafe semantic file read request");
  }

  const canonicalRoot = await fs.realpath(path.resolve(worktreeRoot));
  const candidate = path.resolve(canonicalRoot, gitRelativePath);
  if (!isContainedPath(canonicalRoot, candidate) || candidate === canonicalRoot) {
    throw new Error(`Modified file escapes the worktree: ${gitRelativePath}`);
  }

  const relative = path.relative(canonicalRoot, candidate);
  const components = relative.split(path.sep).filter(Boolean);
  let cursor = canonicalRoot;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    const entry = await fs.lstat(cursor, { bigint: true });
    if (entry.isSymbolicLink()) {
      throw new Error(`Modified file traverses a symbolic link: ${gitRelativePath}`);
    }
    if (index < components.length - 1 && !entry.isDirectory()) {
      throw new Error(`Modified file parent is not a directory: ${gitRelativePath}`);
    }
  }

  const before = await fs.lstat(candidate, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error(`Modified path is not an unlinked regular file: ${gitRelativePath}`);
  }
  const beforeRealPath = await fs.realpath(candidate);
  if (
    !isContainedPath(canonicalRoot, beforeRealPath) ||
    comparablePath(beforeRealPath) !== comparablePath(candidate)
  ) {
    throw new Error(`Modified file resolves outside the worktree: ${gitRelativePath}`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(candidate, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await fs.lstat(candidate, { bigint: true });
    const afterRealPath = await fs.realpath(candidate);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !after.isFile() ||
      after.nlink !== 1n ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, after) ||
      !sameFileVersion(before, opened) ||
      !sameFileVersion(opened, after) ||
      comparablePath(beforeRealPath) !== comparablePath(afterRealPath) ||
      !isContainedPath(canonicalRoot, afterRealPath)
    ) {
      throw new Error(`Modified file changed during secure open: ${gitRelativePath}`);
    }

    const openedSize = checkedSizeNumber(opened.size, gitRelativePath);
    const buffer = Buffer.alloc(Math.min(maxBytes, openedSize));

    // FileHandle.read() is allowed to short-read even for regular files. Keep
    // reading until the requested bounded prefix is complete; otherwise a
    // security scanner could incorrectly treat an arbitrary prefix as the
    // whole file and miss material near the end.
    try {
      await readExact(handle, buffer);
    } catch {
      throw new Error(`Modified file changed during secure read: ${gitRelativePath}`);
    }

    // Re-read the same bounded bytes through the already-attested descriptor.
    // This detects in-place, same-inode/same-size mutations that identity and
    // size checks alone cannot distinguish.
    const verification = Buffer.alloc(buffer.length);
    try {
      await readExact(handle, verification);
    } catch {
      throw new Error(`Modified file changed during secure read: ${gitRelativePath}`);
    }
    if (!buffer.equals(verification)) {
      throw new Error(`Modified file changed during secure read: ${gitRelativePath}`);
    }

    const finalOpened = await handle.stat({ bigint: true });
    const finalPath = await fs.lstat(candidate, { bigint: true });
    if (
      !sameFileIdentity(opened, finalOpened) ||
      !sameFileIdentity(finalOpened, finalPath) ||
      !sameFileVersion(opened, finalOpened) ||
      !sameFileVersion(finalOpened, finalPath)
    ) {
      throw new Error(`Modified file changed during secure read: ${gitRelativePath}`);
    }
    return { content: buffer, size: openedSize };
  } finally {
    await handle.close();
  }
}

export async function readContainedRegularFile(
  worktreeRoot: string,
  gitRelativePath: string,
  maxBytes: number,
): Promise<string> {
  const result = await readContainedRegularFileBuffer(worktreeRoot, gitRelativePath, maxBytes);
  return result.content.toString("utf8");
}
