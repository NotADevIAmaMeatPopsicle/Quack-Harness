// ─── Gate Advisor ──────────────────────────────────────────────────
// Consults historical failure patterns to provide advisory suggestions
// before gate evaluation. Advisory is informational only, not blocking.

import * as fs from "node:fs";
import * as path from "node:path";

import type { ParsedTask } from "../core/types.js";
import type { FailurePatternDB, GateAdvisory } from "./analytics-types.js";
import { createEmptyPatternDB } from "./analytics-types.js";

/**
 * Get advisory suggestions based on historical patterns.
 *
 * This function:
 * 1. Loads the failure pattern database
 * 2. Matches task characteristics (tags, files) against known patterns
 * 3. Returns suggestions for minimum gate score and relevant warnings
 *
 * The advisory is INFORMATIONAL ONLY — it does not block the gate.
 */
export function getGateAdvisory(task: ParsedTask, projectRoot: string): GateAdvisory {
  const analyticsPath = path.join(projectRoot, ".quack", "analytics", "failure-patterns.json");

  // If no analytics data exists yet, return empty advisory
  if (!fs.existsSync(analyticsPath)) {
    return {
      suggestedMinScore: 3.0, // Default from gate config
      warnings: [],
      relevantPatterns: [],
    };
  }

  // Load pattern database
  let db: FailurePatternDB;
  try {
    db = JSON.parse(fs.readFileSync(analyticsPath, "utf-8")) as FailurePatternDB;
  } catch {
    db = createEmptyPatternDB();
  }

  const warnings: string[] = [];
  const relevantPatterns: Array<{ pattern: string; suggestion: string }> = [];

  // Check for file hot spots (threshold: 2 runs at <60% success, lowered from 3)
  for (const fileMod of task.filesToModify) {
    const fileStats = db.byFile[fileMod.path];
    if (fileStats && fileStats.runs >= 2 && fileStats.rate < 0.6) {
      warnings.push(
        `File ${fileMod.path} has a ${(fileStats.rate * 100).toFixed(1)}% success rate (${fileStats.approved}/${fileStats.runs} runs)`,
      );
      // Find the pattern for this file
      const pattern = db.knownPatterns.find((p) => p.pattern === `file_hotspot:${fileMod.path}`);
      if (pattern) {
        relevantPatterns.push({
          pattern: pattern.pattern,
          suggestion: pattern.suggestion,
        });
      }
    }
  }

  // Check for tag failure clusters
  for (const tag of task.tags) {
    const tagStats = db.byTag[tag];
    if (tagStats && tagStats.runs >= 3 && tagStats.rate < 0.5) {
      warnings.push(
        `Tasks tagged "${tag}" have a ${(tagStats.rate * 100).toFixed(1)}% success rate (${tagStats.approved}/${tagStats.runs} runs)`,
      );
      // Find the pattern for this tag
      const pattern = db.knownPatterns.find((p) => p.pattern === `tag_cluster:${tag}`);
      if (pattern) {
        relevantPatterns.push({
          pattern: pattern.pattern,
          suggestion: pattern.suggestion,
        });
      }
    }
  }

  // Check for integration wiring gaps in tasks creating new files
  const createFiles = task.filesToModify.filter((f) => f.action === "Create");
  if (createFiles.length > 0) {
    // Calculate failure rate specifically for the files being created in this task
    // Only count stats from files that match this task's create targets
    let createFileRuns = 0;
    let createFileFailures = 0;

    for (const fileMod of createFiles) {
      const stats = db.byFile[fileMod.path];
      if (stats) {
        createFileRuns += stats.runs;
        createFileFailures += stats.rejected;
      }
    }

    const createFailRate = createFileRuns > 0 ? createFileFailures / createFileRuns : 0;

    if (createFailRate > 0.4 && createFileRuns >= 2) {
      warnings.push(
        "Tasks creating new files have a " +
          Math.round(createFailRate * 100) +
          "% failure rate. " +
          "Verify integration wiring — ensure importing files are also in filesToModify.",
      );
      relevantPatterns.push({
        pattern: "new_file_integration",
        suggestion:
          'Add "Integration Context" section to spec listing where new modules are imported/registered.',
      });
    }
  }

  // Check for gate threshold drift pattern
  const thresholdPattern = db.knownPatterns.find((p) => p.pattern === "gate_threshold_drift");
  if (thresholdPattern) {
    relevantPatterns.push({
      pattern: thresholdPattern.pattern,
      suggestion: thresholdPattern.suggestion,
    });
  }

  // Suggest minimum gate score based on historical success rates
  let suggestedMinScore = 3.0; // Default

  // If we have gate score data, analyze it
  const scoreBuckets = Object.entries(db.byGateScore);
  if (scoreBuckets.length > 0) {
    // Find the lowest score bucket with >70% success rate
    const goodBuckets = scoreBuckets
      .filter(([_, stats]) => stats.runs >= 3 && stats.rate > 0.7)
      .sort((a, b) => {
        // Sort by bucket (lower score first)
        const scoreA = parseScoreBucket(a[0]);
        const scoreB = parseScoreBucket(b[0]);
        return scoreA - scoreB;
      });

    if (goodBuckets.length > 0) {
      const [bucket] = goodBuckets[0];
      suggestedMinScore = parseScoreBucket(bucket);
    } else {
      // No buckets with good success rates — suggest higher threshold
      const allBuckets = scoreBuckets.sort((a, b) => {
        const scoreA = parseScoreBucket(a[0]);
        const scoreB = parseScoreBucket(b[0]);
        return scoreB - scoreA; // Descending
      });
      if (allBuckets.length > 0) {
        const [bucket] = allBuckets[0];
        suggestedMinScore = Math.min(4.0, parseScoreBucket(bucket));
      }
    }
  }

  return {
    suggestedMinScore,
    warnings,
    relevantPatterns,
  };
}

/**
 * Parse score bucket string to numeric value.
 */
function parseScoreBucket(bucket: string): number {
  if (bucket === "<3.0") return 2.5;
  if (bucket === "3.0-3.5") return 3.0;
  if (bucket === "3.5-4.0") return 3.5;
  if (bucket === "4.0-4.5") return 4.0;
  if (bucket === "4.5+") return 4.5;
  return 3.0;
}
