export type BaseRendererEl = HTMLElement & {
  document: any;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
};

export type LayoutRendererEl = BaseRendererEl & {
  editingMode: 'false' | 'true' | 'template';
  playbackMode: 'gpu' | 'cpu' | 'step';
  frameRate: number;
  zoomFactor: number;
};

export type PlaylistRendererEl = BaseRendererEl & {
  // from the .d.ts you shared
  zoomFactor: number;
  frameRate: number;
  currentTimestamp: number;
  // document is more specific at runtime, but keep it "any" to avoid importing types here
};

export type RendererKind = 'layout' | 'playlist';
