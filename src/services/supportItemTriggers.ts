/**
 * Support Item Trigger Logic
 *
 * Pattern-based trigger evaluation for auto-generated support items.
 * Uses category/name matching instead of hardcoded codes, so triggers
 * survive catalog code changes.
 *
 * NOTE: NECA labor units already include travel, planning, circuit testing,
 * and cleanup. Only items that represent real separate costs or tasks
 * (permit fees, utility coordination, panel labeling) are generated here.
 */

type EstimateItemInfo = {
  code: string;
  category: string;
  name: string;
};

type SupportItemGenerated = {
  supportType: string;
  description: string;
  laborHrs: number;
  otherCost: number;
  sourceRule: string;
};

// ─── Pattern helpers ────────────────────────────────────────────────────────

function isPanelMount(item: EstimateItemInfo): boolean {
  return (
    item.category === "LINE" &&
    /panel.*mount|meter.*main.*combo/i.test(item.name)
  );
}

function isMeterOrServiceEquipment(item: EstimateItemInfo): boolean {
  return (
    item.category === "LINE" &&
    /meter base|service mast|service disconnect/i.test(item.name)
  );
}

function isPanelOperation(item: EstimateItemInfo): boolean {
  return item.category === "PANEL";
}

function isNewCircuit(item: EstimateItemInfo): boolean {
  return (
    (item.category === "CIRCUIT_MOD" && /home.?run|split circuit/i.test(item.name)) ||
    (item.category === "PANEL" && /add.*circuit/i.test(item.name))
  );
}

function isPanelDemo(item: EstimateItemInfo): boolean {
  return (
    (item.category === "DEMO" && /panel/i.test(item.name)) ||
    (item.category === "PANEL" && /panel swap/i.test(item.name))
  );
}

// ─── Main trigger evaluation ────────────────────────────────────────────────

export function generateSupportItems(
  items: EstimateItemInfo[],
  laborRate: number = 115
): SupportItemGenerated[] {
  const generated: SupportItemGenerated[] = [];

  // Permit — panel mount, meter/service equipment, new circuits, panel operations
  const triggerPermit = items.some(
    (i) => isPanelMount(i) || isMeterOrServiceEquipment(i) || isNewCircuit(i) || isPanelOperation(i)
  );
  if (triggerPermit) {
    generated.push({
      supportType: "PERMIT",
      description: "Permit Allowance",
      laborHrs: 0,
      otherCost: 350,
      sourceRule: "NEW_CIRCUIT_OR_SERVICE",
    });
  }

  // Utility coordination — meter or service entrance work
  const triggerUtility = items.some((i) => isMeterOrServiceEquipment(i));
  if (triggerUtility) {
    generated.push({
      supportType: "UTILITY_COORD",
      description: "Utility Coordination",
      laborHrs: 2.0,
      otherCost: 0,
      sourceRule: "SERVICE_ENTRANCE",
    });
  }

  // Panel labeling — panel mount or panel swap (NEC code requirement)
  const triggerLabeling = items.some(
    (i) => isPanelMount(i) || isPanelDemo(i)
  );
  if (triggerLabeling) {
    generated.push({
      supportType: "PANEL_LABELING",
      description: "Panel Directory / Labeling",
      laborHrs: 0.75,
      otherCost: 0,
      sourceRule: "PANEL_WORK",
    });
  }

  return generated;
}
