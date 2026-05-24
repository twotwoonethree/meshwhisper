import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Dev: the dashboard's small Node API server runs on port 5175.
      // The Vite dev server proxies /api/* to it so the client just calls
      // fetch('/api/audit') in both dev and production builds.
      '/api': 'http://localhost:5175',
    },
  },
});
