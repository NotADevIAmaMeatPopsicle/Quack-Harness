import * as fs from "node:fs";
import * as path from "node:path";

import { templatesCommand } from "../../src/cli/templates";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

function writeRegistry(projectRoot: string): void {
  const registryPath = path.join(projectRoot, ".quack", "templates", "task-templates.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify(
      {
        updatedAt: "2026-08-17T00:00:00.000Z",
        templates: [
          {
            category: "testing",
            sourceTaskId: "TASK-300",
            specTemplate: "Fixture template",
            successRate: 1,
            avgCostUsd: 1,
            filePatterns: ["src/task-100.ts"],
            fileCount: 1,
            tags: ["fixture"],
          },
        ],
        categoryStats: {
          "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          testing: { count: 1, avgSuccessRate: 1, avgCostUsd: 1 },
          configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("TASK-1339-B: templates CLI canonical match input", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<FixtureCreationOrder>(["child-first", "parent-first"])(
    "--match loads the descriptive parent through the production command when created %s",
    async (order) => {
      const fixture = createDivergentTaskFixture(order, {
        prefix: "quack-templates-cli-path-",
        parent: {
          title: "Parent match target",
          tags: ["fixture"],
          targetFiles: ["src/task-100.ts"],
        },
        child: { title: "Child match target", tags: ["unrelated"], targetFiles: ["src/child.ts"] },
      });
      try {
        writeTestAdapter(fixture.root);
        writeRegistry(fixture.root);
        const exitCodes: number[] = [];
        jest.spyOn(process, "exit").mockImplementation((code) => {
          exitCodes.push(typeof code === "number" ? code : 0);
          return undefined as never;
        });
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);

        await templatesCommand({ match: "TASK-100", project: fixture.root });

        expect(exitCodes).toEqual([0]);
        expect(logSpy.mock.calls.flat().join("\n")).toContain("[MATCH] Best match for TASK-100:");
        expect(logSpy.mock.calls.flat().join("\n")).toContain("Template: TASK-300");
      } finally {
        fixture.cleanup();
      }
    },
  );
});
