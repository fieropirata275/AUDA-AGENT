import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const target = `http://localhost:${process.env.AUDA_PORT ?? 4610}`;
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target, '/hooks': target, '/demo': target,
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
