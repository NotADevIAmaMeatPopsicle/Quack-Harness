import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { parsePrepGateResult } from "../../src/monitor/prep-job-result";

const result = { schemaValid: true, schemaErrors: [], depthScore: 4.9, depthReady: true,
  deficiencies: [], outcome: "pass", contentHash: "a".repeat(64), schemaPolicyHash: "b".repeat(64) };
const browser: { QuackPrepJobs?: { validResult(value: unknown): boolean; passes(value: unknown): boolean } } = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../src/monitor/public/prep-jobs.js"), "utf8"), { window: browser });

describe("browser and server prep contract parity", () => {
  test.each<[string, unknown, boolean, boolean]>([
    ["pass", result, true, true],
    ["enriched", { ...result, outcome: "enriched" }, true, true],
    ["below threshold", { ...result, depthScore: 4.6 }, true, false],
    ["at threshold", { ...result, depthScore: 4.7 }, true, true],
    ["zero schema rejection", { ...result, schemaValid: false, schemaErrors: ["missing"], depthReady: false, depthScore: 0, outcome: "rejected" }, true, false],
    ["depth rejection", { ...result, depthReady: false, depthScore: 3, outcome: "rejected" }, true, false],
    ["uppercase content hash", { ...result, contentHash: "A".repeat(64) }, true, true],
    ["uppercase policy hash", { ...result, schemaPolicyHash: "B".repeat(64) }, false, false],
    ["invalid content hash", { ...result, contentHash: "bad" }, false, false],
    ["null", null, false, false],
    ["array", [], false, false],
    ["array with attached fields", Object.assign([], result), false, false],
    ["missing fields", {}, false, false],
    ["error payload", { ...result, error: "failed" }, false, false],
    ["truthy schema flag", { ...result, schemaValid: "yes" }, false, false],
    ["non-string diagnostics", { ...result, deficiencies: [1] }, false, false],
    ["inconsistent outcome", { ...result, outcome: "rejected" }, false, false],
    ["inconsistent schema errors", { ...result, schemaErrors: ["failure"] }, false, false],
    ["negative score", { ...result, depthScore: -1 }, false, false],
    ["above range", { ...result, depthScore: 6 }, false, false],
    ["NaN", { ...result, depthScore: NaN }, false, false],
    ["infinite score", { ...result, depthScore: Infinity }, false, false],
  ])("%s", (_name, value, valid, passes) => {
    if (valid) expect(() => parsePrepGateResult(value)).not.toThrow();
    else expect(() => parsePrepGateResult(value)).toThrow();
    expect(Boolean(browser.QuackPrepJobs!.validResult(value))).toBe(valid);
    expect(Boolean(browser.QuackPrepJobs!.passes(value))).toBe(passes);
  });
});
