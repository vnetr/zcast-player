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

type NewItemData = {
  inceptAt?: string;         // ISO
  expireAt?: string;         // ISO
  fromTime?: string;         // "HH:mm:ss.SSS"
  toTime?: string;           // "HH:mm:ss.SSS"
  days?: Array<{ day?: unknown; nthOfPeriod?: number }>;
  workingDays?: boolean;
  weekend?: boolean;
  priority?: number;
  media?: any;               // layout JSON
  timeZone?: string;         // optional timezone per item
  // other fields ignored
};

// ------------ normalizers (turn any new-API shape into NewItemData[]) ------------
function looksLikeLegacy(x: any): boolean {
  return x && typeof x === 'object' && x.recipe && Array.isArray(x.recipe.events);
}
function looksLikeNestedItem(x: any): x is { data: NewItemData } {
  return x && typeof x === 'object' && x.data && typeof x.data === 'object' && 'media' in x.data;
}
function looksLikeNestedList(x: any): x is Array<{ data: NewItemData }> {
  return Array.isArray(x) && x.length > 0 && looksLikeNestedItem(x[0]);
}
function looksLikeFlatItem(x: any): x is NewItemData {
  return x && typeof x === 'object' && 'media' in x && x.media && typeof x.media === 'object';
}
function looksLikeFlatList(x: any): x is NewItemData[] {
  return Array.isArray(x) && x.length > 0 && looksLikeFlatItem(x[0]);
}

function unwrapCommonWrappers(x: any): any {
  // Some APIs wrap lists under {results: [...]}, {data: [...]}, {items: [...]}
  if (x && typeof x === 'object') {
    if (Array.isArray((x as any).results)) return (x as any).results;
    if (Array.isArray((x as any).data))    return (x as any).data;
    if (Array.isArray((x as any).items))   return (x as any).items;
  }
  return x;
}

function normalizeToNewDataList(input: any): NewItemData[] | null {
  const x = unwrapCommonWrappers(input);

  if (looksLikeNestedList(x)) return (x as Array<{data: NewItemData}>).map(r => r.data);
  if (looksLikeNestedItem(x)) return [(x as {data: NewItemData}).data];

  if (looksLikeFlatList(x))   return x as NewItemData[];
  if (looksLikeFlatItem(x))   return [x as NewItemData];

  return null; // not new-API
}

// -------------------------- helpers used by evaluator --------------------------
function todaysWindow(now: DateTime, fromTime?: string, toTime?: string) {
  // Default to full day
  const [fs='00',fm='00',fS='00', fms='000'] = (fromTime ?? '00:00:00.000').split(/[:.]/);
  const [ts='23',tm='59',tS='59', tms='999'] = (toTime ?? '23:59:59.999').split(/[:.]/);
  const start = now.set({ hour:+fs, minute:+fm, second:+fS, millisecond:+fms });
  const end   = now.set({ hour:+ts, minute:+tm, second:+tS, millisecond:+tms });
  return { start, end };
}

function allowedTodayByFlags(
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
  if (workingDays && weekend) return true;                     // both → all days
  if (workingDays) return ['mo','tu','we','th','fr'].includes(today);
  if (weekend)     return ['sa','su'].includes(today);
  return true;                                                 // no constraints
}

// -------------------------- NEW format evaluator --------------------------
function pickFromNewDataList(list: NewItemData[], nowJS: Date = new Date()): ActivePick {
  if (!Array.isArray(list) || list.length === 0) {
    return { kind: 'none', nextCheck: Date.now() + 60_000 };
  }

  const tzDefault = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const candidates = list.map((d, idx) => {
    const tz = d.timeZone || tzDefault;
    const now = DateTime.fromJSDate(nowJS).setZone(tz);

    const incept = d.inceptAt ? DateTime.fromISO(d.inceptAt, { zone: tz }) : null;
    const expire = d.expireAt ? DateTime.fromISO(d.expireAt, { zone: tz }) : null;

    const { start: dayStart, end: dayEnd } = todaysWindow(now, d.fromTime, d.toTime);

    const withinDates =
      (!incept || (incept.isValid && now >= incept)) &&
      (!expire || (expire.isValid && now <= expire));

    const todayCode = dayCodeFromLuxon(now.weekday);
    const allowedDay = allowedTodayByFlags(todayCode, d.days, d.workingDays, d.weekend);

    const withinDayWindow = now >= dayStart && now <= dayEnd;

    const active = withinDates && allowedDay && withinDayWindow;

    // Next boundary to re-check
    let nextCheck: DateTime | null = null;
    if (incept && incept.isValid && now < incept)             nextCheck = incept;
    else if (now < dayStart)                                  nextCheck = dayStart;
    else if (active)                                          nextCheck = dayEnd.plus({ millisecond: 1 });
    else { // tomorrow start (best-effort)
      const tomorrow = now.plus({ days: 1 });
      const { start: tomorrowStart } = todaysWindow(tomorrow, d.fromTime, d.toTime);
      nextCheck = tomorrowStart;
    }
    if (expire && expire.isValid && nextCheck > expire)       nextCheck = expire.plus({ millisecond: 1 });

    return {
      idx,
      active,
      layout: d.media,
      priority: Number(d.priority ?? 0),
      nextCheckMs: nextCheck?.toMillis() ?? (Date.now() + 60_000),
      // diagnostics (useful during bring-up)
      __why: { withinDates, allowedDay, withinDayWindow, tz, incept: incept?.toISO(), expire: expire?.toISO(),
               fromTime: d.fromTime, toTime: d.toTime, today: todayCode }
    };
  });

  const nextCheck = Math.min(...candidates.map(c => c.nextCheckMs));
  const actives = candidates.filter(c => c.active && c.layout && c.layout.type === 'layout');

  if (actives.length === 0) {
    // Optional: uncomment for one-line diagnostics on the highest-priority item
    // const top = candidates.sort((a,b) => (b.priority - a.priority) || (b.idx - a.idx))[0];
    // console.info('[schedule:new] not active —', top?.__why);
    return { kind: 'none', nextCheck };
  }

  // Highest priority wins; tie-break: last defined wins
  actives.sort((a, b) => (b.priority - a.priority) || (b.idx - a.idx));
  const chosen = actives[0];

  return { kind: 'layout', layout: chosen.layout, nextCheck, reason: 'api-list+priority' };
}

// -------------------------- legacy evaluator (unchanged) --------------------------
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
      idx, ev, active,
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

// -------------------------- entry point (supports ALL shapes) --------------------------
export function pickActiveContent(input: any, nowJS: Date = new Date()): ActivePick {
  const newList = normalizeToNewDataList(input);
  if (newList) return pickFromNewDataList(newList, nowJS);
  if (looksLikeLegacy(input)) return pickFromLegacyManifest(input, nowJS);
  // Unknown or empty → re-check in ~1min
  return { kind: 'none', nextCheck: Date.now() + 60_000 };
}
