import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Loaded manually (not just import.meta.env) so a plain VITE_API_PROXY_TARGET
  // in client/.env can retarget the dev-server proxy too, not just VITE_*
  // values consumed by application code — lets a separate checkout/worktree
  // run entirely on its own ports without touching another checkout's server.
  const env = loadEnv(mode, process.cwd(), '')
  const port = Number(env.VITE_DEV_PORT) || 5173
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:4000'

  return {
    plugins: [react()],
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': apiTarget,
      },
    },
  }
})
