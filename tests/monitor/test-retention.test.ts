import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneTestArtifacts } from "../../src/monitor/routes/test-results";

function makeTempResultsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-retention-"));
  const dir = path.join(root, ".quack", "test-results");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(dir: string, name: string, daysAgo: number): void {
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, JSON.stringify({ timestamp: new Date().toISOString() }), "utf-8");
  const past = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  fs.utimesSync(fullPath, new Date(past), new Date(past));
}

describe("test artifact retention", () => {
  let resultsDir: string;
  let rootDir: string;

  beforeEach(() => {
    resultsDir = makeTempResultsDir();
    rootDir = path.resolve(resultsDir, "..", "..");
  });

  afterEach(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("removes result artifacts beyond maxResults", () => {
    writeArtifact(resultsDir, "TASK-001-result.json", 1);
    writeArtifact(resultsDir, "TASK-002-result.json", 2);
    writeArtifact(resultsDir, "TASK-003-result.json", 3);

    const pruned = pruneTestArtifacts(resultsDir, {
      maxResults: 2,
      maxAgeDays: 30,
      keepBaselines: true,
    });

    expect(pruned.removedResults).toBe(1);
    const remaining = fs.readdirSync(resultsDir).filter((file) => file.endsWith("-result.json"));
    expect(remaining).toHaveLength(2);
  });

  test("removes artifacts older than maxAgeDays", () => {
    writeArtifact(resultsDir, "TASK-001-result.json", 31);
    writeArtifact(resultsDir, "TASK-002-result.json", 5);

    const pruned = pruneTestArtifacts(resultsDir, {
      maxResults: 50,
      maxAgeDays: 30,
      keepBaselines: true,
    });

    expect(pruned.removedResults).toBe(1);
    expect(fs.existsSync(path.join(resultsDir, "TASK-001-result.json"))).toBe(false);
    expect(fs.existsSync(path.join(resultsDir, "TASK-002-result.json"))).toBe(true);
  });

  test("preserves baselines when keepBaselines is true", () => {
    writeArtifact(resultsDir, "TASK-001-result.json", 31);
    writeArtifact(resultsDir, "TASK-001-baseline.json", 31);

    const pruned = pruneTestArtifacts(resultsDir, {
      maxResults: 1,
      maxAgeDays: 30,
      keepBaselines: true,
    });

    expect(pruned.removedResults).toBe(1);
    expect(pruned.removedBaselines).toBe(0);
    expect(fs.existsSync(path.join(resultsDir, "TASK-001-baseline.json"))).toBe(true);
  });

  test("prunes baselines when keepBaselines is false", () => {
    writeArtifact(resultsDir, "TASK-001-result.json", 40);
    writeArtifact(resultsDir, "TASK-001-baseline.json", 40);
    writeArtifact(resultsDir, "TASK-002-result.json", 1);
    writeArtifact(resultsDir, "TASK-002-baseline.json", 1);

    const pruned = pruneTestArtifacts(resultsDir, {
      maxResults: 1,
      maxAgeDays: 30,
      keepBaselines: false,
    });

    expect(pruned.removedResults).toBe(1);
    expect(pruned.removedBaselines).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(resultsDir, "TASK-001-baseline.json"))).toBe(false);
  });
});
