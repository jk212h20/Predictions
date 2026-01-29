import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Enable build caching for faster rebuilds
    sourcemap: false,
    // Optimize chunk splitting
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate vendor chunks for better caching
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
    // Target modern browsers for smaller bundle
    target: 'es2020',
    // Minimize with esbuild (faster than terser)
    minify: 'esbuild',
  },
})
