import type { RendererKind, BaseRendererEl } from '../types/renderers';

const PATCH_DECORATOR = /e\("design:type",\s*[A-Za-z_$][\w$]*\)/g;

function vendorUrl(file: string) {
  return new URL(`../../vendor/${file}`, import.meta.url).href;
}

export async function loadRenderer(kind: RendererKind) {
  if (import.meta.env.DEV) {
    if (kind === 'layout') await import('@zignage/layout-renderer');
    else await import('@zignage/playlist-renderer');
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
  try { await import(/* @vite-ignore */ blobUrl); }
  finally { URL.revokeObjectURL(blobUrl); }
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
