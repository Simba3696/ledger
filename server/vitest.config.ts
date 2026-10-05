import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    // Store tests share one local Postgres and truncate tables between
    // cases, so test files must not run concurrently (LLD §10).
    fileParallelism: false,
  },
});
