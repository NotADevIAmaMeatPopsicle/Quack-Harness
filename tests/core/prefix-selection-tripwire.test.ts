// TASK-1334 S1-R4: lexical tripwire for prefix-based task-file selection.
//
// Round 2 (R2-3) widened the readdir scope from a 240-char preceding window
// to the FILE level, which is what the spec prescribed: the window let a new
// site with more separation count zero. The known non-task
// `.find(...startsWith...)` idioms that file-level scoping would flag are
// excluded by exact snippet below, and each exclusion self-asserts.
//
// Regex literals are deliberately not lexed. The controls below pin the known
// corpus around comments, strings, templates, multiline arrows, separation
// distance, and .some.
//
// TASK-1339-B adds a SECOND fingerprint pass for task-name constructions.
// It blanks comments but keeps strings intact so the `.md` inside a template
// literal remains visible. This is intentionally distinct from the prefix
// scanner's comments-and-strings blanking pass below.

import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const FIND_PREFIX_WINDOW =
  /\.find\s*\(\s*(?:\([^)]{0,100}\)|[A-Za-z_$][\w$]*(?:\s*:\s*[^=\n]{1,80})?)\s*=>[\s\S]{0,160}?\.startsWith\s*\(/g;

/**
 * Documented non-task `.find(...startsWith...)` idioms in files the
 * file-level readdir gate would otherwise flag (round 2, R2-3). Snippets are
 * blanked out of the RAW source before counting (string blanking would erase
 * the quoted parts of the snippets themselves), and a control asserts each is
 * still PRESENT in its file, so a changed or removed site fails loudly
 * instead of rotting here.
 */
const EXCLUDED_SITES: ReadonlyArray<{
  file: string;
  snippet: string;
  /**
   * Exact occurrence count in the file, asserted below (round 3, R3-1).
   * Blanking removes EVERY occurrence, which is safe only while the count is
   * pinned: a new real selection that duplicated an excluded expression would
   * otherwise be blanked with it and hide from the expected-count table.
   */
  occurrences: number;
  reason: string;
}> = [
  {
    file: "dispatcher/lifecycle-manager.ts",
    // Round 4 (R4-1): the FULL enclosing expression, receiver included, so a
    // new selector reusing a fragment of it cannot ride the exclusion.
    snippet: 'const overallLine = lines.find((l) => l.trim().startsWith("OVERALL:"));',
    occurrences: 1,
    reason: "verifier OVERALL-line parsing, not a task-file selection",
  },
  {
    file: "dispatcher/branch-manager.ts",
    snippet: "allowedPrefixes.find((prefix) => branch.startsWith(prefix))",
    occurrences: 1,
    reason: "branch-name prefix policy, not a task-file selection",
  },
  {
    file: "monitor/dispatch-manager.ts",
    snippet: "allowedPrefixes.find((prefix) => branch.startsWith(prefix))",
    occurrences: 1,
    reason: "branch-name prefix policy, not a task-file selection",
  },
  {
    file: "monitor/server.ts",
    snippet:
      'cleanupWarning: [...job.output]\n            .reverse()\n            .find((line) => line.startsWith("[quarantine] Recovery warning:")),',
    occurrences: 1,
    reason: "operator-stop warning selection, not a task-file selection",
  },
  {
    file: "preflight/decomposition-dispatch-admission.ts",
    snippet:
      "name.startsWith(dispatchPrefix) &&\n        (ADMISSION_SCOPE_PATTERN.test(name) || MARKER_NAME_PATTERN.test(name))",
    occurrences: 1,
    reason: "one-use dispatch capability lookup, not a task-file selection",
  },
];

const CONSTRUCTION_PATTERN = /\$\{[\s\S]*?\}\.md/g;

/**
 * Full creation expressions excluded from the construction fingerprint.
 * Every occurrence is pinned so an added selector cannot hide by copying a
 * fragment or a whole expression from a legitimate creation site.
 */
const CONSTRUCTION_EXCLUDED_SITES: ReadonlyArray<{
  file: string;
  snippet: string;
  occurrences: number;
  reason: string;
}> = [
  {
    file: "intake/validation-spec-generator.ts",
    snippet: "const finalName = `${taskId}-${slug}.md`;",
    occurrences: 1,
    reason: "validation intake creates a new spec filename",
  },
  {
    file: "dispatcher/dispatcher.ts",
    snippet: "const fileName = `${subtaskId}-${slug}.md`;",
    occurrences: 1,
    reason: "decomposition creates a new subtask spec filename",
  },
  {
    file: "preflight/subtask-writer.ts",
    snippet: "return `${subtaskId}-${slugify(title)}.md`;",
    occurrences: 1,
    reason: "preflight creates a new subtask spec filename",
  },
  {
    file: "planner/task-writer.ts",
    snippet: "const fileName = `${spec.id}-${slugify(extractTitle(spec.content))}.md`;",
    occurrences: 1,
    reason: "the planner creates the task spec filename it writes",
  },
  {
    file: "review/codex-cli-runner.ts",
    snippet: "const requestFile = path.join(reviewsDir, `${baseName}.md`);",
    occurrences: 1,
    reason: "the review runner creates a request artifact",
  },
  {
    file: "monitor/dispatch-manager.ts",
    snippet: "const feedbackPath = path.join(feedbackDir, `retry-feedback-${taskId}.md`);",
    occurrences: 1,
    reason: "the dispatcher creates a retry feedback artifact",
  },
  {
    file: "monitor/routes/wiki.ts",
    snippet: "path: `raw/platform/changelog/${date}-${taskFileSlug(input.taskId)}.md`,",
    occurrences: 1,
    reason: "the wiki route creates a changelog artifact path",
  },
  {
    file: "monitor/routes/wiki.ts",
    snippet: "path: `raw/platform/bug-reports/${date}-${slug}.md`,",
    occurrences: 1,
    reason: "the wiki route creates a bug-report artifact path",
  },
];

/**
 * CRLF-normalized before any matching: checkouts on this repo carry CRLF in
 * the working tree, and the multiline exclusion snippets are written LF-only.
 * Round 4 follow-up: an LF-joined snippet can never match CRLF bytes, which
 * silently zeroed an exclusion and failed its pin.
 */
function normalizeEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function countOccurrences(source: string, snippet: string): number {
  return normalizeEndings(source).split(snippet).length - 1;
}

type LexMode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";

function blankCommentsAndStrings(source: string): string {
  const output = source.split("");
  let mode: LexMode = "code";
  const templateExpressionDepths: number[] = [];

  const blank = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") {
      output[index] = " ";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line-comment") {
      if (char === "\n") {
        mode = "code";
      } else {
        blank(index);
      }
      continue;
    }

    if (mode === "block-comment") {
      blank(index);
      if (char === "*" && next === "/") {
        blank(index + 1);
        index += 1;
        mode = "code";
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      blank(index);
      const closing = mode === "single" ? "'" : '"';
      if (char === "\\") {
        if (next !== undefined) {
          blank(index + 1);
          index += 1;
        }
      } else if (char === closing) {
        mode = "code";
      }
      continue;
    }

    if (mode === "template") {
      blank(index);
      if (char === "\\") {
        if (next !== undefined) {
          blank(index + 1);
          index += 1;
        }
      } else if (char === "`") {
        mode = "code";
      } else if (char === "$" && next === "{") {
        blank(index + 1);
        index += 1;
        templateExpressionDepths.push(1);
        mode = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      blank(index);
      blank(index + 1);
      index += 1;
      mode = "line-comment";
    } else if (char === "/" && next === "*") {
      blank(index);
      blank(index + 1);
      index += 1;
      mode = "block-comment";
    } else if (char === "'") {
      blank(index);
      mode = "single";
    } else if (char === '"') {
      blank(index);
      mode = "double";
    } else if (char === "`") {
      blank(index);
      mode = "template";
    } else if (templateExpressionDepths.length > 0 && char === "{") {
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
    } else if (templateExpressionDepths.length > 0 && char === "}") {
      const last = templateExpressionDepths.length - 1;
      templateExpressionDepths[last] -= 1;
      if (templateExpressionDepths[last] === 0) {
        blank(index);
        templateExpressionDepths.pop();
        mode = "template";
      }
    }
  }

  return output.join("");
}

function blankCommentsPreserveStrings(source: string): string {
  const output = source.split("");
  let mode: LexMode = "code";
  const templateExpressionDepths: number[] = [];

  const blank = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") {
      output[index] = " ";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      else blank(index);
      continue;
    }

    if (mode === "block-comment") {
      blank(index);
      if (char === "*" && next === "/") {
        blank(index + 1);
        index += 1;
        mode = "code";
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const closing = mode === "single" ? "'" : '"';
      if (char === "\\" && next !== undefined) index += 1;
      else if (char === closing) mode = "code";
      continue;
    }

    if (mode === "template") {
      if (char === "\\" && next !== undefined) {
        index += 1;
      } else if (char === "`") {
        mode = "code";
      } else if (char === "$" && next === "{") {
        index += 1;
        templateExpressionDepths.push(1);
        mode = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      blank(index);
      blank(index + 1);
      index += 1;
      mode = "line-comment";
    } else if (char === "/" && next === "*") {
      blank(index);
      blank(index + 1);
      index += 1;
      mode = "block-comment";
    } else if (char === "'") {
      mode = "single";
    } else if (char === '"') {
      mode = "double";
    } else if (char === "`") {
      mode = "template";
    } else if (templateExpressionDepths.length > 0 && char === "{") {
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
    } else if (templateExpressionDepths.length > 0 && char === "}") {
      const last = templateExpressionDepths.length - 1;
      templateExpressionDepths[last] -= 1;
      if (templateExpressionDepths[last] === 0) {
        templateExpressionDepths.pop();
        mode = "template";
      }
    }
  }

  return output.join("");
}

function countConstructions(source: string, relativePath = "fixture.ts"): number {
  let working = normalizeEndings(source);
  for (const excluded of CONSTRUCTION_EXCLUDED_SITES) {
    if (excluded.file !== relativePath) continue;
    const blankedSnippet = [...excluded.snippet].map((ch) => (ch === "\n" ? "\n" : " ")).join("");
    working = working.split(excluded.snippet).join(blankedSnippet);
  }
  const matches = blankCommentsPreserveStrings(working).match(CONSTRUCTION_PATTERN);
  return matches?.length ?? 0;
}

function countPrefixSelections(source: string, relativePath = "fixture.ts"): number {
  // Exclusions first, against RAW source: the lexer would blank the quoted
  // parts of the snippets and make them unfindable. Space-for-space
  // replacement keeps every other offset stable.
  let working = normalizeEndings(source);
  for (const excluded of EXCLUDED_SITES) {
    if (excluded.file !== relativePath) continue;
    // Newline-preserving blank, so multiline excluded expressions keep the
    // surrounding line structure intact for the lexer.
    const blankedSnippet = [...excluded.snippet].map((ch) => (ch === "\n" ? "\n" : " ")).join("");
    working = working.split(excluded.snippet).join(blankedSnippet);
  }

  const blanked = blankCommentsAndStrings(working);
  // File-level readdir scope (round 2, R2-3): a directory-listing file with a
  // prefix selection ANYWHERE in it counts, however far apart they sit.
  if (!/\breaddir(?:Sync)?\b/.test(blanked)) {
    return 0;
  }

  const matches = blanked.match(FIND_PREFIX_WINDOW);
  return matches ? matches.length : 0;
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files.sort();
}

const expectedCounts: Readonly<Record<string, number>> = {
  "core/task-file-resolver.ts": 2,
};

const expectedConstructionCounts: Readonly<Record<string, number>> = {
  "cli/ghost-prep-sweep.ts": 1,
  "core/task-file-resolver.ts": 2,
  "dispatcher/context-assembler.ts": 1,
  "monitor/task-service.ts": 1,
};

describe("TASK-1334: prefix-selection scanner controls", () => {
  it("matches a plain prefix-selection fixture", () => {
    const fixture = [
      "const entries = readdirSync(taskDir);",
      "const taskFile = entries.find((entry) => entry.startsWith(taskId));",
    ].join("\n");
    expect(countPrefixSelections(fixture)).toBe(1);
  });

  it("matches a multiline-formatted prefix selection", () => {
    const fixture = [
      "const entries = await readdir(taskDir);",
      "const taskFile = entries.find(",
      "  (entry)",
      "    => entry",
      "      .startsWith(taskId),",
      ");",
    ].join("\n");
    expect(countPrefixSelections(fixture)).toBe(1);
  });

  it.each([
    [
      "block comment",
      "const entries = readdirSync(taskDir); /* entries.find((f) => f.startsWith(taskId)); */",
    ],
    [
      "line comment",
      "const entries = readdirSync(taskDir); // entries.find((f) => f.startsWith(taskId));",
    ],
    [
      "double-quoted string",
      'const entries = readdirSync(taskDir); const copy = "entries.find((f) => f.startsWith(taskId))";',
    ],
    [
      "single-quoted string",
      "const entries = readdirSync(taskDir); const copy = 'entries.find((f) => f.startsWith(taskId))';",
    ],
    [
      "template string",
      "const entries = readdirSync(taskDir); const copy = `entries.find((f) => f.startsWith(taskId))`;",
    ],
  ])("does not match a %s copy", (_label, fixture) => {
    expect(countPrefixSelections(fixture)).toBe(0);
  });

  it("does not let a comment marker inside a string hide real code", () => {
    const fixture = [
      'const marker = "// not a comment";',
      "const entries = readdirSync(taskDir);",
      "const taskFile = entries.find((entry) => entry.startsWith(taskId));",
    ].join("\n");
    expect(countPrefixSelections(fixture)).toBe(1);
  });

  it("does not match a .some existence check", () => {
    const fixture = [
      "const entries = readdirSync(taskDir);",
      "const exists = entries.some((entry) => entry.startsWith(taskId));",
    ].join("\n");
    expect(countPrefixSelections(fixture)).toBe(0);
  });

  it("matches a prefix selection far from its readdir", () => {
    // Round 2 (R2-3): the first build required readdir within a 240-char
    // preceding window, so exactly this shape counted zero. File-level scope
    // is the rule; this control pins it.
    const filler = Array.from({ length: 30 }, (_, i) => `const filler${i} = ${i};`).join("\n");
    const fixture = [
      "const entries = readdirSync(taskDir);",
      filler,
      "const taskFile = entries.find((entry) => entry.startsWith(taskId));",
    ].join("\n");
    expect(fixture.length).toBeGreaterThan(400);
    expect(countPrefixSelections(fixture)).toBe(1);
  });

  it("pins every excluded site to its exact occurrence count, so exclusions cannot rot or hide", () => {
    // Round 3 (R3-1): at-least-one was not enough. Blanking removes every
    // occurrence, so a DUPLICATE of an excluded expression that was actually
    // a new task-file selection would vanish with it; exact counts make that
    // duplication fail here before it can hide there.
    for (const excluded of EXCLUDED_SITES) {
      const source = fs.readFileSync(path.join(SRC, excluded.file), "utf-8");
      expect({
        file: excluded.file,
        occurrences: countOccurrences(source, excluded.snippet),
      }).toEqual({ file: excluded.file, occurrences: excluded.occurrences });
    }
  });

  it("counts a duplicated excluded expression, the control for the exact-count pin", () => {
    const site = "allowedPrefixes.find((prefix) => branch.startsWith(prefix))";
    const doubled = [`const a = ${site};`, `const b = ${site};`].join("\n");
    expect(countOccurrences(doubled, site)).toBe(2);
  });

  it("still counts a real selector that reuses an excluded snippet's fragment", () => {
    // Round 4 (R4-1): the count-neutral relocation evasion. Exclusions bind
    // to the FULL enclosing expression, so dropping the excluded site and
    // adding a real selector that reuses its fragment text cannot ride the
    // exclusion: the corpus pin catches the drop, and this control proves
    // the fragment-reusing selector still counts.
    const fixture = [
      "const entries = await readdir(taskDir);",
      "const taskFile = entries.find((prefix) => branch.startsWith(prefix));",
    ].join("\n");
    expect(countPrefixSelections(fixture, "dispatcher/branch-manager.ts")).toBe(1);
  });

  it("blanks an excluded snippet without hiding a real selection in the same file", () => {
    // The retained branch-policy exclusion must remove exactly that expression,
    // even if the same file acquires a real prefix-based task-file selection.
    const fixture = [
      "const entries = await readdir(taskDir);",
      "const allowed = allowedPrefixes.find((prefix) => branch.startsWith(prefix));",
      "const taskFile = entries.find((entry) => entry.startsWith(taskId));",
    ].join("\n");
    expect(countPrefixSelections(fixture, "dispatcher/branch-manager.ts")).toBe(1);
    expect(countPrefixSelections(fixture)).toBe(2);
  });

  it("detects the retired overnight prefix-attribution expression if reintroduced", () => {
    const fixture = [
      "const entries = await readdir(taskDir);",
      "const parseError = current.parseErrors.find((err) => err.file.startsWith(item.taskId))?.error;",
    ].join("\n");
    expect(countPrefixSelections(fixture, "overnight/runner.ts")).toBe(1);
    expect(countPrefixSelections(fixture)).toBe(1);
  });
});

describe("TASK-1334: exact prefix-selection counts in src", () => {
  const files = listTypeScriptFiles(SRC);
  const relativeFiles = files.map((file) => path.relative(SRC, file).replace(/\\/g, "/"));

  it("keeps every expected producer present and every file at its exact count", () => {
    for (const expectedFile of Object.keys(expectedCounts)) {
      expect(relativeFiles).toContain(expectedFile);
    }

    for (const file of files) {
      const relative = path.relative(SRC, file).replace(/\\/g, "/");
      const source = fs.readFileSync(file, "utf-8");
      expect({
        file: relative,
        matches: countPrefixSelections(source, relative),
      }).toEqual({
        file: relative,
        matches: expectedCounts[relative] ?? 0,
      });
    }
  });

  it("keeps ghost-prep-sweep's .some existence check outside the class", () => {
    const relative = "cli/ghost-prep-sweep.ts";
    const source = fs.readFileSync(path.join(SRC, relative), "utf-8");

    expect(source).toContain(".some");
    expect(source).toMatch(/\breaddir(?:Sync)?\b/);
    expect(countPrefixSelections(source, relative)).toBe(0);
    expect(expectedCounts[relative]).toBeUndefined();
  });
});

describe("TASK-1339-B: construction fingerprint controls", () => {
  it("matcher-only control: matches the literal identifier form", () => {
    expect(countConstructions("const taskFile = `${taskId}.md`;")).toBe(1);
  });

  it("matcher-only control: matches an arbitrary member expression", () => {
    expect(countConstructions("const taskFile = `${record.parentRef}.md`;")).toBe(1);
  });

  it("matcher-only control: ignores a pinned creation expression", () => {
    const excluded = CONSTRUCTION_EXCLUDED_SITES.find(
      (site) => site.file === "planner/task-writer.ts",
    );
    expect(excluded).toBeDefined();
    expect(countConstructions(excluded!.snippet, excluded!.file)).toBe(0);
  });

  it("matcher-only control: blanks comments while retaining string content", () => {
    const fixture = [
      "// const hidden = `${commented.task}.md`;",
      "const visible = `${record.parentRef}.md`;",
    ].join("\n");
    expect(countConstructions(fixture)).toBe(1);
  });

  it("matcher-only control: pins every full creation expression to its exact occurrence count", () => {
    for (const excluded of CONSTRUCTION_EXCLUDED_SITES) {
      const source = fs.readFileSync(path.join(SRC, excluded.file), "utf-8");
      expect({
        file: excluded.file,
        occurrences: countOccurrences(source, excluded.snippet),
      }).toEqual({ file: excluded.file, occurrences: excluded.occurrences });
    }
  });
});

describe("TASK-1339-B: exact construction counts in all src files", () => {
  const files = listTypeScriptFiles(SRC);
  const relativeFiles = files.map((file) => path.relative(SRC, file).replace(/\\/g, "/"));

  it("keeps every expected producer present and every file at its exact count", () => {
    for (const expectedFile of Object.keys(expectedConstructionCounts)) {
      expect(relativeFiles).toContain(expectedFile);
    }

    for (const file of files) {
      const relative = path.relative(SRC, file).replace(/\\/g, "/");
      const source = fs.readFileSync(file, "utf-8");
      expect({
        file: relative,
        matches: countConstructions(source, relative),
      }).toEqual({
        file: relative,
        matches: expectedConstructionCounts[relative] ?? 0,
      });
    }
  });
});
