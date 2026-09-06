import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { repairQuackDb } from "../../src/cli/repair-db";

describe("repairQuackDb", () => {
  let projectRoot: string;
  let dbPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-repair-db-"));
    fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
    dbPath = path.join(projectRoot, ".quack", "quack.db");
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("backs up corrupt DB artifacts before repair", () => {
    fs.writeFileSync(dbPath, "not-a-real-sqlite-db", "utf-8");
    fs.writeFileSync(`${dbPath}-wal`, "wal", "utf-8");
    fs.writeFileSync(`${dbPath}-shm`, "shm", "utf-8");

    const result = repairQuackDb({ project: projectRoot });

    expect(result.initialIntegrity.status).toBe("corrupt");
    expect(result.rebuilt).toBe(false);
    expect(result.finalIntegrity.status).toBe("corrupt");
    expect(result.backupDir).toBeDefined();
    expect(result.backedUpFiles.map((filePath) => path.basename(filePath)).sort()).toEqual([
      "quack.db",
      "quack.db-shm",
      "quack.db-wal",
    ]);
    expect(fs.existsSync(path.join(result.backupDir!, "quack.db"))).toBe(true);
  });

  it("rebuilds a corrupt DB into a healthy fresh schema", () => {
    fs.writeFileSync(dbPath, "totally-broken", "utf-8");

    const result = repairQuackDb({ project: projectRoot, rebuild: true });

    expect(result.initialIntegrity.status).toBe("corrupt");
    expect(result.rebuilt).toBe(true);
    expect(result.finalIntegrity.status).toBe("ok");
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
