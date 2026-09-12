import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = path.resolve(__dirname, "..");
const fixtureRoots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(): { root: string; unrelated: string; npmCli: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "quack-package-contract-"));
  fixtureRoots.push(parent);
  const root = path.join(parent, "package with spaces");
  const unrelated = path.join(parent, "unrelated caller");
  fs.mkdirSync(root);
  fs.mkdirSync(unrelated);
  for (const helper of ["package-assets.cjs", "postinstall.cjs", "prepack.cjs"]) {
    write(
      root,
      `scripts/${helper}`,
      fs.readFileSync(path.join(sourceRoot, "scripts", helper), "utf8"),
    );
  }
  write(root, "package.json", JSON.stringify({ name: "quack-harness", version: "0.3.0" }));
  const npmCli = path.join(parent, "fake npm.cjs");
  fs.writeFileSync(
    npmCli,
    `const fs=require('node:fs');const path=require('node:path');
fs.writeFileSync(process.env.FAKE_NPM_RECORD,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));
if(process.env.FAKE_NPM_OUTPUT)fs.cpSync(process.env.FAKE_NPM_OUTPUT,path.join(process.cwd(),'dist'),{recursive:true});
process.exit(Number(process.env.FAKE_NPM_EXIT||'0'));
`,
  );
  return { root, unrelated, npmCli };
}

function sourceFiles(root: string): void {
  write(root, "src/index.ts", "export {};\n");
  write(root, "tsconfig.json", "{}\n");
  write(root, "frontend/package.json", '{"name":"fixture-ui"}\n');
  write(root, "frontend/package-lock.json", '{"name":"fixture-ui","lockfileVersion":3}\n');
}

function packagedFiles(root: string): void {
  for (const relative of [
    "LICENSE",
    "CHANGELOG.md",
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    "docs/GETTING-STARTED.md",
    "docs/ADAPTER_CONFIG_REFERENCE.md",
    "docs/CLI_REFERENCE.md",
    "docs/API_REFERENCE.md",
    "docs/TROUBLESHOOTING.md",
    "scripts/quack-listener.mjs",
    "scripts/quack-verify.mjs",
    "scripts/admin/install-windows-worker.ps1",
  ])
    write(root, relative, `fixture ${relative}\n`);
  write(root, "dist/index.js", 'console.log("fixture");\n');
  write(root, "dist/index.d.ts", "export {};\n");
  write(root, "dist/build-info.json", JSON.stringify({ version: "0.3.0", commit: "a".repeat(40) }));
  write(root, "dist/monitor/public/index.html", "<html>legacy</html>\n");
  write(
    root,
    "dist/monitor/ui/index.html",
    '<html><link rel="icon" href="data:,"><script type="module" src="/assets/app.js"></script></html>\n',
  );
  write(root, "dist/monitor/ui/assets/app.js", 'console.log("modern");\n');
}

function run(f: ReturnType<typeof fixture>, helper: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(f.root, "scripts", helper)], {
    cwd: f.unrelated,
    env: {
      ...process.env,
      npm_execpath: f.npmCli,
      FAKE_NPM_RECORD: path.join(f.root, "npm-record.json"),
      ...env,
    },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("package lifecycle scripts", () => {
  it("installs locked source frontend dependencies from its own root", () => {
    const f = fixture();
    sourceFiles(f.root);
    const result = run(f, "postinstall.cjs");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const recorded: unknown = JSON.parse(
      fs.readFileSync(path.join(f.root, "npm-record.json"), "utf8"),
    );
    expect(recorded).toEqual({
      cwd: f.root,
      args: ["--prefix", path.join(f.root, "frontend"), "ci", "--no-audit", "--no-fund"],
    });
    expect(fs.readdirSync(f.unrelated)).toEqual([]);
  });

  it("propagates a failing frontend install instead of accepting a partial source install", () => {
    const f = fixture();
    sourceFiles(f.root);
    const result = run(f, "postinstall.cjs", { FAKE_NPM_EXIT: "23" });
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("installation failed");
  });

  it("uses prebuilt consumer assets with no frontend, compiler, Git, or npm executable", () => {
    const f = fixture();
    packagedFiles(f.root);
    const identity = fs.readFileSync(path.join(f.root, "dist", "build-info.json"), "utf8");
    const result = run(f, "postinstall.cjs", {
      npm_execpath: path.join(f.root, "missing-npm.cjs"),
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(f.root, "npm-record.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "frontend"))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, "dist", "build-info.json"), "utf8")).toBe(identity);
  });

  it("refuses incomplete source inputs even if stale packaged assets are present", () => {
    const f = fixture();
    sourceFiles(f.root);
    packagedFiles(f.root);
    fs.unlinkSync(path.join(f.root, "frontend", "package-lock.json"));
    const result = run(f, "postinstall.cjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-lock.json");
    expect(fs.existsSync(path.join(f.root, "npm-record.json"))).toBe(false);
  });

  it.each([
    "dist/monitor/ui/index.html",
    "dist/monitor/ui/assets/app.js",
    "dist/monitor/public/index.html",
    "dist/build-info.json",
    "docs/API_REFERENCE.md",
    "scripts/admin/install-windows-worker.ps1",
  ])("refuses a packed artifact missing %s", (relativePath) => {
    const f = fixture();
    packagedFiles(f.root);
    fs.unlinkSync(path.join(f.root, relativePath));
    const result = run(f, "postinstall.cjs");
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(f.root, "npm-record.json"))).toBe(false);
  });

  it("refuses modern UI references outside the installed UI directory", () => {
    const f = fixture();
    packagedFiles(f.root);
    write(f.root, "dist/monitor/ui/index.html", '<script src="../../index.js"></script>');
    const result = run(f, "postinstall.cjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("escapes its root");
  });

  it("cleans only its dist before prepack and propagates a failed build", () => {
    const f = fixture();
    sourceFiles(f.root);
    packagedFiles(f.root);
    write(f.root, "dist/stale-private.js", "stale output\n");
    write(f.unrelated, "dist/keep.txt", "caller output\n");
    const result = run(f, "prepack.cjs", { FAKE_NPM_EXIT: "37" });
    expect(result.status).toBe(37);
    expect(fs.existsSync(path.join(f.root, "dist", "stale-private.js"))).toBe(false);
    expect(fs.readFileSync(path.join(f.unrelated, "dist", "keep.txt"), "utf8")).toBe(
      "caller output\n",
    );
  });

  it("requires the new build to contain every consumer asset", () => {
    const f = fixture();
    sourceFiles(f.root);
    packagedFiles(f.root);
    const result = run(f, "prepack.cjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packaging failed");
  });

  it("accepts a complete new build and leaves no old output behind", () => {
    const f = fixture();
    sourceFiles(f.root);
    packagedFiles(f.root);
    const buildOutput = path.join(path.dirname(f.root), "fresh-build");
    fs.cpSync(path.join(f.root, "dist"), buildOutput, { recursive: true });
    write(f.root, "dist/stale-private.js", "stale output\n");
    const result = run(f, "prepack.cjs", { FAKE_NPM_OUTPUT: buildOutput });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(f.root, "dist", "stale-private.js"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "dist", "monitor", "ui", "assets", "app.js"))).toBe(
      true,
    );
  });
});
