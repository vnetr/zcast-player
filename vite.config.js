// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  return {
    base: isDev ? '/' : './',
    server: {
      watch: { usePolling: true, interval: 100 },
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: true,
      target: 'chrome120',
      minify: false,
      rollupOptions: {
        treeshake: false,
        output: {
          inlineDynamicImports: true,
          manualChunks: undefined,
          compact: false,
          hoistTransitiveImports: false,
        },
        external: [], // <- DO NOT externalize deps
      },
    },
    // Dev stays the same; this line is harmless and speeds dev
    optimizeDeps: { include: ['@zignage/layout-renderer'] },
  };
});
