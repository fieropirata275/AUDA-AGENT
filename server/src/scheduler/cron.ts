/** Minimal 5-field cron (minute hour day-of-month month day-of-week), local time. */
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.toLowerCase().split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let lo = min, hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map((x) => (x in NAMES ? NAMES[x] : Number(x)));
      lo = a; hi = b ?? (stepS ? max : a);
    }
    if ([lo, hi, step].some((n) => Number.isNaN(n))) throw new Error(`Bad cron field: ${expr}`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 6 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('Cron needs 5 fields');
  return { min: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow: field(f[4], 0, 6), domStar: f[2] === '*', dowStar: f[4] === '*' };
}

export function nextCron(expr: string, after = Date.now()): number {
  const c = parseCron(expr);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 527_040; i++) { // one year of minutes
    const dayOk = c.domStar && c.dowStar ? true
      : c.domStar ? c.dow.has(d.getDay()) : c.dowStar ? c.dom.has(d.getDate()) : c.dom.has(d.getDate()) || c.dow.has(d.getDay());
    if (c.mon.has(d.getMonth() + 1) && dayOk && c.hour.has(d.getHours()) && c.min.has(d.getMinutes())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error('Cron never fires');
}
