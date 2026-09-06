// TASK-1338-C pre-change record: each matrix arm executed and returned a
// dry-run approval instead of throwing duplicate_claimants. The intended
// rejection assertion failed, and the EventWriter created the log directory.

import * as fs from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../../src/core/adapter-loader";
import { dispatchTask } from "../../src/dispatcher/dispatcher";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  removeFixture,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/dispatcher/worktree-cleanup", () => ({
  safeUnsetCoreWorktree: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: jest.fn().mockImplementation((task: { id: string }) =>
    Promise.resolve({
      taskId: task.id,
      fileAnalyses: [],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: [],
      preconditions: [],
    }),
  ),
  createMinimalBlueprint: (taskId: string) => ({
    taskId,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  }),
}));

describe.each(DUPLICATE_FIXTURE_CASES)("dispatchTask admission veto (%s, %s)", (kind, order) => {
  it("refuses before checkpoint or event-writer artifacts exist", async () => {
    const fixture = createDuplicateFixture("quack-dispatch-admission-", kind, order);
    try {
      writeAdapter(fixture.root);
      const adapter = await loadAdapter(fixture.root);
      const logDir = path.join(fixture.root, ".quack", "logs");
      fs.rmSync(logDir, { recursive: true, force: true });

      await expect(
        dispatchTask("TASK-100", adapter, {
          skipGate: true,
          dryRun: true,
        }),
      ).rejects.toMatchObject({
        code: "duplicate_claimants",
        taskId: "TASK-100",
        claimants: fixture.claimants,
      });

      expect(fs.existsSync(logDir)).toBe(false);
    } finally {
      removeFixture(fixture.root);
    }
  });
});
