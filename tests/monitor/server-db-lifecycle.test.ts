import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-db-lifecycle-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

describe("monitor database lifecycle", () => {
  it("releases quack.db handles when the monitor stops", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const port = 33000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir,
    });
    const { stop } = await serverObj.start();

    expect(fs.existsSync(path.join(projectRoot, ".quack", "quack.db"))).toBe(true);

    await stop();

    expect(() => removeTempDir(projectRoot)).not.toThrow();
  });
});
