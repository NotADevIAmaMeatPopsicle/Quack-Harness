// ─── Git Floor ──────────────────────────────────────────────────────
// Hardened deny-floor evaluation for worker Bash commands (TASK-1312).
// Replaces the inline FORBIDDEN_GIT_PATTERNS in agent-worker.ts with a
// pure, testable evaluator that also classifies WHAT was attempted so
// denials become visible safety facts instead of vanishing into the
// SDK transcript.
//
// Coverage (closed bypass classes from the TASK-1312 audit matrix):
//   - compound commands (`cd x && git push`) via segment splitting
//   - option prefixes (`git -C <p> push`, `git -c k=v push`)
//   - cheap wrappers (`env git push`, `exec git push`, `VAR=x git push`,
//     leading `(` / `{`)
//   - alias definition (`git config alias.x '!git push'`)
//   - remote redirection (`git remote set-url ...`)
//   - plumbing history destruction (`update-ref`, `reflog expire`,
//     `gc --prune`)
//
// DOCUMENTED RESIDUAL (not closed here — outcome verification via the
// seal-conformance producer and the dispatcher-side branch guard are the
// truth for these): alternate git binaries (`/usr/bin/git`), nested
// shells (`sh -c "git push"`), control-flow embedding
// (`if true; then git push; fi`), `xargs git push`, `find -exec git push`,
// and exotic quoting the whitespace tokenizer cannot see through (the
// `-C`/`-c` argument consumer is quote-AWARE but not a shell parser).
// `git config` READS (`--get`, `--list`) are allowed; only alias-touching
// writes deny. Segment splitting is deliberately NOT a shell parser:
// separators inside quotes will split anyway, which can deny benign
// commands that merely QUOTE git-write text at a segment start (accepted
// fail-closed nuisance, pinned by test).

export type GitFloorClass =
  | "write"
  | "branch_delete"
  | "history_rewrite"
  | "remote_redirect"
  | "alias_definition";

export interface GitFloorMatch {
  /** The command segment that matched (trimmed, truncated to 200 chars). */
  segment: string;
  /** The git verb that triggered the match. */
  verb: string;
  class: GitFloorClass;
  /** Target ref/branch when cheaply parseable (push --delete X, branch -D X). */
  targetRef?: string;
}

export interface GitFloorResult {
  denied: boolean;
  matches: GitFloorMatch[];
}

const WRITE_VERBS = new Set([
  "add",
  "commit",
  "push",
  "reset",
  "stash",
  "checkout",
  "switch",
  "cherry-pick",
  "rebase",
  "merge",
  "revert",
  "tag",
]);

/** Wrapper words stripped from the front of a segment before the git test. */
const WRAPPER_WORDS = new Set(["env", "exec", "command", "nohup", "sudo"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const GIT_FLOOR_REASON =
  "Quack auto-commits your changes after the worker exits via the post-worker output sealer. " +
  "Do not run git write commands (including via compound commands, `git -C`, aliases, `remote set-url`, " +
  "or ref plumbing); they are intercepted to keep one canonical writer. " +
  "Read commands (git status/diff/log via MCP) are available; git rev-parse / merge-base / show / fetch " +
  "are also allowed via Bash.";

/**
 * Split a raw Bash command string into best-effort segments.
 * `&&` and `||` are normalized to `;` first, then we split on the
 * single-character separators `;`, `|`, `&`, and newlines. Quoting is
 * deliberately not honored (see module header).
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .replace(/\|\||&&/g, ";")
    .split(/[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Strip leading grouping punctuation, env assignments, wrapper words,
 * and wrapper flags (`env -i git push`, `command -- git push`) — round-2
 * closure of the wrapper-flag evasion.
 */
function stripWrappers(tokens: string[]): string[] {
  const out = [...tokens];
  let afterWrapper = false;
  while (out.length > 0) {
    const head = out[0];
    const stripped = head.replace(/^[({]+/, "");
    if (stripped !== head) {
      if (stripped.length === 0) {
        out.shift();
      } else {
        out[0] = stripped;
      }
      continue;
    }
    if (ENV_ASSIGNMENT.test(head) || WRAPPER_WORDS.has(head)) {
      out.shift();
      afterWrapper = true;
      continue;
    }
    if (afterWrapper && head.startsWith("-")) {
      // Wrapper flags (env -i, command --, nohup -p ...) — drop them so
      // the git test still sees the real command.
      out.shift();
      continue;
    }
    break;
  }
  return out;
}

/**
 * Skip git's pre-verb options. `-C` and `-c` consume a following argument
 * (quote-aware: `-C "path with spaces"` consumes through the closing
 * quote — round-2 closure); `--git-dir=x` style inline options are
 * skipped as-is. Returns the remaining tokens plus any alias definition
 * smuggled through an inline `-c alias.x=...` (round-2 closure).
 */
function skipGitOptions(tokens: string[]): {
  rest: string[];
  inlineAliasDefinition: boolean;
} {
  const out = [...tokens];
  let inlineAliasDefinition = false;
  const consumeArg = (): void => {
    if (out.length === 0) return;
    const first = out.shift() as string;
    const quote = first.startsWith('"') ? '"' : first.startsWith("'") ? "'" : null;
    if (quote && !first.endsWith(quote)) {
      while (out.length > 0) {
        const next = out.shift() as string;
        if (next.endsWith(quote)) break;
      }
    }
  };
  while (out.length > 0 && out[0].startsWith("-")) {
    const opt = out[0];
    out.shift();
    if (opt.startsWith("-c") && /alias\./.test(opt)) {
      inlineAliasDefinition = true;
    }
    if (opt === "-C" || opt === "-c") {
      if (out.length > 0 && /^["']?alias\./.test(out[0])) {
        inlineAliasDefinition = true;
      }
      consumeArg();
    }
  }
  return { rest: out, inlineAliasDefinition };
}

function truncateSegment(segment: string): string {
  return segment.length > 200 ? `${segment.slice(0, 200)}…` : segment;
}

/** git config flags that make the invocation a READ, not a write. */
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

function classifySegment(segment: string): GitFloorMatch[] {
  const tokens = stripWrappers(segment.split(/\s+/).filter(Boolean));
  if (tokens.length === 0 || tokens[0] !== "git") return [];

  const { rest: afterGit, inlineAliasDefinition } = skipGitOptions(tokens.slice(1));
  const base = { segment: truncateSegment(segment) };
  if (inlineAliasDefinition) {
    // `git -c alias.pf=push pf` defines-and-invokes in one command.
    return [{ ...base, verb: "config", class: "alias_definition" }];
  }
  if (afterGit.length === 0) return [];
  // Trailing grouping/quote punctuation clings to tokens because the
  // splitter does not honor quotes — `(git push)` tokenizes the verb as
  // `push)`. Strip it so the verb and args match cleanly.
  const clean = (token: string): string => token.replace(/['")}]+$/, "");
  const verb = clean(afterGit[0]);
  const args = afterGit.slice(1).map(clean);

  if (verb === "branch") {
    const deleteFlag = args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete");
    if (deleteFlag) {
      // One fact per named target — a protected ref must not hide among
      // several (round-2 closure).
      const targets = args.filter((arg) => !arg.startsWith("-"));
      if (targets.length === 0) {
        return [{ ...base, verb, class: "branch_delete" }];
      }
      return targets.map((targetRef) => ({
        ...base,
        verb,
        class: "branch_delete" as const,
        targetRef,
      }));
    }
    return [];
  }

  if (verb === "push") {
    const nonFlags = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith(":"));
    const colonRefs = args.filter((arg) => arg.startsWith(":") && arg.length > 1);
    const hasDelete = args.some((arg) => arg === "--delete" || arg === "-d");
    if (hasDelete) {
      // `git push origin --delete a b` — everything after the remote is
      // a target; one fact per target.
      const targets = nonFlags.slice(1);
      const list = targets.length > 0 ? targets : nonFlags;
      return list.map((targetRef) => ({
        ...base,
        verb,
        class: "branch_delete" as const,
        targetRef,
      }));
    }
    if (colonRefs.length > 0) {
      return colonRefs.map((ref) => ({
        ...base,
        verb,
        class: "branch_delete" as const,
        targetRef: ref.slice(1),
      }));
    }
    const force = args.some(
      (arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease"),
    );
    if (force) {
      // Parse the destination when present (`push --force origin <ref>`)
      // so downstream promotion can distinguish a protected target from
      // a task branch (round-2 precision fix).
      const targetRef = nonFlags.length >= 2 ? nonFlags[nonFlags.length - 1] : undefined;
      return [
        {
          ...base,
          verb,
          class: "history_rewrite",
          ...(targetRef !== undefined ? { targetRef } : {}),
        },
      ];
    }
    return [{ ...base, verb, class: "write" }];
  }

  if (verb === "update-ref") {
    const ref = args.find((arg) => arg.startsWith("refs/"));
    return [{ ...base, verb, class: "history_rewrite", ...(ref ? { targetRef: ref } : {}) }];
  }
  if (verb === "reflog" && args[0] === "expire") {
    return [{ ...base, verb, class: "history_rewrite" }];
  }
  if (verb === "gc" && args.some((arg) => arg.startsWith("--prune"))) {
    return [{ ...base, verb, class: "history_rewrite" }];
  }
  if (verb === "remote" && args[0] === "set-url") {
    return [{ ...base, verb, class: "remote_redirect" }];
  }
  if (verb === "config") {
    const isRead = args.some((arg) => CONFIG_READ_FLAGS.has(arg));
    const touchesAlias = args.some((arg) => /^["']?alias\./.test(arg));
    if (!isRead && touchesAlias) {
      return [{ ...base, verb, class: "alias_definition" }];
    }
    return [];
  }

  if (WRITE_VERBS.has(verb)) {
    return [{ ...base, verb, class: "write" }];
  }
  return [];
}

/**
 * Evaluate a raw Bash command against the git write floor.
 * Denies when any segment classifies; returns every match so denials can
 * be recorded as safety facts (attempt visibility).
 */
export function checkGitFloor(command: string): GitFloorResult {
  const matches: GitFloorMatch[] = [];
  for (const segment of splitCommandSegments(command)) {
    matches.push(...classifySegment(segment));
  }
  return { denied: matches.length > 0, matches };
}
