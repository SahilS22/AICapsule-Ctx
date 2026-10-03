import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the extension pages (popup + options). Content script and the
// background service worker are bundled separately by scripts/build.mjs
// (they must be single-file IIFE bundles).
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: 'popup.html',
        options: 'options.html'
      }
    }
  }
});
