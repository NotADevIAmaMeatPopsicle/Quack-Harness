import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function syncDirectoryDurably(directory: string): void {
  if (process.platform === "win32") {
    throw new Error("Directory fsync is not a supported Windows namespace durability contract");
  }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const WINDOWS_MOVE_WRITE_THROUGH = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class QuackDurableMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileExW(string existingName, string newName, uint flags);
  public static void Move(string source, string target, bool replace) {
    const uint MOVEFILE_REPLACE_EXISTING = 0x1;
    const uint MOVEFILE_WRITE_THROUGH = 0x8;
    uint flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
    if (!MoveFileExW(source, target, flags)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
$source = [Environment]::GetEnvironmentVariable('QUACK_DURABLE_SOURCE', 'Process')
$target = [Environment]::GetEnvironmentVariable('QUACK_DURABLE_TARGET', 'Process')
$replace = [Environment]::GetEnvironmentVariable('QUACK_DURABLE_REPLACE', 'Process') -eq '1'
[QuackDurableMove]::Move($source, $target, $replace)
`;

export function trustedWindowsPowerShellPath(): string {
  const configuredRoot = process.env.SystemRoot;
  if (!configuredRoot || !path.win32.isAbsolute(configuredRoot)) {
    throw new Error("SystemRoot is unavailable for the durable Windows namespace operation");
  }
  const systemRoot = fs.realpathSync.native(configuredRoot);
  const candidate = fs.realpathSync.native(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const relative = path.win32.relative(systemRoot, candidate);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.win32.isAbsolute(relative) ||
    !fs.lstatSync(candidate).isFile()
  ) {
    throw new Error("Windows PowerShell did not resolve beneath the validated SystemRoot");
  }
  return candidate;
}

/** Windows uses MoveFileExW(MOVEFILE_WRITE_THROUGH), not directory fsync. */
function moveWindowsWriteThrough(source: string, target: string, replace: boolean): void {
  try {
    execFileSync(
      trustedWindowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_MOVE_WRITE_THROUGH],
      {
        env: {
          ...process.env,
          QUACK_DURABLE_SOURCE: source,
          QUACK_DURABLE_TARGET: target,
          QUACK_DURABLE_REPLACE: replace ? "1" : "0",
        },
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        stdio: "pipe",
      },
    );
  } catch (error: unknown) {
    if (!replace && fs.existsSync(target)) {
      if (typeof error === "object" && error !== null) {
        Object.assign(error, { code: "EEXIST" });
      }
    }
    throw error;
  }
}

export function ensureDirectoryDurably(directory: string): void {
  const missing: string[] = [];
  let cursor = directory;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (process.platform === "win32") {
    for (const created of missing.reverse()) {
      const parent = path.dirname(created);
      const temporary = path.join(
        parent,
        `.${path.basename(created)}.${process.pid}.${randomUUID()}.tmp-dir`,
      );
      fs.mkdirSync(temporary);
      try {
        moveWindowsWriteThrough(temporary, created, false);
      } catch (error: unknown) {
        if (!fs.existsSync(created)) throw error;
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const created of missing.reverse()) {
    syncDirectoryDurably(path.dirname(created));
  }
}

export function syncFileDurably(filePath: string): void {
  // Windows requires a writable handle for FlushFileBuffers; O_RDONLY can
  // surface EPERM even for a regular writable file.
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Durable JSON installation has an untrusted file identity");
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function removeFileDurably(filePath: string): void {
  const directory = path.dirname(filePath);
  if (process.platform === "win32") {
    const tombstone = `${filePath}.${process.pid}.${randomUUID()}.deleted`;
    moveWindowsWriteThrough(filePath, tombstone, false);
    // The durable rename removed the live name. A crash may retain only this
    // ignored tombstone; its later physical deletion is intentionally best effort.
    try {
      fs.rmSync(tombstone, { force: true });
    } catch {
      // The live name is already durably absent; ignored tombstone cleanup is
      // opportunistic and safe to retry later.
    }
    return;
  }
  fs.rmSync(filePath);
  syncDirectoryDurably(directory);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  // Only an OS-provided file identity proves the sibling is the other name
  // for this exact inode. Metadata equality is not strong enough to unlink.
  return (
    left.dev !== 0 &&
    left.ino !== 0 &&
    right.dev !== 0 &&
    right.ino !== 0 &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/** Install an already-written, fsynced sibling without replacing a winner. */
export function installDurableJsonTempNoReplace(temporary: string, filePath: string): void {
  const directory = path.dirname(filePath);
  if (path.dirname(temporary) !== directory) {
    throw new Error("Durable JSON temporary file must share the target directory");
  }
  const temporaryStat = fs.lstatSync(temporary);
  if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== 1) {
    throw new Error("Durable JSON temporary file has an untrusted identity");
  }
  syncFileDurably(temporary);
  if (process.platform === "win32") {
    moveWindowsWriteThrough(temporary, filePath, false);
    const installed = fs.lstatSync(filePath);
    if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1) {
      throw new Error("Durable JSON installation has an untrusted final identity");
    }
    return;
  }
  syncDirectoryDurably(directory);
  fs.linkSync(temporary, filePath);
  syncDirectoryDurably(directory);
  const installedStat = fs.lstatSync(filePath);
  const currentTemporaryStat = fs.lstatSync(temporary);
  if (!sameFileIdentity(installedStat, currentTemporaryStat)) {
    // linkSync created this name because installation is no-replace. Remove
    // only that name if the source identity changed before confirmation.
    fs.rmSync(filePath);
    syncDirectoryDurably(directory);
    throw new Error("Durable JSON temporary file changed during installation");
  }
  // A recovering reader can unlink this exact sibling after linkSync but
  // before this invocation reaches cleanup. Absence is idempotent.
  fs.rmSync(temporary, { force: true });
  syncFileDurably(filePath);
  syncDirectoryDurably(directory);
}

export function replaceDurableJsonFromTemp(temporary: string, filePath: string): void {
  const directory = path.dirname(filePath);
  if (path.dirname(temporary) !== directory) {
    throw new Error("Durable JSON temporary file must share the target directory");
  }
  const temporaryStat = fs.lstatSync(temporary);
  if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== 1) {
    throw new Error("Durable JSON temporary file has an untrusted identity");
  }
  syncFileDurably(temporary);
  if (process.platform === "win32") {
    moveWindowsWriteThrough(temporary, filePath, true);
    return;
  }
  syncDirectoryDurably(directory);
  fs.renameSync(temporary, filePath);
  syncFileDurably(filePath);
  syncDirectoryDurably(directory);
}

/**
 * Heal the only crash residue produced by atomic hard-link installation:
 * the final name and its unique sibling temp still reference the same inode.
 */
export function reconcileDurableJsonInstall(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const installed = fs.lstatSync(filePath);
  if (!installed.isFile() || installed.isSymbolicLink()) {
    throw new Error("Durable JSON installation has an untrusted file identity");
  }
  if (installed.nlink === 1) {
    // A process may have died after unlinking the install temp but before the
    // namespace barrier. Re-establish both barriers before admitting the file.
    syncFileDurably(filePath);
    if (process.platform !== "win32") syncDirectoryDurably(path.dirname(filePath));
    return;
  }
  if (installed.nlink !== 2) {
    throw new Error("Durable JSON installation has an unexpected link count");
  }
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const siblings = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .map((name) => path.join(directory, name))
    .filter((candidate) => {
      try {
        const stat = fs.lstatSync(candidate);
        return stat.isFile() && !stat.isSymbolicLink() && sameFileIdentity(installed, stat);
      } catch {
        return false;
      }
    });
  if (siblings.length !== 1) {
    throw new Error("Durable JSON installation cannot reconcile its temporary link");
  }
  if (process.platform === "win32") {
    const content = fs.readFileSync(filePath);
    writeBufferAtomicDurable(filePath, content, false);
    removeFileDurably(siblings[0]);
  } else {
    fs.rmSync(siblings[0]);
  }
  const reconciled = fs.lstatSync(filePath);
  if (!reconciled.isFile() || reconciled.isSymbolicLink() || reconciled.nlink !== 1) {
    throw new Error("Durable JSON installation did not reconcile to one trusted link");
  }
  syncFileDurably(filePath);
  if (process.platform !== "win32") syncDirectoryDurably(directory);
}

function writeBufferAtomicDurable(filePath: string, content: Buffer, exclusive = false): void {
  const directory = path.dirname(filePath);
  ensureDirectoryDurably(directory);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_SYNC,
    );
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (exclusive) {
      installDurableJsonTempNoReplace(temporary, filePath);
    } else {
      replaceDurableJsonFromTemp(temporary, filePath);
    }
  } catch (error: unknown) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(temporary)) removeFileDurably(temporary);
    } catch {
      // Preserve the write/install/durability failure.
    }
    throw error;
  }
}

export function writeJsonAtomicDurable(filePath: string, value: unknown, exclusive = false): void {
  writeBufferAtomicDurable(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8"),
    exclusive,
  );
}
