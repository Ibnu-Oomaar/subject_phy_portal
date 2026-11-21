/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// The API (and its Socket.IO endpoint at /api/socket.io) is proxied, so the browser only ever talks to one origin.
// That keeps the session cookie first-party and means no CORS configuration is needed.
const API = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  envDir: '..',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API, changeOrigin: false, ws: true } },
  },
  preview: { port: 4173, proxy: { '/api': { target: API, ws: true } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
