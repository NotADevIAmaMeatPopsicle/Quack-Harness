// ─── Snapshot signal re-derivation (TASK-1313 S2/S4) ────────────────
// Producer blocks from a (possibly checkpoint-restored) sealed snapshot,
// with a manifest re-read fallback for checkpoints predating the
// AgentOutputSnapshot extension, plus the stage-signal builder and the
// fail-closed safety-stop predicate. Extracted from the dispatcher
// (round-2 F10) so re-derivation is testable in isolation; the
// dispatcher delegates here with its resolved safetyFloor mode.

import * as fs from "node:fs/promises";

import type { AgentOutputSnapshot } from "../../core/types.js";
import type { JudgmentSignal } from "../judgment-types.js";
import type { SafetySignalsMode } from "../runner/intent-judgment-config.js";
import { factsToSignals, type InjectionInput } from "./signal-injection.js";

export interface ProducerBlocks {
  sealConformance?: AgentOutputSnapshot["sealConformance"];
  secretScan?: AgentOutputSnapshot["secretScan"];
  advisory?: JudgmentSignal;
}

/**
 * Load producer blocks for signal re-derivation. Typed snapshot fields
 * win (no disk read); otherwise the manifest is re-read for checkpoints
 * sealed before the typed extension. A manifest without blocks is a
 * genuinely pre-extension seal (`conformance_unavailable`); an
 * unreadable manifest is `conformance_unreadable`. Both surface as
 * ordinary advisory signals, never silent absence.
 */
export async function loadProducerBlocks(snapshot: AgentOutputSnapshot): Promise<ProducerBlocks> {
  if (snapshot.sealConformance || snapshot.secretScan) {
    return {
      sealConformance: snapshot.sealConformance,
      secretScan: snapshot.secretScan,
    };
  }
  try {
    const raw = await fs.readFile(snapshot.manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      sealConformance?: AgentOutputSnapshot["sealConformance"];
      secretScan?: AgentOutputSnapshot["secretScan"];
    };
    if (parsed.sealConformance || parsed.secretScan) {
      return {
        sealConformance: parsed.sealConformance,
        secretScan: parsed.secretScan,
      };
    }
    return {
      advisory: {
        source: "judge",
        code: "conformance_unavailable",
        disposition: "advisory",
        message: "Sealed snapshot predates producer blocks; conformance signals unavailable",
        deterministic: true,
      },
    };
  } catch {
    return {
      advisory: {
        source: "judge",
        code: "conformance_unreadable",
        disposition: "advisory",
        message: "Sealed snapshot manifest could not be read for conformance re-derivation",
        deterministic: true,
      },
    };
  }
}

/**
 * Build the injected stage signals for a sealed snapshot plus worker-run
 * facts. Off mode injects nothing; any load advisory is re-tagged to the
 * requesting stage.
 */
export async function buildInjectedSignals(
  stage: "loop_diff" | "judge",
  snapshot: AgentOutputSnapshot,
  workerFacts: InjectionInput["workerFacts"],
  mode: SafetySignalsMode,
): Promise<JudgmentSignal[]> {
  if (mode === "off") return [];
  const blocks = await loadProducerBlocks(snapshot);
  const signals = factsToSignals(
    stage,
    {
      sealConformance: blocks.sealConformance,
      secretScan: blocks.secretScan,
      workerFacts: workerFacts ?? [],
    },
    mode,
  );
  if (blocks.advisory) signals.push({ ...blocks.advisory, source: stage });
  return signals;
}

/**
 * Whether an enforce-mode dispatch must take the safety_stop transition.
 * A projection failure fails CLOSED on the injected signals themselves.
 */
export function safetyStopRequested(
  decision: { action: string } | undefined,
  injected: JudgmentSignal[],
  mode: SafetySignalsMode,
): boolean {
  if (mode !== "enforce") return false;
  if (decision) return decision.action === "stop";
  return injected.some((signal) => signal.disposition === "safety");
}
