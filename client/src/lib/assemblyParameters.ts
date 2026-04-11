import type { AssemblyParameterDefinition } from "./types";

export type ParameterFormValues = Record<string, string | boolean>;

function parseJsonValue(input: string | null | undefined): unknown {
  if (!input) {
    return undefined;
  }

  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

export function getEstimatorParameterDefinitions(
  definitions: AssemblyParameterDefinition[] | undefined,
): AssemblyParameterDefinition[] {
  if (!definitions) {
    return [];
  }

  return definitions
    .filter((definition) => definition.estimatorFacing)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.key.localeCompare(b.key);
    });
}

export function getEnumOptions(definition: AssemblyParameterDefinition): string[] {
  const parsed = parseJsonValue(definition.enumOptionsJson);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((value): value is string => typeof value === "string");
}

export function getInitialParameterFormValues(
  definitions: AssemblyParameterDefinition[] | undefined,
): ParameterFormValues {
  const ordered = getEstimatorParameterDefinitions(definitions);
  const values: ParameterFormValues = {};

  for (const definition of ordered) {
    const parsedDefault = parseJsonValue(definition.defaultValueJson);

    if (definition.valueType === "boolean") {
      values[definition.key] = typeof parsedDefault === "boolean" ? parsedDefault : false;
      continue;
    }

    if (typeof parsedDefault === "number" || typeof parsedDefault === "string") {
      values[definition.key] = String(parsedDefault);
      continue;
    }

    values[definition.key] = "";
  }

  return values;
}

export function validateParameterForm(
  definitions: AssemblyParameterDefinition[] | undefined,
  values: ParameterFormValues,
): Record<string, string> {
  const ordered = getEstimatorParameterDefinitions(definitions);
  const errors: Record<string, string> = {};

  for (const definition of ordered) {
    const value = values[definition.key];

    if (definition.valueType === "boolean") {
      continue;
    }

    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
      if (definition.required) {
        errors[definition.key] = "Required";
      }
      continue;
    }

    if (definition.valueType === "integer" || definition.valueType === "number") {
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) {
        errors[definition.key] = "Must be a number";
        continue;
      }
      if (definition.valueType === "integer" && !Number.isInteger(numeric)) {
        errors[definition.key] = "Must be a whole number";
        continue;
      }
      if (definition.minValue !== null && definition.minValue !== undefined && numeric < definition.minValue) {
        errors[definition.key] = `Minimum ${definition.minValue}`;
      }
      if (definition.maxValue !== null && definition.maxValue !== undefined && numeric > definition.maxValue) {
        errors[definition.key] = `Maximum ${definition.maxValue}`;
      }
    }

    if (definition.valueType === "enum") {
      const options = getEnumOptions(definition);
      if (options.length > 0 && !options.includes(normalized)) {
        errors[definition.key] = "Invalid option";
      }
    }
  }

  return errors;
}

export function serializeParameterPayload(
  definitions: AssemblyParameterDefinition[] | undefined,
  values: ParameterFormValues,
): Record<string, unknown> {
  const ordered = getEstimatorParameterDefinitions(definitions);
  const payload: Record<string, unknown> = {};

  for (const definition of ordered) {
    const rawValue = values[definition.key];

    if (definition.valueType === "boolean") {
      payload[definition.key] = Boolean(rawValue);
      continue;
    }

    const normalized = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!normalized) {
      continue;
    }

    if (definition.valueType === "integer") {
      payload[definition.key] = Number.parseInt(normalized, 10);
      continue;
    }

    if (definition.valueType === "number") {
      payload[definition.key] = Number(normalized);
      continue;
    }

    payload[definition.key] = normalized;
  }

  return payload;
}
