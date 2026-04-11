/**
 * Clear all seeded scenario estimate data so we can re-seed with updated pricing.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const scenarioEmails = Array.from(
    { length: 24 },
    (_, i) => `scenario${i + 1}@redcedarelectric.test`
  );

  const customers = await prisma.customer.findMany({
    where: { email: { in: scenarioEmails } },
  });
  const customerIds = customers.map((c) => c.id);
  console.log(`Found ${customerIds.length} scenario customers`);

  if (customerIds.length === 0) {
    console.log("No scenario data to clear");
    return;
  }

  const properties = await prisma.property.findMany({
    where: { customerId: { in: customerIds } },
  });
  const propertyIds = properties.map((p) => p.id);

  const visits = await prisma.visit.findMany({
    where: { propertyId: { in: propertyIds } },
  });
  const visitIds = visits.map((v) => v.id);

  const estimates = await prisma.estimate.findMany({
    where: { visitId: { in: visitIds } },
  });
  const estimateIds = estimates.map((e) => e.id);

  const options = await prisma.estimateOption.findMany({
    where: { estimateId: { in: estimateIds } },
  });
  const optionIds = options.map((o) => o.id);

  // Delete in dependency order
  const mods = await prisma.itemModifier.deleteMany({
    where: { estimateItem: { estimateOptionId: { in: optionIds } } },
  });
  console.log(`Deleted ${mods.count} item modifiers`);

  const items = await prisma.estimateItem.deleteMany({
    where: { estimateOptionId: { in: optionIds } },
  });
  console.log(`Deleted ${items.count} estimate items`);

  const support = await prisma.supportItem.deleteMany({
    where: { estimateId: { in: estimateIds } },
  });
  console.log(`Deleted ${support.count} support items`);

  const opts = await prisma.estimateOption.deleteMany({
    where: { estimateId: { in: estimateIds } },
  });
  console.log(`Deleted ${opts.count} options`);

  const ests = await prisma.estimate.deleteMany({
    where: { id: { in: estimateIds } },
  });
  console.log(`Deleted ${ests.count} estimates`);

  const vis = await prisma.visit.deleteMany({
    where: { id: { in: visitIds } },
  });
  console.log(`Deleted ${vis.count} visits`);

  const snaps = await prisma.systemSnapshot.deleteMany({
    where: { propertyId: { in: propertyIds } },
  });
  console.log(`Deleted ${snaps.count} system snapshots`);

  const props = await prisma.property.deleteMany({
    where: { id: { in: propertyIds } },
  });
  console.log(`Deleted ${props.count} properties`);

  const custs = await prisma.customer.deleteMany({
    where: { id: { in: customerIds } },
  });
  console.log(`Deleted ${custs.count} customers`);

  console.log("\n✓ Scenario data cleared.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
