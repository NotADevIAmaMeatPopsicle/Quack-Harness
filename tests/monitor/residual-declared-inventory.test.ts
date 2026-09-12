// TASK-1336-C: the real-file producer used by residual-reconcile-driver.mjs.
// Legacy H1 families and report-only class C are deliberate compatibility controls.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalIdFromSpecContent,
  loadResidualSpecInventory,
  runResidualReconcile,
  type ResidualReconcileDeps,
} from "../../src/monitor/residual-reconcile";
import { declaredTaskIdFromSpec } from "../../src/core/task-spec-declaration";

describe.each(["forward", "reverse"])("TASK-1336-C residual declared inventory (%s)", (order) => {
  it("reports declarations from partial specs and preserves both historical families", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336c-residual-"));
    const ids = ["TASK-1402-A", "SAURUS-REM-001", "TASK-BS-01", "TASK-SAURUS-REM-001"];
    const entries = ids.map((id, index) => [
      `TASK-${index + 1}-divergent.md`,
      `# ${id}: partial\n- **Status:** COMPLETE\n`,
    ]);
    entries.push(["TASK-9999-pretender.md", "- **Status:** COMPLETE\n"]);
    entries.push([
      "TASK-9998-second-heading.md",
      "# Not a task\n# TASK-9998: ignored\n- **Status:** VERIFIED\n",
    ]);
    entries.push(["TASK-9997-ready.md", "# TASK-600: partial ready\n- **Status:** READY\n"]);
    try {
      for (const [name, content] of order === "forward" ? entries : [...entries].reverse())
        fs.writeFileSync(path.join(root, name), content);
      const inventory = loadResidualSpecInventory(root);
      expect(inventory.doneIds).toEqual([...ids].sort());
      expect([...inventory.taskIds].sort()).toEqual([...ids, "TASK-600"].sort());
      const record = jest.fn<
        ReturnType<ResidualReconcileDeps["record"]>,
        Parameters<ResidualReconcileDeps["record"]>
      >(() => Promise.resolve({ applied: true }));
      const result = await runResidualReconcile(
        {
          ledgerIds: () => new Set(),
          readBundles: () => [],
          statuses: () => [],
          specDoneIds: () => inventory.doneIds,
          taskExists: (id) => inventory.taskIds.has(id),
          record,
          log() {},
        },
        { apply: true },
      );
      expect(result.candidates.map((item) => item.taskId).sort()).toEqual([...ids].sort());
      expect(
        result.candidates.every((item) => item.class === "C" && item.disposition === "report-only"),
      ).toBe(true);
      expect(record).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it("opts legacy IDs in only at partial-reconciliation boundaries and honors the first H1", () => {
  for (const id of ["TASK-BS-01", "TASK-SAURUS-REM-001"]) {
    const content = `\ufeff  # ${id}: retained\n`;
    expect(declaredTaskIdFromSpec(content)).toBeUndefined();
    expect(canonicalIdFromSpecContent(content)).toBe(id);
  }
  expect(canonicalIdFromSpecContent("# unknown\n# TASK-1402: later")).toBeUndefined();
  expect(canonicalIdFromSpecContent("no heading")).toBeUndefined();
  expect(canonicalIdFromSpecContent("# TASK-BS-01:")).toBeUndefined();
});
