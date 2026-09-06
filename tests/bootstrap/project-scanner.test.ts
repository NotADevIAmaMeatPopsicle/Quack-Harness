import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { scanProject } from "../../src/bootstrap/project-scanner";
import type { ScanResult } from "../../src/bootstrap/project-scanner";
import {
  generateAdapter,
  deriveTestPatterns,
  generateTestingConventionMd,
  generateTestExistenceCheck,
  generateTestExistenceConfig,
} from "../../src/bootstrap/adapter-generator";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { verificationCommandShellString, type VerificationCommand } from "../../src/core/types";

// ─── Helpers ────────────────────────────────────────────────────────

let tempRoot: string;

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-test-"));
  return dir;
}

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

async function mkdirp(dir: string, relPath: string): Promise<void> {
  await fs.mkdir(path.join(dir, relPath), { recursive: true });
}

type CommandLike = VerificationCommand | { command: string };

function commandText(command: CommandLike | undefined): string | undefined {
  if (!command) return undefined;
  if ("command" in command) return command.command;
  return verificationCommandShellString(command);
}

// ─── Test suites ────────────────────────────────────────────────────

describe("project-scanner", () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe("Node.js project detection", () => {
    let scan: ScanResult;

    beforeEach(async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "my-node-app",
          version: "1.0.0",
          scripts: { test: "jest" },
        }),
      );
      await writeFile(tempRoot, "tsconfig.json", "{}");
      await writeFile(tempRoot, "jest.config.js", "module.exports = {};");
      await mkdirp(tempRoot, "src");
      await mkdirp(tempRoot, "tests");
      await writeFile(tempRoot, "README.md", "# My Node App\n\nA sample app.");
      await writeFile(tempRoot, ".env.example", "API_KEY=xxx");

      scan = await scanProject(tempRoot);
    });

    it("should detect Node.js as the language", () => {
      expect(scan.language).toBe("node");
    });

    it("should extract the project name from package.json", () => {
      expect(scan.projectName).toBe("my-node-app");
    });

    it("should set the test command to 'npm test'", () => {
      expect(scan.testCommand).toBe("npm test");
    });

    it("should detect Jest as the test framework", () => {
      expect(scan.testFrameworks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "jest" })]),
      );
    });

    it("should detect TypeScript", () => {
      expect(scan.hasTypeScript).toBe(true);
    });

    it("should detect build tools", () => {
      expect(scan.buildTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "typescript" })]),
      );
    });

    it("should detect source directories", () => {
      expect(scan.sourceDirs).toContain("src/");
      expect(scan.sourceDirs).toContain("tests/");
    });

    it("should detect doc files", () => {
      expect(scan.docFiles).toContain("README.md");
      expect(scan.docFiles).toContain(".env.example");
    });

    it("should read README content", () => {
      expect(scan.readmeContent).toContain("My Node App");
    });

    it("should detect .env.example", () => {
      expect(scan.hasEnvExample).toBe(true);
    });

    it("should report no existing .quack directory", () => {
      expect(scan.hasExistingQuackDir).toBe(false);
    });

    it("should resolve to an absolute project path", () => {
      expect(path.isAbsolute(scan.projectPath)).toBe(true);
    });
  });

  describe("Python project detection", () => {
    let scan: ScanResult;

    beforeEach(async () => {
      const pyproject = [
        "[project]",
        'name = "my-python-app"',
        'version = "0.1.0"',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
      ].join("\n");
      await writeFile(tempRoot, "pyproject.toml", pyproject);
      await mkdirp(tempRoot, "src");
      await mkdirp(tempRoot, "tests");
      await writeFile(
        tempRoot,
        "CLAUDE.md",
        "# My Python App\n\n## Conventions\n- Use type hints\n",
      );

      scan = await scanProject(tempRoot);
    });

    it("should detect Python as the language", () => {
      expect(scan.language).toBe("python");
    });

    it("should extract the project name from pyproject.toml", () => {
      expect(scan.projectName).toBe("my-python-app");
    });

    it("should set the test command to 'pytest'", () => {
      expect(scan.testCommand).toBe("pytest");
    });

    it("should detect pytest as the test framework", () => {
      expect(scan.testFrameworks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "pytest" })]),
      );
    });

    it("should read CLAUDE.md content", () => {
      expect(scan.claudeMdContent).toContain("My Python App");
      expect(scan.claudeMdContent).toContain("type hints");
    });

    it("should detect source directories", () => {
      expect(scan.sourceDirs).toContain("src/");
      expect(scan.sourceDirs).toContain("tests/");
    });
  });

  describe("Python project with requirements.txt", () => {
    it("should detect Python from requirements.txt alone", async () => {
      await writeFile(tempRoot, "requirements.txt", "flask==3.0.0\npytest==8.0.0\n");

      const scan = await scanProject(tempRoot);

      expect(scan.language).toBe("python");
      expect(scan.testCommand).toBe("pytest");
    });
  });

  describe("Rust project detection", () => {
    it("should detect Rust from Cargo.toml", async () => {
      const cargoToml = [
        "[package]",
        'name = "my-rust-app"',
        'version = "0.1.0"',
        'edition = "2021"',
      ].join("\n");
      await writeFile(tempRoot, "Cargo.toml", cargoToml);
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);

      expect(scan.language).toBe("rust");
      expect(scan.projectName).toBe("my-rust-app");
      expect(scan.testCommand).toBe("cargo test");
      expect(scan.testFrameworks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "cargo-test" })]),
      );
    });
  });

  describe("Go project detection", () => {
    it("should detect Go from go.mod", async () => {
      await writeFile(tempRoot, "go.mod", "module github.com/user/my-go-app\n\ngo 1.22\n");

      const scan = await scanProject(tempRoot);

      expect(scan.language).toBe("go");
      expect(scan.projectName).toBe("my-go-app");
      expect(scan.testCommand).toBe("go test ./...");
      expect(scan.testFrameworks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "go-test" })]),
      );
    });
  });

  describe("unknown project", () => {
    it("should return 'unknown' when no recognizable files are found", async () => {
      await writeFile(tempRoot, "random.txt", "nothing here");

      const scan = await scanProject(tempRoot);

      expect(scan.language).toBe("unknown");
      expect(scan.testCommand).toBe("");
    });

    it("should fall back to directory name for project name", async () => {
      await writeFile(tempRoot, "random.txt", "nothing here");

      const scan = await scanProject(tempRoot);

      expect(scan.projectName).toBe(path.basename(tempRoot));
    });
  });

  describe("existing .quack directory", () => {
    it("should detect when .quack/ already exists", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, ".quack");

      const scan = await scanProject(tempRoot);

      expect(scan.hasExistingQuackDir).toBe(true);
    });
  });

  describe("Docker detection", () => {
    it("should detect Dockerfile", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "Dockerfile", "FROM node:20");

      const scan = await scanProject(tempRoot);

      expect(scan.hasDocker).toBe(true);
    });

    it("should detect docker-compose.yml", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "docker-compose.yml", "version: '3'");

      const scan = await scanProject(tempRoot);

      expect(scan.hasDocker).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw when path does not exist", async () => {
      await expect(scanProject("/nonexistent/path/12345")).rejects.toThrow();
    });

    it("should throw when path is a file, not a directory", async () => {
      const filePath = path.join(tempRoot, "afile.txt");
      await writeFile(tempRoot, "afile.txt", "content");

      await expect(scanProject(filePath)).rejects.toThrow("not a directory");
    });
  });
});

describe("adapter-generator", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-gen-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe("Node.js project", () => {
    it("should produce valid adapter.json that passes Zod schema", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "valid-node-project",
          version: "1.0.0",
        }),
      );
      await writeFile(tempRoot, "tsconfig.json", "{}");
      await writeFile(tempRoot, "jest.config.js", "module.exports = {};");
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      // Validate against the Zod schema
      const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
      expect(result.success).toBe(true);
    });

    it("should set npm test as the test command", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "node-test-project",
        }),
      );
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");
      expect(testCmd).toBeDefined();
      expect(commandText(testCmd)).toBe("npm test");
    });

    it("should include typecheck command for TypeScript projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "ts-project" }));
      await writeFile(tempRoot, "tsconfig.json", "{}");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const typecheckCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "typecheck",
      );
      expect(typecheckCmd).toBeDefined();
      expect(commandText(typecheckCmd)).toBe("npx tsc --noEmit");
    });

    it("should include lint command for Node.js projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "lint-project" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const lintCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "lint");
      expect(lintCmd).toBeDefined();
      expect(commandText(lintCmd)).toBe("npm run lint");
    });

    it("should set writable paths based on detected directories", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "dir-project" }));
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "lib"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.writablePaths).toContain("src/");
      expect(generated.adapterConfig.sandbox.writablePaths).toContain("tests/");
      expect(generated.adapterConfig.sandbox.writablePaths).toContain("lib/");
    });

    it("should deny .env files and node_modules", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "denied-project" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".env");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".env.*");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("node_modules/");
    });

    it("should include npm bash patterns in allowed list", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "bash-project" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.allowedBashPatterns).toContain("npm test *");
      expect(generated.adapterConfig.sandbox.allowedBashPatterns).toContain("npm run *");
    });

    it("should deny dangerous bash patterns", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "safe-project" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedBashPatterns).toContain("rm -rf *");
      expect(generated.adapterConfig.sandbox.deniedBashPatterns).toContain("git push *");
    });
  });

  describe("Python project", () => {
    it("should produce valid adapter.json that passes Zod schema", async () => {
      const pyproject = ["[project]", 'name = "my-python-api"', 'version = "0.1.0"'].join("\n");
      await writeFile(tempRoot, "pyproject.toml", pyproject);
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
      expect(result.success).toBe(true);
    });

    it("should set pytest as the test command", async () => {
      await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "py-test"\n');
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");
      expect(testCmd).toBeDefined();
      expect(commandText(testCmd)).toBe("pytest");
    });

    it("should include ruff lint command for Python projects", async () => {
      await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "py-lint"\n');

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const lintCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "lint");
      expect(lintCmd).toBeDefined();
      expect(commandText(lintCmd)).toBe("ruff check .");
    });
  });

  describe("conventions.md generation", () => {
    it("should include the project name in the heading", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "conventions-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("conventions-test");
    });

    it("should include stack info for Node.js TypeScript projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "ts-conv" }));
      await writeFile(tempRoot, "tsconfig.json", "{}");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("Node.js");
      expect(generated.conventionsMd).toContain("TypeScript");
    });

    it("should extract conventions from CLAUDE.md", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "claude-conv" }));
      await writeFile(
        tempRoot,
        "CLAUDE.md",
        "# Project\n\n## Conventions\n\n- Use strict TypeScript\n- No any types\n",
      );

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("Conventions");
      expect(generated.conventionsMd).toContain("strict TypeScript");
    });

    it("should extract notes from README.md when CLAUDE.md is absent", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "readme-conv" }));
      await writeFile(tempRoot, "README.md", "# My App\n\nThis is a cool app.\n");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("README.md");
      expect(generated.conventionsMd).toContain("My App");
    });

    it("should include the test command in the testing section", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test-cmd" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("npm test");
    });

    it("should include general guidance", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "general" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.conventionsMd).toContain("Follow existing code patterns");
      expect(generated.conventionsMd).toContain("All tests must pass");
    });
  });

  describe("adapter config defaults", () => {
    it("should set version to 1.0", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "version-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.version).toBe("1.0");
    });

    it("should set git defaults", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "git-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.git.baseBranch).toBe("main");
      expect(generated.adapterConfig.git.branchPrefix).toBe("quack/");
      expect(generated.adapterConfig.git.commitFormat).toBe("[{taskId}] {message}");
      expect(generated.adapterConfig.git.autoCreatePr).toBe(true);
      expect(generated.adapterConfig.git.autoPush).toBe(true);
    });

    it("should set agent defaults", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "agent-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.agent.model).toBe("claude-opus-4-6");
      expect(generated.adapterConfig.agent.maxTurns).toBe(50);
      expect(generated.adapterConfig.agent.maxBudgetPerTask).toBe(5.0);
      expect(generated.adapterConfig.agent.maxRetries).toBe(1);
    });

    it("should set logging defaults", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "logging-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.logging.dir).toBe(".quack/logs");
      expect(generated.adapterConfig.logging.level).toBe("debug");
      expect(generated.adapterConfig.logging.retainDays).toBe(30);
    });

    it("should set taskDir to docs/tasks", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "taskdir-test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.project.taskDir).toBe("docs/tasks");
    });

    it("should default writable paths when no source dirs detected", async () => {
      // Unknown project with no standard dirs
      await writeFile(tempRoot, "random.txt", "nothing");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.writablePaths).toContain("src/");
      expect(generated.adapterConfig.sandbox.writablePaths).toContain("tests/");
    });
  });

  describe("Rust project adapter", () => {
    it("should produce valid adapter.json", async () => {
      const cargoToml = '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n';
      await writeFile(tempRoot, "Cargo.toml", cargoToml);
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
      expect(result.success).toBe(true);
      expect(generated.adapterConfig.project.name).toBe("my-rust-app");
    });
  });

  describe("Go project adapter", () => {
    it("should produce valid adapter.json", async () => {
      await writeFile(tempRoot, "go.mod", "module github.com/user/my-go-app\n\ngo 1.22\n");
      await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
      expect(result.success).toBe(true);
      expect(generated.adapterConfig.project.name).toBe("my-go-app");
    });
  });
});

// ─── Testing Convention Module Tests ────────────────────────────────

describe("deriveTestPatterns", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-tp-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should return config for Node.js TypeScript project", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "tp-node" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await writeFile(tempRoot, "jest.config.js", "module.exports = {};");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeDefined();
    expect(patterns!.testDir).toBe("tests/");
    expect(patterns!.sourceDir).toBe("src/");
    expect(patterns!.suffixes).toContain(".test.ts");
    expect(patterns!.suffixes).toContain(".spec.ts");
    expect(patterns!.prefixes).toEqual([]);
    expect(patterns!.autoConventions).toEqual(["TESTING"]);
  });

  it("should return config for Node.js JavaScript project", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "tp-js" }));
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeDefined();
    expect(patterns!.suffixes).toContain(".test.js");
    expect(patterns!.suffixes).toContain(".spec.js");
  });

  it("should return config for Python project with test_ prefix", async () => {
    await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "tp-py"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeDefined();
    expect(patterns!.prefixes).toContain("test_");
    expect(patterns!.suffixes).toEqual([]);
  });

  it("should return co-located config for Go project", async () => {
    await writeFile(tempRoot, "go.mod", "module github.com/user/tp-go\n\ngo 1.22\n");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeDefined();
    expect(patterns!.suffixes).toContain("_test.go");
    expect(patterns!.testDir).toBe(patterns!.sourceDir); // co-located
  });

  it("should return undefined for Rust project", async () => {
    await writeFile(tempRoot, "Cargo.toml", '[package]\nname = "tp-rust"\nversion = "0.1.0"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeUndefined();
  });

  it("should return undefined for unknown language", async () => {
    // Empty directory with no recognizable project files
    const scan = await scanProject(tempRoot);
    const patterns = deriveTestPatterns(scan);

    expect(patterns).toBeUndefined();
  });
});

describe("generateTestingConventionMd", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-tcmd-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should include Jest template for Node.js project", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "tcmd-jest" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await writeFile(tempRoot, "jest.config.js", "module.exports = {};");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const md = generateTestingConventionMd(scan);

    expect(md).toContain("# TESTING");
    expect(md).toContain("npm test");
    expect(md).toContain("jest");
    expect(md).toContain("describe");
    expect(md).toContain("expect");
    expect(md).toContain("*.test.ts");
    expect(md).toContain("Known Gotchas");
  });

  it("should include pytest template for Python project", async () => {
    await writeFile(
      tempRoot,
      "pyproject.toml",
      '[project]\nname = "tcmd-py"\n\n[tool.pytest.ini_options]\n',
    );
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const md = generateTestingConventionMd(scan);

    expect(md).toContain("pytest");
    expect(md).toContain("def test_");
    expect(md).toContain("assert");
    expect(md).toContain("test_*.py");
  });

  it("should include Rust inline test template", async () => {
    await writeFile(tempRoot, "Cargo.toml", '[package]\nname = "tcmd-rust"\nversion = "0.1.0"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const md = generateTestingConventionMd(scan);

    expect(md).toContain("cargo test");
    expect(md).toContain("#[cfg(test)]");
    expect(md).toContain("Inline in source files");
  });

  it("should include Go test template", async () => {
    await writeFile(tempRoot, "go.mod", "module github.com/user/tcmd-go\n\ngo 1.22\n");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const md = generateTestingConventionMd(scan);

    expect(md).toContain("go test");
    expect(md).toContain("TestMyFunction");
    expect(md).toContain("_test.go");
  });

  it("should include placeholder for unknown language", async () => {
    const scan = await scanProject(tempRoot);
    const md = generateTestingConventionMd(scan);

    expect(md).toContain("configure manually");
    expect(md).toContain("Known Gotchas");
  });
});

describe("generateTestExistenceCheck", () => {
  it("should return valid JS script with shebang", () => {
    const script = generateTestExistenceCheck();

    expect(script).toContain("#!/usr/bin/env node");
    expect(script).toContain("test-existence.config.json");
    expect(script).toContain("git diff HEAD --name-only");
    expect(script).toContain("process.exit(0)");
    expect(script).toContain("process.exit(1)");
  });

  it("should handle both suffix and prefix patterns", () => {
    const script = generateTestExistenceCheck();

    expect(script).toContain("testSuffixes");
    expect(script).toContain("testPrefixes");
  });
});

describe("generateTestExistenceConfig", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-tec-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should produce correct config for Node.js TypeScript", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "tec-node" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const configJson = generateTestExistenceConfig(scan);
    const config = JSON.parse(configJson) as Record<string, unknown>;

    expect(config.sourceDir).toBe("src/");
    expect(config.testDir).toBe("tests/");
    expect(config.testSuffixes).toContain(".test.ts");
    expect(config.testPrefixes).toEqual([]);
    expect(config.ignorePaths).toContain("src/index.ts");
  });

  it("should produce correct config for Python", async () => {
    await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "tec-py"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const configJson = generateTestExistenceConfig(scan);
    const config = JSON.parse(configJson) as Record<string, unknown>;

    expect(config.testPrefixes).toContain("test_");
    expect(config.ignorePaths).toContain("src/__init__.py");
  });

  it("should produce empty suffixes for Rust", async () => {
    await writeFile(tempRoot, "Cargo.toml", '[package]\nname = "tec-rust"\nversion = "0.1.0"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const configJson = generateTestExistenceConfig(scan);
    const config = JSON.parse(configJson) as Record<string, unknown>;

    // Rust has no test file mapping — uses defaults
    expect(config.testSuffixes).toEqual([]);
    expect(config.testPrefixes).toEqual([]);
  });
});

describe("generateAdapter with testing convention", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-gatc-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should include test-existence convention check for Node.js", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "gatc-node" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    const checks = generated.adapterConfig.verification.conventionChecks;
    expect(checks.some((c) => c.name === "test-existence")).toBe(true);
    expect(checks.find((c) => c.name === "test-existence")?.conventionRef).toBe("TESTING");
  });

  it("should include testPatterns in project config", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "gatc-tp" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    expect(generated.adapterConfig.project.testPatterns).toBeDefined();
    expect(generated.adapterConfig.project.testPatterns!.autoConventions).toContain("TESTING");
  });

  it("should not include test-existence check for Rust", async () => {
    await writeFile(tempRoot, "Cargo.toml", '[package]\nname = "gatc-rust"\nversion = "0.1.0"\n');
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    expect(generated.adapterConfig.verification.conventionChecks).toEqual([]);
    expect(generated.adapterConfig.project.testPatterns).toBeUndefined();
  });

  it("should include TESTING.md and check script in generated output", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "gatc-full" }));
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    expect(generated.testingConventionMd).toContain("# TESTING");
    expect(generated.testExistenceCheckJs).toContain("#!/usr/bin/env node");
    expect(generated.testExistenceConfigJson).toBeTruthy();
    JSON.parse(generated.testExistenceConfigJson); // should not throw
  });

  it("should still pass Zod schema validation", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "gatc-zod" }));
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
    expect(result.success).toBe(true);
  });

  // ─── Enhanced detection tests ────────────────────────────────────

  describe("Task location detection", () => {
    it("should detect TASK-*.md files in docs/tasks/", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/tasks");
      await writeFile(tempRoot, "docs/tasks/TASK-001-example.md", "# Task 1");
      await writeFile(tempRoot, "docs/tasks/TASK-002-example.md", "# Task 2");

      const scan = await scanProject(tempRoot);
      expect(scan.taskLocations.length).toBeGreaterThan(0);
      expect(scan.taskLocations.some((loc) => loc.path === "docs/tasks")).toBe(true);
    });

    it("should detect task files in root directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "TASK-001.md", "# Task 1");

      const scan = await scanProject(tempRoot);
      expect(scan.taskLocations.some((loc) => loc.path === "TASK-001.md")).toBe(true);
    });

    it("should detect tasks in backlog/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "backlog");

      const scan = await scanProject(tempRoot);
      expect(scan.taskLocations.some((loc) => loc.path === "backlog")).toBe(true);
    });

    it("should detect .github/ISSUE_TEMPLATE/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, ".github/ISSUE_TEMPLATE");

      const scan = await scanProject(tempRoot);
      expect(scan.taskLocations.some((loc) => loc.path === ".github/ISSUE_TEMPLATE")).toBe(true);
    });
  });

  describe("ADR location detection", () => {
    it("should detect ADR-*.md files in docs/adr/", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/adr");
      await writeFile(tempRoot, "docs/adr/ADR-001.md", "# ADR 1");

      const scan = await scanProject(tempRoot);
      expect(scan.adrLocations.some((loc) => loc.path === "docs/adr")).toBe(true);
    });

    it("should detect ADR files in root directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "ADR-001.md", "# ADR 1");

      const scan = await scanProject(tempRoot);
      expect(scan.adrLocations.some((loc) => loc.path === "ADR-001.md")).toBe(true);
    });

    it("should detect docs/decisions/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/decisions");

      const scan = await scanProject(tempRoot);
      expect(scan.adrLocations.some((loc) => loc.path === "docs/decisions")).toBe(true);
    });
  });

  describe("Architecture doc detection", () => {
    it("should detect ARCHITECTURE.md in root", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "ARCHITECTURE.md", "# Architecture");

      const scan = await scanProject(tempRoot);
      expect(scan.architectureDocs.some((loc) => loc.path === "ARCHITECTURE.md")).toBe(true);
    });

    it("should detect docs/architecture/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/architecture");

      const scan = await scanProject(tempRoot);
      expect(scan.architectureDocs.some((loc) => loc.path === "docs/architecture")).toBe(true);
    });

    it("should detect docs/design/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/design");

      const scan = await scanProject(tempRoot);
      expect(scan.architectureDocs.some((loc) => loc.path === "docs/design")).toBe(true);
    });
  });

  describe("Convention file detection", () => {
    it("should detect CONVENTIONS.md in root", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "CONVENTIONS.md", "# Conventions");

      const scan = await scanProject(tempRoot);
      expect(scan.conventionFiles.some((loc) => loc.path === "CONVENTIONS.md")).toBe(true);
    });

    it("should detect CLAUDE.md in root", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "CLAUDE.md", "# Claude");

      const scan = await scanProject(tempRoot);
      expect(scan.conventionFiles.some((loc) => loc.path === "CLAUDE.md")).toBe(true);
    });

    it("should detect .editorconfig", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".editorconfig", "root = true");

      const scan = await scanProject(tempRoot);
      expect(scan.conventionFiles.some((loc) => loc.path === ".editorconfig")).toBe(true);
    });

    it("should detect docs/conventions directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/conventions");

      const scan = await scanProject(tempRoot);
      expect(scan.conventionFiles.some((loc) => loc.path === "docs/conventions")).toBe(true);
    });
  });

  describe("Linter detection", () => {
    it("should detect ESLint with .eslintrc.js", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".eslintrc.js", "module.exports = {}");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "eslint")).toBe(true);
      const eslint = scan.linters.find((l) => l.name === "eslint");
      expect(commandText(eslint)).toContain("eslint --max-warnings 0");
      expect(eslint?.fixCommand).toContain("eslint --fix");
    });

    it("should detect Prettier with .prettierrc", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".prettierrc", "{}");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "prettier")).toBe(true);
      const prettier = scan.linters.find((l) => l.name === "prettier");
      expect(commandText(prettier)).toContain("prettier --check");
      expect(prettier?.fixCommand).toContain("prettier --write");
    });

    it("should detect Ruff with ruff.toml", async () => {
      await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "test"');
      await writeFile(tempRoot, "ruff.toml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "ruff")).toBe(true);
    });

    it("should detect Ruff in pyproject.toml", async () => {
      await writeFile(
        tempRoot,
        "pyproject.toml",
        '[project]\nname = "test"\n\n[tool.ruff]\nline-length = 88',
      );

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "ruff")).toBe(true);
    });

    it("should detect golangci-lint with .golangci.yml", async () => {
      await writeFile(tempRoot, "go.mod", "module test");
      await writeFile(tempRoot, ".golangci.yml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "golangci-lint")).toBe(true);
      const linter = scan.linters.find((l) => l.name === "golangci-lint");
      expect(linter?.configFile).toBe(".golangci.yml");
    });

    it("should detect golangci-lint with .golangci.yaml", async () => {
      await writeFile(tempRoot, "go.mod", "module test");
      await writeFile(tempRoot, ".golangci.yaml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "golangci-lint")).toBe(true);
      const linter = scan.linters.find((l) => l.name === "golangci-lint");
      expect(linter?.configFile).toBe(".golangci.yaml");
    });

    it("should detect rustfmt with rustfmt.toml", async () => {
      await writeFile(tempRoot, "Cargo.toml", '[package]\nname = "test"\nversion = "0.1.0"');
      await writeFile(tempRoot, "rustfmt.toml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.linters.some((l) => l.name === "rustfmt")).toBe(true);
    });
  });

  describe("CI/CD detection", () => {
    it("should detect GitHub Actions", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, ".github/workflows");

      const scan = await scanProject(tempRoot);
      expect(scan.ciPipelines.some((p) => p.path === ".github/workflows")).toBe(true);
    });

    it("should detect GitLab CI", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".gitlab-ci.yml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.ciPipelines.some((p) => p.path === ".gitlab-ci.yml")).toBe(true);
    });

    it("should detect CircleCI", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, ".circleci");

      const scan = await scanProject(tempRoot);
      expect(scan.ciPipelines.some((p) => p.path === ".circleci")).toBe(true);
    });

    it("should detect Travis CI", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".travis.yml", "");

      const scan = await scanProject(tempRoot);
      expect(scan.ciPipelines.some((p) => p.path === ".travis.yml")).toBe(true);
    });

    it("should detect Jenkins", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "Jenkinsfile", "");

      const scan = await scanProject(tempRoot);
      expect(scan.ciPipelines.some((p) => p.path === "Jenkinsfile")).toBe(true);
    });
  });

  describe("Database config detection", () => {
    it("should detect Prisma", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "prisma");

      const scan = await scanProject(tempRoot);
      expect(scan.databaseConfigs.some((d) => d.path === "prisma")).toBe(true);
    });

    it("should detect Drizzle", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "drizzle.config.ts", "");

      const scan = await scanProject(tempRoot);
      expect(scan.databaseConfigs.some((d) => d.path === "drizzle.config.ts")).toBe(true);
    });

    it("should detect Knex", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "knexfile.js", "");

      const scan = await scanProject(tempRoot);
      expect(scan.databaseConfigs.some((d) => d.path === "knexfile.js")).toBe(true);
    });

    it("should detect Alembic", async () => {
      await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "test"');
      await mkdirp(tempRoot, "alembic");

      const scan = await scanProject(tempRoot);
      expect(scan.databaseConfigs.some((d) => d.path === "alembic")).toBe(true);
    });

    it("should detect migrations/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "migrations");

      const scan = await scanProject(tempRoot);
      expect(scan.databaseConfigs.some((d) => d.path === "migrations")).toBe(true);
    });
  });

  describe("Container config detection", () => {
    it("should detect Dockerfile", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "Dockerfile", "FROM node:18");

      const scan = await scanProject(tempRoot);
      expect(scan.containerConfigs.some((c) => c.path === "Dockerfile")).toBe(true);
    });

    it("should detect docker-compose.yml", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "docker-compose.yml", "version: '3'");

      const scan = await scanProject(tempRoot);
      expect(scan.containerConfigs.some((c) => c.path === "docker-compose.yml")).toBe(true);
    });

    it("should detect k8s/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "k8s");

      const scan = await scanProject(tempRoot);
      expect(scan.containerConfigs.some((c) => c.path === "k8s")).toBe(true);
    });
  });

  describe("Framework detection", () => {
    it("should detect Next.js from dependencies", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { next: "^14.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.frameworkType).toBe("nextjs");
    });

    it("should detect Express from dependencies", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { express: "^4.18.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.frameworkType).toBe("express");
    });

    it("should detect FastAPI from pyproject.toml", async () => {
      await writeFile(
        tempRoot,
        "pyproject.toml",
        '[project]\nname = "test"\ndependencies = ["fastapi"]',
      );

      const scan = await scanProject(tempRoot);
      expect(scan.frameworkType).toBe("fastapi");
    });

    it("should detect Django from requirements.txt", async () => {
      await writeFile(tempRoot, "requirements.txt", "Django==4.2.0\npsycopg2-binary==2.9.0");

      const scan = await scanProject(tempRoot);
      expect(scan.frameworkType).toBe("django");
    });
  });

  describe("API pattern detection", () => {
    it("should detect routes/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "routes");

      const scan = await scanProject(tempRoot);
      expect(scan.apiPatterns.some((a) => a.path === "routes")).toBe(true);
    });

    it("should detect src/controllers/ directory", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "src/controllers");

      const scan = await scanProject(tempRoot);
      expect(scan.apiPatterns.some((a) => a.path === "src/controllers")).toBe(true);
    });
  });

  describe("Monorepo detection", () => {
    it("should detect npm workspaces", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          workspaces: ["packages/*"],
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.isMonorepo).toBe(true);
      expect(scan.workspaces).toContain("packages/*");
    });

    it("should detect pnpm workspace", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'");

      const scan = await scanProject(tempRoot);
      expect(scan.isMonorepo).toBe(true);
    });

    it("should detect lerna.json", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "lerna.json", "{}");

      const scan = await scanProject(tempRoot);
      expect(scan.isMonorepo).toBe(true);
    });

    it("should detect nx.json", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "nx.json", "{}");

      const scan = await scanProject(tempRoot);
      expect(scan.isMonorepo).toBe(true);
    });

    it("should not detect monorepo for simple projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);
      expect(scan.isMonorepo).toBe(false);
      expect(scan.workspaces).toEqual([]);
    });
  });

  describe("Browser target detection", () => {
    it("should detect browser target from public/index.html", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "public");
      await writeFile(tempRoot, "public/index.html", "<!DOCTYPE html><html><body></body></html>");

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(true);
    });

    it("should detect browser target from root index.html", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "index.html", "<!DOCTYPE html>");

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(true);
    });

    it("should detect browser target from React dependency", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(true);
    });

    it("should detect browser target from Vue dependency", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { vue: "^3.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(true);
    });

    it("should detect browser target from Vite devDependency", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { vite: "^5.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(true);
    });

    it("should not detect browser target for CLI projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { commander: "^12.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(false);
    });

    it("should not detect browser target for Python projects", async () => {
      await writeFile(tempRoot, "pyproject.toml", '[project]\nname = "test"');

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(false);
    });
  });

  describe("Browser test framework detection", () => {
    it("should detect Playwright from config file on browser project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
        }),
      );
      await writeFile(tempRoot, "playwright.config.ts", "export default {}");

      const scan = await scanProject(tempRoot);
      const browser = scan.runtimeTargets.find((t) => t.type === "browser");
      expect(browser?.testFrameworks).toContain("playwright");
    });

    it("should detect Cypress from config file on browser project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { vue: "^3.0.0" },
        }),
      );
      await writeFile(tempRoot, "cypress.config.ts", "export default {}");

      const scan = await scanProject(tempRoot);
      const browser = scan.runtimeTargets.find((t) => t.type === "browser");
      expect(browser?.testFrameworks).toContain("cypress");
    });

    it("should detect @playwright/test from devDependencies on browser project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
          devDependencies: { "@playwright/test": "^1.40.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const browser = scan.runtimeTargets.find((t) => t.type === "browser");
      expect(browser?.testFrameworks).toContain("playwright");
    });

    it("should detect cypress from devDependencies on browser project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { vue: "^3.0.0" },
          devDependencies: { cypress: "^13.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const browser = scan.runtimeTargets.find((t) => t.type === "browser");
      expect(browser?.testFrameworks).toContain("cypress");
    });

    it("should return no browser target when no browser test framework detected for non-browser project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { jest: "^29.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "browser")).toBe(false);
    });

    it("should not duplicate framework when both config and dep exist", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
          devDependencies: { "@playwright/test": "^1.40.0" },
        }),
      );
      await writeFile(tempRoot, "playwright.config.ts", "export default {}");

      const scan = await scanProject(tempRoot);
      const browser = scan.runtimeTargets.find((t) => t.type === "browser");
      expect(browser).toBeDefined();
      const playwrightCount = browser!.testFrameworks.filter((f) => f === "playwright").length;
      expect(playwrightCount).toBe(1);
    });
  });

  describe("Android runtime detection", () => {
    it("should detect Android from AndroidManifest.xml", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "build.gradle", 'apply plugin: "com.android.application"');
      await writeFile(tempRoot, "settings.gradle", "include ':app'");
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");

      const scan = await scanProject(tempRoot);
      const android = scan.runtimeTargets.find((t) => t.type === "android");
      expect(android).toBeDefined();
      expect(android!.confidence).toBe("high");
    });

    it("should detect espresso test framework from build.gradle", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "build.gradle", 'apply plugin: "com.android.application"');
      await writeFile(tempRoot, "settings.gradle", "include ':app'");
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");
      await writeFile(
        tempRoot,
        "app/build.gradle",
        'androidTestImplementation "androidx.test.espresso:espresso-core:3.5.1"',
      );

      const scan = await scanProject(tempRoot);
      const android = scan.runtimeTargets.find((t) => t.type === "android");
      expect(android!.testFrameworks).toContain("espresso");
    });

    it("should include android-unit test command (no device required)", async () => {
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");

      const scan = await scanProject(tempRoot);
      const android = scan.runtimeTargets.find((t) => t.type === "android");
      expect(android).toBeDefined();
      const unitCmd = android!.testCommands.find((c) => c.name === "android-unit");
      expect(unitCmd).toBeDefined();
      expect(unitCmd!.requiresDevice).toBe(false);
    });

    it("should include android-instrumented test command (requires device)", async () => {
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");

      const scan = await scanProject(tempRoot);
      const android = scan.runtimeTargets.find((t) => t.type === "android");
      expect(android).toBeDefined();
      const instrCmd = android!.testCommands.find((c) => c.name === "android-instrumented");
      expect(instrCmd).toBeDefined();
      expect(instrCmd!.requiresDevice).toBe(true);
    });

    it("should detect React Native android/ pattern with medium confidence", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { "react-native": "^0.73.0" },
        }),
      );
      await mkdirp(tempRoot, "android");
      await writeFile(tempRoot, "android/build.gradle", "buildscript {}");

      const scan = await scanProject(tempRoot);
      const android = scan.runtimeTargets.find((t) => t.type === "android");
      expect(android).toBeDefined();
      expect(android!.confidence).toBe("medium");
    });

    it("should not detect Android for CLI Node projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { commander: "^12.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "android")).toBe(false);
    });
  });

  describe("Desktop runtime detection", () => {
    it("should detect Electron from dependencies", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { electron: "^28.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const electron = scan.runtimeTargets.find((t) => t.type === "electron");
      expect(electron).toBeDefined();
      expect(electron!.confidence).toBe("high");
    });

    it("should detect Electron from electron-builder", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { "electron-builder": "^24.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "electron")).toBe(true);
    });

    it("should detect Tauri from src-tauri/Cargo.toml", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "src-tauri");
      await writeFile(tempRoot, "src-tauri/Cargo.toml", '[package]\nname = "test-app"');

      const scan = await scanProject(tempRoot);
      const tauri = scan.runtimeTargets.find((t) => t.type === "tauri");
      expect(tauri).toBeDefined();
      expect(tauri!.confidence).toBe("high");
    });

    it("should detect Tauri from src-tauri/tauri.conf.json", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "src-tauri");
      await writeFile(tempRoot, "src-tauri/tauri.conf.json", "{}");

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "tauri")).toBe(true);
    });

    it("should not detect desktop for Express backend projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { express: "^4.18.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "electron")).toBe(false);
      expect(scan.runtimeTargets.some((t) => t.type === "tauri")).toBe(false);
    });

    it("should detect spectron test framework for Electron", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { electron: "^28.0.0", spectron: "^19.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const electron = scan.runtimeTargets.find((t) => t.type === "electron");
      expect(electron!.testFrameworks).toContain("spectron");
    });
  });

  describe("React Native runtime detection", () => {
    it("should detect React Native from dependencies", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { "react-native": "^0.73.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const rn = scan.runtimeTargets.find((t) => t.type === "react-native");
      expect(rn).toBeDefined();
      expect(rn!.confidence).toBe("high");
    });

    it("should detect detox test framework", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { "react-native": "^0.73.0" },
          devDependencies: { detox: "^20.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const rn = scan.runtimeTargets.find((t) => t.type === "react-native");
      expect(rn!.testFrameworks).toContain("detox");
    });

    it("should detect appium test framework", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { "react-native": "^0.73.0" },
          devDependencies: { appium: "^2.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const rn = scan.runtimeTargets.find((t) => t.type === "react-native");
      expect(rn!.testFrameworks).toContain("appium");
    });

    it("should not detect React Native for regular React project", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      expect(scan.runtimeTargets.some((t) => t.type === "react-native")).toBe(false);
    });
  });

  describe("Runtime verification commands in adapter", () => {
    it("should add browser-tests command for web projects with Playwright", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
          devDependencies: { "@playwright/test": "^1.40.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const browserCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "browser-tests",
      );
      expect(browserCmd).toBeDefined();
      expect(commandText(browserCmd)).toBe("npx playwright test");
      expect(browserCmd?.required).toBe(false);
      expect(browserCmd?.timeout).toBe(600);
    });

    it("should add browser-tests command for web projects with Cypress", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { vue: "^3.0.0" },
          devDependencies: { cypress: "^13.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const browserCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "browser-tests",
      );
      expect(browserCmd).toBeDefined();
      expect(commandText(browserCmd)).toBe("npx cypress run");
    });

    it("should not add browser-tests command for non-web projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { commander: "^12.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const browserCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "browser-tests",
      );
      expect(browserCmd).toBeUndefined();
    });

    it("should not add browser-tests for web project without browser test framework", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
        }),
      );
      await mkdirp(tempRoot, "public");
      await writeFile(tempRoot, "public/index.html", "<!DOCTYPE html>");
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const browserCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "browser-tests",
      );
      expect(browserCmd).toBeUndefined();
    });

    it("should add android-unit command for Android projects (skip instrumented)", async () => {
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");
      await writeFile(
        tempRoot,
        "app/build.gradle",
        'androidTestImplementation "androidx.test.espresso:espresso-core:3.5.1"',
      );

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const unitCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "android-unit",
      );
      expect(unitCmd).toBeDefined();
      expect(commandText(unitCmd)).toBe("./gradlew test");

      // Instrumented tests require a device, should NOT be in verification commands
      const instrCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "android-instrumented",
      );
      expect(instrCmd).toBeUndefined();
    });

    it("should add desktop-tests command for Electron projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { electron: "^28.0.0", "@playwright/test": "^1.40.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const desktopCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "desktop-tests",
      );
      expect(desktopCmd).toBeDefined();
      expect(commandText(desktopCmd)).toBe("npx playwright test");
    });

    it("should add desktop-tests command for Tauri projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "src-tauri");
      await writeFile(tempRoot, "src-tauri/Cargo.toml", '[package]\nname = "test-app"');
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const desktopCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "desktop-tests",
      );
      expect(desktopCmd).toBeDefined();
      expect(commandText(desktopCmd)).toContain("cargo test");
    });
  });

  describe("TESTING.md runtime testing sections", () => {
    it("should include functional testing section for web projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
        }),
      );
      await mkdirp(tempRoot, "public");
      await writeFile(tempRoot, "public/index.html", "<!DOCTYPE html>");
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("Functional/Browser Testing");
      expect(md).toContain("Unit tests alone are insufficient");
      expect(md).toContain("Import resolution");
      expect(md).toContain("extensionless imports");
      expect(md).toContain("Recommended: Set up Playwright");
    });

    it("should reference detected browser test framework in TESTING.md", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0" },
          devDependencies: { "@playwright/test": "^1.40.0" },
        }),
      );
      await mkdirp(tempRoot, "public");
      await writeFile(tempRoot, "public/index.html", "<!DOCTYPE html>");
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("Functional/Browser Testing");
      expect(md).toContain("Configured framework: playwright");
      expect(md).toContain("npx playwright test");
      expect(md).not.toContain("Recommended: Set up Playwright");
    });

    it("should not include browser testing section for non-web projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { express: "^4.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).not.toContain("Functional/Browser Testing");
    });

    it("should include Android section for Android projects", async () => {
      await mkdirp(tempRoot, "app/src/main");
      await writeFile(tempRoot, "app/src/main/AndroidManifest.xml", "<manifest />");

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("Android Runtime Testing");
      expect(md).toContain("Activity/Fragment lifecycle");
      expect(md).toContain("./gradlew test");
      expect(md).toContain("./gradlew connectedAndroidTest");
    });

    it("should include Desktop section for Electron projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          devDependencies: { electron: "^28.0.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("Electron Desktop Testing");
      expect(md).toContain("IPC (main↔renderer)");
    });

    it("should include Desktop section for Tauri projects", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "src-tauri");
      await writeFile(tempRoot, "src-tauri/Cargo.toml", '[package]\nname = "test-app"');

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("Tauri Desktop Testing");
      expect(md).toContain("Rust↔JS bridge");
    });

    it("should include React Native section for RN projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { "react-native": "^0.73.0" },
        }),
      );

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).toContain("React Native Testing");
      expect(md).toContain("Native bridge");
      expect(md).toContain("Recommended: Set up Detox");
    });

    it("should not include platform sections for non-target platforms", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { commander: "^12.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const md = generateTestingConventionMd(scan);

      expect(md).not.toContain("Functional/Browser Testing");
      expect(md).not.toContain("Android Runtime Testing");
      expect(md).not.toContain("Desktop Testing");
      expect(md).not.toContain("React Native Testing");
    });
  });

  describe("Empty project edge case", () => {
    it("should return empty arrays for enhanced fields when nothing detected", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);
      expect(scan.taskLocations).toEqual([]);
      expect(scan.adrLocations).toEqual([]);
      expect(scan.architectureDocs).toEqual([]);
      expect(scan.linters).toEqual([]);
      expect(scan.ciPipelines).toEqual([]);
      expect(scan.databaseConfigs).toEqual([]);
      expect(scan.containerConfigs).toEqual([]);
      expect(scan.apiPatterns).toEqual([]);
      expect(scan.isMonorepo).toBe(false);
      expect(scan.workspaces).toEqual([]);
    });
  });

  describe("Adapter generator with enhanced scan", () => {
    it("should include detected linters in verification commands", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".eslintrc.js", "module.exports = {}");
      await writeFile(tempRoot, ".prettierrc", "{}");
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const eslintCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "eslint",
      );
      const prettierCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "prettier",
      );

      expect(eslintCmd).toBeDefined();
      expect(commandText(eslintCmd)).toContain("eslint --max-warnings 0");
      expect(prettierCmd).toBeDefined();
      expect(commandText(prettierCmd)).toContain("prettier --check");
    });

    it("should auto-detect task directory from docs/tasks/", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/tasks");
      await writeFile(tempRoot, "docs/tasks/TASK-001.md", "# Task 1");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.project.taskDir).toBe("docs/tasks");
    });

    it("should auto-detect conventions directory from root CONVENTIONS.md", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "CONVENTIONS.md", "# Conventions");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.project.conventionsDir).toBe(".");
    });

    it("should auto-detect conventions directory from docs/conventions/", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await mkdirp(tempRoot, "docs/conventions");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.project.conventionsDir).toBe("docs/conventions");
    });

    it("should handle empty task directory (root-level task files)", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "TASK-001.md", "# Task 1");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      // Root directory becomes "."
      expect(generated.adapterConfig.project.taskDir).toBe(".");
    });

    it("should add .next/ to denied paths for Next.js projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { next: "^14.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".next/");
    });

    it("should add .nuxt/ to denied paths for Nuxt projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { nuxt: "^3.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".nuxt/");
    });

    it("should add Python-specific denied paths for Python projects", async () => {
      await writeFile(tempRoot, "pyproject.toml", "[project]\nname = 'test'");
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("__pycache__/");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("*.pyc");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".pytest_cache/");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain(".mypy_cache/");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("*.egg-info/");
    });

    it("should add dist/ and build/ to denied paths for Node.js projects", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          dependencies: { express: "^4.0.0" },
        }),
      );
      await mkdirp(tempRoot, "src");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("dist/");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("build/");
      expect(generated.adapterConfig.sandbox.deniedPaths).toContain("node_modules/");
    });

    it("should not add .editorconfig to conventionsDir when it's the only file", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".editorconfig", "root = true");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      // Should fall back to default .quack, not set to "."
      expect(generated.adapterConfig.project.conventionsDir).toBe(".quack");
    });

    it("should prefer docs/conventions/ over .editorconfig for conventionsDir", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, ".editorconfig", "root = true");
      await mkdirp(tempRoot, "docs/conventions");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.project.conventionsDir).toBe("docs/conventions");
    });
  });

  describe("Intelligent Intake - Script Detection", () => {
    it("should detect package.json scripts", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test-app",
          scripts: {
            test: "jest",
            "test:unit": "jest --testPathPattern=unit",
            "test:integration": "jest --testPathPattern=integration",
            build: "tsc && vite build",
            lint: "eslint src",
          },
        }),
      );

      const scan = await scanProject(tempRoot);

      expect(scan.scriptCommands).toEqual({
        test: "jest",
        "test:unit": "jest --testPathPattern=unit",
        "test:integration": "jest --testPathPattern=integration",
        build: "tsc && vite build",
        lint: "eslint src",
      });
    });

    it("should handle package.json with no scripts field", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);

      expect(scan.scriptCommands).toEqual({});
    });

    it("should detect Python pyproject.toml scripts", async () => {
      await writeFile(
        tempRoot,
        "pyproject.toml",
        `
[tool.poetry]
name = "my-python-app"

[tool.poetry.scripts]
test = "pytest"
lint = "ruff check ."
      `,
      );

      const scan = await scanProject(tempRoot);

      expect(scan.scriptCommands.test).toBe("pytest");
      expect(scan.scriptCommands.lint).toBe("ruff check .");
    });
  });

  describe("Intelligent Intake - Git Detection", () => {
    it("should detect git default branch from repo", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);

      // Should have a branch (either detected or defaulted to "main")
      expect(scan.gitDefaultBranch).toBeTruthy();
      expect(typeof scan.gitDefaultBranch).toBe("string");
    });

    it("should handle non-git directory gracefully", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);

      // Should default to "main" if not a git repo
      expect(scan.gitDefaultBranch).toBe("main");
      expect(scan.gitRemoteUrl).toBeNull();
      expect(scan.gitHubOwner).toBeNull();
      expect(scan.gitHubRepo).toBeNull();
    });
  });

  describe("Intelligent Intake - Test File Counting", () => {
    it("should count test files and determine small suite", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));
      await writeFile(tempRoot, "src/app.test.ts", "test('app', () => {})");
      await writeFile(tempRoot, "src/lib.test.ts", "test('lib', () => {})");
      await writeFile(tempRoot, "src/util.spec.ts", "test('util', () => {})");

      const scan = await scanProject(tempRoot);

      expect(scan.testFileCount).toBe(3);
      expect(scan.testSuiteSize).toBe("small");
    });

    it("should detect medium test suite", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      // Create 25 test files
      for (let i = 0; i < 25; i++) {
        await writeFile(tempRoot, `src/test${i}.test.ts`, `test('test${i}', () => {})`);
      }

      const scan = await scanProject(tempRoot);

      expect(scan.testFileCount).toBe(25);
      expect(scan.testSuiteSize).toBe("medium");
    });

    it("should detect large test suite", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      // Create 105 test files
      for (let i = 0; i < 105; i++) {
        await writeFile(tempRoot, `src/test${i}.test.ts`, `test('test${i}', () => {})`);
      }

      const scan = await scanProject(tempRoot);

      expect(scan.testFileCount).toBe(105);
      expect(scan.testSuiteSize).toBe("large");
    });

    it("should detect available test scripts from package.json", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          scripts: {
            test: "jest",
            "test:unit": "jest --testPathPattern=unit",
            "test:integration": "jest --testPathPattern=integration",
            build: "tsc",
          },
        }),
      );

      const scan = await scanProject(tempRoot);

      expect(scan.availableTestScripts).toEqual([
        { name: "test", command: "jest" },
        { name: "test:unit", command: "jest --testPathPattern=unit" },
        { name: "test:integration", command: "jest --testPathPattern=integration" },
      ]);
    });
  });

  describe("Intelligent Intake - Smart Verification Commands", () => {
    it("should use simple test command for small suite", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          scripts: { test: "jest" },
        }),
      );
      await writeFile(tempRoot, "src/app.test.ts", "test('app', () => {})");

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");
      expect(testCmd).toBeDefined();
      expect(commandText(testCmd)).toBe("npm test");
      expect(testCmd?.required).toBe(true);

      // Should not have a "tests-full" command for small suites
      const fullCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "tests-full",
      );
      expect(fullCmd).toBeUndefined();
    });

    it("should generate targeted command for large suite", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          scripts: { test: "jest" },
        }),
      );

      // Create 105 test files for large suite
      for (let i = 0; i < 105; i++) {
        await writeFile(tempRoot, `src/test${i}.test.ts`, `test('test${i}', () => {})`);
      }

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");
      expect(testCmd).toBeDefined();
      expect(commandText(testCmd)).toContain("--changedSince=HEAD~1");

      // Should have a full suite command as optional
      const fullCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "tests-full",
      );
      expect(fullCmd).toBeDefined();
      expect(fullCmd?.required).toBe(false);
    });

    it("should use test:unit script if available for large suite", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          scripts: {
            test: "jest",
            "test:unit": "jest --testPathPattern=unit",
          },
        }),
      );

      // Create 105 test files for large suite
      for (let i = 0; i < 105; i++) {
        await writeFile(tempRoot, `src/test${i}.test.ts`, `test('test${i}', () => {})`);
      }

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");
      expect(testCmd).toBeDefined();
      expect(commandText(testCmd)).toBe("npm run test:unit");
    });

    it("should add build command when build script exists", async () => {
      await writeFile(
        tempRoot,
        "package.json",
        JSON.stringify({
          name: "test",
          scripts: {
            test: "jest",
            build: "tsc && vite build",
          },
        }),
      );

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      const buildCmd = generated.adapterConfig.verification.commands.find(
        (c) => c.name === "build",
      );
      expect(buildCmd).toBeDefined();
      expect(commandText(buildCmd)).toBe("npm run build");
      expect(buildCmd?.required).toBe(true);
    });
  });

  describe("Intelligent Intake - Git Pre-fill", () => {
    it("should pre-fill git default branch from scan", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      // Should use detected branch or default to "main"
      expect(generated.adapterConfig.git.baseBranch).toBe(scan.gitDefaultBranch ?? "main");
    });

    it("should pre-fill GitHub integration when owner/repo detected", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      // Manually set git info for testing (simulating a GitHub repo)
      const scan = await scanProject(tempRoot);
      scan.gitHubOwner = "test-owner";
      scan.gitHubRepo = "test-repo";

      const generated = generateAdapter(scan);

      expect(generated.adapterConfig.integrations?.github).toBeDefined();
      expect(generated.adapterConfig.integrations?.github?.owner).toBe("test-owner");
      expect(generated.adapterConfig.integrations?.github?.repo).toBe("test-repo");
    });

    it("should not add GitHub integration when not detected", async () => {
      await writeFile(tempRoot, "package.json", JSON.stringify({ name: "test" }));

      const scan = await scanProject(tempRoot);
      const generated = generateAdapter(scan);

      // If no GitHub info detected, integrations should be undefined
      expect(generated.adapterConfig.integrations).toBeUndefined();
    });
  });
});
