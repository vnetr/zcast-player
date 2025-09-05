import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    watch: {
      usePolling: true,
      interval: 100, // ms
    },
    port: 5173,
    strictPort: true
  }
});
