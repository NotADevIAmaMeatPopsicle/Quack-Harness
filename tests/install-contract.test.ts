import * as fs from "node:fs";
import * as path from "node:path";

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string;
  files?: string[];
  engines?: { node?: string };
  scripts?: Record<string, string>;
  packages?: Record<
    string,
    { version?: string; hasInstallScript?: boolean; engines?: { node?: string } }
  >;
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8"),
  ) as PackageManifest;
}

describe("repository and consumer install contract", () => {
  it("keeps public identity, locked metadata and supported Node versions aligned", () => {
    const rootPackage = readManifest("package.json");
    const rootLock = readManifest("package-lock.json");
    const frontendPackage = readManifest("frontend/package.json");
    const frontendLock = readManifest("frontend/package-lock.json");

    expect(rootPackage.name).toBe("quack-harness");
    expect(rootPackage.license).toBe("AGPL-3.0-only");
    expect(rootLock.version).toBe(rootPackage.version);
    expect(rootLock.packages?.[""]?.version).toBe(rootPackage.version);
    expect(rootPackage.engines?.node).toBe("^20.19.0 || ^22.12.0");
    expect(rootLock.packages?.[""]?.engines).toEqual(rootPackage.engines);
    expect(frontendPackage.engines).toEqual(rootPackage.engines);
    expect(frontendLock.packages?.[""]?.engines).toEqual(rootPackage.engines);
    expect(rootPackage.scripts?.postinstall).toBe("node scripts/postinstall.cjs");
    expect(rootPackage.scripts?.prepack).toBe("node scripts/prepack.cjs");
    expect(rootLock.packages?.[""]?.hasInstallScript).toBe(true);
    expect(rootPackage.scripts?.build).toContain("npm run build:frontend");
    expect(frontendPackage.name).toBe("quack-harness-ui");
    expect(frontendLock.name).toBe(frontendPackage.name);
  });

  it("ships runtime helpers without broad private directories", () => {
    const files = readManifest("package.json").files ?? [];
    for (const required of [
      "dist/",
      "CHANGELOG.md",
      "scripts/postinstall.cjs",
      "scripts/package-assets.cjs",
      "scripts/quack-listener.mjs",
      "scripts/quack-verify.mjs",
      "scripts/admin/install-windows-worker.ps1",
    ])
      expect(files).toContain(required);
    for (const excluded of [
      "*",
      "**",
      "docs/",
      "scripts/",
      "scripts/admin/",
      "adapters/",
      "src/",
      "frontend/",
      ".quack/",
      ".agents/",
      ".claude/",
      ".dev/",
    ])
      expect(files).not.toContain(excluded);
    for (const file of files.filter((entry) => entry !== "dist/")) {
      expect(fs.statSync(path.join(process.cwd(), file)).isFile()).toBe(true);
    }
  });

  it("documents source and tarball installation and requires natural CI completion", () => {
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

    expect(gettingStarted).toContain("through `postinstall`");
    expect(gettingStarted).toContain("--omit=dev");
    expect(gettingStarted).toContain("packed artifact");
    expect(troubleshooting).toContain("prebuilt");
    expect(ciWorkflow).not.toContain("--forceExit");
    expect(ciWorkflow).toContain("scripts/check-packed-consumer.cjs");
    expect(ciWorkflow).toContain("22.12.0");
  });
});
