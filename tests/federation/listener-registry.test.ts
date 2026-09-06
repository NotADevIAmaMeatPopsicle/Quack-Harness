import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ListenerRegistry } from "../../src/federation/listener-registry";

describe("ListenerRegistry", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-listener-registry-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("registers listeners and applies heartbeat updates", async () => {
    const registry = new ListenerRegistry(projectRoot);
    const registered = await registry.register(
      {
        hostId: "contributor-laptop",
        alias: "Contributor Laptop",
        baseUrl: "http://192.0.2.30:3333",
        capabilities: ["dispatch", "verify", "staging-db", "verify"],
        maxConcurrentJobs: 2,
        projectPaths: { example: "/home/contributor/example" },
        repoCommit: "abc123",
      },
      "contributor-token",
    );

    expect(registered).toMatchObject({
      id: "contributor-laptop",
      healthy: true,
      currentLoad: 0,
      maxConcurrentJobs: 2,
      registeredBy: "contributor-token",
    });
    expect(registered.capabilities).toEqual(["dispatch", "staging-db", "verify"]);

    const heartbeat = await registry.heartbeat("contributor-laptop", {
      healthy: false,
      currentLoad: 1,
      repoCommit: "def456",
    });

    expect(heartbeat).toMatchObject({
      id: "contributor-laptop",
      healthy: false,
      currentLoad: 1,
      repoCommit: "def456",
    });
    await expect(registry.list()).resolves.toHaveLength(1);
  });
});
