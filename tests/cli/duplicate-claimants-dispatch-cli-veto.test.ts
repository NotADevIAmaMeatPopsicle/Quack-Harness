// CONTROL: CLI error formatting cannot independently red because dispatchTask
// is the shared veto seam. The real-file dispatcher matrix covers the veto.
// These controls prove both direct callers preserve stderr plus exit 1.

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { runCommand } from "../../src/cli/run";
import { reviseCommand } from "../../src/cli/revise";
import { formatDuplicateClaimantsMessage } from "../../src/core/duplicate-claimants";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  removeFixture,
} from "../helpers/duplicate-claimants-fixture";

const mockDispatchTask = jest.fn();
const mockLoadAdapter = jest.fn();

jest.mock("../../src/core/adapter-loader", () => ({
  loadAdapter: (...args: unknown[]) => mockLoadAdapter(...args) as Promise<ProjectAdapter>,
}));

jest.mock("../../src/dispatcher/dispatcher", () => ({
  dispatchTask: (...args: unknown[]) => mockDispatchTask(...args) as Promise<unknown>,
}));

function adapter(projectRoot: string): ProjectAdapter {
  return {
    projectRoot,
    adapterPath: `${projectRoot}/.quack/adapter.json`,
    conventions: "",
    config: {
      project: {
        name: "fixture",
        language: "typescript",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: { model: "fixture", maxTurns: 10, maxBudgetPerTask: 1, maxRetries: 0 },
    },
  } as unknown as ProjectAdapter;
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "direct CLI duplicate claimant refusal (%s, %s)",
  (kind, order) => {
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      jest.clearAllMocks();
    });

    it("quack run reports the refusal on stderr and exits 1", async () => {
      const fixture = createDuplicateFixture("quack-cli-run-", kind, order);
      const message = formatDuplicateClaimantsMessage("TASK-100", fixture.claimants);
      try {
        mockLoadAdapter.mockResolvedValue(adapter(fixture.root));
        mockDispatchTask.mockRejectedValue(new Error(message));

        await runCommand("TASK-100", { project: fixture.root });

        expect(errorSpy).toHaveBeenCalledWith(`Error: ${message}`);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        removeFixture(fixture.root);
      }
    });

    it("quack revise reports the refusal on stderr and exits 1", async () => {
      const fixture = createDuplicateFixture("quack-cli-revise-", kind, order);
      const message = formatDuplicateClaimantsMessage("TASK-100", fixture.claimants);
      try {
        mockLoadAdapter.mockResolvedValue(adapter(fixture.root));
        mockDispatchTask.mockRejectedValue(new Error(message));

        await reviseCommand("TASK-100", {
          project: fixture.root,
          feedback: "retry the fixture",
        });

        expect(errorSpy).toHaveBeenCalledWith(`Error: ${message}`);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);
