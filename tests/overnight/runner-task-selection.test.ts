// TASK-1339-A R1: overnight prep caches the parent content on real disk.
//
// The naive-control tests are MATCHER-ONLY CONTROLS. They are exempt from
// the pre-change failure requirement because their purpose is to prove that
// each directory arm exposes the retired selector's wrong answer.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { runOvernightRunner } from "../../src/overnight/runner";
import { computeContentHash } from "../../src/monitor/prep-cache";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

async function startMonitorStub(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(req.url?.startsWith("/api/dispatch/jobs") ? "[]" : '{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Monitor stub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: overnight parent prep selection (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;

    beforeEach(() => {
      fixture = createDivergentTaskFixture(order, {
        prefix: "quack-overnight-selection-",
        parent: { repairPlaceholder: true },
        child: { repairPlaceholder: true },
      });
      writeTestAdapter(fixture.root);
    });

    afterEach(() => fixture.cleanup());

    it("MATCHER-ONLY CONTROL: the naive prefix read selects the child", () => {
      expect(fixture.naiveSelection).toBe("TASK-100-A-child.md");
    });

    it("builds the parent prep cache from the parent's bytes", async () => {
      const monitor = await startMonitorStub();
      try {
        await runOvernightRunner({
          projectRoot: fixture.root,
          monitorUrl: monitor.url,
          taskIds: ["TASK-100"],
          checkpointPath: path.join(fixture.root, ".quack", "overnight-test.json"),
          once: true,
          maxCycles: 2,
          autoDecompose: false,
          federationDispatch: false,
          logger: () => {},
        });
      } finally {
        await monitor.stop();
      }

      const cached = JSON.parse(
        fs.readFileSync(path.join(fixture.root, ".quack", "prep", "TASK-100.json"), "utf-8"),
      ) as { contentHash?: string };
      expect(cached.contentHash).toBe(computeContentHash(fixture.parentContent));
      expect(cached.contentHash).not.toBe(computeContentHash(fixture.childContent));
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });
  },
);
