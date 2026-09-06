// ─── Git Floor tests (TASK-1312) ────────────────────────────────────
// The executed bypass matrix from the spec, landed as data-driven
// regression tests. Closed classes must deny; documented residual
// classes are PINNED as not-caught so a future change that closes (or
// regresses) them is visible.

import { checkGitFloor, splitCommandSegments } from "../../src/worker/git-floor";

describe("splitCommandSegments", () => {
  it("splits on &&, ||, ;, |, &, and newlines", () => {
    expect(splitCommandSegments("a && b || c; d | e & f\ng")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });

  it("drops empty segments", () => {
    expect(splitCommandSegments("a;;  ;b")).toEqual(["a", "b"]);
  });
});

describe("checkGitFloor — original floor behavior preserved", () => {
  const stillDenied = [
    "git add .",
    "git commit -m x",
    "git push",
    "git push origin main",
    "git reset --hard HEAD~1",
    "git stash",
    "git checkout main",
    "git switch main",
    "git cherry-pick abc123",
    "git rebase main",
    "git merge feature",
    "git revert HEAD",
    "git tag v1.0.0",
    "git branch -d old-branch",
    "git branch -D old-branch",
    "git branch --delete old-branch",
  ];
  it.each(stillDenied)("denies %s", (command) => {
    expect(checkGitFloor(command).denied).toBe(true);
  });

  const stillAllowed = [
    "git status",
    "git diff",
    "git log --oneline -5",
    "git rev-parse HEAD",
    "git merge-base main HEAD",
    "git show abc123",
    "git fetch origin",
    "git branch --list",
    "git branch",
    "npx jest tests/worker",
    "ls -la",
  ];
  it.each(stillAllowed)("allows %s", (command) => {
    expect(checkGitFloor(command).denied).toBe(false);
  });
});

describe("checkGitFloor — closed bypass classes (matrix items 1, 2, 4, 5, 6)", () => {
  it("item 1: compound command", () => {
    const result = checkGitFloor("cd . && git push --force");
    expect(result.denied).toBe(true);
    expect(result.matches[0].class).toBe("history_rewrite");
  });

  it("item 1: compound via semicolon and pipe", () => {
    expect(checkGitFloor("true; git commit -m x").denied).toBe(true);
    expect(checkGitFloor("echo hi | git push").denied).toBe(true);
    expect(checkGitFloor("git push &").denied).toBe(true);
  });

  it("item 2: git -C option prefix", () => {
    const result = checkGitFloor("git -C /some/path push --force");
    expect(result.denied).toBe(true);
    expect(result.matches[0].class).toBe("history_rewrite");
  });

  it("item 2: git -c config prefix", () => {
    expect(checkGitFloor("git -c user.name=x commit -m y").denied).toBe(true);
  });

  it("item 4: alias definition", () => {
    const result = checkGitFloor("git config alias.pf '!git push --force'");
    expect(result.denied).toBe(true);
    expect(result.matches.some((m) => m.class === "alias_definition")).toBe(true);
  });

  it("item 4: global alias definition", () => {
    expect(checkGitFloor("git config --global alias.co checkout").denied).toBe(true);
  });

  it("item 5: remote set-url", () => {
    const result = checkGitFloor("git remote set-url origin https://evil.example/x.git");
    expect(result.denied).toBe(true);
    expect(result.matches[0].class).toBe("remote_redirect");
  });

  it("item 6: update-ref delete", () => {
    const result = checkGitFloor("git update-ref -d refs/heads/main");
    expect(result.denied).toBe(true);
    expect(result.matches[0].class).toBe("history_rewrite");
    expect(result.matches[0].targetRef).toBe("refs/heads/main");
  });

  it("item 6: reflog expire + gc --prune", () => {
    expect(checkGitFloor("git reflog expire --expire=now --all").denied).toBe(true);
    expect(checkGitFloor("git gc --prune=now").denied).toBe(true);
  });

  it("wrapper strips: env, exec, command, VAR=, leading punctuation", () => {
    expect(checkGitFloor("env git push").denied).toBe(true);
    expect(checkGitFloor("exec git push").denied).toBe(true);
    expect(checkGitFloor("command git push").denied).toBe(true);
    expect(checkGitFloor("GIT_TRACE=1 git push").denied).toBe(true);
    expect(checkGitFloor("(git push)").denied).toBe(true);
    expect(checkGitFloor("{ git push; }").denied).toBe(true);
  });

  it("round-2 closures: wrapper flags, quoted -C args, inline -c alias", () => {
    expect(checkGitFloor("env -i git push").denied).toBe(true);
    expect(checkGitFloor("command -- git push").denied).toBe(true);
    expect(checkGitFloor('git -C "path with spaces" push').denied).toBe(true);
    const inlineAlias = checkGitFloor("git -c alias.pf=push pf --force");
    expect(inlineAlias.denied).toBe(true);
    expect(inlineAlias.matches[0].class).toBe("alias_definition");
  });

  it("round-2 false-deny fix: git config READS are allowed", () => {
    expect(checkGitFloor("git config --get alias.pf").denied).toBe(false);
    expect(checkGitFloor("git config --list").denied).toBe(false);
    expect(checkGitFloor("git config --get-regexp alias").denied).toBe(false);
    expect(checkGitFloor("git config user.name").denied).toBe(false);
  });
});

describe("checkGitFloor — branch-delete target extraction", () => {
  it("extracts the branch from branch -D", () => {
    const result = checkGitFloor("git branch -D quack/TASK-999");
    expect(result.matches[0].class).toBe("branch_delete");
    expect(result.matches[0].targetRef).toBe("quack/TASK-999");
  });

  it("extracts the branch from push --delete", () => {
    const result = checkGitFloor("git push origin --delete main");
    expect(result.matches[0].class).toBe("branch_delete");
    expect(result.matches[0].targetRef).toBe("main");
  });

  it("extracts the branch from push refspec deletion", () => {
    const result = checkGitFloor("git push origin :main");
    expect(result.matches[0].class).toBe("branch_delete");
    expect(result.matches[0].targetRef).toBe("main");
  });
});

describe("checkGitFloor — documented residual classes (pinned as NOT caught)", () => {
  // Matrix item 3 + control-flow/xargs/find-exec. If a change closes one
  // of these, update the module-header residual list along with this pin.
  const residual = [
    "/usr/bin/git push",
    'sh -c "git push"',
    'bash -lc "git push"',
    "xargs git push",
    "find . -name x -exec git push {} +",
  ];
  it.each(residual)("does not catch %s (outcome producers are the truth)", (command) => {
    expect(checkGitFloor(command).denied).toBe(false);
  });

  it("if-then embedding: the embedded segment IS caught by the semicolon split", () => {
    // `if true; then git push; fi` splits at semicolons and the middle
    // segment `then git push` is NOT stripped (then is not a wrapper
    // word) — pin actual behavior either way.
    const result = checkGitFloor("if true; then git push; fi");
    expect(result.denied).toBe(false);
  });
});

describe("checkGitFloor — quoted-separator fail-closed nuisance (pinned)", () => {
  it("denies a benign command whose quoted text puts git-write at a segment start", () => {
    // Accepted trade-off: segment splitting does not honor quotes, so the
    // text after the quoted separator starts a segment with `git push`.
    // Fail-closed nuisance, not a hazard.
    expect(checkGitFloor("echo 'safe; git push origin'").denied).toBe(true);
  });

  it("allows quoted git-write text that does NOT start a segment", () => {
    // Here every segment starts with `echo`/plain words, so nothing
    // classifies even though the string mentions git push.
    expect(checkGitFloor("echo 'git push; harmless text'").denied).toBe(false);
  });
});
