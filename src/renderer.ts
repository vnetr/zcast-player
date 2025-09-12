// src/renderer/index.ts

import { ScheduleEngine } from './schedule';

// NOTE: Do NOT import '@zignage/layout-renderer' statically in prod —
// we patch it at runtime to neutralize TDZ "design:type" metadata.

async function loadRendererModule() {
  if (import.meta.env.DEV) {
    // Dev: straight from node_modules
    await import('@zignage/layout-renderer');
    return;
  }

  // Prod: read vendor file from the built app and patch TDZ metadata
  const url = new URL('../vendor/layout-renderer.js', import.meta.url).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch layout-renderer: ${resp.status}`);
  const src = await resp.text();

  // Replace decorator metadata like e("design:type", <Ident>) with Object
  const patched = src.replace(/e\("design:type",\s*[A-Za-z_$][\w$]*\)/g, 'e("design:type", Object)');

  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

type LayoutRendererEl = HTMLElement & {
  document: any;
  editingMode: 'false' | 'true' | 'template';
  playbackMode: 'gpu' | 'cpu' | 'step';
  frameRate: number;
  zoomFactor: number;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
};

declare global {
  interface Window {
    zcast?: {
      readManifest: () => Promise<any>;
      onManifestUpdate: (cb: (data: any) => void) => () => void;
    };
  }
}

const root = document.getElementById('root')!;
let playerEl: LayoutRendererEl | null = null;
let engine: ScheduleEngine | null = null;
let loopTimer: any = null;

function stopLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

async function ensureRenderer(): Promise<LayoutRendererEl> {
  if (playerEl) return playerEl;

  await loadRendererModule(); // ensure custom element is defined
  root.innerHTML = '';

  const el = document.createElement('layout-renderer') as LayoutRendererEl;
  el.editingMode = 'false';
  el.playbackMode = 'gpu';
  el.frameRate = 30;
  el.zoomFactor = 1;

  root.appendChild(el);
  playerEl = el;
  return el;
}

async function renderLayout(layout: any) {
  const el = await ensureRenderer();

  // swap the document; layout-renderer re-initializes the scene
  el.document = layout;

  // try to run
  try {
    await el.play();
  } catch (e) {
    console.warn('[renderer] play() failed, retrying once after stop()', e);
    try { await el.stop(); } catch {}
    el.document = layout;
    try { await el.play(); } catch (e2) { console.error('[renderer] play() failed again:', e2); }
  }
}

function showBlack() {
  root.innerHTML = '<div style="width:100%;height:100%;background:#000"></div>';
  playerEl = null;
}

function startLoop() {
  stopLoop();
  const tick = async () => {
    if (!engine) {
      loopTimer = setTimeout(tick, 1000);
      return;
    }

    // Ask the engine which item to play next and for how long
    const { item, tickMs } = engine.next(new Date());

    if (!item) {
      console.info('[engine] idle — no active items; sleeping ms=', tickMs);
      showBlack();
      loopTimer = setTimeout(tick, Math.max(500, tickMs));
      return;
    }

    await renderLayout(item.layout);
    loopTimer = setTimeout(tick, Math.max(500, tickMs));
  };

  // Kick off the rotation loop
  tick();
}

async function applyManifest(manifest: any) {
  if (!engine) engine = new ScheduleEngine();
  engine.updateManifest(manifest);
  startLoop();
}

async function boot() {
  if (import.meta.hot) {
    // Dev: load local mock and hot-reload it
    const { default: manifest } = await import('./mock/manifest.json');
    console.info('[zcast] DEV manifest loaded (HMR):', Array.isArray(manifest) ? `array(len=${manifest.length})` : typeof manifest);
    await applyManifest(manifest);

    import.meta.hot.accept('./mock/manifest.json', (mod) => {
      const next = mod?.default ?? manifest;
      console.info('[zcast] DEV manifest updated (HMR)');
      applyManifest(next);
    });
  } else {
    // Prod: read file via preload bridge
    const json = await window.zcast?.readManifest?.();
    console.info('[zcast] manifest loaded:',
      Array.isArray(json) ? `array(len=${json.length})` : typeof json
    );
    await applyManifest(json);

    // Push updates when the file changes
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
