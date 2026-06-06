import { defineConfig } from 'vite';
import path from 'node:path';

// Aliases mirror the Prudence reference: stub out Node-only modules the
// SDK occasionally touches (node:crypto/dgram/net) so the browser bundle
// doesn't try to polyfill them.
export default defineConfig({
  resolve: {
    alias: {
      'node:crypto': path.resolve(__dirname, 'src/stubs/node-crypto.ts'),
      'node:dgram': path.resolve(__dirname, 'src/stubs/empty.ts'),
      'node:net': path.resolve(__dirname, 'src/stubs/empty.ts'),
    },
  },
  optimizeDeps: { include: ['buffer'] },
  server: { port: 5180, host: true },
});
