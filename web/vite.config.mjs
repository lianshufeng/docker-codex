import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000', '/events': { target: 'ws://localhost:3000', ws: true } } },
});
