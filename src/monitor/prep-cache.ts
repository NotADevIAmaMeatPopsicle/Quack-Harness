import {
  fidelityBlueprintFailure,
  blueprintFailureGuidance,
} from "../blueprint/generation-failure.js";
import { parseFullPreflightResult } from "./preflight-job-result.js";
// ─── Prep Cache ────────────────────────────────────────────────────
// Manages cached gate prep results in .quack/prep/{taskId}.json
// Provides read/write/invalidate operations and staleness detection.
// Supports content-hash-based cache validation for deterministic caching.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PreflightResult } from "../preflight/preflight-types.js";
import { ensurePrepStorageDir, resolvePrepStorageDirSync } from "../core/prep-storage.js";
import { matchesSchemaPolicy } from "../gate/schema-policy.js";

export interface PrepResult {
  taskId: string;
  preparedAt: string;
  schemaValid: boolean;
  schemaErrors: string[];
  depthScore: number;
  depthReady: boolean;
  deficiencies: string[];
  outcome: "pass" | "enriched" | "rejected";
  recommendDecomposition?: boolean;
  decompositionReason?: string;
  stale: boolean;
  /** SHA-256 hash of the task spec content + relevant file hashes */
  contentHash?: string;
  /** Policy captured at evaluation; absent legacy policy is unknown. */
  schemaPolicyHash?: string;
}

/**
 * Compute a SHA-256 content hash from task spec content and optional file hashes.
 * Used for deterministic cache validation — if the hash matches, the cached
 * result is still valid regardless of file modification timestamps.
 */
export function computeContentHash(taskSpecContent: string, relevantFileHashes?: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(taskSpecContent);
  if (relevantFileHashes) {
    hash.update(JSON.stringify(relevantFileHashes));
  }
  return hash.digest("hex");
}

export class PrepCache {
  constructor(private readonly projectRoot: string) {}

  private get prepDir(): string {
    return resolvePrepStorageDirSync(this.projectRoot);
  }

  private prepFilePath(taskId: string): string {
    return path.join(this.prepDir, `${taskId}.json`);
  }

  /**
   * Read cached prep result for a task.
   * Returns null if no cached result exists.
   * Sets stale flag if task file has been modified since prep.
   * If a contentHash is provided and the cached result has a matching hash,
   * the result is returned as non-stale.
   * If a contentHash is provided and the cached result has a different hash,
   * the cached result is stale regardless of timestamps.
   */
  async read(
    taskId: string,
    taskFilePath?: string,
    contentHash?: string,
    expectedSchemaPolicyHash?: string,
  ): Promise<PrepResult | null> {
    const filePath = this.prepFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const result = JSON.parse(content) as PrepResult;

      // Content hash match is authoritative for currentness.
      if (contentHash && result.contentHash && result.contentHash === contentHash) {
        return {
          ...result,
          stale:
            expectedSchemaPolicyHash !== undefined &&
            !matchesSchemaPolicy(result.schemaPolicyHash, expectedSchemaPolicyHash),
        };
      }

      // If the caller knows the current spec hash and it differs from the
      // cached hash, the cache is stale even if file mtimes happen to align.
      let stale = Boolean(contentHash && result.contentHash && result.contentHash !== contentHash);

      // Fall back to timestamp-based staleness only when hash mismatch
      // information is unavailable.
      if (!stale && taskFilePath && fs.existsSync(taskFilePath)) {
        const taskStat = await fs.promises.stat(taskFilePath);
        const prepTime = new Date(result.preparedAt).getTime();
        stale = taskStat.mtimeMs > prepTime;
      }

      return {
        ...result,
        stale:
          stale ||
          (expectedSchemaPolicyHash !== undefined &&
            !matchesSchemaPolicy(result.schemaPolicyHash, expectedSchemaPolicyHash)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read cached prep result by content hash only.
   * Returns the cached result if the stored contentHash matches the provided hash.
   * Returns null if no cache exists or hashes do not match.
   * This is the primary deterministic cache lookup — zero LLM calls when content is unchanged.
   */
  async readByHash(taskId: string, contentHash: string): Promise<PrepResult | null> {
    const filePath = this.prepFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const result = JSON.parse(content) as PrepResult;

      if (result.contentHash === contentHash) {
        return { ...result, stale: false };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Write prep result to cache.
   */
  async write(result: Omit<PrepResult, "stale">): Promise<void> {
    const filePath = this.prepFilePath(result.taskId);

    // Ensure prep directory exists
    await ensurePrepStorageDir(this.projectRoot);

    const content = JSON.stringify(result, null, 2) + "\n";
    await fs.promises.writeFile(filePath, content, "utf-8");
  }

  /**
   * Delete cached prep result.
   */
  async invalidate(taskId: string): Promise<boolean> {
    const filePath = this.prepFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a prep result exists (without reading it).
   */
  exists(taskId: string): boolean {
    return fs.existsSync(this.prepFilePath(taskId));
  }

  // ─── Preflight Cache Methods ────────────────────────────────────

  private preflightFilePath(taskId: string): string {
    return path.join(this.prepDir, `${taskId}-preflight.json`);
  }

  /**
   * Read cached preflight result for a task.
   * Returns null if no cached result exists or if the content hash doesn't match
   * (indicating the task spec has changed since the preflight was run).
   */
  async readPreflight(
    taskId: string,
    contentHash?: string,
    expectedReadinessMode?: "off" | "shadow" | "enforce",
    expectedSchemaPolicyHash?: string,
  ): Promise<PreflightResult | null> {
    const filePath = this.preflightFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const result = JSON.parse(content) as PreflightResult;

      // If a content hash is provided, validate it matches
      if (contentHash && result.contentHash !== contentHash) {
        return null; // Stale — task spec changed
      }
      if (
        expectedSchemaPolicyHash !== undefined &&
        !matchesSchemaPolicy(result.schemaPolicyHash, expectedSchemaPolicyHash)
      ) {
        return null;
      }

      // TASK-1315: a readiness-judgment mode flip changes gate AUTHORITY
      // semantics — cached results from another mode are stale for
      // authority consumers (legacy caches without the field are
      // off-era).
      if (
        expectedReadinessMode !== undefined &&
        (result.gate.readinessJudgmentMode ?? "off") !== expectedReadinessMode
      ) {
        return null;
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Write preflight result to cache.
   *
   * TASK-1356 extends the TASK-1324 monotonic guard to the real producer's
   * failed-generation evidence, including omitted structured data. It returns
   * the effective report for coherent caller/SQLite/job publication. A failed
   * synthesis never overwrites a cached
   * fidelity-ok brief for the SAME contentHash — the exact overwrite
   * that destroyed replan-1's good blueprint with replan-2's stub during
   * the TASK-1273 cycle. The whole blueprint section (counts + markdown
   * + structured) is preserved coherently, the refused synthesis is
   * recorded on the result (`structuredPreserved`), and everything else
   * synthesis-independent evidence (gate, timestamps) remains fresh.
   * A different contentHash means the SPEC changed, so the old brief is
   * legitimately obsolete and the guard stands aside.
   */
  async writePreflight(result: PreflightResult): Promise<PreflightResult> {
    const filePath = this.preflightFilePath(result.taskId);

    // Ensure prep directory exists
    await ensurePrepStorageDir(this.projectRoot);

    let toWrite = result;
    const incoming = result.blueprint.structured;
    const fidelity = result.blueprint.fidelity ?? incoming?.fidelity;
    const failure =
      result.blueprint.generationFailure ??
      incoming?.generationFailure ??
      (fidelity?.status === "failed" ? fidelityBlueprintFailure(fidelity) : undefined);
    if (failure) {
      toWrite = {
        ...result,
        mode: "deterministic",
        blueprint: { ...result.blueprint, generationFailure: failure },
        degraded: result.degraded ?? {
          reason: blueprintFailureGuidance(failure),
          diagnostics: failure,
          checksRun: [],
          checksSkipped: ["blueprint.llm"],
        },
      };
      try {
        const prior = await this.readPreflight(result.taskId, result.contentHash);
        const existing = prior?.blueprint.structured;
        const existingUsable =
          existing &&
          existing.taskId === result.taskId &&
          Array.isArray(existing.fileAnalyses) &&
          Array.isArray(existing.codeExamples) &&
          Array.isArray(existing.verificationPatterns) &&
          Array.isArray(existing.antiPatterns) &&
          Array.isArray(existing.preconditions) &&
          existing.fileAnalyses.every(
            (file) =>
              file &&
              typeof file.filePath === "string" &&
              file.filePath.trim().length > 0 &&
              ["Create", "Modify", "Delete", "Reference"].includes(file.action),
          ) &&
          typeof prior.blueprint.formattedMarkdown === "string" &&
          prior.blueprint.formattedMarkdown.trim().length > 0 &&
          !existing.generationFailure &&
          (existing.fidelity === undefined || existing.fidelity.status === "ok") &&
          prior.blueprint.fidelity?.status !== "failed" &&
          (existing.fileAnalyses.length > 0 ||
            (Array.isArray(existing.importsToUse) &&
              existing.importsToUse.some(
                (item) =>
                  item &&
                  typeof item.symbol === "string" &&
                  item.symbol.trim().length > 0 &&
                  typeof item.fromFile === "string" &&
                  item.fromFile.trim().length > 0,
              )) ||
            (Array.isArray(existing.entryPoints) &&
              existing.entryPoints.some(
                (item) =>
                  item &&
                  typeof item.symbol === "string" &&
                  item.symbol.trim().length > 0 &&
                  typeof item.file === "string" &&
                  item.file.trim().length > 0,
              )));
        // A size-omitted structured object still leaves a fully validated paid
        // rendering and a positive fidelity audit. Unknown legacy blobs do not.
        const omittedUsable =
          prior &&
          !existing &&
          prior.blueprint.fidelity?.status === "ok" &&
          prior.blueprint.formattedMarkdown.trim().length > 0 &&
          prior.blueprint.fileAnalyses > 0 &&
          Boolean(parseFullPreflightResult(prior));
        if (prior && (existingUsable || omittedUsable)) {
          // Round-2 F4: everything DERIVED FROM the preserved synthesis
          // travels with it — blueprint section, context estimate, and
          // complexity — so approval decisions, the operator view, and
          // the worker context all describe the SAME brief. Only
          // synthesis-independent facts (gate, timestamps, specReview)
          // stay fresh.
          const generatedAt = existing?.generatedAt ?? prior.blueprint.generatedAt;
          const hasGeneratedAt =
            typeof generatedAt === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt) &&
            Number.isFinite(Date.parse(generatedAt));
          toWrite = {
            ...toWrite,
            blueprint: {
              ...prior.blueprint,
              generationFailure: failure,
              structuredPreserved: {
                reason: "fidelity_monotonic_guard",
                preservedFrom:
                  prior.blueprint.structuredPreserved?.preservedFrom ??
                  (hasGeneratedAt ? generatedAt : prior.timestamp),
                preservedFromKind:
                  prior.blueprint.structuredPreserved?.preservedFromKind ??
                  (hasGeneratedAt ? "generated_at" : "legacy_cache_timestamp"),
                refusedCheckedAt: fidelity?.checkedAt ?? failure.failedAt,
              },
            },
            contextEstimate: prior.contextEstimate,
            complexity: prior.complexity,
          };
        }
      } catch {
        // The guard is best-effort protection of a GOOD artifact; a
        // failed read of the prior cache must never block the write.
      }
    }

    const content = JSON.stringify(toWrite, null, 2) + "\n";
    await fs.promises.writeFile(filePath, content, "utf-8");
    return toWrite;
  }

  /**
   * Delete cached preflight result.
   */
  async invalidatePreflight(taskId: string): Promise<boolean> {
    const filePath = this.preflightFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Convention Check Cache ──────────────────────────────────────────
// In-memory cache for convention check results, keyed by a content hash
// of the target files. If target files haven't changed (same hashes),
// convention check results are still valid — no need to re-run commands.

export interface CachedConventionResult {
  hash: string;
  results: Array<{ name: string; passed: boolean; output: string }>;
  cachedAt: string;
}

export class ConventionCheckCache {
  private cache = new Map<string, CachedConventionResult>();

  /**
   * Compute a hash from file contents to use as a cache key.
   */
  static hashFiles(fileContents: Map<string, string>): string {
    const hash = crypto.createHash("sha256");
    const sortedEntries = [...fileContents.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [filePath, content] of sortedEntries) {
      hash.update(filePath);
      hash.update(content);
    }
    return hash.digest("hex");
  }

  /**
   * Get cached convention check results for a given check name and file hash.
   * Returns null if no valid cache entry exists.
   */
  get(checkName: string, fileHash: string): CachedConventionResult["results"] | null {
    const entry = this.cache.get(checkName);
    if (!entry || entry.hash !== fileHash) {
      return null;
    }
    return entry.results;
  }

  /**
   * Store convention check results for a given check name and file hash.
   */
  set(checkName: string, fileHash: string, results: CachedConventionResult["results"]): void {
    this.cache.set(checkName, {
      hash: fileHash,
      results,
      cachedAt: new Date().toISOString(),
    });
  }

  /**
   * Invalidate a specific check's cache entry.
   */
  invalidate(checkName: string): boolean {
    return this.cache.delete(checkName);
  }

  /**
   * Clear the entire convention check cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
