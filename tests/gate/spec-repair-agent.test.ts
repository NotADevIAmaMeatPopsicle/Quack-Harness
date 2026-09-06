import { repairTaskSpec, _setQueryFn } from "../../src/gate/spec-repair-agent";
import { buildSpecRepairPrompt } from "../../src/gate/spec-repair-prompt";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

// ─── Mock adapter ─────────────────────────────────────────────────

function createMockAdapter(): ProjectAdapter {
  return {
    config: {
      project: { name: "test-project", taskDir: "docs/tasks" },
      agent: {},
      verification: { commands: [] },
    },
    conventionsDoc: "Use TypeScript strict mode.",
    projectRoot: "/test/project",
  } as unknown as ProjectAdapter;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("buildSpecRepairPrompt", () => {
  it("includes raw content and parse error in prompt", () => {
    const rawContent = "# TASK-001: Test\n\n## Problem Statement\nFoo";
    const prompt = buildSpecRepairPrompt(
      rawContent,
      "docs/tasks/TASK-001.md",
      "Missing required field: Testing Requirements",
      "Use strict TypeScript",
    );

    expect(prompt).toContain(rawContent);
    expect(prompt).toContain("Missing required field: Testing Requirements");
    expect(prompt).toContain("docs/tasks/TASK-001.md");
    expect(prompt).toContain("Use strict TypeScript");
  });

  it("handles empty conventions doc", () => {
    const prompt = buildSpecRepairPrompt("# TASK-001", "f.md", "err", "");
    expect(prompt).toContain("No conventions document available");
  });
});

describe("repairTaskSpec", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  it("returns repaired content from SDK", async () => {
    const repairedSpec = [
      "# TASK-001: Test Feature",
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 2 hours",
      "- **Status:** READY",
      "- **Blocked By:** []",
      "- **Tags:** test",
      "",
      "## Problem Statement",
      "Need a test feature.",
      "",
      "## Success Criteria",
      "- Feature works",
      "",
      "## Testing Requirements",
      "- Unit tests added",
    ].join("\n");

    // Mock the query function to yield a success result
    const mockQueryFn = jest.fn().mockImplementation(function* () {
      yield {
        type: "result",
        subtype: "success",
        result: repairedSpec,
      };
    });
    _setQueryFn(mockQueryFn as never);

    const adapter = createMockAdapter();
    const result = await repairTaskSpec(
      "# TASK-001: Test\n## Problem Statement\nFoo",
      "docs/tasks/TASK-001.md",
      "Missing Testing Requirements",
      adapter,
    );

    expect(result).toBe(repairedSpec);
    expect(mockQueryFn).toHaveBeenCalledTimes(1);

    // Verify SDK options
    const calls = mockQueryFn.mock.calls as Array<
      [{ prompt: string; options: Record<string, unknown> }]
    >;
    const callArgs = calls[0][0];
    expect(callArgs.options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(callArgs.options.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.options.maxTurns).toBe(10);
  });

  it("throws on SDK error result", async () => {
    const mockQueryFn = jest.fn().mockImplementation(function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        errors: ["Something went wrong"],
        total_cost_usd: 0.01,
        num_turns: 2,
      };
    });
    _setQueryFn(mockQueryFn as never);

    const adapter = createMockAdapter();
    await expect(repairTaskSpec("content", "file.md", "error", adapter)).rejects.toThrow(
      "Spec repair agent SDK error",
    );
  });

  it("throws when no success result is yielded", async () => {
    const mockQueryFn = jest.fn().mockImplementation(function* () {
      yield { type: "assistant", subtype: undefined };
    });
    _setQueryFn(mockQueryFn as never);

    const adapter = createMockAdapter();
    await expect(repairTaskSpec("content", "file.md", "error", adapter)).rejects.toThrow(
      "returned no success result",
    );
  });

  it("uses custom model and maxTurns when provided", async () => {
    const mockQueryFn = jest.fn().mockImplementation(function* () {
      yield { type: "result", subtype: "success", result: "repaired" };
    });
    _setQueryFn(mockQueryFn as never);

    const adapter = createMockAdapter();
    await repairTaskSpec("content", "file.md", "error", adapter, {
      model: "claude-sonnet-4-6",
      maxTurns: 5,
    });

    const calls = mockQueryFn.mock.calls as Array<
      [{ prompt: string; options: Record<string, unknown> }]
    >;
    const callArgs = calls[0][0];
    expect(callArgs.options.model).toBe("claude-sonnet-4-6");
    expect(callArgs.options.maxTurns).toBe(5);
  });
});
