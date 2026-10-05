/**
 * "While you were away": coming back after a while, you get the story in a
 * few seconds — what got done, what needs you, what your agents learned,
 * what AUDA recovered from on its own, and what didn't work out. Story-style
 * cards advance on their own; tap, arrows or Esc to move or skip. Shown
 * once per absence.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { Aperture } from '../motion/Aperture';
import { Morph } from '../motion/Morph';
import { fm, prefersReducedMotion } from '../motion/spring';
import { openSheet } from './ui';

const AWAY_MS = 30 * 60_000;
const CARD_MS = 4200;

interface Card { key: string; shape: string; color: string; title: string; items: { id: string; text: string; sub?: string; open?: () => void }[] }

function since(ts: number) {
  const h = (Date.now() - ts) / 3600_000;
  return h < 1 ? `${Math.round(h * 60)} minutes` : h < 36 ? `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
}

export function Recap() {
  const s = useStore();
  const away = s.lastSeen && s.bootAt - s.lastSeen > AWAY_MS ? s.lastSeen : null;
  const seenKey = away ? `auda.recap.${away}` : '';
  const [open, setOpen] = useState(() => { try { return !!away && !sessionStorage.getItem(seenKey); } catch { return !!away; } });
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  const cards = useMemo<Card[]>(() => {
    if (!away) return [];
    const tasks = Object.values(s.tasks);
    const acts = Object.values(s.activity).filter((a) => a.ts > away && a.ts < s.bootAt + 5000);
    const done = tasks.filter((t) => t.state === 'COMPLETED' && !t.parentTaskId && (t.completedAt ?? 0) > away).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    const failed = tasks.filter((t) => t.state === 'FAILED' && !t.parentTaskId && (t.completedAt ?? 0) > away);
    const needs = Object.values(s.approvals).filter((a) => a.state === 'pending');
    const learned = acts.filter((a) => a.kind === 'memory');
    const recovered = acts.filter((a) => a.kind === 'recover');
    const out: Card[] = [];
    if (done.length) out.push({ key: 'done', shape: 'check', color: 'var(--settled)', title: `I finished ${done.length} thing${done.length > 1 ? 's' : ''}`, items: done.slice(0, 5).map((t) => ({ id: t.id, text: `${t.agent ? `${t.agent.emoji} ` : ''}${t.title}`, sub: t.result?.split('\n')[0]?.slice(0, 120), open: () => openSheet({ type: 'task', id: t.id }) })) });
    if (needs.length) out.push({ key: 'needs', shape: 'attention', color: 'var(--attention)', title: `${needs.length} thing${needs.length > 1 ? 's need' : ' needs'} your decision`, items: needs.slice(0, 4).map((a) => ({ id: a.id, text: a.title, sub: a.task?.title, open: () => navigate('/work?view=needs') })) });
    if (learned.length) out.push({ key: 'learned', shape: 'eye', color: 'var(--accent)', title: `Your agents learned ${learned.length} thing${learned.length > 1 ? 's' : ''}`, items: learned.slice(0, 4).map((a) => ({ id: a.id, text: a.title, sub: a.detail?.split('\n')[0]?.replace(/^• /, '') })) });
    if (recovered.length) out.push({ key: 'recovered', shape: 'recover', color: 'var(--accent)', title: `I recovered from ${recovered.length} problem${recovered.length > 1 ? 's' : ''} on my own`, items: recovered.slice(0, 4).map((a) => ({ id: a.id, text: a.title, sub: a.detail?.slice(0, 120) })) });
    if (failed.length) out.push({ key: 'failed', shape: 'problem', color: 'var(--problem)', title: `${failed.length} didn’t work out`, items: failed.slice(0, 3).map((t) => ({ id: t.id, text: t.title, sub: t.diagnosis?.slice(0, 140), open: () => openSheet({ type: 'task', id: t.id }) })) });
    return out;
  }, [away, s.ready]); // a snapshot of the moment you came back

  const show = open && cards.length >= 1 && (cards.length > 1 || cards[0].items.length > 1);
  const close = () => { setOpen(false); try { sessionStorage.setItem(seenKey, '1'); } catch { /* private mode */ } };
  const next = () => (i + 1 < cards.length ? setI(i + 1) : close());
  const prev = () => setI(Math.max(0, i - 1));

  useEffect(() => {
    if (!show) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); } else if (e.key === 'ArrowLeft') prev(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  useEffect(() => {
    if (!show || paused || prefersReducedMotion()) return;
    const t = setTimeout(next, CARD_MS + (cards[i]?.items.length ?? 0) * 250);
    return () => clearTimeout(t);
  }, [show, i, paused]);

  if (!show) return null;
  const c = cards[i];
  return (
    <motion.div className="recap" role="dialog" aria-modal="true" aria-label="While you were away" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="recap-backdrop" onClick={close} />
      <motion.div className="recap-card" initial={{ y: 24, scale: 0.96, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} transition={fm.expressive}
        onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
        <div className="recap-bars">
          {cards.map((x, k) => (
            <span key={x.key} className="recap-bar">
              <motion.span key={`${x.key}-${i}-${paused}`} initial={{ width: k < i ? '100%' : '0%' }} animate={{ width: k < i ? '100%' : k === i ? (paused ? undefined : '100%') : '0%' }}
                transition={k === i && !paused ? { duration: (CARD_MS + c.items.length * 250) / 1000, ease: 'linear' } : { duration: 0 }} />
            </span>
          ))}
        </div>
        <div className="recap-head">
          <Aperture state={c.key === 'needs' ? 'needs_you' : c.key === 'failed' ? 'blocked' : c.key === 'done' ? 'completed' : 'available'} size={64} />
          <div><div className="small faint">While you were away · {since(away!)}</div><div className="recap-kicker">{i + 1} of {cards.length}</div></div>
          <button className="btn ghost icon recap-x" aria-label="Close" onClick={close}><Morph shape="close" size={18} /></button>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={c.key} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={fm.glide}>
            <h2 className="recap-title"><Morph shape={c.shape} size={26} color={c.color} />{c.title}</h2>
            <div className="recap-items">
              {c.items.map((it, k) => (
                <motion.button key={it.id} className="recap-item" disabled={!it.open} onClick={() => { close(); it.open?.(); }}
                  initial={{ opacity: 0, y: 10, filter: 'blur(3px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ ...fm.glide, delay: 0.12 + k * 0.08 }}>
                  <span className="recap-dot" style={{ background: c.color }} />
                  <span className="grow"><span className="recap-text">{it.text}</span>{it.sub && <span className="small faint">{it.sub}</span>}</span>
                  {it.open && <Morph shape="chevronRight" size={14} color="var(--ink-4)" animate={false} />}
                </motion.button>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
        <div className="recap-foot">
          <button className="btn ghost sm" onClick={prev} disabled={i === 0}>Back</button>
          <span className="grow" />
          {cards.some((x) => x.key === 'needs') && <button className="btn sm" onClick={() => { close(); navigate('/work?view=needs'); }}>Review decisions</button>}
          <button className="btn primary sm" onClick={next}>{i + 1 < cards.length ? 'Next' : 'Got it'}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
