// ─── QPI-048 leg (h): decompose ghost-prep sweep ───────────────────
// The sweep removes prep artifacts ONLY for the decompose-revert shape
// (subtask id, child spec gone, parent spec present) — everything else
// is out of scope by construction.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sweepGhostPrepState } from "../../src/cli/ghost-prep-sweep";

let projectRoot: string;

function seed(rel: string, content = "x"): void {
  const p = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/**
 * Seed a real TASK SPEC: the H1 its id claims plus the parser's
 * required Metadata shape. Round-2c F1: the Metadata block is what
 * separates a spec from a document ABOUT the task, and the sweep's
 * parent check depends on that distinction.
 */
function seedSpec(rel: string, taskId: string): void {
  seed(
    rel,
    `# ${taskId}: Fixture Title\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 1h\n- **Status:** BACKLOG\n\nBody.\n`,
  );
}

/** Seed a NON-spec document that still names a task in its H1. */
function seedDoc(rel: string, h1: string): void {
  seed(rel, `${h1}\n\n**Generated:** a workflow, not a spec.\n\n## 1. Summary\n\nBody.\n`);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-ghost-prep-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("sweepGhostPrepState", () => {
  it("detects and (on apply) removes ghost child prep whose spec was reverted", () => {
    seedSpec("docs/tasks/TASK-1273-parent.md", "TASK-1273");
    seed(".quack/prep/TASK-1273-A.json");
    seed(".quack/prep/TASK-1273-A-preflight.json");

    const dry = sweepGhostPrepState(projectRoot, "docs/tasks", false);
    expect(dry.ghosts).toEqual([
      {
        taskId: "TASK-1273-A",
        parentId: "TASK-1273",
        files: ["TASK-1273-A-preflight.json", "TASK-1273-A.json"],
      },
    ]);
    expect(dry.removedFiles).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1273-A.json"))).toBe(true);

    const applied = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(applied.removedFiles).toEqual(["TASK-1273-A-preflight.json", "TASK-1273-A.json"]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1273-A.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1273-A-preflight.json"))).toBe(
      false,
    );
  });

  it("keeps prep for children whose spec still exists", () => {
    seedSpec("docs/tasks/TASK-900-parent.md", "TASK-900");
    seedSpec("docs/tasks/TASK-900-A-child.md", "TASK-900-A");
    seed(".quack/prep/TASK-900-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-900-A.json"))).toBe(true);
  });

  it("never touches non-subtask prep, even with no spec (out of scope by construction)", () => {
    seed(".quack/prep/TASK-777.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-777.json"))).toBe(true);
  });

  it("skips subtask prep whose PARENT spec is also gone (whole family left; not the revert shape)", () => {
    seedSpec("docs/tasks/TASK-1.md", "TASK-1"); // unrelated, keeps taskDir present
    seed(".quack/prep/TASK-555-B.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-555-B.json"))).toBe(true);
  });

  it("review finding: a SIBLING child's spec does not stand in for the missing parent", () => {
    // Parent TASK-555 deleted; sibling child A's spec remains; child B's
    // spec reverted. Without the parent-own-spec check, A's file
    // prefix-matched the parent and B's prep was wrongly swept.
    seedSpec("docs/tasks/TASK-555-A-sibling-child.md", "TASK-555-A");
    seed(".quack/prep/TASK-555-B.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-555-B.json"))).toBe(true);
  });

  it("the parent's own kebab-slug spec still counts as the parent", () => {
    seedSpec("docs/tasks/TASK-556-parent-slug.md", "TASK-556");
    seed(".quack/prep/TASK-556-C.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toHaveLength(1);
    expect(result.ghosts[0].taskId).toBe("TASK-556-C");
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-556-C.json"))).toBe(false);
  });

  it("2b finding: an UPPERCASE-slug parent is identified by CONTENT, not its filename", () => {
    // Filename grammar cannot tell this parent from a subtask id. Pair
    // this with the 2c F1 case below: SAME filename, opposite outcome,
    // decided entirely by whether the content is a spec.
    seedSpec("docs/tasks/TASK-1106-IMPLEMENTATION-BLUEPRINT.md", "TASK-1106");
    seed(".quack/prep/TASK-1106-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toHaveLength(1);
    expect(result.ghosts[0].taskId).toBe("TASK-1106-A");
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1106-A.json"))).toBe(false);
  });

  // Property pin, not a fold pin: 2c verified this passes under the old
  // filename heuristic too. It stays because the property must hold
  // under every future identity rule, not because it discriminates.
  it("a sibling child's H1 still does not impersonate the parent", () => {
    seedSpec("docs/tasks/TASK-557-A-child.md", "TASK-557-A");
    seed(".quack/prep/TASK-557-B.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-557-B.json"))).toBe(true);
  });

  it("2c F1: the LIVE TASK-1106 blueprint DOC is not the parent spec, so the family is skipped", () => {
    // The exact live shape the 2b fold cited as its own justification:
    // `# TASK-1106 Implementation Blueprint` — no colon (the old
    // `\s*[:\s]` accepted the space, so the missing colon changed
    // nothing) and no Metadata. It is a workflow document, not
    // TASK-1106's spec, and no TASK-1106 spec exists here at all — the
    // whole-family-left case, which is out of scope.
    seedDoc(
      "docs/tasks/TASK-1106-IMPLEMENTATION-BLUEPRINT.md",
      "# TASK-1106 Implementation Blueprint",
    );
    seed(".quack/prep/TASK-1106-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1106-A.json"))).toBe(true);
  });

  it("2c F1: a colon'd H1 without the spec shape is still only a document", () => {
    seedDoc("docs/tasks/TASK-1107-NOTES.md", "# TASK-1107: Design notes");
    seed(".quack/prep/TASK-1107-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-1107-A.json"))).toBe(true);
  });

  it("real-corpus: a parent using the TOLERANT status shape (no ## Metadata) still counts", () => {
    // Measured on the live example backlog: 8 genuine specs carry Status
    // directly under the H1 with no `## Metadata` heading — the shape
    // TASK-1300 (P0-5) taught the parser to accept. A marker that
    // required the heading skipped their families silently.
    seed(
      "docs/tasks/TASK-559-tolerant.md",
      "# TASK-559 — tolerant shape\n\n**Priority:** P2\n**Status:** BACKLOG\n\n## Problem\nBody.\n",
    );
    seed(".quack/prep/TASK-559-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toHaveLength(1);
    expect(result.ghosts[0].taskId).toBe("TASK-559-A");
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-559-A.json"))).toBe(false);
  });

  it("2d F1: a QUOTED H1 inside a fenced block does not make a doc the parent spec", () => {
    // The over-delete the fence-awareness closes: a notes file that
    // SHOWS the parent's H1 in a code fence and carries a Status field
    // of its own was being indexed as that task's spec.
    seed(
      "docs/tasks/TASK-560-NOTES.md",
      "# Notes about the family\n\n```md\n# TASK-560: Quoted heading\n```\n\n**Status:** BACKLOG\n",
    );
    seed(".quack/prep/TASK-560-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-560-A.json"))).toBe(true);
  });

  it("2d F1: a Status line that only appears inside a fence is not a spec marker", () => {
    seed(
      "docs/tasks/TASK-561-example.md",
      "# TASK-561: Example doc\n\nHow a spec looks:\n\n```md\n**Status:** BACKLOG\n```\n",
    );
    seed(".quack/prep/TASK-561-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-561-A.json"))).toBe(true);
  });

  it("2d F1: YAML frontmatter does not hide a real spec's H1", () => {
    seed(
      "docs/tasks/TASK-562-frontmatter.md",
      "---\ntitle: something\n---\n\n# TASK-562: Real spec\n\n## Metadata\n- **Status:** BACKLOG\n",
    );
    seed(".quack/prep/TASK-562-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toHaveLength(1);
    expect(result.ghosts[0].taskId).toBe("TASK-562-A");
  });

  it("2c F2: a child spec whose FILENAME omits its id still counts as present", () => {
    // Filename undecidability cuts the other way too: the child side
    // must be generous or live prep gets swept.
    seedSpec("docs/tasks/TASK-558-parent.md", "TASK-558");
    seedSpec("docs/tasks/TASK-558-BLUEPRINT.md", "TASK-558-A");
    seed(".quack/prep/TASK-558-A.json");

    const result = sweepGhostPrepState(projectRoot, "docs/tasks", true);
    expect(result.ghosts).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, ".quack/prep/TASK-558-A.json"))).toBe(true);
  });
});
