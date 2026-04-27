import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: { devSourcemap: true },
  build: { sourcemap: true },
  server: {
    proxy: {
      '/api': 'http://localhost:4399',
      '/mcp': 'http://localhost:4399',
    },
  },
})
