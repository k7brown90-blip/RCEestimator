/**
 * Seed 24 Field-Realistic Estimates from the Scenario Suite
 *
 * Creates a unique customer + property + visit + estimate per scenario,
 * calls the API to add items (with wiring resolution / modifiers),
 * generates support items, and runs NEC check.
 *
 * Usage: npx tsx scripts/seedScenarioEstimates.ts
 */

import { PrismaClient } from "@prisma/client";
import { app } from "../src/app";
import http from "node:http";

const prisma = new PrismaClient();

// ─── TYPES ───────────────────────────────────────────────────────────────────

type ItemInput = {
  atomicUnitCode: string;
  quantity: number;
  location?: string;
  notes?: string;
  circuitVoltage?: 120 | 240;
  circuitAmperage?: number;
  environment?: "interior" | "exterior" | "underground";
  exposure?: "concealed" | "exposed";
  cableLength?: number;
  needsThreeWire?: boolean;
  modifiers?: Array<{
    modifierType: string;
    modifierValue: string;
    laborMultiplier: number;
    materialMult: number;
  }>;
};

type ScenarioDef = {
  scenario: number;
  name: string;
  jobType: string;
  customerName: string;
  address: string;
  items: ItemInput[];
  scopeSummary: string;
};

// ─── ACCESS MODIFIER SHORTHAND ──────────────────────────────────────────────

const DIFFICULT_ACCESS = {
  modifierType: "ACCESS",
  modifierValue: "DIFFICULT",
  laborMultiplier: 1.25,
  materialMult: 1.0,
};

// ─── 24 SCENARIOS ────────────────────────────────────────────────────────────

const SCENARIOS: ScenarioDef[] = [
  // ═══ G1: DEVICES & LIGHTING (1–6) ═══
  {
    scenario: 1,
    name: "Replace 6 Standard Receptacles",
    jobType: "Service / Repair",
    customerName: "Sarah Mitchell",
    address: "1201 Oak St",
    items: [
      { atomicUnitCode: "DEV-001", quantity: 6, location: "Kitchen, Living Room" },
    ],
    scopeSummary: "6× receptacle swap in existing boxes, no new circuits",
  },
  {
    scenario: 2,
    name: "GFCI Upgrade — Kitchen/Bath",
    jobType: "Service / Upgrade",
    customerName: "James & Linda Torres",
    address: "2450 Birch Ave",
    items: [
      { atomicUnitCode: "DEV-002", quantity: 2, location: "kitchen" },
      { atomicUnitCode: "DEV-002", quantity: 2, location: "bathroom" },
    ],
    scopeSummary: "4× GFCI receptacle upgrade in kitchen and bath locations",
  },
  {
    scenario: 3,
    name: "Replace 3 Light Fixtures",
    jobType: "Service / Repair",
    customerName: "Dave Kowalski",
    address: "875 Cedar Ln",
    items: [
      { atomicUnitCode: "LUM-001", quantity: 3, location: "Dining Room, Hallway" },
    ],
    scopeSummary: "3× fixture swap in existing boxes, no new circuits",
  },
  {
    scenario: 4,
    name: "MyRethread — Dimmer Multi-Gang Retrofit",
    jobType: "Service / Upgrade",
    customerName: "Angela Nguyen",
    address: "3310 Maple Dr",
    items: [
      { atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining" },
      { atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room" },
      { atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run" },
      { atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining" },
    ],
    scopeSummary: "4 dimmers in multi-gang cut-in box, 24ft NM-B 12/2, 2 splice-throughs",
  },
  {
    scenario: 5,
    name: "Ceiling Fan Install",
    jobType: "Service / Install",
    customerName: "Robert Garcia",
    address: "1560 Willow Way",
    items: [
      { atomicUnitCode: "LUM-005", quantity: 1, location: "Master Bedroom" },
    ],
    scopeSummary: "Fan-rated box + fan assembly in existing circuit location",
  },
  {
    scenario: 6,
    name: "Replace 4 Smoke/CO Detectors",
    jobType: "Service / Safety",
    customerName: "Patricia Chen",
    address: "4220 Elm Ct",
    items: [
      { atomicUnitCode: "DEV-006", quantity: 4, location: "Bedrooms, Hallway" },
    ],
    scopeSummary: "4× detector swap in existing bases, bedroom + hallway locations",
  },

  // ═══ G2: CIRCUITS & WIRING RESOLUTION (7–12) ═══
  {
    scenario: 7,
    name: "Dedicated 120V 20A — Concealed",
    jobType: "New Circuit",
    customerName: "Michael Stevens",
    address: "980 Pine Ridge Rd",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Office",
        circuitVoltage: 120, circuitAmperage: 20,
        environment: "interior", exposure: "concealed", cableLength: 40,
      },
      { atomicUnitCode: "EQP-001", quantity: 1, location: "Office" },
    ],
    scopeSummary: "120V 20A branch circuit, 40ft NM-B 12/2, receptacle endpoint",
  },
  {
    scenario: 8,
    name: "Dryer Circuit 240V 30A — 3-Wire",
    jobType: "Appliance Circuit",
    customerName: "Karen & Tom Bradley",
    address: "2115 Spruce St",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Laundry",
        circuitVoltage: 240, circuitAmperage: 30,
        environment: "interior", exposure: "concealed", cableLength: 35,
        needsThreeWire: true,
      },
      { atomicUnitCode: "EQP-002", quantity: 1, location: "Laundry" },
    ],
    scopeSummary: "240V 30A dryer circuit, 35ft NM-B 10/3, 240V receptacle endpoint",
  },
  {
    scenario: 9,
    name: "Range Circuit 240V 50A — 3-Wire",
    jobType: "Appliance Circuit",
    customerName: "Diane Hartley",
    address: "650 Aspen Blvd",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Kitchen",
        circuitVoltage: 240, circuitAmperage: 50,
        environment: "interior", exposure: "concealed", cableLength: 25,
        needsThreeWire: true,
      },
      { atomicUnitCode: "EQP-002", quantity: 1, location: "Kitchen" },
    ],
    scopeSummary: "240V 50A range circuit, 25ft NM-B 6/3, 240V receptacle endpoint",
  },
  {
    scenario: 10,
    name: "120V 20A — Interior Exposed (MC Cable)",
    jobType: "New Circuit",
    customerName: "Chris & Amy Walker",
    address: "3890 Juniper Ct",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Garage",
        circuitVoltage: 120, circuitAmperage: 20,
        environment: "interior", exposure: "exposed", cableLength: 30,
      },
      { atomicUnitCode: "EQP-001", quantity: 1, location: "Garage" },
    ],
    scopeSummary: "120V 20A exposed interior circuit, 30ft MC 12/2, receptacle endpoint",
  },
  {
    scenario: 11,
    name: "120V 20A — Exterior (UF Cable)",
    jobType: "New Circuit",
    customerName: "Brian Hoffman",
    address: "4750 Larch Ln",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "exterior patio",
        circuitVoltage: 120, circuitAmperage: 20,
        environment: "exterior", exposure: "exposed", cableLength: 30,
      },
      { atomicUnitCode: "EQP-001", quantity: 1, location: "exterior patio" },
    ],
    scopeSummary: "120V 20A exterior circuit, 30ft UF cable, receptacle endpoint",
  },
  {
    scenario: 12,
    name: "Dedicated 120V 15A — Concealed",
    jobType: "New Circuit",
    customerName: "Stephanie Ross",
    address: "1340 Alder Dr",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Bedroom",
        circuitVoltage: 120, circuitAmperage: 15,
        environment: "interior", exposure: "concealed", cableLength: 40,
      },
      { atomicUnitCode: "EQP-001", quantity: 1, location: "Bedroom" },
    ],
    scopeSummary: "120V 15A branch circuit, 40ft NM-B 14/2, receptacle endpoint",
  },

  // ═══ G3: PANEL / SERVICE / GROUNDING (13–18) ═══
  {
    scenario: 13,
    name: "Main Panel Replace",
    jobType: "Panel / Service",
    customerName: "Richard & Mary Sullivan",
    address: "5200 Fir Ave",
    items: [
      { atomicUnitCode: "PNL-001", quantity: 1, location: "Garage" },
    ],
    scopeSummary: "Full main panel replacement — remove old, mount new, reconnect all circuits, label",
  },
  {
    scenario: 14,
    name: "New Subpanel + Feeder",
    jobType: "Panel / Service",
    customerName: "Eric Peterson",
    address: "2680 Hemlock Way",
    items: [
      { atomicUnitCode: "PNL-003", quantity: 1, location: "Workshop" },
      {
        atomicUnitCode: "CIR-002", quantity: 1, location: "Garage → Workshop",
        circuitVoltage: 240, circuitAmperage: 60,
        environment: "interior", exposure: "concealed", cableLength: 60,
      },
    ],
    scopeSummary: "New subpanel install with 60ft feeder, SER cable",
  },
  {
    scenario: 15,
    name: "Full Service Entrance Upgrade",
    jobType: "Panel / Service",
    customerName: "Howard & Janet Price",
    address: "790 Dogwood Cir",
    items: [
      { atomicUnitCode: "SVC-005", quantity: 1, location: "Exterior / Garage" },
      { atomicUnitCode: "SVC-002", quantity: 1, location: "Exterior" },
      { atomicUnitCode: "PNL-001", quantity: 1, location: "Garage" },
      { atomicUnitCode: "GND-001", quantity: 1, location: "Exterior" },
    ],
    scopeSummary: "Service upgrade + meter base + main panel + grounding electrode system",
  },
  {
    scenario: 16,
    name: "Grounding System",
    jobType: "Grounding / Safety",
    customerName: "Nancy Yamamoto",
    address: "3100 Poplar St",
    items: [
      { atomicUnitCode: "GND-001", quantity: 1, location: "Exterior" },
      { atomicUnitCode: "GND-003", quantity: 1, location: "Exterior" },
      { atomicUnitCode: "GND-002", quantity: 1, location: "Mechanical Room" },
    ],
    scopeSummary: "Full GES + supplemental ground rod + bonding correction",
  },
  {
    scenario: 17,
    name: "Panel Rework / Cleanup",
    jobType: "Service / Maintenance",
    customerName: "Greg Lawson",
    address: "1900 Sequoia Blvd",
    items: [
      { atomicUnitCode: "PNL-004", quantity: 1, location: "Basement" },
    ],
    scopeSummary: "Re-terminate, organize, and label all circuits in existing panel",
  },
  {
    scenario: 18,
    name: "Service Cable + Mast Repair",
    jobType: "Panel / Service",
    customerName: "Deborah Franklin",
    address: "4480 Redwood Ln",
    items: [
      { atomicUnitCode: "SVC-001", quantity: 1, location: "Exterior" },
      { atomicUnitCode: "SVC-004", quantity: 1, location: "Exterior" },
    ],
    scopeSummary: "Replace service entrance cable + mast/weatherhead repair",
  },

  // ═══ G4: SPECIALTY EQUIPMENT (19–22) ═══
  {
    scenario: 19,
    name: "EV Charger Install",
    jobType: "Equipment / EV",
    customerName: "Kevin & Lisa Tran",
    address: "2230 Cypress Ave",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "Garage",
        circuitVoltage: 240, circuitAmperage: 40,
        environment: "interior", exposure: "concealed", cableLength: 30,
      },
      { atomicUnitCode: "EQP-006", quantity: 1, location: "Garage" },
      { atomicUnitCode: "EQP-003", quantity: 1, location: "Garage" },
    ],
    scopeSummary: "240V 40A EV circuit + charger mount + disconnect",
  },
  {
    scenario: 20,
    name: "Hot Tub/Spa Install",
    jobType: "Equipment / Spa",
    customerName: "Mark & Susan Petrov",
    address: "5600 Magnolia Dr",
    items: [
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "exterior patio",
        circuitVoltage: 240, circuitAmperage: 50,
        environment: "exterior", exposure: "exposed", cableLength: 50,
      },
      { atomicUnitCode: "EQP-010", quantity: 1, location: "exterior patio" },
      { atomicUnitCode: "EQP-003", quantity: 1, location: "exterior patio" },
    ],
    scopeSummary: "240V 50A spa circuit, 50ft UF cable, GFCI disconnect + spa connection",
  },
  {
    scenario: 21,
    name: "Generator Inlet + Interlock",
    jobType: "Equipment / Generator",
    customerName: "Douglas Reed",
    address: "1480 Chestnut Way",
    items: [
      { atomicUnitCode: "EQP-007", quantity: 1, location: "Exterior wall" },
      { atomicUnitCode: "EQP-008", quantity: 1, location: "Panel" },
    ],
    scopeSummary: "Power inlet box for portable generator + panel interlock kit",
  },
  {
    scenario: 22,
    name: "Bathroom Exhaust Fan + Circuit",
    jobType: "Fixture / Circuit",
    customerName: "Rachel Kim",
    address: "3750 Walnut St",
    items: [
      { atomicUnitCode: "LUM-007", quantity: 1, location: "bathroom" },
      {
        atomicUnitCode: "CIR-001", quantity: 1, location: "bathroom",
        circuitVoltage: 120, circuitAmperage: 20,
        environment: "interior", exposure: "concealed", cableLength: 25,
      },
    ],
    scopeSummary: "Bathroom exhaust fan + dedicated 120V 20A circuit, 25ft NM-B 12/2",
  },

  // ═══ G5: MODIFIERS & COMPARISONS (23–24) ═══
  {
    scenario: 23,
    name: "MyRethread — Difficult Access",
    jobType: "Service / Upgrade",
    customerName: "Angela Nguyen",
    address: "3310 Maple Dr",
    items: [
      {
        atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining",
        modifiers: [DIFFICULT_ACCESS],
      },
      {
        atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room",
        modifiers: [DIFFICULT_ACCESS],
      },
      {
        atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run",
        modifiers: [DIFFICULT_ACCESS],
      },
      {
        atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining",
        modifiers: [DIFFICULT_ACCESS],
      },
    ],
    scopeSummary: "MyRethread with all items at Difficult Access (1.25× labor)",
  },
  {
    scenario: 24,
    name: "MyRethread — Occupied + After-Hours",
    jobType: "Service / Upgrade",
    customerName: "Angela Nguyen",
    address: "3310 Maple Dr",
    items: [
      { atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining" },
      { atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room" },
      { atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run" },
      { atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining" },
    ],
    scopeSummary: "MyRethread — occupied home, after-hours schedule (estimate-level modifiers)",
  },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  // Start server on a random port
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Could not bind server");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`\nServer started on ${baseUrl}`);

  // Track unique customers to re-use for repeat addresses
  const customerCache = new Map<string, { customerId: string; propertyId: string }>();

  let created = 0;

  for (const s of SCENARIOS) {
    const cacheKey = `${s.customerName}|${s.address}`;
    let customerId: string;
    let propertyId: string;

    if (customerCache.has(cacheKey)) {
      // Re-use customer + property (e.g. Angela Nguyen for scenarios 4, 23, 24)
      const cached = customerCache.get(cacheKey)!;
      customerId = cached.customerId;
      propertyId = cached.propertyId;
    } else {
      // Create customer
      const customer = await prisma.customer.create({
        data: {
          name: s.customerName,
          email: `scenario${s.scenario}@redcedarelectric.test`,
          phone: `(360) 555-${String(s.scenario).padStart(4, "0")}`,
        },
      });
      customerId = customer.id;

      // Create property
      const property = await prisma.property.create({
        data: {
          customerId,
          name: `${s.customerName} Residence`,
          addressLine1: s.address,
          city: "Vancouver",
          state: "WA",
          postalCode: "98660",
        },
      });
      propertyId = property.id;

      // Create system snapshot (required)
      await prisma.systemSnapshot.create({
        data: {
          propertyId,
          deficienciesJson: "[]",
          changeLogJson: "[]",
        },
      });

      customerCache.set(cacheKey, { customerId, propertyId });
    }

    // Create visit
    const visit = await prisma.visit.create({
      data: {
        propertyId,
        customerId,
        mode: "service_diagnostic",
        purpose: `Scenario ${s.scenario}: ${s.name}`,
      },
    });

    // Create estimate via API
    const estimate = await apiPost("/estimates", {
      visitId: visit.id,
      propertyId,
      title: `S${s.scenario} — ${s.name}`,
      notes: s.scopeSummary,
    });
    const estimateId = estimate.id;

    // Create option
    const option = await apiPost(`/estimates/${estimateId}/options`, {
      optionLabel: "Recommended",
      description: s.scopeSummary,
    });
    const optionId = option.id;

    // Add items
    for (const item of s.items) {
      await apiPost(`/estimates/${estimateId}/options/${optionId}/items`, item);
    }

    // Generate support items
    await apiPost(`/estimates/${estimateId}/support-items/generate`, {});

    // Run NEC check
    const necResult = await apiPost(`/estimates/${estimateId}/nec-check`, {});

    // Fetch items for summary
    const items = await apiGet(`/estimates/${estimateId}/options/${optionId}/items`);
    const supportItems = await apiGet(`/estimates/${estimateId}/support-items`);

    // Compute totals
    const itemLabor = round2(items.reduce((s: number, i: any) => s + i.laborCost, 0));
    const itemMaterial = round2(items.reduce((s: number, i: any) => s + i.materialCost, 0));
    const materialMarkup = round2(itemMaterial * 0.30);
    const supportLabor = round2(supportItems.reduce((s: number, i: any) => s + i.laborCost, 0));
    const supportOther = round2(supportItems.reduce((s: number, i: any) => s + i.otherCost, 0));
    const total = round2(itemLabor + itemMaterial + materialMarkup + supportLabor + supportOther);

    created++;
    console.log(
      `  [${created}/24] S${s.scenario}: ${s.name.padEnd(42)} ` +
      `${items.length} items, ${supportItems.length} support, ` +
      `${necResult.prompts?.length ?? 0} NEC prompts  →  $${total.toFixed(2)}`
    );
  }

  console.log(`\n✓ ${created} scenario estimates created successfully.\n`);

  server.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  server?.close();
  prisma.$disconnect().finally(() => process.exit(1));
});
