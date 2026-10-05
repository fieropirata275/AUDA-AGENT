/**
 * The Aperture — AUDA's glyph. Three closed polar curves rendered as a
 * ceramic lens in a recessed socket. Every presence state is a set of
 * parameter targets; springs move the parameters, so state changes are
 * continuous morphs, never swaps.
 */
import { useEffect, useId, useRef } from 'react';
import { Spring, onTick, springs, prefersReducedMotion } from './spring';
import { voiceSignal } from '../lib/voice';

type P = { r: number; amp: number; inner: number; core: number; spin: number; breath: number; rate: number; orbit: number; pulse: number; notch: number; gaze: number; churn: number; resolve: number };
const BASE: P = { r: 0.8, amp: 0.03, inner: 0.03, core: 0.3, spin: 0.12, breath: 0.018, rate: 0.35, orbit: 0, pulse: 0, notch: 0, gaze: 0, churn: 0.4, resolve: 0 };

export const PRESETS: Record<string, Partial<P>> = {
  idle: { r: 0.74, amp: 0.015, inner: 0.015, core: 0.27, spin: 0.04, breath: 0.022, rate: 0.18, churn: 0.15 },
  available: {},
  listening: { r: 0.86, amp: 0.02, inner: 0.02, core: 0.36, breath: 0.03, rate: 0.9, churn: 0.6 },
  thinking: { amp: 0.05, inner: 0.11, core: 0.25, spin: 0.32, churn: 1.9, breath: 0.012 },
  working: { amp: 0.04, inner: 0.05, spin: 0.85, orbit: 1, churn: 0.9 },
  coding: { amp: 0.035, inner: 0.06, spin: 0.85, orbit: 1, churn: 1.1 },
  browsing: { amp: 0.04, inner: 0.05, spin: 0.7, orbit: 1, churn: 0.8, gaze: 0.05 },
  waiting: { r: 0.77, amp: 0.012, inner: 0.015, core: 0.33, spin: 0.03, breath: 0.015, rate: 0.14, churn: 0.12 },
  scheduled: { r: 0.77, amp: 0.012, inner: 0.015, core: 0.31, spin: 0.03, breath: 0.015, rate: 0.14, churn: 0.12 },
  watching: { amp: 0.022, inner: 0.025, core: 0.29, spin: 0.08, gaze: 0.09, churn: 0.3 },
  needs_you: { amp: 0.03, pulse: 1, core: 0.31, spin: 0.06, breath: 0.03, rate: 0.45 },
  blocked: { notch: 0.55, amp: 0.02, spin: 0.02, churn: 0.2 },
  recovering: { spin: -0.7, orbit: 0.55, amp: 0.05, inner: 0.07, churn: 1.4 },
  problem: { notch: 1, amp: 0.02, spin: 0.02 },
  completed: { resolve: 1, amp: 0, inner: 0, spin: 0.2 },
};

const KEYS = Object.keys(BASE) as (keyof P)[];
const TAU = Math.PI * 2;
const SEG = 72;

function blob(cx: number, cy: number, R: number, f: (a: number) => number, rot: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i < SEG; i++) { const a = (i / SEG) * TAU; const r = R * f(a); pts.push([cx + r * Math.cos(a + rot), cy + r * Math.sin(a + rot)]); }
  // Closed Catmull-Rom → cubic Bézier for a smooth, organic outline.
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < SEG; i++) {
    const p0 = pts[(i - 1 + SEG) % SEG], p1 = pts[i], p2 = pts[(i + 1) % SEG], p3 = pts[(i + 2) % SEG];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + 'Z';
}

/** `reactive`: the glyph also moves with your voice while you talk to AUDA, and with its own when it answers. */
export function Aperture({ state = 'available', size = 200, flash, reactive = false }: { state?: string; size?: number; flash?: number; reactive?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const refs = useRef<Record<string, SVGElement | null>>({});
  const springsRef = useRef<Record<keyof P, Spring> | null>(null);
  const target = useRef(state);
  target.current = state;
  const flashRef = useRef(0);

  if (!springsRef.current) {
    const init = { ...BASE, ...PRESETS[state] };
    springsRef.current = Object.fromEntries(KEYS.map((k) => [k, new Spring(init[k], ['spin', 'churn', 'rate'].includes(k) ? springs.drift : springs.glide)])) as Record<keyof P, Spring>;
  }

  useEffect(() => {
    const p = { ...BASE, ...PRESETS[state] };
    for (const k of KEYS) springsRef.current![k].set(p[k]);
  }, [state]);

  useEffect(() => { if (flash) flashRef.current = 1; }, [flash]);

  useEffect(() => {
    const S = springsRef.current!;
    let phase = Math.random() * 10, rot = 0, orbitA = 0, t = 0;
    const voice = new Spring(0, springs.snap);
    const reduced = prefersReducedMotion();
    const hidden = () => document.hidden;
    return onTick((dt) => {
      if (hidden()) return true;
      const v = Object.fromEntries(KEYS.map((k) => [k, S[k].step(dt)])) as P;
      t += dt;
      const speed = reduced ? 0.15 : 1;
      phase += dt * v.churn * speed;
      rot += dt * v.spin * speed;
      orbitA += dt * (0.9 + Math.abs(v.spin)) * Math.sign(v.spin || 1) * speed;
      flashRef.current = Math.max(0, flashRef.current - dt * 1.4);
      voice.set(reactive && (voiceSignal.listening || voiceSignal.speaking) ? voiceSignal.level : 0);
      const lv = Math.max(0, voice.step(dt));
      const breathe = (1 + v.breath * Math.sin(t * TAU * v.rate)) * (1 + lv * 0.09);
      const live = 1 - v.resolve;
      const notchAt = -Math.PI / 4;
      const notch = (a: number) => {
        const d = Math.atan2(Math.sin(a - notchAt), Math.cos(a - notchAt));
        return 1 - v.notch * 0.22 * Math.exp(-(d * d) / 0.09);
      };
      const c = 100;
      const R = 72 * v.r * breathe;
      const outer = blob(c, c, R, (a) => (1 + live * (v.amp * Math.sin(3 * a + phase) + v.amp * 0.6 * Math.sin(5 * a - phase * 1.3)) + lv * 0.07 * Math.sin(9 * a + t * 14)) * notch(a + rot), rot);
      const mid = blob(c + v.gaze * 40 * Math.sin(t * 0.37) * live, c + v.gaze * 22 * Math.cos(t * 0.29) * live, R * 0.74,
        (a) => (1 + live * (v.inner * Math.sin(4 * a - phase * 1.7) + v.inner * 0.7 * Math.sin(7 * a + phase * 0.9))) * notch(a - rot * 1.4), -rot * 1.4);
      const coreR = 72 * v.core * (1 + 0.04 * Math.sin(t * TAU * v.rate + 1)) * (1 + flashRef.current * 0.25) * (1 + lv * 0.35);
      const core = blob(c + v.gaze * 52 * Math.sin(t * 0.37) * live, c + v.gaze * 30 * Math.cos(t * 0.29) * live, coreR,
        (a) => 1 + live * (v.inner * 0.8 * Math.sin(3 * a + phase * 2.1)), rot * 2);
      refs.current.outer?.setAttribute('d', outer);
      refs.current.mid?.setAttribute('d', mid);
      refs.current.core?.setAttribute('d', core);
      // Orbiting satellites (working).
      for (let i = 0; i < 3; i++) {
        const el = refs.current[`o${i}`];
        if (!el) continue;
        const a = orbitA * 1.6 + (i * TAU) / 3;
        const rr = R + 13 + 2 * Math.sin(t * 2 + i);
        el.setAttribute('cx', (c + rr * Math.cos(a)).toFixed(2));
        el.setAttribute('cy', (c + rr * Math.sin(a)).toFixed(2));
        el.setAttribute('opacity', (v.orbit * (0.55 + 0.45 * Math.sin(t * 3 + i * 2))).toFixed(3));
        el.setAttribute('r', (2.4 + v.orbit * 1.2).toFixed(2));
      }
      // Soft pulse ring (needs you) and completion ring.
      const pr = refs.current.pulse;
      if (pr) {
        const cyc = (t % 2.4) / 2.4;
        const pulse = v.pulse * (1 - cyc);
        const done = flashRef.current;
        pr.setAttribute('r', (R + 6 + (v.pulse > 0.05 ? cyc * 22 : (1 - done) * 26)).toFixed(2));
        pr.setAttribute('opacity', Math.max(pulse * 0.55, done * 0.6).toFixed(3));
      }
      return true;
    });
  }, []);

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" className="aperture" role="img" aria-label={`AUDA — ${state.replace('_', ' ')}`}>
      <defs>
        <radialGradient id={`sock${uid}`} cx="50%" cy="45%" r="55%">
          <stop offset="0.72" stopColor="var(--well-deep)" />
          <stop offset="1" stopColor="var(--well)" />
        </radialGradient>
        <radialGradient id={`lens${uid}`} cx="36%" cy="30%" r="80%">
          <stop offset="0" stopColor="var(--glyph-a)" />
          <stop offset="0.55" stopColor="var(--glyph-b)" />
          <stop offset="1" stopColor="var(--glyph-c)" />
        </radialGradient>
        <radialGradient id={`mid${uid}`} cx="40%" cy="35%" r="75%">
          <stop offset="0" stopColor="var(--glyph-b)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--glyph-c)" stopOpacity="0.95" />
        </radialGradient>
        <radialGradient id={`core${uid}`} cx="45%" cy="40%" r="70%">
          <stop offset="0" stopColor="var(--glyph-core)" stopOpacity="0.92" />
          <stop offset="1" stopColor="var(--glyph-core)" />
        </radialGradient>
        <linearGradient id={`spec${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={`soft${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" />
          <feOffset dy="3" />
          <feComponentTransfer><feFuncA type="linear" slope="0.35" /></feComponentTransfer>
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {/* recessed socket */}
      <circle cx="100" cy="100" r="96" fill={`url(#sock${uid})`} />
      <circle cx="100" cy="100" r="95.5" fill="none" stroke="var(--glyph-ring)" strokeWidth="1" />
      <circle ref={(e) => { refs.current.pulse = e; }} cx="100" cy="100" r="80" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0" />
      <g filter={`url(#soft${uid})`}>
        <path ref={(e) => { refs.current.outer = e; }} fill={`url(#lens${uid})`} />
        <path ref={(e) => { refs.current.mid = e; }} fill={`url(#mid${uid})`} opacity="0.78" />
        <path ref={(e) => { refs.current.core = e; }} fill={`url(#core${uid})`} />
      </g>
      {/* specular highlight: makes it read as a lens, not a flat blob */}
      <ellipse cx="80" cy="66" rx="30" ry="15" fill={`url(#spec${uid})`} transform="rotate(-28 80 66)" opacity="0.65" />
      {[0, 1, 2].map((i) => <circle key={i} ref={(e) => { refs.current[`o${i}`] = e; }} r="3" fill="var(--glyph-b)" opacity="0" />)}
    </svg>
  );
}

/** A still glyph for places where many appear at once (chat history). */
export function GlyphStill({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <defs>
        <radialGradient id="gs-lens" cx="36%" cy="30%" r="80%"><stop offset="0" stopColor="var(--glyph-a)" /><stop offset="0.55" stopColor="var(--glyph-b)" /><stop offset="1" stopColor="var(--glyph-c)" /></radialGradient>
      </defs>
      <circle cx="100" cy="100" r="96" fill="var(--well)" />
      <circle cx="100" cy="100" r="58" fill="url(#gs-lens)" />
      <circle cx="100" cy="100" r="22" fill="var(--glyph-core)" />
      <ellipse cx="82" cy="70" rx="22" ry="10" fill="#fff" opacity="0.35" transform="rotate(-28 82 70)" />
    </svg>
  );
}
