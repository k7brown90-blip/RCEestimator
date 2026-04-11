import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    env: {
      DATABASE_URL: "file:./prisma/test.db",
    },
    globalSetup: ["./tests/globalSetup.ts"],
  },
});
