import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadFederationPeerConfig } from "../../src/monitor/federation/peer-config";

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
            url: "http://headnode.example.test:3333",
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
      url: "http://headnode.example.test:3333",
      remoteProjectId: "example-service",
      serviceToken: "qsvc_test",
      pushOnWrite: false,
      syncOnStartup: true,
      syncIntervalMs: 300000,
      limit: 250,
    });
  });
});
