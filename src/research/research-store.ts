// ─── Research Store ────────────────────────────────────────────────
// Persistence layer: load/save/append analyses to .quack/research/analyses.json.
// Rebuilds from session history on demand.

import * as fs from "node:fs";
import * as path from "node:path";

import { EventReader } from "../monitor/event-reader.js";
import type { DispatchAnalysis, ResearchStoreData } from "./research-types.js";
import {
  buildAnalysis,
  computeEfficiencyBaseline,
  computeEfficiencyScore,
  detectAnomalies,
  normalizeResearchAnalyses,
} from "./research-analyzer.js";

export class ResearchStore {
  private readonly storePath: string;

  constructor(projectRoot: string) {
    const dir = path.join(projectRoot, ".quack", "research");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.storePath = path.join(dir, "analyses.json");
  }

  load(): ResearchStoreData {
    if (!fs.existsSync(this.storePath)) {
      return { analyses: [], baseline: null, lastRebuilt: null };
    }
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      return JSON.parse(raw) as ResearchStoreData;
    } catch {
      return { analyses: [], baseline: null, lastRebuilt: null };
    }
  }

  save(data: ResearchStoreData): void {
    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Analyze a single completed session and append to the store.
   * Non-fatal — returns the analysis or null on error.
   */
  appendAnalysis(
    sessionId: string,
    reader: EventReader,
    projectRoot: string,
  ): DispatchAnalysis | null {
    try {
      const sessions = reader.getExecutionSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return null;

      // Skip active sessions
      if (session.status === "active") return null;

      const events = reader.getSessionEvents(sessionId);
      if (events.length === 0) return null;

      const data = this.load();

      // Don't re-analyze existing sessions
      if (data.analyses.some((a) => a.sessionId === sessionId)) return null;

      const analysis = buildAnalysis(session, events, projectRoot, data.baseline);
      data.analyses = normalizeResearchAnalyses([...data.analyses, analysis]);

      // Recompute baseline after adding
      data.baseline = computeEfficiencyBaseline(data.analyses);

      this.save(data);
      return data.analyses.find((a) => a.sessionId === sessionId) ?? null;
    } catch (err) {
      console.error("[research-store] appendAnalysis failed (non-fatal):", err);
      return null;
    }
  }

  /**
   * Rebuild all analyses from session history.
   */
  rebuild(reader: EventReader, projectRoot: string): ResearchStoreData {
    const sessions = reader.getExecutionSessions();
    const analyses: DispatchAnalysis[] = [];

    // First pass: build analyses without baseline
    for (const session of sessions) {
      if (session.status === "active") continue;

      const events = reader.getSessionEvents(session.sessionId);
      if (events.length === 0) continue;

      const analysis = buildAnalysis(session, events, projectRoot, null);
      analyses.push(analysis);
    }

    const normalizedAnalyses = normalizeResearchAnalyses(analyses);

    // Compute baseline from first pass
    const baseline = computeEfficiencyBaseline(normalizedAnalyses);

    // Second pass: re-score with baseline and detect anomalies
    if (baseline) {
      for (const analysis of normalizedAnalyses) {
        if (analysis.linesPerMinute !== null && analysis.linesPerMinute > 0) {
          analysis.efficiencyScore = computeEfficiencyScore(analysis.linesPerMinute, baseline);
        }
        analysis.anomalies = detectAnomalies(analysis, baseline);
      }
    }

    const data: ResearchStoreData = {
      analyses: normalizedAnalyses,
      baseline,
      lastRebuilt: new Date().toISOString(),
    };

    this.save(data);
    return data;
  }
}
