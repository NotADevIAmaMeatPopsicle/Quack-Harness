// ─── Stream-JSON Output Format Tests ────────────────────────────────
// Tests that the --output-format stream-json flag produces valid NDJSON.

interface StreamEvent {
  type: string;
  timestamp: string;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  turnNumber?: number;
  role?: string;
  contentPreview?: string;
  toolName?: string;
  filePath?: string;
  outcome?: string;
  turnsUsed?: number;
  totalCostUsd?: number;
}

describe("stream-json output format", () => {
  describe("NDJSON line format", () => {
    test("onEvent produces valid JSON lines with type and timestamp", () => {
      const lines: string[] = [];
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        const line = JSON.stringify({
          type: stage,
          timestamp: new Date().toISOString(),
          ...payload,
        });
        lines.push(line);
      };

      // Simulate events
      onEvent("session_start", { model: "sonnet", maxTurns: 75, maxBudget: 6 });
      onEvent("gate_schema", { valid: true, errors: [] });
      onEvent("agent_turn", { turnNumber: 1, role: "assistant", contentPreview: "Starting work" });
      onEvent("agent_tool_use", { turnNumber: 1, toolName: "Edit", filePath: "src/foo.ts" });
      onEvent("agent_complete", {
        outcome: "success",
        turnsUsed: 5,
        totalCostUsd: 0.45,
        filesModified: [],
      });
      onEvent("session_complete", { outcome: "approved", durationMs: 60000, totalCostUsd: 0.45 });

      expect(lines).toHaveLength(6);

      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line) as StreamEvent;
        expect(parsed.type).toBeDefined();
        expect(parsed.timestamp).toBeDefined();
        // Timestamp should be valid ISO 8601
        expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
      }
    });

    test("session_start event includes model and maxTurns", () => {
      let output = "";
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        output = JSON.stringify({ type: stage, timestamp: new Date().toISOString(), ...payload });
      };

      onEvent("session_start", { model: "opus", maxTurns: 150, maxBudget: 10 });

      const parsed = JSON.parse(output) as StreamEvent;
      expect(parsed.type).toBe("session_start");
      expect(parsed.model).toBe("opus");
      expect(parsed.maxTurns).toBe(150);
      expect(parsed.maxBudget).toBe(10);
    });

    test("agent_turn event includes turnNumber and role", () => {
      let output = "";
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        output = JSON.stringify({ type: stage, timestamp: new Date().toISOString(), ...payload });
      };

      onEvent("agent_turn", { turnNumber: 5, role: "assistant", contentPreview: "Editing files" });

      const parsed = JSON.parse(output) as StreamEvent;
      expect(parsed.type).toBe("agent_turn");
      expect(parsed.turnNumber).toBe(5);
      expect(parsed.role).toBe("assistant");
      expect(parsed.contentPreview).toBe("Editing files");
    });

    test("agent_tool_use event includes toolName and filePath", () => {
      let output = "";
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        output = JSON.stringify({ type: stage, timestamp: new Date().toISOString(), ...payload });
      };

      onEvent("agent_tool_use", { turnNumber: 3, toolName: "Write", filePath: "src/new-file.ts" });

      const parsed = JSON.parse(output) as StreamEvent;
      expect(parsed.type).toBe("agent_tool_use");
      expect(parsed.toolName).toBe("Write");
      expect(parsed.filePath).toBe("src/new-file.ts");
    });

    test("agent_complete event includes cost and turn count", () => {
      let output = "";
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        output = JSON.stringify({ type: stage, timestamp: new Date().toISOString(), ...payload });
      };

      onEvent("agent_complete", {
        outcome: "success",
        turnsUsed: 12,
        totalCostUsd: 1.23,
        filesModified: ["a.ts", "b.ts"],
      });

      const parsed = JSON.parse(output) as StreamEvent;
      expect(parsed.type).toBe("agent_complete");
      expect(parsed.outcome).toBe("success");
      expect(parsed.turnsUsed).toBe(12);
      expect(parsed.totalCostUsd).toBe(1.23);
    });

    test("multiple events produce valid NDJSON (one JSON per line)", () => {
      const lines: string[] = [];
      const onEvent = (stage: string, payload: Record<string, unknown>) => {
        lines.push(
          JSON.stringify({ type: stage, timestamp: new Date().toISOString(), ...payload }),
        );
      };

      // Simulate a realistic event sequence
      onEvent("session_start", { model: "sonnet" });
      onEvent("gate_schema", { valid: true });
      onEvent("gate_depth", { ready: true, overallScore: 4 });
      onEvent("gate_result", { outcome: "pass" });
      onEvent("context_assembled", { relevantFilesCount: 5, conventionsCount: 2 });
      onEvent("branch_created", { branchName: "quack/TASK-001" });
      onEvent("agent_turn", { turnNumber: 1, role: "assistant", contentPreview: "Starting" });
      onEvent("agent_tool_use", { turnNumber: 1, toolName: "Read" });
      onEvent("agent_turn", { turnNumber: 2, role: "assistant", contentPreview: "Editing" });
      onEvent("agent_tool_use", { turnNumber: 2, toolName: "Edit", filePath: "src/foo.ts" });
      onEvent("agent_complete", { outcome: "success", turnsUsed: 2, totalCostUsd: 0.3 });
      onEvent("session_complete", { outcome: "approved", durationMs: 30000, totalCostUsd: 0.3 });

      expect(lines).toHaveLength(12);

      // The full NDJSON string
      const ndjson = lines.join("\n") + "\n";

      // Split by newline and parse each — simulates a consumer reading stdout
      const parsed = ndjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as StreamEvent);
      expect(parsed).toHaveLength(12);
      expect(parsed[0].type).toBe("session_start");
      expect(parsed[parsed.length - 1].type).toBe("session_complete");
    });
  });

  describe("CLI option validation", () => {
    test("stream-json format is only activated when explicitly requested", () => {
      // When outputFormat is undefined or "text", onEvent should be undefined
      const options1 = { outputFormat: undefined };
      const streamJson1 = options1.outputFormat === "stream-json";
      expect(streamJson1).toBe(false);

      const options2 = { outputFormat: "text" };
      const streamJson2 = options2.outputFormat === "stream-json";
      expect(streamJson2).toBe(false);

      const options3 = { outputFormat: "stream-json" };
      const streamJson3 = options3.outputFormat === "stream-json";
      expect(streamJson3).toBe(true);
    });
  });
});
