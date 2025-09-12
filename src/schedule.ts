// src/schedule.ts
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const DEFAULT_TZ = 'America/New_York';
const DEFAULT_SLOT_MS = 15_000;   // if layout has no timeline
const MIN_SLOT_MS = 2_000;        // never switch faster than this
const MAX_SLOT_MS = 5 * 60_000;   // protect against crazy timelines
// ----------------------------

const ALL_DAYS = ['mo','tu','we','th','fr','sa','su'] as const;
type ByDayCode = typeof ALL_DAYS[number];

function isByDayCode(x: string): x is ByDayCode {
  return (ALL_DAYS as readonly string[]).includes(x);
}
function toByDayCode(x: unknown): ByDayCode | null {
  const s = String(x ?? '').toLowerCase();
  return isByDayCode(s) ? s : null;
}

// Luxon weekday: 1..7 == Mon..Sun
const DOW: ByDayCode[] = ['mo','tu','we','th','fr','sa','su'];
function dayCodeFromLuxon(weekday: number): ByDayCode {
  const i = ((weekday - 1) % 7 + 7) % 7;
  return DOW[i];
}

type NewItem = {
  inceptAt?: string;
  expireAt?: string;
  fromTime?: string;
  toTime?: string;
  days?: Array<{ day?: unknown; nthOfPeriod?: number }>;
  workingDays?: boolean;
  weekend?: boolean;
  priority?: number;
  media?: any;          // layout (must have type === 'layout')
  timeZone?: string;
  name?: string;
  // pass-through fields ignored by the engine
};

// ---------- Normalization (accept flat or {data:…}; array or single) ----------
function looksFlat(x: any): x is NewItem {
  return x && typeof x === 'object' && 'media' in x && x.media && typeof x.media === 'object';
}
function looksNested(x: any): x is { data: NewItem } {
  return x && typeof x === 'object' && x.data && typeof x.data === 'object' && 'media' in x.data;
}
function unwrapListWrappers(x: any): any {
  if (x && typeof x === 'object') {
    if (Array.isArray((x as any).results)) return (x as any).results;
    if (Array.isArray((x as any).data))    return (x as any).data;
    if (Array.isArray((x as any).items))   return (x as any).items;
  }
  return x;
}
export function normalize(manifest: any): NewItem[] {
  const raw = unwrapListWrappers(manifest);
  const out: NewItem[] = [];

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (looksFlat(it)) out.push(it);
      else if (looksNested(it)) out.push(it.data);
      else if (it && typeof it === 'object' && looksFlat((it as any).data)) out.push((it as any).data);
    }
  } else if (raw && typeof raw === 'object') {
    if (looksFlat(raw)) out.push(raw);
    else if (looksNested(raw)) out.push(raw.data);
  }

  console.groupCollapsed('[schedule] normalize');
  console.info('input:', Array.isArray(manifest) ? `array(len=${manifest.length})` : typeof manifest);
  console.info('normalized items:', out.length);
  if (out.length > 0) {
    console.debug('sample:', safePreview(out[0]));
  }
  console.groupEnd();
  return out;
}
function safePreview(x: unknown) { try { return JSON.parse(JSON.stringify(x)); } catch { return x; } }

// ---------- Helpers (windows & day filters) ----------
function todaysWindow(now: DateTime, fromTime?: string, toTime?: string) {
  const [fs='00',fm='00',fS='00', fms='000'] = (fromTime ?? '00:00:00.000').split(/[:.]/);
  const [ts='23',tm='59',tS='59', tms='999'] = (toTime ?? '23:59:59.999').split(/[:.]/);
  const start = now.set({ hour:+fs, minute:+fm, second:+fS, millisecond:+fms });
  const end   = now.set({ hour:+ts, minute:+tm, second:+tS, millisecond:+tms });
  return { start, end };
}
function allowedToday(
  today: ByDayCode,
  itemDays?: Array<{ day?: unknown; nthOfPeriod?: number }>,
  workingDays?: boolean,
  weekend?: boolean
): boolean {
  if (Array.isArray(itemDays) && itemDays.length > 0) {
    const set = new Set<ByDayCode>(
      itemDays.map(d => toByDayCode(d?.day)).filter((v): v is ByDayCode => v !== null)
    );
    return set.has(today);
  }
  if (workingDays && weekend) return true; // both => all week
  if (workingDays) return ['mo','tu','we','th','fr'].includes(today);
  if (weekend)     return ['sa','su'].includes(today);
  return true;
}

// ---------- Duration extraction from layout ----------
function layoutTimelineMs(layout: any): number {
  if (!layout || typeof layout !== 'object') return DEFAULT_SLOT_MS;
  let maxEnd = 0;

  const take = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const o = node.options || {};
    const e = Number(o.end ?? 0);
    if (!Number.isNaN(e) && e > maxEnd) maxEnd = e;
    const kids = node.children;
    if (Array.isArray(kids)) kids.forEach(take);
  };

  // consider root's options.duration or .end first
  const rootDur = Number(layout?.options?.duration ?? 0);
  const rootEnd = Number(layout?.options?.end ?? 0);
  maxEnd = Math.max(maxEnd, isFinite(rootDur) ? rootDur : 0, isFinite(rootEnd) ? rootEnd : 0);
  take(layout);

  const ms = Math.min(Math.max(maxEnd || DEFAULT_SLOT_MS, MIN_SLOT_MS), MAX_SLOT_MS);
  return ms;
}

// ---------- Public shape ----------
export type ActivePick =
  | { kind: 'none'; nextCheck: number }
  | { kind: 'layout'; layout: any; nextCheck: number; reason: string };

// Keep the simple API if you only want "the best item right now"
export function pickActiveContent(manifest: any, nowJS: Date = new Date()): ActivePick {
  const engine = new ScheduleEngine();
  engine.updateManifest(manifest);
  const snap = engine.snapshot(nowJS);
  if (snap.playlist.length === 0) {
    return { kind: 'none', nextCheck: snap.nextBoundaryMs };
  }
  // "best" is the first in the round-robin order (deterministic, but not rotating here)
  return { kind: 'layout', layout: snap.playlist[0].layout, nextCheck: snap.nextBoundaryMs, reason: 'engine-best' };
}

// ---------- Full engine (round-robin rotation) ----------
type EvalItem = {
  idx: number;
  name: string;
  priority: number;
  tz: string;
  layout: any;
  active: boolean;
  slotMs: number;
  nextChangeMs: number;   // when this item's active state might change
};

type Snapshot = {
  nowMs: number;
  nextBoundaryMs: number;     // when we must re-evaluate globally
  topPriority: number | null;
  playlist: EvalItem[];       // only active items at top priority, rotation order
  key: string;                // signature of the current playlist
};

export class ScheduleEngine {
  private manifest: any = null;
  private items: NewItem[] = [];
  private lastKey: string | null = null;
  private rrIndex: number = 0;

  updateManifest(manifest: any) {
    this.manifest = manifest;
    this.items = normalize(manifest);
    // reset rotation whenever manifest changes
    this.lastKey = null;
    this.rrIndex = 0;
  }

  snapshot(nowJS: Date = new Date()): Snapshot {
    const nowMs = +nowJS;
    if (!Array.isArray(this.items) || this.items.length === 0) {
      return { nowMs, nextBoundaryMs: nowMs + 60_000, topPriority: null, playlist: [], key: 'empty' };
    }

    // Evaluate every item
    const evals: EvalItem[] = this.items.map((d, idx) => {
      const tz = d.timeZone || DEFAULT_TZ;
      const now = DateTime.fromJSDate(nowJS).setZone(tz);

      const incept = d.inceptAt ? DateTime.fromISO(d.inceptAt, { zone: tz }) : null;
      const expire = d.expireAt ? DateTime.fromISO(d.expireAt, { zone: tz }) : null;
      const { start: dayStart, end: dayEnd } = todaysWindow(now, d.fromTime, d.toTime);

      const withinDates =
        (!incept || (incept.isValid && now >= incept)) &&
        (!expire || (expire.isValid && now <= expire));

      const todayCode = dayCodeFromLuxon(now.weekday);
      const allowedDay = allowedToday(todayCode, d.days, d.workingDays, d.weekend);
      const withinDayWindow = now >= dayStart && now <= dayEnd;

      const active = !!(d.media && d.media.type === 'layout') && withinDates && allowedDay && withinDayWindow;

      // compute next change moment for this item
      let next: DateTime | null = null;
      if (incept && incept.isValid && now < incept)       next = incept;
      else if (now < dayStart)                            next = dayStart;
      else if (active)                                    next = dayEnd.plus({ millisecond: 1 });
      else {
        // simple "tomorrow at start" fallback
        const tomorrow = now.plus({ days: 1 });
        next = todaysWindow(tomorrow, d.fromTime, d.toTime).start;
      }
      if (expire && expire.isValid && next > expire)      next = expire.plus({ millisecond: 1 });

      const layout = d.media;
      const slotMs = layoutTimelineMs(layout);
      return {
        idx,
        name: (d.name || layout?.name || '') as string,
        priority: Number(d.priority ?? 0),
        tz, layout,
        active,
        slotMs,
        nextChangeMs: next?.toMillis() ?? (nowMs + 60_000),
      };
    });

    // Global next boundary: earliest nextChange across everything
    const nextBoundaryMs = Math.min(...evals.map(e => e.nextChangeMs));

    // Choose top priority among currently active
    const activeNow = evals.filter(e => e.active);
    if (activeNow.length === 0) {
      // Return nothing, but still tell caller when to re-check
      const warn = [...evals].sort((a,b) => (b.priority - a.priority) || (a.nextChangeMs - b.nextChangeMs))[0];
      if (warn) {
        console.warn('[schedule] no active items; nextBoundary', new Date(nextBoundaryMs).toISOString(), 'top candidate:', {
          idx: warn.idx, priority: warn.priority, nextChangeISO: new Date(warn.nextChangeMs).toISOString()
        });
      }
      return { nowMs, nextBoundaryMs, topPriority: null, playlist: [], key: 'none' };
    }

    const topPriority = Math.max(...activeNow.map(e => e.priority));
    const topGroup = activeNow.filter(e => e.priority === topPriority);

    // Build a stable key for rotation continuity (priority + ids)
    // Try media.id first; fallback to index
    const ids = topGroup.map(e => (e.layout?.id ?? `idx:${e.idx}`));
    const key = JSON.stringify({ p: topPriority, ids });

    // Stable deterministic order, then apply round-robin offset later
    topGroup.sort((a, b) => {
      const an = (a.name || '').toLowerCase();
      const bn = (b.name || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return a.idx - b.idx;
    });

    return { nowMs, nextBoundaryMs, topPriority, playlist: topGroup, key };
  }

  // Select the next item in round-robin and return (item, tickMs)
  next(manifestNow?: Date): { item: EvalItem | null, tickMs: number, snap: Snapshot } {
    const snap = this.snapshot(manifestNow ?? new Date());
    if (snap.playlist.length === 0) {
      return { item: null, tickMs: Math.max(250, snap.nextBoundaryMs - snap.nowMs), snap };
    }

    // reset rotation index if the group changed
    if (this.lastKey !== snap.key) {
      this.lastKey = snap.key;
      this.rrIndex = 0;
      console.info('[engine] new playlist:', snap.key);
    }

    const n = snap.playlist.length;
    const pick = snap.playlist[this.rrIndex % n];

    // Bound the slot by the global boundary (preempt if something changes/arrives)
    const slot = pick.slotMs;
    const untilBoundary = Math.max(250, snap.nextBoundaryMs - snap.nowMs);
    const tickMs = Math.max(250, Math.min(slot, untilBoundary));

    // advance the rr index for the next call
    this.rrIndex = (this.rrIndex + 1) % n;

    console.info('[engine] play:', {
      idx: pick.idx,
      name: pick.name,
      priority: pick.priority,
      slotMs: slot,
      nextTickMs: tickMs,
      boundaryISO: new Date(snap.nextBoundaryMs).toISOString()
    });

    return { item: pick, tickMs, snap };
  }
}
