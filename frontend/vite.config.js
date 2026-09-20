import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev the app calls /api/*, which Vite forwards to the Express server. The browser therefore
// sees one origin, so the httpOnly auth cookie works without any CORS setup.
// In production set VITE_API_URL to the deployed API instead (see src/api.js).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
