export type JsonMap = Record<string, unknown>;

export type Totals = {
  labor: number;
  material: number;
  other: number;
  total: number;
};

export type ExpandedComponent = {
  componentType: "material" | "labor" | "permit" | "allowance" | "subcontract";
  code: string;
  description: string;
  quantity: number;
  unit?: string | null;
  unitCost: number;
  laborHours: number;
  laborRate: number;
  extendedCost: number;
};
