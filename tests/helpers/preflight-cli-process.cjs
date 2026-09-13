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

// Only the expensive producer is replaced. The CLI, input checks, event writer,
// stdout pipe and process.exit are the real implementations in a native child.
const [projectRoot, optionsJson, reportPath] = process.argv.slice(2);
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith("/preflight/preflight-runner.js")) return {
    runPreflight: async (_task, _adapter, options) => {
      fs.writeFileSync(path.join(projectRoot, "producer-called.json"), JSON.stringify({ mode: options.mode, force: options.force }));
      options.events?.emit("preflight_start", { taskId: "TASK-1355" });
      options.events?.emit("preflight_complete", { taskId: "TASK-1355", cached: false, recommendDecomposition: false });
      return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    },
  };
  return originalLoad.call(this, request, parent, ...rest);
};
const { preflightCommand } = require(path.join(sourceRoot, "cli/preflight.ts"));
void preflightCommand("TASK-1355", { project: projectRoot, ...JSON.parse(optionsJson) });
