import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubConfig } from "../../../src/integrations/github/github-types";
import { taskSpec } from "../../helpers/divergent-task-fixture";

let capturedCommands: string[] = [];
let capturedBodies: string[] = [];

jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn((args: string[], options?: { input?: string }) => {
    const command = [
      "gh",
      ...args.map((arg, index) =>
        arg.includes(" ") || ["--label", "--title"].includes(args[index - 1]) ? `"${arg}"` : arg,
      ),
    ].join(" ");
    capturedCommands.push(command);
    capturedBodies.push(options?.input ?? "");
    return Promise.resolve({
      stdout: "https://github.com/sentinel-owner/sentinel-repo/issues/987\n",
      stderr: "",
    });
  }),
}));

import { publishTask } from "../../../src/integrations/github/issue-publisher";

const TASK_ID = "TASK-451";
const SENTINEL_PUBLISH_LABEL = "task-1343-publish-sentinel";
const NESTED_FALLBACK_LABEL = "task-1343-nested-fallback";
const GITHUB_CONFIG: GitHubConfig = {
  owner: "sentinel-owner",
  repo: "sentinel-repo",
  publishLabel: SENTINEL_PUBLISH_LABEL,
  labels: { task: NESTED_FALLBACK_LABEL },
};

describe("Issue Publisher", () => {
  let projectRoot: string;

  beforeEach(() => {
    capturedCommands = [];
    capturedBodies = [];
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-issue-publisher-"));
    const taskPath = path.join(projectRoot, "docs", "tasks", `${TASK_ID}-publisher-contract.md`);
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(
      taskPath,
      taskSpec(TASK_ID, {
        title: "Production publisher contract",
        status: "BACKLOG",
        tags: ["analytics", "github"],
        targetFiles: ["src/analytics.ts"],
        successCriteria: [
          "Failure patterns stored in database",
          "Gate provides advisory suggestions",
        ],
        testingRequirements: ["Test pattern storage"],
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });

  async function publishAndCapture(): Promise<{ command: string; body: string }> {
    const result = await publishTask(TASK_ID, projectRoot, GITHUB_CONFIG);
    expect(result).toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(capturedCommands).toHaveLength(1);
    const command = capturedCommands[0];
    return { command, body: capturedBodies[0] };
  }

  it("emits the quack task-id marker through the production body builder", async () => {
    const { body } = await publishAndCapture();

    expect(body).toMatch(/^<!-- quack:task-id=TASK-451 -->\n/);
  });

  it("supports task ID extraction from the production-generated marker", async () => {
    const { body } = await publishAndCapture();

    const markerMatch = body.match(/^<!-- quack:task-id=(TASK-\d+) -->$/m);
    expect(markerMatch).not.toBeNull();
    expect(markerMatch?.[1]).toBe(TASK_ID);
  });

  it("formats task fields through the production body builder", async () => {
    const { command, body } = await publishAndCapture();

    expect(command).toContain("gh issue create");
    expect(command).toContain("--repo sentinel-owner/sentinel-repo");
    expect(command).toContain('--title "TASK-451: Production publisher contract"');
    expect(command).toContain("--body-file -");
    expect(body).toContain(`${TASK_ID} must resolve to its own file.`);
    expect(body).toContain("- [ ] Failure patterns stored in database");
    expect(body).toContain("- [ ] Gate provides advisory suggestions");
    expect(body).toContain("| `src/analytics.ts` | Modify | TASK-451 fixture |");
    expect(body).toContain("- [ ] Test pattern storage");
    expect(body).toContain("**Tags:** analytics, github");
    expect(body).toContain("## Priority: P2-MEDIUM | Effort: 1-2 hours");
  });

  it("uses the sentinel publishLabel in the captured command", async () => {
    const { command, body } = await publishAndCapture();

    expect(command).toContain(`--label "${SENTINEL_PUBLISH_LABEL}"`);
    expect(command).not.toContain(`--label "${NESTED_FALLBACK_LABEL}"`);
    expect(command).not.toContain('--label "quack-task"');
    expect(body).toContain(`<!-- quack:task-id=${TASK_ID} -->`);
  });
});
