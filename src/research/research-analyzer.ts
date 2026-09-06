// ─── Research Analyzer ─────────────────────────────────────────────
// Core engine: computes stage timings from event logs, extracts code
// metrics from git diff, scores efficiency, and flags anomalies.

import { execSync } from "node:child_process";

import type { QuackEvent } from "../monitor/event-types.js";
import type { SessionEntry } from "../monitor/event-types.js";
import type {
  StageTiming,
  CodeMetrics,
  AnomalyFlag,
  EfficiencyBaseline,
  DispatchAnalysis,
  ExperimentReadiness,
  TrendEntry,
} from "./research-types.js";

// ─── Stage Timing Computation ─────────────────────────────────────

/** Milestone stage names mapped to their logical pipeline stage. */
const STAGE_MILESTONES: Array<{ name: string; start: string[]; end: string[] }> = [
  // Dispatch pipeline stages
  { name: "gate", start: ["session_start"], end: ["gate_result"] },
  { name: "blueprint", start: ["gate_result"], end: ["blueprint_generated", "blueprint_approved"] },
  {
    name: "context",
    start: ["blueprint_generated", "blueprint_approved"],
    end: ["context_assembled"],
  },
  { name: "agent", start: ["agent_turn"], end: ["agent_complete"] },
  { name: "judge", start: ["judge_start"], end: ["judge_result"] },
  // Preflight pipeline stages
  { name: "preflight_total", start: ["preflight_start"], end: ["preflight_complete"] },
  { name: "preflight_gate", start: ["preflight_start"], end: ["preflight_gate"] },
  { name: "preflight_spec_review", start: ["preflight_gate"], end: ["preflight_spec_review"] },
  { name: "preflight_blueprint", start: ["preflight_spec_review"], end: ["preflight_blueprint"] },
  { name: "preflight_analysis", start: ["preflight_blueprint"], end: ["preflight_analysis"] },
];

export function computeStageTimings(events: QuackEvent[]): StageTiming[] {
  if (events.length === 0) return [];

  const timings: StageTiming[] = [];
  const timestampMap = new Map<string, string>();

  // Build timestamp map: first occurrence of each stage
  for (const event of events) {
    if (!timestampMap.has(event.stage)) {
      timestampMap.set(event.stage, event.timestamp);
    }
  }

  // Also keep the LAST occurrence for end stages (e.g., last judge_result)
  const lastTimestampMap = new Map<string, string>();
  for (const event of events) {
    lastTimestampMap.set(event.stage, event.timestamp);
  }

  for (const milestone of STAGE_MILESTONES) {
    let startTime: string | undefined;
    let endTime: string | undefined;

    // Find earliest start
    for (const s of milestone.start) {
      const ts = timestampMap.get(s);
      if (ts && (!startTime || ts < startTime)) {
        startTime = ts;
      }
    }

    // Find latest end
    for (const e of milestone.end) {
      const ts = lastTimestampMap.get(e);
      if (ts && (!endTime || ts > endTime)) {
        endTime = ts;
      }
    }

    if (startTime && endTime) {
      const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
      if (durationMs >= 0) {
        timings.push({
          stage: milestone.name,
          startTime,
          endTime,
          durationMs,
        });
      }
    }
  }

  // Compute overhead: total session time minus sum of known stages
  const sessionStart = timestampMap.get("session_start");
  const sessionEnd =
    lastTimestampMap.get("session_complete") ?? lastTimestampMap.get("session_error");
  if (sessionStart && sessionEnd) {
    const totalMs = new Date(sessionEnd).getTime() - new Date(sessionStart).getTime();
    const knownMs = timings.reduce((sum, t) => sum + t.durationMs, 0);
    const overheadMs = Math.max(0, totalMs - knownMs);
    if (overheadMs > 0) {
      timings.push({
        stage: "overhead",
        startTime: sessionStart,
        endTime: sessionEnd,
        durationMs: overheadMs,
      });
    }
  }

  return timings;
}

// ─── Code Metrics from Git Diff ───────────────────────────────────

export function computeCodeMetrics(events: QuackEvent[], projectRoot: string): CodeMetrics | null {
  // Find branch name from events
  let branchName: string | undefined;
  for (const event of events) {
    if (
      event.stage === "branch_created" ||
      event.stage === "branch_resumed" ||
      event.stage === "branch_reused"
    ) {
      const payload = event.payload as { branchName?: string };
      if (payload.branchName) {
        branchName = payload.branchName;
        break;
      }
    }
  }

  if (!branchName) return null;

  try {
    // Find merge base
    const base = execSync(`git merge-base main ${branchName}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    if (!base) return null;

    // Get diff stat
    const stat = execSync(`git diff --stat ${base}...${branchName}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10000,
    });

    // Get name-status for file counts
    const nameStatus = execSync(`git diff --name-status ${base}...${branchName}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10000,
    });

    let linesAdded = 0;
    let linesRemoved = 0;

    // Parse --stat summary line: " N files changed, X insertions(+), Y deletions(-)"
    const statLines = stat.trim().split("\n");
    const summaryLine = statLines[statLines.length - 1] ?? "";
    const insertMatch = summaryLine.match(/(\d+)\s+insertion/);
    const deleteMatch = summaryLine.match(/(\d+)\s+deletion/);
    if (insertMatch) linesAdded = parseInt(insertMatch[1], 10);
    if (deleteMatch) linesRemoved = parseInt(deleteMatch[1], 10);

    // Parse name-status
    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;

    for (const line of nameStatus.trim().split("\n")) {
      if (!line.trim()) continue;
      const status = line.charAt(0);
      if (status === "A") filesAdded++;
      else if (status === "M") filesModified++;
      else if (status === "D") filesDeleted++;
      else filesModified++; // R, C, etc. count as modified
    }

    return {
      linesAdded,
      linesRemoved,
      linesChanged: linesAdded + linesRemoved,
      filesAdded,
      filesModified,
      filesDeleted,
      totalFiles: filesAdded + filesModified + filesDeleted,
      branchName,
    };
  } catch {
    // Branch may have been deleted, merge-base may fail
    return null;
  }
}

// ─── Efficiency Scoring ───────────────────────────────────────────

export function computeEfficiencyBaseline(analyses: DispatchAnalysis[]): EfficiencyBaseline | null {
  // Only use approved dispatches with code metrics for baseline
  const qualified = analyses.filter(
    (a) => a.outcome === "approved" && a.linesPerMinute !== null && a.linesPerMinute > 0,
  );

  if (qualified.length < 3) return null;

  const lpmValues = qualified.map((a) => a.linesPerMinute!);
  const cplValues = qualified
    .filter((a) => a.costPerLine !== null && a.costPerLine > 0)
    .map((a) => a.costPerLine!);

  const meanLPM = mean(lpmValues);
  const stdLPM = stdDev(lpmValues, meanLPM);
  const meanCPL = cplValues.length > 0 ? mean(cplValues) : 0;
  const stdCPL = cplValues.length > 0 ? stdDev(cplValues, meanCPL) : 0;

  return {
    meanLinesPerMinute: meanLPM,
    stdDevLinesPerMinute: stdLPM,
    meanCostPerLine: meanCPL,
    stdDevCostPerLine: stdCPL,
    sampleCount: qualified.length,
    lastUpdated: new Date().toISOString(),
  };
}

export function computeEfficiencyScore(
  linesPerMinute: number,
  baseline: EfficiencyBaseline,
): number {
  if (baseline.stdDevLinesPerMinute === 0) return 50;
  const zScore = (linesPerMinute - baseline.meanLinesPerMinute) / baseline.stdDevLinesPerMinute;
  // Map z-score to 0-100 percentile (approximate via sigmoid)
  const percentile = 100 / (1 + Math.exp(-zScore * 0.7));
  return Math.round(Math.min(100, Math.max(0, percentile)));
}

export function detectAnomalies(
  analysis: DispatchAnalysis,
  baseline: EfficiencyBaseline | null,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  // No flags for dispatches without code output
  if (analysis.codeMetrics === null || analysis.linesPerMinute === null) {
    return flags;
  }

  if (!baseline || baseline.sampleCount < 3) return flags;

  const lpm = analysis.linesPerMinute;
  const agentMinutes = analysis.durationMs / 60000;
  const linesChanged = analysis.codeMetrics.linesChanged;

  // too_slow: linesPerMinute < mean - 1.5σ AND duration > 30min
  const slowThreshold = baseline.meanLinesPerMinute - 1.5 * baseline.stdDevLinesPerMinute;
  if (lpm < slowThreshold && agentMinutes > 30) {
    flags.push({
      type: "too_slow",
      message: `${lpm.toFixed(1)} lines/min vs baseline ${baseline.meanLinesPerMinute.toFixed(1)} (30+ min dispatch)`,
      value: lpm,
      threshold: slowThreshold,
    });
  }

  // too_fast: linesPerMinute > mean + 2.5σ AND linesChanged > 200
  const fastThreshold = baseline.meanLinesPerMinute + 2.5 * baseline.stdDevLinesPerMinute;
  if (lpm > fastThreshold && linesChanged > 200) {
    flags.push({
      type: "too_fast",
      message: `${lpm.toFixed(1)} lines/min is suspicious (${linesChanged} lines in ${agentMinutes.toFixed(0)} min)`,
      value: lpm,
      threshold: fastThreshold,
    });
  }

  // high_cost_per_line: costPerLine > mean + 2σ
  if (
    analysis.costPerLine !== null &&
    baseline.meanCostPerLine > 0 &&
    baseline.stdDevCostPerLine > 0
  ) {
    const costThreshold = baseline.meanCostPerLine + 2 * baseline.stdDevCostPerLine;
    if (analysis.costPerLine > costThreshold) {
      flags.push({
        type: "high_cost_per_line",
        message: `$${analysis.costPerLine.toFixed(4)}/line vs baseline $${baseline.meanCostPerLine.toFixed(4)}`,
        value: analysis.costPerLine,
        threshold: costThreshold,
      });
    }
  }

  // low_output: duration > 30min AND linesChanged < 10 AND outcome = approved
  if (agentMinutes > 30 && linesChanged < 10 && analysis.outcome === "approved") {
    flags.push({
      type: "low_output",
      message: `Only ${linesChanged} lines changed in ${agentMinutes.toFixed(0)} min (approved)`,
      value: linesChanged,
      threshold: 10,
    });
  }

  return flags;
}

// ─── Full Analysis Builder ────────────────────────────────────────

export interface WorkerProvenance {
  workerHostId?: string;
  workerHostAlias?: string;
  workerHostEndpoint?: string;
  executionMode: "direct" | "federated" | "remote" | "unknown";
  federatedJobId?: string;
  federatedLeaseId?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function inferWorkerProvenance(events: QuackEvent[]): WorkerProvenance {
  const result: WorkerProvenance = { executionMode: "direct" };

  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const eventLike = event as unknown as Record<string, unknown>;
    const hostId =
      stringValue(payload.hostId) ??
      stringValue(payload.workerHostId) ??
      stringValue(eventLike.hostId);
    const hostAlias = stringValue(payload.hostAlias) ?? stringValue(payload.workerHostAlias);
    const hostEndpoint =
      stringValue(payload.hostEndpoint) ??
      stringValue(payload.workerHostEndpoint) ??
      stringValue(payload.baseUrl);
    const jobId = stringValue(payload.jobId) ?? stringValue(payload.federatedJobId);
    const leaseId = stringValue(payload.leaseId) ?? stringValue(payload.federatedLeaseId);

    if (hostId) result.workerHostId = hostId;
    if (hostAlias) result.workerHostAlias = hostAlias;
    if (hostEndpoint) result.workerHostEndpoint = hostEndpoint;
    if (jobId) result.federatedJobId = jobId;
    if (leaseId) result.federatedLeaseId = leaseId;

    if (event.stage === "federated_job_status" || event.stage === "federated_job_event" || jobId) {
      result.executionMode = "federated";
    } else if (hostId && result.executionMode !== "federated") {
      result.executionMode = "remote";
    }
  }

  if (!result.workerHostId && result.executionMode === "remote") {
    result.executionMode = "unknown";
  }

  return result;
}

export function buildAnalysis(
  session: SessionEntry,
  events: QuackEvent[],
  projectRoot: string,
  baseline: EfficiencyBaseline | null,
): DispatchAnalysis {
  const stageTimings = computeStageTimings(events);
  const codeMetrics = computeCodeMetrics(events, projectRoot);
  const workerProvenance = inferWorkerProvenance(events);

  // Compute lines per minute from agent stage duration
  const agentTiming = stageTimings.find((t) => t.stage === "agent");
  const agentMinutes = agentTiming
    ? agentTiming.durationMs / 60000
    : (session.durationMs ?? 0) / 60000;

  let linesPerMinute: number | null = null;
  let costPerLine: number | null = null;
  let efficiencyScore: number | null = null;

  if (codeMetrics && codeMetrics.linesChanged > 0 && agentMinutes > 0) {
    linesPerMinute = codeMetrics.linesChanged / agentMinutes;

    const cost = session.totalCostUsd ?? 0;
    if (cost > 0) {
      costPerLine = cost / codeMetrics.linesChanged;
    }

    if (baseline) {
      efficiencyScore = computeEfficiencyScore(linesPerMinute, baseline);
    }
  }

  const analysis: DispatchAnalysis = {
    sessionId: session.sessionId,
    taskId: session.taskId,
    taskTitle: session.title,
    project: session.project,
    outcome: session.outcome ?? session.status,
    startTime: session.startTime,
    durationMs: session.durationMs ?? 0,
    totalCostUsd: session.totalCostUsd ?? 0,
    turnsUsed: session.turnsUsed ?? 0,
    stageTimings,
    codeMetrics,
    linesPerMinute,
    costPerLine,
    efficiencyScore,
    anomalies: [],
    ...workerProvenance,
    analyzedAt: new Date().toISOString(),
  };

  analysis.anomalies = detectAnomalies(analysis, baseline);

  return analysis;
}

// ─── Federated Wrapper Normalization ────────────────────────────────────────

const FEDERATION_SESSION_PREFIX = "federation-";

function isFederatedLifecycleOutcome(outcome: string): boolean {
  return outcome.toLowerCase().startsWith("federated_job_");
}

export function isFederationWrapperAnalysis(analysis: DispatchAnalysis): boolean {
  return (
    analysis.sessionId.startsWith(FEDERATION_SESSION_PREFIX) ||
    isFederatedLifecycleOutcome(analysis.outcome)
  );
}

export function analysisFederatedJobKey(analysis: DispatchAnalysis): string | null {
  if (analysis.federatedJobId) return analysis.federatedJobId;
  if (analysis.sessionId.startsWith(FEDERATION_SESSION_PREFIX)) {
    return analysis.sessionId.slice(FEDERATION_SESSION_PREFIX.length);
  }
  return null;
}

function mergeWorkerProvenance(
  target: DispatchAnalysis,
  source: DispatchAnalysis,
): DispatchAnalysis {
  const merged: DispatchAnalysis = { ...target };
  if (!merged.workerHostId && source.workerHostId) {
    merged.workerHostId = source.workerHostId;
  }
  if (!merged.workerHostAlias && source.workerHostAlias) {
    merged.workerHostAlias = source.workerHostAlias;
  }
  if (!merged.workerHostEndpoint && source.workerHostEndpoint) {
    merged.workerHostEndpoint = source.workerHostEndpoint;
  }
  if (!merged.federatedJobId && source.federatedJobId) {
    merged.federatedJobId = source.federatedJobId;
  }
  if (!merged.federatedLeaseId && source.federatedLeaseId) {
    merged.federatedLeaseId = source.federatedLeaseId;
  }
  if ((!merged.executionMode || merged.executionMode === "unknown") && source.executionMode) {
    merged.executionMode = source.executionMode;
  }
  return merged;
}

/**
 * Research history stores both real worker sessions and Headnode federation
 * ledger sessions. The ledger session is useful only when no worker run exists;
 * once a worker run exists for the same job, keep the worker run and copy any
 * missing host attribution from the wrapper.
 */
export function normalizeResearchAnalyses(analyses: DispatchAnalysis[]): DispatchAnalysis[] {
  const wrappersByJob = new Map<string, DispatchAnalysis[]>();
  const realByJob = new Map<string, DispatchAnalysis[]>();

  for (const analysis of analyses) {
    const jobKey = analysisFederatedJobKey(analysis);
    if (!jobKey) continue;

    const bucket = isFederationWrapperAnalysis(analysis) ? wrappersByJob : realByJob;
    const existing = bucket.get(jobKey) ?? [];
    existing.push(analysis);
    bucket.set(jobKey, existing);
  }

  const replacementBySession = new Map<string, DispatchAnalysis>();
  const droppedSessions = new Set<string>();

  for (const [jobKey, wrappers] of wrappersByJob.entries()) {
    const realAnalyses = realByJob.get(jobKey) ?? [];
    if (realAnalyses.length === 0) continue;

    const provenanceSource =
      wrappers.find(
        (wrapper) =>
          wrapper.workerHostId ||
          wrapper.workerHostAlias ||
          wrapper.workerHostEndpoint ||
          wrapper.federatedLeaseId,
      ) ?? wrappers[0];

    for (const real of realAnalyses) {
      replacementBySession.set(real.sessionId, mergeWorkerProvenance(real, provenanceSource));
    }
    for (const wrapper of wrappers) {
      droppedSessions.add(wrapper.sessionId);
    }
  }

  return analyses
    .filter((analysis) => !droppedSessions.has(analysis.sessionId))
    .map((analysis) => replacementBySession.get(analysis.sessionId) ?? analysis);
}

// ─── Experiment Readiness ─────────────────────────────────────────

export function computeExperimentReadiness(analyses: DispatchAnalysis[]): ExperimentReadiness[] {
  const areas = [
    "gate",
    "blueprint",
    "context",
    "agent",
    "judge",
    "preflight_total",
    "preflight_gate",
    "preflight_spec_review",
    "preflight_blueprint",
    "preflight_analysis",
  ];
  const results: ExperimentReadiness[] = [];

  // Total average duration across all analyses
  const totalAvgDuration =
    analyses.length > 0 ? analyses.reduce((s, a) => s + a.durationMs, 0) / analyses.length : 0;

  for (const area of areas) {
    const dataPoints = analyses.filter((a) => a.stageTimings.some((t) => t.stage === area)).length;

    const durations = analyses
      .map((a) => a.stageTimings.find((t) => t.stage === area)?.durationMs ?? 0)
      .filter((d) => d > 0);

    const avgDuration =
      durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

    const pctOfTotal = totalAvgDuration > 0 ? (avgDuration / totalAvgDuration) * 100 : 0;

    results.push({
      area,
      dataPoints,
      avgDurationMs: Math.round(avgDuration),
      pctOfTotal: Math.round(pctOfTotal * 10) / 10,
      baselineReady: dataPoints >= 5,
    });
  }

  return results;
}

// ─── Trends ───────────────────────────────────────────────────────

export function computeTrends(analyses: DispatchAnalysis[]): TrendEntry[] {
  const byDay = new Map<string, DispatchAnalysis[]>();

  for (const a of analyses) {
    const day = a.startTime.slice(0, 10);
    const existing = byDay.get(day) ?? [];
    existing.push(a);
    byDay.set(day, existing);
  }

  const entries: TrendEntry[] = [];

  for (const [date, dayAnalyses] of Array.from(byDay.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const lpmValues = dayAnalyses
      .filter((a) => a.linesPerMinute !== null)
      .map((a) => a.linesPerMinute!);
    const cplValues = dayAnalyses.filter((a) => a.costPerLine !== null).map((a) => a.costPerLine!);

    entries.push({
      date,
      avgLinesPerMinute: lpmValues.length > 0 ? mean(lpmValues) : null,
      avgCostPerLine: cplValues.length > 0 ? mean(cplValues) : null,
      dispatches: dayAnalyses.length,
      approvedCount: dayAnalyses.filter((a) => a.outcome === "approved").length,
      anomalyCount: dayAnalyses.reduce((sum, a) => sum + a.anomalies.length, 0),
    });
  }

  return entries;
}

// ─── Math helpers ─────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
