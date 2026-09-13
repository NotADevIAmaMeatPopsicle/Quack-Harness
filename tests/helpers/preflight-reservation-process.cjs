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
const { PreflightJobStore, createPreflightOwner } = require(path.join(sourceRoot, "monitor/preflight-job-store.ts"));
const [projectRoot, inputJson] = process.argv.slice(2);
process.send({ type: "ready" });
process.once("message", async () => {
  try {
    const owner = await createPreflightOwner(projectRoot);
    const result = await new PreflightJobStore(projectRoot, "fixture").reserve("TASK-1355", JSON.parse(inputJson), { owner, force: true });
    process.send({ type: "result", jobId: result.job.jobId, created: result.created });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
});
