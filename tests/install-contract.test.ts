import * as fs from "node:fs";
import * as path from "node:path";

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  packages?: Record<string, { hasInstallScript?: boolean }>;
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8"),
  ) as PackageManifest;
}

describe("repository install contract", () => {
  it("installs locked frontend dependencies during a root npm ci", () => {
    const rootPackage = readManifest("package.json");
    const rootLock = readManifest("package-lock.json");
    const frontendPackage = readManifest("frontend/package.json");
    const frontendLock = readManifest("frontend/package-lock.json");

    expect(rootPackage.scripts?.postinstall).toBe("npm --prefix frontend ci --no-audit --no-fund");
    expect(rootLock.packages?.[""]?.hasInstallScript).toBe(true);
    expect(rootPackage.scripts?.build).toContain("npm run build:frontend");
    expect(frontendPackage.name).toBe("quack-harness-ui");
    expect(frontendLock.name).toBe(frontendPackage.name);
  });

  it("keeps setup guidance and CI aligned with the root install contract", () => {
    const gettingStarted = fs.readFileSync(
      path.join(process.cwd(), "docs", "GETTING-STARTED.md"),
      "utf-8",
    );
    const troubleshooting = fs.readFileSync(
      path.join(process.cwd(), "docs", "TROUBLESHOOTING.md"),
      "utf-8",
    );
    const ciWorkflow = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "ci.yml"),
      "utf-8",
    );

    expect(gettingStarted).not.toContain("npm --prefix frontend ci");
    expect(ciWorkflow).not.toContain("npm --prefix frontend ci");
    expect(troubleshooting).not.toContain("The root install does not install");
    expect(troubleshooting).toContain("through `postinstall`");
  });
});
