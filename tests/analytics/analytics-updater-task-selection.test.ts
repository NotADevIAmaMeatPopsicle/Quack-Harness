// TASK-1339-A R3: rebuilt parent metrics come from the parent spec.
//
// The naive-control tests are MATCHER-ONLY CONTROLS. The behavioral arms
// use divergent tags, target files, and criterion counts on real files.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  rebuildAnalyticsDB,
  summarizeResolvedTaskSpec,
} from "../../src/analytics/analytics-updater";
import type { FailurePatternDB } from "../../src/analytics/analytics-types";
import { resolveParsedTaskFile } from "../../src/core/task-file-resolver";
import type { EventReader } from "../../src/monitor/event-reader";
import type { SessionEntry } from "../../src/monitor/event-types";
import {
  createDivergentTaskFixture,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: analytics parent selection (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;

    beforeEach(() => {
      fixture = createDivergentTaskFixture(order, {
        prefix: "quack-analytics-selection-",
        parent: {
          tags: ["parent-only"],
          targetFiles: ["src/parent-one.ts", "src/parent-two.ts"],
          successCriteria: ["Parent criterion one", "Parent criterion two"],
        },
        child: {
          tags: ["child-only"],
          targetFiles: ["src/child-only.ts"],
          successCriteria: ["Child criterion"],
        },
      });
    });

    afterEach(() => fixture.cleanup());

    it("MATCHER-ONLY CONTROL: the naive prefix read selects the child", () => {
      expect(fixture.naiveSelection).toBe("TASK-100-A-child.md");
    });

    it("derives parent tags and target-file metrics from the parent content", () => {
      const session: SessionEntry = {
        sessionId: "parent-session",
        taskId: "TASK-100",
        project: "fixture",
        startTime: "2026-08-17T00:00:00.000Z",
        status: "completed",
        outcome: "rejected",
      };
      const reader = {
        logDir: path.join(fixture.root, ".quack", "logs"),
        getAllSessions: () => [session],
        getExecutionSessions: () => [session],
        getSessionEvents: () => [],
      } as unknown as EventReader;

      rebuildAnalyticsDB(reader, fixture.root);

      const db = JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, ".quack", "analytics", "failure-patterns.json"),
          "utf-8",
        ),
      ) as FailurePatternDB;
      expect(db.byTag["parent-only"]?.runs).toBe(1);
      expect(db.byTag["child-only"]).toBeUndefined();
      expect(Object.keys(db.byFile).sort()).toEqual(["src/parent-one.ts", "src/parent-two.ts"]);
      expect(db.byFile["src/child-only.ts"]).toBeUndefined();
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });

    it("uses the resolved bundle after the task file is deleted", async () => {
      const resolved = await resolveParsedTaskFile(fixture.taskDir, "TASK-100");
      expect(resolved).not.toBeNull();
      fs.unlinkSync(fixture.parentPath);

      const metrics = summarizeResolvedTaskSpec(resolved!);

      expect(metrics).toEqual({
        tags: ["parent-only"],
        targetFiles: ["src/parent-one.ts", "src/parent-two.ts"],
        filesToModify: 2,
        successCriteria: 2,
      });
    });
  },
);
