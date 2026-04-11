import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function verify() {
  const estimates = await p.estimate.findMany({
    where: { title: { startsWith: "S" } },
    include: {
      visit: { include: { customer: true, property: true } },
      options: { include: { items: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nTotal scenario estimates: ${estimates.length}\n`);
  for (const e of estimates) {
    const itemCount = e.options.reduce((s, o) => s + o.items.length, 0);
    console.log(
      `${e.title.padEnd(50)} Customer: ${e.visit.customer.name.padEnd(25)} Items: ${itemCount}`
    );
  }

  await p.$disconnect();
}

verify();
