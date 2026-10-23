import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { plaidApiPlugin } from './server/plaidApi.js'

export default defineConfig(({ mode }) => {
  // PLAID_* come from .env.local (gitignored). Without the VITE_ prefix they stay on the server.
  const env = loadEnv(mode, process.cwd(), 'PLAID_')

  return {
    plugins: [react(), mode !== 'test' && plaidApiPlugin(env)],
    test: {
      // Any zone well west of UTC, so tests catch dates computed in UTC instead of local time
      // Etc/GMT+10 is UTC−10 (POSIX inverts the sign); no city, just an offset
      env: { TZ: 'Etc/GMT+10' },
    },
  }
})
