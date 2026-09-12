import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findDockerPublicationRecovery,
  readDockerPublicationRecovery,
  type DockerPublicationJournal,
} from "../../src/dispatcher/docker-publication-recovery";

function fixture(taskId = "TASK-RECOVERY"): {
  root: string;
  finalPath: string;
  journal: DockerPublicationJournal;
  bytes: Buffer;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-publication-recovery-"));
  const publicationId = randomUUID();
  const branch = `quack/${taskId}`;
  const timestamp = "2020-01-01T00:00:00.000Z";
  const journal: DockerPublicationJournal = {
    version: 1,
    publicationId,
    taskId,
    projectRoot: root,
    branch,
    targetBranch: "main",
    repository: {
      pushUrlHash: "d".repeat(64),
      github: {
        host: "github.com",
        nameWithOwner: "org/repo",
        selector: "github.com/org/repo",
      },
    },
    gitState: {
      authoritativeRef: `refs/heads/${branch}`,
      baseHead: "a".repeat(40),
      candidateHead: "b".repeat(40),
      sealedRef: `refs/quack/docker-publication/${taskId}/${publicationId}`,
    },
    worktreePath: path.join(root, "worktree"),
    worktreeSessionId: `quack-${taskId}-${randomUUID()}`,
    worktreeOwnershipId: publicationId,
    preserveWorktree: false,
    requirements: { push: true, pullRequest: true, merge: true, status: true, cleanup: true },
    progress: {},
    state: "pending",
    generation: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const finalPath = path.join(root, `${taskId}-${publicationId}.json`);
  return {
    root,
    finalPath,
    journal,
    bytes: Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf-8"),
  };
}

describe("Docker publication restart discovery", () => {
  test("fails closed on a legacy pending remote journal without an origin binding", () => {
    const state = fixture();
    delete state.journal.repository;
    fs.writeFileSync(state.finalPath, `${JSON.stringify(state.journal, null, 2)}\n`, "utf-8");

    expect(() => findDockerPublicationRecovery(state.root, state.journal.taskId)).toThrow(
      /inconsistent progress or ownership/,
    );
    fs.rmSync(state.root, { recursive: true, force: true });
  });

  test("rejects pull-request progress that has a timestamp but no URL", () => {
    const state = fixture();
    state.journal.progress = {
      promotedAt: "2020-01-01T00:00:01.000Z",
      pushedAt: "2020-01-01T00:00:02.000Z",
      pullRequestAt: "2020-01-01T00:00:03.000Z",
    };
    fs.writeFileSync(state.finalPath, `${JSON.stringify(state.journal, null, 2)}\n`, "utf-8");

    expect(() => readDockerPublicationRecovery(state.finalPath)).toThrow(
      /inconsistent progress or ownership/,
    );
    fs.rmSync(state.root, { recursive: true, force: true });
  });

  test("promotes one fully written orphan install temp into the durable final name", () => {
    const state = fixture();
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, state.bytes);

      const found = findDockerPublicationRecovery(state.root, state.journal.taskId);

      expect(found).toEqual({ path: state.finalPath, journal: state.journal });
      expect(fs.existsSync(temporary)).toBe(false);
      expect(fs.lstatSync(state.finalPath).nlink).toBe(1);
      expect(readDockerPublicationRecovery(state.finalPath)).toEqual(state.journal);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("blocks a new invocation on a truncated orphan rather than ignoring its ownership", () => {
    const state = fixture();
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, state.bytes.subarray(0, Math.floor(state.bytes.length / 2)));

      expect(() => findDockerPublicationRecovery(state.root, state.journal.taskId)).toThrow(
        /exact publication remains blocked for recovery/,
      );
      expect(fs.existsSync(temporary)).toBe(true);
      expect(fs.existsSync(state.finalPath)).toBe(false);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("repairs a final-plus-temp hard-link crash residue during discovery", () => {
    const state = fixture();
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, state.bytes);
      fs.linkSync(temporary, state.finalPath);
      expect(fs.lstatSync(state.finalPath).nlink).toBe(2);

      const found = findDockerPublicationRecovery(state.root, state.journal.taskId);

      expect(found?.journal).toEqual(state.journal);
      expect(fs.existsSync(temporary)).toBe(false);
      expect(fs.lstatSync(state.finalPath).nlink).toBe(1);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed when restart discovery finds multiple orphan owners", () => {
    const first = fixture();
    const second = fixture();
    try {
      const secondJournal = { ...second.journal, taskId: first.journal.taskId };
      const secondPath = path.join(
        first.root,
        `${first.journal.taskId}-${secondJournal.publicationId}.json`,
      );
      fs.writeFileSync(`${first.finalPath}.2147483647.${randomUUID()}.tmp`, first.bytes);
      fs.writeFileSync(
        `${secondPath}.2147483646.${randomUUID()}.tmp`,
        `${JSON.stringify(secondJournal, null, 2)}\n`,
      );

      expect(() => findDockerPublicationRecovery(first.root, first.journal.taskId)).toThrow(
        /Multiple orphan Docker publication journals/,
      );
      expect(fs.existsSync(first.finalPath)).toBe(false);
      expect(fs.existsSync(secondPath)).toBe(false);
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });

  test("promotes the exact next generation left beside an older final journal", () => {
    const state = fixture();
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    const successor: DockerPublicationJournal = {
      ...state.journal,
      progress: { promotedAt: "2020-01-01T00:00:01.000Z" },
      generation: 1,
      previousDigest: createHash("sha256").update(state.bytes).digest("hex"),
      updatedAt: "2020-01-01T00:00:01.000Z",
    };
    try {
      fs.writeFileSync(state.finalPath, state.bytes);
      fs.writeFileSync(temporary, `${JSON.stringify(successor, null, 2)}\n`, "utf-8");

      const found = findDockerPublicationRecovery(state.root, state.journal.taskId);

      expect(found?.journal).toEqual(successor);
      expect(fs.existsSync(temporary)).toBe(false);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["bad digest", 1, "f".repeat(64)],
    ["skipped generation", 2, createHash("sha256").update("unused").digest("hex")],
  ])("blocks a %s update temp without changing the final", (_label, generation, prior) => {
    const state = fixture();
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    const candidate: DockerPublicationJournal = {
      ...state.journal,
      progress: { promotedAt: "2020-01-01T00:00:01.000Z" },
      generation,
      previousDigest: prior,
      updatedAt: "2020-01-01T00:00:01.000Z",
    };
    try {
      fs.writeFileSync(state.finalPath, state.bytes);
      fs.writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`, "utf-8");

      expect(() => findDockerPublicationRecovery(state.root, state.journal.taskId)).toThrow(
        /not the exact next generation/,
      );
      expect(fs.readFileSync(state.finalPath)).toEqual(state.bytes);
      expect(fs.existsSync(temporary)).toBe(true);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed on divergent same-generation successors", () => {
    const state = fixture();
    const previousDigest = createHash("sha256").update(state.bytes).digest("hex");
    const first = {
      ...state.journal,
      progress: { promotedAt: "2020-01-01T00:00:01.000Z" },
      generation: 1,
      previousDigest,
      updatedAt: "2020-01-01T00:00:01.000Z",
    };
    const second = {
      ...first,
      lastError: {
        step: "push" as const,
        detail: "different outcome",
        at: "2020-01-01T00:00:02.000Z",
      },
    };
    try {
      fs.writeFileSync(state.finalPath, state.bytes);
      fs.writeFileSync(
        `${state.finalPath}.2147483647.${randomUUID()}.tmp`,
        `${JSON.stringify(first, null, 2)}\n`,
      );
      fs.writeFileSync(
        `${state.finalPath}.2147483646.${randomUUID()}.tmp`,
        `${JSON.stringify(second, null, 2)}\n`,
      );

      expect(() => findDockerPublicationRecovery(state.root, state.journal.taskId)).toThrow(
        /divergent next-generation/,
      );
      expect(fs.readFileSync(state.finalPath)).toEqual(state.bytes);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("recovers a preparedMerge update before publication replay", () => {
    const state = fixture();
    state.journal.requirements.pullRequest = false;
    state.bytes = Buffer.from(`${JSON.stringify(state.journal, null, 2)}\n`, "utf-8");
    const preparedRef = state.journal.gitState.sealedRef.replace(
      "refs/quack/docker-publication/",
      "refs/quack/docker-publication-prepared/",
    );
    const successor: DockerPublicationJournal = {
      ...state.journal,
      progress: {
        promotedAt: "2020-01-01T00:00:01.000Z",
        preparedMerge: {
          strategy: "squash",
          candidateHead: state.journal.gitState.candidateHead,
          targetHead: "c".repeat(40),
          resultHead: "d".repeat(40),
          preparedRef,
          preparedAt: "2020-01-01T00:00:02.000Z",
        },
      },
      generation: 1,
      previousDigest: createHash("sha256").update(state.bytes).digest("hex"),
      updatedAt: "2020-01-01T00:00:02.000Z",
    };
    const temporary = `${state.finalPath}.2147483647.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(state.finalPath, state.bytes);
      fs.writeFileSync(temporary, `${JSON.stringify(successor, null, 2)}\n`, "utf-8");

      expect(findDockerPublicationRecovery(state.root, state.journal.taskId)?.journal).toEqual(
        successor,
      );
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });
});
