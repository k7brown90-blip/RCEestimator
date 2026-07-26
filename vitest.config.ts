import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/rce_crm_test";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
    globalSetup: ["./tests/globalSetup.ts"],
  },
});
