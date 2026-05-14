import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  css: { devSourcemap: true },
  build: { sourcemap: true },
  server: {
    https: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4399',
        changeOrigin: true,
        secure: false,
      },
      '/mcp': {
        target: 'http://localhost:4399',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
