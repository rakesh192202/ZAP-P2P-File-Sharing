import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    https: false,        // ← NO HTTPS
    host: '0.0.0.0',     // ← Listen on all network interfaces
    port: 5173,
    strictPort: false,
    cors: true
  }
})