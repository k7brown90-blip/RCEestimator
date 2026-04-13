/**
 * Support Item Trigger Logic
 *
 * Pattern-based trigger evaluation for auto-generated support items.
 * Uses category/name matching instead of hardcoded codes, so triggers
 * survive catalog code changes.
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

function isBreakerInstall(item: EstimateItemInfo): boolean {
  return (
    item.category === "LINE" &&
    /breaker.*install/i.test(item.name)
  );
}

function isPanelOperation(item: EstimateItemInfo): boolean {
  return item.category === "PANEL";
}

function isNewCircuit(item: EstimateItemInfo): boolean {
  // New circuit = home-run from panel, split circuit, or add circuit to panel
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

  // Mobilization — always
  generated.push({
    supportType: "MOBILIZATION",
    description: "Mobilization / Travel",
    laborHrs: 0,
    otherCost: 35,
    sourceRule: "ALWAYS",
  });

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

  // Load calculation — panel mount or meter/service work
  const triggerLoadCalc = items.some(
    (i) => isPanelMount(i) || isMeterOrServiceEquipment(i) || isPanelDemo(i)
  );
  if (triggerLoadCalc) {
    generated.push({
      supportType: "LOAD_CALC",
      description: "Load Calculation Review",
      laborHrs: 1.5,
      otherCost: 0,
      sourceRule: "PANEL_OR_SERVICE",
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

  // Circuit testing — count new circuits (breaker installs + new circuit panel ops)
  const newCircuitCount = items.filter(
    (i) => isBreakerInstall(i) || isNewCircuit(i)
  ).length;
  if (newCircuitCount > 0) {
    generated.push({
      supportType: "CIRCUIT_TESTING",
      description: `Circuit Testing / Checkout (${newCircuitCount} circuit${newCircuitCount > 1 ? "s" : ""})`,
      laborHrs: parseFloat((0.25 * newCircuitCount).toFixed(2)),
      otherCost: 0,
      sourceRule: "NEW_CIRCUITS",
    });
  }

  // Cleanup — 0.5 hr flat + 0.1 hr per item over 5
  const itemCount = items.length;
  if (itemCount > 2) {
    const cleanupHrs = parseFloat((0.5 + Math.max(0, (itemCount - 5) * 0.1)).toFixed(2));
    generated.push({
      supportType: "CLEANUP",
      description: `Cleanup / Debris Removal (${itemCount} line item${itemCount !== 1 ? "s" : ""})`,
      laborHrs: cleanupHrs,
      otherCost: 0,
      sourceRule: "MULTI_ITEM",
    });
  }

  // Panel labeling — panel mount or panel swap
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

  // Panel demo — removing or swapping a panel
  const triggerPanelDemoItem = items.some((i) => isPanelDemo(i));
  if (triggerPanelDemoItem) {
    generated.push({
      supportType: "PANEL_DEMO",
      description: "Panel Demo / Removal Prep",
      laborHrs: 5.0,
      otherCost: 0,
      sourceRule: "PANEL_REPLACE",
    });
  }

  return generated;
}
