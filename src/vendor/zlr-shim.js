/**
 * Bundling shim: force Vite/Rollup to inline @zignage/layout-renderer
 * into the renderer bundle so production never executes the copy in
 * app.asar/node_modules (which causes the TDZ on Linux).
 *
 * If your package has a different ESM entry, change the path below.
 * We point at the file by path so Rollup must bundle it.
 */
import '../../node_modules/@zignage/layout-renderer/index.js';
export {};
