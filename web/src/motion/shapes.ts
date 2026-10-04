/**
 * Stroke-morph geometry. Every icon is three centerline strokes of N points
 * in a 24×24 box, drawn with round caps. A dot is a zero-length stroke, so any
 * icon can morph into any other by moving points: dots → wave → orbit → check.
 */
export const N = 24;
export type Pt = [number, number];
export interface Stroke { pts: Pt[]; w: number; o: number }
export type Shape = (t: number) => Stroke[];

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const line = (a: Pt, b: Pt): Pt[] => Array.from({ length: N }, (_, i) => [lerp(a[0], b[0], i / (N - 1)), lerp(a[1], b[1], i / (N - 1))]);
export const dot = (p: Pt): Pt[] => Array.from({ length: N }, () => [p[0], p[1]]);
export const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Pt[] =>
  Array.from({ length: N }, (_, i) => { const a = lerp(a0, a1, i / (N - 1)); return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
export function poly(points: Pt[]): Pt[] {
  const seg: number[] = []; let total = 0;
  for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); seg.push(d); total += d; }
  return Array.from({ length: N }, (_, i) => {
    let d = (i / (N - 1)) * total, k = 0;
    while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; }
    const f = seg[k] ? d / seg[k] : 0;
    return [lerp(points[k][0], points[k + 1][0], f), lerp(points[k][1], points[k + 1][1], f)];
  });
}
const S = (pts: Pt[], w = 2, o = 1): Stroke => ({ pts, w, o });
const TAU = Math.PI * 2;

export const shapes: Record<string, Shape> = {
  dots: (t) => [0, 1, 2].map((i) => S(dot([6 + i * 6, 12 + Math.sin(t * 2.2 + i * 0.9) * 0.35]), 2.8)),
  rest: () => [0, 1, 2].map((i) => S(dot([7 + i * 5, 13]), 2.2, 0.55)),
  wave: (t) => [0, 1, 2].map((i) => S(Array.from({ length: N }, (_, j) => {
    const x = 3 + i * 6 + (j / (N - 1)) * 6;
    return [x, 12 + Math.sin(x * 0.75 - t * 5) * 3.2 * Math.sin(((x - 3) / 18) * Math.PI)] as Pt;
  }), 2)),
  orbit: (t) => [0, 1, 2].map((i) => { const a = t * 3.2 + (i * TAU) / 3; return S(arc(12, 12, 8, a, a + 1.25), 2.2); }),
  progress: () => [S(arc(12, 12, 8.5, -Math.PI / 2, -Math.PI / 2 + TAU * 0.999), 2), S(dot([12, 3.5]), 0, 0), S(dot([12, 3.5]), 0, 0)],
  check: () => [S(line([5.2, 12.6], [10, 17.2]), 2.4), S(line([10, 17.2], [18.8, 7.4]), 2.4), S(dot([10, 17.2]), 2.4, 0)],
  clock: () => [S(arc(12, 12, 8.5, -Math.PI / 2, -Math.PI / 2 + TAU), 1.9), S(line([12, 12], [12, 7.2]), 1.9), S(line([12, 12], [15.4, 14]), 1.9)],
  eye: (t) => {
    const g = Math.sin(t * 0.7) * 1.6;
    return [S(poly([[3.5, 12], [7, 8.2], [12, 6.8], [17, 8.2], [20.5, 12]]), 1.8), S(poly([[3.5, 12], [7, 15.8], [12, 17.2], [17, 15.8], [20.5, 12]]), 1.8), S(dot([12 + g, 12]), 3.6)];
  },
  attention: (t) => [S(arc(12, 12, 8.5, -Math.PI / 2, -Math.PI / 2 + TAU), 1.9, 0.55 + 0.45 * Math.abs(Math.sin(t * 1.6))), S(line([12, 7.4], [12, 12.6]), 2.2), S(dot([12, 16.2]), 2.6)],
  blocked: () => [S(arc(12, 12, 8.5, -Math.PI / 2, -Math.PI / 2 + TAU), 1.9), S(line([8, 12], [16, 12]), 2.2), S(dot([12, 12]), 0, 0)],
  problem: () => [S(arc(12, 12, 8.5, -Math.PI / 2 + 0.55, -Math.PI / 2 + TAU - 0.55), 1.9), S(line([12, 9], [12, 13]), 2.1), S(dot([12, 16.3]), 2.5)],
  recover: (t) => { const a = t * 2.4; return [S(arc(12, 12, 8, a, a + TAU * 0.78), 1.9), S(line([12 + 8 * Math.cos(a + TAU * 0.78), 12 + 8 * Math.sin(a + TAU * 0.78)], [12 + 8 * Math.cos(a + TAU * 0.78) + 3.2 * Math.cos(a + TAU * 0.78 - 2.3), 12 + 8 * Math.sin(a + TAU * 0.78) + 3.2 * Math.sin(a + TAU * 0.78 - 2.3)]), 1.9), S(line([12 + 8 * Math.cos(a + TAU * 0.78), 12 + 8 * Math.sin(a + TAU * 0.78)], [12 + 8 * Math.cos(a + TAU * 0.78) + 3.2 * Math.cos(a + TAU * 0.78 + 0.9), 12 + 8 * Math.sin(a + TAU * 0.78) + 3.2 * Math.sin(a + TAU * 0.78 + 0.9)]), 1.9)]; },
  pause: () => [S(line([9, 6.5], [9, 17.5]), 2.6), S(line([15, 6.5], [15, 17.5]), 2.6), S(dot([12, 12]), 0, 0)],
  play: () => [S(line([8.5, 6], [8.5, 18]), 2.2), S(line([8.5, 6], [18, 12]), 2.2), S(line([8.5, 18], [18, 12]), 2.2)],
  stop: () => [S(poly([[7, 7], [17, 7], [17, 17]]), 2.2), S(poly([[17, 17], [7, 17], [7, 7]]), 2.2), S(dot([12, 12]), 0, 0)],
  arrowUp: () => [S(line([12, 19], [12, 5.5]), 2.2), S(line([6.5, 11], [12, 5.5]), 2.2), S(line([17.5, 11], [12, 5.5]), 2.2)],
  arrowRight: () => [S(line([5, 12], [18.5, 12]), 2.1), S(line([13, 6.5], [18.5, 12]), 2.1), S(line([13, 17.5], [18.5, 12]), 2.1)],
  close: () => [S(line([7, 7], [17, 17]), 2.1), S(line([17, 7], [7, 17]), 2.1), S(dot([12, 12]), 0, 0)],
  plus: () => [S(line([12, 6], [12, 18]), 2.1), S(line([6, 12], [18, 12]), 2.1), S(dot([12, 12]), 0, 0)],
  unplugged: () => [S(poly([[2.5, 12], [6.5, 12], [6.5, 8.5], [9.5, 8.5], [9.5, 15.5], [6.5, 15.5], [6.5, 12]]), 1.9), S(poly([[21.5, 12], [17.5, 12], [17.5, 8.5], [14.5, 8.5], [14.5, 15.5], [17.5, 15.5], [17.5, 12]]), 1.9), S(dot([12, 12]), 0, 0)],
  linked: () => [S(poly([[2.5, 12], [6.5, 12], [6.5, 8.5], [11.6, 8.5], [11.6, 15.5], [6.5, 15.5], [6.5, 12]]), 1.9), S(poly([[21.5, 12], [17.5, 12], [17.5, 8.5], [12.4, 8.5], [12.4, 15.5], [17.5, 15.5], [17.5, 12]]), 1.9), S(line([10, 12], [14, 12]), 2.2)],
  flow: (t) => [S(Array.from({ length: N }, (_, j) => { const x = 2.5 + (j / (N - 1)) * 19; return [x, 12 + Math.sin(x * 0.6 - t * 6) * 1.8] as Pt; }), 1.9), S(dot([2.5, 12]), 2.4), S(dot([21.5, 12]), 2.4)],
  bell: () => [S(poly([[6, 16.5], [7, 14.5], [7, 10.5], [8.6, 7.2], [12, 6], [15.4, 7.2], [17, 10.5], [17, 14.5], [18, 16.5]]), 1.8), S(line([5.5, 16.6], [18.5, 16.6]), 1.8), S(dot([12, 19.3]), 2.4)],
  bellRing: (t) => { const r = Math.sin(t * 9) * 0.6 * Math.max(0, Math.sin(t * 1.3)); return [S(poly([[6 + r, 16.5], [7 + r, 14.5], [7 + r, 10.5], [8.6 + r, 7.2], [12 + r, 6], [15.4 + r, 7.2], [17 + r, 10.5], [17 + r, 14.5], [18 + r, 16.5]]), 1.8), S(line([5.5 + r, 16.6], [18.5 + r, 16.6]), 1.8), S(dot([12 - r, 19.3]), 2.6)]; },
  sun: () => [S(arc(12, 12, 4.2, 0, TAU), 1.9), S(poly([[12, 2.5], [12, 4.5]]), 1.9), S(poly([[12, 19.5], [12, 21.5]]), 1.9)],
  moon: () => [S(poly([[15.5, 4.5], [10, 5.5], [7, 9.5], [7.5, 15], [12, 19], [17.5, 18.5], [20, 15]]), 1.9), S(poly([[20, 15], [14.5, 14], [12.3, 9.5], [15.5, 4.5]]), 1.9), S(dot([12, 12]), 0, 0)],
  chevronDown: () => [S(line([6.5, 9.5], [12, 15]), 2.1), S(line([17.5, 9.5], [12, 15]), 2.1), S(dot([12, 15]), 0, 0)],
  chevronRight: () => [S(line([9.5, 6.5], [15, 12]), 2.1), S(line([9.5, 17.5], [15, 12]), 2.1), S(dot([15, 12]), 0, 0)],
};

/** Map AUDA presence / task states onto morph shapes. */
export const presenceShape: Record<string, string> = {
  available: 'dots', idle: 'rest', listening: 'dots', thinking: 'wave', working: 'orbit', browsing: 'orbit', coding: 'orbit',
  waiting: 'clock', watching: 'eye', scheduled: 'clock', needs_you: 'attention', blocked: 'blocked', recovering: 'recover',
};
export const taskShape: Record<string, string> = {
  DRAFT: 'rest', PLANNING: 'wave', READY: 'dots', RUNNING: 'orbit', WAITING_EXTERNAL: 'clock', WAITING_USER: 'attention',
  SCHEDULED: 'clock', PAUSED: 'pause', RETRYING: 'recover', RECOVERING: 'recover', COMPLETED: 'check', FAILED: 'problem', CANCELLED: 'close',
};
