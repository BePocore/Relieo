import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/prototype-api/project': {
        target: 'https://rando3-d.vercel.app',
        changeOrigin: true,
        rewrite: () => '/api/project',
      },
    },
  },
})
