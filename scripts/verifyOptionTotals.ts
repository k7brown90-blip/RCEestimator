/**
 * Verify that EstimateOption.totalCost is non-zero for all scenario estimates.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const estimates = await prisma.estimate.findMany({
    where: { title: { startsWith: "S" } },
    include: {
      options: {
        select: {
          optionLabel: true,
          subtotalLabor: true,
          subtotalMaterial: true,
          subtotalOther: true,
          totalCost: true,
        },
      },
    },
    orderBy: { title: "asc" },
  });

  let allGood = true;
  for (const est of estimates) {
    for (const opt of est.options) {
      const status = opt.totalCost > 0 ? "✓" : "✗ $0 BUG";
      if (opt.totalCost === 0) allGood = false;
      console.log(
        `  ${status}  ${est.title.padEnd(50)} ` +
        `Labor: $${opt.subtotalLabor.toFixed(2).padStart(9)}  ` +
        `Material: $${opt.subtotalMaterial.toFixed(2).padStart(8)}  ` +
        `Total: $${opt.totalCost.toFixed(2).padStart(9)}`
      );
    }
  }

  console.log(allGood ? "\n✓ All option totals are non-zero!" : "\n✗ Some options still show $0!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
