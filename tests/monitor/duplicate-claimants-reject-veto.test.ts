// TASK-1338-B pre-change record: all four behavioural arms executed and
// FAILED at the expected 409 assertion because reject returned 200 and rewrote
// one claimant. The already-REJECTED arm is a CONTROL for the earlier no-write
// return and is covered behaviorally by the READY matrix.

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
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

describe.each(DUPLICATE_FIXTURE_CASES)("reject duplicate claimant veto (%s, %s)", (kind, order) => {
  it("refuses before rewriting either claimant", async () => {
    const fixture = createDuplicateFixture("quack-reject-veto-", kind, order);
    const adapterPath = writeAdapter(fixture.root);
    let stop: (() => Promise<void>) | undefined;
    try {
      const server = createMonitorServer({
        port: 0,
        host: "127.0.0.1",
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        quackRoot: fixture.root,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await server.start();
      stop = started.stop;
      const response = await postJson(started.port, "/api/tasks/TASK-100/reject", {
        reason: "fixture refusal",
      });

      expectPinnedHttpRefusal(response, fixture.claimants);
      expectClaimantsUnchanged(fixture);
      expectNoWriterArtifacts(fixture);
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  });
});

it("reject still passes through for one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-reject-single-");
  const adapterPath = writeAdapter(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      quackRoot: fixture.root,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await server.start();
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/reject", {});
    expect(response.status).toBe(200);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toContain("**Status:** REJECTED");
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});

it("already rejected remains the original no-write response when contested", async () => {
  const fixture = createDuplicateFixture("quack-reject-noop-", "cross-population", "forward", {
    status: "REJECTED",
  });
  const adapterPath = writeAdapter(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      quackRoot: fixture.root,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await server.start();
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/reject", {});
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain("already REJECTED");
    expectClaimantsUnchanged(fixture);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
