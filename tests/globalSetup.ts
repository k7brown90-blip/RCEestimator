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

  // Seed atomic catalog data (units, modifiers, NEC rules, presets, job types)
  execSync("npx tsx scripts/seedAtomicUnits.ts", {
    stdio: "ignore",
    env: TEST_DB_ENV,
  });
}
