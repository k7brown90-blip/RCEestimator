/**
 * The materials list — Unit L, 2026-09-17.
 *
 * Kyle: "I should be able to pull up a materials list from this card. A button that pulls up a
 * pdf would be fine." Then: "the materials list pdf should show the materials from the line
 * items used to quote the job."
 *
 * Two things under test:
 *   - `materialNeedListForJob` (services/jobMaterials.ts) — the shared pre-stock computation
 *     `shortagesForJob` already builds. Same traps as tests/jobMaterialShortages.test.ts: an
 *     assembly must expand to its real components, a signed CHANGE ORDER (a separate
 *     IssuedEstimate row) must count, and — new for this unit — a VOIDED estimate must NOT count.
 *   - `renderMaterialsListPdf` (services/materialsListPdf.ts) — reads the actual rendered bytes,
 *     the same way tests/issuedEstimatePdf.test.ts does, because a test that only inspects the
 *     input data would pass even if the generator accidentally printed a cost column.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { materialNeedListForJob } from "../src/services/jobMaterials";
import { renderMaterialsListPdf } from "../src/services/materialsListPdf";
import type { CompanyProfile } from "../src/services/companyProfile";

const newId = () => crypto.randomUUID().replaceAll("-", "");

const WIRE = "UNITL-WIRE";
const BREAKER = "UNITL-BREAKER";
const EVCHG = "UNITL-EVCHG"; // the assembly — must NEVER appear directly in the need list

let customerId: string;
let propertyId: string;
let job: string;
let draftId: string;

async function cleanup() {
  await prisma.issuedEstimateLine.deleteMany({ where: { estimate: { number: { startsWith: "0000-UNITL" } } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-UNITL" } } });
  if (draftId) await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.priceBookItemComponent.deleteMany({ where: { parentItemId: EVCHG } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BREAKER, EVCHG] } } });
  if (job) await prisma.visit.deleteMany({ where: { id: job } });
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  if (customerId) await prisma.customer.deleteMany({ where: { id: customerId } });
}

beforeAll(async () => {
  await cleanup();

  await prisma.priceBookAtomic.createMany({
    data: [
      { itemId: WIRE, description: "Unit L 12-2 NM-B", unit: "ft" },
      { itemId: BREAKER, description: "Unit L 20A breaker", unit: "ea" },
      { itemId: EVCHG, description: "Unit L EV charger assembly", unit: "ea", rowType: "ASSEMBLY" },
    ],
  });
  // Each EV charger needs 1 breaker and 30 ft of wire.
  await prisma.priceBookItemComponent.createMany({
    data: [
      { parentItemId: EVCHG, childItemId: BREAKER, quantity: 1 },
      { parentItemId: EVCHG, childItemId: WIRE, quantity: 30 },
    ],
  });

  const customer = await prisma.customer.create({ data: { name: "Unit L Materials Co", phone: "+16155508888" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Materials House", addressLine1: "1 Materials Way", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  job = (await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "Unit L job", jobType: "Unit L job", status: "in_progress", visitDate: new Date() },
  })).id;

  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "unit-l materials draft", supplierId: "UNITL-SUP" } });
  draftId = draft.id;

  // The ORIGINAL signed estimate: 40 ft of wire quoted directly, plus 1 EV charger assembly
  // (expands to 1 breaker + 30 ft of wire). Linked to the job through jobVisitId.
  const original = await prisma.issuedEstimate.create({
    data: {
      number: "0000-UNITL-ORIG", token: `unitl-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, jobVisitId: job,
      customerName: "Unit L Materials Co", serviceAddress: "1 Materials Way, Franklin", title: "Unit L original",
      workSubtotal: 2000, total: 2000, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
    },
  });
  await prisma.issuedEstimateLine.createMany({
    data: [
      { estimateId: original.id, itemId: WIRE, description: "12-2 NM-B", quantity: 40, unitPrice: 1, lineTotal: 40, option: "A", materialCost: 28.8, materialSell: 40 },
      { estimateId: original.id, itemId: EVCHG, description: "EV charger install", quantity: 1, unitPrice: 500, lineTotal: 500, option: "A", materialCost: 100, materialSell: 500 },
    ],
  });

  // A signed CHANGE ORDER against the same job — a separate IssuedEstimate row, linked through
  // `visitId` — adding one more breaker.
  const changeOrder = await prisma.issuedEstimate.create({
    data: {
      number: "0000-UNITL-CO", token: `unitl-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: job,
      customerName: "Unit L Materials Co", serviceAddress: "1 Materials Way, Franklin", title: "Unit L change order",
      workSubtotal: 30, total: 30, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
    },
  });
  await prisma.issuedEstimateLine.create({
    data: { estimateId: changeOrder.id, itemId: BREAKER, description: "Extra 20A breaker", quantity: 1, unitPrice: 15, lineTotal: 15, option: "A", materialCost: 9.5, materialSell: 15 },
  });

  // A VOIDED signed estimate on the same job — must NOT count toward the need list. If it counted,
  // its 500 ft of wire would swamp every assertion below.
  const voided = await prisma.issuedEstimate.create({
    data: {
      number: "0000-UNITL-VOID", token: `unitl-token-${newId()}`, status: "void", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: job,
      customerName: "Unit L Materials Co", serviceAddress: "1 Materials Way, Franklin", title: "Unit L voided",
      workSubtotal: 9999, total: 9999, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
      voidedAt: new Date(), voidReason: "test cleanup",
    },
  });
  await prisma.issuedEstimateLine.create({
    data: { estimateId: voided.id, itemId: WIRE, description: "Voided wire — must not count", quantity: 500, unitPrice: 1, lineTotal: 500, option: "A", materialCost: 360, materialSell: 500 },
  });
});

afterAll(cleanup);

describe("materialNeedListForJob", () => {
  it("expands the assembly, merges the change order, excludes the voided estimate, and carries no cost fields", async () => {
    const need = await materialNeedListForJob(job);

    // Both live estimates are named; the voided one is not.
    expect(need.estimates.map((e) => e.number).sort()).toEqual(["0000-UNITL-CO", "0000-UNITL-ORIG"]);

    const byId = new Map(need.lines.map((l) => [l.itemId, l]));

    // The assembly itself must never appear — only its real components.
    expect(byId.has(EVCHG)).toBe(false);

    // Wire: 40 direct + 30 (1 EV charger) = 70. The voided estimate's 500 must NOT be added.
    const wire = byId.get(WIRE);
    expect(wire).toBeTruthy();
    expect(wire!.qty).toBe(70);
    expect(wire!.unit).toBe("ft");
    expect(wire!.name).toContain("12-2 NM-B");

    // Breaker: 1 (the EV charger) + 1 (change order) = 2.
    const breaker = byId.get(BREAKER);
    expect(breaker).toBeTruthy();
    expect(breaker!.qty).toBe(2);
    expect(breaker!.unit).toBe("ea");

    // No cost field exists anywhere on a need-list line — this is a need list, not a priced
    // document.
    for (const line of need.lines) {
      expect(Object.keys(line).sort()).toEqual(["itemId", "name", "qty", "unit"]);
    }
  });

  it("returns empty estimates and lines for a job with no signed estimate", async () => {
    const bareJob = (await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: "Unit L bare job", jobType: "Unit L bare job", status: "in_progress", visitDate: new Date() },
    })).id;
    try {
      const need = await materialNeedListForJob(bareJob);
      expect(need).toEqual({ estimates: [], lines: [] });
    } finally {
      await prisma.visit.delete({ where: { id: bareJob } });
    }
  });
});

// ── PDF rendering — read the actual bytes, not the code that writes them ──────────────────────

const PROFILE: CompanyProfile = {
  legalName: "Red Cedar Electric LLC",
  phone: "615-625-2163",
  email: "service@redcedarelectricllc.com",
  tagline: "Licensed & Insured",
  mailingAddress: "PO Box 1, Franklin, TN 37064",
  licenseNumber: null,
  licenseState: "TN",
  financingUrl: "https://example.com/financing",
};

/** Same hex-run decoder as tests/issuedEstimatePdf.test.ts — pdfkit draws text as hex strings. */
function extractText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join("");
}

describe("renderMaterialsListPdf", () => {
  it("prints item, description, quantity, and unit — and no cost figures", async () => {
    const text = extractText(await renderMaterialsListPdf({
      customerName: "Unit L Materials Co",
      serviceAddress: "1 Materials Way, Franklin, TN 37064",
      jobLabel: "Unit L job",
      estimateNumbers: ["0000-UNITL-ORIG", "0000-UNITL-CO"],
      lines: [
        { itemId: WIRE, name: "Unit L 12-2 NM-B", unit: "ft", qty: 70 },
        { itemId: BREAKER, name: "Unit L 20A breaker", unit: "ea", qty: 2 },
      ],
    }, PROFILE));

    // Presence: the header and every field of every line.
    expect(text).toContain("Unit L Materials Co");
    expect(text).toContain("1 Materials Way");
    expect(text).toContain("0000-UNITL-ORIG");
    expect(text).toContain("0000-UNITL-CO");
    expect(text).toContain(WIRE);
    expect(text).toContain("Unit L 12-2 NM-B");
    expect(text).toContain("70");
    expect(text).toContain("ft");
    expect(text).toContain(BREAKER);
    expect(text).toContain("Unit L 20A breaker");

    // Absence, paired with the presence above so it means something: no dollar sign anywhere —
    // this document carries no cost, no on-hand, no short figures.
    expect(text).not.toContain("$");
    expect(text).not.toContain("cost");
    expect(text).not.toContain("Cost");
  });

  it("renders plainly for a job with no signed estimate — not a blank page, not a crash", async () => {
    const text = extractText(await renderMaterialsListPdf({
      customerName: null,
      serviceAddress: null,
      jobLabel: null,
      estimateNumbers: [],
      lines: [],
    }, PROFILE));
    expect(text).toContain("no signed estimate");
  });

  it("renders plainly when the signed estimate(s) carry no material lines", async () => {
    const text = extractText(await renderMaterialsListPdf({
      customerName: "Labour Only Co",
      serviceAddress: null,
      jobLabel: null,
      estimateNumbers: ["0000-UNITL-LABOR"],
      lines: [],
    }, PROFILE));
    expect(text).toContain("no material lines");
  });

  it("never prints the literal string \"null\" for a missing description or unit", async () => {
    const text = extractText(await renderMaterialsListPdf({
      customerName: "Unit L Materials Co",
      serviceAddress: null,
      jobLabel: null,
      estimateNumbers: ["0000-UNITL-ORIG"],
      lines: [
        { itemId: "UNITL-NOUNIT", name: "", unit: null, qty: 3 },
      ],
    }, PROFILE));
    expect(text).not.toContain("null");
    // The em dash pdfkit draws is WinAnsiEncoding byte 0x97 — decoding the hex run as latin1 (like
    // the rest of this file) yields code point U+0097, not the em dash's real U+2014, so that is
    // the byte to look for rather than the "—" character itself.
    expect(text).toContain("\x97");
  });
});
