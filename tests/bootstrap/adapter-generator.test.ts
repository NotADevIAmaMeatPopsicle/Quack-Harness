import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { scanProject } from "../../src/bootstrap/project-scanner";
import { generateAdapter } from "../../src/bootstrap/adapter-generator";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { verificationCommandShellString, type VerificationCommand } from "../../src/core/types";

// ─── Helpers ────────────────────────────────────────────────────────

let tempRoot: string;

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

function commandText(command: VerificationCommand | undefined): string | undefined {
  return command ? verificationCommandShellString(command) : undefined;
}

// ─── Smart Verification Commands ────────────────────────────────────

describe("adapter-generator smart commands", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-adgen-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should generate npm test as primary command for small suites", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "small-suite",
        scripts: { test: "jest" },
      }),
    );
    // Only 2 test files = small suite
    await writeFile(tempRoot, "src/a.test.ts", "test('a', () => {})");
    await writeFile(tempRoot, "src/b.test.ts", "test('b', () => {})");

    const scan = await scanProject(tempRoot);
    expect(scan.testSuiteSize).toBe("small");

    const generated = generateAdapter(scan);
    const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");

    expect(testCmd).toBeDefined();
    expect(commandText(testCmd)).toBe("npm test");
    expect(testCmd?.required).toBe(true);

    // Small suite should NOT have a "tests-full" fallback
    const fullCmd = generated.adapterConfig.verification.commands.find(
      (c) => c.name === "tests-full",
    );
    expect(fullCmd).toBeUndefined();
  });

  it("should generate targeted command for large suites without test:unit script", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "large-suite",
        scripts: { test: "jest" },
      }),
    );
    await writeFile(tempRoot, "jest.config.js", "module.exports = {};");
    // Create 105 test files = large suite
    for (let i = 0; i < 105; i++) {
      await writeFile(tempRoot, `src/mod${i}.test.ts`, `test('mod${i}', () => {})`);
    }

    const scan = await scanProject(tempRoot);
    expect(scan.testSuiteSize).toBe("large");

    const generated = generateAdapter(scan);
    const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");

    expect(testCmd).toBeDefined();
    expect(commandText(testCmd)).toContain("--changedSince=HEAD~1");
    expect(commandText(testCmd)).not.toContain("--passWithNoTests");
    expect(testCmd?.required).toBe(true);

    // Large suite should have a "tests-full" optional fallback
    const fullCmd = generated.adapterConfig.verification.commands.find(
      (c) => c.name === "tests-full",
    );
    expect(fullCmd).toBeDefined();
    expect(fullCmd?.required).toBe(false);
    expect(fullCmd?.timeout).toBe(600);
  });

  it("should prefer test:unit script for large suites when available", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "large-with-unit",
        scripts: {
          test: "jest",
          "test:unit": "jest --testPathPattern=unit",
        },
      }),
    );
    // Create 105 test files = large suite
    for (let i = 0; i < 105; i++) {
      await writeFile(tempRoot, `src/mod${i}.test.ts`, `test('mod${i}', () => {})`);
    }

    const scan = await scanProject(tempRoot);
    expect(scan.testSuiteSize).toBe("large");

    const generated = generateAdapter(scan);
    const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");

    expect(testCmd).toBeDefined();
    expect(commandText(testCmd)).toBe("npm run test:unit");
    expect(testCmd?.required).toBe(true);
  });

  it("should generate build command when build script exists", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "build-project",
        scripts: {
          test: "jest",
          build: "tsc && vite build",
        },
      }),
    );

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    const buildCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "build");
    expect(buildCmd).toBeDefined();
    expect(commandText(buildCmd)).toBe("npm run build");
    expect(buildCmd?.required).toBe(true);
    expect(buildCmd?.timeout).toBe(120);
  });

  it("should not generate build command when no build script exists", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "no-build",
        scripts: { test: "jest" },
      }),
    );

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    const buildCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "build");
    expect(buildCmd).toBeUndefined();
  });

  it("should generate targeted command for medium suites", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "medium-suite",
        scripts: { test: "jest" },
      }),
    );
    // Create 25 test files = medium suite
    for (let i = 0; i < 25; i++) {
      await writeFile(tempRoot, `src/mod${i}.test.ts`, `test('mod${i}', () => {})`);
    }

    const scan = await scanProject(tempRoot);
    expect(scan.testSuiteSize).toBe("medium");

    const generated = generateAdapter(scan);
    const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");

    expect(testCmd).toBeDefined();
    // Medium suite without test:unit falls back to --changedSince
    expect(commandText(testCmd)).toContain("--changedSince");
    expect(commandText(testCmd)).not.toContain("--passWithNoTests");

    // Medium suite should also have a full-suite fallback
    const fullCmd = generated.adapterConfig.verification.commands.find(
      (c) => c.name === "tests-full",
    );
    expect(fullCmd).toBeDefined();
    expect(fullCmd?.required).toBe(false);
  });

  it("should prefer test:unit script for medium suites when available", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "medium-with-unit",
        scripts: {
          test: "jest",
          "test:unit": "jest --testPathPattern=unit",
        },
      }),
    );
    // Create 25 test files = medium suite
    for (let i = 0; i < 25; i++) {
      await writeFile(tempRoot, `src/mod${i}.test.ts`, `test('mod${i}', () => {})`);
    }

    const scan = await scanProject(tempRoot);
    expect(scan.testSuiteSize).toBe("medium");

    const generated = generateAdapter(scan);
    const testCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "tests");

    expect(testCmd).toBeDefined();
    expect(commandText(testCmd)).toBe("npm run test:unit");
  });
});

// ─── Git Pre-fill ───────────────────────────────────────────────────

describe("adapter-generator git pre-fill", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-adgen-git-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("should use detected git default branch in adapter config", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "git-branch" }));

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    // Should use detected branch (defaults to "main" for non-git dirs)
    expect(generated.adapterConfig.git.baseBranch).toBe(scan.gitDefaultBranch ?? "main");
  });

  it("should pre-fill GitHub integration when owner/repo are detected", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "github-prefill" }));

    const scan = await scanProject(tempRoot);
    // Simulate detected GitHub info
    scan.gitHubOwner = "my-org";
    scan.gitHubRepo = "my-project";

    const generated = generateAdapter(scan);

    expect(generated.adapterConfig.integrations).toBeDefined();
    expect(generated.adapterConfig.integrations?.github).toBeDefined();
    expect(generated.adapterConfig.integrations?.github?.owner).toBe("my-org");
    expect(generated.adapterConfig.integrations?.github?.repo).toBe("my-project");
  });

  it("should not add integrations when no GitHub info detected", async () => {
    await writeFile(tempRoot, "package.json", JSON.stringify({ name: "no-github" }));

    const scan = await scanProject(tempRoot);
    const generated = generateAdapter(scan);

    // No GitHub detected → no integrations section
    expect(generated.adapterConfig.integrations).toBeUndefined();
  });

  it("should produce valid adapter config with all new fields", async () => {
    await writeFile(
      tempRoot,
      "package.json",
      JSON.stringify({
        name: "full-config-test",
        scripts: {
          test: "jest",
          "test:unit": "jest --testPathPattern=unit",
          build: "tsc",
        },
      }),
    );
    await writeFile(tempRoot, "tsconfig.json", "{}");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });

    const scan = await scanProject(tempRoot);
    // Simulate GitHub info
    scan.gitHubOwner = "acme";
    scan.gitHubRepo = "widget";

    const generated = generateAdapter(scan);

    // Zod validation should still pass with all new fields
    const result = AdapterConfigSchema.safeParse(generated.adapterConfig);
    expect(result.success).toBe(true);

    // Build command present
    const buildCmd = generated.adapterConfig.verification.commands.find((c) => c.name === "build");
    expect(buildCmd).toBeDefined();

    // Git pre-filled
    expect(generated.adapterConfig.git.baseBranch).toBeTruthy();

    // GitHub integration present
    expect(generated.adapterConfig.integrations?.github?.owner).toBe("acme");
    expect(generated.adapterConfig.integrations?.github?.repo).toBe("widget");
  });
});
