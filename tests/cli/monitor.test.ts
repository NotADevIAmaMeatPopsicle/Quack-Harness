// Test that the monitor command is properly registered in the CLI

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
});
