// ─── TASK-1334: a parent id must never select its subtask's file ─────
//
// The defect: a dozen sites picked a task's spec with
// `readdir().find(f => f.startsWith(taskId))`, so `TASK-100` selected
// `TASK-100-A-child.md` whenever that sorted first. Some of those sites then
// WROTE to what they selected. The worst commits the result under the parent's
// id and pushes it to the target branch.
//
// Two deliberate choices about how this is tested, both from the step-1
// review's critique of the original plan:
//
//  1. FIXTURES, NOT THE REAL CORPUS. The live count (12 here, 81 in example)
//     depends on `readdir` order, which is undefined. A test asserting a count
//     would encode an invariant that does not exist and would break on a
//     different filesystem for the wrong reason.
//  2. BOTH DIRECTORY ORDERS. Creating the child first happens to reproduce the
//     bug on NTFS, but that is luck. Each case runs with both creation orders
//     so neither result depends on which one the filesystem happens to yield.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  classifyDeclaredId,
  resolveParsedTaskFile,
  resolveParsedTaskFileSync,
  resolveParsedTaskFileSyncPath,
  resolveTaskFile,
  resolveTaskFilePath,
} from "../../src/core/task-file-resolver.js";
import { matchTaskHeading } from "../../src/core/task-parser.js";

function spec(id: string, body = `${id} body`): string {
  return [
    `# ${id}: fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** READY`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    "",
    body,
    "",
    "## Success Criteria",
    "- [ ] It resolves",
    "",
    "## Testing Requirements",
    "- [ ] None (fixture)",
    "",
  ].join("\n");
}

/** Run `fn` against a fresh task dir, once per creation order. */
function inBothOrders(
  files: Array<[name: string, content: string]>,
  fn: (taskDir: string, order: string) => Promise<void> | void,
): Array<() => Promise<void>> {
  const orders: Array<[string, typeof files]> = [
    ["child-first", files],
    ["parent-first", [...files].reverse()],
  ];
  return orders.map(([label, ordered]) => async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1334-"));
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    try {
      for (const [name, content] of ordered) {
        fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
      }
      await fn(taskDir, label);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

type DuplicateAwareBundle = {
  fileName: string;
  duplicateClaimants?: string[];
} | null;

type PublicBundleAccessor = (taskDir: string, taskId: string) => Promise<DuplicateAwareBundle>;

const publicBundleAccessors: Array<[name: string, accessor: PublicBundleAccessor]> = [
  [
    "resolveTaskFile",
    async (taskDir, taskId) => (await resolveTaskFile(taskDir, taskId)) as DuplicateAwareBundle,
  ],
  [
    "resolveParsedTaskFile",
    async (taskDir, taskId) =>
      (await resolveParsedTaskFile(taskDir, taskId)) as DuplicateAwareBundle,
  ],
  [
    "resolveParsedTaskFileSync",
    (taskDir, taskId) =>
      Promise.resolve(resolveParsedTaskFileSync(taskDir, taskId) as DuplicateAwareBundle),
  ],
];

async function withTaskFiles(
  files: Array<[name: string, content: string]>,
  fn: (taskDir: string) => Promise<void> | void,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338-a-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  try {
    for (const [name, content] of files) {
      fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
    }
    await fn(taskDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("TASK-1334: canonical selection never returns a subtask for its parent", () => {
  const files: Array<[string, string]> = [
    ["TASK-100-A-child.md", spec("TASK-100-A")],
    ["TASK-100-parent.md", spec("TASK-100", "the parent contract")],
  ];

  const cases = inBothOrders(files, async (taskDir, order) => {
    // The naive selector these sites used, kept as the CONTROL. If this ever
    // stops picking the child, the fixture no longer reproduces the defect and
    // the assertions below would pass for the wrong reason.
    const naive = fs
      .readdirSync(taskDir)
      .find((f) => f.startsWith("TASK-100") && f.endsWith(".md"));
    expect(naive).toBeDefined();

    const resolved = await resolveTaskFile(taskDir, "TASK-100");
    expect(resolved?.fileName).toBe("TASK-100-parent.md");
    expect(resolved?.task?.id).toBe("TASK-100");
    // And the path accessor agrees with the bundle, which is the property the
    // read-then-write sites depend on.
    expect(await resolveTaskFilePath(taskDir, "TASK-100")).toBe(resolved?.filePath);

    if (order === "child-first") {
      // On this order the naive selector demonstrably picks the wrong file,
      // so the fixture is proven to reproduce the original defect.
      expect(naive).toBe("TASK-100-A-child.md");
    }
  });

  it.each([
    ["child-first", cases[0]],
    ["parent-first", cases[1]],
  ])("resolves the parent when files are created %s", async (_label, run) => {
    await run();
  });

  it("still resolves the subtask for its OWN id", async () => {
    await inBothOrders(files, async (taskDir) => {
      const child = await resolveTaskFile(taskDir, "TASK-100-A");
      expect(child?.fileName).toBe("TASK-100-A-child.md");
    })[0]();
  });
});

describe("TASK-1339-A: sync parsed bundle accessor", () => {
  const files: Array<[string, string]> = [
    ["TASK-100-A-child.md", spec("TASK-100-A")],
    ["TASK-100-parent.md", spec("TASK-100", "the parent contract")],
  ];
  const cases = inBothOrders(files, async (taskDir) => {
    const asyncResolved = await resolveParsedTaskFile(taskDir, "TASK-100");
    const syncResolved = resolveParsedTaskFileSync(taskDir, "TASK-100");

    expect(syncResolved).toEqual(asyncResolved);
    expect(syncResolved?.fileName).toBe("TASK-100-parent.md");
    expect(syncResolved?.content).toBe(spec("TASK-100", "the parent contract"));
    expect(syncResolved?.task?.id).toBe("TASK-100");
    expect(resolveParsedTaskFileSyncPath(taskDir, "TASK-100")).toEqual({
      fileName: syncResolved?.fileName,
      filePath: syncResolved?.filePath,
    });
  });

  it.each([
    ["child-first", cases[0]],
    ["parent-first", cases[1]],
  ])("returns the parsed bundle when files are created %s", async (_label, run) => {
    await run();
  });

  it.each([
    ["foreign parsed candidate", [["TASK-100-A-child.md", spec("TASK-100-A")]]],
    ["unparseable parent candidate", [["TASK-100-parent.md", "not a task spec\n"]]],
  ] as Array<[string, Array<[string, string]>]>)(
    "matches the async parsed-first result for a %s",
    async (_label, candidateFiles) => {
      await inBothOrders(candidateFiles, async (taskDir) => {
        expect(resolveParsedTaskFileSync(taskDir, "TASK-100")).toEqual(
          await resolveParsedTaskFile(taskDir, "TASK-100"),
        );
        expect(resolveParsedTaskFileSyncPath(taskDir, "TASK-100")).toBeNull();
      })[0]();
    },
  );
});

describe("TASK-1338-A: public resolver bundles surface candidate-scoped duplicates", () => {
  const duplicateFiles: Array<[string, string]> = [
    ["TASK-100-a.md", spec("TASK-100", "first claimant")],
    ["TASK-100-b.md", spec("TASK-100", "second claimant")],
  ];
  const creationOrders: Array<[label: string, files: Array<[string, string]>]> = [
    ["a-first", duplicateFiles],
    ["b-first", [...duplicateFiles].reverse()],
  ];

  const duplicateCases = publicBundleAccessors.flatMap(([accessorName, accessor]) =>
    creationOrders.map(([order, files]) => [accessorName, order, files, accessor] as const),
  );

  it.each(duplicateCases)(
    "CONTROL: %s keeps the first sorted match when claimants are created %s",
    async (_accessorName, _order, files, accessor) => {
      await withTaskFiles(files, async (taskDir) => {
        const resolved = await accessor(taskDir, "TASK-100");
        expect(resolved?.fileName).toBe("TASK-100-a.md");
      });
    },
  );

  it.each(duplicateCases)(
    "RED: %s reports both sorted claimants when they are created %s",
    async (_accessorName, _order, files, accessor) => {
      await withTaskFiles(files, async (taskDir) => {
        const resolved = await accessor(taskDir, "TASK-100");
        expect(resolved?.duplicateClaimants).toEqual(["TASK-100-a.md", "TASK-100-b.md"]);
      });
    },
  );

  it.each(publicBundleAccessors)(
    "RED: %s reports an empty claimant field for one declaration",
    async (_accessorName, accessor) => {
      await withTaskFiles(
        [["TASK-100-only.md", spec("TASK-100", "only claimant")]],
        async (taskDir) => {
          const resolved = await accessor(taskDir, "TASK-100");
          expect(resolved?.duplicateClaimants).toEqual([]);
        },
      );
    },
  );
});

describe("TASK-1334: replacement identity is a separate guard from target identity", () => {
  // The step-1 review's sharpest point about the fix: resolving the target
  // path correctly does not stop content headed `# TASK-999` being written
  // into TASK-100's file. Both enrichment writes could do exactly that.
  it("flags content that declares a different task", () => {
    expect(classifyDeclaredId(spec("TASK-999"), "TASK-100")).toEqual({
      kind: "mismatch",
      declared: "TASK-999",
    });
  });

  it("passes content that declares the right task", () => {
    expect(classifyDeclaredId(spec("TASK-100"), "TASK-100")).toEqual({
      kind: "match",
      declared: "TASK-100",
    });
  });

  it("treats a subtask id as a different task, because it is one", () => {
    expect(classifyDeclaredId(spec("TASK-100-A"), "TASK-100")).toEqual({
      kind: "mismatch",
      declared: "TASK-100-A",
    });
  });

  it("refuses a lowercase heading, because the parser does", () => {
    // ROUND 2 (R2-2): this arm previously asserted a case-insensitive MATCH,
    // written on the recorded belief that `parseH1` is case-insensitive. It
    // is not: `# task-100: ...` THROWS in the parser, so a guard that
    // accepted it let approve persist a spec that instantly became a
    // parse-error file. The guard now consumes the parser's own
    // `matchTaskHeading`, and this arm pins the corrected direction.
    expect(classifyDeclaredId("# task-100: lowercase heading\n", "TASK-100")).toEqual({
      kind: "unrecognized",
    });
  });

  it.each([
    ["a separator with no title", "# TASK-100:"],
    ["trailing text with no separator", "# TASK-100 garbage"],
    ["the TASK- prefix with no id", "# TASK-: no id"],
  ])("refuses %s, because the parser throws on it", (_label, heading) => {
    // ROUND 2 (R2-2): each of these passed the old guard and would have been
    // persisted by approve as a file the parser then rejects.
    expect(classifyDeclaredId(`${heading}\n\nbody\n`, "TASK-100")).toEqual({
      kind: "unrecognized",
    });
  });

  it("tolerates the leading whitespace and BOM the parser tolerates", () => {
    expect(classifyDeclaredId("﻿  # TASK-100: bom and indent\n", "TASK-100").kind).toBe("match");
  });

  it("accepts the parser's bare-id form", () => {
    // `# TASK-100` with no separator and no title is a valid declaration in
    // `parseH1`, so the parser-equivalent guard must accept it too.
    expect(classifyDeclaredId("# TASK-100\n\nbody\n", "TASK-100")).toEqual({
      kind: "match",
      declared: "TASK-100",
    });
  });

  it("does not read a task id MENTIONED later in the heading as the declaration", () => {
    expect(classifyDeclaredId("# Follow-up to TASK-999: something\n", "TASK-100").kind).toBe(
      "unrecognized",
    );
  });

  it("reports UNRECOGNIZED, not silence, for content with no heading", () => {
    // The fail-open round 1 found. `/enrich/approve` accepts any non-empty
    // body and had no earlier H1 check, so collapsing "declares nothing" into
    // the same null as "declares this task" meant a headless body was written,
    // and could be committed and pushed. Round 2 retired the two-way wrapper
    // entirely; both routes now refuse this verdict.
    expect(classifyDeclaredId("no heading at all\n", "TASK-100").kind).toBe("unrecognized");
  });

  it("stays parser-equivalent at the shared rule", () => {
    // ROUND 2 (R2-2): the drift mechanism was two copies of the H1 rule.
    // There is now one, `matchTaskHeading`, and this arm pins that the guard
    // and the parser read the same headings the same way.
    expect(matchTaskHeading("task-100: lowercase")).toBeNull();
    expect(matchTaskHeading("TASK-100 garbage")).toBeNull();
    expect(matchTaskHeading("TASK-100:")).toBeNull();
    expect(matchTaskHeading("TASK-100: title")).toEqual({ id: "TASK-100", title: "title" });
    expect(matchTaskHeading("TASK-100")).toEqual({ id: "TASK-100", title: "" });
  });
});
