"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { PUBLIC_RESOURCES, REQUIRED_FILES, assertPackagedRuntime } = require("./package-assets.cjs");

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          request.destroy(new Error("Package smoke response exceeded 8 MiB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
      );
    });
    request.setTimeout(10_000, () =>
      request.destroy(new Error("Package smoke request timed out.")),
    );
    request.on("error", reject);
  });
}

async function main() {
  const [rootArg, expectedCommit] = process.argv.slice(2);
  assert(
    rootArg && path.isAbsolute(rootArg),
    "Supply the absolute installed quack-harness package path.",
  );
  assert(
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedCommit ?? ""),
    "Supply the full expected source commit.",
  );
  const root = fs.realpathSync(rootArg);
  const { manifest, build, uiReferences } = assertPackagedRuntime(root);
  assert.equal(manifest.name, "quack-harness");
  assert.equal(manifest.license, "AGPL-3.0-only");
  assert.equal(build.commit, expectedCommit);
  for (const excluded of ["src", "tests", "frontend", ".quack", ".agents", ".claude", ".dev"]) {
    assert(!fs.existsSync(path.join(root, excluded)), `Unexpected packed path: ${excluded}`);
  }

  const requireInstalled = createRequire(path.join(root, "package.json"));
  const Database = requireInstalled("better-sqlite3");
  const database = new Database(":memory:");
  try {
    assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
  } finally {
    database.close();
  }

  const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-package-smoke-"));
  try {
    for (const argument of ["--help", "--version"]) {
      const result = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), argument], {
        cwd: unrelatedCwd,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      if (argument === "--version") assert.equal(result.stdout.trim(), manifest.version);
      else assert.match(result.stdout, /Usage:/u);
    }
  } finally {
    fs.rmSync(unrelatedCwd, { recursive: true, force: true });
  }

  const express = requireInstalled("express");
  const { RESOURCES, registerAgentResourcesRoutes } = requireInstalled(
    "./dist/monitor/routes/agent-resources.js",
  );
  assert.deepEqual(
    RESOURCES.map((resource) => resource.relativePath).sort(),
    [...PUBLIC_RESOURCES].sort(),
  );
  const app = express();
  registerAgentResourcesRoutes(app);
  app.use("/legacy", express.static(path.join(root, "dist", "monitor", "public")));
  app.use(express.static(path.join(root, "dist", "monitor", "ui")));
  app.get("*", (_request, response) =>
    response.sendFile(path.join(root, "dist", "monitor", "ui", "index.html")),
  );
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const listing = await get(`${base}/api/agent-resources`);
    assert.equal(listing.status, 200);
    const resources = JSON.parse(listing.body.toString("utf8")).resources;
    assert.equal(resources.length, PUBLIC_RESOURCES.length);
    assert(resources.every((resource) => resource.available === true));
    for (const resource of RESOURCES) {
      for (const suffix of ["", "/download"]) {
        const response = await get(`${base}/api/agent-resources/${resource.id}${suffix}`);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, fs.readFileSync(path.join(root, resource.relativePath)));
      }
    }
    for (const route of ["/", "/tasks", "/legacy/"]) {
      const response = await get(`${base}${route}`);
      assert.equal(response.status, 200);
      const ui = route === "/legacy/" ? "public" : "ui";
      assert.deepEqual(
        response.body,
        fs.readFileSync(path.join(root, "dist", "monitor", ui, "index.html")),
      );
    }
    for (const reference of uiReferences) {
      const response = await get(`${base}/${reference}`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body,
        fs.readFileSync(path.join(root, "dist", "monitor", "ui", reference)),
      );
    }
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  console.log(
    JSON.stringify({
      version: manifest.version,
      commit: build.commit,
      requiredFiles: REQUIRED_FILES.length,
      resources: PUBLIC_RESOURCES.length,
      uiReferences: uiReferences.length,
      nativeSqlite: true,
      naturalCompletion: true,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
