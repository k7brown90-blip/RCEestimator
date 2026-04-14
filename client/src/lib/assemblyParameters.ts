// Stub — assembly system removed. TODO: clean up VisitWorkspacePage references.

export type ParameterFormValues = Record<string, unknown>;

interface ParamDef {
  key: string;
  label?: string;
  valueType?: string;
  enumValues?: string;
  sortOrder?: number;
  required?: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  helpText?: string | null;
  unit?: string | null;
}

export function getEstimatorParameterDefinitions(defs?: ParamDef[] | null): ParamDef[] {
  return defs ?? [];
}

export function getInitialParameterFormValues(_defs: ParamDef[] | undefined): ParameterFormValues {
  return {};
}

export function validateParameterForm(_defs: ParamDef[] | undefined, _values: ParameterFormValues): Record<string, string> {
  return {};
}

export function serializeParameterPayload(_defs: ParamDef[] | undefined, _values: ParameterFormValues): Record<string, unknown> {
  return {};
}

export function getEnumOptions(_def: ParamDef): string[] {
  return [];
}
