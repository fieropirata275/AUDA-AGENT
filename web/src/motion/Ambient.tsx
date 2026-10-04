/**
 * Ambient light: a slow aurora behind everything, driven by AUDA's state.
 * Idle is almost still; work warms and quickens it (more agents, more
 * energy); needing you breathes amber; trouble cools it. Rendered at a tiny
 * resolution (soft by nature), capped at ~30 fps, paused when the tab is
 * hidden, and frozen under reduced motion.
 */
import { useEffect, useRef } from 'react';
import { Spring, onTick, springs, prefersReducedMotion } from './spring';

const MOOD: Record<string, { energy: number; hue: 'accent' | 'attention' | 'problem' | 'settled' | 'calm' }> = {
  idle: { energy: 0.15, hue: 'calm' }, available: { energy: 0.3, hue: 'calm' }, listening: { energy: 0.5, hue: 'accent' },
  thinking: { energy: 0.7, hue: 'accent' }, working: { energy: 0.8, hue: 'accent' }, coding: { energy: 0.8, hue: 'accent' }, browsing: { energy: 0.75, hue: 'accent' },
  waiting: { energy: 0.2, hue: 'calm' }, scheduled: { energy: 0.2, hue: 'calm' }, watching: { energy: 0.35, hue: 'settled' },
  needs_you: { energy: 0.55, hue: 'attention' }, blocked: { energy: 0.3, hue: 'problem' }, recovering: { energy: 0.6, hue: 'problem' }, problem: { energy: 0.3, hue: 'problem' },
  completed: { energy: 0.6, hue: 'settled' },
};

function rgb(v: string): [number, number, number] {
  const s = v.trim();
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).split('').map((x) => x + x).join('') : s.slice(1, 7);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = s.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [200, 120, 80];
}

export function Ambient({ presence, load }: { presence: string; load: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef({ presence, load });
  target.current = { presence, load };

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d', { alpha: true });
    if (!ctx) return;
    const reduced = prefersReducedMotion();
    const energy = new Spring(0.3, springs.drift);
    const mix = { r: new Spring(0, springs.drift), g: new Spring(0, springs.drift), b: new Spring(0, springs.drift) };
    let palette: Record<string, [number, number, number]> = {};
    let dark = false;
    const readPalette = () => {
      const st = getComputedStyle(document.documentElement);
      const theme = document.documentElement.getAttribute('data-theme');
      dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      palette = { accent: rgb(st.getPropertyValue('--accent')), accent2: rgb(st.getPropertyValue('--accent-2')), attention: rgb(st.getPropertyValue('--attention')), problem: rgb(st.getPropertyValue('--problem')), settled: rgb(st.getPropertyValue('--settled')), calm: rgb(st.getPropertyValue('--ink-4')) };
    };
    readPalette();
    const themeObs = new MutationObserver(readPalette);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', readPalette);

    const resize = () => { cv.width = Math.max(48, Math.round(innerWidth / 10)); cv.height = Math.max(32, Math.round(innerHeight / 10)); };
    resize();
    addEventListener('resize', resize);

    const blobs = [
      { x: 0.18, y: 0.12, r: 0.55, sx: 0.07, sy: 0.05, p: 0, key: 'mood' },
      { x: 0.85, y: 0.2, r: 0.45, sx: 0.05, sy: 0.08, p: 2.1, key: 'accent2' },
      { x: 0.6, y: 0.9, r: 0.6, sx: 0.06, sy: 0.04, p: 4.2, key: 'mood' },
      { x: 0.05, y: 0.8, r: 0.4, sx: 0.08, sy: 0.06, p: 1.3, key: 'settled' },
    ];
    let acc = 0, phase = 0;
    const draw = (t: number) => {
      const w = cv.width, h = cv.height;
      ctx.clearRect(0, 0, w, h);
      const e = energy.value;
      const mood: [number, number, number] = [mix.r.value, mix.g.value, mix.b.value];
      for (const b of blobs) {
        const col = b.key === 'mood' ? mood : palette[b.key] ?? mood;
        const x = (b.x + Math.sin(phase * b.sx * 6 + b.p) * 0.12) * w;
        const y = (b.y + Math.cos(phase * b.sy * 6 + b.p) * 0.1) * h;
        const r = b.r * Math.max(w, h) * (0.85 + e * 0.35 + Math.sin(t * 0.6 + b.p) * 0.04 * e);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const a = dark ? 0.05 + e * 0.13 : 0.035 + e * 0.09; // light stays subtle so text keeps its contrast
        g.addColorStop(0, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a})`);
        g.addColorStop(1, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    };
    const apply = () => {
      const m = MOOD[target.current.presence] ?? MOOD.available;
      energy.set(Math.min(1, m.energy + Math.min(0.25, target.current.load * 0.06)));
      const c = palette[m.hue] ?? palette.accent;
      mix.r.set(c[0]); mix.g.set(c[1]); mix.b.set(c[2]);
    };
    apply();
    const c0 = palette[(MOOD[presence] ?? MOOD.available).hue];
    mix.r.jump(c0[0]); mix.g.jump(c0[1]); mix.b.jump(c0[2]);
    if (reduced) { energy.jump(energy.target); draw(0); }
    const stop = reduced ? () => {} : onTick((dt, t) => {
      if (document.hidden) return;
      apply();
      energy.step(dt); mix.r.step(dt); mix.g.step(dt); mix.b.step(dt);
      phase += dt * (0.15 + energy.value * 0.9);
      acc += dt;
      if (acc < 1 / 30) return;
      acc = 0;
      draw(t);
    });
    return () => { stop(); removeEventListener('resize', resize); themeObs.disconnect(); mq.removeEventListener?.('change', readPalette); };
  }, []);

  return <canvas ref={canvas} className="ambient" aria-hidden="true" />;
}
