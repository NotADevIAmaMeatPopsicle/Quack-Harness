/* A test-only child loader. Compile checked-in TypeScript in memory; never use
 * potentially stale dist files or write compiler output into the checkout. */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const sourceRoot = path.join(root, "src") + path.sep;
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (
    parent?.filename.startsWith(sourceRoot) &&
    request.startsWith(".") &&
    request.endsWith(".js")
  ) {
    const candidate = path.resolve(path.dirname(parent.filename), request.slice(0, -3) + ".ts");
    if (candidate.startsWith(sourceRoot) && fs.existsSync(candidate)) request = candidate;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  if (!filename.startsWith(sourceRoot))
    throw new Error("Only Quack source may use this test loader");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { QuackDB } = require(path.join(sourceRoot, "db/quack-db.ts"));
const { recordVerification, regenerateProjection } = require(
  path.join(sourceRoot, "monitor/verification-store.ts"),
);
const [projectRoot, mode, taskId] = process.argv.slice(2);
const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
const send = (type) => process.send?.({ type });
send("ready");
process.once("message", () => {
  send("attempting");
  const operation =
    mode === "regenerate"
      ? regenerateProjection({ projectRoot, db })
      : recordVerification(
          { projectRoot, db },
          {
            taskId,
            verdict: "VERIFIED",
            commitSha: "def5678",
            method: "api",
            criteriaChecked: 1,
            criteriaPassed: 1,
            verifiedAt: "2026-05-02",
            updatedAt: "2026-05-02T13:00:00.000Z",
          },
          { afterProjectionReadForTest: () => send("projection_read") },
        );
  operation
    .then(
      () => send("done"),
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    )
    .finally(() => {
      db.close();
      process.disconnect?.();
    });
});
