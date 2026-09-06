// TASK-1339-A R6: the CLI prints skipped ids and exits nonzero.

import { loadAdapter } from "../../src/core/adapter-loader";
import { handleSync } from "../../src/cli/sync";
import { syncAllTasks } from "../../src/integrations/github/status-syncer";

jest.mock("../../src/core/adapter-loader", () => ({ loadAdapter: jest.fn() }));
jest.mock("../../src/integrations/github/status-syncer", () => ({
  syncAllTasks: jest.fn(),
  getSyncStatus: jest.fn(),
}));

describe("TASK-1339-A: CLI sync outcome", () => {
  afterEach(() => jest.restoreAllMocks());

  it("prints every skipped id and exits with code 1", async () => {
    (loadAdapter as jest.MockedFunction<typeof loadAdapter>).mockResolvedValue({
      config: { integrations: { github: { owner: "fixture", repo: "fixture" } } },
    } as never);
    (syncAllTasks as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue({
      outcomes: [
        {
          taskId: "TASK-100-parent",
          issueNumber: 42,
          outcome: "skipped",
          reason: "task_file_unresolvable",
        },
        {
          taskId: "TASK-200-old",
          issueNumber: 43,
          outcome: "skipped",
          reason: "sync_failed",
          message: "fixture",
        },
      ],
    });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await handleSync({ github: true, project: "." });

    const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(output).toContain("TASK-100-parent");
    expect(output).toContain("TASK-200-old");
    expect(output).toContain("Skipped TASK-200-old: sync_failed message=fixture");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
