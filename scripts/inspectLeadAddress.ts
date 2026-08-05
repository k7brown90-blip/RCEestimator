/**
 * Prints a lead's raw address fields to check convert-readiness.
 * Usage: railway ssh -- npx tsx scripts/inspectLeadAddress.ts "<name substring>"
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  const nameSubstring = process.argv[2];
  if (!nameSubstring) {
    console.error("Usage: inspectLeadAddress.ts <name substring>");
    process.exit(1);
  }

  const leads = await prisma.lead.findMany({
    where: { name: { contains: nameSubstring, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (leads.length === 0) {
    console.log(`No leads matching "${nameSubstring}".`);
    return;
  }

  for (const lead of leads) {
    console.log(`\nid: ${lead.id}`);
    console.log(`name: ${lead.name}`);
    console.log(`status: ${lead.status}  leadStatus: ${lead.leadStatus}  source: ${lead.source}`);
    console.log(`phone: ${lead.phone ?? "-"}  email: ${lead.email ?? "-"}`);
    console.log(`address (free text): ${lead.address ?? "-"}`);
    console.log(`addressLine1: ${lead.addressLine1 ?? "-"}`);
    console.log(`city/state/zip: ${lead.city ?? "-"}, ${lead.state ?? "-"} ${lead.postalCode ?? "-"}`);
    console.log(`createdAt: ${lead.createdAt.toISOString()}`);
    console.log(`notes: ${lead.notes ?? "-"}`);
  }
}

main().finally(() => prisma.$disconnect());
