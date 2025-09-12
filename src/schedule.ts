// src/schedule.ts
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const DEFAULT_TZ = 'America/New_York';
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

// Correct weekday mapping: Luxon 1..7 = Mon..Sun
const DOW: ByDayCode[] = ['mo','tu','we','th','fr','sa','su'];
function dayCodeFromLuxon(weekday: number): ByDayCode {
  // guard in case weekday is 0 or >7
  const i = ((weekday - 1) % 7 + 7) % 7;
  return DOW[i];
}

// Shape of the **new** schedule item we evaluate internally
type NewItem = {
  inceptAt?: string;
  expireAt?: string;
  fromTime?: string;             // "HH:mm:ss.SSS"
  toTime?: string;               // "HH:mm:ss.SSS"
  days?: Array<{ day?: unknown; nthOfPeriod?: number }>;
  workingDays?: boolean;
  weekend?: boolean;
  priority?: number;
  media?: any;                   // layout JSON (must have type === 'layout')
  timeZone?: string;             // optional per-item TZ
  name?: string;                 // optional, for logs
  // other fields ignored
};

// ---------- Normalization: accept array/single, flat/nested ----------

function looksFlat(x: any): x is NewItem {
  return x && typeof x === 'object' && 'media' in x && x.media && typeof x.media === 'object';
}
function looksNested(x: any): x is { data: NewItem } {
  return x && typeof x === 'object' && x.data && typeof x.data === 'object' && 'media' in x.data;
}

// Some APIs wrap arrays as {results:[…]} or {data:[…]} or {items:[…]}
function unwrapListWrappers(x: any): any {
  if (x && typeof x === 'object') {
    if (Array.isArray((x as any).results)) return (x as any).results;
    if (Array.isArray((x as any).data))    return (x as any).data;
    if (Array.isArray((x as any).items))   return (x as any).items;
  }
  return x;
}

function normalize(manifest: any): NewItem[] {
  const raw = unwrapListWrappers(manifest);
  const out: NewItem[] = [];

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (looksFlat(it)) out.push(it);
      else if (looksNested(it)) out.push(it.data);
    }
  } else if (raw && typeof raw === 'object') {
    if (looksFlat(raw)) out.push(raw);
    else if (looksNested(raw)) out.push(raw.data);
  }

  // Logs so you always know what we saw
  console.groupCollapsed('[schedule] normalize');
  console.info('input type:', Array.isArray(manifest) ? `array(len=${manifest.length})` : typeof manifest);
  console.info('normalized items:', out.length);
  if (out.length > 0) {
    console.debug('first normalized item sample:', safePreview(out[0]));
  }
  console.groupEnd();

  return out;
}

function safePreview(x: unknown) {
  try { return JSON.parse(JSON.stringify(x)); } catch { return x; }
}

// ---------- Helpers for today window & day filters ----------
function todaysWindow(now: DateTime, fromTime?: string, toTime?: string) {
  // Default to full day
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
      itemDays
        .map(d => toByDayCode(d?.day))
        .filter((v): v is ByDayCode => v !== null)
    );
    return set.has(today);
  }
  if (workingDays && weekend) return true;                     // both => all 7 days
  if (workingDays) return ['mo','tu','we','th','fr'].includes(today);
  if (weekend)     return ['sa','su'].includes(today);
  return true;                                                 // no constraint
}

// ---------- Public types ----------
export type ActivePick =
  | { kind: 'none';   nextCheck: number }
  | { kind: 'layout'; layout: any; nextCheck: number; reason: string };

// ---------- Evaluator for new items only (forced EST by default) ----------
export function pickActiveContent(manifest: any, nowJS: Date = new Date()): ActivePick {
  const items = normalize(manifest);

  // If nothing recognizable → re-check a bit later (and log)
  if (items.length === 0) {
    console.warn('[schedule] manifest not recognized as new-format (no items with .media).');
    return { kind: 'none', nextCheck: Date.now() + 60_000 };
  }

  const candidates = items.map((d, idx) => {
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

    const active = withinDates && allowedDay && withinDayWindow;

    // Next moment to re-evaluate
    let nextCheck: DateTime | null = null;
    if (incept && incept.isValid && now < incept)             nextCheck = incept;
    else if (now < dayStart)                                  nextCheck = dayStart;
    else if (active)                                          nextCheck = dayEnd.plus({ millisecond: 1 });
    else { // tomorrow start
      const tomorrow = now.plus({ days: 1 });
      const { start: tomorrowStart } = todaysWindow(tomorrow, d.fromTime, d.toTime);
      nextCheck = tomorrowStart;
    }
    if (expire && expire.isValid && nextCheck > expire)       nextCheck = expire.plus({ millisecond: 1 });

    // DEBUG per-candidate
    console.groupCollapsed(`[schedule] item #${idx} (priority=${Number(d.priority ?? 0)})`);
    console.info('name:', d.name ?? '(unnamed)');
    console.info('tz:', tz, '| now:', now.toISO());
    console.info('inceptAt:', incept?.toISO() ?? '(none)', '| expireAt:', expire?.toISO() ?? '(none)');
    console.info('fromTime:', d.fromTime ?? '(00:00:00.000)', '| toTime:', d.toTime ?? '(23:59:59.999)');
    console.info('today:', todayCode, '| days[] present:', Array.isArray(d.days) ? d.days.length : 0,
                 '| workingDays:', !!d.workingDays, '| weekend:', !!d.weekend);
    console.info('withinDates:', withinDates, '| allowedDay:', allowedDay, '| withinDayWindow:', withinDayWindow);
    console.info('active:', active, '| nextCheck:', nextCheck?.toISO());
    console.groupEnd();

    return {
      idx,
      active,
      layout: d.media,
      priority: Number(d.priority ?? 0),
      nextCheckMs: nextCheck?.toMillis() ?? (Date.now() + 60_000),
    };
  });

  // When to wake up next time
  const nextCheck = Math.min(...candidates.map(c => c.nextCheckMs));

  // Pick active with highest priority; tie → last wins
  const actives = candidates.filter(c => c.active && c.layout && c.layout.type === 'layout');
  if (actives.length === 0) {
    const top = [...candidates].sort((a,b) => (b.priority - a.priority) || (b.idx - a.idx))[0];
    if (top) {
      console.warn('[schedule] no active item; highest-priority candidate snapshot:', {
        priority: top.priority, nextCheckISO: new Date(top.nextCheckMs).toISOString()
      });
    }
    return { kind: 'none', nextCheck };
  }

  actives.sort((a, b) => (b.priority - a.priority) || (b.idx - a.idx));
  const chosen = actives[0];

  console.info('[schedule] chosen item:', { idx: chosen.idx, priority: chosen.priority, nextCheckISO: new Date(nextCheck).toISOString() });

  return { kind: 'layout', layout: chosen.layout, nextCheck, reason: 'new-format+priority' };
}
