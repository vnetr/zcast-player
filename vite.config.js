import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Use relative paths for production so file:// loads work inside Electron
  base: command === 'serve' ? '/' : './',
  server: {
    watch: { usePolling: true, interval: 100 },
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true
  }
}));
