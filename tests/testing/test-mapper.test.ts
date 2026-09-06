import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { normalize } from "node:path";

// Mock fs before importing the module
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

import {
  mapChangedFilesToTests,
  mapChangedFilesToModuleTests,
} from "../../src/testing/test-mapper.js";
import { existsSync, readdirSync, statSync } from "node:fs";

const mockExistsSync = existsSync as ReturnType<typeof jest.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof jest.fn>;
const mockStatSync = statSync as ReturnType<typeof jest.fn>;

/**
 * Helper: normalize a path pattern for cross-platform matching.
 * On Windows, path.join converts / to \, so mock checks need to handle both.
 */
function np(p: string): string {
  return normalize(p);
}

/**
 * Helper: check if a path contains a forward-slash pattern (cross-platform).
 * Normalizes both sides before checking.
 */
function pathContains(fullPath: string, pattern: string): boolean {
  return np(fullPath).includes(np(pattern));
}

describe("test-mapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("mapChangedFilesToTests", () => {
    it("maps backend service files to test files", () => {
      const diffFiles = ["src/src/services/foo.service.js"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/services/foo.service.test.js");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(
        result.some((f) => pathContains(f, "src/tests/unit/services/foo.service.test.js")),
      ).toBe(true);
    });

    it("maps backend controller files to test files", () => {
      const diffFiles = ["src/src/controllers/auth.controller.js"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/controllers/auth.controller.test.js");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(
        result.some((f) => pathContains(f, "src/tests/unit/controllers/auth.controller.test.js")),
      ).toBe(true);
    });

    it("maps backend middleware files to test files", () => {
      const diffFiles = ["src/src/middleware/featureFlag.js"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/middleware/featureFlag.test.js");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(
        result.some((f) => pathContains(f, "src/tests/unit/middleware/featureFlag.test.js")),
      ).toBe(true);
    });

    it("maps frontend hook files to __tests__ convention", () => {
      const diffFiles = ["frontends/admin-portal/src/hooks/useFoo.ts"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "frontends/admin-portal/src/hooks/__tests__/useFoo.test.ts");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result.some((f) => pathContains(f, "hooks/__tests__/useFoo.test.ts"))).toBe(true);
    });

    it("maps frontend component files to __tests__ convention", () => {
      const diffFiles = ["frontends/admin-portal/src/components/Button.tsx"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "components/__tests__/Button.test.tsx");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result.some((f) => pathContains(f, "components/__tests__/Button.test.tsx"))).toBe(
        true,
      );
    });

    it("maps frontend page files to __tests__ convention", () => {
      const diffFiles = ["frontends/admin-portal/src/pages/Dashboard/DashboardPage.tsx"];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "pages/Dashboard/__tests__/DashboardPage.test.tsx");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(
        result.some((f) => pathContains(f, "pages/Dashboard/__tests__/DashboardPage.test.tsx")),
      ).toBe(true);
    });

    it("returns empty array when no test files exist for changed files", () => {
      const diffFiles = ["src/src/services/unknown.service.js"];
      mockExistsSync.mockReturnValue(false);

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result).toEqual([]);
    });

    it("skips non-source files", () => {
      const diffFiles = ["package.json", "README.md", ".env", "docker-compose.yml"];
      mockExistsSync.mockReturnValue(false);

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result).toEqual([]);
    });

    it("skips files that are already test files", () => {
      const diffFiles = [
        "src/tests/unit/services/foo.service.test.js",
        "frontends/app/src/hooks/__tests__/useFoo.test.ts",
      ];
      mockExistsSync.mockReturnValue(false);

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result).toEqual([]);
    });

    it("deduplicates test files when multiple sources map to same test", () => {
      const diffFiles = [
        "src/src/services/foo.service.js",
        "src/src/services/foo.service.js", // duplicate
      ];
      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/services/foo.service.test.js");
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      // Should only appear once even with duplicate source
      const occurrences = result.filter((f) => f.includes("foo.service.test.js"));
      expect(occurrences.length).toBe(1);
    });

    it("handles mixed backend and frontend files", () => {
      const diffFiles = [
        "src/src/services/auth.service.js",
        "frontends/admin-portal/src/hooks/useAuth.ts",
      ];
      mockExistsSync.mockImplementation((path: string) => {
        return (
          pathContains(path, "src/tests/unit/services/auth.service.test.js") ||
          pathContains(path, "hooks/__tests__/useAuth.test.ts")
        );
      });

      const result = mapChangedFilesToTests(diffFiles, "/project");
      expect(result.some((f) => f.includes("auth.service.test.js"))).toBe(true);
      expect(result.some((f) => f.includes("useAuth.test.ts"))).toBe(true);
    });
  });

  describe("mapChangedFilesToModuleTests", () => {
    it("finds all tests in a backend module directory", () => {
      const diffFiles = ["src/src/services/foo.service.js"];

      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/services");
      });

      mockReaddirSync.mockImplementation(() => ["foo.service.test.js", "bar.service.test.js"]);

      mockStatSync.mockImplementation(() => ({
        isDirectory: () => false,
      }));

      const result = mapChangedFilesToModuleTests(diffFiles, "/project");
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("includes integration tests matching module names", () => {
      const diffFiles = ["src/src/middleware/featureFlag.js"];

      mockExistsSync.mockImplementation((path: string) => {
        return (
          pathContains(path, "src/tests/unit/middleware") ||
          pathContains(path, "src/tests/integration")
        );
      });

      mockReaddirSync.mockImplementation((dir: string) => {
        if (String(dir).includes("integration")) {
          return ["featureFlag.integration.test.js", "other.test.js"];
        }
        return ["featureFlag.test.js"];
      });

      mockStatSync.mockImplementation(() => ({
        isDirectory: () => false,
      }));

      const result = mapChangedFilesToModuleTests(diffFiles, "/project");
      const hasIntegration = result.some(
        (f) => f.toLowerCase().includes("featureflag") && f.toLowerCase().includes("integration"),
      );
      // Should find integration test matching the module name
      expect(hasIntegration).toBe(true);
    });

    it("returns empty array when no module directories have tests", () => {
      const diffFiles = ["src/src/services/unknown.service.js"];
      mockExistsSync.mockReturnValue(false);

      const result = mapChangedFilesToModuleTests(diffFiles, "/project");
      expect(result).toEqual([]);
    });

    it("handles non-source files gracefully", () => {
      const diffFiles = ["package.json", "README.md"];
      mockExistsSync.mockReturnValue(false);

      const result = mapChangedFilesToModuleTests(diffFiles, "/project");
      expect(result).toEqual([]);
    });

    it("excludes files passed via excludeFiles parameter", () => {
      const diffFiles = ["src/src/services/foo.service.js"];

      mockExistsSync.mockImplementation((path: string) => {
        return pathContains(path, "src/tests/unit/services");
      });

      mockReaddirSync.mockImplementation(() => ["foo.service.test.js", "bar.service.test.js"]);

      mockStatSync.mockImplementation(() => ({
        isDirectory: () => false,
      }));

      // Without excludeFiles — should return both test files
      const allResults = mapChangedFilesToModuleTests(diffFiles, "/project");
      expect(allResults.length).toBeGreaterThanOrEqual(1);

      // With excludeFiles — should filter out the excluded file
      const fooTestFile = allResults.find((f) => f.includes("foo.service.test.js"));
      expect(fooTestFile).toBeDefined();

      const filtered = mapChangedFilesToModuleTests(diffFiles, "/project", [fooTestFile!]);
      expect(filtered).not.toContain(fooTestFile);
    });
  });
});
