import * as fs from "node:fs";
import fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { defaultFederatedHosts } from "../../src/monitor/federation/host";

jest.mock("../../src/core/global-config", () => ({
  ...jest.requireActual<object>("../../src/core/global-config"),
  loadGlobalConfig: () => ({
    remoteInstances: [
      { id: "broken", host: "127.0.0.1", remotePort: 1, enabled: true },
      { id: "configured", host: "127.0.0.1", remotePort: 2, enabled: true },
    ],
  }),
}));

describe("listener registry diagnostic isolation", () => {
  let root: string;
  let registry: ListenerRegistry;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-listener-diagnostics-"));
    registry = new ListenerRegistry(root);
    await registry.register({ hostId: "valid", capabilities: ["dispatch"] }, "worker-token");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recordPath = (root: string, hostId: string) =>
    path.join(root, ".quack", "federation", "listeners", `${hostId}.json`);

  it.each([
    ["{broken", "malformed_json"],
    ["null", "invalid_record"],
    [
      JSON.stringify({ id: "broken", capabilities: ["dispatch"], healthy: "true" }),
      "invalid_record",
    ],
  ])("keeps valid workers visible beside invalid record %s", async (content, code) => {
    fs.writeFileSync(recordPath(root, "broken"), content);
    const snapshot = await registry.listWithDiagnostics();
    expect(snapshot.records.map((record) => record.id)).toEqual(["valid"]);
    expect(snapshot.issues[0]?.reason).toEqual(expect.any(String));
    expect(snapshot.issues).toEqual([
      { file: "broken.json", hostId: "broken", code, reason: snapshot.issues[0]?.reason },
    ]);
    expect(snapshot.reservedHostIds).toEqual(["broken", "valid"]);
    expect((await registry.list()).map((record) => record.id)).toEqual(["valid"]);
    expect(fs.readFileSync(recordPath(root, "broken"), "utf8")).toBe(content);
    const hosts = await defaultFederatedHosts(root, snapshot);
    expect(hosts.map((host) => host.id).sort()).toEqual(["configured", "valid"]);
    expect(hosts.some((host) => host.id === "broken")).toBe(false);
  });

  it("refuses filename/body identity mismatch and does not replace it on registration", async () => {
    const valid = await registry.get("valid");
    const content = JSON.stringify({ ...valid, id: "somebody-else" });
    fs.writeFileSync(recordPath(root, "broken"), content);
    expect((await registry.listWithDiagnostics()).issues).toEqual([
      expect.objectContaining({ hostId: "broken", code: "identity_mismatch" }),
    ]);
    await expect(
      registry.register({ hostId: "broken", capabilities: ["dispatch"] }, "worker-token"),
    ).rejects.toMatchObject({ issue: { code: "identity_mismatch" } });
    expect(fs.readFileSync(recordPath(root, "broken"), "utf8")).toBe(content);
  });

  it("reserves all static fallbacks when the registry cannot be enumerated", async () => {
    const original = fsp.readdir;
    jest.spyOn(fsp, "readdir").mockImplementation(((directory: fs.PathLike, options?: unknown) => {
      if (String(directory).endsWith("listeners"))
        return Promise.reject(Object.assign(new Error("fixture denied"), { code: "EACCES" }));
      return original(directory, options as never);
    }) as typeof fsp.readdir);
    const snapshot = await registry.listWithDiagnostics();
    expect(snapshot).toMatchObject({
      unavailable: true,
      issues: [{ code: "registry_unavailable" }],
    });
    expect(await defaultFederatedHosts(root, snapshot)).toEqual([]);
  });

  it("keeps the previous complete record until atomic replacement and preserves it when rename fails", async () => {
    const previous = fs.readFileSync(recordPath(root, "valid"), "utf8");
    const rename = fsp.rename;
    const spy = jest.spyOn(fsp, "rename").mockImplementation(async (source, destination) => {
      expect(String(source)).toMatch(/\.tmp$/);
      expect(fs.readFileSync(recordPath(root, "valid"), "utf8")).toBe(previous);
      await rename(source, destination);
    });
    await registry.heartbeat("valid", { healthy: false }, "worker-token");
    expect((await registry.get("valid"))?.healthy).toBe(false);
    const replaced = fs.readFileSync(recordPath(root, "valid"), "utf8");
    spy.mockRejectedValueOnce(new Error("fixture rename failure"));
    await expect(registry.heartbeat("valid", { healthy: true }, "worker-token")).rejects.toThrow(
      "fixture rename failure",
    );
    expect(fs.readFileSync(recordPath(root, "valid"), "utf8")).toBe(replaced);
    expect(
      fs
        .readdirSync(path.dirname(recordPath(root, "valid")))
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
