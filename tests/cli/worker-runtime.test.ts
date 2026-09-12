import * as path from "node:path";

import { buildSingleProjectWorkerServerOptions } from "../../src/cli/worker";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

describe("CLI worker runtime", () => {
  it("forwards operator-owned local-read authorization in single-project mode", () => {
    const projectRoot = path.resolve("C:/demo/worker-project");
    const trustedOrigin = path.resolve("C:/operator-owned/worker-origin.git");
    const adapter = {
      projectRoot,
      config: {
        project: { taskDir: "docs/tasks" },
        logging: { dir: ".quack/logs" },
      },
      trustedLocalReadRemotePaths: [trustedOrigin],
    } as ProjectAdapter;

    const options = buildSingleProjectWorkerServerOptions(adapter, 3347, "127.0.0.1");

    expect(options.trustedLocalReadRemotePaths).toEqual([trustedOrigin]);
    expect(options.projectRoot).toBe(projectRoot);
    expect(options.runtimeRole).toBe("worker");
  });
});
