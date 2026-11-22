import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit and component tests run in jsdom against a mocked API — they never
// start the app or touch port 4000 (that's the e2e suite's job).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/testSetup.ts"],
  },
});
