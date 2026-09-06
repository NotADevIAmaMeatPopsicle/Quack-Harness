import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCcusageCommand } from "../../src/monitor/ccusage-command";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-ccusage-"));
}

describe("resolveCcusageCommand", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("prefers a direct ccusage shim on Windows", () => {
    const ccusagePath = path.join(tempDir, "ccusage.cmd");
    const npxPath = path.join(tempDir, "npx.cmd");
    fs.writeFileSync(ccusagePath, "", "utf-8");
    fs.writeFileSync(npxPath, "", "utf-8");

    const resolved = resolveCcusageCommand(
      {
        PATH: tempDir,
        APPDATA: tempDir,
      },
      "win32",
    );

    expect(resolved.command).toBe(ccusagePath);
    expect(resolved.argsPrefix).toEqual([]);
    expect(resolved.shell).toBe(true);
    expect(resolved.source).toBe("ccusage");
  });

  it("falls back to npx on Windows when ccusage is missing", () => {
    const npxPath = path.join(tempDir, "npx.cmd");
    fs.writeFileSync(npxPath, "", "utf-8");

    const resolved = resolveCcusageCommand(
      {
        PATH: tempDir,
        APPDATA: tempDir,
      },
      "win32",
    );

    expect(resolved.command).toBe(npxPath);
    expect(resolved.argsPrefix).toEqual(["ccusage"]);
    expect(resolved.shell).toBe(true);
    expect(resolved.source).toBe("npx");
  });

  it("checks the APPDATA npm shim directory on Windows", () => {
    const appDataDir = path.join(tempDir, "appdata");
    const npmDir = path.join(appDataDir, "npm");
    fs.mkdirSync(npmDir, { recursive: true });
    const ccusagePath = path.join(npmDir, "ccusage.cmd");
    fs.writeFileSync(ccusagePath, "", "utf-8");

    const resolved = resolveCcusageCommand(
      {
        PATH: "",
        APPDATA: appDataDir,
      },
      "win32",
    );

    expect(resolved.command).toBe(ccusagePath);
    expect(resolved.source).toBe("ccusage");
  });

  it("prefers a direct binary on non-Windows platforms", () => {
    const ccusagePath = path.join(tempDir, "ccusage");
    const npxPath = path.join(tempDir, "npx");
    fs.writeFileSync(ccusagePath, "", "utf-8");
    fs.writeFileSync(npxPath, "", "utf-8");

    const resolved = resolveCcusageCommand(
      {
        PATH: tempDir,
      },
      "linux",
    );

    expect(resolved.command).toBe(ccusagePath);
    expect(resolved.argsPrefix).toEqual([]);
    expect(resolved.shell).toBe(false);
    expect(resolved.source).toBe("ccusage");
  });
});
