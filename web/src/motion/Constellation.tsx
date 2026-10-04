/**
 * The constellation: AUDA's work made visible around its glyph.
 *
 * Every agent at work is a satellite on an orbit around the Aperture; its
 * sub-agents are moons around it; threads carry a flowing current from the
 * core to each one. New work launches out of the core on a spring, finished
 * work is absorbed back into it with a burst. One rAF loop moves everything
 * through direct style writes — React only re-renders when the set changes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Aperture } from './Aperture';
import { Spring, onTick, springs, prefersReducedMotion } from './spring';
import { TaskGlyph, TASK_LABEL } from '../components/glyphs';
import { openSheet } from '../components/ui';
import type { Task } from '../lib/types';

const ACTIVE = new Set(['RUNNING', 'READY', 'RETRYING', 'RECOVERING', 'WAITING_EXTERNAL', 'WAITING_USER', 'PAUSED']);
const TAU = Math.PI * 2;

type Node = {
  id: string; parent?: string; task: Task;
  angle: number; r: Spring; scale: Spring; leaving: boolean; born: number;
};

const tone = (t: Task) =>
  t.state === 'WAITING_USER' ? 'var(--attention)' : t.state === 'RETRYING' || t.state === 'RECOVERING' ? 'var(--problem)' : t.state === 'PAUSED' || t.state === 'WAITING_EXTERNAL' ? 'var(--ink-4)' : 'var(--accent)';
const speed = (t: Task) =>
  t.state === 'RUNNING' ? 0.22 : t.state === 'READY' ? 0.14 : t.state === 'RECOVERING' || t.state === 'RETRYING' ? -0.18 : t.state === 'WAITING_USER' ? 0 : 0.04;

export function Constellation({ tasks, state, flash, size = 360 }: { tasks: Task[]; state: string; flash?: number; size?: number }) {
  const reduced = prefersReducedMotion();
  const c = size / 2;
  const ring = size * 0.445;
  const moon = size * 0.12;
  const glyph = Math.round(size * 0.64);

  const live = useMemo(() => tasks.filter((t) => ACTIVE.has(t.state) && t.playbook === 'agent'), [tasks]);
  const nodes = useRef(new Map<string, Node>());
  const els = useRef(new Map<string, { bead: HTMLElement | null; line: SVGLineElement | null }>());
  const [, force] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [bursts, setBursts] = useState<{ id: number; x: number; y: number; color: string }[]>([]);
  const [ripples, setRipples] = useState<number[]>([]);

  // Reconcile the set of nodes with the tasks that are live now.
  useEffect(() => {
    const map = nodes.current;
    const ids = new Set(live.map((t) => t.id));
    const tops = live.filter((t) => !t.parentTaskId || !ids.has(t.parentTaskId));
    tops.forEach((t, i) => {
      const n = map.get(t.id);
      if (n) { n.task = t; n.leaving = false; n.r.set(ring); n.scale.set(1); return; }
      // Launch from the core at the emptiest angle.
      const taken = [...map.values()].filter((x) => !x.parent && !x.leaving).map((x) => x.angle);
      const angle = taken.length ? emptiest(taken) : -Math.PI / 2 + i * (TAU / Math.max(1, tops.length));
      const node: Node = { id: t.id, task: t, angle, r: new Spring(reduced ? ring : 0, springs.expressive), scale: new Spring(reduced ? 1 : 0.2, springs.expressive), leaving: false, born: performance.now() };
      node.r.set(ring); node.scale.set(1);
      map.set(t.id, node);
    });
    for (const t of live) {
      if (!t.parentTaskId || !ids.has(t.parentTaskId)) continue;
      const n = map.get(t.id);
      if (n) { n.task = t; n.leaving = false; n.r.set(moon); n.scale.set(1); continue; }
      const sibs = live.filter((x) => x.parentTaskId === t.parentTaskId).findIndex((x) => x.id === t.id);
      const node: Node = { id: t.id, parent: t.parentTaskId, task: t, angle: sibs * (TAU / 3), r: new Spring(0, springs.expressive), scale: new Spring(0.2, springs.expressive), leaving: false, born: performance.now() };
      node.r.set(moon); node.scale.set(1);
      map.set(t.id, node);
    }
    // Whatever is no longer live is absorbed back into the core.
    for (const n of map.values()) if (!ids.has(n.id) && !n.leaving) { n.leaving = true; n.r.set(0); n.scale.set(0.3); }
    force((x) => x + 1);
  }, [live, ring, moon, reduced]);

  // Celebrate completions: a ripple from the glyph.
  useEffect(() => {
    if (!flash || reduced) return;
    setRipples((r) => [...r.slice(-2), flash]);
    const t = setTimeout(() => setRipples((r) => r.filter((x) => x !== flash)), 1600);
    return () => clearTimeout(t);
  }, [flash, reduced]);

  // The single animation loop.
  useEffect(() => onTick((dt, t) => {
    let removed = false;
    const pos = new Map<string, [number, number]>();
    const order = [...nodes.current.values()].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
    for (const n of order) {
      n.r.step(dt); n.scale.step(dt);
      if (!reduced) n.angle += speed(n.task) * dt * (n.parent ? 3 : 1);
      const origin = n.parent ? pos.get(n.parent) ?? [c, c] : [c, c];
      const wobble = reduced ? 0 : Math.sin(t * 0.9 + n.born) * 3;
      const x = origin[0] + Math.cos(n.angle) * (n.r.value + wobble);
      const y = origin[1] + Math.sin(n.angle) * (n.r.value + wobble);
      pos.set(n.id, [x, y]);
      const e = els.current.get(n.id);
      if (e?.bead) {
        const pulse = n.task.state === 'WAITING_USER' && !reduced ? 1 + Math.sin(t * 4) * 0.06 : 1;
        e.bead.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${Math.max(0, n.scale.value * pulse)})`;
        e.bead.style.opacity = String(Math.min(1, n.scale.value));
      }
      if (e?.line) {
        e.line.setAttribute('x1', String(origin[0])); e.line.setAttribute('y1', String(origin[1]));
        e.line.setAttribute('x2', String(x)); e.line.setAttribute('y2', String(y));
        if (!reduced) e.line.style.strokeDashoffset = String(-(t * 26) % 1000);
      }
      if (n.leaving && n.r.value < 6) {
        nodes.current.delete(n.id);
        removed = true;
        if (!reduced && !n.parent) setBursts((b) => [...b.slice(-4), { id: Math.random(), x: c, y: c, color: 'var(--settled)' }]);
      }
    }
    if (removed) force((x) => x + 1);
  }), [c, reduced]);

  const list = [...nodes.current.values()];
  const hovered = hover ? nodes.current.get(hover) : undefined;

  return (
    <div className="constellation" style={{ width: size, height: size }}>
      <svg className="orbits" width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id="core-glow"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
        </defs>
        <circle cx={c} cy={c} r={ring} className="orbit-ring" />
        <circle cx={c} cy={c} r={ring * 0.82} className="orbit-ring faint" />
        {list.length > 0 && <circle cx={c} cy={c} r={glyph * 0.62} fill="url(#core-glow)" />}
        {list.map((n) => (
          <line key={n.id} ref={(el) => { const e = els.current.get(n.id) ?? { bead: null, line: null }; e.line = el; els.current.set(n.id, e); }}
            className={`thread ${n.parent ? 'moon' : ''}`} stroke={tone(n.task)} x1={c} y1={c} x2={c} y2={c} />
        ))}
      </svg>
      {ripples.map((r) => <span key={r} className="ripple" style={{ left: c, top: c, width: glyph, height: glyph }} />)}
      <div className="core" style={{ left: c - glyph / 2, top: c - glyph / 2, width: glyph, height: glyph }}>
        <Aperture state={state} size={glyph} flash={flash} />
      </div>
      {list.map((n) => (
        <button key={n.id} type="button" className={`sat ${n.parent ? 'moon' : ''} ${n.task.state === 'WAITING_USER' ? 'needs' : ''}`}
          ref={(el) => { const e = els.current.get(n.id) ?? { bead: null, line: null }; e.bead = el; els.current.set(n.id, e); }}
          style={{ transform: `translate(${c}px, ${c}px) translate(-50%, -50%) scale(0)` }}
          aria-label={`${n.task.title} — ${TASK_LABEL[n.task.state] ?? n.task.state}`}
          onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover((h) => (h === n.id ? null : h))} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
          onClick={() => openSheet({ type: 'task', id: n.id })}>
          {n.task.agent && !n.parent ? <span className="sat-emoji">{n.task.agent.emoji}</span> : <TaskGlyph state={n.task.state} size={n.parent ? 10 : 15} />}
        </button>
      ))}
      <AnimatePresence>
        {hovered && (
          <motion.div key={hovered.id} className="sat-tip" initial={{ opacity: 0, y: 4, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ type: 'spring', stiffness: 520, damping: 34 }}>
            <div className="sat-tip-title">{hovered.task.agent ? `${hovered.task.agent.emoji} ${hovered.task.agent.name} · ` : ''}{hovered.task.title}</div>
            <div className="small faint">{TASK_LABEL[hovered.task.state]}{hovered.task.nowLine ? ` — ${hovered.task.nowLine}` : ''}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {bursts.map((b) => <Burst key={b.id} x={b.x} y={b.y} color={b.color} radius={glyph * 0.55} onDone={() => setBursts((x) => x.filter((y) => y.id !== b.id))} />)}
    </div>
  );
}

function emptiest(angles: number[]) {
  const a = angles.map((x) => ((x % TAU) + TAU) % TAU).sort((p, q) => p - q);
  let best = 0, gap = -1;
  for (let i = 0; i < a.length; i++) {
    const next = i + 1 < a.length ? a[i + 1] : a[0] + TAU;
    if (next - a[i] > gap) { gap = next - a[i]; best = a[i] + gap / 2; }
  }
  return best;
}

/** A small burst of sparks: work absorbed into the core. */
function Burst({ x, y, color, radius, onDone }: { x: number; y: number; color: string; radius: number; onDone: () => void }) {
  const sparks = useMemo(() => Array.from({ length: 14 }, (_, i) => ({ a: (i / 14) * TAU + Math.random() * 0.3, d: radius * (0.7 + Math.random() * 0.6), s: 3 + Math.random() * 3 })), [radius]);
  return (
    <>
      {sparks.map((p, i) => (
        <motion.span key={i} className="burst-spark" style={{ left: x, top: y, width: p.s, height: p.s, background: color }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }} animate={{ x: Math.cos(p.a) * p.d, y: Math.sin(p.a) * p.d, opacity: 0, scale: 0.4 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} onAnimationComplete={i === 0 ? onDone : undefined} />
      ))}
    </>
  );
}
