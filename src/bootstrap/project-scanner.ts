// ─── Bootstrap: Project Scanner ─────────────────────────────────────
// Detects project type, stack, structure by inspecting files on disk.
// Pure file detection — no LLM calls.

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

export type ProjectLanguage = "node" | "python" | "rust" | "go" | "unknown";

export type RuntimeTargetType = "browser" | "android" | "electron" | "tauri" | "react-native";

export interface RuntimeTestCommand {
  name: string;
  command: string;
  requiresDevice: boolean;
  timeout: number;
}

export interface RuntimeTarget {
  type: RuntimeTargetType;
  confidence: "high" | "medium";
  testFrameworks: string[];
  testCommands: RuntimeTestCommand[];
}

export interface DetectedTestFramework {
  name: string;
  configFile: string;
}

export interface DetectedBuildTool {
  name: string;
  configFile: string;
}

export interface DiscoveredLocation {
  path: string;
  type: string;
  confidence: "high" | "medium" | "low";
}

export interface DetectedLinter {
  name: string;
  configFile: string;
  command: string;
  fixCommand?: string;
}

export interface ScanResult {
  /** Absolute path to the scanned project */
  projectPath: string;
  /** Detected project name (from package.json, Cargo.toml, etc.) */
  projectName: string;
  /** Primary language/runtime */
  language: ProjectLanguage;
  /** Inferred test command (e.g., "npm test", "pytest") */
  testCommand: string;
  /** Detected test frameworks */
  testFrameworks: DetectedTestFramework[];
  /** Detected build tools */
  buildTools: DetectedBuildTool[];
  /** Directories that exist (e.g., "src/", "tests/", "lib/") */
  sourceDirs: string[];
  /** Files found that inform conventions */
  docFiles: string[];
  /** Content of README.md (empty string if missing) */
  readmeContent: string;
  /** Content of CLAUDE.md (empty string if missing) */
  claudeMdContent: string;
  /** Whether a .quack/ directory already exists */
  hasExistingQuackDir: boolean;
  /** Whether a tsconfig.json exists (TypeScript project) */
  hasTypeScript: boolean;
  /** Whether a Dockerfile or docker-compose file exists */
  hasDocker: boolean;
  /** Whether a .env.example file exists */
  hasEnvExample: boolean;

  // Enhanced detection fields
  /** Task file locations (TASK-*.md, issues/, backlog/) */
  taskLocations: DiscoveredLocation[];
  /** ADR locations (ADR-*.md, adr/, decisions/) */
  adrLocations: DiscoveredLocation[];
  /** Architecture documentation locations */
  architectureDocs: DiscoveredLocation[];
  /** Convention files (CONVENTIONS.md, .editorconfig, etc.) */
  conventionFiles: DiscoveredLocation[];
  /** Detected linters with their configs */
  linters: DetectedLinter[];
  /** CI/CD pipeline locations */
  ciPipelines: DiscoveredLocation[];
  /** Database configuration locations */
  databaseConfigs: DiscoveredLocation[];
  /** Container configuration locations */
  containerConfigs: DiscoveredLocation[];
  /** Framework type (express, fastapi, nextjs, etc.) */
  frameworkType: string;
  /** API pattern locations (routes/, controllers/, endpoints/) */
  apiPatterns: DiscoveredLocation[];
  /** Whether this is a monorepo */
  isMonorepo: boolean;
  /** Workspace directories in monorepo */
  workspaces: string[];
  /** Detected runtime targets with platform-specific test info */
  runtimeTargets: RuntimeTarget[];

  // Enhanced detection fields for intelligent intake
  /** Scripts from package.json (or pyproject.toml) */
  scriptCommands: Record<string, string>;
  /** Number of test files detected */
  testFileCount: number;
  /** Estimated test suite size based on file count */
  testSuiteSize: "small" | "medium" | "large";
  /** Available test script variants (test:unit, test:integration, etc.) */
  availableTestScripts: Array<{ name: string; command: string }>;
  /** Git default branch from repo config */
  gitDefaultBranch: string | null;
  /** Git remote URL (first origin) */
  gitRemoteUrl: string | null;
  /** Parsed GitHub owner from remote URL */
  gitHubOwner: string | null;
  /** Parsed GitHub repo name from remote URL */
  gitHubRepo: string | null;
}

// ─── RuntimeTarget helpers ──────────────────────────────────────────

export function hasTarget(scan: ScanResult, type: RuntimeTargetType): boolean {
  return scan.runtimeTargets.some((t) => t.type === type);
}

export function getTargetFrameworks(scan: ScanResult, type: RuntimeTargetType): string[] {
  return scan.runtimeTargets.find((t) => t.type === type)?.testFrameworks ?? [];
}

// ─── Helpers ────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function extractProjectNameFromPackageJson(content: string): string {
  try {
    const parsed = JSON.parse(content) as { name?: string };
    return parsed.name ?? "";
  } catch {
    return "";
  }
}

function extractProjectNameFromCargoToml(content: string): string {
  const match = /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(content);
  return match?.[1] ?? "";
}

function extractProjectNameFromGoMod(content: string): string {
  const match = /^module\s+(\S+)/m.exec(content);
  if (!match?.[1]) return "";
  // Use the last segment of the module path as the project name
  const segments = match[1].split("/");
  return segments[segments.length - 1] ?? "";
}

function extractProjectNameFromPyprojectToml(content: string): string {
  const match = /\[project\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(content);
  if (match?.[1]) return match[1];
  // Fallback to [tool.poetry] section
  const poetryMatch = /\[tool\.poetry\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(content);
  return poetryMatch?.[1] ?? "";
}

// ─── Language detection ─────────────────────────────────────────────

async function detectLanguage(
  projectPath: string,
): Promise<{ language: ProjectLanguage; projectName: string; testCommand: string }> {
  // Check Node.js (package.json)
  const packageJsonPath = path.join(projectPath, "package.json");
  if (await fileExists(packageJsonPath)) {
    const content = await readFileOrEmpty(packageJsonPath);
    const name = extractProjectNameFromPackageJson(content);
    return { language: "node", projectName: name, testCommand: "npm test" };
  }

  // Check Python (pyproject.toml first, then requirements.txt)
  const pyprojectPath = path.join(projectPath, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    const content = await readFileOrEmpty(pyprojectPath);
    const name = extractProjectNameFromPyprojectToml(content);
    return { language: "python", projectName: name, testCommand: "pytest" };
  }
  if (await fileExists(path.join(projectPath, "requirements.txt"))) {
    return { language: "python", projectName: "", testCommand: "pytest" };
  }

  // Check Rust (Cargo.toml)
  const cargoPath = path.join(projectPath, "Cargo.toml");
  if (await fileExists(cargoPath)) {
    const content = await readFileOrEmpty(cargoPath);
    const name = extractProjectNameFromCargoToml(content);
    return { language: "rust", projectName: name, testCommand: "cargo test" };
  }

  // Check Go (go.mod)
  const goModPath = path.join(projectPath, "go.mod");
  if (await fileExists(goModPath)) {
    const content = await readFileOrEmpty(goModPath);
    const name = extractProjectNameFromGoMod(content);
    return { language: "go", projectName: name, testCommand: "go test ./..." };
  }

  return { language: "unknown", projectName: "", testCommand: "" };
}

// ─── Test framework detection ───────────────────────────────────────

async function detectTestFrameworks(
  projectPath: string,
  language: ProjectLanguage,
): Promise<DetectedTestFramework[]> {
  const frameworks: DetectedTestFramework[] = [];

  if (language === "node") {
    const jestConfigs = ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"];
    for (const config of jestConfigs) {
      if (await fileExists(path.join(projectPath, config))) {
        frameworks.push({ name: "jest", configFile: config });
        break;
      }
    }
    // Check package.json for jest config
    if (frameworks.length === 0) {
      const pkgContent = await readFileOrEmpty(path.join(projectPath, "package.json"));
      if (pkgContent) {
        try {
          const pkg = JSON.parse(pkgContent) as { jest?: unknown };
          if (pkg.jest) {
            frameworks.push({ name: "jest", configFile: "package.json" });
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    const vitestConfigs = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"];
    for (const config of vitestConfigs) {
      if (await fileExists(path.join(projectPath, config))) {
        frameworks.push({ name: "vitest", configFile: config });
        break;
      }
    }

    if (
      (await fileExists(path.join(projectPath, ".mocharc.yml"))) ||
      (await fileExists(path.join(projectPath, ".mocharc.json")))
    ) {
      frameworks.push({ name: "mocha", configFile: ".mocharc.yml" });
    }
  }

  if (language === "python") {
    if (await fileExists(path.join(projectPath, "pytest.ini"))) {
      frameworks.push({ name: "pytest", configFile: "pytest.ini" });
    } else if (await fileExists(path.join(projectPath, "pyproject.toml"))) {
      const content = await readFileOrEmpty(path.join(projectPath, "pyproject.toml"));
      if (content.includes("[tool.pytest")) {
        frameworks.push({ name: "pytest", configFile: "pyproject.toml" });
      }
    } else if (await fileExists(path.join(projectPath, "setup.cfg"))) {
      const content = await readFileOrEmpty(path.join(projectPath, "setup.cfg"));
      if (content.includes("[tool:pytest]")) {
        frameworks.push({ name: "pytest", configFile: "setup.cfg" });
      }
    }
  }

  if (language === "rust") {
    // Rust uses cargo test by default, no separate config needed
    frameworks.push({ name: "cargo-test", configFile: "Cargo.toml" });
  }

  if (language === "go") {
    // Go uses go test by default
    frameworks.push({ name: "go-test", configFile: "go.mod" });
  }

  return frameworks;
}

// ─── Build tool detection ───────────────────────────────────────────

async function detectBuildTools(
  projectPath: string,
  language: ProjectLanguage,
): Promise<DetectedBuildTool[]> {
  const tools: DetectedBuildTool[] = [];

  if (language === "node") {
    if (await fileExists(path.join(projectPath, "tsconfig.json"))) {
      tools.push({ name: "typescript", configFile: "tsconfig.json" });
    }
    if (
      (await fileExists(path.join(projectPath, "webpack.config.js"))) ||
      (await fileExists(path.join(projectPath, "webpack.config.ts")))
    ) {
      tools.push({ name: "webpack", configFile: "webpack.config.js" });
    }
    if (
      (await fileExists(path.join(projectPath, "vite.config.ts"))) ||
      (await fileExists(path.join(projectPath, "vite.config.js")))
    ) {
      tools.push({ name: "vite", configFile: "vite.config.ts" });
    }
    if (
      (await fileExists(path.join(projectPath, "next.config.js"))) ||
      (await fileExists(path.join(projectPath, "next.config.mjs"))) ||
      (await fileExists(path.join(projectPath, "next.config.ts")))
    ) {
      tools.push({ name: "next.js", configFile: "next.config.js" });
    }
  }

  return tools;
}

// ─── Source directory detection ─────────────────────────────────────

async function detectSourceDirs(projectPath: string): Promise<string[]> {
  const candidates = ["src/", "lib/", "tests/", "test/", "spec/", "docs/", "scripts/"];
  const found: string[] = [];

  for (const dir of candidates) {
    if (await directoryExists(path.join(projectPath, dir))) {
      found.push(dir);
    }
  }

  return found;
}

// ─── Doc file detection ─────────────────────────────────────────────

async function detectDocFiles(projectPath: string): Promise<string[]> {
  const candidates = [
    "README.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    ".env.example",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
  ];
  const found: string[] = [];

  for (const file of candidates) {
    if (await fileExists(path.join(projectPath, file))) {
      found.push(file);
    }
  }

  return found;
}

// ─── Enhanced detection functions ───────────────────────────────────

async function detectTaskLocations(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // Check common task directories
  const taskDirs = ["docs/tasks", "tasks", "backlog", "issues", ".github/ISSUE_TEMPLATE"];
  for (const dir of taskDirs) {
    if (await directoryExists(path.join(projectPath, dir))) {
      locations.push({ path: dir, type: "directory", confidence: "high" });
    }
  }

  // Check for TASK-*.md files in root
  try {
    const files = await fs.readdir(projectPath);
    for (const file of files) {
      if (/^TASK-.*\.md$/i.test(file)) {
        locations.push({ path: file, type: "file", confidence: "high" });
      }
    }
  } catch {
    // Ignore read errors
  }

  // Check docs/ for TASK files
  const docsPath = path.join(projectPath, "docs");
  if (await directoryExists(docsPath)) {
    try {
      const files = await fs.readdir(docsPath);
      for (const file of files) {
        if (/^TASK-.*\.md$/i.test(file) || /^task-.*\.md$/i.test(file)) {
          locations.push({ path: `docs/${file}`, type: "file", confidence: "high" });
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return locations;
}

async function detectAdrLocations(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // Check common ADR directories
  const adrDirs = ["docs/adr", "docs/decisions", "adr", "decisions"];
  for (const dir of adrDirs) {
    if (await directoryExists(path.join(projectPath, dir))) {
      locations.push({ path: dir, type: "directory", confidence: "high" });
    }
  }

  // Check for ADR-*.md files in root
  try {
    const files = await fs.readdir(projectPath);
    for (const file of files) {
      if (/^ADR-.*\.md$/i.test(file)) {
        locations.push({ path: file, type: "file", confidence: "high" });
      }
    }
  } catch {
    // Ignore read errors
  }

  // Check docs/ for ADR files
  const docsPath = path.join(projectPath, "docs");
  if (await directoryExists(docsPath)) {
    try {
      const files = await fs.readdir(docsPath);
      for (const file of files) {
        if (/^ADR-.*\.md$/i.test(file) || /^adr-.*\.md$/i.test(file)) {
          locations.push({ path: `docs/${file}`, type: "file", confidence: "high" });
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return locations;
}

async function detectArchitectureDocs(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // Check for ARCHITECTURE.md in root
  if (await fileExists(path.join(projectPath, "ARCHITECTURE.md"))) {
    locations.push({ path: "ARCHITECTURE.md", type: "file", confidence: "high" });
  }

  // Check for architecture docs in docs/
  const archDirs = ["docs/architecture", "docs/design"];
  for (const dir of archDirs) {
    if (await directoryExists(path.join(projectPath, dir))) {
      locations.push({ path: dir, type: "directory", confidence: "high" });
    }
  }

  return locations;
}

async function detectConventionFiles(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  const conventionCandidates = [
    { path: "CONVENTIONS.md", confidence: "high" as const },
    { path: "CLAUDE.md", confidence: "high" as const },
    { path: ".editorconfig", confidence: "medium" as const },
    { path: "docs/conventions", confidence: "high" as const },
    { path: "docs/CONVENTIONS.md", confidence: "high" as const },
    { path: ".quack/CONVENTIONS.md", confidence: "high" as const },
  ];

  for (const candidate of conventionCandidates) {
    const fullPath = path.join(projectPath, candidate.path);
    const exists = (await fileExists(fullPath)) || (await directoryExists(fullPath));
    if (exists) {
      const stats = await fs.stat(fullPath).catch(() => null);
      locations.push({
        path: candidate.path,
        type: stats?.isDirectory() ? "directory" : "file",
        confidence: candidate.confidence,
      });
    }
  }

  return locations;
}

async function detectLinters(
  projectPath: string,
  language: ProjectLanguage,
): Promise<DetectedLinter[]> {
  const linters: DetectedLinter[] = [];

  if (language === "node") {
    // ESLint
    const eslintConfigs = [
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yml",
      "eslint.config.js",
    ];
    for (const config of eslintConfigs) {
      if (await fileExists(path.join(projectPath, config))) {
        linters.push({
          name: "eslint",
          configFile: config,
          command: "npx eslint --max-warnings 0 .",
          fixCommand: "npx eslint --fix .",
        });
        break;
      }
    }

    // Prettier
    const prettierConfigs = [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      "prettier.config.js",
    ];
    for (const config of prettierConfigs) {
      if (await fileExists(path.join(projectPath, config))) {
        linters.push({
          name: "prettier",
          configFile: config,
          command: "npx prettier --check .",
          fixCommand: "npx prettier --write .",
        });
        break;
      }
    }
  }

  if (language === "python") {
    // Ruff
    if (await fileExists(path.join(projectPath, "ruff.toml"))) {
      linters.push({
        name: "ruff",
        configFile: "ruff.toml",
        command: "ruff check .",
        fixCommand: "ruff check --fix .",
      });
    } else if (await fileExists(path.join(projectPath, "pyproject.toml"))) {
      const content = await readFileOrEmpty(path.join(projectPath, "pyproject.toml"));
      if (content.includes("[tool.ruff]")) {
        linters.push({
          name: "ruff",
          configFile: "pyproject.toml",
          command: "ruff check .",
          fixCommand: "ruff check --fix .",
        });
      }
    }
  }

  if (language === "go") {
    const ymlExists = await fileExists(path.join(projectPath, ".golangci.yml"));
    const yamlExists = await fileExists(path.join(projectPath, ".golangci.yaml"));
    if (ymlExists || yamlExists) {
      linters.push({
        name: "golangci-lint",
        configFile: ymlExists ? ".golangci.yml" : ".golangci.yaml",
        command: "golangci-lint run",
      });
    }
  }

  if (language === "rust") {
    // Rustfmt
    if (await fileExists(path.join(projectPath, "rustfmt.toml"))) {
      linters.push({
        name: "rustfmt",
        configFile: "rustfmt.toml",
        command: "cargo fmt --check",
        fixCommand: "cargo fmt",
      });
    }
  }

  return linters;
}

async function detectCiPipelines(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // GitHub Actions
  if (await directoryExists(path.join(projectPath, ".github/workflows"))) {
    locations.push({ path: ".github/workflows", type: "directory", confidence: "high" });
  }

  // GitLab CI
  if (await fileExists(path.join(projectPath, ".gitlab-ci.yml"))) {
    locations.push({ path: ".gitlab-ci.yml", type: "file", confidence: "high" });
  }

  // CircleCI
  if (await directoryExists(path.join(projectPath, ".circleci"))) {
    locations.push({ path: ".circleci", type: "directory", confidence: "high" });
  }

  // Travis CI
  if (await fileExists(path.join(projectPath, ".travis.yml"))) {
    locations.push({ path: ".travis.yml", type: "file", confidence: "high" });
  }

  // Jenkins
  if (await fileExists(path.join(projectPath, "Jenkinsfile"))) {
    locations.push({ path: "Jenkinsfile", type: "file", confidence: "high" });
  }

  return locations;
}

async function detectDatabaseConfigs(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // Prisma
  if (await directoryExists(path.join(projectPath, "prisma"))) {
    locations.push({ path: "prisma", type: "directory", confidence: "high" });
  }

  // Drizzle
  const drizzleConfigs = ["drizzle.config.ts", "drizzle.config.js"];
  for (const config of drizzleConfigs) {
    if (await fileExists(path.join(projectPath, config))) {
      locations.push({ path: config, type: "file", confidence: "high" });
      break;
    }
  }

  // Knex
  const knexConfigs = ["knexfile.js", "knexfile.ts"];
  for (const config of knexConfigs) {
    if (await fileExists(path.join(projectPath, config))) {
      locations.push({ path: config, type: "file", confidence: "high" });
      break;
    }
  }

  // Alembic (Python)
  if (await directoryExists(path.join(projectPath, "alembic"))) {
    locations.push({ path: "alembic", type: "directory", confidence: "high" });
  }

  // Migrations
  if (await directoryExists(path.join(projectPath, "migrations"))) {
    locations.push({ path: "migrations", type: "directory", confidence: "medium" });
  }

  return locations;
}

async function detectContainerConfigs(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  // Dockerfile
  if (await fileExists(path.join(projectPath, "Dockerfile"))) {
    locations.push({ path: "Dockerfile", type: "file", confidence: "high" });
  }

  // Docker Compose
  const composeFiles = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const file of composeFiles) {
    if (await fileExists(path.join(projectPath, file))) {
      locations.push({ path: file, type: "file", confidence: "high" });
    }
  }

  // Kubernetes
  if (await directoryExists(path.join(projectPath, "k8s"))) {
    locations.push({ path: "k8s", type: "directory", confidence: "high" });
  }
  if (await directoryExists(path.join(projectPath, "kubernetes"))) {
    locations.push({ path: "kubernetes", type: "directory", confidence: "high" });
  }

  return locations;
}

async function detectFrameworkType(
  projectPath: string,
  language: ProjectLanguage,
): Promise<string> {
  if (language !== "node" && language !== "python") {
    return "";
  }

  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (allDeps["next"]) return "nextjs";
        if (allDeps["@nuxt/kit"] || allDeps["nuxt"]) return "nuxt";
        if (allDeps["express"]) return "express";
        if (allDeps["@nestjs/core"]) return "nestjs";
        if (allDeps["fastify"]) return "fastify";
        if (allDeps["koa"]) return "koa";
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (language === "python") {
    const pyprojectPath = path.join(projectPath, "pyproject.toml");
    if (await fileExists(pyprojectPath)) {
      const content = await readFileOrEmpty(pyprojectPath);
      if (content.includes("fastapi")) return "fastapi";
      if (content.includes("django")) return "django";
      if (content.includes("flask")) return "flask";
    }

    const requirementsPath = path.join(projectPath, "requirements.txt");
    if (await fileExists(requirementsPath)) {
      const content = await readFileOrEmpty(requirementsPath);
      if (content.includes("fastapi")) return "fastapi";
      if (content.includes("Django")) return "django";
      if (content.includes("Flask")) return "flask";
    }
  }

  return "";
}

async function detectApiPatterns(projectPath: string): Promise<DiscoveredLocation[]> {
  const locations: DiscoveredLocation[] = [];

  const apiDirs = [
    "routes",
    "controllers",
    "endpoints",
    "api",
    "src/routes",
    "src/controllers",
    "src/api",
  ];
  for (const dir of apiDirs) {
    if (await directoryExists(path.join(projectPath, dir))) {
      locations.push({ path: dir, type: "directory", confidence: "medium" });
    }
  }

  return locations;
}

// ─── Runtime target detection ───────────────────────────────────────

async function detectBrowserRuntime(
  projectPath: string,
  language: ProjectLanguage,
): Promise<RuntimeTarget | null> {
  let isBrowser = false;

  // Check for HTML files in public/ or root
  if (await fileExists(path.join(projectPath, "public", "index.html"))) isBrowser = true;
  if (await fileExists(path.join(projectPath, "index.html"))) isBrowser = true;

  // Check for frontend frameworks in package.json
  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        const browserFrameworks = [
          "react",
          "react-dom",
          "vue",
          "svelte",
          "@sveltejs/kit",
          "@angular/core",
          "next",
          "nuxt",
          "vite",
        ];
        for (const fw of browserFrameworks) {
          if (allDeps[fw]) {
            isBrowser = true;
            break;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Check for canvas usage patterns (game projects, visualization)
  if (!isBrowser && language === "node") {
    const srcPath = path.join(projectPath, "src");
    if (await directoryExists(srcPath)) {
      try {
        const files = await fs.readdir(srcPath);
        for (const file of files) {
          if (file.endsWith(".ts") || file.endsWith(".js")) {
            const content = await readFileOrEmpty(path.join(srcPath, file));
            if (
              content.includes("getContext(") &&
              (content.includes('"2d"') ||
                content.includes("'2d'") ||
                content.includes('"webgl"') ||
                content.includes("'webgl'"))
            ) {
              isBrowser = true;
              break;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  if (!isBrowser) return null;

  // Detect browser test frameworks
  const testFrameworks: string[] = [];

  const playwrightConfigs = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mts",
  ];
  for (const config of playwrightConfigs) {
    if (await fileExists(path.join(projectPath, config))) {
      testFrameworks.push("playwright");
      break;
    }
  }

  const cypressConfigs = ["cypress.config.ts", "cypress.config.js", "cypress.config.mjs"];
  for (const config of cypressConfigs) {
    if (await fileExists(path.join(projectPath, config))) {
      testFrameworks.push("cypress");
      break;
    }
  }

  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as {
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (allDeps["@playwright/test"] && !testFrameworks.includes("playwright")) {
          testFrameworks.push("playwright");
        }
        if (allDeps["cypress"] && !testFrameworks.includes("cypress")) {
          testFrameworks.push("cypress");
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Build test commands
  const testCommands: RuntimeTestCommand[] = [];
  if (testFrameworks.includes("playwright")) {
    testCommands.push({
      name: "browser-tests",
      command: "npx playwright test",
      requiresDevice: false,
      timeout: 600,
    });
  } else if (testFrameworks.includes("cypress")) {
    testCommands.push({
      name: "browser-tests",
      command: "npx cypress run",
      requiresDevice: false,
      timeout: 600,
    });
  }

  return { type: "browser", confidence: "high", testFrameworks, testCommands };
}

async function detectAndroidRuntime(projectPath: string): Promise<RuntimeTarget | null> {
  let confidence: "high" | "medium" | null = null;

  // High confidence: root-level Gradle files + AndroidManifest
  if (await fileExists(path.join(projectPath, "app", "src", "main", "AndroidManifest.xml"))) {
    confidence = "high";
  } else if (
    (await fileExists(path.join(projectPath, "build.gradle"))) ||
    (await fileExists(path.join(projectPath, "build.gradle.kts")))
  ) {
    // Only count as Android if AndroidManifest also exists somewhere, or settings.gradle exists
    if (
      (await fileExists(path.join(projectPath, "settings.gradle"))) ||
      (await fileExists(path.join(projectPath, "settings.gradle.kts")))
    ) {
      // Verify it's actually Android by checking for android plugin in build.gradle
      const gradleContent = await readFileOrEmpty(path.join(projectPath, "build.gradle"));
      const gradleKtsContent = await readFileOrEmpty(path.join(projectPath, "build.gradle.kts"));
      const combined = gradleContent + gradleKtsContent;
      if (
        combined.includes("com.android") ||
        combined.includes("android {") ||
        combined.includes("android{")
      ) {
        confidence = "high";
      }
    }
  }

  // Medium confidence: android/ subdirectory with build.gradle (React Native pattern)
  if (!confidence) {
    const androidDir = path.join(projectPath, "android");
    if (await directoryExists(androidDir)) {
      if (
        (await fileExists(path.join(androidDir, "build.gradle"))) ||
        (await fileExists(path.join(androidDir, "build.gradle.kts")))
      ) {
        confidence = "medium";
      }
    }
  }

  if (!confidence) return null;

  // Detect test frameworks from build.gradle content
  const testFrameworks: string[] = [];
  const gradlePaths = [
    path.join(projectPath, "app", "build.gradle"),
    path.join(projectPath, "app", "build.gradle.kts"),
    path.join(projectPath, "build.gradle"),
    path.join(projectPath, "build.gradle.kts"),
    path.join(projectPath, "android", "app", "build.gradle"),
    path.join(projectPath, "android", "app", "build.gradle.kts"),
  ];

  let gradleContent = "";
  for (const gp of gradlePaths) {
    gradleContent += await readFileOrEmpty(gp);
  }

  if (gradleContent.includes("androidx.test.espresso")) testFrameworks.push("espresso");
  if (gradleContent.includes("androidx.test.uiautomator")) testFrameworks.push("uiautomator");
  if (gradleContent.includes("androidx.compose.ui:ui-test")) testFrameworks.push("compose-test");

  const testCommands: RuntimeTestCommand[] = [
    { name: "android-unit", command: "./gradlew test", requiresDevice: false, timeout: 300 },
    {
      name: "android-instrumented",
      command: "./gradlew connectedAndroidTest",
      requiresDevice: true,
      timeout: 900,
    },
  ];

  return { type: "android", confidence, testFrameworks, testCommands };
}

async function detectDesktopRuntime(
  projectPath: string,
  language: ProjectLanguage,
): Promise<RuntimeTarget | null> {
  // Electron detection
  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (allDeps["electron"] || allDeps["electron-builder"]) {
          const testFrameworks: string[] = [];
          if (allDeps["spectron"]) testFrameworks.push("spectron");
          if (allDeps["@playwright/test"] || allDeps["electron-playwright-helpers"])
            testFrameworks.push("playwright");

          const testCommands: RuntimeTestCommand[] = [];
          if (testFrameworks.includes("playwright")) {
            testCommands.push({
              name: "desktop-tests",
              command: "npx playwright test",
              requiresDevice: false,
              timeout: 600,
            });
          } else if (testFrameworks.includes("spectron")) {
            testCommands.push({
              name: "desktop-tests",
              command: "npx jest --config jest.e2e.config.js",
              requiresDevice: false,
              timeout: 600,
            });
          }

          return { type: "electron", confidence: "high", testFrameworks, testCommands };
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Tauri detection
  const tauriCargoToml = path.join(projectPath, "src-tauri", "Cargo.toml");
  const tauriConf = path.join(projectPath, "src-tauri", "tauri.conf.json");

  if ((await fileExists(tauriCargoToml)) || (await fileExists(tauriConf))) {
    const testFrameworks: string[] = [];

    // Check for Tauri test utilities in package.json
    if (language === "node") {
      const packageJsonPath = path.join(projectPath, "package.json");
      if (await fileExists(packageJsonPath)) {
        try {
          const content = await readFileOrEmpty(packageJsonPath);
          const pkg = JSON.parse(content) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps["@tauri-apps/api"]) testFrameworks.push("tauri-api");
        } catch {
          // Ignore parse errors
        }
      }
    }

    const testCommands: RuntimeTestCommand[] = [
      {
        name: "desktop-tests",
        command: "cargo test --manifest-path src-tauri/Cargo.toml",
        requiresDevice: false,
        timeout: 300,
      },
    ];

    return { type: "tauri", confidence: "high", testFrameworks, testCommands };
  }

  // Also check package.json for @tauri-apps/api without src-tauri present yet
  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps["@tauri-apps/api"]) {
          return {
            type: "tauri",
            confidence: "medium",
            testFrameworks: ["tauri-api"],
            testCommands: [
              {
                name: "desktop-tests",
                command: "cargo test --manifest-path src-tauri/Cargo.toml",
                requiresDevice: false,
                timeout: 300,
              },
            ],
          };
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return null;
}

async function detectReactNativeRuntime(projectPath: string): Promise<RuntimeTarget | null> {
  const packageJsonPath = path.join(projectPath, "package.json");
  if (!(await fileExists(packageJsonPath))) return null;

  try {
    const content = await readFileOrEmpty(packageJsonPath);
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (!allDeps["react-native"]) return null;

    const testFrameworks: string[] = [];
    if (allDeps["detox"]) testFrameworks.push("detox");
    if (allDeps["appium"]) testFrameworks.push("appium");

    const testCommands: RuntimeTestCommand[] = [];
    if (testFrameworks.includes("detox")) {
      testCommands.push({
        name: "rn-android",
        command: "npx detox test --configuration android.emu.debug",
        requiresDevice: true,
        timeout: 900,
      });
    }

    return { type: "react-native", confidence: "high", testFrameworks, testCommands };
  } catch {
    return null;
  }
}

async function detectMonorepo(
  projectPath: string,
): Promise<{ isMonorepo: boolean; workspaces: string[] }> {
  // Check for npm/yarn workspaces in package.json
  const packageJsonPath = path.join(projectPath, "package.json");
  if (await fileExists(packageJsonPath)) {
    try {
      const content = await readFileOrEmpty(packageJsonPath);
      const pkg = JSON.parse(content) as { workspaces?: string[] | { packages?: string[] } };
      if (pkg.workspaces) {
        const workspaces = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : (pkg.workspaces.packages ?? []);
        if (workspaces.length > 0) {
          return { isMonorepo: true, workspaces };
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for pnpm-workspace.yaml
  if (await fileExists(path.join(projectPath, "pnpm-workspace.yaml"))) {
    return { isMonorepo: true, workspaces: [] }; // Would need YAML parser to extract
  }

  // Check for lerna.json
  if (await fileExists(path.join(projectPath, "lerna.json"))) {
    return { isMonorepo: true, workspaces: [] };
  }

  // Check for nx.json
  if (await fileExists(path.join(projectPath, "nx.json"))) {
    return { isMonorepo: true, workspaces: [] };
  }

  return { isMonorepo: false, workspaces: [] };
}

// ─── Enhanced Detection for Intelligent Intake ────────────────────

async function detectScriptCommands(
  projectPath: string,
  language: ProjectLanguage,
): Promise<Record<string, string>> {
  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
        return pkg.scripts ?? {};
      } catch {
        return {};
      }
    }
  }
  if (language === "python") {
    const pyprojectPath = path.join(projectPath, "pyproject.toml");
    if (await fileExists(pyprojectPath)) {
      const content = await readFileOrEmpty(pyprojectPath);
      const scriptsMatch = /\[tool\.poetry\.scripts\]([\s\S]*?)(?=\n\[|$)/.exec(content);
      if (scriptsMatch) {
        const scripts: Record<string, string> = {};
        const lines = scriptsMatch[1].split("\n");
        for (const line of lines) {
          const match = /^(\w+)\s*=\s*"([^"]+)"/.exec(line.trim());
          if (match) scripts[match[1]] = match[2];
        }
        return scripts;
      }
    }
  }
  return {};
}

async function detectGitInfo(projectPath: string): Promise<{
  gitDefaultBranch: string | null;
  gitRemoteUrl: string | null;
  gitHubOwner: string | null;
  gitHubRepo: string | null;
}> {
  const { execSync } = await import("node:child_process");

  let gitDefaultBranch: string | null = null;
  let gitRemoteUrl: string | null = null;
  let gitHubOwner: string | null = null;
  let gitHubRepo: string | null = null;

  try {
    // Get default branch
    const branchOutput = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    gitDefaultBranch = branchOutput.split("/").pop() ?? null;
  } catch {
    // Fallback to "main"
    gitDefaultBranch = "main";
  }

  try {
    // Get remote URL
    gitRemoteUrl = execSync("git remote get-url origin", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // Parse GitHub owner/repo from URL
    const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(gitRemoteUrl);
    if (match) {
      gitHubOwner = match[1];
      gitHubRepo = match[2];
    }
  } catch {
    // Not a git repo or no origin
  }

  return { gitDefaultBranch, gitRemoteUrl, gitHubOwner, gitHubRepo };
}

async function detectTestFiles(
  projectPath: string,
  language: ProjectLanguage,
): Promise<{
  testFileCount: number;
  testSuiteSize: "small" | "medium" | "large";
  availableTestScripts: Array<{ name: string; command: string }>;
}> {
  let testFileCount = 0;
  const availableTestScripts: Array<{ name: string; command: string }> = [];

  // Count test files using recursive directory walking
  const testFilePatterns: RegExp[] = [];
  if (language === "node")
    testFilePatterns.push(/\.test\.(ts|js|tsx|jsx)$/, /\.spec\.(ts|js|tsx|jsx)$/);
  if (language === "python") testFilePatterns.push(/^test_.*\.py$/);
  if (language === "go") testFilePatterns.push(/_test\.go$/);
  if (language === "rust") testFilePatterns.push(/\.rs$/);

  // Recursively walk directories and count matching files
  async function walkDir(dir: string, depth: number = 0): Promise<void> {
    // Don't recurse too deep or into common ignored directories
    if (depth > 10) return;

    const basename = path.basename(dir);
    if (["node_modules", ".venv", "dist", "build", ".git", "target"].includes(basename)) {
      return;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          // Check if file matches test pattern
          for (const pattern of testFilePatterns) {
            if (pattern.test(entry.name)) {
              // For Rust, only count files in tests/ directories
              if (language === "rust" && !fullPath.includes(path.sep + "tests" + path.sep)) {
                continue;
              }
              testFileCount++;
              break;
            }
          }
        }
      }
    } catch {
      // Ignore directories we can't read
    }
  }

  await walkDir(projectPath);

  // Determine suite size
  let testSuiteSize: "small" | "medium" | "large" = "small";
  if (testFileCount >= 100) testSuiteSize = "large";
  else if (testFileCount >= 20) testSuiteSize = "medium";

  // Detect test script variants from package.json
  if (language === "node") {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFileOrEmpty(packageJsonPath);
        const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
        if (pkg.scripts) {
          for (const [name, command] of Object.entries(pkg.scripts)) {
            if (/test/.test(name)) {
              availableTestScripts.push({ name, command });
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return { testFileCount, testSuiteSize, availableTestScripts };
}

// ─── Main scanner ───────────────────────────────────────────────────

export async function scanProject(projectPath: string): Promise<ScanResult> {
  const absolutePath = path.resolve(projectPath);

  // Verify the path exists and is a directory
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absolutePath}`);
  }

  // Detect language and project name
  const { language, projectName, testCommand } = await detectLanguage(absolutePath);

  // Detect frameworks and tools
  const testFrameworks = await detectTestFrameworks(absolutePath, language);
  const buildTools = await detectBuildTools(absolutePath, language);

  // Detect directories
  const sourceDirs = await detectSourceDirs(absolutePath);

  // Detect doc files
  const docFiles = await detectDocFiles(absolutePath);

  // Read doc content
  const readmeContent = await readFileOrEmpty(path.join(absolutePath, "README.md"));
  const claudeMdContent = await readFileOrEmpty(path.join(absolutePath, "CLAUDE.md"));

  // Check for existing .quack dir
  const hasExistingQuackDir = await directoryExists(path.join(absolutePath, ".quack"));

  // Check for TypeScript
  const hasTypeScript = await fileExists(path.join(absolutePath, "tsconfig.json"));

  // Check for Docker
  const hasDocker =
    (await fileExists(path.join(absolutePath, "Dockerfile"))) ||
    (await fileExists(path.join(absolutePath, "docker-compose.yml"))) ||
    (await fileExists(path.join(absolutePath, "docker-compose.yaml")));

  // Check for .env.example
  const hasEnvExample = await fileExists(path.join(absolutePath, ".env.example"));

  // Derive project name from directory if not found from config files
  const finalName = projectName || path.basename(absolutePath);

  // Run enhanced detection
  const taskLocations = await detectTaskLocations(absolutePath);
  const adrLocations = await detectAdrLocations(absolutePath);
  const architectureDocs = await detectArchitectureDocs(absolutePath);
  const conventionFiles = await detectConventionFiles(absolutePath);
  const linters = await detectLinters(absolutePath, language);
  const ciPipelines = await detectCiPipelines(absolutePath);
  const databaseConfigs = await detectDatabaseConfigs(absolutePath);
  const containerConfigs = await detectContainerConfigs(absolutePath);
  const frameworkType = await detectFrameworkType(absolutePath, language);
  const apiPatterns = await detectApiPatterns(absolutePath);
  const monorepoInfo = await detectMonorepo(absolutePath);

  // Runtime target detection
  const runtimeTargets: RuntimeTarget[] = [];
  const browserTarget = await detectBrowserRuntime(absolutePath, language);
  if (browserTarget) runtimeTargets.push(browserTarget);
  const androidTarget = await detectAndroidRuntime(absolutePath);
  if (androidTarget) runtimeTargets.push(androidTarget);
  const desktopTarget = await detectDesktopRuntime(absolutePath, language);
  if (desktopTarget) runtimeTargets.push(desktopTarget);
  const rnTarget = await detectReactNativeRuntime(absolutePath);
  if (rnTarget) runtimeTargets.push(rnTarget);

  // Enhanced detection for intelligent intake
  const scriptCommands = await detectScriptCommands(absolutePath, language);
  const gitInfo = await detectGitInfo(absolutePath);
  const testFileInfo = await detectTestFiles(absolutePath, language);

  return {
    projectPath: absolutePath,
    projectName: finalName,
    language,
    testCommand,
    testFrameworks,
    buildTools,
    sourceDirs,
    docFiles,
    readmeContent,
    claudeMdContent,
    hasExistingQuackDir,
    hasTypeScript,
    hasDocker,
    hasEnvExample,
    // Enhanced fields
    taskLocations,
    adrLocations,
    architectureDocs,
    conventionFiles,
    linters,
    ciPipelines,
    databaseConfigs,
    containerConfigs,
    frameworkType,
    apiPatterns,
    isMonorepo: monorepoInfo.isMonorepo,
    workspaces: monorepoInfo.workspaces,
    runtimeTargets,
    // Intelligent intake fields
    scriptCommands,
    testFileCount: testFileInfo.testFileCount,
    testSuiteSize: testFileInfo.testSuiteSize,
    availableTestScripts: testFileInfo.availableTestScripts,
    gitDefaultBranch: gitInfo.gitDefaultBranch,
    gitRemoteUrl: gitInfo.gitRemoteUrl,
    gitHubOwner: gitInfo.gitHubOwner,
    gitHubRepo: gitInfo.gitHubRepo,
  };
}
