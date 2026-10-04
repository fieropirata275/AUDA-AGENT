/**
 * <Morph shape="check" /> — a stroke-morph icon. Changing `shape` never swaps
 * an icon: the current geometry springs into the new one.
 */
import { useEffect, useRef } from 'react';
import { N, shapes, type Stroke } from './shapes';
import { Spring, onTick, springs, prefersReducedMotion, type SpringConfig } from './spring';

const ANIMATED = new Set(['dots', 'wave', 'orbit', 'eye', 'attention', 'recover', 'flow', 'bellRing']);

function toPath(pts: number[][]) {
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return d;
}

export function Morph({ shape, size = 20, color = 'currentColor', weight = 1, spring = springs.settle, animate = true, className, title }: {
  shape: string; size?: number; color?: string; weight?: number; spring?: SpringConfig; animate?: boolean; className?: string; title?: string;
}) {
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const state = useRef<{ from: Stroke[]; cur: Stroke[]; shape: string; p: Spring; t0: number } | null>(null);

  useEffect(() => {
    const fn = shapes[shape] ?? shapes.dots;
    const now = performance.now() / 1000;
    const st = state.current;
    if (!st) {
      const s = fn(now);
      state.current = { from: s, cur: s, shape, p: new Spring(1, spring), t0: now };
    } else if (st.shape !== shape) {
      st.from = st.cur.map((s) => ({ pts: s.pts.map((p) => [p[0], p[1]] as [number, number]), w: s.w, o: s.o }));
      st.shape = shape;
      st.p = new Spring(0, spring);
      st.p.set(1);
      if (prefersReducedMotion()) st.p.jump(1);
    }
    const s = state.current!;
    const live = animate && ANIMATED.has(shape) && !prefersReducedMotion();
    const stop = onTick((dt, t) => {
      const target = fn(t);
      const k = s.p.step(dt);
      s.cur = target.map((tg, i) => {
        const f = s.from[i] ?? tg;
        return {
          pts: tg.pts.map((p, j) => [f.pts[j][0] + (p[0] - f.pts[j][0]) * k, f.pts[j][1] + (p[1] - f.pts[j][1]) * k] as [number, number]),
          w: f.w + (tg.w - f.w) * k, o: f.o + (tg.o - f.o) * k,
        };
      });
      s.cur.forEach((st, i) => {
        const el = paths.current[i];
        if (!el) return;
        el.setAttribute('d', toPath(st.pts));
        el.setAttribute('stroke-width', String(Math.max(0, st.w * weight)));
        el.setAttribute('opacity', String(Math.max(0, Math.min(1, st.o))));
      });
      return live || !s.p.settled;
    });
    return stop;
  }, [shape, animate, weight]); // eslint-disable-line react-hooks/exhaustive-deps

  const init = (shapes[shape] ?? shapes.dots)(performance.now() / 1000);
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={!title} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {[0, 1, 2].map((i) => (
        <path key={i} ref={(el) => { paths.current[i] = el; }} d={toPath(init[i].pts)} stroke={color} strokeWidth={init[i].w * weight}
          opacity={init[i].o} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
export { N };
