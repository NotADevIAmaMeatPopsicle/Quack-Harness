// TASK-1338-B pre-change record: all four persist arms executed and FAILED at
// the expected 409 assertion because enrich replaced one claimant. The
// dryRun arm is a CONTROL for the preview return and the persist matrix is its
// behavioural red coverage.

import * as fs from "node:fs";
import * as path from "node:path";

import { parseTaskFile } from "../../src/core/task-parser";
import type { GateResult } from "../../src/core/types";
import { runReadinessGate } from "../../src/gate/gate";
import { createMonitorServer } from "../../src/monitor/server";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  expectNoWriterArtifacts,
  expectPinnedHttpRefusal,
  postJson,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: jest.fn(),
}));

const mockedRunReadinessGate = runReadinessGate as jest.MockedFunction<typeof runReadinessGate>;

function setEnrichedResult(filePath: string): string {
  const original = parseTaskFile(fs.readFileSync(filePath, "utf-8"), filePath);
  const content = `${taskSpec("TASK-100", { title: "enriched content" })}\n## Enriched\naccepted body\n`;
  const result: GateResult = {
    outcome: "enriched",
    task: {
      original,
      enriched: { ...original, rawContent: content },
      diff: "fixture enrichment",
      approved: false,
    },
  };
  mockedRunReadinessGate.mockResolvedValue(result);
  return content;
}

async function start(root: string, adapterPath: string) {
  const server = createMonitorServer({
    port: 0,
    host: "127.0.0.1",
    projectRoot: root,
    taskDir: "docs/tasks",
    adapterPath,
    quackRoot: root,
    logDir: path.join(root, ".quack", "logs"),
  });
  return server.start();
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "monitor enrich duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses before creating the tmp file", async () => {
      const fixture = createDuplicateFixture("quack-enrich-veto-", kind, order);
      const adapterPath = writeAdapter(fixture.root);
      let stop: (() => Promise<void>) | undefined;
      try {
        setEnrichedResult(fixture.claimantPaths[0]);
        const started = await start(fixture.root, adapterPath);
        stop = started.stop;
        const response = await postJson(started.port, "/api/tasks/TASK-100/enrich", {});
        expectPinnedHttpRefusal(response, fixture.claimants);
        expectClaimantsUnchanged(fixture);
        expectNoWriterArtifacts(fixture);
      } finally {
        await stop?.();
        removeFixture(fixture.root);
      }
    });
  },
);

it("dryRun remains spec-neutral on a contested id", async () => {
  const fixture = createDuplicateFixture("quack-enrich-preview-", "cross-population", "forward");
  const adapterPath = writeAdapter(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    setEnrichedResult(fixture.claimantPaths[0]);
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/enrich", { dryRun: true });
    expect(response.status).toBe(200);
    expect(response.body.persisted).toBe(false);
    expectClaimantsUnchanged(fixture);
    expectNoWriterArtifacts(fixture);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});

it("persists normally with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-enrich-single-");
  const adapterPath = writeAdapter(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    const enriched = setEnrichedResult(fixture.claimantPaths[0]);
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/enrich", {});
    expect(response.status).toBe(200);
    expect(response.body.persisted).toBe(true);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toBe(enriched);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
