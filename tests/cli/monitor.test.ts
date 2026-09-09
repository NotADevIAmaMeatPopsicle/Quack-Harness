// Test that the monitor command is properly registered in the CLI
import {
  describeMonitorNetwork,
  formatMonitorUrlHost,
  resolveMonitorBindHost,
} from "../../src/cli/monitor";

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

  it("brackets IPv6 hosts in displayed URLs while preserving the raw bind host", () => {
    const host = resolveMonitorBindHost(" ::1 ");
    const network = describeMonitorNetwork(host, 3333, "single");

    expect(formatMonitorUrlHost(host)).toBe("[::1]");
    expect(network.bindHost).toBe("::1");
    expect(network.lines).toEqual([
      "Bind:      [::1]:3333",
      "Dashboard: http://[::1]:3333",
      "SSE:       http://[::1]:3333/api/events/stream",
      "Health:    http://[::1]:3333/api/health",
    ]);
  });
});
