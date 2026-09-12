// ─── Wiring restraint (TASK-1312, amended TASK-1313) ────────────────
// TASK-1312 pinned producers OUT of every stage-decision module.
// TASK-1313 wires them in DELIBERATELY at exactly one place: the
// dispatcher imports the injection layer + machinery-integrity and
// threads generic JudgmentSignal[] down. The decision modules
// themselves (gate, docs-gate, llm-judge, loop-gate) stay producer-free
// — they accept injected signals as opaque inputs and never import
// producer modules. This test pins BOTH halves of that boundary.

import * as fs from "node:fs";
import * as path from "node:path";

const PRODUCER_FREE_FILES = [
  "src/gate/gate.ts",
  "src/review/docs-gate.ts",
  "src/judge/llm-judge.ts",
  "src/review/loop-gate.ts",
];

// Round-2 F10 (deliberate allowed-list change, reviewed): the
// dispatcher's snapshot re-derivation closures were extracted to
// snapshot-signals.ts (which wraps signal-injection), so the dispatcher
// no longer imports signal-injection directly — its producer surface
// NARROWED to the three modules below. branch-mutation is the single
// fail-closed producer for protected/base branch collision evidence.
const DISPATCHER_ALLOWED_PRODUCER_IMPORTS = [
  "../judgment/producers/snapshot-signals.js",
  "../judgment/producers/machinery-integrity.js",
  "../judgment/producers/branch-mutation.js",
];

describe("TASK-1312/1313 wiring restraint", () => {
  it.each(PRODUCER_FREE_FILES)("%s does not import judgment producers", (relPath) => {
    const filePath = path.join(process.cwd(), relPath);
    const source = fs.readFileSync(filePath, "utf-8");
    expect(source).not.toMatch(/judgment\/producers\//);
  });

  it("dispatcher.ts imports ONLY the sanctioned producer modules", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/dispatcher/dispatcher.ts"),
      "utf-8",
    );
    const imports = [...source.matchAll(/from "([^"]*judgment\/producers\/[^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(imports.sort()).toEqual([...DISPATCHER_ALLOWED_PRODUCER_IMPORTS].sort());
  });
});
