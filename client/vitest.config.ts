import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The client's unit-test runner (`npm run test:client`). Node environment by
// default: most tests cover plain modules (the storage backends) and stub
// `fetch` themselves. Component tests (`*.test.tsx`) opt into jsdom with a
// `// @vitest-environment jsdom` first line and mock `../api`, so they never
// start the app. Separate from vite.config.ts so the app build is
// unaffected; the root `npm test` stays the server suite.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // syncUi.test.ts reads the sync UI's stylesheet as text (?raw), which
    // vitest otherwise empties.
    css: { include: [/sync\.css/] },
  },
})
