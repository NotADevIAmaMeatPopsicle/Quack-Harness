import * as fs from "node:fs";
import * as path from "node:path";

const PREP_DIR_NAME = "prep";
const FALLBACK_PREP_DIR_NAME = "runtime-prep";

function canonicalPrepDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", PREP_DIR_NAME);
}

function fallbackPrepDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", FALLBACK_PREP_DIR_NAME);
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolvePointerTarget(pointer: string, projectRoot: string): string | null {
  const trimmed = pointer.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(projectRoot, trimmed);
}

export function resolvePrepStorageDirSync(projectRoot: string): string {
  const canonical = canonicalPrepDir(projectRoot);
  try {
    const stat = fs.lstatSync(canonical);
    if (stat.isDirectory()) {
      return canonical;
    }
    if (stat.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(canonical);
        if (isExistingDirectory(real)) {
          return real;
        }
      } catch {
        return fallbackPrepDir(projectRoot);
      }
      return fallbackPrepDir(projectRoot);
    }
    if (stat.isFile()) {
      try {
        const pointer = fs.readFileSync(canonical, "utf-8");
        const target = resolvePointerTarget(pointer, projectRoot);
        if (target && isExistingDirectory(target)) {
          return target;
        }
      } catch {
        // Fall back to the runtime directory below.
      }
      return fallbackPrepDir(projectRoot);
    }
    return fallbackPrepDir(projectRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return canonical;
    }
    return fallbackPrepDir(projectRoot);
  }
}

export async function ensurePrepStorageDir(projectRoot: string): Promise<string> {
  const dir = resolvePrepStorageDirSync(projectRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function ensurePrepStorageDirSync(projectRoot: string): string {
  const dir = resolvePrepStorageDirSync(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
