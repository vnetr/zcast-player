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

function parseUntil(rule: any, tz: string): DateTime | null {
  const u = rule?.until;
  if (!u) return null;
  try { return DateTime.fromISO(u, { zone: tz }); } catch { return null; }
}

function allowedToday(rule: any, tzNow: DateTime): boolean {
  const by = rule?.byDay;
  if (!Array.isArray(by) || by.length === 0) return true; // no restriction

  // Safely narrow to ByDayCode[]
  const codes = new Set<ByDayCode>(
    by
      .map((d: any) => toByDayCode(d?.day))
      .filter((v): v is ByDayCode => v !== null)
  );

  return codes.has(dayCodeFromLuxon(tzNow.weekday));
}

export type ActivePick =
  | { kind: 'none'; nextCheck: number }
  | { kind: 'layout'; layout: any; nextCheck: number; reason: string };

export function pickActiveContent(scheduleDoc: any, nowJS: Date = new Date()): ActivePick {
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
    const started = start.isValid ? now >= start : true;  // if no/invalid start, consider started
    const notEnded = until ? now <= until : true;

    const active = activeDay && started && notEnded;

    // Next boundary to re-check
    let nextCheck: DateTime | null = null;
    if (!started && start.isValid) nextCheck = start;
    else if (until) nextCheck = until.plus({ milliseconds: 1 });
    else nextCheck = now.plus({ hours: 1 }); // conservative fallback

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
  if (actives.length === 0) {
    return { kind: 'none', nextCheck };
  }

  // Highest priority wins; tie-break: last defined wins
  actives.sort((a, b) => (b.priority - a.priority) || (b.idx - a.idx));
  const chosen = actives[0].ev;

  // Your CMS emits a single layout under playlist.media_templates[0].params
  const mt = chosen?.playlist?.media_templates;
  if (!Array.isArray(mt) || mt.length === 0) return { kind: 'none', nextCheck };

  const first = mt[0];
  const params = first?.params;
  if (!params || params.type !== 'layout') return { kind: 'none', nextCheck };

  const layoutDoc = params; // already a full layout JSON
  return { kind: 'layout', layout: layoutDoc, nextCheck, reason: 'event+priority' };
}
