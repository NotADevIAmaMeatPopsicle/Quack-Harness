// ─── Research Routes ──────────────────────────────────────────────
// REST API routes for the Research tab: dispatch analysis dashboard,
// single analysis detail, and rebuild-from-history endpoint.

import type { Express, Request, Response } from "express";
import * as path from "node:path";

import type { ProjectContext } from "./analytics.js";
import { EventReader } from "../event-reader.js";
import { ResearchStore } from "../../research/research-store.js";
import {
  computeExperimentReadiness,
  computeTrends,
  inferWorkerProvenance,
  normalizeResearchAnalyses,
} from "../../research/research-analyzer.js";
import type {
  DispatchAnalysis,
  ResearchDashboard,
  ValidationDriftByWorkerEntry,
  ValidationFailureTaxonomy,
  ValidationFailureTaxonomyCounts,
} from "../../research/research-types.js";

function enrichWorkerProvenance(
  projectRoot: string,
  analyses: DispatchAnalysis[],
): DispatchAnalysis[] {
  const reader = new EventReader(path.join(projectRoot, ".quack", "logs"));
  return analyses.map((analysis) => {
    const needsEventReplay =
      !analysis.executionMode ||
      !analysis.workerHostId ||
      (analysis.executionMode === "federated" && !analysis.federatedJobId) ||
      analysis.sessionId.startsWith("federation-");

    if (!needsEventReplay) {
      return analysis;
    }
    try {
      const inferred = inferWorkerProvenance(reader.getSessionEvents(analysis.sessionId));
      return {
        ...analysis,
        workerHostId: analysis.workerHostId ?? inferred.workerHostId,
        workerHostAlias: analysis.workerHostAlias ?? inferred.workerHostAlias,
        workerHostEndpoint: analysis.workerHostEndpoint ?? inferred.workerHostEndpoint,
        executionMode: analysis.executionMode ?? inferred.executionMode,
        federatedJobId: analysis.federatedJobId ?? inferred.federatedJobId,
        federatedLeaseId: analysis.federatedLeaseId ?? inferred.federatedLeaseId,
      };
    } catch {
      return {
        ...analysis,
        executionMode: "unknown",
      };
    }
  });
}

function normalizedWorkerKey(analysis: DispatchAnalysis): string {
  const raw =
    analysis.workerHostAlias ?? analysis.workerHostId ?? analysis.executionMode ?? "unknown";
  const key = raw.trim().toLowerCase();
  if (key === "headnode") return "headnode";
  if (key === "laptop" || key === "example laptop") return "worker-laptop";
  if (analysis.sessionId.startsWith("federation-")) return "federation-ledger";
  return key || "unknown";
}

const VALIDATION_TAXONOMY: ValidationFailureTaxonomy[] = [
  "stale_adapter",
  "refreshed_adapter",
  "validation_class_mismatch",
];

function emptyValidationTaxonomy(): ValidationFailureTaxonomyCounts {
  return {
    stale_adapter: 0,
    refreshed_adapter: 0,
    validation_class_mismatch: 0,
  };
}

function classifyValidationDrift(analysis: DispatchAnalysis): ValidationFailureTaxonomy[] {
  const found = new Set<ValidationFailureTaxonomy>();
  for (const anomaly of analysis.anomalies ?? []) {
    const type = String(anomaly.type);
    const message = anomaly.message.toLowerCase();
    for (const key of VALIDATION_TAXONOMY) {
      if (type === key || message.includes(key.replace(/_/g, " "))) {
        found.add(key);
      }
    }
    if (message.includes("stale adapter")) found.add("stale_adapter");
    if (message.includes("refreshed adapter") || message.includes("adapter bundle was refreshed")) {
      found.add("refreshed_adapter");
    }
    if (message.includes("validation class")) found.add("validation_class_mismatch");
  }
  return [...found];
}

function computeValidationDriftSummary(analyses: DispatchAnalysis[]): {
  validationDriftRuns: number;
  validationFailureTaxonomy: ValidationFailureTaxonomyCounts;
  validationDriftByWorker: ValidationDriftByWorkerEntry[];
} {
  const validationFailureTaxonomy = emptyValidationTaxonomy();
  const byWorker = new Map<string, ValidationDriftByWorkerEntry>();
  let validationDriftRuns = 0;

  for (const analysis of analyses) {
    const classes = classifyValidationDrift(analysis);
    if (classes.length === 0) continue;
    validationDriftRuns += 1;

    const worker = normalizedWorkerKey(analysis);
    const workerEntry = byWorker.get(worker) ?? {
      worker,
      total: 0,
      ...emptyValidationTaxonomy(),
    };
    workerEntry.total += 1;

    for (const key of classes) {
      validationFailureTaxonomy[key] += 1;
      workerEntry[key] += 1;
    }
    byWorker.set(worker, workerEntry);
  }

  return {
    validationDriftRuns,
    validationFailureTaxonomy,
    validationDriftByWorker: [...byWorker.values()].sort(
      (a, b) => b.total - a.total || a.worker.localeCompare(b.worker),
    ),
  };
}

export function registerResearchRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
): void {
  // ─── GET /api/research/dashboard ─────────────────────────────────
  app.get("/api/research/dashboard", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const store = new ResearchStore(p.projectRoot);
      const data = store.load();
      let analyses = normalizeResearchAnalyses(
        enrichWorkerProvenance(p.projectRoot, data.analyses),
      );

      // Optional filters
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const outcome = req.query.outcome as string | undefined;

      if (from) {
        analyses = analyses.filter((a) => a.startTime >= from);
      }
      if (to) {
        analyses = analyses.filter((a) => a.startTime <= to);
      }
      if (outcome) {
        analyses = analyses.filter((a) => a.outcome === outcome);
      }

      // Compute derived data
      const experimentReadiness = computeExperimentReadiness(analyses);
      const trends = computeTrends(analyses);

      // Summary stats
      const lpmValues = analyses
        .filter((a) => a.linesPerMinute !== null)
        .map((a) => a.linesPerMinute!);
      const cplValues = analyses.filter((a) => a.costPerLine !== null).map((a) => a.costPerLine!);
      const workerKeys = new Set(analyses.map((a) => normalizedWorkerKey(a)));
      const validationDriftSummary = computeValidationDriftSummary(analyses);

      const dashboard: ResearchDashboard = {
        analyses: analyses.sort(
          (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
        ),
        baseline: data.baseline,
        experimentReadiness,
        trends,
        lastRebuilt: data.lastRebuilt,
        summary: {
          totalAnalyzed: analyses.length,
          avgLinesPerMinute:
            lpmValues.length > 0 ? lpmValues.reduce((s, v) => s + v, 0) / lpmValues.length : null,
          avgCostPerLine:
            cplValues.length > 0 ? cplValues.reduce((s, v) => s + v, 0) / cplValues.length : null,
          totalAnomalies: analyses.reduce((sum, a) => sum + a.anomalies.length, 0),
          workerCount: workerKeys.size,
          federatedRuns: analyses.filter((a) => a.executionMode === "federated").length,
          directRuns: analyses.filter((a) => !a.executionMode || a.executionMode === "direct")
            .length,
          failedRuns: analyses.filter((a) =>
            ["rejected", "error", "agent_failed", "failed"].includes(a.outcome),
          ).length,
          ...validationDriftSummary,
        },
      };

      res.json(dashboard);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load research data: ${msg}` });
    }
  });

  // ─── GET /api/research/analyses/:sessionId ───────────────────────
  app.get("/api/research/analyses/:sessionId", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const store = new ResearchStore(p.projectRoot);
      const data = store.load();
      const analysis = normalizeResearchAnalyses(
        enrichWorkerProvenance(p.projectRoot, data.analyses),
      ).find((a) => a.sessionId === req.params.sessionId);

      if (!analysis) {
        res.status(404).json({ error: "Analysis not found" });
        return;
      }

      res.json(analysis);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load analysis: ${msg}` });
    }
  });

  // ─── POST /api/research/rebuild ──────────────────────────────────
  app.post("/api/research/rebuild", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const logDir = path.join(p.projectRoot, ".quack", "logs");
      const reader = new EventReader(logDir);
      const store = new ResearchStore(p.projectRoot);
      const data = store.rebuild(reader, p.projectRoot);

      res.json({
        success: true,
        totalAnalyzed: data.analyses.length,
        baseline: data.baseline,
        lastRebuilt: data.lastRebuilt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Rebuild failed: ${msg}` });
    }
  });
}
