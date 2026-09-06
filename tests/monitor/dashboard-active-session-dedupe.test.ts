import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const dashboardPath = path.join(process.cwd(), "src", "monitor", "public", "index.html");

function readDashboard(): string {
  return fs.readFileSync(dashboardPath, "utf8");
}

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf("{", start);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Could not extract function ${name}`);
}

describe("dashboard active session dedupe", () => {
  it("hides federation shadow sessions when a real worker session owns the same job", () => {
    const source = readDashboard();
    const helpers = [
      "extractEventFederatedJobId",
      "isFederationSessionId",
      "sessionFederatedJobId",
      "activeSessionEntriesForDisplay",
    ]
      .map((name) => extractFunction(source, name))
      .join("\n");

    const context = {
      activeSessions: new Map([
        [
          "federation-fed-task-878",
          { sessionId: "federation-fed-task-878", taskId: "TASK-878", hostId: "headnode" },
        ],
        [
          "quack-TASK-878-123",
          {
            sessionId: "quack-TASK-878-123",
            taskId: "TASK-878",
            hostId: "headnode",
            federatedJobId: "fed-task-878",
          },
        ],
      ]),
      activeSessionEvents: new Map([
        ["federation-fed-task-878", [{ payload: { jobId: "fed-task-878" } }]],
        ["quack-TASK-878-123", [{ payload: { jobId: "fed-task-878" } }]],
      ]),
      result: [] as string[],
    };

    vm.runInNewContext(
      `${helpers}\nresult = activeSessionEntriesForDisplay().map(([sessionId]) => sessionId);`,
      context,
    );

    expect(context.result).toEqual(["quack-TASK-878-123"]);
  });

  it("dedupes the unified jobs bar by federated job id and prefers real dispatch jobs", () => {
    const source = readDashboard();
    const helpers = ["unifiedJobKey", "unifiedJobRank", "dedupeUnifiedJobs"]
      .map((name) => extractFunction(source, name))
      .join("\n");

    const context = {
      jobs: [
        {
          jobSource: "federationQueue",
          jobId: "fed-task-887-a",
          federatedJobId: "fed-task-887-a",
          taskId: "TASK-887-A",
          status: "running",
          hostId: "headnode",
        },
        {
          jobSource: "localDispatch",
          federatedJobId: "fed-task-887-a",
          taskId: "TASK-887-A",
          status: "running",
          hostId: "headnode",
          sessionId: "quack-TASK-887-A-123",
          pid: 123,
        },
      ],
      result: [] as Array<{ taskId: string; jobSource: string }>,
    };

    vm.runInNewContext(`${helpers}\nresult = dedupeUnifiedJobs(jobs);`, context);

    expect(context.result).toHaveLength(1);
    expect(context.result[0]).toMatchObject({
      taskId: "TASK-887-A",
      jobSource: "localDispatch",
    });
  });
});
