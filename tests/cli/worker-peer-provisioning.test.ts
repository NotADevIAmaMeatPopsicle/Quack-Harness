import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writePrimaryProjectPeerConfigs } from "../../src/cli/worker";
import { loadFederationPeerConfig, writeFederationPeerConfig } from "../../src/monitor/federation/peer-config";

it("the real worker provisioning step preserves explicit authority during repair", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-peer-provisioning-"));
  try {
    await writeFederationPeerConfig(root, { url: "http://headnode.test:3333",
      remoteProjectId: "fixture", startAuthority: { hostId: "worker" } });
    const paths = await writePrimaryProjectPeerConfigs({
      controlPlane: { baseUrl: "http://headnode.test:3333", runtimeRole: "headnode" },
      projects: [{ id: "fixture", label: "Fixture", repoId: "fixture", pathAlias: "fixture",
        primary: true, installCommands: [], probeCommands: [] }],
    }, { fixture: root });
    expect(paths).toEqual([path.join(root, ".quack/federation/peer.json")]);
    await expect(loadFederationPeerConfig(root)).resolves.toMatchObject({
      startAuthority: { hostId: "worker" }, remoteProjectId: "fixture", pushOnWrite: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("worker provisioning refuses corrupt peer config with a safe named error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-peer-provisioning-"));
  try {
    fs.mkdirSync(path.join(root, ".quack/federation"), { recursive: true });
    const file = path.join(root, ".quack/federation/peer.json");
    const corrupt = '{"serviceToken":"fixture-secret",';
    fs.writeFileSync(file, corrupt);
    const result = writePrimaryProjectPeerConfigs({
      controlPlane: { baseUrl: "http://headnode.test:3333", runtimeRole: "headnode" },
      projects: [{ id: "fixture", label: "Fixture", repoId: "fixture", pathAlias: "fixture",
        primary: true, installCommands: [], probeCommands: [] }],
    }, { fixture: root });
    await expect(result).rejects.toMatchObject({
      name: "FederationPeerConfigWriteError", code: "existing_peer_config_unreadable",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(corrupt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
