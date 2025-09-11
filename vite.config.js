import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : './',
  server: {
    watch: { usePolling: true, interval: 100 },
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    // ⬇️ DO NOT bundle the renderer lib in prod (dev is unaffected)
    rollupOptions: {
      external: ['@zignage/layout-renderer']
    }
  }
}));
