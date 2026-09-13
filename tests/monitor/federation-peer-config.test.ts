import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FederationPeerConfigWriteError, loadFederationPeerConfig, writeFederationPeerConfig } from "../../src/monitor/federation/peer-config";

describe("loadFederationPeerConfig", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-peer-config-"));
    fs.mkdirSync(path.join(projectRoot, ".quack", "federation"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("parses BOM-prefixed JSON written by Windows PowerShell", async () => {
    const peerPath = path.join(projectRoot, ".quack", "federation", "peer.json");
    fs.writeFileSync(
      peerPath,
      "\uFEFF" +
        JSON.stringify(
          {
            url: "http://headnode.tail6d5e6a.ts.net:3333",
            remoteProjectId: "example-service",
            serviceToken: "qsvc_test",
            syncOnStartup: true,
            pushOnWrite: false,
            syncIntervalMs: 300000,
            limit: 250,
          },
          null,
          2,
        ),
      "utf-8",
    );

    await expect(loadFederationPeerConfig(projectRoot)).resolves.toMatchObject({
      url: "http://headnode.tail6d5e6a.ts.net:3333",
      remoteProjectId: "example-service",
      serviceToken: "qsvc_test",
      pushOnWrite: false,
      syncOnStartup: true,
      syncIntervalMs: 300000,
      limit: 250,
    });
  });

  it.each(['{"serviceToken":"fixture-secret",', '{"url":42}'])(
    "names corrupt-config refusal and permits explicit authority replacement %#", async (raw) => {
      const file = path.join(projectRoot, ".quack/federation/peer.json");
      fs.writeFileSync(file, raw);
      const config = { url: "http://headnode.test:3333", remoteProjectId: "fixture" };
      await expect(writeFederationPeerConfig(projectRoot, config)).rejects.toBeInstanceOf(FederationPeerConfigWriteError);
      await expect(writeFederationPeerConfig(projectRoot, config)).rejects.toMatchObject({
        code: "existing_peer_config_unreadable",
      });
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
      await writeFederationPeerConfig(projectRoot, { ...config, startAuthority: { hostId: "worker" } });
      expect((await loadFederationPeerConfig(projectRoot))?.startAuthority).toEqual({ hostId: "worker" });
    });

  it("preserves start authority during a legacy sync-only rewrite", async () => {
    const original = { url: "http://headnode.test:3333", remoteProjectId: "fixture",
      serviceTokenEnv: "QUACK_SERVICE_TOKEN", startAuthority: { hostId: "worker" } };
    await writeFederationPeerConfig(projectRoot, original);
    await writeFederationPeerConfig(projectRoot, { ...original, startAuthority: undefined, pushOnWrite: false });
    await expect(loadFederationPeerConfig(projectRoot)).resolves.toMatchObject({
      startAuthority: { hostId: "worker" }, pushOnWrite: false,
    });
  });

  it.each([{ url: "http://other.test" }, { remoteProjectId: "other" }])(
    "refuses implicit authority retargeting %j without changing the file", async (changed) => {
      const config = { url: "http://headnode.test:3333", remoteProjectId: "fixture",
        startAuthority: { hostId: "worker" } };
      const file = await writeFederationPeerConfig(projectRoot, config);
      const before = fs.readFileSync(file, "utf8");
      await expect(writeFederationPeerConfig(projectRoot, { ...config, startAuthority: undefined, ...changed }))
        .rejects.toThrow("Explicit startAuthority is required");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      await writeFederationPeerConfig(projectRoot, { ...config, ...changed });
      await expect(loadFederationPeerConfig(projectRoot)).resolves.toMatchObject(changed);
    });
});
