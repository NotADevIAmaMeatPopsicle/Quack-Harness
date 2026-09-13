import { computeSchemaPolicyHash } from "../../src/gate/schema-policy";
import type { PreflightInputIdentity } from "../../src/monitor/preflight-job-store";
import type { StampedPreflightResult } from "../../src/monitor/preflight-job-result";

export const preflightInput: PreflightInputIdentity = {
  contentHash: "a".repeat(64), schemaPolicyHash: computeSchemaPolicyHash(),
  readinessJudgmentMode: "off", requestedMode: "auto",
};

export function fullPreflightReport(taskId = "TASK-1355"): StampedPreflightResult {
  return {
    taskId, timestamp: new Date().toISOString(), contentHash: preflightInput.contentHash,
    schemaPolicyHash: preflightInput.schemaPolicyHash, mode: "full",
    gate: { ready: true, score: 4.9, dimensions: {}, readinessJudgmentMode: "off" },
    blueprint: { fileAnalyses: 1, codeExamples: 1, verificationPatterns: 1,
      antiPatterns: 0, formattedMarkdown: "Fresh generated blueprint" },
    complexity: { filesToModify: 1, successCriteria: 1, estimatedContextTokens: 100,
      independentFeatures: 1, featureClusters: [], recommendDecomposition: false, reason: "Small task" },
    contextEstimate: { taskSpec: 100, blueprint: 100, repoMap: 0, relevantFiles: 0,
      relatedPatterns: 0, existingTests: 0, conventions: 0, claudeMd: 0,
      total: 200, withinBudget: true },
  };
}
