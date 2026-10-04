/**
 * AUDA's one spring solver. Physically coherent motion everywhere:
 * glyphs, morphs and small mechanical details all run on the same physics.
 */
export interface SpringConfig { stiffness: number; damping: number; mass?: number }

export const springs = {
  /** micro-interactions, ~160ms */
  snap: { stiffness: 720, damping: 44 },
  /** default state changes, ~280ms */
  settle: { stiffness: 420, damping: 34 },
  /** larger moves, ~450ms */
  glide: { stiffness: 210, damping: 26 },
  /** expressive transitions with a touch of overshoot, ~650ms */
  expressive: { stiffness: 170, damping: 15 },
  /** slow parameter drift for the glyph */
  drift: { stiffness: 60, damping: 14 },
} satisfies Record<string, SpringConfig>;

/** framer-motion equivalents for layout/presence animations. */
export const fm = {
  snap: { type: 'spring', stiffness: 720, damping: 44 },
  settle: { type: 'spring', stiffness: 420, damping: 34 },
  glide: { type: 'spring', stiffness: 260, damping: 30 },
  expressive: { type: 'spring', stiffness: 200, damping: 18 },
} as const;

export class Spring {
  value: number; velocity = 0; target: number;
  constructor(v: number, public cfg: SpringConfig = springs.settle) { this.value = v; this.target = v; }
  set(t: number) { this.target = t; }
  jump(v: number) { this.value = v; this.target = v; this.velocity = 0; }
  /** Integrate dt seconds with fixed substeps (stable at any frame rate). */
  step(dt: number) {
    const m = this.cfg.mass ?? 1;
    const h = 1 / 240;
    let rem = Math.min(dt, 0.064);
    while (rem > 0) {
      const s = Math.min(h, rem);
      const f = -this.cfg.stiffness * (this.value - this.target) - this.cfg.damping * this.velocity;
      this.velocity += (f / m) * s;
      this.value += this.velocity * s;
      rem -= s;
    }
    return this.value;
  }
  get settled() { return Math.abs(this.value - this.target) < 1e-3 && Math.abs(this.velocity) < 1e-3; }
}

// One shared animation clock. Subscribers return false when they're done.
type Tick = (dt: number, t: number) => boolean | void;
const subs = new Set<Tick>();
let raf = 0, last = 0;
const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const prefersReducedMotion = () => reduced;

function frame(ts: number) {
  const dt = last ? (ts - last) / 1000 : 1 / 60;
  last = ts;
  for (const s of [...subs]) if (s(dt, ts / 1000) === false) subs.delete(s);
  raf = subs.size ? requestAnimationFrame(frame) : 0;
  if (!raf) last = 0;
}
export function onTick(fn: Tick) {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(frame);
  return () => { subs.delete(fn); };
}
