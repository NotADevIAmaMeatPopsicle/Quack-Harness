// TASK-1338-B pre-change record: all four accept-if-better arms executed and
// FAILED at the expected 409 assertion because one claimant was atomically
// replaced. Dry-run and propose are CONTROL arms for earlier no-write returns.

import * as fs from "node:fs";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { computeContentHash } from "../../src/monitor/prep-cache";
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
} from "../helpers/duplicate-claimants-fixture";

function betterCandidate(): string {
  return taskSpec("TASK-100", {
    title: "duplicate claimant fixture",
    extra: [
      "## Additional Detail",
      "The accepted candidate adds an explicit atomic write boundary, cache invalidation, and provenance.",
      "",
      "## Rollback Plan",
      "Restore the prior bytes if post-write verification fails.",
      "",
      "## Security Considerations",
      "The route is restricted to the canonical writer and preserves all required checks.",
    ].join("\n"),
  }).replace(
    "- [ ] Exercise real files in both creation orders",
    "- [ ] Exercise real files in both creation orders\n- [ ] Verify atomic replacement and provenance persistence",
  );
}

async function start(fixture: { root: string; taskDir: string }): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const server = createMonitorServer({
    port: 0,
    host: "127.0.0.1",
    projectRoot: fixture.root,
    taskDir: fixture.taskDir,
    quackRoot: fixture.root,
    logDir: path.join(fixture.root, ".quack", "logs"),
  });
  return server.start();
}

function candidateBody(base: string, applyMode: "accept-if-better" | "dry-run" | "propose") {
  return {
    source: "test",
    baseSpecHash: computeContentHash(base),
    candidateContent: betterCandidate(),
    applyMode,
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "enrichment candidate duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses immediately before the atomic tmp write", async () => {
      const fixture = createDuplicateFixture("quack-candidate-veto-", kind, order);
      let stop: (() => Promise<void>) | undefined;
      try {
        const started = await start(fixture);
        stop = started.stop;
        const base = fs.readFileSync(fixture.claimantPaths[0], "utf-8");
        const response = await postJson(
          started.port,
          "/v1/tasks/TASK-100/enrichment-candidates",
          candidateBody(base, "accept-if-better"),
        );
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

it.each(["dry-run", "propose"] as const)(
  "%s stays spec-neutral on a contested id",
  async (applyMode) => {
    const fixture = createDuplicateFixture(
      "quack-candidate-control-",
      "cross-population",
      "forward",
    );
    let stop: (() => Promise<void>) | undefined;
    try {
      const started = await start(fixture);
      stop = started.stop;
      const base = fs.readFileSync(fixture.claimantPaths[0], "utf-8");
      const response = await postJson(
        started.port,
        "/v1/tasks/TASK-100/enrichment-candidates",
        candidateBody(base, applyMode),
      );
      expect(response.status).toBe(200);
      expectClaimantsUnchanged(fixture);
      expectNoWriterArtifacts(fixture);
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  },
);

it("applies an accepted candidate with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-candidate-single-");
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture);
    stop = started.stop;
    const base = fs.readFileSync(fixture.claimantPaths[0], "utf-8");
    const response = await postJson(
      started.port,
      "/v1/tasks/TASK-100/enrichment-candidates",
      candidateBody(base, "accept-if-better"),
    );
    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toBe(betterCandidate());
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
