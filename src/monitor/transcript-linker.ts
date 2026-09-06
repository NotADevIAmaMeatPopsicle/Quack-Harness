// ─── Transcript Linker ──────────────────────────────────────────────
// Discovers Claude Code session transcripts that correspond to Quack
// dispatch sessions and copies them into .quack/logs/ for co-location
// with event data.
//
// Claude Code stores transcripts at:
//   ~/.claude/projects/<project-slug>/<session-id>.jsonl
//
// Each JSONL line has fields: type, message, sessionId, gitBranch

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscoveredTranscript {
  /** Claude Code session ID (from the JSONL sessionId field) */
  claudeSessionId: string;
  /** Absolute path to the source transcript file */
  sourcePath: string;
  /** File modification time (for closest-match selection) */
  mtime: number;
}

export interface CopyResult {
  /** Whether the copy succeeded */
  success: boolean;
  /** Destination path (if successful) */
  destPath?: string;
  /** Error message (if failed) */
  error?: string;
}

// ─── Discovery ──────────────────────────────────────────────────────

/**
 * Scan ~/.claude/projects/ for JSONL transcript files where gitBranch
 * matches the task's branch pattern and the file timestamp falls within
 * the run's time window.
 *
 * @param _projectRoot - Unused, kept for API consistency
 * @param taskId - Task identifier (e.g., "TASK-027")
 * @param startTime - Run start time (epoch ms)
 * @param endTime - Run end time (epoch ms)
 * @param claudeDir - Override for ~/.claude (used in tests)
 */
export async function discoverTranscripts(
  _projectRoot: string,
  taskId: string,
  startTime: number,
  endTime: number,
  claudeDir?: string,
): Promise<DiscoveredTranscript[]> {
  const baseDir = claudeDir ?? path.join(os.homedir(), ".claude");
  const projectsDir = path.join(baseDir, "projects");

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const branchPattern = `quack/${taskId}`;
  const results: DiscoveredTranscript[] = [];

  // Scan all project subdirectories
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }

  for (const projDir of projectDirs) {
    const projPath = path.join(projectsDir, projDir);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(projPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Scan JSONL files in this project directory
    let files: string[];
    try {
      files = await fsp.readdir(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = path.join(projPath, file);
      let fileStat: fs.Stats;
      try {
        fileStat = await fsp.stat(filePath);
      } catch {
        continue;
      }

      // Check file modification time falls within the run window
      // Use a generous buffer (5 min before start, 5 min after end)
      const bufferMs = 5 * 60 * 1000;
      const mtime = fileStat.mtimeMs;
      if (mtime < startTime - bufferMs || mtime > endTime + bufferMs) {
        continue;
      }

      // Read first few lines to check gitBranch and sessionId
      const match = await matchTranscriptFile(filePath, branchPattern);
      if (match) {
        results.push({
          claudeSessionId: match.sessionId,
          sourcePath: filePath,
          mtime,
        });
      }
    }
  }

  // Sort by mtime closest to startTime
  results.sort((a, b) => Math.abs(a.mtime - startTime) - Math.abs(b.mtime - startTime));

  return results;
}

/**
 * Read the first lines of a JSONL transcript file to extract sessionId
 * and check if gitBranch matches the expected pattern.
 */
async function matchTranscriptFile(
  filePath: string,
  branchPattern: string,
): Promise<{ sessionId: string } | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream });

    let foundSessionId: string | null = null;
    let foundBranch = false;
    let linesRead = 0;
    const maxLines = 50; // Check first 50 lines for branch info

    rl.on("line", (line) => {
      linesRead++;

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        // Extract sessionId from any line that has it
        if (
          !foundSessionId &&
          typeof parsed.sessionId === "string" &&
          parsed.sessionId.length > 0
        ) {
          foundSessionId = parsed.sessionId;
        }

        // Check gitBranch
        if (typeof parsed.gitBranch === "string" && parsed.gitBranch.startsWith(branchPattern)) {
          foundBranch = true;
        }
      } catch {
        // Skip unparseable lines
      }

      if ((foundSessionId && foundBranch) || linesRead >= maxLines) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on("close", () => {
      if (foundSessionId && foundBranch) {
        resolve({ sessionId: foundSessionId });
      } else {
        resolve(null);
      }
    });

    rl.on("error", () => {
      resolve(null);
    });

    stream.on("error", () => {
      rl.close();
      resolve(null);
    });
  });
}

// ─── Copying ────────────────────────────────────────────────────────

/**
 * Copy a transcript file to the .quack/logs/ directory with a
 * standardized naming convention.
 *
 * @param sourcePath - Absolute path to the source transcript
 * @param destDir - Destination directory (.quack/logs/)
 * @param quackSessionId - Quack session ID for naming
 * @param attemptNumber - Attempt number (0-based)
 */
export async function copyTranscript(
  sourcePath: string,
  destDir: string,
  quackSessionId: string,
  attemptNumber: number,
): Promise<CopyResult> {
  const destFileName = `transcript-${quackSessionId}-attempt-${attemptNumber}.jsonl`;
  const destPath = path.join(destDir, destFileName);

  try {
    // Ensure destination directory exists
    await fsp.mkdir(destDir, { recursive: true });

    // Check source exists
    await fsp.access(sourcePath);

    // Copy the file
    await fsp.copyFile(sourcePath, destPath);

    return { success: true, destPath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to copy transcript: ${message}` };
  }
}
