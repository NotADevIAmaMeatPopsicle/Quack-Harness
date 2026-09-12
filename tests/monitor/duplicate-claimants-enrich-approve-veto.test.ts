// TASK-1338-B pre-change record: all four behavioural arms executed and
// FAILED at the expected 409 assertion because approve atomically replaced
// one claimant.

import * as fs from "node:fs";
import * as path from "node:path";

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
  "enrich approve duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses before creating the approval tmp file", async () => {
      const fixture = createDuplicateFixture("quack-approve-veto-", kind, order);
      const adapterPath = writeAdapter(fixture.root);
      let stop: (() => Promise<void>) | undefined;
      try {
        const started = await start(fixture.root, adapterPath);
        stop = started.stop;
        const response = await postJson(started.port, "/api/tasks/TASK-100/enrich/approve", {
          content: `${taskSpec("TASK-100")}\n## Approved\nnew content\n`,
        });
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

it("approves normally with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-approve-single-");
  const adapterPath = writeAdapter(fixture.root);
  const approved = `${taskSpec("TASK-100")}\n## Approved\nnew content\n`;
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/enrich/approve", {
      content: approved,
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toBe(approved);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
