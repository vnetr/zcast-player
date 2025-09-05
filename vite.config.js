// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : './',
  server: {
    watch: { usePolling: true, interval: 100 },
    port: 5173,
    strictPort: true,
  },
  // Don’t let esbuild prebundle the renderer lib (it’s where the TDZ usually comes from)
  optimizeDeps: {
    exclude: ['@zignage/layout-renderer'],
  },
  build: {
    // Make the prod bundle readable and preserve eval order (fixes “Cannot access 'Vi'…”)
    minify: false,           // <-- immediate fix
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      treeshake: false,      // be conservative: don’t drop/reorder side effects
      output: { compact: false },
    },
  },
}));
