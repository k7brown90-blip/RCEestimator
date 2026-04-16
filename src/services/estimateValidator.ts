/**
 * Estimate Validator
 *
 * Runs reasonableness checks on a completed estimate before it's presented
 * to the customer. Catches hallucinated pricing, double-counted labor,
 * missing material costs, and out-of-range totals.
 *
 * Called by the AI agent after every estimate via the validate_estimate MCP tool.
 */

// ─── Reasonableness benchmarks ─────────────────────────────────────────────

// Material should be 15-20% of total job cost for typical residential work
const MATERIAL_RATIO_LOW = 0.08;
const MATERIAL_RATIO_HIGH = 0.45;

// Max labor hours per single EA item (anything above this is suspicious)
const MAX_SINGLE_ITEM_LABOR_HRS = 8.0;

// Support items shouldn't exceed this % of total estimate labor cost
const MAX_SUPPORT_LABOR_RATIO = 0.40;

// Snapshot vs catalog deviation threshold
const CATALOG_DEVIATION_THRESHOLD = 0.25; // 25%

// ─── Types ─────────────────────────────────────────────────────────────────

type ValidatorFlag = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  item?: string; // item code or ID for context
};

type EstimateItemForValidation = {
  id: string;
  atomicUnitCode: string;
  atomicUnitCategory: string;
  atomicUnitName: string;
  quantity: number;
  snapshotLaborHrs: number;
  snapshotLaborRate: number;
  snapshotMaterialCost: number;
  catalogMaterialCost: number; // from atomicUnit.baseMaterialCost
  laborCost: number;
  materialCost: number;
};

type SupportItemForValidation = {
  supportType: string;
  description: string;
  laborHrs: number;
  laborCost: number;
  otherCost: number;
  totalCost: number;
};

type ValidationInput = {
  items: EstimateItemForValidation[];
  supportItems: SupportItemForValidation[];
  materialMarkupPct: number;
};

type ValidationResult = {
  passed: boolean;
  flags: ValidatorFlag[];
  summary: {
    totalLaborHrs: number;
    totalLaborCost: number;
    totalMaterialBase: number;
    totalMaterialWithMarkup: number;
    totalSupportCost: number;
    grandTotal: number;
    itemCount: number;
    supportRatio: number;
    materialRatio: number;
  };
};

// ─── Validation logic ──────────────────────────────────────────────────────

export function validateEstimate(input: ValidationInput): ValidationResult {
  const flags: ValidatorFlag[] = [];
  const { items, supportItems, materialMarkupPct } = input;

  // ── 1. Catalog cost deviation + zero-material checks ────────────────────

  for (const item of items) {
    const snap = item.snapshotMaterialCost;
    const catalog = item.catalogMaterialCost;

    // Zero snapshot but catalog says it should have material
    if (snap === 0 && catalog > 0) {
      flags.push({
        severity: "error",
        code: "ZERO_MATERIAL",
        message: `${item.atomicUnitCode} "${item.atomicUnitName}" has $0 snapshot material but catalog shows $${catalog.toFixed(2)}. Snapshot may be stale or missing.`,
        item: item.atomicUnitCode,
      });
    }

    // Both have values — check deviation
    if (snap > 0 && catalog > 0) {
      const deviation = Math.abs(snap - catalog) / catalog;
      if (deviation > CATALOG_DEVIATION_THRESHOLD) {
        flags.push({
          severity: "warning",
          code: "CATALOG_DEVIATION",
          message: `${item.atomicUnitCode} snapshot material $${snap.toFixed(2)} differs from catalog $${catalog.toFixed(2)} by ${(deviation * 100).toFixed(0)}%. Verify pricing is current.`,
          item: item.atomicUnitCode,
        });
      }
    }
  }

  // ── 2. Labor hour checks ─────────────────────────────────────────────────

  for (const item of items) {
    const effectiveHrs = item.snapshotLaborHrs * item.quantity;
    if (item.snapshotLaborHrs > MAX_SINGLE_ITEM_LABOR_HRS) {
      flags.push({
        severity: "warning",
        code: "HIGH_ITEM_LABOR",
        message: `${item.atomicUnitCode} has ${item.snapshotLaborHrs} hrs per unit — unusually high for a single item. Verify this is correct.`,
        item: item.atomicUnitCode,
      });
    }
    if (effectiveHrs > 20) {
      flags.push({
        severity: "warning",
        code: "HIGH_TOTAL_ITEM_LABOR",
        message: `${item.atomicUnitCode} × ${item.quantity} = ${effectiveHrs.toFixed(1)} total hrs — verify quantity and labor hours.`,
        item: item.atomicUnitCode,
      });
    }
  }

  // ── 3. Support item ratio check ──────────────────────────────────────────

  const totalItemLabor = items.reduce((sum, i) => sum + i.laborCost, 0);
  const totalSupportLabor = supportItems.reduce((sum, s) => sum + s.laborCost, 0);
  const totalLabor = totalItemLabor + totalSupportLabor;
  const supportRatio = totalLabor > 0 ? totalSupportLabor / totalLabor : 0;

  if (supportRatio > MAX_SUPPORT_LABOR_RATIO) {
    flags.push({
      severity: "warning",
      code: "HIGH_SUPPORT_RATIO",
      message: `Support item labor is ${(supportRatio * 100).toFixed(0)}% of total labor — typically should be under ${(MAX_SUPPORT_LABOR_RATIO * 100).toFixed(0)}%. Check for double-counted support items.`,
    });
  }

  // ── 4. Duplicate item check ──────────────────────────────────────────────

  const codeCounts = new Map<string, number>();
  for (const item of items) {
    codeCounts.set(item.atomicUnitCode, (codeCounts.get(item.atomicUnitCode) || 0) + 1);
  }
  for (const [code, count] of codeCounts) {
    if (count > 1) {
      flags.push({
        severity: "warning",
        code: "DUPLICATE_ITEM",
        message: `${code} appears ${count} times — consider consolidating into a single line item with quantity ${count}.`,
        item: code,
      });
    }
  }

  // ── 5. Compute summary ──────────────────────────────────────────────────

  const totalLaborHrs = items.reduce((sum, i) => sum + i.snapshotLaborHrs * i.quantity, 0)
    + supportItems.reduce((sum, s) => sum + s.laborHrs, 0);
  const totalLaborCost = totalItemLabor + totalSupportLabor;
  const totalMaterialBase = items.reduce((sum, i) => sum + i.snapshotMaterialCost * i.quantity, 0);
  const totalMaterialWithMarkup = totalMaterialBase * (1 + materialMarkupPct / 100);
  const totalSupportOther = supportItems.reduce((sum, s) => sum + s.otherCost, 0);
  const totalSupportCost = totalSupportLabor + totalSupportOther;
  const grandTotal = totalLaborCost + totalMaterialWithMarkup + totalSupportOther;

  // ── 6. Material-to-total ratio check ─────────────────────────────────────

  const materialRatio = grandTotal > 0 ? totalMaterialWithMarkup / grandTotal : 0;

  if (grandTotal >= 300) {
    if (materialRatio < MATERIAL_RATIO_LOW) {
      flags.push({
        severity: "warning",
        code: "MATERIAL_RATIO_LOW",
        message: `Material is only ${(materialRatio * 100).toFixed(0)}% of total ($${totalMaterialWithMarkup.toFixed(0)} / $${grandTotal.toFixed(0)}). Expected 15-20% for typical residential work. Verify material costs are populated.`,
      });
    } else if (materialRatio > MATERIAL_RATIO_HIGH) {
      flags.push({
        severity: "warning",
        code: "MATERIAL_RATIO_HIGH",
        message: `Material is ${(materialRatio * 100).toFixed(0)}% of total ($${totalMaterialWithMarkup.toFixed(0)} / $${grandTotal.toFixed(0)}). Higher than typical 15-20% — may be correct for equipment-heavy scope, but verify.`,
      });
    }
  }

  // Always report the ratio as info
  flags.push({
    severity: "info",
    code: "MATERIAL_RATIO",
    message: `Material ratio: ${(materialRatio * 100).toFixed(1)}% of total ($${totalMaterialWithMarkup.toFixed(0)} material / $${grandTotal.toFixed(0)} total). Typical residential target: 15-20%.`,
  });

  // ── 7. Grand total sanity ────────────────────────────────────────────────

  if (grandTotal < 100) {
    flags.push({
      severity: "warning",
      code: "TOTAL_TOO_LOW",
      message: `Grand total $${grandTotal.toFixed(0)} seems unusually low. Verify scope is complete.`,
    });
  }

  // ── Determine pass/fail ──────────────────────────────────────────────────

  const hasErrors = flags.some((f) => f.severity === "error");

  return {
    passed: !hasErrors,
    flags,
    summary: {
      totalLaborHrs: parseFloat(totalLaborHrs.toFixed(2)),
      totalLaborCost: parseFloat(totalLaborCost.toFixed(2)),
      totalMaterialBase: parseFloat(totalMaterialBase.toFixed(2)),
      totalMaterialWithMarkup: parseFloat(totalMaterialWithMarkup.toFixed(2)),
      totalSupportCost: parseFloat(totalSupportCost.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      itemCount: items.length,
      supportRatio: parseFloat(supportRatio.toFixed(3)),
      materialRatio: parseFloat(materialRatio.toFixed(3)),
    },
  };
}
