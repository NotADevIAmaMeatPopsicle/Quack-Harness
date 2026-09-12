import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { dispatchTask } from "../../src/dispatcher/dispatcher";
import { EventWriter } from "../../src/monitor/event-emitter";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

describe("host-pinned dispatch event identity", () => {
  const environment = process.env;
  let root: string;
  let adapter: ProjectAdapter;
  beforeEach(() => {
    process.env = { ...environment };
    delete process.env.QUACK_DOCKER_EVENT_SESSION_ID;
    delete process.env.QUACK_MONITOR_EVENT_SESSION_ID;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-event-id-"));
    fs.mkdirSync(path.join(root, "tasks"));
    fs.copyFileSync(
      path.join(__dirname, "../fixtures/task-valid-minimal.md"),
      path.join(root, "tasks/TASK-001.md"),
    );
    adapter = {
      projectRoot: root,
      config: {
        project: { name: "Fixture", taskDir: "tasks" },
        logging: { dir: ".quack/logs" },
        agent: { maxRetries: 0, maxBudgetPerTask: 1 },
      },
    } as unknown as ProjectAdapter;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = environment;
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each(["QUACK_MONITOR_EVENT_SESSION_ID", "QUACK_DOCKER_EVENT_SESSION_ID"])(
    "uses the validated host UUID at the actual writer boundary (%s)",
    async (name) => {
      const sessionId = `quack-TASK-001-${randomUUID()}`;
      process.env[name] = sessionId;
      let observed: string | undefined;
      jest.spyOn(EventWriter.prototype, "recordSession").mockImplementation(function (
        this: EventWriter,
      ) {
        observed = this.sessionId;
        throw new Error("stop after actual event writer construction");
      });
      await expect(dispatchTask("TASK-001", adapter)).rejects.toThrow(
        "stop after actual event writer construction",
      );
      expect(observed).toBe(sessionId);
    },
  );
  it.each([
    "quack-TASK-002-00000000-0000-4000-8000-000000000000",
    "../../other",
    "quack-TASK-001-not-a-uuid",
  ])("refuses an invalid or cross-task host identity: %s", async (value) => {
    process.env.QUACK_MONITOR_EVENT_SESSION_ID = value;
    const writer = jest.spyOn(EventWriter.prototype, "recordSession");
    await expect(dispatchTask("TASK-001", adapter)).rejects.toThrow(
      "Invalid host-assigned dispatch event session identity",
    );
    expect(writer).not.toHaveBeenCalled();
  });
  it("refuses conflicting monitor and Docker identities", async () => {
    process.env.QUACK_MONITOR_EVENT_SESSION_ID = `quack-TASK-001-${randomUUID()}`;
    process.env.QUACK_DOCKER_EVENT_SESSION_ID = `quack-TASK-001-${randomUUID()}`;
    await expect(dispatchTask("TASK-001", adapter)).rejects.toThrow(
      "Conflicting host-assigned dispatch event identities",
    );
  });
});
