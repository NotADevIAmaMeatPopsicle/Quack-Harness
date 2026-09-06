import { TaskType } from "../../src/core/types";
import {
  buildDepthResponseExample,
  buildDepthResponseSchema,
  getTaskTypeDepthConfig,
} from "../../src/gate/depth-dimensions";

function assertValidJson(value: string): void {
  JSON.parse(value);
}

describe("depth-dimensions", () => {
  test("returns the expected thresholds for each task type", () => {
    expect(getTaskTypeDepthConfig(TaskType.Code).threshold).toBe(4.7);
    expect(getTaskTypeDepthConfig(TaskType.Architecture).threshold).toBe(3.5);
    expect(getTaskTypeDepthConfig(TaskType.Test).threshold).toBe(3.5);
    expect(getTaskTypeDepthConfig(TaskType.Documentation).threshold).toBe(3.0);
  });

  test("builds a type-aware schema for architecture tasks", () => {
    const schema = buildDepthResponseSchema(TaskType.Architecture) as {
      properties?: {
        scores?: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      };
    };

    expect(schema.properties?.scores?.properties).toEqual(
      expect.objectContaining({
        decision_points: { type: "number" },
        alternatives_coverage: { type: "number" },
        adr_template_compliance: { type: "number" },
        cross_reference_completeness: { type: "number" },
      }),
    );
    expect(schema.properties?.scores?.required).toEqual([
      "decision_points",
      "alternatives_coverage",
      "adr_template_compliance",
      "cross_reference_completeness",
    ]);
  });

  test("builds valid JSON examples without JS comments", () => {
    const architectureExample = buildDepthResponseExample(TaskType.Architecture);
    const documentationExample = buildDepthResponseExample(TaskType.Documentation);

    expect(() => assertValidJson(architectureExample)).not.toThrow();
    expect(() => assertValidJson(documentationExample)).not.toThrow();
    expect(architectureExample).not.toContain("//");
    expect(documentationExample).not.toContain("//");
  });
});
