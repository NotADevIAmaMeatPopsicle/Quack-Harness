// TASK-1338-B pre-change record: the eight behavioural executions, four
// fixtures times the yes and edit branches, FAILED at the intended exit-code
// and artifact assertions. The clean edit control also FAILED because the
// preview landed beside the task and became a second claimant.

import * as fs from "node:fs";
import * as path from "node:path";

import { enrichCommand } from "../../src/cli/enrich";
import { listDuplicateClaimants } from "../../src/core/task-file-resolver";
import { parseTaskFile } from "../../src/core/task-parser";
import type { GateResult } from "../../src/core/types";
import { runReadinessGate } from "../../src/gate/gate";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  expectNoWriterArtifacts,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

let mockPromptAnswer = "yes";

jest.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_question: string, callback: (answer: string) => void) => callback(mockPromptAnswer),
    close: () => undefined,
  }),
}));
jest.mock("../../src/gate/gate", () => ({ runReadinessGate: jest.fn() }));

const mockedRunReadinessGate = runReadinessGate as jest.MockedFunction<typeof runReadinessGate>;

function configureGate(filePath: string): string {
  const original = parseTaskFile(fs.readFileSync(filePath, "utf-8"), filePath);
  const content = `${taskSpec("TASK-100", { title: "CLI enriched" })}\n## Enriched\nCLI body\n`;
  const result: GateResult = {
    outcome: "enriched",
    task: {
      original,
      enriched: { ...original, rawContent: content },
      diff: "fixture",
      approved: false,
    },
  };
  mockedRunReadinessGate.mockResolvedValue(result);
  return content;
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "CLI enrich duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it.each(["yes", "edit"])("refuses the %s write branch", async (answer) => {
      const fixture = createDuplicateFixture("quack-cli-enrich-veto-", kind, order);
      writeAdapter(fixture.root);
      mockPromptAnswer = answer;
      configureGate(fixture.claimantPaths[0]);
      let exitCode: number | undefined;
      const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        exitCode = typeof code === "number" ? code : 0;
        return undefined as never;
      });
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await enrichCommand("TASK-100", { project: fixture.root });
        expect(exitCode).toBe(1);
        const stderr = errorSpy.mock.calls.flat().join(" ");
        expect(stderr).toContain("TASK-100");
        for (const claimant of fixture.claimants) expect(stderr).toContain(claimant);
        expectClaimantsUnchanged(fixture);
        expectNoWriterArtifacts(fixture);
        expect(fs.existsSync(path.join(fixture.root, ".quack", "enriched"))).toBe(false);
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        exitSpy.mockRestore();
        removeFixture(fixture.root);
      }
    });
  },
);

it("yes passes through with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-enrich-single-");
  writeAdapter(fixture.root);
  mockPromptAnswer = "yes";
  const enriched = configureGate(fixture.claimantPaths[0]);
  let exitCode: number | undefined;
  const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    return undefined as never;
  });
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await enrichCommand("TASK-100", { project: fixture.root });
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toBe(enriched);
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    removeFixture(fixture.root);
  }
});

it("edit writes outside taskDir and does not create a claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-enrich-edit-");
  writeAdapter(fixture.root);
  mockPromptAnswer = "edit";
  const enriched = configureGate(fixture.claimantPaths[0]);
  let exitCode: number | undefined;
  const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    return undefined as never;
  });
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await enrichCommand("TASK-100", { project: fixture.root });
    const previewPath = path.join(fixture.root, ".quack", "enriched", "TASK-100.enriched.md");
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(previewPath, "utf-8")).toBe(enriched);
    expect(await listDuplicateClaimants(fixture.taskDir, "TASK-100")).toEqual([]);
    expectClaimantsUnchanged(fixture);
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    removeFixture(fixture.root);
  }
});
