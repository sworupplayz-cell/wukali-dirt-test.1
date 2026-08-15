import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  // The live preview runs `vite preview` on the production build: unlike the
  // dev server it never force-reloads connected players when files change.
  preview: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  build: {
    target: 'es2019',
    // Single-bundle game; three.js alone is ~450 kB minified. No code-split
    // benefit for a game that needs everything at startup.
    chunkSizeWarningLimit: 600,
  },
});
