import { execSync } from "node:child_process";

const TEST_DB_ENV = {
  ...process.env,
  DATABASE_URL: "file:./prisma/test.db",
};

export default async function globalSetup() {
  // Push schema to test DB
  execSync("npx prisma db push --skip-generate", {
    stdio: "ignore",
    env: TEST_DB_ENV,
  });

  // Seed atomic catalog data (units, modifiers, NEC rules, presets, job types)
  execSync("npx tsx scripts/seedAtomicUnits.ts", {
    stdio: "ignore",
    env: TEST_DB_ENV,
  });
}
