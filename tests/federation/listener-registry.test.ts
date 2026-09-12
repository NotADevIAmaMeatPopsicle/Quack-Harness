import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ListenerRegistry,
  ListenerTokenBindingError,
} from "../../src/federation/listener-registry";

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
        baseUrl: "http://100.1.2.3:3333",
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

    const heartbeat = await registry.heartbeat(
      "contributor-laptop",
      {
        healthy: false,
        currentLoad: 1,
        repoCommit: "def456",
      },
      "contributor-token",
    );

    expect(heartbeat).toMatchObject({
      id: "contributor-laptop",
      healthy: false,
      currentLoad: 1,
      repoCommit: "def456",
    });
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it("binds a host immutably to its first worker token across concurrent registration", async () => {
    const registry = new ListenerRegistry(projectRoot);
    const registrations = await Promise.allSettled([
      registry.register({ hostId: "shared-host", capabilities: ["dispatch"] }, "worker-token-a"),
      registry.register({ hostId: "shared-host", capabilities: ["dispatch"] }, "worker-token-b"),
    ]);

    expect(registrations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = registrations.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(ListenerTokenBindingError);
    expect(rejected?.reason).toMatchObject({ code: "listener_token_host_mismatch" });

    const stored = await registry.get("shared-host");
    expect(["worker-token-a", "worker-token-b"]).toContain(stored?.registeredBy);
    const attacker =
      stored?.registeredBy === "worker-token-a" ? "worker-token-b" : "worker-token-a";
    await expect(
      registry.heartbeat("shared-host", { healthy: false, currentLoad: 99 }, attacker),
    ).rejects.toMatchObject({ code: "listener_token_host_mismatch" });
    await expect(
      registry.heartbeat("shared-host", { healthy: false, currentLoad: 99 }),
    ).rejects.toMatchObject({ code: "listener_token_host_mismatch" });
    await expect(
      registry.register({ hostId: "shared-host", capabilities: ["dispatch"] }),
    ).rejects.toMatchObject({ code: "listener_token_host_mismatch" });
    await expect(registry.assertTokenBinding("shared-host", attacker)).rejects.toMatchObject({
      code: "listener_token_host_mismatch",
    });
    expect(await registry.get("shared-host")).toMatchObject({
      registeredBy: stored?.registeredBy,
      healthy: true,
      currentLoad: 0,
    });
  });

  it("fails closed instead of overwriting a corrupt existing host registration", async () => {
    const listenerDir = path.join(projectRoot, ".quack", "federation", "listeners");
    fs.mkdirSync(listenerDir, { recursive: true });
    const listenerPath = path.join(listenerDir, "shared-host.json");
    fs.writeFileSync(listenerPath, "{not valid json", "utf-8");
    const registry = new ListenerRegistry(projectRoot);

    await expect(
      registry.register({ hostId: "shared-host", capabilities: ["dispatch"] }, "attacker-token"),
    ).rejects.toMatchObject({ issue: { code: "malformed_json" } });
    expect(fs.readFileSync(listenerPath, "utf-8")).toBe("{not valid json");
  });

  it("does not let a worker token claim a legacy unbound host id", async () => {
    const registry = new ListenerRegistry(projectRoot);
    await registry.register({ hostId: "legacy-host", capabilities: ["dispatch"] });

    await expect(
      registry.register({ hostId: "legacy-host", capabilities: ["dispatch"] }, "worker-token"),
    ).rejects.toMatchObject({ code: "listener_token_host_mismatch" });
    const stored = await registry.get("legacy-host");
    expect(stored?.id).toBe("legacy-host");
    expect(stored?.registeredBy).toBeUndefined();
  });
});
