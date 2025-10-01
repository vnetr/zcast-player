// src/renderer.ts
import { ScheduleEngine } from './schedule';
import type { RendererKind, BaseRendererEl } from './types/renderers';
import { loadRenderer, createRendererEl } from './renderer/loader';

declare global {
  interface Window {
    zcast?: {
      readManifest: () => Promise<any>;
      onManifestUpdate: (cb: (data: any) => void) => () => void;
    };
  }
}

const root = document.getElementById('root')!;
let engine: ScheduleEngine | null = null;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let manifestVersion = 0;

// ---------- double buffer containers / players ----------
let stageA!: HTMLDivElement;
let stageB!: HTMLDivElement;
let activeStage!: HTMLDivElement;
let backStage!: HTMLDivElement;

let playerA: BaseRendererEl | null = null;
let playerB: BaseRendererEl | null = null;
let activePlayer: BaseRendererEl | null = null;
let backPlayer: BaseRendererEl | null = null;
let activeKind: RendererKind | null = null;
let backKind: RendererKind | null = null;

// Track last successfully shown doc (by kind+id) to avoid redundant swaps
let lastGood: { kind: RendererKind; id?: string | number } | null = null;

// ---------- DOM bootstrap (once) ----------
async function ensureStages() {
  if (stageA) return;

  // Create the layers; players are created lazily when we know the kind+document
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.innerHTML = `
    <div id="layerA" class="layer visible"></div>
    <div id="layerB" class="layer hidden"></div>
  `;
  root.innerHTML = '';
  root.appendChild(stage);

  stageA = stage.querySelector('#layerA') as HTMLDivElement;
  stageB = stage.querySelector('#layerB') as HTMLDivElement;

  activeStage = stageA;
  backStage   = stageB;

  // Preload and register the layout renderer early.
  // Playlist internally instantiates <layout-renderer>, so it MUST be defined first.
  await loadRenderer('layout');
  await customElements.whenDefined('layout-renderer');
}

// ---------- helpers: readiness & events ----------
function waitLoaded(el: HTMLElement, kind: RendererKind, timeoutMs = 6000): Promise<void> {
  // Playlist renderer does not expose a "loaded" event; skip.
  if (kind === 'playlist') return Promise.resolve();

  const eventName = 'layoutLoaded';
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const onLoaded = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const t = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error(`${eventName} timeout`)); } }, timeoutMs);
    const cleanup = () => { clearTimeout(t); el.removeEventListener(eventName as any, onLoaded as any); };
    el.addEventListener(eventName as any, onLoaded as any, { once: true });
  });
}

async function waitReady(el: BaseRendererEl, timeoutMs = 6000) {
  try { await el.play(); } catch {}

  const rafSettled = new Promise<void>((resolve) => {
    let ticks = 0;
    const step = () => { if (++ticks >= 3) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  await Promise.race([
    rafSettled,
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('ready-timeout')), timeoutMs)),
  ]);
}

// ---------- ensure the back layer has the right element, with doc set BEFORE append ----------
async function ensureBackRenderer(kind: RendererKind, doc: any) {
  // If playlist is requested, guarantee <layout-renderer> is already defined,
  // because playlist will create and control it internally.
  if (kind === 'playlist') {
    await loadRenderer('layout');
    await customElements.whenDefined('layout-renderer');
    await loadRenderer('playlist');
    await customElements.whenDefined('playlist-renderer');
  } else {
    await loadRenderer('layout');
    await customElements.whenDefined('layout-renderer');
  }

  // If the back element is missing or a different kind, replace it.
  if (!backPlayer || backKind !== kind) {
    // Remove old back element if present
    if (backPlayer?.parentElement) {
      try { backPlayer.pause?.(); } catch {}
      try { backPlayer.stop?.(); } catch {}
      backPlayer.parentElement.removeChild(backPlayer);
    }

    // Create, assign .document FIRST, then append → avoids null-first-render in Lit
    const el = createRendererEl(kind);
    (el as any).document = doc;
    backStage.appendChild(el);

    backPlayer = el;
    backKind = kind;

    if (!playerA)      playerA = el;
    else if (!playerB) playerB = el;

    return;
  }

  // Same kind already mounted on back stage → just update the doc before it updates
  (backPlayer as any).document = doc;
}

// ---------- resolve next scheduled doc ----------
function resolveNextFromEngineItem(item: any): { kind: RendererKind; doc: any; id?: string | number } {
  // Common shapes coming from schedule engine or raw manifest:
  // - item.layout (could be a layout or a playlist doc)
  // - item.media (schedule.data.media)
  // - item.document (defensive)
  const raw = item?.layout ?? item?.media ?? item?.document ?? item;

  // Identify playlist vs layout by explicit type or presence of items[]
  const looksPlaylist = !!raw && (raw.type === 'playlist' || Array.isArray(raw.items));
  const kind: RendererKind = looksPlaylist ? 'playlist' : 'layout';

  // Use raw as the doc directly (both renderers accept `.document`)
  const doc = raw;

  // Prefer explicit id; fall back to name if present
  const id = doc?.id ?? doc?.name;
  return { kind, doc, id };
}

// ---------- render off-screen (generic for both kinds) ----------
async function prepareOffscreen(kind: RendererKind, doc: any) {
  await ensureStages();
  await ensureBackRenderer(kind, doc);

  try { await backPlayer?.stop?.(); } catch {}

  await waitLoaded(backPlayer as unknown as HTMLElement, kind).catch(() => {});
  try { await backPlayer?.play?.(); } catch {}

  await waitReady(backPlayer!).catch(() => {});
}

// ---------- atomic swap ----------
async function swapLayers() {
  activeStage.classList.remove('visible'); activeStage.classList.add('hidden');
  backStage.classList.remove('hidden');    backStage.classList.add('visible');

  // swap refs & kinds
  [activeStage, backStage]   = [backStage, activeStage];
  [activePlayer, backPlayer] = [backPlayer, activePlayer];
  [activeKind, backKind]     = [backKind as RendererKind, activeKind as RendererKind];

  // Ensure the now-visible player is actually playing
  try { await activePlayer?.play?.(); } catch {}
  requestAnimationFrame(async () => { try { await activePlayer?.play?.(); } catch {} });

  // Quiet the hidden one
  try { backPlayer?.pause?.(); } catch {}
}

// ---------- loop control ----------
function stopLoop() {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
}
function scheduleNext(ms: number) {
  stopLoop();
  loopTimer = setTimeout(() => tick(manifestVersion), ms);
}

async function tick(versionAtStart: number) {
  if (!engine) { scheduleNext(500); return; }

  const { item, tickMs } = engine.next(new Date());
  if (versionAtStart !== manifestVersion) return;

  if (!item) {
    scheduleNext(Math.min(1000, Math.max(250, tickMs)));
    return;
  }

  const next = resolveNextFromEngineItem(item);
  const same =
    lastGood &&
    lastGood.kind === next.kind &&
    lastGood.id &&
    next.id &&
    lastGood.id === next.id;

  if (same) {
    scheduleNext(Math.max(500, tickMs));
    return;
  }

  try {
    await prepareOffscreen(next.kind, next.doc);
    if (versionAtStart !== manifestVersion) return;
    await swapLayers();
    lastGood = { kind: next.kind, id: next.id };
  } catch (e) {
    console.error('[renderer] prepare/swap failed; keeping current item', e);
  }

  scheduleNext(Math.max(500, tickMs));
}

// ---------- manifest application ----------
async function applyManifest(manifest: any) {
  await ensureStages();
  if (!engine) engine = new ScheduleEngine();
  engine.updateManifest(manifest);
  manifestVersion++;
  stopLoop();
  tick(manifestVersion);
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
