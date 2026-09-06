import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  listDuplicateClaimants,
  listDuplicateClaimantsSync,
  resolveTaskFile,
} from "../../src/core/task-file-resolver.js";

function spec(id: string, body = `${id} body`): string {
  return [
    `# ${id}: duplicate claimant fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    body,
    "",
    "## Success Criteria",
    "- [ ] It resolves",
    "",
    "## Testing Requirements",
    "- [ ] Fixture coverage",
    "",
  ].join("\n");
}

async function withTaskFiles(
  files: Array<[name: string, content: string]>,
  fn: (taskDir: string) => Promise<void> | void,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338-query-"));
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

describe("TASK-1338-A: directory-scoped duplicate claimant query", () => {
  it("returns an empty list for a missing directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338-missing-"));
    try {
      expect(
        await listDuplicateClaimants(path.join(root, "directory-that-does-not-exist"), "TASK-100"),
      ).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for one declaration", async () => {
    await withTaskFiles([["TASK-100-only.md", spec("TASK-100")]], async (taskDir) => {
      expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([]);
    });
  });

  const duplicateFiles: Array<[string, string]> = [
    ["TASK-100-z.md", spec("TASK-100", "z claimant")],
    ["TASK-100-a.md", spec("TASK-100", "a claimant")],
  ];

  it.each([
    ["z-first", duplicateFiles],
    ["a-first", [...duplicateFiles].reverse()],
  ] as Array<[string, Array<[string, string]>]>)(
    "returns a sorted copy for candidate duplicates created %s",
    async (_order, files) => {
      await withTaskFiles(files, async (taskDir) => {
        expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([
          "TASK-100-a.md",
          "TASK-100-z.md",
        ]);
      });
    },
  );

  it("keeps the async and sync full-directory queries in parity for a cross-population claimant", async () => {
    await withTaskFiles(crossPopulationFiles, async (taskDir) => {
      const expected = ["TASK-100-a.md", "TASK-999-b.md"];
      expect(await listDuplicateClaimants(taskDir, "task-100")).toEqual(expected);
      expect(listDuplicateClaimantsSync(taskDir, "task-100")).toEqual(expected);
    });
  });

  const crossPopulationFiles: Array<[string, string]> = [
    ["TASK-100-a.md", spec("TASK-100", "candidate-scoped claimant")],
    ["TASK-999-b.md", spec("TASK-100", "directory-scoped claimant")],
  ];

  it.each([
    ["candidate first", crossPopulationFiles],
    ["cross-population claimant first", [...crossPopulationFiles].reverse()],
  ] as Array<[string, Array<[string, string]>]>)(
    "sees the cross-population claimant with files created %s",
    async (_order, files) => {
      await withTaskFiles(files, async (taskDir) => {
        const resolved = (await resolveTaskFile(taskDir, "TASK-100")) as {
          fileName: string;
          duplicateClaimants?: string[];
        } | null;

        expect(resolved?.fileName).toBe("TASK-100-a.md");
        expect(resolved?.duplicateClaimants).toEqual([]);
        expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([
          "TASK-100-a.md",
          "TASK-999-b.md",
        ]);
      });
    },
  );

  it("includes the TaskService SAURUS-REM filename population", async () => {
    await withTaskFiles(
      [
        ["TASK-100-a.md", spec("TASK-100")],
        ["SAURUS-REM-999-b.md", spec("TASK-100")],
      ],
      async (taskDir) => {
        expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([
          "SAURUS-REM-999-b.md",
          "TASK-100-a.md",
        ]);
      },
    );
  });

  it("skips unparseable files and directory entries", async () => {
    await withTaskFiles(
      [
        ["TASK-100-a.md", spec("TASK-100")],
        ["TASK-999-broken.md", "# not a parseable task\n"],
      ],
      async (taskDir) => {
        fs.mkdirSync(path.join(taskDir, "TASK-998-directory.md"));
        expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([]);
      },
    );
  });

  it("accepts linked files under the resolver entry-type policy", async () => {
    await withTaskFiles([["TASK-100-a.md", spec("TASK-100")]], async (taskDir) => {
      const target = path.join(path.dirname(taskDir), "symlink-target.md");
      fs.writeFileSync(target, spec("TASK-100"), "utf-8");
      const link = path.join(taskDir, "TASK-999-linked.md");
      if (process.platform === "win32") {
        fs.linkSync(target, link);
      } else {
        fs.symlinkSync(target, link, "file");
      }

      expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([
        "TASK-100-a.md",
        "TASK-999-linked.md",
      ]);
    });
  });

  it("skips unreadable dangling symlinks", async () => {
    await withTaskFiles([["TASK-100-a.md", spec("TASK-100")]], async (taskDir) => {
      const target = path.join(path.dirname(taskDir), "dangling-target");
      fs.mkdirSync(target);
      fs.symlinkSync(
        target,
        path.join(taskDir, "TASK-999-dangling.md"),
        process.platform === "win32" ? "junction" : "dir",
      );
      fs.rmdirSync(target);

      expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([]);
    });
  });

  it("MATCHER CONTROL: ignores unsupported and non-md top-level names", async () => {
    await withTaskFiles(
      [
        ["TASK-100-a.md", spec("TASK-100")],
        ["NOT-A-TASK.md", spec("TASK-100")],
        ["TASK-999-uppercase.MD", spec("TASK-100")],
        ["TASK-997-note.txt", spec("TASK-100")],
      ],
      async (taskDir) => {
        expect(await listDuplicateClaimants(taskDir, "TASK-100")).toEqual([]);
      },
    );
  });
});
