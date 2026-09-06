import * as fs from "node:fs/promises";
import * as path from "node:path";

import { RESOURCES } from "../../src/monitor/routes/agent-resources";

describe("project resources registry", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  it("points every registered resource at a real public file", async () => {
    const ids = new Set<string>();
    for (const resource of RESOURCES) {
      expect(ids.has(resource.id)).toBe(false);
      ids.add(resource.id);
      expect(resource.relativePath).not.toMatch(/^\.(?:agents|claude)[/\\]/);
      const absolute = path.join(repoRoot, resource.relativePath);
      const stats = await fs.stat(absolute);
      expect(stats.isFile()).toBe(true);
    }
  });

  it("includes the primary public documentation", () => {
    const paths = new Set(RESOURCES.map((resource) => resource.relativePath));
    expect(paths.has("README.md")).toBe(true);
    expect(paths.has("ARCHITECTURE.md")).toBe(true);
    expect(paths.has("SECURITY.md")).toBe(true);
    expect(paths.has("docs/GETTING-STARTED.md")).toBe(true);
  });
});
