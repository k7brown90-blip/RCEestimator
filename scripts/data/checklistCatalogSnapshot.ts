/**
 * Frozen description of every checklist item, for backfilling the finding ledger
 * from records that predate self-describing pushes.
 *
 * GENERATED — run `npx tsx scripts/generateChecklistSnapshot.ts` to regenerate.
 * Do not hand-edit: the point of a snapshot is that it is a snapshot.
 *
 * Generated 2026-07-29 from field/src/data/checklist.ts.
 */

export interface CatalogEntry {
  id: string;
  title: string;
  section: string;
  citations: string[];
  bannerListed: boolean;
  phase: 1 | 2;
}

export const CHECKLIST_CATALOG: Record<string, CatalogEntry> = {
  "A1": {
    "id": "A1",
    "title": "Service drop / lateral clearances & condition",
    "section": "A — Service Entrance & Supply",
    "citations": [
      "230.24 (overhead clearances: 10 ft at entrance/over pedestrian, 12 ft over residential drive, 3 ft above roof)",
      "230.26 (attach ≥10 ft)",
      "230.28 (mast strength)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "A2": {
    "id": "A2",
    "title": "Service rating vs. calculated load",
    "section": "A — Service Entrance & Supply",
    "citations": [
      "230.79(C) (one-family dwelling ≥100 A, 3-wire)",
      "230.42 (conductor ampacity)",
      "Article 220 (load calculation)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "A3": {
    "id": "A3",
    "title": "Meter base (external condition) & main disconnect",
    "section": "A — Service Entrance & Supply",
    "citations": [
      "230.66 (service equipment listed/labeled)",
      "312 (enclosure integrity)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "B1": {
    "id": "B1",
    "title": "Service disconnect — location, marking, rating",
    "section": "B — Service Disconnect & Working Space",
    "citations": [
      "230.70(A) (readily accessible, outside or nearest point of entry; not in a bathroom)",
      "230.70(B) (marked as service disconnect)",
      "230.71 (≤6 disconnects)",
      "230.77 (indicates on/off)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "B2": {
    "id": "B2",
    "title": "Panel working space & dedicated space",
    "section": "B — Service Disconnect & Working Space",
    "citations": [
      "110.26(A) (≥36 in. deep, ≥30 in. wide, ≥6.5 ft high clear in front)",
      "110.26(E) (dedicated space above; no piping/ducts foreign to electrical)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "C1": {
    "id": "C1",
    "title": "Grounding electrode system — electrodes, resistance & GEC",
    "section": "C — Grounding & Bonding",
    "citations": [
      "250.50 (all present electrodes bonded into one system)",
      "250.52 (permitted electrode types: rod, Ufer/concrete-encased, water pipe, ground ring)",
      "250.53(A)(2) Exception (single rod ≤25 Ω, else supplemental electrode required)",
      "250.53(G) (≥8 ft rod in soil)",
      "250.64 (GEC routing/protection)",
      "250.66 (GEC sizing per Table 250.66)",
      "250.70 (listed connection, no solder)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "C2": {
    "id": "C2",
    "title": "Ground-rod resistance (measured)",
    "section": "C — Grounding & Bonding",
    "citations": [],
    "bannerListed": false,
    "phase": 1
  },
  "C3": {
    "id": "C3",
    "title": "Grounding electrode conductor (GEC) — size & connection",
    "section": "C — Grounding & Bonding",
    "citations": [],
    "bannerListed": false,
    "phase": 1
  },
  "C4": {
    "id": "C4",
    "title": "Main bonding jumper & EGC-bar bonding at the service",
    "section": "C — Grounding & Bonding",
    "citations": [
      "250.24(B) (MBJ connects the EGCs and the enclosure to the grounded conductor)",
      "250.28 (MBJ material — \"wire, bus, screw, or similar\" — size per Table 250.102(C)(1))",
      "250.24(A)(4) (a wire/busbar from the neutral bar to the EGC bar is an explicitly recognized MBJ form)",
      "408.3(C) (service panelboard MBJ bonds neutral to frame)",
      "250.118 (enclosure is not a listed EGC type)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "C5": {
    "id": "C5",
    "title": "Neutral-ground separation at subpanels",
    "section": "C — Grounding & Bonding",
    "citations": [
      "250.24(A)(5) (no re-grounding of neutral on load side of service)",
      "408.41 (neutrals isolated in subpanels)"
    ],
    "bannerListed": true,
    "phase": 2
  },
  "C6": {
    "id": "C6",
    "title": "Metal water pipe & gas pipe bonding",
    "section": "C — Grounding & Bonding",
    "citations": [
      "250.104(A) (metal water piping bonded, sized per 250.102)",
      "250.104(B) (other metal piping incl. gas likely to be energized bonded)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "C7": {
    "id": "C7",
    "title": "Intersystem bonding termination (ISBT)",
    "section": "C — Grounding & Bonding",
    "citations": [
      "250.94 (accessible IBT with ≥3 terminals for cable/phone/satellite bonding)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "D1": {
    "id": "D1",
    "title": "Connection integrity (torque + thermal)",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "110.14 (connections)",
      "110.14(D) (torque to spec, calibrated tool, Annex I tables)",
      "110.12(B) (no corroded/overheated parts)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "D2": {
    "id": "D2",
    "title": "Breaker-to-conductor sizing",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "240.4 (conductors protected at ampacity)",
      "240.4(D) (15 A/14 AWG, 20 A/12 AWG, 30 A/10 AWG small-conductor limits)",
      "240.6 (standard ratings)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "D3": {
    "id": "D3",
    "title": "Breaker compatibility & panel condition",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "110.3(B) (equipment used per listing)",
      "408.54 (max devices)",
      "110.12(B) (condition)"
    ],
    "bannerListed": true,
    "phase": 1
  },
  "D4": {
    "id": "D4",
    "title": "Panel circuit directory (verified schedule)",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "408.4(A) (every circuit legibly identified, clear/specific purpose; spares labeled; no transient-occupancy descriptions)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "D5": {
    "id": "D5",
    "title": "Aluminum branch-circuit wiring",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "110.14 (connections, dissimilar-metal listing)",
      "110.3(B) (devices used per listing — CO/ALR-rated)",
      "CPSC hazard findings on pre-1972 solid aluminum branch wiring"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "D6": {
    "id": "D6",
    "title": "Service / main termination voltages (control reading)",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "110.14 (connections)",
      "ANSI C84.1 Range A (utility delivery tolerance — informational)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "D7": {
    "id": "D7",
    "title": "Branch-circuit voltage at the OCPD",
    "section": "D — Panel, Overcurrent & Connections",
    "citations": [
      "110.14(D) (torque to spec, calibrated tool)",
      "110.12(B) (no corroded or overheated parts)",
      "210.19(A) Informational Note (3% branch / 5% total — applies to conductor runs, not to this measurement)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "E1": {
    "id": "E1",
    "title": "GFCI protection (shock)",
    "section": "E — Branch-Circuit Protection",
    "citations": [
      "210.8(A) (bathrooms, garages, outdoors, crawl spaces, unfinished basements, kitchens, within 6 ft of sinks, laundry, dishwasher 210.8(D))"
    ],
    "bannerListed": true,
    "phase": 2
  },
  "E2": {
    "id": "E2",
    "title": "AFCI protection (arc-fault fire)",
    "section": "E — Branch-Circuit Protection",
    "citations": [
      "210.12(A) (kitchens, family/living/dining, bedrooms, hallways, laundry, closets, sunrooms…)",
      "210.12(D) (add on modify/replace/extend)",
      "TN amd: optional in baths, laundry, garages, unfinished basements"
    ],
    "bannerListed": false,
    "phase": 2
  },
  "E3": {
    "id": "E3",
    "title": "Surge protection (SPD)",
    "section": "E — Branch-Circuit Protection",
    "citations": [
      "2017: not required",
      "230.67 (required at the service from the 2020 NEC onward, min 10 kA, and on any service or panel replacement)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "F1": {
    "id": "F1",
    "title": "Receptacle placement & condition",
    "section": "F — Devices, Receptacles & Lighting",
    "citations": [
      "210.52(A) (spacing: no point along wall >6 ft from a receptacle; walls ≥2 ft)",
      "210.52(B) (kitchen small-appliance)",
      "210.52(C) (countertop)",
      "406.4(D) (replacement rules)",
      "406.12 (tamper-resistant)"
    ],
    "bannerListed": false,
    "phase": 2
  },
  "F2": {
    "id": "F2",
    "title": "Egress / Security lighting",
    "section": "F — Devices, Receptacles & Lighting",
    "citations": [
      "210.70(A) (lighting outlet in every habitable room, hall, stair, and at the exterior of outdoor entrances; switch-controlled)",
      "404 (switch use)"
    ],
    "bannerListed": false,
    "phase": 2
  },
  "F3": {
    "id": "F3",
    "title": "Box fill, cable support & protection",
    "section": "F — Devices, Receptacles & Lighting",
    "citations": [
      "314.16 (box fill limits)",
      "314.17 (cable clamping)",
      "300.4 (protection from physical damage / nail plates)",
      "334.30 (NM cable support)",
      "314.25 (missing box covers)"
    ],
    "bannerListed": false,
    "phase": 2
  },
  "G1": {
    "id": "G1",
    "title": "Water heater disconnect",
    "section": "G — Equipment Disconnects & Load Balance",
    "citations": [
      "422.31(B) (permanently-connected appliance >300 VA: switch/breaker within sight or lockable per 110.25)",
      "Article 100 (\"within sight\" = visible, ≤50 ft)"
    ],
    "bannerListed": false,
    "phase": 2
  },
  "G2": {
    "id": "G2",
    "title": "HVAC / heating disconnect",
    "section": "G — Equipment Disconnects & Load Balance",
    "citations": [
      "440.14 (A/C disconnect within sight of equipment)",
      "424.19 (fixed electric heat)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "G3": {
    "id": "G3",
    "title": "Load balance (measured, fixed/dedicated circuits)",
    "section": "G — Equipment Disconnects & Load Balance",
    "citations": [
      "Article 220 (load calculation methodology)"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "H1": {
    "id": "H1",
    "title": "Smoke & CO alarms",
    "section": "H — Life Safety & Panel Life",
    "citations": [
      "NFPA 72 (10-yr replacement life)",
      "IRC R314/R315 (placement: each bedroom, outside each sleeping area, each level; CO outside sleeping areas; interconnection)"
    ],
    "bannerListed": true,
    "phase": 2
  },
  "H2": {
    "id": "H2",
    "title": "Panel condition & remaining life",
    "section": "H — Life Safety & Panel Life",
    "citations": [
      "manufacturer rated life (~30 yrs)",
      "110.12(B) condition"
    ],
    "bannerListed": false,
    "phase": 1
  },
  "I1": {
    "id": "I1",
    "title": "Metro-specific amendments (Nashville only)",
    "section": "I — Nashville / Davidson Metro Amendments",
    "citations": [
      "Metro Code Title 16, Ch. 16.20 amendments to 2023 NEC"
    ],
    "bannerListed": false,
    "phase": 2
  }
};

/** Description for an id, or null when the catalogue has never heard of it. */
export function describeItem(itemId: string): CatalogEntry | null {
  return CHECKLIST_CATALOG[itemId] ?? null;
}
