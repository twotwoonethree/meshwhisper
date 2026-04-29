import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'node:crypto': path.resolve(__dirname, 'src/stubs/node-crypto.ts'),
      'node:dgram': path.resolve(__dirname, 'src/stubs/empty.ts'),
      'node:net': path.resolve(__dirname, 'src/stubs/empty.ts'),
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Prudence',
        short_name: 'Prudence',
        description: 'End-to-end encrypted messaging',
        theme_color: '#9333ea',
        background_color: '#020617',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
});
