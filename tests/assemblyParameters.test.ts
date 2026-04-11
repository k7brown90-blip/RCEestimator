import { describe, expect, it } from "vitest";
import {
  getEstimatorParameterDefinitions,
  getInitialParameterFormValues,
  serializeParameterPayload,
  validateParameterForm,
} from "../client/src/lib/assemblyParameters";
import type { AssemblyParameterDefinition } from "../client/src/lib/types";

const defs: AssemblyParameterDefinition[] = [
  {
    id: "d1",
    templateId: "t1",
    key: "run_length",
    label: "Run Length",
    valueType: "number",
    required: true,
    defaultValueJson: "25",
    enumOptionsJson: null,
    estimatorFacing: true,
    sortOrder: 2,
    minValue: 5,
    maxValue: 150,
  },
  {
    id: "d2",
    templateId: "t1",
    key: "wall_type",
    label: "Wall Type",
    valueType: "enum",
    required: true,
    defaultValueJson: '"finished_wall"',
    enumOptionsJson: '["open_framing","finished_wall"]',
    estimatorFacing: true,
    sortOrder: 1,
    minValue: null,
    maxValue: null,
  },
  {
    id: "d3",
    templateId: "t1",
    key: "internal_only",
    label: "Internal",
    valueType: "string",
    required: false,
    defaultValueJson: null,
    enumOptionsJson: null,
    estimatorFacing: false,
    sortOrder: 0,
    minValue: null,
    maxValue: null,
  },
  {
    id: "d4",
    templateId: "t1",
    key: "neutral_present",
    label: "Neutral Present",
    valueType: "boolean",
    required: false,
    defaultValueJson: "true",
    enumOptionsJson: null,
    estimatorFacing: true,
    sortOrder: 3,
    minValue: null,
    maxValue: null,
  },
];

describe("assembly parameter helper behavior", () => {
  it("uses estimator-facing definitions sorted by sortOrder", () => {
    const ordered = getEstimatorParameterDefinitions(defs);
    expect(ordered.map((d) => d.key)).toEqual(["wall_type", "run_length", "neutral_present"]);
  });

  it("prefills defaults for number, enum, and boolean", () => {
    const values = getInitialParameterFormValues(defs);
    expect(values.wall_type).toBe("finished_wall");
    expect(values.run_length).toBe("25");
    expect(values.neutral_present).toBe(true);
    expect((values as Record<string, unknown>).internal_only).toBeUndefined();
  });

  it("validates required and range constraints", () => {
    const errors = validateParameterForm(defs, {
      wall_type: "",
      run_length: "2",
      neutral_present: true,
    });

    expect(errors.wall_type).toMatch(/Required/i);
    expect(errors.run_length).toMatch(/Minimum 5/i);
  });

  it("serializes only known estimator-facing values", () => {
    const payload = serializeParameterPayload(defs, {
      wall_type: "open_framing",
      run_length: "42.5",
      neutral_present: false,
      internal_only: "should-not-send",
    });

    expect(payload).toEqual({
      wall_type: "open_framing",
      run_length: 42.5,
      neutral_present: false,
    });
  });
});
