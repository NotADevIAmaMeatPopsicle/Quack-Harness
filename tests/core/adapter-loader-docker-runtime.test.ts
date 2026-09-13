import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAdapter } from "../../src/core/adapter-loader";

const LOGS = "/workspace/.quack/docker-runtime/TASK-TEST-12345678-1234-4234-8234-123456789abc";

describe("loadAdapter managed Docker runtime binding", () => {
  let root: string;
  let original: string;
  let previousLogs: string | undefined;
  let previousMarker: string | undefined;

  beforeEach(() => {
    previousLogs = process.env.QUACK_DOCKER_RUNTIME_LOG_DIR;
    previousMarker = process.env.QUACK_DOCKER_HOST_PROMOTION;
    delete process.env.QUACK_DOCKER_RUNTIME_LOG_DIR;
    delete process.env.QUACK_DOCKER_HOST_PROMOTION;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-adapter-binding-"));
    fs.mkdirSync(path.join(root, ".quack"));
    original = fs.readFileSync(
      path.resolve(__dirname, "../fixtures/adapters/minimal/.quack/adapter.json"),
      "utf8",
    );
    fs.writeFileSync(path.join(root, ".quack", "adapter.json"), original);
  });

  afterEach(() => {
    if (previousLogs === undefined) delete process.env.QUACK_DOCKER_RUNTIME_LOG_DIR;
    else process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = previousLogs;
    if (previousMarker === undefined) delete process.env.QUACK_DOCKER_HOST_PROMOTION;
    else process.env.QUACK_DOCKER_HOST_PROMOTION = previousMarker;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("returns the selected directory without changing adapter authority", async () => {
    const baseline = await loadAdapter(root);
    process.env.QUACK_DOCKER_HOST_PROMOTION = "1";
    process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = LOGS;
    const managed = await loadAdapter(root);
    // POSIX compatibility assertion, not a dispatcher invocation. Independent
    // review traces this expression into CheckpointManager and EventWriter.
    expect(path.posix.resolve("/workspace", managed.config.logging.dir)).toBe(LOGS);
    expect(managed.config.project).toEqual(baseline.config.project);
    expect(managed.projectRoot).toBe(baseline.projectRoot);
    expect(managed.adapterBundle).toEqual(baseline.adapterBundle);
    expect(fs.readFileSync(path.join(root, ".quack", "adapter.json"), "utf8")).toBe(original);
  });

  test.each([LOGS, "/tmp/untrusted-log-tree"])(
    "host loads ignore an unscoped environment override: %s",
    async (value) => {
      process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = value;
      expect((await loadAdapter(root)).config.logging.dir).toBe(".quack/logs");
    },
  );

  test.each([
    "",
    undefined,
    "/workspace/.quack/docker-runtime",
    "/workspace/.quack/logs",
    "/tmp/TASK-TEST-12345678-1234-4234-8234-123456789abc",
    "/workspace/.quack/docker-runtime/../TASK-TEST-12345678-1234-4234-8234-123456789abc",
    "/workspace/.quack/docker-runtime/TASK-TEST-not-a-uuid",
  ])("managed loads reject an invalid or unbound adoption directory: %s", async (value) => {
    process.env.QUACK_DOCKER_HOST_PROMOTION = "1";
    if (value !== undefined) process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = value;
    await expect(loadAdapter(root)).rejects.toThrow(
      "Invalid QUACK_DOCKER_RUNTIME_LOG_DIR isolation boundary",
    );
  });

  test("does not activate dormant worker root, task or log overlays", async () => {
    const raw = JSON.parse(original) as Record<string, unknown>;
    raw.workerOverlay = {
      projectRoot: "/other-project",
      taskDir: "other-tasks",
      logDir: "/other-logs",
    };
    fs.writeFileSync(path.join(root, ".quack", "adapter.json"), JSON.stringify(raw));
    const before = await loadAdapter(root);
    expect(before.config.project.root).toBe(".");
    expect(before.config.project.taskDir).toBe("docs/tasks");
    expect(before.config.logging.dir).toBe(".quack/logs");
    process.env.QUACK_DOCKER_HOST_PROMOTION = "1";
    process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = LOGS;
    const after = await loadAdapter(root);
    expect(after.config.project).toEqual(before.config.project);
    expect(after.config.logging.dir).toBe(LOGS);
  });

  test("accepts the producer's sanitized underscore in a task segment", async () => {
    process.env.QUACK_DOCKER_HOST_PROMOTION = "1";
    process.env.QUACK_DOCKER_RUNTIME_LOG_DIR = LOGS.replace("TASK-TEST-", "TASK_TEST-");
    expect((await loadAdapter(root)).config.logging.dir).toBe(
      process.env.QUACK_DOCKER_RUNTIME_LOG_DIR,
    );
  });
});
