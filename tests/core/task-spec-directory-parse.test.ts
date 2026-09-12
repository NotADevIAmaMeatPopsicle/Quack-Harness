import * as fs from "node:fs";
import * as path from "node:path";

import { groupTaskClaimantsByDeclaredId } from "../../src/core/duplicate-claimants";
import { parseTaskFile } from "../../src/core/task-parser";

interface TaskDocument {
  fileName: string;
  content: string;
}

interface ParseFailure {
  fileName: string;
  message: string;
}

interface ParsedDeclaration {
  fileName: string;
  declaredId: string;
}

const NON_TASK_DOCUMENT_ALLOWLIST: Readonly<Record<string, string>> = {
  "README.md": "Backlog index and authoring guide, not a task spec.",
  "TASK-1106-IMPLEMENTATION-BLUEPRINT.md":
    "Implementation blueprint companion, not the TASK-1106 task spec.",
  "PENDING-cc-inbox-atomic-claim-single-drainer.md":
    "Pending design note without an assigned task id.",
};

function scanTaskDocuments(
  documents: readonly TaskDocument[],
  allowlist: Readonly<Record<string, string>> = NON_TASK_DOCUMENT_ALLOWLIST,
): {
  parsedFileNames: string[];
  parsedDeclarations: ParsedDeclaration[];
  allowlistedFailures: ParseFailure[];
  unexpectedFailures: ParseFailure[];
} {
  const parsedFileNames: string[] = [];
  const parsedDeclarations: ParsedDeclaration[] = [];
  const allowlistedFailures: ParseFailure[] = [];
  const unexpectedFailures: ParseFailure[] = [];

  for (const document of documents) {
    try {
      const parsed = parseTaskFile(document.content, document.fileName);
      parsedFileNames.push(document.fileName);
      parsedDeclarations.push({
        fileName: document.fileName,
        declaredId: parsed.id,
      });
    } catch (error) {
      const failure = {
        fileName: document.fileName,
        message: error instanceof Error ? error.message : String(error),
      };
      if (Object.hasOwn(allowlist, document.fileName)) {
        allowlistedFailures.push(failure);
      } else {
        unexpectedFailures.push(failure);
      }
    }
  }

  return {
    parsedFileNames,
    parsedDeclarations,
    allowlistedFailures,
    unexpectedFailures,
  };
}

function assertUniqueDeclarations(declarations: readonly ParsedDeclaration[]): void {
  const grouped = groupTaskClaimantsByDeclaredId(declarations);
  const duplicates = [...grouped.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length > 0) {
    throw new Error(`Repeated declared task ids: ${JSON.stringify(duplicates)}`);
  }
}

function loadMarkdownDocuments(directory: string): TaskDocument[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({
      fileName: entry.name,
      content: fs.readFileSync(path.join(directory, entry.name), "utf-8"),
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

describe("docs/tasks parser guard", () => {
  it("parses every task spec and allows exactly the three non-task documents", () => {
    const taskDirectory = path.join(process.cwd(), "docs", "tasks");
    const documents = loadMarkdownDocuments(taskDirectory);
    const result = scanTaskDocuments(documents);
    const expectedAllowlist = [
      "PENDING-cc-inbox-atomic-claim-single-drainer.md",
      "README.md",
      "TASK-1106-IMPLEMENTATION-BLUEPRINT.md",
    ];

    expect(Object.keys(NON_TASK_DOCUMENT_ALLOWLIST).sort()).toEqual(expectedAllowlist);
    expect(result.allowlistedFailures.map(({ fileName }) => fileName)).toEqual(expectedAllowlist);
    expect(result.unexpectedFailures).toEqual([]);
    expect(result.parsedFileNames).toHaveLength(documents.length - 3);
  });

  it("CONTROL TASK-1338-A: this repo's docs/tasks has unique declared ids", () => {
    const taskDirectory = path.join(process.cwd(), "docs", "tasks");
    const result = scanTaskDocuments(loadMarkdownDocuments(taskDirectory));

    assertUniqueDeclarations(result.parsedDeclarations);
  });

  it("CONTROL TASK-1338-A: the two-file uniqueness oracle detects a repeated id", () => {
    const fixture = (title: string) => `# TASK-999999: ${title}

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** SMALL
- **Status:** BACKLOG

## Problem Statement
Two files deliberately declare one id.

## Success Criteria
- [ ] The uniqueness oracle rejects the fixture

## Testing Requirements
- [ ] Positive control
`;
    const result = scanTaskDocuments([
      { fileName: "TASK-999999-a.md", content: fixture("first claimant") },
      { fileName: "TASK-999999-b.md", content: fixture("second claimant") },
    ]);

    expect(result.parsedDeclarations).toEqual([
      { fileName: "TASK-999999-a.md", declaredId: "TASK-999999" },
      { fileName: "TASK-999999-b.md", declaredId: "TASK-999999" },
    ]);
    // Round-1 LOW: toThrow(string) is substring matching, so capture and
    // compare the whole message instead; a prefixed or suffixed diagnostic
    // must fail this control.
    let thrown: unknown;
    try {
      assertUniqueDeclarations(result.parsedDeclarations);
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Repeated declared task ids: [["TASK-999999",["TASK-999999-a.md","TASK-999999-b.md"]]]',
    );
  });

  it("positive control detects an unparseable task spec", () => {
    const fileName = "TASK-999999-positive-control.md";
    const deliberatelyBrokenSpec = `# TASK-999999: Positive control

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** SMALL
- **Status:** BACKLOG

## Success Criteria
- [ ] The scanner reports this fixture

## Testing Requirements
- [ ] The positive control is exercised
`;

    const result = scanTaskDocuments([{ fileName, content: deliberatelyBrokenSpec }]);

    expect(result).toEqual({
      parsedFileNames: [],
      parsedDeclarations: [],
      allowlistedFailures: [],
      unexpectedFailures: [
        {
          fileName,
          message: `${fileName}: Missing required section: Problem Statement`,
        },
      ],
    });
  });
});
