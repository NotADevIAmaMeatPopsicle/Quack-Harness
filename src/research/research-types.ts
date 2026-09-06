// ─── Research Types ────────────────────────────────────────────────
// Interfaces for automated post-dispatch analysis: stage timing,
// code metrics, efficiency scoring, and anomaly detection.

export interface StageTiming {
  stage: string;
  startTime: string;
  endTime: string;
  durationMs: number;
}

export interface CodeMetrics {
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  totalFiles: number;
  branchName: string;
}

export type AnomalyType =
  | "too_slow"
  | "too_fast"
  | "high_cost_per_line"
  | "low_output"
  | "stale_adapter"
  | "refreshed_adapter"
  | "validation_class_mismatch";

export type ValidationFailureTaxonomy =
  | "stale_adapter"
  | "refreshed_adapter"
  | "validation_class_mismatch";

export type ValidationFailureTaxonomyCounts = Record<ValidationFailureTaxonomy, number>;

export interface ValidationDriftByWorkerEntry extends ValidationFailureTaxonomyCounts {
  worker: string;
  total: number;
}

export interface AnomalyFlag {
  type: AnomalyType;
  message: string;
  value: number;
  threshold: number;
}

export interface EfficiencyBaseline {
  meanLinesPerMinute: number;
  stdDevLinesPerMinute: number;
  meanCostPerLine: number;
  stdDevCostPerLine: number;
  sampleCount: number;
  lastUpdated: string;
}

export interface DispatchAnalysis {
  sessionId: string;
  taskId: string;
  taskTitle?: string;
  project: string;
  outcome: string;
  startTime: string;
  durationMs: number;
  totalCostUsd: number;
  turnsUsed: number;
  stageTimings: StageTiming[];
  codeMetrics: CodeMetrics | null;
  linesPerMinute: number | null;
  costPerLine: number | null;
  efficiencyScore: number | null;
  anomalies: AnomalyFlag[];
  workerHostId?: string;
  workerHostAlias?: string;
  workerHostEndpoint?: string;
  executionMode?: "direct" | "federated" | "remote" | "unknown";
  federatedJobId?: string;
  federatedLeaseId?: string;
  analyzedAt: string;
}

export interface ExperimentReadiness {
  area: string;
  dataPoints: number;
  avgDurationMs: number;
  pctOfTotal: number;
  baselineReady: boolean;
}

export interface TrendEntry {
  date: string;
  avgLinesPerMinute: number | null;
  avgCostPerLine: number | null;
  dispatches: number;
  approvedCount: number;
  anomalyCount: number;
}

export interface ResearchDashboard {
  analyses: DispatchAnalysis[];
  baseline: EfficiencyBaseline | null;
  experimentReadiness: ExperimentReadiness[];
  trends: TrendEntry[];
  lastRebuilt?: string | null;
  summary: {
    totalAnalyzed: number;
    avgLinesPerMinute: number | null;
    avgCostPerLine: number | null;
    totalAnomalies: number;
    workerCount: number;
    federatedRuns: number;
    directRuns: number;
    failedRuns: number;
    validationDriftRuns: number;
    validationFailureTaxonomy: ValidationFailureTaxonomyCounts;
    validationDriftByWorker: ValidationDriftByWorkerEntry[];
  };
}

export interface ResearchStoreData {
  analyses: DispatchAnalysis[];
  baseline: EfficiencyBaseline | null;
  lastRebuilt: string | null;
}
