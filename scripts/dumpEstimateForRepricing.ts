/**
 * Read-only dump of everything needed to re-price an issued estimate offline —
 * the frozen estimate, the draft behind it with every line's price-book row,
 * the live Rate Config, and a catalog search for candidate substitute items.
 *
 * Built for Kyle's what-if questions (2026-08-31: "I want to see how this
 * estimate would price out when we follow the 7290 model with the range on an
 * SMM… at $100/hr… wire and conduit sized appropriately") — the answer needs
 * production rows, and the database is reachable only inside the container:
 *
 *   railway ssh "node dist/scripts/dumpEstimateForRepricing.js --number 2026-1033 --search '7290|26 kw|smm|thhn|emt|conduit|transfer'"
 *
 * Writes nothing. Prints one JSON document to stdout.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ATOMIC_FIELDS = {
  itemId: true, description: true, category: true, subCategory: true, rowType: true, unit: true, unitLabel: true,
  laborNormal: true, laborDifficult: true, laborVeryDifficult: true,
  laborUnitBasis: true, laborUnitDivisor: true,
  companyCost: true, companyPrice: true, sellNormal: true, sellDifficult: true, sellVeryDifficult: true,
  costBasisUsed: true, sellPricePerUnit: true, markupTier: true, source: true, retiredAt: true,
} as const;

async function main(): Promise<void> {
  const number = arg("number");
  if (!number) {
    console.error("Usage: --number 2026-1033 [--search 'regex|terms']");
    process.exit(1);
  }
  const estimate = await prisma.issuedEstimate.findFirst({
    where: { number },
    orderBy: { revision: "desc" },
    select: {
      id: true, number: true, revision: true, title: true, status: true, draftId: true,
      tripCharge: true, tripWaived: true, workSubtotal: true, total: true,
      discountType: true, exclusiveOptions: true, selectedOptions: true,
      jobBandsJson: true, materialCapsJson: true, comboCapJson: true, validDays: true,
      options: { select: { option: true, label: true, subtotal: true } },
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          itemId: true, description: true, quantity: true, unitPrice: true, lineTotal: true, option: true,
          laborHours: true, materialSell: true, materialCost: true, flatPriced: true,
        },
      },
    },
  });
  if (!estimate) {
    console.error(`No issued estimate numbered ${number}.`);
    process.exit(1);
  }

  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: estimate.draftId },
    select: {
      id: true, title: true, supplierId: true, billedLaborRate: true, discountType: true, exclusiveOptions: true,
      status: true, jobDescription: true,
      optionMeta: { select: { option: true, label: true, note: true } },
      lines: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, itemId: true, quantity: true, quantitySource: true, difficulty: true, option: true,
          state: true, location: true, note: true,
          atomic: { select: ATOMIC_FIELDS },
        },
      },
    },
  });

  const rateConfig = await prisma.priceBookRateConfig.findMany({
    select: { key: true, numberValue: true, textValue: true },
    orderBy: { key: "asc" },
  });

  const search = arg("search");
  const terms = (search ?? "").split("|").map((t) => t.trim()).filter(Boolean);
  const candidates = terms.length === 0
    ? []
    : await prisma.priceBookAtomic.findMany({
        where: {
          retiredAt: null,
          OR: terms.flatMap((t) => [
            { description: { contains: t, mode: "insensitive" as const } },
            { itemId: { contains: t, mode: "insensitive" as const } },
            { subCategory: { contains: t, mode: "insensitive" as const } },
          ]),
        },
        select: ATOMIC_FIELDS,
        orderBy: { itemId: "asc" },
        take: 300,
      });

  const itemIds = [
    ...new Set([
      ...(draft?.lines ?? []).map((l) => l.itemId),
      ...candidates.map((c) => c.itemId),
    ]),
  ];
  const supplierPrices = itemIds.length === 0 ? [] : await prisma.priceBookSupplierPrice.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, supplierId: true, unitCost: true, quotable: true, pricedUom: true, packQty: true },
  });

  process.stdout.write(JSON.stringify({ estimate, draft, rateConfig, candidates, supplierPrices }, null, 1));
  process.stdout.write("\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
