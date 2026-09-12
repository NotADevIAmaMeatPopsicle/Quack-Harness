// Test that the monitor command is properly registered in the CLI
import {
  buildSingleProjectMonitorServerOptions,
  resolveMonitorBindHost,
} from "../../src/cli/monitor";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

describe("CLI monitor command", () => {
  it("is registered in the program", async () => {
    // Dynamically build a fresh program to check registration
    // We just verify the command exists by checking the module exports
    const mod = (await import("../../src/cli/monitor")) as {
      monitorCommand: (...args: unknown[]) => void;
    };
    expect(typeof mod.monitorCommand).toBe("function");
  });

  it("monitorCommand accepts options", async () => {
    const mod = (await import("../../src/cli/monitor")) as {
      monitorCommand: (...args: unknown[]) => void;
    };
    // Just verify the function signature doesn't throw on import
    expect(mod.monitorCommand.length).toBe(1); // one parameter: options
  });

  it("defaults its bind host to loopback in the implementation", () => {
    expect(resolveMonitorBindHost()).toBe("127.0.0.1");
    expect(resolveMonitorBindHost("   ")).toBe("127.0.0.1");
    expect(resolveMonitorBindHost("0.0.0.0")).toBe("0.0.0.0");
  });

  it("forwards operator-owned local-read authorization in single-project mode", () => {
    const trustedOrigin = "C:\\operator-owned\\demo-origin.git";
    const adapter = {
      projectRoot: "C:\\demo\\project",
      config: {
        project: { name: "demo", taskDir: "docs/tasks" },
        logging: { dir: ".quack/logs" },
      },
      trustedLocalReadRemotePaths: [trustedOrigin],
    } as ProjectAdapter;

    const options = buildSingleProjectMonitorServerOptions(adapter, 3347, "127.0.0.1");

    expect(options.trustedLocalReadRemotePaths).toEqual([trustedOrigin]);
    expect(options.projectRoot).toBe(adapter.projectRoot);
    expect(options.runtimeRole).toBe("headnode");
  });
});
