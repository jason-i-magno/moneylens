import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Any zone well west of UTC, so tests catch dates computed in UTC instead of local time
    // Etc/GMT+10 is UTC−10 (POSIX inverts the sign); no city, just an offset
    env: { TZ: 'Etc/GMT+10' },
  },
})
