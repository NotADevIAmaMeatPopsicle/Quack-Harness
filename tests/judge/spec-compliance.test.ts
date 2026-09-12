import {
  runSpecComplianceChecks,
  blueprintToChecks,
  type DeterministicCheck,
} from "../../src/judge/spec-compliance";
import type { ParsedTask, VerificationPattern } from "../../src/core/types";
import { promises as fs } from "fs";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

// ─── Test helpers ──────────────────────────────────────────────────

function makeTask(successCriteria: string[]): ParsedTask {
  return {
    id: "TASK-999",
    title: "Test Task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [],
    successCriteria,
    testingRequirements: [],
    contextReferences: [],
    rawContent: "",
  };
}

// ─── Built-in Pattern Tests ───────────────────────────────────────

describe("spec-compliance: built-in patterns", () => {
  describe("limit/cap enforcement", () => {
    test("should detect slice() as limit enforcement", async () => {
      const task = makeTask(["Enforces max of 10 items"]);
      const diff = `
diff --git a/src/list.ts b/src/list.ts
+export function getItems(items: string[]) {
+  return items.slice(0, 10);
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.criterion).toBe("Enforces max of 10 items");
      expect(results[0]?.description).toContain("slice");
    });

    test("should detect Math.min as limit enforcement", async () => {
      const task = makeTask(["Limits batch size to 100"]);
      const diff = `
diff --git a/src/batch.ts b/src/batch.ts
+const batchSize = Math.min(requestedSize, 100);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.evidence.length).toBeGreaterThan(0);
    });

    test("should flag missing limit enforcement code", async () => {
      const task = makeTask(["Enforces maxTasks limit of 5"]);
      const diff = `
diff --git a/src/queue.ts b/src/queue.ts
+// TODO: enforce maxTasks limit
+export function addTask(task: Task) {
+  tasks.push(task);
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(false);
      expect(results[0]?.severity).toBe("flag");
      expect(results[0]?.evidence).toEqual([]);
    });

    test("should detect conditional comparisons as limit enforcement", async () => {
      const task = makeTask(["Caps result count at maximum"]);
      const diff = `
diff --git a/src/query.ts b/src/query.ts
+if (count > maxResults) {
+  count = maxResults;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });
  });

  describe("error handling", () => {
    test("should detect try/catch as error handling", async () => {
      const task = makeTask(["Handles error gracefully"]);
      const diff = `
diff --git a/src/api.ts b/src/api.ts
+try {
+  await fetch(url);
+} catch (error) {
+  logger.error(error);
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.description).toContain("try/catch");
    });

    test("should detect .catch() as error handling", async () => {
      const task = makeTask(["Error handling for async operations"]);
      const diff = `
diff --git a/src/fetch.ts b/src/fetch.ts
+return fetch(url).catch(handleError);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should flag missing error handling", async () => {
      const task = makeTask(["Recovers from network failures"]);
      const diff = `
diff --git a/src/network.ts b/src/network.ts
+export async function sendRequest(url: string) {
+  const response = await fetch(url);
+  return response.json();
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(false);
      expect(results[0]?.severity).toBe("flag");
    });
  });

  describe("validation", () => {
    test("should detect validation logic with conditionals", async () => {
      const task = makeTask(["Validates email format"]);
      const diff = `
diff --git a/src/validator.ts b/src/validator.ts
+if (!email || !email.test(/^[^@]+@[^@]+$/)) {
+  throw new Error("Invalid email");
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should detect validation with regex test", async () => {
      const task = makeTask(["Ensures valid phone number"]);
      const diff = `
diff --git a/src/phone.ts b/src/phone.ts
+const isValid = /^\\d{10}$/.test(phoneNumber);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should flag missing validation", async () => {
      const task = makeTask(["Rejects invalid input"]);
      const diff = `
diff --git a/src/process.ts b/src/process.ts
+export function processInput(data: unknown) {
+  return data;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(false);
    });
  });

  describe("concurrency control", () => {
    test("should detect lock file patterns", async () => {
      const task = makeTask(["Prevents concurrent access with lock file"]);
      const diff = `
diff --git a/src/lock.ts b/src/lock.ts
+await fs.writeFile(lockPath, "", { flag: "wx" });
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.description).toContain("lock");
    });

    test("should detect mutex usage", async () => {
      const task = makeTask(["Handles race conditions with mutex"]);
      const diff = `
diff --git a/src/sync.ts b/src/sync.ts
+await mutex.acquire();
+try {
+  // critical section
+} finally {
+  mutex.release();
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });
  });

  describe("cross-reference checks", () => {
    test("does not require Set/Map operations for a pinned package dependency", async () => {
      const task = makeTask([
        "The exact dependency `@playwright/test@1.63.0` is locked, without a semver range, browser download, or install lifecycle script.",
      ]);
      const diff = `
diff --git a/package.json b/package.json
+    "@playwright/test": "1.63.0"
diff --git a/package-lock.json b/package-lock.json
+    "node_modules/@playwright/test": { "version": "1.63.0" }
`;

      const results = await runSpecComplianceChecks(task, diff, [
        "package.json",
        "package-lock.json",
      ]);

      expect(results).toEqual([]);
    });

    test("still flags an explicit dependency-existence check without lookup evidence", async () => {
      const task = makeTask(["Checks dependency exists before processing"]);
      const diff = `
diff --git a/src/deps.ts b/src/deps.ts
+processDependency(depId);
`;

      const results = await runSpecComplianceChecks(task, diff, ["src/deps.ts"]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ found: false, severity: "flag" });
      expect(results[0]?.description).toContain("Set/Map");
    });

    test("should detect Set.has() as cross-reference check", async () => {
      const task = makeTask(["Checks dependency exists before processing"]);
      const diff = `
diff --git a/src/deps.ts b/src/deps.ts
+if (!dependencies.has(depId)) {
+  throw new Error("Missing dependency");
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.description).toContain("Set/Map");
    });

    test("should detect array.includes() as cross-reference", async () => {
      const task = makeTask(["References existing user IDs"]);
      const diff = `
diff --git a/src/users.ts b/src/users.ts
+const isValid = validUserIds.includes(userId);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });
  });

  describe("frontend/React implementation", () => {
    test("should flag when criterion mentions page but diff has no .tsx files", async () => {
      const task = makeTask(["Gift Cards list page loads at /gift-cards"]);
      const diff = `
diff --git a/src/api/gift-cards.ts b/src/api/gift-cards.ts
+export async function getGiftCards() {
+  return prisma.giftCard.findMany();
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(false);
      expect(results[0]?.severity).toBe("flag");
      expect(results[0]?.description).toContain("Frontend/React");
    });

    test("should pass when criterion mentions page and diff contains .tsx with React code", async () => {
      const task = makeTask(["Gift Cards list page loads at /gift-cards"]);
      const diff = `
diff --git a/src/pages/GiftCardsPage.tsx b/src/pages/GiftCardsPage.tsx
+import { useState, useEffect } from 'react';
+
+export default function GiftCardsPage() {
+  const [cards, setCards] = useState([]);
+
+  useEffect(() => {
+    fetchGiftCards().then(setCards);
+  }, []);
+
+  return (
+    <div className="gift-cards-page">
+      <h1>Gift Cards</h1>
+    </div>
+  );
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should not trigger when criterion has no frontend keywords", async () => {
      const task = makeTask(["POST /api/gift-cards returns 201"]);
      const diff = `
diff --git a/src/api/gift-cards.ts b/src/api/gift-cards.ts
+export async function createGiftCard(data: any) {
+  return prisma.giftCard.create({ data });
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(0);
    });

    test("should detect JSX in sidebar navigation", async () => {
      const task = makeTask(["sidebar navigation includes Gift Cards link"]);
      const diff = `
diff --git a/src/components/Sidebar.tsx b/src/components/Sidebar.tsx
+export function Sidebar() {
+  return (
+    <div className="sidebar">
+      <a href="/gift-cards">Gift Cards</a>
+    </div>
+  );
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should detect component exports", async () => {
      const task = makeTask(["Creates GiftCardComponent for display"]);
      const diff = `
diff --git a/src/components/GiftCardComponent.tsx b/src/components/GiftCardComponent.tsx
+export default function GiftCardComponent({ card }: Props) {
+  return <div className="card">{card.name}</div>;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should detect useState hook", async () => {
      const task = makeTask(["Form component manages state"]);
      const diff = `
diff --git a/src/components/GiftCardForm.tsx b/src/components/GiftCardForm.tsx
+import { useState } from 'react';
+
+export function GiftCardForm() {
+  const [value, setValue] = useState('');
+  return <input value={value} onChange={e => setValue(e.target.value)} />;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });

    test("should detect React import", async () => {
      const task = makeTask(["Dashboard page displays metrics"]);
      const diff = `
diff --git a/src/pages/Dashboard.tsx b/src/pages/Dashboard.tsx
+import React from 'react';
+
+export function Dashboard() {
+  return <div>Dashboard</div>;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
    });
  });

  describe("pattern not triggered", () => {
    test("should not flag criteria that don't trigger any pattern", async () => {
      const task = makeTask(["Adds new user registration endpoint"]);
      const diff = `
diff --git a/src/routes.ts b/src/routes.ts
+app.post("/register", registerHandler);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(0);
    });

    test("should only return results for triggered patterns", async () => {
      const task = makeTask(["Enforces limit of 10", "Adds logging to endpoint"]);
      const diff = `
diff --git a/src/api.ts b/src/api.ts
+items = items.slice(0, 10);
+logger.info("Request received");
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      // Only the "enforces limit" criterion should trigger a pattern
      expect(results).toHaveLength(1);
      expect(results[0]?.criterion).toBe("Enforces limit of 10");
    });
  });

  describe("evidence collection", () => {
    test("should collect file:line references for evidence", async () => {
      const task = makeTask(["Validates input with multiple checks"]);
      const diff = `
diff --git a/src/validator.ts b/src/validator.ts
@@ -1,0 +1,10 @@
+export function validate(data: unknown) {
+  if (!data) {
+    throw new Error("Data required");
+  }
+  if (typeof data !== "object") {
+    throw new Error("Invalid type");
+  }
+  return true;
+}
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.found).toBe(true);
      expect(results[0]?.evidence.length).toBeGreaterThan(0);
      expect(results[0]?.evidence[0]).toMatch(/src\/validator\.ts:\d+/);
    });

    test("should not duplicate evidence from same line", async () => {
      const task = makeTask(["Enforces limits"]);
      const diff = `
diff --git a/src/limits.ts b/src/limits.ts
+const size = Math.min(Math.max(requested, 1), 100);
`;
      const results = await runSpecComplianceChecks(task, diff, []);

      expect(results).toHaveLength(1);
      expect(results[0]?.evidence.length).toBe(1); // One line, even though Math.min and Math.max both match
    });
  });
});

// ─── Adapter-Configured Check Tests ───────────────────────────────

describe("spec-compliance: adapter checks", () => {
  describe("grep type", () => {
    test("should match criterion and search for pattern", async () => {
      const task = makeTask(["Enforces example_id filtering in queries"]);
      const diff = `
diff --git a/src/models/booking.ts b/src/models/booking.ts
+const bookings = await Booking.findAll({
+  where: { example_id: exampleId }
+});
`;
      const adapterChecks: DeterministicCheck[] = [
        {
          name: "tenant-isolation",
          criterionMatch: "example_id",
          type: "grep",
          pattern: "example_id:",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

      const tenantCheck = results.find((r) => r.description.includes("tenant-isolation"));
      expect(tenantCheck).toBeDefined();
      expect(tenantCheck?.found).toBe(true);
      expect(tenantCheck?.evidence.length).toBeGreaterThan(0);
    });

    test("should flag when pattern not found", async () => {
      const task = makeTask(["Enforces example_id filtering"]);
      const diff = `
diff --git a/src/models/user.ts b/src/models/user.ts
+const users = await User.findAll();
`;
      const adapterChecks: DeterministicCheck[] = [
        {
          name: "tenant-isolation",
          criterionMatch: "example_id",
          type: "grep",
          pattern: "example_id:",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

      const tenantCheck = results.find((r) => r.description.includes("tenant-isolation"));
      expect(tenantCheck).toBeDefined();
      expect(tenantCheck?.found).toBe(false);
    });

    test("should filter by glob pattern", async () => {
      const task = makeTask(["Uses AppError for error responses"]);
      const diff = `
diff --git a/src/routes/api.ts b/src/routes/api.ts
+throw new AppError("Not found", 404);
diff --git a/src/utils/logger.ts b/src/utils/logger.ts
+throw new Error("Log error");
`;
      const adapterChecks: DeterministicCheck[] = [
        {
          name: "app-error-usage",
          criterionMatch: "AppError",
          type: "grep",
          pattern: "AppError",
          glob: "src/routes/*.ts",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

      const errorCheck = results.find((r) => r.description.includes("app-error-usage"));
      expect(errorCheck).toBeDefined();
      expect(errorCheck?.found).toBe(true);
      // Should only find the match in src/routes/*.ts, not utils
      expect(errorCheck?.evidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/src\/routes\/api\.ts/)]),
      );
    });
  });

  describe("file_exists type", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "spec-compliance-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    test("should pass when file exists", async () => {
      const task = makeTask(["Creates migration file"]);
      const diff = "";

      // Create the file
      const migrationPath = join(tempDir, "migrations", "001_init.sql");
      await fs.mkdir(join(tempDir, "migrations"), { recursive: true });
      await fs.writeFile(migrationPath, "-- migration");

      const adapterChecks: DeterministicCheck[] = [
        {
          name: "migration-exists",
          criterionMatch: "migration",
          type: "file_exists",
          pattern: "migrations/001_init.sql",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks, tempDir);

      const migrationCheck = results.find((r) => r.description.includes("migration-exists"));
      expect(migrationCheck).toBeDefined();
      expect(migrationCheck?.found).toBe(true);
    });

    test("should flag when file doesn't exist", async () => {
      const task = makeTask(["Creates config file"]);
      const diff = "";

      const adapterChecks: DeterministicCheck[] = [
        {
          name: "config-exists",
          criterionMatch: "config",
          type: "file_exists",
          pattern: "config/app.json",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks, tempDir);

      const configCheck = results.find((r) => r.description.includes("config-exists"));
      expect(configCheck).toBeDefined();
      expect(configCheck?.found).toBe(false);
    });
  });

  describe("file_not_exists type", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "spec-compliance-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    test("should pass when file correctly absent", async () => {
      const task = makeTask(["Removes deprecated config"]);
      const diff = "";

      const adapterChecks: DeterministicCheck[] = [
        {
          name: "deprecated-removed",
          criterionMatch: "removes deprecated",
          type: "file_not_exists",
          pattern: "old-config.json",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks, tempDir);

      const removalCheck = results.find((r) => r.description.includes("deprecated-removed"));
      expect(removalCheck).toBeDefined();
      expect(removalCheck?.found).toBe(true);
    });

    test("should flag when file exists but shouldn't", async () => {
      const task = makeTask(["Removes old cache file"]);
      const diff = "";

      // Create the file that should have been deleted
      await fs.writeFile(join(tempDir, "cache.dat"), "old cache");

      const adapterChecks: DeterministicCheck[] = [
        {
          name: "cache-removed",
          criterionMatch: "removes",
          type: "file_not_exists",
          pattern: "cache.dat",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks, tempDir);

      const cacheCheck = results.find((r) => r.description.includes("cache-removed"));
      expect(cacheCheck).toBeDefined();
      expect(cacheCheck?.found).toBe(false);
    });
  });

  describe("criterion matching", () => {
    test("should match criterion case-insensitively", async () => {
      const task = makeTask(["ENFORCES TENANT ISOLATION"]);
      const diff = `
diff --git a/src/db.ts b/src/db.ts
+where: { tenant_id: currentTenant }
`;
      const adapterChecks: DeterministicCheck[] = [
        {
          name: "tenant-check",
          criterionMatch: "tenant isolation",
          type: "grep",
          pattern: "tenant_id",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

      expect(results.length).toBeGreaterThan(0);
      const tenantCheck = results.find((r) => r.description.includes("tenant-check"));
      expect(tenantCheck).toBeDefined();
    });

    test("should not match if criterion doesn't contain match string", async () => {
      const task = makeTask(["Adds new endpoint"]);
      const diff = `
diff --git a/src/api.ts b/src/api.ts
+app.get("/endpoint", handler);
`;
      const adapterChecks: DeterministicCheck[] = [
        {
          name: "security-check",
          criterionMatch: "authentication",
          type: "grep",
          pattern: "auth",
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

      const securityCheck = results.find((r) => r.description.includes("security-check"));
      expect(securityCheck).toBeUndefined();
    });
  });
});

// ─── Blueprint Conversion Tests ──────────────────────────────────────

describe("blueprintToChecks", () => {
  test("should convert verification patterns to deterministic checks", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Validates email format",
        checkType: "grep",
        pattern: "validateEmail",
        fileGlob: "src/**/*.ts",
      },
      {
        criterion: "Creates migration file",
        checkType: "file_exists",
        pattern: "migrations/001_init.sql",
        fileGlob: "",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(2);
    expect(checks[0].type).toBe("grep");
    expect(checks[0].pattern).toBe("validateEmail");
    expect(checks[0].glob).toBe("src/**/*.ts");
    expect(checks[0].severity).toBe("flag");
    expect(checks[0].criterionMatch).toBe("Validates email format");

    expect(checks[1].type).toBe("file_exists");
    expect(checks[1].pattern).toBe("migrations/001_init.sql");
  });

  test("should preserve grep_count thresholds", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Has at least 3 test cases",
        checkType: "grep_count",
        pattern: "test\\(",
        fileGlob: "tests/**/*.test.ts",
        expectedMatches: 3,
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0].type).toBe("grep_count");
    expect(checks[0].pattern).toBe("test\\(");
    expect(checks[0].expectedMatches).toBe(3);
  });

  test("should convert file_not_exists check type", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Removes deprecated config file",
        checkType: "file_not_exists",
        pattern: "config/deprecated.json",
        fileGlob: "",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0].type).toBe("file_not_exists");
    expect(checks[0].pattern).toBe("config/deprecated.json");
    expect(checks[0].name).toContain("blueprint-0");
    expect(checks[0].criterionMatch).toBe("Removes deprecated config file");
  });

  test("should handle empty array", () => {
    const checks = blueprintToChecks([]);
    expect(checks).toEqual([]);
  });
});

// ─── Integration Tests ─────────────────────────────────────────────

describe("spec-compliance: integration", () => {
  test("should enforce exact-zero grep_count checks against full changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "quack-grep-count-"));
    try {
      await fs.mkdir(join(root, "src"), { recursive: true });
      await fs.writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
      await fs.writeFile(join(root, "src", "unsafe.ts"), "export const value = Math.random();\n");
      const task = makeTask(["Gameplay modules no longer call Math.random() directly."]);
      const checks: DeterministicCheck[] = [
        {
          name: "no-random",
          criterionMatch: "no longer call Math.random",
          type: "grep_count",
          pattern: "Math\\.random",
          glob: "src/*.ts",
          expectedMatches: 0,
          severity: "flag",
        },
      ];

      const passing = await runSpecComplianceChecks(task, "", ["src/safe.ts"], checks, root);
      expect(passing.find((result) => result.patternMatched === "no-random")?.found).toBe(true);

      const failing = await runSpecComplianceChecks(task, "", ["src/unsafe.ts"], checks, root);
      expect(failing.find((result) => result.patternMatched === "no-random")?.found).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("should enforce positive grep_count minimums against full changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "quack-grep-count-min-"));
    try {
      await fs.mkdir(join(root, "tests"), { recursive: true });
      await fs.writeFile(
        join(root, "tests", "example.test.ts"),
        "test('one', () => {});\ntest('two', () => {});\n",
      );
      const task = makeTask(["Has at least 2 tests"]);
      const checks: DeterministicCheck[] = [
        {
          name: "two-tests",
          criterionMatch: "at least 2 tests",
          type: "grep_count",
          pattern: "test\\(",
          glob: "tests/**/*.test.ts",
          expectedMatches: 2,
          severity: "flag",
        },
      ];

      const results = await runSpecComplianceChecks(
        task,
        "",
        ["tests/example.test.ts"],
        checks,
        root,
      );
      expect(results.find((result) => result.patternMatched === "two-tests")?.found).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("should combine built-in and adapter checks", async () => {
    const task = makeTask(["Enforces max 5 items", "Uses AppError for all errors"]);
    const diff = `
diff --git a/src/items.ts b/src/items.ts
+return items.slice(0, 5);
diff --git a/src/errors.ts b/src/errors.ts
+throw new AppError("Not found", 404);
`;
    const adapterChecks: DeterministicCheck[] = [
      {
        name: "app-error-check",
        criterionMatch: "AppError",
        type: "grep",
        pattern: "AppError",
        severity: "flag",
      },
    ];

    const results = await runSpecComplianceChecks(task, diff, [], adapterChecks);

    // Should have results from both built-in (limit enforcement) and adapter (AppError)
    expect(results.length).toBeGreaterThanOrEqual(2);

    const limitCheck = results.find((r) => r.criterion.includes("max 5"));
    const errorCheck = results.find((r) => r.description.includes("app-error-check"));

    expect(limitCheck?.found).toBe(true);
    expect(errorCheck?.found).toBe(true);
  });

  test("should handle multiple criteria matching same pattern", async () => {
    const task = makeTask(["Validates email format", "Validates phone number"]);
    const diff = `
diff --git a/src/validators.ts b/src/validators.ts
+if (!emailRegex.test(email)) throw new Error("Invalid email");
+if (!phoneRegex.test(phone)) throw new Error("Invalid phone");
`;

    const results = await runSpecComplianceChecks(task, diff, []);

    // Both criteria should trigger validation pattern
    expect(results).toHaveLength(2);
    expect(results[0]?.found).toBe(true);
    expect(results[1]?.found).toBe(true);
  });

  test("should return empty array when no criteria trigger patterns", async () => {
    const task = makeTask(["Adds documentation", "Updates README"]);
    const diff = `
diff --git a/docs/guide.md b/docs/guide.md
+# User Guide
+This is a guide.
`;

    const results = await runSpecComplianceChecks(task, diff, []);

    expect(results).toEqual([]);
  });
});

// ─── Blueprint Conversion Tests (TASK-044) ────────────────────────

describe("blueprintToChecks", () => {
  test("should convert grep pattern correctly", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Export function validateEmail",
        checkType: "grep",
        pattern: "export function validateEmail",
        fileGlob: "src/validators.ts",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toContain("blueprint-0");
    expect(checks[0]?.name).toContain("Export function validateEmail");
    expect(checks[0]?.criterionMatch).toBe("Export function validateEmail");
    expect(checks[0]?.type).toBe("grep");
    expect(checks[0]?.pattern).toBe("export function validateEmail");
    expect(checks[0]?.glob).toBe("src/validators.ts");
    expect(checks[0]?.severity).toBe("flag");
  });

  test("should preserve grep_count type and expected count", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "At least 3 test cases",
        checkType: "grep_count",
        pattern: 'test\\("',
        fileGlob: "tests/**/*.test.ts",
        expectedMatches: 3,
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.type).toBe("grep_count");
    expect(checks[0]?.pattern).toBe('test\\("');
    expect(checks[0]?.expectedMatches).toBe(3);
  });

  test("should convert file_exists pattern correctly", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Test file exists",
        checkType: "file_exists",
        pattern: "tests/validators.test.ts",
        fileGlob: "",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.type).toBe("file_exists");
    expect(checks[0]?.pattern).toBe("tests/validators.test.ts");
  });

  test("should convert file_not_exists pattern correctly", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "No legacy file remains",
        checkType: "file_not_exists",
        pattern: "src/legacy/old-validator.ts",
        fileGlob: "",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.type).toBe("file_not_exists");
    expect(checks[0]?.pattern).toBe("src/legacy/old-validator.ts");
  });

  test("should handle empty input array", () => {
    const patterns: VerificationPattern[] = [];
    const checks = blueprintToChecks(patterns);
    expect(checks).toEqual([]);
  });

  test("should convert multiple patterns with sequential indices", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "First criterion",
        checkType: "grep",
        pattern: "pattern1",
        fileGlob: "*.ts",
      },
      {
        criterion: "Second criterion",
        checkType: "file_exists",
        pattern: "file.ts",
        fileGlob: "",
      },
      {
        criterion:
          "Third criterion with a very long name that exceeds sixty characters and should be truncated",
        checkType: "grep_count",
        pattern: "pattern3",
        fileGlob: "**/*.ts",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks).toHaveLength(3);
    expect(checks[0]?.name).toContain("blueprint-0");
    expect(checks[1]?.name).toContain("blueprint-1");
    expect(checks[2]?.name).toContain("blueprint-2");
    // Check that long criterion is truncated to 60 chars in name
    expect(checks[2]?.name.length).toBeLessThanOrEqual("blueprint-2: ".length + 60);
  });

  test("should set all checks to flag severity", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Criterion 1",
        checkType: "grep",
        pattern: "p1",
        fileGlob: "*.ts",
      },
      {
        criterion: "Criterion 2",
        checkType: "file_exists",
        pattern: "file.ts",
        fileGlob: "",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks.every((c) => c.severity === "flag")).toBe(true);
  });

  test("should use criterion as criterionMatch", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Exact criterion text for matching",
        checkType: "grep",
        pattern: "some pattern",
        fileGlob: "*.ts",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks[0]?.criterionMatch).toBe("Exact criterion text for matching");
  });

  test("should pass fileGlob as glob field", () => {
    const patterns: VerificationPattern[] = [
      {
        criterion: "Test criterion",
        checkType: "grep",
        pattern: "test",
        fileGlob: "src/**/*.test.ts",
      },
    ];

    const checks = blueprintToChecks(patterns);

    expect(checks[0]?.glob).toBe("src/**/*.test.ts");
  });
});
