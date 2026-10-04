/**
 * Natural-language schedules → structured schedule specs.
 * Fuzzy times ("tomorrow morning") become windows; AUDA picks a moment
 * inside the window rather than pretending to a precision you didn't ask for.
 */
export interface ParsedSchedule {
  kind: 'cron' | 'once' | 'interval' | 'fuzzy';
  spec: string;           // cron expr | ISO time | seconds | JSON window
  description: string;
  nextRunAt: number;
  windowEnd?: number;
}
import { nextCron } from './cron.ts';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PARTS: Record<string, [number, number]> = { morning: [8, 10], afternoon: [13, 16], evening: [18, 20], night: [21, 23], noon: [12, 12.5] };

function time(s: string): [number, number] | null {
  const m = s.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?\b/i);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (!m[2] && !m[3] && !/\bat\s+\d/i.test(s)) return null;
  if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
  if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? [h, min] : null;
}
const pad = (n: number) => String(n).padStart(2, '0');

export function parseSchedule(text: string, nowMs = Date.now()): ParsedSchedule | null {
  const s = text.toLowerCase();
  const t = time(s);
  const part = Object.keys(PARTS).find((p) => s.includes(p));

  // in N minutes/hours/days
  const rel = s.match(/\bin\s+(\d+|an?|one)\s*(minute|min|hour|day|week)s?\b/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : 1;
    const ms = { minute: 60e3, min: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3 }[rel[2] as 'minute']!;
    const at = nowMs + n * ms;
    return { kind: 'once', spec: new Date(at).toISOString(), description: `in ${n} ${rel[2]}${n > 1 ? 's' : ''}`, nextRunAt: at };
  }

  // every N minutes/hours
  const every = s.match(/\bevery\s+(\d+)?\s*(minute|min|hour|day)s?\b/);
  if (every && !DAYS.some((d) => s.includes(d)) && !(every[2] === 'day' && (t || part))) {
    const n = Number(every[1] ?? 1);
    const sec = n * { minute: 60, min: 60, hour: 3600, day: 86400 }[every[2] as 'minute']!;
    return { kind: 'interval', spec: String(sec), description: `every ${n > 1 ? n + ' ' : ''}${every[2]}${n > 1 ? 's' : ''}`, nextRunAt: nowMs + sec * 1000 };
  }

  const recurring = /\b(every|each|daily|weekly|weekdays?|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/.test(s);
  const [h, m] = t ?? (part ? [Math.floor(PARTS[part][0]), 0] : [9, 0]);
  if (recurring) {
    let dow = '*', label = 'every day';
    const day = DAYS.findIndex((d) => s.includes(d));
    if (/weekday/.test(s)) { dow = '1-5'; label = 'every weekday'; }
    else if (day >= 0) { dow = String(day); label = `every ${DAYS[day][0].toUpperCase()}${DAYS[day].slice(1)}`; }
    else if (/weekly|every week/.test(s)) { dow = '1'; label = 'every Monday'; }
    const expr = `${m} ${h} * * ${dow}`;
    return { kind: 'cron', spec: expr, description: `${label} ${t ? `at ${pad(h)}:${pad(m)}` : part ? `in the ${part}` : `at ${pad(h)}:${pad(m)}`}`, nextRunAt: nextCron(expr, nowMs) };
  }

  // one-off: today/tomorrow/<weekday> + time or part of day
  const base = new Date(nowMs);
  let dayLabel = 'today';
  if (/\btomorrow\b/.test(s)) { base.setDate(base.getDate() + 1); dayLabel = 'tomorrow'; }
  else {
    const day = DAYS.findIndex((d) => s.includes(d));
    if (day >= 0) { const diff = (day - base.getDay() + 7) % 7 || 7; base.setDate(base.getDate() + diff); dayLabel = DAYS[day][0].toUpperCase() + DAYS[day].slice(1); }
    else if (!t && !part) return null;
  }
  if (t) {
    base.setHours(t[0], t[1], 0, 0);
    if (base.getTime() <= nowMs) base.setDate(base.getDate() + 1);
    return { kind: 'once', spec: base.toISOString(), description: `${dayLabel} at ${pad(t[0])}:${pad(t[1])}`, nextRunAt: base.getTime() };
  }
  const [a, b] = PARTS[part ?? 'morning'];
  const start = new Date(base); start.setHours(Math.floor(a), (a % 1) * 60, 0, 0);
  const end = new Date(base); end.setHours(Math.floor(b), (b % 1) * 60, 0, 0);
  if (end.getTime() <= nowMs) { start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1); }
  const pick = Math.max(nowMs + 60e3, start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  return { kind: 'fuzzy', spec: JSON.stringify({ from: start.getTime(), to: end.getTime() }), description: `${dayLabel} ${part ?? 'morning'} (${pad(Math.floor(a))}:00–${pad(Math.floor(b))}:00)`, nextRunAt: pick, windowEnd: end.getTime() };
}
