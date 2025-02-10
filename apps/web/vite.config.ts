import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
  // @hashbridge/core lives outside apps/web, so the `vite-plugin-node-polyfills/shims/*` imports the plugin
  // injects into its files do not resolve under pnpm's strict node_modules; point them at this app's copy.
  resolve: { alias: { 'vite-plugin-node-polyfills/shims': fileURLToPath(new URL('./node_modules/vite-plugin-node-polyfills/shims', import.meta.url)) } },
  server: { port: 5173 },
});
