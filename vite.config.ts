import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Renderer plus local PMREM studio reflections: ~553 kB minified. Models and GLTFLoader load separately.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {main:'index.html',sculptStudio:'sculpt-lab.html'},
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
