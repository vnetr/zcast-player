// renderer/schedule.ts
import { DateTime } from 'luxon';

const ALL_DAYS = ['mo','tu','we','th','fr','sa','su'] as const;
export type ByDayCode = typeof ALL_DAYS[number];

function isByDayCode(x: string): x is ByDayCode {
  return (ALL_DAYS as readonly string[]).includes(x);
}
function toByDayCode(x: unknown): ByDayCode | null {
  const s = String(x ?? '').toLowerCase();
  return isByDayCode(s) ? s : null;
}
function dayCodeFromLuxon(weekday: number): ByDayCode {
  // Luxon: 1=Mon..7=Sun
  const map: Record<number, ByDayCode> =
    {1:'mo',2:'tu',3:'we',4:'th',5:'fr',6:'sa',7:'su'};
  return map[weekday];
}

// ----------------------------
// NEW FORMAT (API list) utils
// ----------------------------
type ApiItem = {
  doc_uuid?: string;
  data?: {
    inceptAt?: string;
    expireAt?: string;
    fromTime?: string;
    toTime?: string;
    days?: Array<{ day: unknown; nthOfPeriod?: number }>;
    workingDays?: boolean;
    weekend?: boolean;
    priority?: number;
    media?: any;
    timeZone?: string;
  };
};

function normalizeToApiList(input: any): ApiItem[] | null {
  if (looksLikeApiList(input)) return input;
  if (looksLikeApiItem(input)) return [input];

  if (looksLikeFlatList(input)) return (input as any[]).map(d => ({ data: d }));
  if (looksLikeFlatItem(input)) return [{ data: input }];

  return null; // not API-style; probably legacy manifest
}


function looksLikeApiItem(x: any): x is ApiItem {
  return x && typeof x === 'object' && x.data && typeof x.data === 'object' && 'media' in x.data;
}

function looksLikeApiList(x: any): x is ApiItem[] {
  return Array.isArray(x) && x.length > 0 && looksLikeApiItem(x[0]);
}
// NEW: flattened item guards  (fields directly on the object)
function looksLikeFlatItem(x: any): x is Required<ApiItem>['data'] {
  return x && typeof x === 'object' && 'media' in x && x.media && typeof x.media === 'object';
}
function looksLikeFlatList(x: any): x is Array<Required<ApiItem>['data']> {
  return Array.isArray(x) && x.length > 0 && looksLikeFlatItem(x[0]);
}
function todaysWindow(now: DateTime, fromTime?: string, toTime?: string) {
  // If missing, treat as 00:00:00 -> 23:59:59.999
  const [fs='00',fm='00',fS='00', fms='000'] = (fromTime ?? '00:00:00.000').split(/[:.]/);
  const [ts='23',tm='59',tS='59', tms='999'] = (toTime ?? '23:59:59.999').split(/[:.]/);
  const start = now.set({ hour:+fs, minute:+fm, second:+fS, millisecond:+fms });
  const end   = now.set({ hour:+ts, minute:+tm, second:+tS, millisecond:+tms });
  return { start, end };
}

function allowedTodayByFlags(
  today: ByDayCode,
  itemDays?: Array<{ day: unknown; nthOfPeriod?: number }>,
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
  if (workingDays && weekend) return true;
  if (workingDays) return ['mo','tu','we','th','fr'].includes(today);
  if (weekend)     return ['sa','su'].includes(today);
  return true;
}

function pickFromApiList(list: ApiItem[], nowJS: Date = new Date()): ActivePick {
  if (!Array.isArray(list) || list.length === 0) {
    return { kind: 'none', nextCheck: Date.now() + 60_000 };
  }

  // Use item timeZone if provided; otherwise local TZ
  const tzDefault = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const candidates = list.map((row, idx) => {
    const d = row?.data ?? ({} as any);
    const tz = d.timeZone || tzDefault;

    const now = DateTime.fromJSDate(nowJS).setZone(tz);

    const incept = d.inceptAt ? DateTime.fromISO(d.inceptAt, { zone: tz }) : null;
    const expire = d.expireAt ? DateTime.fromISO(d.expireAt, { zone: tz }) : null;

    const { start: dayStart, end: dayEnd } = todaysWindow(now, d.fromTime, d.toTime);

    const withinDates =
      (!incept || now >= incept) &&
      (!expire || now <= expire);

    const todayCode = dayCodeFromLuxon(now.weekday);
    const allowedDay = allowedTodayByFlags(todayCode, d.days, d.workingDays, d.weekend);

    const withinDayWindow = now >= dayStart && now <= dayEnd;

    const active = withinDates && allowedDay && withinDayWindow;

    // Next boundary to re-check:
    // - if before incept: at incept
    // - else if before today's start: at today's start
    // - else if inside window: at today's end + 1ms
    // - else if after today's end: next day's start (roughly +24h at same fromTime)
    // - always clamp by expire if present
    let nextCheck: DateTime | null = null;
    if (incept && now < incept) nextCheck = incept;
    else if (now < dayStart) nextCheck = dayStart;
    else if (active) nextCheck = dayEnd.plus({ millisecond: 1 });
    else {
      // past today's window → tomorrow's start (best-effort)
      const tomorrow = now.plus({ days: 1 });
      const { start: tomorrowStart } = todaysWindow(tomorrow, d.fromTime, d.toTime);
      nextCheck = tomorrowStart;
    }
    if (expire && nextCheck > expire) nextCheck = expire.plus({ millisecond: 1 });

    return {
      idx,
      active,
      priority: Number(d.priority ?? 0),
      layout: d.media,
      nextCheckMs: nextCheck?.toMillis() ?? (Date.now() + 60_000),
    };
  });

  const nextCheck = Math.min(...candidates.map(c => c.nextCheckMs));

  const actives = candidates.filter(c => c.active && c.layout && c.layout.type === 'layout');
  if (actives.length === 0) return { kind: 'none', nextCheck };

  // Highest priority wins; tie-break: last defined wins
  actives.sort((a, b) => (b.priority - a.priority) || (b.idx - a.idx));
  const chosen = actives[0];

  return { kind: 'layout', layout: chosen.layout, nextCheck, reason: 'api-list+priority' };
}

// ----------------------------
// OLD FORMAT (unchanged)
// ----------------------------
function parseUntil(rule: any, tz: string): DateTime | null {
  const u = rule?.until;
  if (!u) return null;
  try { return DateTime.fromISO(u, { zone: tz }); } catch { return null; }
}
function allowedToday(rule: any, tzNow: DateTime): boolean {
  const by = rule?.byDay;
  if (!Array.isArray(by) || by.length === 0) return true;
  const codes = new Set<ByDayCode>(
    by.map((d: any) => toByDayCode(d?.day)).filter((v): v is ByDayCode => v !== null)
  );
  return codes.has(dayCodeFromLuxon(tzNow.weekday));
}

export type ActivePick =
  | { kind: 'none'; nextCheck: number }
  | { kind: 'layout'; layout: any; nextCheck: number; reason: string };

function pickFromLegacyManifest(scheduleDoc: any, nowJS: Date = new Date()): ActivePick {
  const events: any[] = scheduleDoc?.recipe?.events ?? [];
  if (!Array.isArray(events) || events.length === 0) {
    return { kind: 'none', nextCheck: Date.now() + 60_000 };
  }

  const candidates = events.map((ev: any, idx: number) => {
    const tz = ev?.timeZone || 'UTC';
    const now = DateTime.fromJSDate(nowJS).setZone(tz);
    const start = DateTime.fromISO(ev?.start, { zone: tz });
    const rule = Array.isArray(ev?.recurrenceRules) ? ev.recurrenceRules[0] : null;
    const until = parseUntil(rule, tz);

    const activeDay = allowedToday(rule, now);
    const started = start.isValid ? now >= start : true;
    const notEnded = until ? now <= until : true;
    const active = activeDay && started && notEnded;

    let nextCheck: DateTime | null = null;
    if (!started && start.isValid) nextCheck = start;
    else if (until) nextCheck = until.plus({ milliseconds: 1 });
    else nextCheck = now.plus({ hours: 1 });

    return {
      idx,
      ev,
      active,
      priority: Number(ev?.priority ?? 0),
      nextCheckMs: nextCheck?.toMillis() ?? (Date.now() + 60_000),
    };
  });

  const nextCheck = Math.min(...candidates.map(c => c.nextCheckMs));

  const actives = candidates.filter(c => c.active);
  if (actives.length === 0) return { kind: 'none', nextCheck };

  actives.sort((a, b) => (b.priority - a.priority) || (b.idx - a.idx));
  const chosen = actives[0].ev;

  const mt = chosen?.playlist?.media_templates;
  if (!Array.isArray(mt) || mt.length === 0) return { kind: 'none', nextCheck };

  const first = mt[0];
  const params = first?.params;
  if (!params || params.type !== 'layout') return { kind: 'none', nextCheck };

  const layoutDoc = params;
  return { kind: 'layout', layout: layoutDoc, nextCheck, reason: 'event+priority' };
}

// ----------------------------
// Entry point that supports BOTH
// ----------------------------
export function pickActiveContent(input: any, nowJS: Date = new Date()): ActivePick {
  const apiNorm = normalizeToApiList(input);
  if (apiNorm) return pickFromApiList(apiNorm, nowJS);
  return pickFromLegacyManifest(input, nowJS);
}
