import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { plaidApiPlugin } from './server/plaidApi.js'
import { dataApiPlugin } from './server/dataApi.js'
import { receiptsApiPlugin } from './server/receiptsApi.js'
import { parseHostList } from './server/http.js'

export default defineConfig(({ mode }) => {
  // PLAID_*, MONEYLENS_* and ANTHROPIC_* come from .env.local (gitignored). Without the VITE_ prefix they stay on the server.
  const env = loadEnv(mode, process.cwd(), ['PLAID_', 'MONEYLENS_', 'ANTHROPIC_'])
  // Names besides localhost the app is reached by, e.g. through `tailscale serve` (see .env.example)
  const extraHosts = parseHostList(env.MONEYLENS_ALLOWED_HOSTS)
  const allowedHosts = extraHosts.length ? extraHosts : undefined

  return {
    plugins: [react(), ...(mode === 'test' ? [] : [plaidApiPlugin(env), dataApiPlugin(env), receiptsApiPlugin(env)])],
    server: { allowedHosts },
    preview: { allowedHosts },
    test: {
      // Any zone well west of UTC, so tests catch dates computed in UTC instead of local time
      // Etc/GMT+10 is UTC−10 (POSIX inverts the sign); no city, just an offset
      env: { TZ: 'Etc/GMT+10' },
    },
  }
})
