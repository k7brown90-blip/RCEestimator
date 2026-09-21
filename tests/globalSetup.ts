import { execSync } from "node:child_process";

const TEST_DB_ENV = {
  ...process.env,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/rce_crm_test",
};

export default async function globalSetup() {
  // schema.prisma declares trigram GIN indexes for global search (2026-09-20), and `db push`
  // creates them straight from the schema — which fails unless pg_trgm is already installed.
  // Production gets the extension from the migration (which survives a role that cannot
  // install it); the test database has no migration path, so it is installed here first. Local
  // and CI both run as the `postgres` superuser, so this cannot be refused there.
  await ensureExtensions(TEST_DB_ENV.DATABASE_URL);

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

/** pg_trgm, before `db push` asks for the GIN indexes that need it. See globalSetup above. */
async function ensureExtensions(databaseUrl: string) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  } finally {
    await prisma.$disconnect();
  }
}
