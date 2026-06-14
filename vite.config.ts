import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cesium()],
  server: {
    proxy: {
      // Lecture seule du vrai projet pour comparer les moteurs en local.
      '/prototype-api/project': {
        target: 'https://rando3-d.vercel.app',
        changeOrigin: true,
        rewrite: () => '/api/project',
      },
    },
  },
})
