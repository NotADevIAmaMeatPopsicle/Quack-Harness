import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function decompositionTemporaryPath(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.quack-decompose-tmp`);
}

export function decompositionReplacementBackupPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.quack-decompose-backup`,
  );
}

const REPLACEMENT_BACKUP_SUFFIX = ".quack-decompose-backup";
const REPLACEMENT_TEMP_MARKER = ".quack-decompose-tmp";

function uniqueDecompositionTemporaryPath(destination: string): string {
  return `${decompositionTemporaryPath(destination)}-${process.pid}-${randomUUID()}`;
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export async function assertSafeDecompositionTaskDirectory(
  projectRoot: string,
  taskDir: string,
): Promise<void> {
  const [realProjectRoot, realTaskDir, taskDirectoryStat] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(taskDir),
    fs.stat(taskDir),
  ]);
  if (!taskDirectoryStat.isDirectory() || !isPathContainedBy(realProjectRoot, realTaskDir)) {
    throw new Error("the task directory is not a real directory inside the project root");
  }
}

async function flushDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDurableTemporaryFile(
  destination: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const temporaryPath = uniqueDecompositionTemporaryPath(destination);
  let handle: fs.FileHandle | undefined;
  let created = false;
  let complete = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    complete = true;
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await handle?.close();
  } catch (error) {
    cleanupError = error;
  }
  if (created && !complete) {
    try {
      await unlinkDecompositionFileWithRetry(temporaryPath);
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], "Temporary file cleanup failed")
        : error;
    }
  }
  if (cleanupError) {
    if (operationFailed && typeof operationError === "object" && operationError !== null) {
      Object.defineProperty(operationError, "temporaryCleanupError", {
        value: cleanupError,
        configurable: true,
        enumerable: true,
      });
    } else if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Temporary file creation and cleanup both failed",
        { cause: operationError },
      );
    } else {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Temporary file cleanup failed with a non-Error value.");
    }
  }
  if (operationFailed) throw operationError;
  return temporaryPath;
}

async function syncPublishedFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeClaimedFile(
  filePath: string,
  expected: { dev: bigint; ino: bigint; bytes: Buffer },
  label: string,
): Promise<void> {
  const quarantinePath =
    filePath.includes(REPLACEMENT_TEMP_MARKER) || filePath.includes(REPLACEMENT_BACKUP_SUFFIX)
      ? `${filePath}.cleanup-${process.pid}-${randomUUID()}`
      : `${uniqueDecompositionTemporaryPath(filePath)}.cleanup-${process.pid}-${randomUUID()}`;
  await fs.rename(filePath, quarantinePath);
  await flushDirectory(path.dirname(filePath));
  const claimedStat = await fs.lstat(quarantinePath, { bigint: true });
  const claimedBytes = await fs.readFile(quarantinePath);
  if (
    claimedStat.isSymbolicLink() ||
    !claimedStat.isFile() ||
    claimedStat.nlink !== 1n ||
    claimedStat.dev !== expected.dev ||
    claimedStat.ino !== expected.ino ||
    !claimedBytes.equals(expected.bytes)
  ) {
    try {
      await fs.link(quarantinePath, filePath);
      await unlinkDecompositionFileWithRetry(quarantinePath);
      await flushDirectory(path.dirname(filePath));
    } catch (restoreError) {
      throw new Error(
        `${label} changed during cleanup and could not be restored: ${filePath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
    throw new Error(`${label} changed during identity-bound cleanup: ${filePath}`);
  }
  await unlinkDecompositionFileWithRetry(quarantinePath);
  await flushDirectory(path.dirname(filePath));
}

export async function removeDecompositionFileIfExact(
  filePath: string,
  expectedContent: string | Buffer,
): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const bytes = Buffer.isBuffer(expectedContent)
    ? expectedContent
    : Buffer.from(expectedContent, "utf-8");
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    !(await fs.readFile(filePath)).equals(bytes)
  ) {
    throw new Error(`Refusing to remove a changed decomposition file: ${filePath}`);
  }
  await removeClaimedFile(filePath, { dev: stat.dev, ino: stat.ino, bytes }, "Decomposition file");
  return true;
}

async function removeClaimedRecoveryLink(
  filePath: string,
  siblingPath: string,
  expected: { dev: bigint; ino: bigint; bytes: Buffer },
): Promise<void> {
  const quarantinePath =
    filePath.includes(REPLACEMENT_TEMP_MARKER) || filePath.includes(REPLACEMENT_BACKUP_SUFFIX)
      ? `${filePath}.cleanup-${process.pid}-${randomUUID()}`
      : `${uniqueDecompositionTemporaryPath(filePath)}.cleanup-${process.pid}-${randomUUID()}`;
  await fs.rename(filePath, quarantinePath);
  await flushDirectory(path.dirname(filePath));
  const [claimedStat, siblingStat, claimedBytes] = await Promise.all([
    fs.lstat(quarantinePath, { bigint: true }),
    fs.lstat(siblingPath, { bigint: true }),
    fs.readFile(quarantinePath),
  ]);
  if (
    claimedStat.isSymbolicLink() ||
    !claimedStat.isFile() ||
    claimedStat.nlink !== 2n ||
    claimedStat.dev !== expected.dev ||
    claimedStat.ino !== expected.ino ||
    siblingStat.dev !== expected.dev ||
    siblingStat.ino !== expected.ino ||
    !claimedBytes.equals(expected.bytes)
  ) {
    try {
      await fs.link(quarantinePath, filePath);
      await unlinkDecompositionFileWithRetry(quarantinePath);
      await flushDirectory(path.dirname(filePath));
    } catch (restoreError) {
      throw new Error(
        `Decomposition recovery link changed and could not be restored: ${filePath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
    throw new Error(`Decomposition recovery link changed during cleanup: ${filePath}`);
  }
  await unlinkDecompositionFileWithRetry(quarantinePath);
  await flushDirectory(path.dirname(filePath));
}

async function listReplacementTemporaryPaths(destination: string): Promise<string[]> {
  const directory = path.dirname(destination);
  const baseName = path.basename(decompositionTemporaryPath(destination));
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(
      (name) =>
        name === baseName ||
        (name.startsWith(`${baseName}-`) &&
          /^\d+-[0-9a-f-]{36}(?:\.cleanup-\d+-[0-9a-f-]{36})*$/.test(
            name.slice(baseName.length + 1),
          )) ||
        (name.startsWith(`${baseName}.cleanup-`) &&
          /^(?:\.cleanup-\d+-[0-9a-f-]{36})+$/.test(name.slice(baseName.length))),
    )
    .map((name) => path.join(directory, name));
}

export async function listDecompositionReplacementBackupPaths(
  destination: string,
): Promise<string[]> {
  const backupPath = decompositionReplacementBackupPath(destination);
  const directory = path.dirname(backupPath);
  const baseName = path.basename(backupPath);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(
      (name) =>
        name === baseName ||
        (name.startsWith(`${baseName}.cleanup-`) &&
          /^(?:\.cleanup-\d+-[0-9a-f-]{36})+$/.test(name.slice(baseName.length))),
    )
    .sort()
    .map((name) => path.join(directory, name));
}

/**
 * Reconcile the self-describing artifacts left by an interrupted atomic
 * replacement. A hard-linked backup means publication had not happened; a
 * single-link backup beside a different complete destination means the
 * atomic rename completed. No target content has to be guessed.
 */
export async function recoverDecompositionReplacementArtifacts(
  destination: string,
  expected?: { original: Buffer; target: Buffer },
): Promise<void> {
  for (const temporaryPath of await listReplacementTemporaryPaths(destination)) {
    const temporary = await fs.lstat(temporaryPath, { bigint: true });
    if (temporary.isSymbolicLink() || !temporary.isFile()) {
      throw new Error(`Unsafe decomposition replacement temporary file: ${temporaryPath}`);
    }
    const bytes = await fs.readFile(temporaryPath);
    if (expected) {
      const temporaryHash = createHash("sha256").update(bytes).digest("hex");
      const targetHash = createHash("sha256").update(expected.target).digest("hex");
      if (temporaryHash !== targetHash) {
        throw new Error(
          `Replacement temporary bytes diverged for ${destination}; recovery evidence retained.`,
        );
      }
    }
    if (temporary.nlink === 1n) {
      if (!expected) {
        // A unique, unpublished temporary cannot affect the canonical
        // namespace and is not sufficiently authenticated to delete. Leave it
        // as operator evidence; future writes use a fresh random name.
        continue;
      }
      await removeClaimedFile(
        temporaryPath,
        { dev: temporary.dev, ino: temporary.ino, bytes },
        "Decomposition replacement temporary file",
      );
      continue;
    }
    let destinationStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      destinationStat = await fs.lstat(destination, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!destinationStat && temporary.nlink === 2n) {
      const matchingBackups: string[] = [];
      for (const backupPath of await listDecompositionReplacementBackupPaths(destination)) {
        const backup = await fs.lstat(backupPath, { bigint: true });
        if (backup.dev === temporary.dev && backup.ino === temporary.ino) {
          matchingBackups.push(backupPath);
        }
      }
      if (matchingBackups.length !== 1) {
        throw new Error(
          `Replacement cleanup link has no unique backup peer for ${destination}; recovery evidence retained.`,
        );
      }
      await removeClaimedRecoveryLink(temporaryPath, matchingBackups[0], {
        dev: temporary.dev,
        ino: temporary.ino,
        bytes,
      });
      continue;
    }
    if (
      temporary.nlink !== 2n ||
      !destinationStat ||
      destinationStat.dev !== temporary.dev ||
      destinationStat.ino !== temporary.ino
    ) {
      throw new Error(
        `Replacement temporary link identity diverged for ${destination}; recovery evidence retained.`,
      );
    }
    await removeClaimedRecoveryLink(temporaryPath, destination, {
      dev: temporary.dev,
      ino: temporary.ino,
      bytes,
    });
  }

  const backupPaths = await listDecompositionReplacementBackupPaths(destination);
  if (backupPaths.length > 1) {
    throw new Error(`Ambiguous decomposition replacement backups for ${destination}`);
  }
  const backupPath = backupPaths[0] ?? decompositionReplacementBackupPath(destination);
  let backup: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    backup = await fs.lstat(backupPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (backup) {
    if (
      backup.isSymbolicLink() ||
      !backup.isFile() ||
      (backup.nlink !== 1n && backup.nlink !== 2n)
    ) {
      throw new Error(`Unsafe decomposition replacement backup: ${backupPath}`);
    }
    const backupBytes = await fs.readFile(backupPath);
    let destinationStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      destinationStat = await fs.lstat(destination, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!destinationStat) {
      if (backup.nlink !== 1n || !expected) {
        throw new Error(`Replacement backup has an unexplained link: ${backupPath}`);
      }
      if (!backupBytes.equals(expected.original)) {
        throw new Error(`Replacement backup bytes diverged for ${destination}; evidence retained.`);
      }
      await fs.link(backupPath, destination);
      await syncPublishedFile(destination);
      await removeClaimedRecoveryLink(backupPath, destination, {
        dev: BigInt(backup.dev),
        ino: BigInt(backup.ino),
        bytes: backupBytes,
      });
    } else if (
      destinationStat.dev === backup.dev &&
      destinationStat.ino === backup.ino &&
      destinationStat.nlink === 2n &&
      backup.nlink === 2n
    ) {
      await removeClaimedRecoveryLink(backupPath, destination, {
        dev: BigInt(backup.dev),
        ino: BigInt(backup.ino),
        bytes: backupBytes,
      });
    } else {
      if (
        backup.nlink !== 1n ||
        destinationStat.isSymbolicLink() ||
        !destinationStat.isFile() ||
        destinationStat.nlink !== 1n
      ) {
        throw new Error(`Replacement artifact identities diverged for ${destination}`);
      }
      if (!expected) {
        throw new Error(
          `Replacement completion at ${destination} requires its durable mutation journal.`,
        );
      }
      const [backupHash, destinationHash] = await Promise.all([
        Promise.resolve(createHash("sha256").update(backupBytes).digest("hex")),
        fs.readFile(destination).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
      ]);
      const originalHash = createHash("sha256").update(expected.original).digest("hex");
      const targetHash = createHash("sha256").update(expected.target).digest("hex");
      if (backupHash !== originalHash || destinationHash !== targetHash) {
        throw new Error(
          `Replacement bytes diverged for ${destination}; recovery evidence retained.`,
        );
      }
      await removeClaimedFile(
        backupPath,
        { dev: BigInt(backup.dev), ino: BigInt(backup.ino), bytes: backupBytes },
        "Decomposition replacement backup",
      );
    }
  }
}

export async function recoverDecompositionReplacementArtifactsInDirectory(
  directory: string,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const destinations = new Set<string>();
  for (const name of names) {
    if (!name.startsWith(".")) continue;
    const backupMarkerIndex = name.indexOf(REPLACEMENT_BACKUP_SUFFIX);
    if (backupMarkerIndex > 1) {
      const suffix = name.slice(backupMarkerIndex + REPLACEMENT_BACKUP_SUFFIX.length);
      if (suffix === "" || /^(?:\.cleanup-\d+-[0-9a-f-]{36})+$/.test(suffix)) {
        destinations.add(path.join(directory, name.slice(1, backupMarkerIndex)));
        continue;
      }
    }
    const markerIndex = name.indexOf(REPLACEMENT_TEMP_MARKER);
    if (markerIndex > 1) {
      const suffix = name.slice(markerIndex + REPLACEMENT_TEMP_MARKER.length);
      if (
        suffix === "" ||
        /^-\d+-[0-9a-f-]{36}(?:\.cleanup-\d+-[0-9a-f-]{36})*$/.test(suffix) ||
        /^(?:\.cleanup-\d+-[0-9a-f-]{36})+$/.test(suffix)
      ) {
        destinations.add(path.join(directory, name.slice(1, markerIndex)));
      }
    }
  }
  for (const destination of [...destinations].sort()) {
    await recoverDecompositionReplacementArtifacts(destination);
  }
}

export async function unlinkDecompositionFileWithRetry(filePath: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code ?? "")) {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * Durably replace an existing regular file without clobbering a pathname that
 * changes between validation and publication. The fully-fsynced target is
 * create-only; the exact current inode is first claimed at a deterministic
 * backup path and validated there. A journal-holding caller can recover every
 * crash boundary from the original/target bytes and these two pathnames.
 */
export async function writeDecompositionFileAtomicReplace(
  destination: string,
  content: string | Buffer,
  expectedCurrent: string | Buffer,
): Promise<void> {
  const expectedBytes = Buffer.isBuffer(expectedCurrent)
    ? expectedCurrent
    : Buffer.from(expectedCurrent, "utf-8");
  const targetBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const initialStat = await fs.lstat(destination, { bigint: true });
  if (initialStat.isSymbolicLink() || !initialStat.isFile() || initialStat.nlink !== 1n) {
    throw new Error(`Decomposition target is not a single-link regular file: ${destination}`);
  }

  const temporaryPath = await writeDurableTemporaryFile(
    destination,
    targetBytes,
    Number(initialStat.mode & 0o777n),
  );
  const backupPath = decompositionReplacementBackupPath(destination);
  try {
    await fs.lstat(backupPath);
    throw new Error(`Decomposition replacement backup already exists: ${backupPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await unlinkDecompositionFileWithRetry(temporaryPath);
      throw error;
    }
  }

  const temporaryStat = await fs.lstat(temporaryPath, { bigint: true });
  const temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
  let backupClaimed = false;
  let destinationPublished = false;
  let published = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const currentStat = await fs.lstat(destination, { bigint: true });
    if (
      currentStat.isSymbolicLink() ||
      !currentStat.isFile() ||
      currentStat.nlink !== 1n ||
      currentStat.dev !== initialStat.dev ||
      currentStat.ino !== initialStat.ino
    ) {
      throw new Error(`Decomposition target changed file identity: ${destination}`);
    }
    const currentBytes = await fs.readFile(destination);
    if (!currentBytes.equals(expectedBytes)) {
      throw new Error(`Decomposition target changed before atomic publish: ${destination}`);
    }

    // Claim the original inode at a create-only backup name, then remove only
    // the exact canonical hard link we just validated. Unlike rename(), link()
    // cannot overwrite a backup created by a concurrent actor.
    await fs.link(destination, backupPath);
    backupClaimed = true;
    await flushDirectory(path.dirname(destination));
    const backupStat = await fs.lstat(backupPath, { bigint: true });
    const backupBytes = await fs.readFile(backupPath);
    if (
      backupStat.isSymbolicLink() ||
      !backupStat.isFile() ||
      backupStat.nlink !== 2n ||
      backupStat.dev !== currentStat.dev ||
      backupStat.ino !== currentStat.ino ||
      !backupBytes.equals(expectedBytes)
    ) {
      throw new Error(`Decomposition target changed during atomic publish: ${destination}`);
    }
    await removeClaimedRecoveryLink(destination, backupPath, {
      dev: backupStat.dev,
      ino: backupStat.ino,
      bytes: expectedBytes,
    });

    await fs.link(temporaryPath, destination);
    destinationPublished = true;
    await unlinkDecompositionFileWithRetry(temporaryPath);
    await syncPublishedFile(destination);
    await flushDirectory(path.dirname(destination));
    const publishedStat = await fs.lstat(destination, { bigint: true });
    const publishedBytes = await fs.readFile(destination);
    if (
      publishedStat.isSymbolicLink() ||
      !publishedStat.isFile() ||
      publishedStat.dev !== temporaryIdentity.dev ||
      publishedStat.ino !== temporaryIdentity.ino ||
      !publishedBytes.equals(targetBytes)
    ) {
      throw new Error(`Decomposition target changed after atomic publish: ${destination}`);
    }
    await removeClaimedFile(
      backupPath,
      {
        dev: backupStat.dev,
        ino: backupStat.ino,
        bytes: expectedBytes,
      },
      "Decomposition replacement backup",
    );
    backupClaimed = false;
    published = true;
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (backupClaimed) {
      try {
        const [backupNow, destinationNow] = await Promise.all([
          fs.lstat(backupPath, { bigint: true }),
          fs.lstat(destination, { bigint: true }).catch((statError: NodeJS.ErrnoException) => {
            if (statError.code === "ENOENT") return undefined;
            throw statError;
          }),
        ]);
        if (
          backupNow.isSymbolicLink() ||
          !backupNow.isFile() ||
          backupNow.dev !== initialStat.dev ||
          backupNow.ino !== initialStat.ino ||
          backupNow.nlink !== 1n
        ) {
          throw new Error(`Decomposition replacement backup changed: ${backupPath}`);
        }
        if (!destinationNow) {
          await fs.link(backupPath, destination);
          await syncPublishedFile(destination);
          await removeClaimedRecoveryLink(backupPath, destination, {
            dev: backupNow.dev,
            ino: backupNow.ino,
            bytes: expectedBytes,
          });
        } else if (destinationPublished) {
          const destinationBytes = await fs.readFile(destination);
          if (
            destinationNow.isSymbolicLink() ||
            !destinationNow.isFile() ||
            destinationNow.dev !== temporaryIdentity.dev ||
            destinationNow.ino !== temporaryIdentity.ino ||
            !destinationBytes.equals(targetBytes)
          ) {
            throw new Error(
              `Published destination diverged; original bytes retained at ${backupPath}`,
            );
          }
          await removeClaimedFile(
            destination,
            { dev: temporaryIdentity.dev, ino: temporaryIdentity.ino, bytes: targetBytes },
            "Published decomposition target",
          );
          await fs.link(backupPath, destination);
          await syncPublishedFile(destination);
          await removeClaimedRecoveryLink(backupPath, destination, {
            dev: backupNow.dev,
            ino: backupNow.ino,
            bytes: expectedBytes,
          });
        } else {
          // A creator won the path after Quack claimed the original. Preserve
          // both the new pathname and the original backup for journal-led
          // recovery/operator inspection.
          throw new Error(
            `Decomposition destination was recreated concurrently; original bytes retained at ${backupPath}`,
          );
        }
        backupClaimed = false;
        await flushDirectory(path.dirname(destination));
      } catch (cleanupError) {
        if (typeof error === "object" && error !== null) {
          Object.defineProperty(error, "replacementRollbackError", {
            value: cleanupError,
            configurable: true,
            enumerable: true,
          });
        }
      }
    }
  }
  if (!published) {
    try {
      await unlinkDecompositionFileWithRetry(temporaryPath);
    } catch (cleanupError) {
      if (operationFailed && typeof operationError === "object" && operationError !== null) {
        Object.defineProperty(operationError, "temporaryCleanupError", {
          value: cleanupError,
          configurable: true,
          enumerable: true,
        });
      } else if (operationFailed) {
        throw new AggregateError(
          [operationError, cleanupError],
          "Decomposition replacement and temporary cleanup both failed",
          { cause: operationError },
        );
      } else {
        throw cleanupError;
      }
    }
  }
  if (operationFailed) throw operationError;
}

/**
 * Durably publish a new child without replacing a destination that appears
 * after preflight. A hard-link publish is atomic and fails with EEXIST while
 * the fully fsynced temporary inode remains private.
 */
export async function writeDecompositionFileAtomicExclusive(
  destination: string,
  content: string | Buffer,
  mode = 0o666,
): Promise<void> {
  const targetBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const temporaryPath = await writeDurableTemporaryFile(destination, targetBytes, mode);
  // Capture the private inode before publication. Once link() succeeds there
  // must be enough identity evidence to remove only our destination if any
  // later durability step fails (including the very first post-link call).
  let publishedIdentity: { dev: bigint; ino: bigint } | undefined;
  let destinationPublished = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const temporaryStat = await fs.lstat(temporaryPath, { bigint: true });
    publishedIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    await fs.link(temporaryPath, destination);
    destinationPublished = true;
    // Drop the private link before any later fallible durability step. A
    // crash after link() still exposes complete fsynced bytes, and recovery
    // deliberately tolerates that child's temporary second link.
    await unlinkDecompositionFileWithRetry(temporaryPath);
    await syncPublishedFile(destination);
    await flushDirectory(path.dirname(destination));
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (destinationPublished && publishedIdentity) {
      try {
        const destinationStat = await fs.lstat(destination, { bigint: true });
        if (
          destinationStat.isFile() &&
          !destinationStat.isSymbolicLink() &&
          destinationStat.dev === publishedIdentity.dev &&
          destinationStat.ino === publishedIdentity.ino
        ) {
          await removeClaimedFile(
            destination,
            {
              dev: publishedIdentity.dev,
              ino: publishedIdentity.ino,
              bytes: targetBytes,
            },
            "Published decomposition child",
          );
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          Object.defineProperty(error, "publishedDestinationCleanupError", {
            value: cleanupError,
            configurable: true,
            enumerable: true,
          });
        }
      }
    }
  }
  try {
    await unlinkDecompositionFileWithRetry(temporaryPath);
  } catch (cleanupError) {
    if (operationFailed && typeof operationError === "object" && operationError !== null) {
      Object.defineProperty(operationError, "temporaryCleanupError", {
        value: cleanupError,
        configurable: true,
        enumerable: true,
      });
    } else if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Decomposition child publish and temporary cleanup both failed",
        { cause: operationError },
      );
    } else {
      throw cleanupError;
    }
  }
  if (operationFailed) throw operationError;
}
