import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'], manifest: true,
    rollupOptions: { output: { manualChunks(id) {
      if (/\/src\/nodes\/(?:config-schema|concrete-app-module|core\/modules|context\/modules|image\/modules)\.(?:ts|tsx)$/.test(id)) return 'node-runtime';
    } } },
  },
});
