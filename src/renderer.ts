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
let playerA!: BaseRendererEl;
let playerB!: BaseRendererEl;
let activePlayer!: BaseRendererEl;
let backPlayer!: BaseRendererEl;
let activeKind: RendererKind = 'layout';
let backKind: RendererKind = 'layout';

// Track last successfully shown doc (by kind+id) to avoid redundant swaps
let lastGood: { kind: RendererKind; id?: string | number } | null = null;

// ---------- DOM bootstrap (once) ----------
async function ensureStages() {
  if (stageA) return;

  // Always load layout renderer; playlist is loaded on demand
  await loadRenderer('layout');

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

  // Start with <layout-renderer> on both layers
  playerA = createRendererEl('layout');
  playerB = createRendererEl('layout');

  stageA.appendChild(playerA);
  stageB.appendChild(playerB);

  activeStage = stageA; backStage = stageB;
  activePlayer = playerA; backPlayer = playerB;
  activeKind = 'layout'; backKind = 'layout';
}

// ---------- helpers: readiness & events ----------
function waitLoaded(el: HTMLElement, kind: RendererKind, timeoutMs = 6000): Promise<void> {
  // Playlist renderer .d.ts does not define a "loaded" event; skip event wait.
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
  // Try a quick play to initialize scene; ignore failures here.
  try { await el.play(); } catch {}

  const rafSettled = new Promise<void>((resolve) => {
    let ticks = 0; const step = () => { if (++ticks >= 3) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  await Promise.race([
    rafSettled,
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('ready-timeout')), timeoutMs)),
  ]);
}

// Ensure the **back** layer hosts the correct renderer kind
async function ensureBackKind(kind: RendererKind) {
  if (backKind === kind) return;

  // Load the web component (once per process)
  await loadRenderer(kind);

  // Replace back element with correct tag
  try { backPlayer?.pause?.(); } catch {}
  try { backPlayer?.stop?.(); } catch {}
  if (backPlayer && backPlayer.parentElement) backPlayer.parentElement.removeChild(backPlayer);

  backPlayer = createRendererEl(kind);
  backStage.appendChild(backPlayer);
  backKind = kind;
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
  await ensureBackKind(kind);
  try { await backPlayer.stop(); } catch {}

  // Assign the document for the renderer (both accept .document)
  (backPlayer as any).document = doc;

  // For layout we listen for 'layoutLoaded'; for playlist we skip the event.
  await waitLoaded(backPlayer as unknown as HTMLElement, kind).catch(() => {});
  try { await backPlayer.play(); } catch {}

  // Heuristic settle for both kinds (advances a few RAFs).
  await waitReady(backPlayer).catch(() => {});
}

// ---------- atomic swap ----------
async function swapLayers() {
  activeStage.classList.remove('visible'); activeStage.classList.add('hidden');
  backStage.classList.remove('hidden');    backStage.classList.add('visible');

  // swap refs & kinds
  [activeStage, backStage] = [backStage, activeStage];
  [activePlayer, backPlayer] = [backPlayer, activePlayer];
  [activeKind, backKind] = [backKind, activeKind];

  // Ensure the now-visible player is playing
  try { await activePlayer.play(); } catch {}
  requestAnimationFrame(async () => { try { await activePlayer.play(); } catch {} });

  // Quiet the hidden one
  try { backPlayer.pause(); } catch {}
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
