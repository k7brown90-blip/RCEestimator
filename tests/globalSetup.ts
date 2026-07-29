import { execSync } from "node:child_process";

const TEST_DB_ENV = {
  ...process.env,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/rce_crm_test",
};

export default async function globalSetup() {
  // Push schema to test DB. --accept-data-loss: test.db is throwaway, and a
  // retired model (e.g. NECRule) lingering in an old test.db otherwise makes
  // Prisma prompt interactively and hang under stdio:"ignore".
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "ignore",
    env: TEST_DB_ENV,
  });

  // `db push` builds the schema from schema.prisma and never runs migration SQL,
  // so anything Prisma's schema language can't express would exist in production
  // and not here. Apply those by hand or they go untested.
  await applyHandWrittenIndexes(TEST_DB_ENV.DATABASE_URL);

  // Seed atomic catalog data (units, modifiers, NEC rules, presets, job types)
  execSync("npx tsx scripts/seedAtomicUnits.ts", {
    stdio: "ignore",
    env: TEST_DB_ENV,
  });
}

/**
 * Partial unique indexes, which Prisma's schema language has no syntax for.
 *
 * PropertyFinding_live_unique is what makes "at most one live finding per
 * (property, item, location)" a database guarantee rather than a convention the
 * reconciler is trusted to keep. Without it here, a test suite would happily
 * pass on a race that production rejects.
 */
async function applyHandWrittenIndexes(databaseUrl: string) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "PropertyFinding_live_unique"
        ON "PropertyFinding"("propertyId", "itemId", "locationKey")
        WHERE "status" IN ('open', 'scheduled')
    `);
  } finally {
    await prisma.$disconnect();
  }
}
