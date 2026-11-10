/**
 * Deterministic time handling.
 *
 * LLMs are unreliable at calendar arithmetic ("last Tuesday" is a different date
 * every day). So the model never has to compute it: we resolve the user's date
 * expressions to absolute windows in the user's timezone *in code*, before the
 * first model call, and hand the model absolute dates.
 */
import * as chrono from 'chrono-node';

export interface TimeWindow {
  /** What the user wrote, e.g. "last Tuesday". */
  text: string;
  /** Human label of what we resolved it to, e.g. "Tue 3 Nov 2026". */
  label: string;
  startMs: number; // inclusive
  endMs: number; // exclusive
}

// ---------- timezone primitives (no deps; Intl does the heavy lifting) ----------

interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

export function wallClock(date: Date, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

function offsetMs(utcMs: number, tz: string): number {
  const w = wallClock(new Date(utcMs), tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads y-m-d h:mi. Month is 1-12; overflow is normalised. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let res = guess - offsetMs(guess, tz);
  const off2 = offsetMs(res, tz);
  res = guess - off2;
  return new Date(res);
}

export function startOfDay(y: number, m: number, d: number, tz: string): Date {
  return zonedToUtc(y, m, d, 0, 0, tz);
}

/** Calendar day number (days since epoch) of a wall date, for day-difference maths. */
function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function addDays(w: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dowOf(w: { y: number; m: number; d: number }): number {
  return new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
}

function labelDay(w: { y: number; m: number; d: number }): string {
  return `${DOW[dowOf(w)]} ${w.d} ${MON[w.m - 1]} ${w.y}`;
}

/** "Mon 9 Nov 2026, 14:32" in the given timezone. */
export function formatStamp(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  const hh = String(w.h).padStart(2, '0');
  const mm = String(w.mi).padStart(2, '0');
  return `${labelDay(w)}, ${hh}:${mm}`;
}

/** "today" | "yesterday" | "N days ago" by calendar day in the user's timezone. */
export function relativeDay(date: Date, now: Date, tz: string): string {
  const a = wallClock(date, tz);
  const b = wallClock(now, tz);
  const diff = dayNumber(b.y, b.m, b.d) - dayNumber(a.y, a.m, a.d);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 14) return `${diff} days ago`;
  if (diff < 60) return `${Math.round(diff / 7)} weeks ago`;
  return `${Math.round(diff / 30)} months ago`;
}

/** Long form for the system prompt: "Tuesday 10 November 2026, 15:42 (Asia/Kolkata)". */
export function formatNow(now: Date, tz: string): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return `${s.replace(' at ', ', ')} (${tz})`;
}

// ---------- resolving date expressions in free text ----------


function dayWindow(day: { y: number; m: number; d: number }, tz: string, text: string): TimeWindow {
  const next = addDays(day, 1);
  return {
    text,
    label: labelDay(day),
    startMs: startOfDay(day.y, day.m, day.d, tz).getTime(),
    endMs: startOfDay(next.y, next.m, next.d, tz).getTime(),
  };
}

function rangeWindow(from: { y: number; m: number; d: number }, toExclusive: { y: number; m: number; d: number }, tz: string, text: string, label: string): TimeWindow {
  return {
    text,
    label,
    startMs: startOfDay(from.y, from.m, from.d, tz).getTime(),
    endMs: startOfDay(toExclusive.y, toExclusive.m, toExclusive.d, tz).getTime(),
  };
}

/**
 * Find date expressions in `text` and resolve them to absolute windows in the
 * past (relative to `now`, in `tz`). Future references are dropped: memory only
 * contains the past.
 */
export function resolveTimeRefs(text: string, now: Date, tz: string): TimeWindow[] {
  const today = wallClock(now, tz);
  const todayDay = { y: today.y, m: today.m, d: today.d };
  const out: TimeWindow[] = [];
  let remaining = text;

  // Ranges chrono doesn't model well. Handled first, then blanked out of the text.
  const range = (re: RegExp, build: (m: RegExpMatchArray) => TimeWindow | null) => {
    remaining = remaining.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      const w = build(m);
      if (w) out.push(w);
      return ' ';
    });
  };

  range(/\b(last|past|previous)\s+(\d{1,3})\s+days?\b/gi, (m) => {
    const n = Math.min(Number(m[2]), 365);
    const from = addDays(todayDay, -n);
    return rangeWindow(from, addDays(todayDay, 1), tz, m[0], `${labelDay(from)} to ${labelDay(todayDay)}`);
  });
  range(/\b(last|previous)\s+week\b/gi, (m) => {
    const monThis = addDays(todayDay, -((dowOf(todayDay) + 6) % 7));
    const monLast = addDays(monThis, -7);
    return rangeWindow(monLast, monThis, tz, m[0], `week of ${labelDay(monLast)}`);
  });
  range(/\bthis\s+week\b/gi, (m) => {
    const monThis = addDays(todayDay, -((dowOf(todayDay) + 6) % 7));
    return rangeWindow(monThis, addDays(todayDay, 1), tz, m[0], `since ${labelDay(monThis)}`);
  });
  range(/\b(last|previous)\s+month\b/gi, (m) => {
    const first = { y: todayDay.m === 1 ? todayDay.y - 1 : todayDay.y, m: todayDay.m === 1 ? 12 : todayDay.m - 1, d: 1 };
    const thisFirst = { y: todayDay.y, m: todayDay.m, d: 1 };
    return rangeWindow(first, thisFirst, tz, m[0], `${MON[first.m - 1]} ${first.y}`);
  });

  // Reference date for chrono: a Date whose *local* fields equal the user's wall clock.
  const refWall = new Date(today.y, today.m - 1, today.d, today.h, today.mi, today.s);

  for (const r of chrono.en.parse(remaining, refWall, { forwardDate: false })) {
    const raw = r.text.trim();
    // "may" as a verb, bare "now", etc. are not dates.
    if (/^(may|now|sat|sun|mar|dec|oct|jan|feb|apr|jun|jul|aug|sep|sept|nov)$/i.test(raw) && raw === raw.toLowerCase()) continue;
    if (/^now$/i.test(raw) || /\b(next|coming)\b/i.test(raw)) continue;

    let day = { y: r.start.get('year')!, m: r.start.get('month')!, d: r.start.get('day')! };
    const weekdayOnly = r.start.isCertain('weekday') && !r.start.isCertain('day') && !r.start.isCertain('month');
    const monthDayNoYear = r.start.isCertain('month') && r.start.isCertain('day') && !r.start.isCertain('year');

    if (weekdayOnly) {
      // "Monday" in "On Monday we shortlisted…" means the most recent Monday strictly before today.
      const wd = r.start.get('weekday')!;
      const diff = (dowOf(todayDay) - wd + 7) % 7 || 7;
      const isLastX = /\blast\b/i.test(raw);
      day = isLastX ? day : addDays(todayDay, -diff);
      if (isLastX && dayNumber(day.y, day.m, day.d) >= dayNumber(todayDay.y, todayDay.m, todayDay.d)) day = addDays(day, -7);
    } else if (monthDayNoYear && dayNumber(day.y, day.m, day.d) > dayNumber(todayDay.y, todayDay.m, todayDay.d)) {
      day = { ...day, y: day.y - 1 };
    }

    const future = dayNumber(day.y, day.m, day.d) > dayNumber(todayDay.y, todayDay.m, todayDay.d);
    if (future || (/\bthis\b/i.test(raw) && weekdayOnly)) continue; // memory only holds the past
    out.push(dayWindow(day, tz, raw));
  }

  return out;
}

