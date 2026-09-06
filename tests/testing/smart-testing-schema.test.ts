import { describe, it, expect } from "@jest/globals";
import { SmartTestingConfigSchema } from "../../src/core/adapter-schema.js";

describe("SmartTestingConfigSchema", () => {
  it("accepts valid config with all fields", () => {
    const input = {
      enabled: true,
      mode: "related",
      baselineEnabled: true,
      failOnPreExisting: false,
      outputDir: ".quack/test-results",
    };

    const result = SmartTestingConfigSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("applies defaults when fields are missing", () => {
    const result = SmartTestingConfigSchema.parse({});

    expect(result).toEqual({
      enabled: true,
      mode: "related",
      baselineEnabled: true,
      failOnPreExisting: false,
      outputDir: ".quack/test-results",
    });
  });

  it("accepts mode 'full'", () => {
    const result = SmartTestingConfigSchema.parse({ mode: "full" });
    expect(result?.mode).toBe("full");
  });

  it("returns undefined when input is undefined (optional schema)", () => {
    const result = SmartTestingConfigSchema.parse(undefined);
    expect(result).toBeUndefined();
  });
});
