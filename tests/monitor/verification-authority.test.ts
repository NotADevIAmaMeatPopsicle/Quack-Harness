import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB, NoopDB } from "../../src/db";
import {
  findDbJsonDrift,
  recordVerification,
  reconcileVerifiedDrift,
  regenerateProjection,
  type VerificationEntry,
} from "../../src/monitor/verification-store";

const positive: VerificationEntry = {
  taskId: "TASK-100",
  verdict: "VERIFIED",
  commitSha: "abc1234",
  method: "api",
  criteriaChecked: 2,
  criteriaPassed: 2,
  verifiedAt: "2026-05-02",
  updatedAt: "2026-05-02T12:00:00.000Z",
};
function ledgerEntry(commit = "abc1234") {
  return {
    verified: "2026-05-02",
    commit,
    method: "api",
    verdict: "VERIFIED",
    criteriaChecked: 2,
    criteriaPassed: 2,
    notes: null,
  };
}

describe("QPI-013 verification source authority", () => {
  let root: string;
  let jsonPath: string;
  let db: QuackDB;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-verification-authority-"));
    fs.mkdirSync(path.join(root, ".quack"));
    jsonPath = path.join(root, ".quack", "verified.json");
    db = new QuackDB(path.join(root, ".quack", "quack.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const read = (file: string): { tasks: Record<string, unknown> } =>
    JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown> };

  test("only a genuinely missing projection starts an empty ledger", async () => {
    expect(db.getHealth()).toEqual({ mode: "sqlite", available: true });
    expect(fs.existsSync(jsonPath)).toBe(false);
    const result = await recordVerification({ projectRoot: root, db }, positive);
    expect(result.applied).toBe(true);
    expect(read(jsonPath).tasks[positive.taskId]).toMatchObject(ledgerEntry());
    expect(db.getVerifiedHistory(positive.taskId)).toHaveLength(1);
  });

  test.each(["{broken", "[]", "null", "{}", '{"tasks":[]}', '{"tasks":null}'])(
    "preserves malformed projection bytes and canonical state: %s",
    async (bytes) => {
      await recordVerification({ projectRoot: root, db }, positive);
      const row = db.getVerified(positive.taskId);
      const history = db.getVerifiedHistory(positive.taskId);
      const status = db.getAllStatuses();
      fs.writeFileSync(jsonPath, bytes);
      const p = { projectRoot: root, db };
      await expect(recordVerification(p, { ...positive, taskId: "TASK-200" })).rejects.toThrow(
        /projection/i,
      );
      await expect(regenerateProjection(p)).rejects.toThrow(/projection/i);
      await expect(reconcileVerifiedDrift(p)).rejects.toThrow(/projection/i);
      await expect(findDbJsonDrift(p)).rejects.toThrow(/projection/i);
      expect(fs.readFileSync(jsonPath, "utf8")).toBe(bytes);
      expect(db.getVerified(positive.taskId)).toEqual(row);
      expect(db.getVerified("TASK-200")).toBeUndefined();
      expect(db.getVerifiedHistory(positive.taskId)).toEqual(history);
      expect(db.getAllStatuses()).toEqual(status);
    },
  );

  test("does not treat a real filesystem read failure as ENOENT", async () => {
    fs.mkdirSync(jsonPath);
    fs.writeFileSync(path.join(jsonPath, "preserve.txt"), "unreadable projection path");
    const p = { projectRoot: root, db };
    await expect(recordVerification(p, positive)).rejects.toThrow();
    await expect(regenerateProjection(p)).rejects.toThrow();
    expect(db.getAllVerified().size).toBe(0);
    expect(fs.readFileSync(path.join(jsonPath, "preserve.txt"), "utf8")).toBe(
      "unreadable projection path",
    );
  });

  test.each(["existing", "missing"])(
    "refuses NoopDB authority with %s projection",
    async (state) => {
      const bytes = JSON.stringify({ tasks: { "TASK-200": ledgerEntry() } });
      if (state === "existing") fs.writeFileSync(jsonPath, bytes);
      const p = { projectRoot: root, db: new NoopDB() };
      expect(p.db.getHealth()).toMatchObject({ mode: "noop", available: false });
      await expect(recordVerification(p, positive)).rejects.toThrow(/database is unavailable/);
      await expect(regenerateProjection(p)).rejects.toThrow(/database is unavailable/);
      await expect(reconcileVerifiedDrift(p)).rejects.toThrow(/database is unavailable/);
      await expect(findDbJsonDrift(p)).rejects.toThrow(/database is unavailable/);
      expect(fs.existsSync(jsonPath)).toBe(state === "existing");
      if (state === "existing") expect(fs.readFileSync(jsonPath, "utf8")).toBe(bytes);
      expect(fs.existsSync(`${jsonPath}.lock`)).toBe(false);
    },
  );

  test.each(["closed", "missing verified table"])(
    "refuses a real unavailable DB: %s",
    async (condition) => {
      const bytes = JSON.stringify({ tasks: { "TASK-200": ledgerEntry() } });
      fs.writeFileSync(jsonPath, bytes);
      if (condition === "closed") db.close();
      else {
        // An actual SQLite table-read failure, not a mocked empty map.
        const connection = db.raw() as { exec(sql: string): void };
        connection.exec("DROP TABLE verified");
      }
      expect(db.getHealth()).toMatchObject({ mode: "sqlite", available: false });
      const p = { projectRoot: root, db };
      await expect(regenerateProjection(p)).rejects.toThrow(/database is unavailable/);
      await expect(recordVerification(p, positive)).rejects.toThrow(/database is unavailable/);
      expect(fs.readFileSync(jsonPath, "utf8")).toBe(bytes);
    },
  );

  test("regeneration keeps JSON-only and malformed entries, while DB wins for shared IDs", async () => {
    await recordVerification({ projectRoot: root, db }, positive);
    const original = {
      _description: "retained history",
      extraHeader: "retain this too",
      tasks: {
        "TASK-300": null,
        "TASK-200": ledgerEntry("def5678"),
        "TASK-100": ledgerEntry("aaaaaaa"),
      },
    };
    fs.writeFileSync(jsonPath, JSON.stringify(original));
    expect(await regenerateProjection({ projectRoot: root, db })).toEqual({ entryCount: 3 });
    const result = read(jsonPath);
    expect(result).toMatchObject({
      _description: original._description,
      extraHeader: original.extraHeader,
    });
    expect(Object.keys(result.tasks)).toEqual(["TASK-100", "TASK-200", "TASK-300"]);
    expect(result.tasks["TASK-100"]).toMatchObject(ledgerEntry());
    expect(result.tasks["TASK-200"]).toEqual(original.tasks["TASK-200"]);
    expect(result.tasks["TASK-300"]).toBeNull();
    const once = fs.readFileSync(jsonPath, "utf8");
    await regenerateProjection({ projectRoot: root, db });
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(once);
  });

  test("a skipped claimant promotion survives subsequent startup regeneration", async () => {
    const tasks = { "TASK-100": ledgerEntry(), "TASK-200": { ...ledgerEntry(), commit: "probe" } };
    fs.writeFileSync(jsonPath, JSON.stringify({ tasks }));
    const p = { projectRoot: root, db };
    const result = await reconcileVerifiedDrift(p, {
      claimantIndex: { status: "unavailable", reason: "task directory unavailable" },
    });
    expect(result.promotionsSkipped).toContain("TASK-100");
    expect(db.getAllVerified().size).toBe(0);
    await regenerateProjection(p);
    expect(read(jsonPath).tasks).toEqual(tasks);
  });

  test("a real partial reconciliation failure retains the remaining evidence on regeneration", async () => {
    const tasks = {
      "TASK-100": ledgerEntry(),
      "TASK-200": ledgerEntry("def5678"),
      "TASK-300": ledgerEntry("cafe123"),
    };
    fs.writeFileSync(jsonPath, JSON.stringify({ tasks }));
    const connection = db.raw() as { exec(sql: string): void };
    connection.exec(
      "CREATE TRIGGER reject_second_verified BEFORE INSERT ON verified WHEN NEW.task_id = 'TASK-200' BEGIN SELECT RAISE(ABORT, 'injected durable database refusal'); END",
    );
    const p = { projectRoot: root, db };
    let refusal: unknown;
    try {
      await reconcileVerifiedDrift(p);
    } catch (error: unknown) {
      refusal = error;
    }
    // Native SQLite errors can originate in another Jest worker realm. The
    // owner fence retains that original error as cause when it wraps it.
    const originalRefusal =
      refusal && typeof refusal === "object" && "cause" in refusal ? refusal.cause : refusal;
    expect(String(originalRefusal)).toContain("injected durable database refusal");
    expect(db.getVerified("TASK-100")).toBeDefined();
    expect(db.getVerified("TASK-200")).toBeUndefined();
    await regenerateProjection(p);
    expect(Object.keys(read(jsonPath).tasks)).toEqual(Object.keys(tasks));
    expect(read(jsonPath).tasks["TASK-200"]).toEqual(tasks["TASK-200"]);
    expect(read(jsonPath).tasks["TASK-300"]).toEqual(tasks["TASK-300"]);
    connection.exec("DROP TRIGGER reject_second_verified");
    await reconcileVerifiedDrift(p);
    expect(db.getAllVerified().size).toBe(3);
  });

  test("skips a missing historical date and still imports later valid normalized evidence", async () => {
    const missingDate: Record<string, unknown> = { ...ledgerEntry() };
    delete missingDate.verified;
    const tasks = {
      "TASK-100": missingDate,
      "TASK-200": { ...ledgerEntry(" def5678 "), method: " api " },
    };
    const before = JSON.stringify({ tasks });
    fs.writeFileSync(jsonPath, before);
    const p = { projectRoot: root, db };
    const result = await reconcileVerifiedDrift(p);
    expect(result.jsonToDb).toEqual(["TASK-200"]);
    expect(db.getVerified("TASK-100")).toBeUndefined();
    expect(db.getVerified("TASK-200")).toMatchObject({
      verified_at: "2026-05-02",
      method: "api",
      commit_sha: "def5678",
    });
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(before);
    await regenerateProjection(p);
    expect(read(jsonPath).tasks["TASK-100"]).toEqual(missingDate);
    expect(read(jsonPath).tasks["TASK-200"]).toMatchObject({
      verified: "2026-05-02",
      method: "api",
      commit: "def5678",
    });
  });
});

describe("QPI-025 canonical verification write validation", () => {
  test.each<[string, Record<string, unknown>]>([
    ["unknown verdict", { verdict: "PROBE" }],
    ["probe commit", { commitSha: "probe" }],
    ["single character commit", { commitSha: "x" }],
    ["missing positive commit", { commitSha: undefined }],
    ["wrong method type", { method: 3 }],
    ["fractional counts", { criteriaChecked: 1.5 }],
    ["passed exceeds checked", { criteriaChecked: 1 }],
    ["negative count", { criteriaPassed: -1 }],
    ["invalid calendar date", { verifiedAt: "2026-02-30" }],
    ["invalid cursor", { updatedAt: "tomorrow" }],
    ["future cursor", { updatedAt: "2999-01-01T00:00:00.000Z" }],
    ["review path traversal", { reviewId: "../outside" }],
    ["unknown field", { probe: true }],
  ])("rejects %s before any row/history/status/projection mutation", async (_label, override) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-verified-schema-"));
    fs.mkdirSync(path.join(root, ".quack"));
    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    const p = { projectRoot: root, db };
    try {
      await recordVerification(p, positive);
      const jsonPath = path.join(root, ".quack", "verified.json");
      const before = fs.readFileSync(jsonPath, "utf8");
      const row = db.getVerified(positive.taskId);
      const history = db.getVerifiedHistory(positive.taskId);
      const status = db.getAllStatuses();
      await expect(
        recordVerification(p, { ...positive, ...override } as VerificationEntry),
      ).rejects.toThrow();
      expect(db.getVerified(positive.taskId)).toEqual(row);
      expect(db.getVerifiedHistory(positive.taskId)).toEqual(history);
      expect(db.getAllStatuses()).toEqual(status);
      expect(fs.readFileSync(jsonPath, "utf8")).toBe(before);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
