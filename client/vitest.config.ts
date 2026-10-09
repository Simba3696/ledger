import { defineConfig } from 'vitest/config'

// The client's unit-test runner (`npm run test:client`). Node environment:
// these tests cover plain modules (the storage backends), not components,
// and stub `fetch` themselves. Separate from vite.config.ts so the app build
// is unaffected; the root `npm test` stays the server suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
