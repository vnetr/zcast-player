// src/renderer.ts
import { CanvasManager } from './canvas';

declare global {
  interface Window {
    zcast?: {
      readManifest: () => Promise<any>;
      onManifestUpdate: (cb: (data: any) => void) => () => void;
    };
  }
}

const root = document.getElementById('root')!;
const mgr = new CanvasManager(root);

// ---------- manifest application ----------
async function applyManifest(manifest: any) {
  mgr.applyManifest(manifest);
}

// ---------- boot ----------
async function boot() {
  if (import.meta.hot) {
    const { default: manifest } = await import('./mock/manifest.json');
    console.info('[zcast] DEV manifest loaded (HMR)');
    await applyManifest(manifest);
    import.meta.hot.accept('./mock/manifest.json', (mod) => {
      console.info('[zcast] DEV manifest updated (HMR)');
      applyManifest(mod?.default ?? manifest);
    });
  } else {
    const json = await window.zcast?.readManifest?.();
    console.info('[zcast] manifest loaded');
    await applyManifest(json);
    window.zcast?.onManifestUpdate?.((next) => {
      console.info('[zcast] manifest file changed → applying');
      applyManifest(next);
    });
  }
}

boot().catch((e) => {
  console.error('[zcast] Boot error:', e);
  root.innerHTML = '<div style="padding:20px;color:#f55">Boot error (see console)</div>';
});
