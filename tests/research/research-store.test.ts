import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { persistClaimantDiagnostic } from "../../src/monitor/claimant-diagnostic";
import { EventWriter } from "../../src/monitor/event-emitter";
import { EventReader } from "../../src/monitor/event-reader";
import { ResearchStore } from "../../src/research/research-store";

describe("ResearchStore execution-session boundary", () => {
  it("excludes claimant diagnostics from rebuilt analyses and baselines", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-research-diagnostic-"));
    try {
      const logDir = path.join(root, ".quack", "logs");
      const execution = new EventWriter({
        sessionId: "execution-approved",
        taskId: "TASK-610",
        project: "project-a",
        logDir,
      });
      execution.emit("session_start", { model: "test", maxTurns: 1, maxBudget: 0 });
      execution.recordSession("completed", { outcome: "approved", durationMs: 1000 });
      await persistClaimantDiagnostic({
        logDir,
        project: "project-a",
        diagnostic: {
          kind: "duplicate-claimants",
          taskId: "TASK-610",
          commitSha: "commit-610",
          claimants: ["TASK-610.md", "TASK-999.md"],
          scannerMethod: "on-merge",
          reason: "contested id",
        },
      });

      const rebuilt = new ResearchStore(root).rebuild(new EventReader(logDir), root);

      expect(rebuilt.analyses.map((analysis) => analysis.sessionId)).toEqual([
        "execution-approved",
      ]);
      expect(rebuilt.analyses.some((analysis) => analysis.outcome === "claimant_diagnostic")).toBe(
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
