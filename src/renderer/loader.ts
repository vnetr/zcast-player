// src/renderer/loader.ts
import type { RendererKind, BaseRendererEl } from '../types/renderers';

const PATCH_DECORATOR = /e\("design:type",\s*[A-Za-z_$][\w$]*\)/g;
// Remove the noisy "[ERROR] No document found for layout renderer." call
const PATCH_LAYOUT_NO_DOC_LOG =
  /console\.error\(\s*"\[ERROR\]\s*No document found for layout renderer\."\s*\),?/g;

// Track whether a renderer kind has been loaded
const loaded: Record<RendererKind, boolean> = { layout: false, playlist: false };
// Also track the in-flight promise to prevent concurrent double-loads
const loading: Partial<Record<RendererKind, Promise<void>>> = {};

// Build a URL to /public/vendor/* that works in dev and packaged
function vendorUrl(file: string) {
  const href =
    (typeof window !== 'undefined' && window.location && window.location.href) || '';
  const isFile = href.startsWith('file:');

  // In packaged file://, vendor lives next to dist/index.html
  if (isFile) return new URL(`./vendor/${file}`, href).href;

  // In dev, honor Vite base (falls back to '/')
  const base =
    (typeof (window as any).__vite_base__ !== 'undefined' && (window as any).__vite_base__) ||
    (import.meta as any).env?.BASE_URL ||
    '/';
  const normBase = base.endsWith('/') ? base : `${base}/`;
  return `${normBase}vendor/${file}`;
}

// Temporarily wrap customElements.define to be idempotent during module load
function patchDefineIdempotent(): () => void {
  const orig = customElements.define.bind(customElements);
  (customElements as any).define = (
    name: string,
    ctor: CustomElementConstructor,
    options?: ElementDefinitionOptions
  ) => {
    // If already defined, silently ignore instead of throwing
    if (customElements.get(name)) return;
    return orig(name, ctor, options);
  };
  return () => {
    customElements.define = orig;
  };
}

/**
 * After the playlist bundle loads, monkey-patch <layout-item-renderer>
 * so it sets `layoutDocument` BEFORE first render. That prevents the child
 * <layout-renderer> from connecting without a `.document`.
 */
async function postImportPatch(kind: RendererKind) {
  if (kind !== 'playlist') return;

  try {
    await customElements.whenDefined('layout-item-renderer');
    const Ctor: any = customElements.get('layout-item-renderer');
    if (!Ctor) return;

    const proto: any = Ctor.prototype;
    if (proto.__zcastPatched) return;

    const origRender = proto.render;
    proto.render = function patchedRender(...args: any[]) {
      try {
        // If the upstream code hasn’t populated it yet, do it now.
        // For "layout-document" items this comes from .originalDocument.
        if (
          !this.layoutDocument &&
          this.document &&
          typeof this.document === 'object'
        ) {
          if (
            this.document.type === 'layout-document' &&
            this.document.originalDocument
          ) {
            this.layoutDocument = this.document.originalDocument;
          }
          // For "media-asset" the upstream subclass (asset-item-renderer)
          // builds a layout on its own; no manual action here.
        }
      } catch {}
      return origRender.apply(this, args);
    };

    // Mark as patched
    proto.__zcastPatched = true;
    console.info('[loader] Patched <layout-item-renderer> to hydrate layoutDocument early.');
  } catch (e) {
    console.warn('[loader] postImportPatch failed:', e);
  }
}

async function importVendor(kind: RendererKind) {
  if (import.meta.env.DEV) {
    // In dev, module system caches by specifier; still wrap define for safety.
    const unpatch = patchDefineIdempotent();
    try {
      if (kind === 'layout') {
        await import('@zignage/layout-renderer');
      } else {
        await import('@zignage/playlist-renderer');
      }
    } finally {
      unpatch();
    }
    // Apply runtime patch (if playlist)
    await postImportPatch(kind);
    return;
  }

  const file = kind === 'layout' ? 'layout-renderer.js' : 'playlist-renderer.js';
  const url = vendorUrl(file);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${file}: ${resp.status}`);

  let src = await resp.text();

  // 1) Relax TS decorator reflection shape (kept from your original patch)
  src = src.replace(PATCH_DECORATOR, 'e("design:type", Object)');

  // 2) Silence the specific "No document found" console.error inside layout bundle
  if (kind === 'layout') {
    src = src.replace(PATCH_LAYOUT_NO_DOC_LOG, '');
  }

  // Wrap define to avoid duplicate 'base-renderer' / friends re-definitions
  const unpatch = patchDefineIdempotent();
  try {
    const blob = new Blob([src], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await import(/* @vite-ignore */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } finally {
    unpatch();
  }

  // Apply runtime patch (if playlist)
  await postImportPatch(kind);
}

export async function loadRenderer(kind: RendererKind) {
  // If the tag is already registered, mark loaded and return
  const tag = kind === 'layout' ? 'layout-renderer' : 'playlist-renderer';
  if (customElements.get(tag)) {
    loaded[kind] = true;
    return;
  }
  if (loaded[kind]) return;

  // If a load is already in flight, await it
  if (loading[kind]) {
    await loading[kind]!;
    return;
  }

  // Otherwise, start a single load
  loading[kind] = (async () => {
    await importVendor(kind);
    loaded[kind] = true;
  })();

  await loading[kind]!;
}

export function createRendererEl(kind: RendererKind): BaseRendererEl {
  const tag = kind === 'layout' ? 'layout-renderer' : 'playlist-renderer';
  const el = document.createElement(tag) as any;

  // Common sizing/position
  (el.style as any).position = 'absolute';
  (el.style as any).inset = '0';

  // Reasonable defaults for both renderers
  el.zoomFactor = 1;
  el.frameRate = 30;

  // Layout-only defaults — harmless if playlist ignores them
  if (kind === 'layout') {
    el.editingMode = 'false';
    el.playbackMode = 'gpu';
  }

  return el as BaseRendererEl;
}
