// ─── Bootstrap: Adapter Generator ───────────────────────────────────
// Generates starter adapter.json and conventions.md from scan results.
// Pure logic — no LLM calls.

import * as path from "node:path";
import type { AdapterConfig, TestPatternConfig } from "../core/types.js";
import { AdapterConfigSchema } from "../core/adapter-schema.js";
import type { ScanResult, RuntimeTarget } from "./project-scanner.js";
import { hasTarget } from "./project-scanner.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface GeneratedAdapter {
  /** Generated adapter.json content (validated) */
  adapterConfig: AdapterConfig;
  /** Generated conventions.md content */
  conventionsMd: string;
  /** Generated TESTING.md content */
  testingConventionMd: string;
  /** Generated test-existence-check.js content */
  testExistenceCheckJs: string;
  /** Generated test-existence.config.json content */
  testExistenceConfigJson: string;
}

// ─── Writable/Denied path defaults ─────────────────────────────────

function deriveWritablePaths(scan: ScanResult): string[] {
  const writable: string[] = [];

  if (scan.sourceDirs.includes("src/")) {
    writable.push("src/");
  }
  if (scan.sourceDirs.includes("lib/")) {
    writable.push("lib/");
  }
  if (scan.sourceDirs.includes("tests/")) {
    writable.push("tests/");
  }
  if (scan.sourceDirs.includes("test/")) {
    writable.push("test/");
  }
  if (scan.sourceDirs.includes("spec/")) {
    writable.push("spec/");
  }

  // Platform-specific writable paths
  if (hasTarget(scan, "android")) {
    writable.push("app/src/");
  }
  if (hasTarget(scan, "tauri")) {
    writable.push("src-tauri/src/");
  }

  // Fallback defaults if nothing detected
  if (writable.length === 0) {
    writable.push("src/", "tests/");
  }

  return writable;
}

function deriveDeniedPaths(scan: ScanResult): string[] {
  const denied = [".env", ".env.*"];

  if (scan.language === "node") {
    denied.push("node_modules/");
    // Framework-specific denied paths for Node.js
    if (scan.frameworkType === "nextjs") {
      denied.push(".next/");
    } else if (scan.frameworkType === "nuxt") {
      denied.push(".nuxt/");
    }
    // Common build outputs for Node.js projects
    denied.push("dist/", "build/");
  }

  if (scan.language === "python") {
    // Python-specific denied paths
    denied.push("__pycache__/", "*.pyc", ".pytest_cache/", ".mypy_cache/", "*.egg-info/");
  }

  if (scan.hasDocker) {
    denied.push("docker-compose*.yml");
  }

  // Platform-specific denied paths
  if (hasTarget(scan, "android")) {
    denied.push(".gradle/", "build/");
  }
  if (hasTarget(scan, "tauri")) {
    denied.push("src-tauri/target/");
  }

  return denied;
}

// ─── Verification commands ──────────────────────────────────────────

function deriveVerificationCommands(scan: ScanResult) {
  const commands: Array<{
    name: string;
    command: string;
    required: boolean;
    timeout: number;
  }> = [];

  // Add build command if detected
  if (scan.scriptCommands.build) {
    commands.push({
      name: "build",
      command: scan.language === "node" ? "npm run build" : scan.scriptCommands.build,
      required: true,
      timeout: 120,
    });
  }

  // Smart test command generation based on suite size
  if (scan.testCommand) {
    if (scan.testSuiteSize === "small") {
      // Small suite: run full tests
      commands.push({
        name: "tests",
        command: scan.testCommand,
        required: true,
        timeout: 300,
      });
    } else if (scan.testSuiteSize === "medium") {
      // Medium suite: prefer targeted tests, include full suite as optional
      const targetedScript = scan.availableTestScripts.find((s) => s.name.includes("unit"));
      if (targetedScript) {
        commands.push({
          name: "tests",
          command:
            scan.language === "node" ? `npm run ${targetedScript.name}` : targetedScript.command,
          required: true,
          timeout: 300,
        });
      } else {
        commands.push({
          name: "tests",
          command: scan.language === "node" ? "npx jest --changedSince=HEAD~1" : scan.testCommand,
          required: true,
          timeout: 300,
        });
      }
      commands.push({
        name: "tests-full",
        command: scan.testCommand,
        required: false,
        timeout: 600,
      });
    } else {
      // Large suite: targeted command as primary, full suite as secondary
      const targetedScript = scan.availableTestScripts.find((s) => s.name.includes("unit"));
      if (targetedScript) {
        commands.push({
          name: "tests",
          command:
            scan.language === "node" ? `npm run ${targetedScript.name}` : targetedScript.command,
          required: true,
          timeout: 300,
        });
        commands.push({
          name: "tests-full",
          command: scan.testCommand,
          required: false,
          timeout: 600,
        });
      } else {
        // Fallback to changed-files approach
        const usesJest =
          scan.testFrameworks.some((f) => f.name === "jest") ||
          (scan.scriptCommands.test && /\bjest\b/i.test(scan.scriptCommands.test));
        if (scan.language === "node" && usesJest) {
          commands.push({
            name: "tests",
            command: "npx jest --changedSince=HEAD~1",
            required: true,
            timeout: 300,
          });
        } else if (scan.language === "python") {
          commands.push({
            name: "tests",
            command: "pytest --lf --tb=short",
            required: true,
            timeout: 300,
          });
        } else {
          // No smart targeting available, use full suite but warn
          commands.push({
            name: "tests",
            command: scan.testCommand,
            required: true,
            timeout: 600,
          });
        }
        commands.push({
          name: "tests-full",
          command: scan.testCommand,
          required: false,
          timeout: 600,
        });
      }
    }
  }

  // TypeScript type-check
  if (scan.hasTypeScript && scan.language === "node") {
    commands.push({
      name: "typecheck",
      command: "npx tsc --noEmit",
      required: false,
      timeout: 60,
    });
  }

  // Add detected linters
  for (const linter of scan.linters) {
    commands.push({
      name: linter.name,
      command: linter.command,
      required: false,
      timeout: 60,
    });
  }

  // Fallback lint commands if no linters were detected
  if (scan.linters.length === 0) {
    if (scan.language === "node") {
      commands.push({
        name: "lint",
        command: "npm run lint",
        required: false,
        timeout: 60,
      });
    }
    if (scan.language === "python") {
      commands.push({
        name: "lint",
        command: "ruff check .",
        required: false,
        timeout: 60,
      });
    }
    if (scan.language === "rust") {
      commands.push({
        name: "lint",
        command: "cargo clippy",
        required: false,
        timeout: 120,
      });
    }
    if (scan.language === "go") {
      commands.push({
        name: "lint",
        command: "golangci-lint run",
        required: false,
        timeout: 120,
      });
    }
  }

  // Runtime target verification commands
  for (const target of scan.runtimeTargets) {
    for (const cmd of target.testCommands) {
      // Skip device-dependent tests (can't run in CI without emulator setup)
      if (cmd.requiresDevice) continue;
      commands.push({
        name: cmd.name,
        command: cmd.command,
        required: false,
        timeout: cmd.timeout,
      });
    }
  }

  // Fallback: if no test command was detected, still add a placeholder
  if (commands.length === 0) {
    commands.push({
      name: "tests",
      command: "echo 'No test command detected — configure manually'",
      required: true,
      timeout: 300,
    });
  }

  return commands;
}

// ─── Bash patterns ──────────────────────────────────────────────────

function deriveAllowedBashPatterns(scan: ScanResult): string[] {
  const patterns: string[] = ["ls *", "node .quack/convention-checks/*"];

  if (scan.language === "node") {
    patterns.push("npm test *", "npm run *", "npx *");
  }
  if (scan.language === "python") {
    patterns.push("pytest *", "python -m pytest *", "ruff *");
  }
  if (scan.language === "rust") {
    patterns.push("cargo test *", "cargo clippy *", "cargo build *");
  }
  if (scan.language === "go") {
    patterns.push("go test *", "go build *", "golangci-lint *");
  }

  // Platform-specific bash patterns
  if (hasTarget(scan, "android")) {
    patterns.push("./gradlew *");
  }
  if (hasTarget(scan, "tauri")) {
    patterns.push("cargo build *", "cargo test *");
  }

  return patterns;
}

function deriveDeniedBashPatterns(): string[] {
  return ["rm -rf *", "curl *", "wget *", "git push *", "git checkout *", "git reset *"];
}

// ─── Conventions.md generation ──────────────────────────────────────

function generateConventionsMd(scan: ScanResult): string {
  const sections: string[] = [];

  sections.push(`# ${scan.projectName} - Project Conventions`);
  sections.push("");
  sections.push(
    "This file was auto-generated by `quack init`. " +
      "Review and edit it to match your project's actual conventions.",
  );
  sections.push("");

  // Stack section
  sections.push("## Stack");
  sections.push("");

  switch (scan.language) {
    case "node":
      sections.push(`- **Runtime:** Node.js`);
      if (scan.hasTypeScript) {
        sections.push(`- **Language:** TypeScript`);
      } else {
        sections.push(`- **Language:** JavaScript`);
      }
      for (const fw of scan.testFrameworks) {
        sections.push(`- **Testing:** ${fw.name}`);
      }
      for (const bt of scan.buildTools) {
        sections.push(`- **Build:** ${bt.name}`);
      }
      break;
    case "python":
      sections.push(`- **Language:** Python`);
      for (const fw of scan.testFrameworks) {
        sections.push(`- **Testing:** ${fw.name}`);
      }
      break;
    case "rust":
      sections.push(`- **Language:** Rust`);
      sections.push(`- **Testing:** cargo test`);
      break;
    case "go":
      sections.push(`- **Language:** Go`);
      sections.push(`- **Testing:** go test`);
      break;
    default:
      sections.push(`- **Language:** (not detected — configure manually)`);
  }

  if (scan.hasDocker) {
    sections.push(`- **Containerization:** Docker`);
  }

  sections.push("");

  // Directory structure
  if (scan.sourceDirs.length > 0) {
    sections.push("## Project Structure");
    sections.push("");
    sections.push("```");
    for (const dir of scan.sourceDirs) {
      sections.push(`${dir}`);
    }
    sections.push("```");
    sections.push("");
  }

  // Testing section
  sections.push("## Testing");
  sections.push("");
  if (scan.testCommand) {
    sections.push(`Run tests with: \`${scan.testCommand}\``);
  } else {
    sections.push("(No test command detected -- configure manually)");
  }
  sections.push("");

  // Extract conventions from CLAUDE.md if present
  if (scan.claudeMdContent) {
    sections.push("## Conventions (extracted from CLAUDE.md)");
    sections.push("");
    // Extract relevant sections from CLAUDE.md (conventions, patterns, rules)
    const lines = scan.claudeMdContent.split("\n");
    let inRelevantSection = false;
    for (const line of lines) {
      // Track section headers
      if (/^#{1,3}\s/.test(line)) {
        const lower = line.toLowerCase();
        inRelevantSection =
          lower.includes("convention") ||
          lower.includes("pattern") ||
          lower.includes("rule") ||
          lower.includes("style") ||
          lower.includes("stack") ||
          lower.includes("architecture");
      }
      if (inRelevantSection) {
        sections.push(line);
      }
    }
    sections.push("");
  }

  // Extract from README if CLAUDE.md not present
  if (!scan.claudeMdContent && scan.readmeContent) {
    sections.push("## Notes (extracted from README.md)");
    sections.push("");
    // Just include the first ~30 lines as a summary
    const readmeLines = scan.readmeContent.split("\n").slice(0, 30);
    sections.push(...readmeLines);
    sections.push("");
  }

  // General guidance
  sections.push("## General");
  sections.push("");
  sections.push("- Follow existing code patterns in the codebase");
  sections.push("- All tests must pass before committing");
  sections.push("- Review and customize this file to match your project's actual conventions");
  sections.push("");

  return sections.join("\n");
}

// ─── Test pattern derivation ────────────────────────────────────────

export function deriveTestPatterns(scan: ScanResult): TestPatternConfig | undefined {
  if (scan.language === "rust" || scan.language === "unknown") {
    return undefined;
  }

  const testDir = scan.sourceDirs.includes("tests/")
    ? "tests/"
    : scan.sourceDirs.includes("test/")
      ? "test/"
      : scan.sourceDirs.includes("spec/")
        ? "spec/"
        : "tests/";

  const sourceDir = scan.sourceDirs.includes("src/")
    ? "src/"
    : scan.sourceDirs.includes("lib/")
      ? "lib/"
      : "src/";

  switch (scan.language) {
    case "node":
      return {
        testDir,
        sourceDir,
        suffixes: scan.hasTypeScript ? [".test.ts", ".spec.ts"] : [".test.js", ".spec.js"],
        prefixes: [],
        autoConventions: ["TESTING"],
      };
    case "python":
      return {
        testDir,
        sourceDir,
        suffixes: [],
        prefixes: ["test_"],
        autoConventions: ["TESTING"],
      };
    case "go":
      return {
        testDir: sourceDir, // Go tests are co-located
        sourceDir,
        suffixes: ["_test.go"],
        prefixes: [],
        autoConventions: ["TESTING"],
      };
    default:
      return undefined;
  }
}

// ─── Runtime testing section helpers ─────────────────────────────────

function appendRuntimeTestingSection(sections: string[], target: RuntimeTarget): void {
  switch (target.type) {
    case "browser":
      appendBrowserTestingSection(sections, target);
      break;
    case "android":
      appendAndroidTestingSection(sections, target);
      break;
    case "electron":
      appendDesktopTestingSection(sections, target, "Electron");
      break;
    case "tauri":
      appendDesktopTestingSection(sections, target, "Tauri");
      break;
    case "react-native":
      appendReactNativeTestingSection(sections, target);
      break;
  }
}

function appendBrowserTestingSection(sections: string[], target: RuntimeTarget): void {
  sections.push("## Functional/Browser Testing");
  sections.push("");
  sections.push(
    "**Unit tests alone are insufficient for browser projects.** Unit tests run in Node.js",
  );
  sections.push(
    "and cannot catch browser-specific failures. Functional tests must verify the built",
  );
  sections.push("output works in a real browser.");
  sections.push("");
  sections.push("### What unit tests miss");
  sections.push("");
  sections.push("- **Import resolution:** Node.js resolves extensionless imports (`./game`), but");
  sections.push("  browser ES modules require explicit extensions (`./game.js`). This is the #1");
  sections.push('  cause of "all tests pass but app is broken" scenarios.');
  sections.push(
    "- **Canvas/WebGL rendering:** `getContext('2d')` may return null or render nothing",
  );
  sections.push("  due to missing setup that only manifests in a real browser.");
  sections.push(
    "- **DOM events:** Event listeners, focus management, and keyboard handling differ",
  );
  sections.push("  between jsdom/Node.js and real browsers.");
  sections.push("- **CSS layout:** Visual regressions, z-index issues, and responsive breakpoints");
  sections.push("  are invisible to unit tests.");
  sections.push(
    "- **Missing polyfills:** APIs available in Node.js may not exist in target browsers.",
  );
  sections.push("");
  sections.push("### Browser smoke test checklist");
  sections.push("");
  sections.push("Every browser smoke test should verify:");
  sections.push("1. Page loads without JavaScript console errors");
  sections.push("2. Core UI elements render (canvas has content, main layout visible)");
  sections.push("3. No module resolution errors in the network/console");
  sections.push("4. Basic user interactions work (clicks, keyboard input)");
  sections.push("");

  if (target.testFrameworks.length > 0) {
    sections.push(`### Configured framework: ${target.testFrameworks.join(", ")}`);
    sections.push("");
    if (target.testFrameworks.includes("playwright")) {
      sections.push("Run browser tests: `npx playwright test`");
    } else if (target.testFrameworks.includes("cypress")) {
      sections.push("Run browser tests: `npx cypress run`");
    }
    sections.push("");
  } else {
    sections.push("### Recommended: Set up Playwright");
    sections.push("");
    sections.push("No browser test framework is currently configured. Consider adding Playwright:");
    sections.push("```bash");
    sections.push("npm install -D @playwright/test");
    sections.push("npx playwright install");
    sections.push("```");
    sections.push("");
  }
}

function appendAndroidTestingSection(sections: string[], target: RuntimeTarget): void {
  sections.push("## Android Runtime Testing");
  sections.push("");
  sections.push(
    "**Unit tests alone are insufficient for Android projects.** Unit tests run on the",
  );
  sections.push(
    "JVM and cannot catch Android-specific failures. Instrumented tests must verify the",
  );
  sections.push("app works on a real device or emulator.");
  sections.push("");
  sections.push("### What unit tests miss");
  sections.push("");
  sections.push(
    "- **Activity/Fragment lifecycle:** onCreate, onResume, onDestroy transitions that",
  );
  sections.push("  only happen on a real Android runtime.");
  sections.push("- **Permissions:** Runtime permission dialogs and their callbacks.");
  sections.push("- **Sensor APIs:** Camera, GPS, accelerometer behavior differs from mocks.");
  sections.push(
    "- **Screen density:** UI on different densities (mdpi, hdpi, xxhdpi) may clip or overlap.",
  );
  sections.push(
    "- **Background processing:** WorkManager, foreground services, and doze mode interactions.",
  );
  sections.push("");
  sections.push("### Android smoke test checklist");
  sections.push("");
  sections.push("1. App launches without crashing on emulator");
  sections.push("2. Main activity renders correctly");
  sections.push("3. Navigation between screens works");
  sections.push("4. No ANR (Application Not Responding) dialogs");
  sections.push("");
  sections.push("### Test commands");
  sections.push("");
  sections.push("- Unit tests (JVM): `./gradlew test` (no device required)");
  sections.push(
    "- Instrumented tests: `./gradlew connectedAndroidTest` (requires emulator/device)",
  );
  sections.push("");

  if (target.testFrameworks.length > 0) {
    sections.push(`### Configured framework: ${target.testFrameworks.join(", ")}`);
    sections.push("");
  }
}

function appendDesktopTestingSection(
  sections: string[],
  target: RuntimeTarget,
  platform: string,
): void {
  sections.push(`## ${platform} Desktop Testing`);
  sections.push("");
  sections.push(
    `**Unit tests alone are insufficient for ${platform} apps.** Unit tests run in Node.js`,
  );
  sections.push("and cannot catch desktop-specific failures. Functional tests must verify the app");
  sections.push("works as a native desktop application.");
  sections.push("");
  sections.push("### What unit tests miss");
  sections.push("");

  if (platform === "Electron") {
    sections.push("- **IPC (main↔renderer):** Communication between main and renderer processes.");
    sections.push(
      "- **Native OS integration:** File dialogs, notifications, system tray behavior.",
    );
    sections.push("- **Window lifecycle:** Window creation, minimize, maximize, close events.");
    sections.push("- **Menu and shortcuts:** Application menu, global keyboard shortcuts.");
    sections.push("- **Auto-updates:** Squirrel/electron-updater update flow.");
  } else {
    sections.push("- **Rust↔JS bridge:** Commands between the Rust backend and webview frontend.");
    sections.push(
      "- **Native OS integration:** File dialogs, notifications, system tray behavior.",
    );
    sections.push("- **Window lifecycle:** Window creation, minimize, maximize, close events.");
    sections.push(
      "- **Permissions:** File system access, network access on different OS policies.",
    );
  }

  sections.push("");
  sections.push("### Desktop smoke test checklist");
  sections.push("");
  sections.push("1. Application window opens without errors");
  sections.push("2. Main UI renders correctly");
  sections.push("3. Core menu items and shortcuts work");
  sections.push("4. No unhandled exceptions in console/logs");
  sections.push("");

  if (target.testFrameworks.length > 0) {
    sections.push(`### Configured framework: ${target.testFrameworks.join(", ")}`);
    sections.push("");
  }

  if (target.testCommands.length > 0) {
    sections.push("### Test commands");
    sections.push("");
    for (const cmd of target.testCommands) {
      sections.push(
        `- ${cmd.name}: \`${cmd.command}\`${cmd.requiresDevice ? " (requires device)" : ""}`,
      );
    }
    sections.push("");
  }
}

function appendReactNativeTestingSection(sections: string[], target: RuntimeTarget): void {
  sections.push("## React Native Testing");
  sections.push("");
  sections.push("**Unit tests alone are insufficient for React Native apps.** Unit tests run in");
  sections.push("Node.js and cannot catch platform-specific failures. E2E tests must verify the");
  sections.push("app works on real devices or emulators.");
  sections.push("");
  sections.push("### What unit tests miss");
  sections.push("");
  sections.push("- **Native bridge:** Communication between JS and native modules.");
  sections.push(
    "- **Platform-specific rendering:** Components render differently on iOS vs Android.",
  );
  sections.push("- **Navigation:** Stack/tab navigation transitions and deep linking.");
  sections.push("- **Gesture handling:** Swipes, pinch-to-zoom, long press on different devices.");
  sections.push(
    "- **Native modules:** Camera, push notifications, biometrics require real device testing.",
  );
  sections.push("");
  sections.push("### React Native smoke test checklist");
  sections.push("");
  sections.push("1. App launches without red screen on emulator/device");
  sections.push("2. Main screen renders correctly");
  sections.push("3. Navigation between screens works");
  sections.push("4. No JS bridge errors in Metro console");
  sections.push("");

  if (target.testFrameworks.length > 0) {
    sections.push(`### Configured framework: ${target.testFrameworks.join(", ")}`);
    sections.push("");
  } else {
    sections.push("### Recommended: Set up Detox");
    sections.push("");
    sections.push("No E2E test framework is currently configured. Consider adding Detox:");
    sections.push("```bash");
    sections.push("npm install -D detox");
    sections.push("npx detox init");
    sections.push("```");
    sections.push("");
  }
}

// ─── TESTING.md generation ──────────────────────────────────────────

export function generateTestingConventionMd(scan: ScanResult): string {
  const sections: string[] = [];

  sections.push("# TESTING — Testing Conventions");
  sections.push("");
  sections.push(
    "This file was auto-generated by `quack init`. " +
      "Review and customize it for your project. " +
      "Referenced automatically via `autoConventions` in adapter config.",
  );
  sections.push("");

  // Section 1: Test Runner
  sections.push("## Test Runner");
  sections.push("");
  if (scan.testCommand) {
    sections.push(`- **Command:** \`${scan.testCommand}\``);
  } else {
    sections.push("- **Command:** (not detected — configure manually)");
  }
  if (scan.testFrameworks.length > 0) {
    sections.push(`- **Framework:** ${scan.testFrameworks[0].name}`);
  }
  switch (scan.language) {
    case "node":
      sections.push("- **Environment:** Node.js (set `NODE_ENV=test` if needed)");
      break;
    case "python":
      sections.push("- **Environment:** Python");
      break;
    case "go":
      sections.push("- **Environment:** Go (tests run via `go test`)");
      break;
    case "rust":
      sections.push("- **Environment:** Rust (tests run via `cargo test`)");
      break;
  }
  sections.push("");

  // Section 2: Test Structure
  sections.push("## Test Structure");
  sections.push("");

  switch (scan.language) {
    case "node":
      if (scan.hasTypeScript) {
        sections.push("- **Test directory:** `tests/`");
        sections.push("- **Naming:** `*.test.ts` or `*.spec.ts`");
        sections.push(
          "- **Convention:** Mirror source structure: `src/foo/bar.ts` -> `tests/foo/bar.test.ts`",
        );
      } else {
        sections.push("- **Test directory:** `tests/`");
        sections.push("- **Naming:** `*.test.js` or `*.spec.js`");
        sections.push(
          "- **Convention:** Mirror source structure: `src/foo/bar.js` -> `tests/foo/bar.test.js`",
        );
      }
      break;
    case "python":
      sections.push("- **Test directory:** `tests/`");
      sections.push("- **Naming:** `test_*.py` (prefix convention)");
      sections.push(
        "- **Convention:** Mirror source structure: `src/foo/bar.py` -> `tests/foo/test_bar.py`",
      );
      break;
    case "go":
      sections.push("- **Test files:** Co-located with source (same directory)");
      sections.push("- **Naming:** `*_test.go` (suffix convention)");
      sections.push("- **Convention:** `foo.go` -> `foo_test.go` in the same package");
      break;
    case "rust":
      sections.push("- **Test location:** Inline in source files");
      sections.push("- **Convention:** `#[cfg(test)] mod tests { ... }` at bottom of each module");
      break;
    default:
      sections.push("- **Test directory:** (configure manually)");
      sections.push("- **Naming:** (configure manually)");
  }
  sections.push("");

  // Section 3: Test Patterns
  sections.push("## Test Patterns");
  sections.push("");

  const frameworkName = scan.testFrameworks[0]?.name.toLowerCase() ?? "";

  if (frameworkName.includes("jest") || frameworkName.includes("vitest")) {
    sections.push("```typescript");
    sections.push(
      'import { describe, it, expect } from "' +
        (frameworkName.includes("vitest") ? "vitest" : "@jest/globals") +
        '";',
    );
    sections.push("");
    sections.push('describe("MyModule", () => {');
    sections.push('  it("should do something", () => {');
    sections.push("    const result = myFunction();");
    sections.push('    expect(result).toBe("expected");');
    sections.push("  });");
    sections.push("});");
    sections.push("```");
  } else if (frameworkName.includes("pytest") || scan.language === "python") {
    sections.push("```python");
    sections.push("def test_my_function():");
    sections.push("    result = my_function()");
    sections.push('    assert result == "expected"');
    sections.push("```");
  } else if (scan.language === "rust") {
    sections.push("```rust");
    sections.push("#[cfg(test)]");
    sections.push("mod tests {");
    sections.push("    use super::*;");
    sections.push("");
    sections.push("    #[test]");
    sections.push("    fn test_my_function() {");
    sections.push('        assert_eq!(my_function(), "expected");');
    sections.push("    }");
    sections.push("}");
    sections.push("```");
  } else if (scan.language === "go") {
    sections.push("```go");
    sections.push("func TestMyFunction(t *testing.T) {");
    sections.push("    result := MyFunction()");
    sections.push('    if result != "expected" {');
    sections.push('        t.Errorf("got %s, want expected", result)');
    sections.push("    }");
    sections.push("}");
    sections.push("```");
  } else if (frameworkName.includes("mocha")) {
    sections.push("```javascript");
    sections.push('const assert = require("assert");');
    sections.push("");
    sections.push('describe("MyModule", () => {');
    sections.push('  it("should do something", () => {');
    sections.push("    const result = myFunction();");
    sections.push('    assert.strictEqual(result, "expected");');
    sections.push("  });");
    sections.push("});");
    sections.push("```");
  } else {
    sections.push("(Add your project's test template here)");
  }
  sections.push("");

  // Section 4: Runtime-specific testing sections
  for (const target of scan.runtimeTargets) {
    appendRuntimeTestingSection(sections, target);
  }

  // Section 5: Known Gotchas
  sections.push("## Known Gotchas");
  sections.push("");
  sections.push("<!-- Add project-specific testing gotchas here as they are discovered. -->");
  sections.push(
    "<!-- Example: 'Never use page.waitForLoadState(\"networkidle\") with SSE endpoints' -->",
  );
  sections.push("");

  return sections.join("\n");
}

// ─── Test-existence check script generation ─────────────────────────

export function generateTestExistenceCheck(): string {
  return `#!/usr/bin/env node
/**
 * Convention Check: Test Existence
 * Verifies that modified source files have corresponding test files.
 *
 * Reads config from .quack/test-existence.config.json
 * Exit 0: All source files have tests (or nothing to check)
 * Exit 1: Some source files missing tests
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = process.cwd();

// Load config
const configPath = path.join(projectRoot, ".quack", "test-existence.config.json");
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (err) {
  process.stderr.write("test-existence: Cannot read config at " + configPath + "\\n");
  process.exit(1);
}

// Get changed files via git
let changedFiles;
try {
  const output = execSync("git diff HEAD --name-only", {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  changedFiles = output.trim().split("\\n").filter(Boolean);
} catch (err) {
  // No git HEAD (fresh repo) or not a git repo — skip check
  process.stdout.write("test-existence: Skipped (no git HEAD)\\n");
  process.exit(0);
}

if (changedFiles.length === 0) {
  process.stdout.write("test-existence: No changed files.\\n");
  process.exit(0);
}

// Filter to source files
const sourceDir = config.sourceDir || "src/";
const testDir = config.testDir || "tests/";
const suffixes = config.testSuffixes || [];
const prefixes = config.testPrefixes || [];
const ignorePaths = config.ignorePaths || [];

const sourceFiles = changedFiles.filter(function (f) {
  if (!f.startsWith(sourceDir)) return false;
  if (ignorePaths.some(function (p) { return f.startsWith(p) || f === p; })) return false;
  return true;
});

if (sourceFiles.length === 0) {
  process.stdout.write("test-existence: No source files in diff.\\n");
  process.exit(0);
}

// Check each source file for a corresponding test
var missing = [];
for (var i = 0; i < sourceFiles.length; i++) {
  var sourceFile = sourceFiles[i];
  var relativePart = sourceFile.slice(sourceDir.length);
  var parsed = path.parse(relativePart);
  var hasTest = false;

  // Check suffix patterns (e.g., bar.test.ts)
  for (var s = 0; s < suffixes.length; s++) {
    var testPath = path.join(testDir, parsed.dir, parsed.name + suffixes[s]);
    if (fs.existsSync(path.join(projectRoot, testPath))) {
      hasTest = true;
      break;
    }
  }

  // Check prefix patterns (e.g., test_bar.py)
  if (!hasTest) {
    for (var p = 0; p < prefixes.length; p++) {
      var testPath2 = path.join(testDir, parsed.dir, prefixes[p] + parsed.name + parsed.ext);
      if (fs.existsSync(path.join(projectRoot, testPath2))) {
        hasTest = true;
        break;
      }
    }
  }

  if (!hasTest) {
    missing.push(sourceFile);
  }
}

if (missing.length > 0) {
  process.stderr.write("test-existence: " + missing.length + " source file(s) without tests:\\n");
  for (var m = 0; m < missing.length; m++) {
    process.stderr.write("  " + missing[m] + "\\n");
  }
  process.exit(1);
} else {
  process.stdout.write("test-existence: All " + sourceFiles.length + " source file(s) have tests.\\n");
  process.exit(0);
}
`;
}

// ─── Test-existence config generation ───────────────────────────────

export function generateTestExistenceConfig(scan: ScanResult): string {
  const testPatterns = deriveTestPatterns(scan);

  const config = {
    sourceDir: testPatterns?.sourceDir ?? "src/",
    testDir: testPatterns?.testDir ?? "tests/",
    testSuffixes: testPatterns?.suffixes ?? [],
    testPrefixes: testPatterns?.prefixes ?? [],
    ignorePaths: [] as string[],
  };

  // Add common ignore paths per language
  switch (scan.language) {
    case "node":
      config.ignorePaths = ["src/index.ts", "src/index.js"];
      break;
    case "python":
      config.ignorePaths = ["src/__init__.py", "src/conftest.py"];
      break;
    case "go":
      config.ignorePaths = [];
      break;
    default:
      config.ignorePaths = [];
  }

  return JSON.stringify(config, null, 2) + "\n";
}

// ─── Main generator ─────────────────────────────────────────────────

export function generateAdapter(scan: ScanResult): GeneratedAdapter {
  // Auto-detect task directory from scanner results
  let taskDir = "docs/tasks"; // default
  if (scan.taskLocations.length > 0) {
    const firstLocation = scan.taskLocations[0];
    if (firstLocation.type === "directory") {
      taskDir = firstLocation.path;
    } else {
      // It's a file - extract directory
      const dir = path.dirname(firstLocation.path);
      taskDir = dir === "." ? "." : dir; // root directory becomes "."
    }
  }

  // Auto-detect conventions directory from scanner results
  let conventionsDir = ".quack"; // default
  if (scan.conventionFiles.length > 0) {
    // Prefer directories, then convention docs (CONVENTIONS.md, CLAUDE.md), but skip .editorconfig
    // .editorconfig is a config file, not a conventions directory indicator
    const suitableLocation = scan.conventionFiles.find((loc) => {
      if (loc.type === "directory") return true;
      // Skip .editorconfig when it's in root - it shouldn't determine conventionsDir
      const basename = path.basename(loc.path);
      if (basename === ".editorconfig" && path.dirname(loc.path) === ".") return false;
      return true; // Include CONVENTIONS.md, CLAUDE.md, etc., even in root
    });

    if (suitableLocation) {
      if (suitableLocation.type === "directory") {
        conventionsDir = suitableLocation.path;
      } else {
        const dir = path.dirname(suitableLocation.path);
        conventionsDir = dir === "." ? "." : dir; // root directory becomes "."
      }
    }
  }

  // Build the raw adapter config object
  const rawConfig = {
    $schema: "https://quack.dev/adapter-schema.json",
    version: "1.0",
    project: {
      name: scan.projectName,
      root: ".",
      taskDir,
      conventionsDir,
      ...(deriveTestPatterns(scan) ? { testPatterns: deriveTestPatterns(scan) } : {}),
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: deriveVerificationCommands(scan),
      conventionChecks:
        scan.language !== "rust" && scan.language !== "unknown"
          ? [
              {
                name: "test-existence",
                description: "Verify modified source files have corresponding test files",
                command: "node .quack/convention-checks/test-existence-check.js",
                conventionRef: "TESTING",
              },
            ]
          : [],
    },
    sandbox: {
      writablePaths: deriveWritablePaths(scan),
      deniedPaths: deriveDeniedPaths(scan),
      allowedBashPatterns: deriveAllowedBashPatterns(scan),
      deniedBashPatterns: deriveDeniedBashPatterns(),
    },
    git: {
      baseBranch: scan.gitDefaultBranch ?? "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug" as const,
      retainDays: 30,
    },
    ...(scan.gitHubOwner && scan.gitHubRepo
      ? {
          integrations: {
            github: {
              owner: scan.gitHubOwner,
              repo: scan.gitHubRepo,
            },
          },
        }
      : {}),
  };

  // Validate against Zod schema
  const result = AdapterConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Generated adapter config failed validation:\n${issues}`);
  }

  const adapterConfig: AdapterConfig = result.data;
  const conventionsMd = generateConventionsMd(scan);
  const testingConventionMd = generateTestingConventionMd(scan);
  const testExistenceCheckJs = generateTestExistenceCheck();
  const testExistenceConfigJson = generateTestExistenceConfig(scan);

  return {
    adapterConfig,
    conventionsMd,
    testingConventionMd,
    testExistenceCheckJs,
    testExistenceConfigJson,
  };
}
