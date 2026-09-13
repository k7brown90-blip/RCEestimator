/**
 * The monthly supplier-price refresh (2026-09-12, barcode/materials plan Unit 5).
 *
 * "The book is never written automatically." (Kyle, 2026-09-12) — buildPriceProposal /
 * runMonthlyPriceRefresh must never write PriceBookAtomic; acceptPriceProposalLine is the
 * only writer, and only one line at a time, on the operator's say-so.
 *
 * RETARGETED 2026-09-13 (Kyle's ruling): accepting writes the item's `companyCost` (through
 * `updateAtomic`'s guarded path in priceBookCatalog.ts), not `PriceBookSupplierPrice.unitCost` —
 * `atomicEstimateService.ts` resolves an item's cost from `companyCost`, so the old target changed
 * none of Kyle's actual prices. These tests were retargeted accordingly, not deleted — the
 * behaviour they pin still matters.
 *
 * Pins down:
 *   1. Median outlier resistance — a $1,197-for-$11.97 misread among real $11.97 observations
 *      must not move the candidate price.
 *   2. A minimum observation count — below it, nothing is proposed.
 *   3. Barcode/sku observations outrank name_fuzzy for the same item.
 *   4. An assembly itemId is refused a cost, both in the proposal (skipped before the median
 *      step) and at accept (assertNotAssembly, reused, not reimplemented).
 *   5. Accepting writes the item's companyCost AND recomputes companyPrice/sell*, leaving a
 *      recoverable trail via PriceBookEdit.
 *   6. A dry run (buildPriceProposal) writes nothing to PriceBookAtomic.
 *   7. THE CASCADE — accepting a component's new price recomputes and persists every assembly
 *      containing it (stored companyCost + sell*) in the SAME transaction, and the preview
 *      (findAssemblyImpacts) predicts exactly those values via the same computation.
 *   8. ATOMICITY (2026-09-13, security-review follow-up) — a forced failure partway through a
 *      multi-assembly cascade rolls back the COMPONENT'S OWN companyCost too, not only the
 *      un-cascaded assemblies. Pins the one-transaction guarantee against a future `try/catch`
 *      "for better error messages" silently allowing a partial cascade.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { createMaterial } from "../src/services/materials";
import { createAssembly } from "../src/services/priceBookAssembly";
import { computePricing, loadPricingContext } from "../src/services/priceBookCatalog";
import {
  acceptPriceProposalLine,
  buildPriceProposal,
  findAssemblyImpacts,
  median,
  MIN_OBSERVATIONS_FOR_PROPOSAL,
} from "../src/services/priceBookRefresh";

const newId = () => crypto.randomUUID().slice(0, 8).toUpperCase();

const createdAtomicIds: string[] = [];
const createdMaterialIds: string[] = [];

function materialAtomic(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: `TU5-${newId()}`,
    description: "test material",
    category: "Test",
    rowType: "MATERIAL + LABOR",
    source: "in-app",
    companyCost: 10,
    laborNormal: 0.25,
    laborDifficult: 0.35,
    laborVeryDifficult: 0.5,
    laborUnitBasis: "E",
    laborUnitDivisor: 1,
    ...overrides,
  };
}

async function makeAtomic(overrides: Partial<Record<string, unknown>> = {}) {
  const data = materialAtomic(overrides);
  const row = await prisma.priceBookAtomic.create({ data: data as never });
  createdAtomicIds.push(row.itemId);
  return row;
}

async function makeMaterial(overrides: Partial<Record<string, unknown>> = {}) {
  const result = await createMaterial(prisma, { description: "test material", ...overrides } as never);
  if (!result.ok) throw new Error(result.reason);
  createdMaterialIds.push(result.material.id);
  return result.material;
}

/** Insert observations directly — the median/ranking/proposal logic is under test here, not
 * receipt parsing (materialPriceObservations.test.ts already covers ingestion). */
async function makeObservation(opts: {
  materialId: string;
  itemId: string;
  supplier: string;
  unitCost: number;
  matchMethod: "barcode" | "sku" | "name_fuzzy" | "manual";
  observedAt?: Date;
}) {
  return prisma.materialPriceObservation.create({
    data: {
      materialId: opts.materialId,
      itemId: opts.itemId,
      supplier: opts.supplier,
      observedAt: opts.observedAt ?? new Date(),
      qty: 1,
      unitCost: opts.unitCost,
      source: "manual",
      matchMethod: opts.matchMethod,
    },
  });
}

afterAll(async () => {
  await prisma.materialPriceObservation.deleteMany({ where: { materialId: { in: createdMaterialIds } } });
  await prisma.material.deleteMany({ where: { id: { in: createdMaterialIds } } });
  await prisma.priceBookItemComponent.deleteMany({ where: { parentItemId: { in: createdAtomicIds } } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: createdAtomicIds } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: createdAtomicIds } } });
});

describe("median()", () => {
  it("is the untouched middle value at odd counts", () => {
    expect(median([11.97, 11.97, 11.97])).toBe(11.97);
  });

  it("a single extreme outlier does not move the median at n=3+", () => {
    expect(median([11.97, 11.97, 1197])).toBe(11.97);
    expect(median([11.97, 11.97, 11.97, 11.97, 1197])).toBe(11.97);
  });
});

describe("buildPriceProposal — outlier resistance (the median case)", () => {
  it("a $1,197-for-$11.97 misread among real observations does not move the candidate price", async () => {
    const supplier = `Home Depot ${newId()}`;
    const atomic = await makeAtomic();
    const material = await makeMaterial({ supplier, itemId: atomic.itemId });

    // 4 real observations at 11.97, 1 outlier at 1197 — all name_fuzzy, so all share one rank
    // group and all count toward the median together.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 11.97, matchMethod: "name_fuzzy" });
    }
    await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 1197, matchMethod: "name_fuzzy" });

    const proposal = await buildPriceProposal(prisma);
    const line = proposal.lines.find((l) => l.itemId === atomic.itemId);
    expect(line).toBeDefined();
    expect(line?.candidateUnitCost).toBeCloseTo(11.97, 2);
    expect(line?.observationCount).toBe(5);
  });
});

describe("buildPriceProposal — minimum observation count", () => {
  it(`below ${MIN_OBSERVATIONS_FOR_PROPOSAL} observations, nothing is proposed for that item/supplier`, async () => {
    const supplier = `Home Depot ${newId()}`;
    const atomic = await makeAtomic();
    const material = await makeMaterial({ supplier, itemId: atomic.itemId });

    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 5, matchMethod: "name_fuzzy" });
    }

    const proposal = await buildPriceProposal(prisma);
    expect(proposal.lines.find((l) => l.itemId === atomic.itemId)).toBeUndefined();
  });

  it(`at exactly ${MIN_OBSERVATIONS_FOR_PROPOSAL}, a proposal line appears`, async () => {
    const supplier = `Home Depot ${newId()}`;
    const atomic = await makeAtomic();
    const material = await makeMaterial({ supplier, itemId: atomic.itemId });

    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 5, matchMethod: "name_fuzzy" });
    }

    const proposal = await buildPriceProposal(prisma);
    const line = proposal.lines.find((l) => l.itemId === atomic.itemId);
    expect(line).toBeDefined();
    // atomic was created with companyCost: 10 — the proposal must show it beside the candidate,
    // not a supplier price (2026-09-13 retarget: PriceBookSupplierPrice has no runtime writer).
    expect(line?.currentCompanyCost).toBe(10);
  });
});

describe("buildPriceProposal — barcode/sku outranks name_fuzzy", () => {
  it("only the highest-ranked group counts toward the median, for the same item", async () => {
    const supplier = `Home Depot ${newId()}`;
    const atomic = await makeAtomic();
    const material = await makeMaterial({ supplier, itemId: atomic.itemId });

    // 5 cheap name_fuzzy misfires, then 4 real barcode reads at a higher, correct price.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 0.5, matchMethod: "name_fuzzy" });
    }
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 3.25, matchMethod: "barcode" });
    }

    const proposal = await buildPriceProposal(prisma);
    const line = proposal.lines.find((l) => l.itemId === atomic.itemId);
    expect(line?.matchMethod).toBe("barcode");
    expect(line?.observationCount).toBe(4);
    expect(line?.candidateUnitCost).toBeCloseTo(3.25, 2);
  });
});

describe("the assembly guard — an assembly itemId is refused a cost", () => {
  it("buildPriceProposal skips an assembly itemId before the median step", async () => {
    const component = await makeAtomic({ companyCost: 10 });
    const assemblyResult = await createAssembly(prisma, {
      description: "test assembly for refresh guard",
      category: "Test",
      components: [{ childItemId: component.itemId, quantity: 1 }],
    }, "test");
    if (!assemblyResult.ok) throw new Error(assemblyResult.reason);
    createdAtomicIds.push((assemblyResult.atomic as { itemId: string }).itemId);
    const assemblyItemId = (assemblyResult.atomic as { itemId: string }).itemId;

    // Material.itemId itself is guarded against pointing at an assembly (services/materials.ts,
    // assertNotAssembly) — so to exercise buildPriceProposal's OWN defensive check, the material
    // stays unlinked and the observation's denormalised itemId is set directly, the same way a
    // stale/manual row could carry it.
    const supplier = `Home Depot ${newId()}`;
    const material = await makeMaterial({ supplier });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: assemblyItemId, supplier, unitCost: 5, matchMethod: "name_fuzzy" });
    }

    const proposal = await buildPriceProposal(prisma);
    expect(proposal.lines.find((l) => l.itemId === assemblyItemId)).toBeUndefined();
    expect(proposal.skippedAssemblyItemIds).toContain(assemblyItemId);
  });

  it("acceptPriceProposalLine refuses an assembly itemId outright, and its companyCost is untouched", async () => {
    const assemblyResult = await createAssembly(prisma, {
      description: "test assembly for accept guard",
      category: "Test",
      components: [],
    }, "test");
    if (!assemblyResult.ok) throw new Error(assemblyResult.reason);
    const assemblyItemId = (assemblyResult.atomic as { itemId: string }).itemId;
    createdAtomicIds.push(assemblyItemId);
    const before = await prisma.priceBookAtomic.findUnique({ where: { itemId: assemblyItemId }, select: { companyCost: true } });

    const result = await acceptPriceProposalLine(prisma, { itemId: assemblyItemId, supplierName: "Home Depot" }, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/assembly/i);

    const after = await prisma.priceBookAtomic.findUnique({ where: { itemId: assemblyItemId }, select: { companyCost: true } });
    expect(after?.companyCost).toBe(before?.companyCost);
  });
});

describe("acceptPriceProposalLine — writes companyCost, recomputes sell*, and leaves a trail", () => {
  it("updates the item's companyCost and companyPrice/sell*, recording the prior value on PriceBookEdit", async () => {
    const supplierName = `Home Depot ${newId()}`;
    const atomic = await makeAtomic({ companyCost: 10 });
    const material = await makeMaterial({ supplier: supplierName, itemId: atomic.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier: supplierName, unitCost: 7.5, matchMethod: "barcode" });
    }

    const first = await acceptPriceProposalLine(prisma, { itemId: atomic.itemId, supplierName }, "test-operator");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first accept to succeed");
    expect(first.companyCost).toBeCloseTo(7.5, 2);
    expect(first.priorCompanyCost).toBeCloseTo(10, 2);

    const row = await prisma.priceBookAtomic.findUnique({ where: { itemId: atomic.itemId } });
    expect(row?.companyCost).toBeCloseTo(7.5, 2);
    // companyPrice/sell* must have recomputed from the new companyCost via the book's own
    // formula (priceBookCatalog.ts's computePricing) — not a raw write that would leave them
    // stale. Pinned against an independent computation, not merely "differs from before", so this
    // holds regardless of what PriceBookRateConfig happens to contain in the test database.
    const { tiers, rate } = await loadPricingContext(prisma);
    const expected = computePricing(
      { rowType: "MATERIAL + LABOR", companyCost: 7.5, laborNormal: 0.25, laborDifficult: 0.35, laborVeryDifficult: 0.5 },
      tiers,
      rate,
    );
    expect(row?.companyPrice).toBe(expected.companyPrice);
    expect(row?.sellNormal).toBe(expected.sellNormal);
    expect(row?.sellDifficult).toBe(expected.sellDifficult);
    expect(row?.sellVeryDifficult).toBe(expected.sellVeryDifficult);

    // A second, higher round of observations — accepting again must show the PRIOR value as
    // recoverable, not silently overwrite it with no trace. The first round is cleared first so
    // the median reflects only the new round (mirrors what a fresh receipt re-ingestion would do).
    await prisma.materialPriceObservation.deleteMany({ where: { itemId: atomic.itemId, supplier: supplierName } });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier: supplierName, unitCost: 9.25, matchMethod: "barcode" });
    }
    const second = await acceptPriceProposalLine(prisma, { itemId: atomic.itemId, supplierName }, "test-operator");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected second accept to succeed");
    expect(second.priorCompanyCost).toBeCloseTo(7.5, 2);

    const edits = await prisma.priceBookEdit.findMany({
      where: { itemId: atomic.itemId, field: "priceProposalAccepted" },
      orderBy: { createdAt: "asc" },
    });
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(Number(edits[0].oldValue)).toBeCloseTo(10, 2);
    expect(Number(edits[0].newValue)).toBeCloseTo(7.5, 2);
    expect(Number(edits[1].oldValue)).toBeCloseTo(7.5, 2);
    expect(Number(edits[1].newValue)).toBeCloseTo(9.25, 2);

    // The generic companyCost field edit (from updateAtomic's own audit trail) also recorded the
    // prior value — the "recoverable" guarantee holds at the mechanical field level too.
    const companyCostEdits = await prisma.priceBookEdit.findMany({
      where: { itemId: atomic.itemId, field: "companyCost" },
      orderBy: { createdAt: "asc" },
    });
    expect(companyCostEdits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("dry run — buildPriceProposal writes nothing", () => {
  it("companyCost is unchanged on PriceBookAtomic after a dry-run proposal", async () => {
    const supplier = `Home Depot ${newId()}`;
    const atomic = await makeAtomic({ companyCost: 10 });
    const material = await makeMaterial({ supplier, itemId: atomic.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier, unitCost: 4.4, matchMethod: "barcode" });
    }

    const proposal = await buildPriceProposal(prisma);
    const line = proposal.lines.find((l) => l.itemId === atomic.itemId);
    expect(line).toBeDefined();
    // The candidate (4.4) differs from the stored cost (10) — proving this is a live proposal,
    // not a no-op — yet the stored row must be untouched by merely proposing.
    expect(line?.candidateUnitCost).toBeCloseTo(4.4, 2);

    const row = await prisma.priceBookAtomic.findUnique({ where: { itemId: atomic.itemId }, select: { companyCost: true } });
    expect(row?.companyCost).toBe(10);
  });
});

describe("assembly blast radius — the cascade and its preview share one computation", () => {
  it("findAssemblyImpacts reports which assemblies move, and by how much, for a component whose price moves", async () => {
    const componentA = await makeAtomic({ companyCost: 10 });
    const componentB = await makeAtomic({ companyCost: 5 });
    const assemblyResult = await createAssembly(prisma, {
      description: "blast radius test assembly",
      category: "Test",
      components: [
        { childItemId: componentA.itemId, quantity: 1 },
        { childItemId: componentB.itemId, quantity: 1 },
      ],
    }, "test");
    if (!assemblyResult.ok) throw new Error(assemblyResult.reason);
    const assemblyAtomic = assemblyResult.atomic as { itemId: string; companyCost: number | null };
    createdAtomicIds.push(assemblyAtomic.itemId);
    expect(assemblyAtomic.companyCost).toBe(15); // 10 + 5, sanity check on the fixture

    // Directly exercise findAssemblyImpacts — the pure preview function reused by buildPriceProposal.
    const impacts = await findAssemblyImpacts(prisma, componentA.itemId, 12);
    const impact = impacts.find((i) => i.assemblyItemId === assemblyAtomic.itemId);
    expect(impact).toBeDefined();
    expect(impact?.currentCost).toBe(15);
    expect(impact?.projectedCost).toBe(17); // 12 + 5
    expect(impact?.delta).toBeCloseTo(2, 2);
    expect(impact?.projectedSellNormal).not.toBeNull();
    // Pinned against an independent computePricing call (both components carry laborNormal 0.25,
    // quantity 1 each → assembly laborNormal 0.5), not "differs from current" — correct either
    // way, regardless of what PriceBookRateConfig contains in the test database.
    const { tiers, rate } = await loadPricingContext(prisma);
    const expectedProjected = computePricing(
      { rowType: "ASSEMBLY", companyCost: 17, laborNormal: 0.5, laborDifficult: 0.7, laborVeryDifficult: 1 },
      tiers,
      rate,
    );
    expect(impact?.projectedSellNormal).toBe(expectedProjected.sellNormal);
    expect(impact?.projectedCompanyPrice).toBe(expectedProjected.companyPrice);

    // And end-to-end through buildPriceProposal: a real price move on componentA must surface the
    // assembly it belongs to, before anything is accepted.
    const supplier = `Home Depot ${newId()}`;
    const material = await makeMaterial({ supplier, itemId: componentA.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: componentA.itemId, supplier, unitCost: 12, matchMethod: "barcode" });
    }
    const proposal = await buildPriceProposal(prisma);
    const line = proposal.lines.find((l) => l.itemId === componentA.itemId);
    expect(line).toBeDefined();
    const affected = line?.affectedAssemblies.find((a) => a.assemblyItemId === assemblyAtomic.itemId);
    expect(affected).toBeDefined();
    expect(affected?.currentCost).toBe(15);
    expect(affected?.projectedCost).toBe(17);
    expect(affected?.delta).toBeCloseTo(2, 2);
  });

  it("THE CASCADE: accepting a component's price updates the containing assembly's stored companyCost and sell*, matching the preview exactly", async () => {
    const componentA = await makeAtomic({ companyCost: 10 });
    const componentB = await makeAtomic({ companyCost: 5 });
    const assemblyResult = await createAssembly(prisma, {
      description: "cascade test assembly",
      category: "Test",
      components: [
        { childItemId: componentA.itemId, quantity: 2 },
        { childItemId: componentB.itemId, quantity: 1 },
      ],
    }, "test");
    if (!assemblyResult.ok) throw new Error(assemblyResult.reason);
    const assemblyAtomic = assemblyResult.atomic as { itemId: string; companyCost: number | null };
    createdAtomicIds.push(assemblyAtomic.itemId);
    expect(assemblyAtomic.companyCost).toBe(25); // 10*2 + 5

    const supplierName = `Home Depot ${newId()}`;
    const material = await makeMaterial({ supplier: supplierName, itemId: componentA.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: componentA.itemId, supplier: supplierName, unitCost: 20, matchMethod: "barcode" });
    }

    // Predict via the preview BEFORE accepting — this must equal what accepting actually does.
    const preview = await findAssemblyImpacts(prisma, componentA.itemId, 20);
    const previewImpact = preview.find((i) => i.assemblyItemId === assemblyAtomic.itemId);
    expect(previewImpact).toBeDefined();
    expect(previewImpact?.projectedCost).toBe(45); // 20*2 + 5

    const before = await prisma.priceBookAtomic.findUnique({ where: { itemId: assemblyAtomic.itemId } });

    const accepted = await acceptPriceProposalLine(prisma, { itemId: componentA.itemId, supplierName }, "test-operator");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("expected accept to succeed");
    expect(accepted.companyCost).toBeCloseTo(20, 2);

    // The accept result reports the cascaded assembly directly.
    const cascaded = accepted.cascadedAssemblies.find((a) => a.assemblyItemId === assemblyAtomic.itemId);
    expect(cascaded).toBeDefined();
    expect(cascaded?.priorCompanyCost).toBe(25);
    expect(cascaded?.companyCost).toBe(45);

    // And the row itself, read back fresh, matches — both the stored companyCost and the sell*
    // columns moved together, in the same accept. companyCost itself (pure rollup arithmetic,
    // independent of any RateConfig) is asserted against a hard number either way.
    const after = await prisma.priceBookAtomic.findUnique({ where: { itemId: assemblyAtomic.itemId } });
    expect(after?.companyCost).toBe(45);
    expect(after?.companyCost).not.toBe(before?.companyCost);

    // sell*/companyPrice are pinned against an independent computePricing call, not "differs from
    // before" — correct either way, regardless of what PriceBookRateConfig contains.
    const { tiers, rate } = await loadPricingContext(prisma);
    const expectedAssembly = computePricing(
      { rowType: "ASSEMBLY", companyCost: 45, laborNormal: 0.75, laborDifficult: 1.05, laborVeryDifficult: 1.5 },
      tiers,
      rate,
    );
    expect(after?.companyPrice).toBe(expectedAssembly.companyPrice);
    expect(after?.sellNormal).toBe(expectedAssembly.sellNormal);
    expect(after?.sellDifficult).toBe(expectedAssembly.sellDifficult);
    expect(after?.sellVeryDifficult).toBe(expectedAssembly.sellVeryDifficult);

    // The preview computed BEFORE accepting matches the actual post-accept row exactly — same
    // function, same numbers.
    expect(previewImpact?.projectedCost).toBe(after?.companyCost);
    expect(previewImpact?.projectedCompanyPrice).toBe(after?.companyPrice);
    expect(previewImpact?.projectedSellNormal).toBe(after?.sellNormal);
    expect(previewImpact?.projectedSellDifficult).toBe(after?.sellDifficult);
    expect(previewImpact?.projectedSellVeryDifficult).toBe(after?.sellVeryDifficult);

    // And it matches computeComponentRollup's own math directly (never a second implementation):
    // 20*2 + 5 = 45.
    expect(after?.companyCost).toBe(2 * 20 + 5);

    // The edit trail records the cascaded assembly's prior value too, not only the component's.
    const assemblyEdits = await prisma.priceBookEdit.findMany({
      where: { itemId: assemblyAtomic.itemId, field: "companyCost" },
      orderBy: { createdAt: "asc" },
    });
    expect(assemblyEdits.length).toBeGreaterThanOrEqual(1);
    const lastEdit = assemblyEdits[assemblyEdits.length - 1];
    expect(Number(lastEdit.oldValue)).toBe(25);
    expect(Number(lastEdit.newValue)).toBe(45);
  });

  it("a component with no assemblies produces an empty cascade list and no assembly edit rows", async () => {
    const supplierName = `Home Depot ${newId()}`;
    const atomic = await makeAtomic({ companyCost: 3 });
    const material = await makeMaterial({ supplier: supplierName, itemId: atomic.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: atomic.itemId, supplier: supplierName, unitCost: 6, matchMethod: "barcode" });
    }
    const accepted = await acceptPriceProposalLine(prisma, { itemId: atomic.itemId, supplierName }, "test-operator");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("expected accept to succeed");
    expect(accepted.cascadedAssemblies).toHaveLength(0);
  });
});

describe("acceptPriceProposalLine — atomicity: a partial cascade must never partially persist", () => {
  it("a forced failure on a later assembly write rolls back the component's OWN companyCost too, not just the un-cascaded assemblies", async () => {
    // Two assemblies both contain componentA, so the cascade loop in acceptPriceProposalLine
    // touches priceBookAtomic.update TWICE for assemblies, plus once up front for the component's
    // own companyCost (applyAtomicUpdatePlan, priceBookCatalog.ts) — three writes total, in one
    // transaction. This test does not change priceBookRefresh.ts; it wraps the real
    // prisma.$transaction from outside so one specific write, partway through, can be made to
    // throw — the exact "swallowed error in the loop" scenario the security review flagged.
    const componentA = await makeAtomic({ companyCost: 10 });
    const assembly1 = await createAssembly(prisma, {
      description: "atomicity test assembly 1",
      category: "Test",
      components: [{ childItemId: componentA.itemId, quantity: 1 }],
    }, "test");
    if (!assembly1.ok) throw new Error(assembly1.reason);
    const assembly1Atomic = assembly1.atomic as { itemId: string; companyCost: number | null };
    createdAtomicIds.push(assembly1Atomic.itemId);

    const assembly2 = await createAssembly(prisma, {
      description: "atomicity test assembly 2",
      category: "Test",
      components: [{ childItemId: componentA.itemId, quantity: 3 }],
    }, "test");
    if (!assembly2.ok) throw new Error(assembly2.reason);
    const assembly2Atomic = assembly2.atomic as { itemId: string; companyCost: number | null };
    createdAtomicIds.push(assembly2Atomic.itemId);

    const supplierName = `Home Depot ${newId()}`;
    const material = await makeMaterial({ supplier: supplierName, itemId: componentA.itemId });
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PROPOSAL; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeObservation({ materialId: material.id, itemId: componentA.itemId, supplier: supplierName, unitCost: 20, matchMethod: "barcode" });
    }

    const priorComponentCost = componentA.companyCost;
    const priorAssembly1Cost = assembly1Atomic.companyCost;
    const priorAssembly2Cost = assembly2Atomic.companyCost;

    // Call 1 = the component's own companyCost write. Calls 2 and 3 = the two cascaded assembly
    // writes, in whatever order tx.priceBookItemComponent.findMany returns them. Throwing on call
    // 3 means BOTH assembly writes are attempted (the first one actually runs against the real
    // transaction connection) before the failure — the strongest version of this test, because it
    // proves an assembly write that already succeeded inside the transaction still gets undone.
    const FAIL_AT_CALL = 3;
    let updateCalls = 0;
    const realTransaction = prisma.$transaction.bind(prisma);
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementation(((callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
      realTransaction(async (tx) => {
        const txAny = tx as unknown as { priceBookAtomic: Record<string, unknown> };
        const realDelegate = txAny.priceBookAtomic;
        const patchedDelegate = new Proxy(realDelegate, {
          get(target, prop) {
            if (prop === "update") {
              return async (...args: unknown[]) => {
                updateCalls += 1;
                if (updateCalls === FAIL_AT_CALL) {
                  throw new Error(`forced failure on priceBookAtomic.update call #${FAIL_AT_CALL} (atomicity test)`);
                }
                return (target as { update: (...a: unknown[]) => unknown }).update(...args);
              };
            }
            const value = target[prop as keyof typeof target];
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        // Own-property override on this specific tx instance — shadows whatever getter or cached
        // delegate Prisma would otherwise return, so every access to tx.priceBookAtomic for the
        // rest of this transaction goes through the patched delegate.
        Object.defineProperty(txAny, "priceBookAtomic", { value: patchedDelegate, configurable: true });
        return callback(tx);
      }, options as never)) as typeof prisma.$transaction);

    try {
      await expect(
        acceptPriceProposalLine(prisma, { itemId: componentA.itemId, supplierName }, "test-operator"),
      ).rejects.toThrow(/forced failure on priceBookAtomic\.update call #3/);
    } finally {
      txSpy.mockRestore();
    }

    expect(updateCalls).toBe(FAIL_AT_CALL); // sanity: we actually reached the intended write, not an earlier one

    // THE PIN: the component's OWN companyCost is rolled back — the assertion a swallowed cascade
    // error would NOT catch, since the component's write (call 1) is the one furthest from the
    // point of failure and would be the first thing left stranded by a caught-and-ignored throw.
    const componentAfter = await prisma.priceBookAtomic.findUnique({ where: { itemId: componentA.itemId } });
    expect(componentAfter?.companyCost).toBe(priorComponentCost);

    // And neither assembly kept its write either — including the one whose update call actually
    // ran (call 2) before call 3 threw. A real partial-cascade bug would show exactly one of
    // these two still at its OLD value and the other moved, or the component moved while an
    // assembly didn't; here every one of the three must be back to where it started.
    const assembly1After = await prisma.priceBookAtomic.findUnique({ where: { itemId: assembly1Atomic.itemId } });
    const assembly2After = await prisma.priceBookAtomic.findUnique({ where: { itemId: assembly2Atomic.itemId } });
    expect(assembly1After?.companyCost).toBe(priorAssembly1Cost);
    expect(assembly2After?.companyCost).toBe(priorAssembly2Cost);

    // No PriceBookEdit trail from THIS attempt should have been left behind either — a
    // rolled-back transaction leaves no trace, recoverable or otherwise. Scoped to the fields/
    // notes only the accept path itself writes, since createAssembly above already left its own
    // "created" edit rows on these same itemIds before this attempt ever ran.
    const strandedEdits = await prisma.priceBookEdit.findMany({
      where: {
        itemId: { in: [componentA.itemId, assembly1Atomic.itemId, assembly2Atomic.itemId] },
        OR: [{ field: "priceProposalAccepted" }, { note: { contains: "Cascaded: component" } }],
      },
    });
    expect(strandedEdits).toHaveLength(0);
  });
});
