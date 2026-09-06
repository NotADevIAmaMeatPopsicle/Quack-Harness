import {
  buildStrictDuplicateClaimantIndex,
  duplicateClaimantRefusalForIndex,
  type TaskClaimantDeclaration,
} from "../../src/core/duplicate-claimants";

const declarations: TaskClaimantDeclaration[] = [
  { fileName: "TASK-100-z.md", declaredId: " task-100 " },
  { fileName: "TASK-200-only.md", declaredId: "TASK-200" },
  { fileName: "TASK-999-a.md", declaredId: "TASK-100" },
];

describe("TASK-1338-F strict duplicate claimant index", () => {
  it("returns a normalized scanned index with sorted contested claimants", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() => Promise.resolve(declarations));

    expect(index.status).toBe("scanned");
    if (index.status !== "scanned") throw new Error("expected scanned index");
    expect([...index.contested]).toEqual([["TASK-100", ["TASK-100-z.md", "TASK-999-a.md"]]]);
  });

  it("returns a scanned empty index for a clean producer result", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() => Promise.resolve([declarations[1]]));
    expect(index).toEqual({ status: "scanned", contested: new Map() });
  });

  it("returns unavailable when no scan producer can be configured", async () => {
    await expect(buildStrictDuplicateClaimantIndex()).resolves.toEqual({
      status: "unavailable",
      reason: "TaskService is unavailable for duplicate claimant scan.",
    });
  });

  it("returns unavailable with the scan failure reason instead of throwing", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() =>
      Promise.reject(new Error("ENOENT: task directory missing")),
    );
    expect(index).toEqual({
      status: "unavailable",
      reason: "Duplicate claimant scan failed: ENOENT: task directory missing",
    });
  });

  it("distinguishes a configured producer scan failure from missing configuration", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() =>
      Promise.reject(new Error("access denied while enumerating claimant files")),
    );
    expect(index).toEqual({
      status: "unavailable",
      reason: "Duplicate claimant scan failed: access denied while enumerating claimant files",
    });
  });

  it("builds the shared singular refusal body for a contested id", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() => Promise.resolve(declarations));
    expect(duplicateClaimantRefusalForIndex(index, " task-100 ")).toEqual({
      error: "duplicate_claimants",
      taskId: "TASK-100",
      claimants: ["TASK-100-z.md", "TASK-999-a.md"],
      message:
        "Task TASK-100 has duplicate claimants: TASK-100-z.md, TASK-999-a.md. Refusing to write until the id has one owner.",
    });
  });

  it("extends the same singular refusal shape for unavailable scans", async () => {
    const index = await buildStrictDuplicateClaimantIndex();
    expect(duplicateClaimantRefusalForIndex(index, "task-100")).toEqual({
      error: "duplicate_claimants",
      taskId: "TASK-100",
      claimants: [],
      message:
        "Task TASK-100 duplicate claimant scan unavailable: TaskService is unavailable for duplicate claimant scan. Refusing admission until the scan succeeds.",
      retryable: true,
    });
  });

  it("returns no singular refusal for an uncontested scanned id", async () => {
    const index = await buildStrictDuplicateClaimantIndex(() => Promise.resolve(declarations));
    expect(duplicateClaimantRefusalForIndex(index, "TASK-200")).toBeUndefined();
  });
});
