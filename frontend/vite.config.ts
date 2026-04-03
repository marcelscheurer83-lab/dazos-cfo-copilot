import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8008',
        changeOrigin: true,
        timeout: 600_000,
        proxyTimeout: 600_000,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            const p = req.headers['x-app-password']
            if (p !== undefined) proxyReq.setHeader('X-App-Password', p)
          })
        },
      },
    },
  },
  // `npm run preview` serves a production build on :4173; without this, `/api/*` would 404 locally.
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8008',
        changeOrigin: true,
        timeout: 600_000,
        proxyTimeout: 600_000,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            const p = req.headers['x-app-password']
            if (p !== undefined) proxyReq.setHeader('X-App-Password', p)
          })
        },
      },
    },
  },
})
