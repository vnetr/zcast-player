// src/renderer/loader.ts
import type { RendererKind, BaseRendererEl } from '../types/renderers';

const PATCH_DECORATOR = /e\("design:type",\s*[A-Za-z_$][\w$]*\)/g;

/**
 * Build a URL to /public/vendor/* that works in both:
 *  - dev server (http://localhost:5173/)
 *  - packaged electron (file:///.../dist/index.html)
 *
 * Files in /public are copied to the dist root. So the vendor files
 * live beside index.html under dist/vendor/*. We resolve relative to
 * window.location in packaged builds.
 */
function vendorUrl(file: string) {
  const href = (typeof window !== 'undefined' && window.location && window.location.href) || '';
  const isFile = href.startsWith('file:');

  // When running from file://, resolve "./vendor/*" next to index.html
  if (isFile) {
    return new URL(`./vendor/${file}`, href).href;
  }

  // When running from the dev server or any http/https, BASE_URL is safe
  const base =
    // Vite exposes this at runtime in dev
    (typeof (window as any).__vite_base__ !== 'undefined' && (window as any).__vite_base__) ||
    // And at build-time for prod (falls back to '/')
    (import.meta as any).env?.BASE_URL ||
    '/';

  // Ensure base ends with a slash
  const normBase = base.endsWith('/') ? base : `${base}/`;
  return `${normBase}vendor/${file}`;
}

export async function loadRenderer(kind: RendererKind) {
  if (import.meta.env.DEV) {
    if (kind === 'layout') {
      await import('@zignage/layout-renderer');
    } else {
      await import('@zignage/playlist-renderer');
    }
    return;
  }

  const file = kind === 'layout' ? 'layout-renderer.js' : 'playlist-renderer.js';
  const url = vendorUrl(file);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${file}: ${resp.status}`);

  const src = await resp.text();
  const patched = src.replace(PATCH_DECORATOR, 'e("design:type", Object)');

  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function createRendererEl(kind: RendererKind): BaseRendererEl {
  const tag = kind === 'layout' ? 'layout-renderer' : 'playlist-renderer';
  const el = document.createElement(tag) as any;

  (el.style as any).position = 'absolute';
  (el.style as any).inset = '0';

  // Reasonable defaults for both renderers
  el.zoomFactor = 1;
  el.frameRate  = 30;

  if (kind === 'layout') {
    el.editingMode  = 'false';
    el.playbackMode = 'gpu';
  }

  return el as BaseRendererEl;
}
