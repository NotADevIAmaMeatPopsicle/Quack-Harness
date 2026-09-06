import * as fs from "node:fs";
import * as path from "node:path";

import { templatesCommand } from "../../src/cli/templates";
import type { FixtureCreationOrder } from "../helpers/divergent-task-fixture";
import {
  createContestedTaskFixture,
  writeSessionLog,
  type ClaimantPopulation,
} from "../helpers/task-1338e-fixture";

function captureCli(): {
  errors: jest.SpyInstance;
  exits: number[];
} {
  const exits: number[] = [];
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(process, "exit").mockImplementation((code) => {
    exits.push(typeof code === "number" ? code : 0);
    return undefined as never;
  });
  return { errors, exits };
}

describe("TASK-1338-E: template rebuild CLI save veto", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<[ClaimantPopulation, FixtureCreationOrder]>([
    ["candidate", "child-first"],
    ["candidate", "parent-first"],
    ["cross-population", "child-first"],
    ["cross-population", "parent-first"],
  ])(
    "refuses %s source ids created %s and keeps the registry absent",
    async (population, order) => {
      const fixture = createContestedTaskFixture(order, population, {
        status: "COMPLETE",
        withAdapter: true,
      });
      writeSessionLog(fixture.root, [fixture.taskId]);
      const registryPath = path.join(fixture.root, ".quack", "templates", "task-templates.json");
      const cli = captureCli();
      try {
        await templatesCommand({ rebuild: true, project: fixture.root });
        expect(cli.exits).toEqual([1]);
        const output = cli.errors.mock.calls.flat().join("\n");
        expect(output).toContain(fixture.taskId);
        for (const claimant of fixture.claimants) expect(output).toContain(claimant);
        expect(fs.existsSync(registryPath)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("threads a custom taskDir through both rebuild and the save veto", async () => {
    const fixture = createContestedTaskFixture("parent-first", "cross-population", {
      status: "COMPLETE",
      withAdapter: true,
      relativeTaskDir: "project/custom-task-specs",
    });
    writeSessionLog(fixture.root, [fixture.taskId]);
    const cli = captureCli();
    try {
      await templatesCommand({ rebuild: true, project: fixture.root });
      const output = cli.errors.mock.calls.flat().join("\n");
      expect(cli.exits).toEqual([1]);
      expect(output).toContain(fixture.taskId);
      for (const claimant of fixture.claimants) expect(output).toContain(claimant);
      expect(
        fs.existsSync(path.join(fixture.root, ".quack", "templates", "task-templates.json")),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps a single claimant rebuild writable", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      status: "COMPLETE",
      withAdapter: true,
    });
    fs.rmSync(fixture.claimantPaths[1]);
    writeSessionLog(fixture.root, [fixture.taskId]);
    const cli = captureCli();
    try {
      await templatesCommand({ rebuild: true, project: fixture.root });
      expect(cli.exits).toEqual([0]);
      const registryPath = path.join(fixture.root, ".quack", "templates", "task-templates.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
        templates: Array<{ sourceTaskId: string }>;
      };
      expect(registry.templates.map((row) => row.sourceTaskId)).toEqual([fixture.taskId]);
    } finally {
      fixture.cleanup();
    }
  });
});
