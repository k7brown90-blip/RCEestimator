// Stub — assembly system removed. TODO: clean up VisitWorkspacePage references.

export type ParameterFormValues = Record<string, unknown>;

interface ParamDef {
  key: string;
  label?: string;
  valueType?: string;
  enumValues?: string;
  sortOrder?: number;
}

export function getEstimatorParameterDefinitions(defs?: ParamDef[] | null): ParamDef[] {
  return defs ?? [];
}

export function getInitialParameterFormValues(_defs: ParamDef[]): ParameterFormValues {
  return {};
}

export function validateParameterForm(_defs: ParamDef[], _values: ParameterFormValues): Record<string, string> {
  return {};
}

export function serializeParameterPayload(_defs: ParamDef[], _values: ParameterFormValues): Record<string, unknown> {
  return {};
}

export function getEnumOptions(_def: ParamDef): string[] {
  return [];
}
