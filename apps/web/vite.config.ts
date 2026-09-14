import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER_PORT = Number(process.env['HARNESS_TRAJECTORY_PORT'] ?? 5170)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/shiki') || id.includes('/node_modules/@shikijs/')) return 'shiki'
          if (id.includes('/node_modules/katex')) return 'katex'
          if (id.includes('/node_modules/react')) return 'react'
          return undefined
        },
      },
    },
  },
})
