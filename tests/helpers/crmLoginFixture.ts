import { randomUUID } from "node:crypto";
import { prisma } from "../../src/lib/prisma";

/**
 * Roster people for the CRM login tests. Every caller tears down with `cleanupCrmLoginFixtures`,
 * which removes the logins first (CrmLogin.technicianId is onDelete Restrict) and then the people
 * this helper created.
 */
const created: string[] = [];

export async function makePerson(name = "Test Person"): Promise<{ id: string; name: string }> {
  const row = await prisma.technician.create({
    data: { name, accessToken: `crm-login-test-${randomUUID()}` },
    select: { id: true, name: true },
  });
  created.push(row.id);
  return row;
}

export async function cleanupCrmLoginFixtures(): Promise<void> {
  await prisma.crmLogin.deleteMany();
  await prisma.adminLogin.deleteMany();
  if (created.length > 0) {
    await prisma.technician.deleteMany({ where: { id: { in: created.splice(0) } } });
  }
}
