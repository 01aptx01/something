import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Three's WebGL renderer is about 509 kB minified (129 kB gzip) at this version.
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
