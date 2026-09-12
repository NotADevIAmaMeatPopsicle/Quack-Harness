/* Test-only fresh-process harness. Production Git audits run before this exact
 * spawn-delivery substitution. No fixture URL is contacted and no runtime
 * switch or production implementation is changed. */
"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ORIGIN = "https://quack-publication.invalid/fixture/docker-e2e.git";
const TRANSPORTS = new Set([
  "clone",
  "fetch",
  "fetch-pack",
  "http-fetch",
  "http-push",
  "imap-send",
  "ls-remote",
  "pull",
  "push",
  "send-pack",
  "submodule",
]);
const LOCAL_COMMANDS = new Set([
  "config",
  "rev-parse",
  "check-ref-format",
  "show-ref",
  "merge-base",
  "update-ref",
  "hash-object",
  "cat-file",
  "worktree",
  "show",
  "log",
  "diff",
  "rev-list",
  "status",
  "add",
  "commit",
  "merge",
  "reset",
  "remote",
  "for-each-ref",
  "ls-files",
  "ls-tree",
  "read-tree",
  "write-tree",
  "diff-tree",
  "symbolic-ref",
  "--version",
]);
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.ok(["lost-response", "resume"].includes(input.phase));
const canonical = (value) => fs.realpathSync.native(value);
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const fixtureRoot = canonical(input.fixtureRoot);
const projectRoot = canonical(input.projectRoot);
const bareRoot = canonical(input.bareRoot);
assert.ok(samePath(projectRoot, path.join(fixtureRoot, "project")));
assert.ok(samePath(bareRoot, path.join(fixtureRoot, "origin.git")));
assert.match(input.taskId, /^TASK-\d+$/);
assert.equal(input.branch, `quack/${input.taskId}`);
const taskRef = `refs/heads/${input.branch}`;
const targetRef = "refs/heads/main";
const sourceOid = input.options.recovery.gitState.candidateHead;
assert.match(sourceOid, /^[a-f0-9]{40,64}$/i);
process.env.GH_HOST = "quack-publication.invalid";

// Load modules before replacing execFile. Native incarnation probes retain
// their real promisified implementation; Git's callback runner reads the
// child_process export when it launches each already-audited command.
const trusted = require(path.join(input.quackRoot, "dist/worker/trusted-executable.js"));
const publication = require(
  path.join(input.quackRoot, "dist/dispatcher/docker-host-publication.js"),
);
const realExecFile = cp.execFile;
const realExecFileSync = cp.execFileSync;
const gitExecutable = trusted.resolveTrustedExecutable("git", projectRoot, "Docker proof Git");
const gitEnvironment = trusted.buildTrustedGitEnvironment(gitExecutable);
const commonDir = canonical(path.join(projectRoot, ".git"));
const bareConfig = createHash("sha256")
  .update(fs.readFileSync(path.join(bareRoot, "config")))
  .digest("hex");
const deliveries = [];
let injected = false;

function git(cwd, args, optional = false) {
  try {
    return realExecFileSync(
      gitExecutable,
      ["-C", cwd, "-c", "core.hooksPath=" + require("node:os").devNull, ...args],
      {
        cwd: path.dirname(gitExecutable),
        env: gitEnvironment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    ).trim();
  } catch (error) {
    if (optional && error.status === 1) return undefined;
    throw error;
  }
}

function bareHead(ref) {
  return git(bareRoot, ["rev-parse", "--verify", "--quiet", ref], true);
}

function splitInvocation(args) {
  let index = 0;
  let cwd;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C") {
      assert.equal(cwd, undefined);
      cwd = args[index + 1];
      index += 2;
    } else if (arg === "-c") {
      assert.equal(typeof args[index + 1], "string");
      index += 2;
    } else if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      index += 1;
    } else {
      break;
    }
  }
  return { index, cwd, command: args.slice(index) };
}

function permitLocal(command) {
  assert.ok(LOCAL_COMMANDS.has(command[0]), `Unapproved fixture Git operation: ${command[0]}`);
  if (command[0] === "remote") assert.equal(command[1], "get-url");
}

function validateDelivery(args, options) {
  const call = splitInvocation(args);
  assert.ok(
    call.cwd &&
      samePath(
        canonical(git(call.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
        commonDir,
      ),
  );
  assert.equal(git(call.cwd, ["remote", "get-url", "origin"]), ORIGIN);
  assert.equal(git(call.cwd, ["remote", "get-url", "--push", "--all", "origin"]), ORIGIN);
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(path.join(bareRoot, "config")))
      .digest("hex"),
    bareConfig,
  );
  assert.ok(options.timeout > 0 && options.timeout <= 60_000);
  assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 1024 * 1024);
  assert.ok(samePath(options.cwd, path.dirname(gitExecutable)));
  const command = call.command;
  let targetIndex;
  let kind;
  let ref;
  if (command[0] === "ls-remote") {
    assert.equal(command.length, 4);
    assert.deepEqual(command.slice(0, 3), ["ls-remote", "--heads", ORIGIN]);
    assert.ok([taskRef, targetRef].includes(command[3]));
    targetIndex = 2;
    kind = "read";
    ref = command[3];
  } else if (command[0] === "fetch") {
    assert.equal(command.length, 3);
    assert.ok([ORIGIN, "origin"].includes(command[1]));
    assert.equal(command[2], "main:refs/remotes/origin/main");
    targetIndex = 1;
    kind = "fetch";
    ref = targetRef;
  } else if (command[0] === "push") {
    const journal = publication.readDockerPublicationRecovery(input.recoveryPath);
    assert.equal(journal.publicationId, input.options.recovery.publicationId);
    assert.equal(journal.gitState.candidateHead, sourceOid);
    if (command.length === 3 && command[2] === `${sourceOid}:${taskRef}`) {
      assert.equal(
        input.phase,
        "lost-response",
        "resume must adopt the real already-pushed candidate",
      );
      assert.equal(command[1], ORIGIN);
      assert.equal(git(projectRoot, ["rev-parse", journal.gitState.sealedRef]), sourceOid);
      assert.equal(git(projectRoot, ["rev-parse", taskRef]), sourceOid);
      targetIndex = 1;
      kind = "task-push";
      ref = taskRef;
    } else if (command.length === 4) {
      const prepared = journal.progress.preparedMerge;
      assert.ok(prepared);
      assert.equal(prepared.candidateHead, sourceOid);
      assert.deepEqual(command, [
        "push",
        `--force-with-lease=${targetRef}:${prepared.targetHead}`,
        ORIGIN,
        `${prepared.resultHead}:${targetRef}`,
      ]);
      assert.equal(git(projectRoot, ["rev-parse", prepared.preparedRef]), prepared.resultHead);
      assert.equal(bareHead(targetRef), prepared.targetHead);
      targetIndex = 2;
      kind = "merge-push";
      ref = targetRef;
    } else {
      assert.equal(command.length, 3);
      assert.equal(command[1], ORIGIN); // The real trusted runner freezes origin to this URL.
      const head = git(call.cwd, ["rev-parse", "HEAD"]);
      assert.deepEqual(command, ["push", ORIGIN, `${head}:${targetRef}`]);
      assert.ok(
        samePath(canonical(call.cwd), path.join(projectRoot, ".quack", "tmp-status-update")),
      );
      const before = bareHead(targetRef);
      assert.equal(before, journal.progress.mergeCommitSha);
      assert.equal(git(call.cwd, ["rev-parse", `${head}^`]), before);
      const taskPath = `docs/tasks/${input.taskId}.md`;
      assert.equal(git(call.cwd, ["diff", "--name-only", before, head]), taskPath);
      const oldText = git(call.cwd, ["show", `${before}:${taskPath}`]);
      const newText = git(call.cwd, ["show", `${head}:${taskPath}`]);
      assert.notEqual(oldText, newText);
      assert.equal(newText, oldText.replace("**Status:** READY", "**Status:** COMPLETE"));
      targetIndex = 1;
      kind = "status-push";
      ref = targetRef;
    }
  } else {
    throw new Error(`Unapproved Docker-proof Git transport: ${command[0]}`);
  }
  const mapped = [...args];
  mapped[call.index + targetIndex] = bareRoot;
  return { mapped, kind, ref, before: bareHead(ref), command };
}

async function main() {
  assert.ok(
    samePath(
      canonical(input.options.recovery.rootDir),
      path.dirname(canonical(input.recoveryPath)),
    ),
  );
  // Exercise the real bare-path and configuration audit before installing the
  // delivery substitution. This preflight is explicitly read-only and local.
  const preflight = await trusted.runTrustedGitResult(
    projectRoot,
    ["ls-remote", "--heads", bareRoot, targetRef],
    {
      timeoutMs: 15_000,
      maxBuffer: 1024 * 1024,
      trustedLocalReadRemotePaths: [bareRoot],
    },
  );
  assert.equal(preflight.exitCode, 0, preflight.stderr);
  assert.equal(git(bareRoot, ["rev-parse", "--is-bare-repository"]), "true");

  cp.execFile = function (executable, args, options, callback) {
    if (/^gh(?:\.exe)?$/i.test(path.basename(executable)))
      throw new Error("GitHub CLI is outside this local proof");
    if (!/^git(?:\.exe)?$/i.test(path.basename(executable)))
      return realExecFile.apply(this, arguments);
    assert.ok(samePath(executable, gitExecutable), "only the audited Git executable is permitted");
    const invocation = splitInvocation(args);
    if (!TRANSPORTS.has(invocation.command[0])) {
      permitLocal(invocation.command);
      return realExecFile.apply(this, arguments);
    }
    assert.equal(typeof callback, "function");
    const delivery = validateDelivery(args, options); // Throws; never falls back to network.
    return realExecFile.call(
      this,
      executable,
      delivery.mapped,
      options,
      (error, stdout, stderr) => {
        const injectResponseLoss =
          !error && delivery.kind === "task-push" && input.phase === "lost-response" && !injected;
        const record = {
          kind: delivery.kind,
          auditedArgs: args,
          mappedArgs: delivery.mapped,
          before: delivery.before ?? null,
          after: bareHead(delivery.ref) ?? null,
          exitCode: error ? error.code : 0,
          injectedLostResponse: injectResponseLoss,
        };
        deliveries.push(record);
        fs.appendFileSync(input.transportLog, JSON.stringify(record) + "\n");
        if (injectResponseLoss) {
          injected = true;
          const lost = new Error("Injected lost response after exact local task push");
          lost.code = 1;
          callback(lost, stdout, lost.message);
        } else {
          callback(error, stdout, stderr);
        }
      },
    );
  };
  cp.execFileSync = function (executable, args) {
    if (/^gh(?:\.exe)?$/i.test(path.basename(executable)))
      throw new Error("GitHub CLI is outside this local proof");
    if (/^git(?:\.exe)?$/i.test(path.basename(executable))) {
      const command = splitInvocation(args).command;
      if (TRANSPORTS.has(command[0]))
        throw new Error("No synchronous Git transport is authorized in this proof");
      permitLocal(command);
    }
    return realExecFileSync.apply(this, arguments);
  };

  let result;
  let expectedFailure;
  try {
    if (input.phase === "lost-response") {
      try {
        await publication.publishDockerPromotedResult(
          input.taskId,
          projectRoot,
          input.branch,
          input.options,
        );
        throw new Error("Expected the injected lost-response failure");
      } catch (error) {
        assert.ok(
          injected &&
            error instanceof publication.DockerPublicationIncompleteError &&
            error.step === "push",
          String(error),
        );
        expectedFailure = { step: error.step, message: error.message };
      }
    } else {
      result = await publication.resumeDockerPromotedResult(projectRoot, input.recoveryPath);
      assert.equal(result.autoMerged, true);
      assert.equal(deliveries.filter((entry) => entry.kind === "task-push").length, 0);
      assert.equal(deliveries.filter((entry) => entry.kind === "merge-push").length, 1);
      assert.equal(deliveries.filter((entry) => entry.kind === "status-push").length, 1);
    }
  } finally {
    cp.execFile = realExecFile;
    cp.execFileSync = realExecFileSync;
  }
  const journal = publication.readDockerPublicationRecovery(input.recoveryPath);
  if (input.phase === "lost-response") {
    assert.equal(journal.state, "pending");
    assert.equal(journal.progress.pushedAt, undefined);
    assert.equal(journal.progress.mergedAt, undefined);
    assert.equal(bareHead(taskRef), sourceOid);
  } else {
    assert.equal(journal.state, "complete");
  }
  fs.writeFileSync(
    input.reportPath,
    JSON.stringify(
      {
        phase: input.phase,
        pid: process.pid,
        processNonce: randomUUID(),
        expectedFailure,
        result,
        journal,
        deliveries,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  cp.execFile = realExecFile;
  cp.execFileSync = realExecFileSync;
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
