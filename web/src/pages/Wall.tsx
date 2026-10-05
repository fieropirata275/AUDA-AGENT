/**
 * Wall mode: AUDA on a monitor across the room. Everything here is legible
 * at a distance and live — the constellation of work, what needs a person,
 * what's running, what's being watched, the health of every connection, and
 * a stream of what just happened. The cursor hides when idle; F toggles
 * fullscreen; Esc goes back.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { Constellation } from '../motion/Constellation';
import { Spoken, Ticker } from '../motion/Live';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { PRESENCE_LABEL, TaskGlyph, TASK_LABEL } from '../components/glyphs';
import { Sparkline } from '../components/Sparkline';
import { openSheet } from '../components/ui';
import { ago } from '../lib/time';

const ACTIVE = ['RUNNING', 'READY', 'RETRYING', 'RECOVERING', 'WAITING_EXTERNAL', 'PAUSED', 'WAITING_USER'];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}
function useOrbit() {
  const pick = () => Math.max(300, Math.min(innerHeight * 0.62, innerWidth * 0.42, 640));
  const [n, setN] = useState(pick);
  useEffect(() => { const f = () => setN(pick()); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return Math.round(n);
}

export function Wall() {
  const s = useStore();
  const now = useClock();
  const orbit = useOrbit();
  const [idle, setIdle] = useState(false);
  const id = s.identity!;
  const tasks = Object.values(s.tasks);
  const working = tasks.filter((t) => ACTIVE.includes(t.state) && !t.parentTaskId).sort((a, b) => b.updatedAt - a.updatedAt);
  const approvals = Object.values(s.approvals).filter((a) => a.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const resps = Object.values(s.responsibilities).filter((r) => r.state !== 'ENDED');
  const connectors = Object.values(s.connectors);
  const feed = useMemo(() => Object.values(s.activity).sort((a, b) => b.ts - a.ts).slice(0, 14), [s.activity]);
  const flash = useMemo(() => Math.max(0, ...Object.values(s.justCompleted)), [s.justCompleted]);
  const doneToday = tasks.filter((t) => t.state === 'COMPLETED' && (t.completedAt ?? 0) > new Date().setHours(0, 0, 0, 0)).length;

  // Hide the cursor and chrome when nobody is touching the screen.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) navigate('/');
      if (e.key.toLowerCase() === 'f' && !(e.target as HTMLElement)?.closest?.('input,textarea')) { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }
      wake();
    };
    wake();
    addEventListener('pointermove', wake); addEventListener('keydown', key);
    return () => { clearTimeout(t); removeEventListener('pointermove', wake); removeEventListener('keydown', key); };
  }, []);

  return (
    <div className={`wall ${idle ? 'idle' : ''}`}>
      <header className="wall-head">
        <div className="wall-brand"><span className="wall-dot" data-state={id.presence} />{s.instance?.name && /auda/i.test(s.instance.name) ? s.instance.name : `AUDA · ${s.instance?.name ?? 'operator'}`}<span className="faint"> — {PRESENCE_LABEL[id.presence]}</span></div>
        <div className="wall-clock"><span className="tnum">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="wall-sec tnum">{String(now.getSeconds()).padStart(2, '0')}</span><div className="wall-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
        <div className="wall-ctl">
          <button className="btn ghost sm" onClick={() => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.()}><Morph shape="arrowUp" size={14} animate={false} /> Fullscreen <kbd>F</kbd></button>
          <button className="btn ghost sm" onClick={() => navigate('/')}>Exit <kbd>Esc</kbd></button>
        </div>
      </header>

      <main className="wall-grid">
        <section className="wall-hero">
          <Constellation tasks={tasks} state={flash && Date.now() - flash < 1500 ? 'completed' : id.presence} flash={flash} size={orbit} reactive />
          <Spoken text={`“${id.narration}”`} className="wall-narration voice" />
          <div className="wall-kpis">
            <div><Ticker value={working.length} className="tnum" /><span>working</span></div>
            <div className={approvals.length ? 'hot' : ''}><Ticker value={approvals.length} className="tnum" /><span>need a person</span></div>
            <div><Ticker value={resps.length} className="tnum" /><span>watching</span></div>
            <div><Ticker value={doneToday} className="tnum" /><span>done today</span></div>
          </div>
        </section>

        <section className="wall-col">
          <AnimatePresence>
            {approvals.length > 0 && (
              <motion.div className="wall-panel needs" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.glide}>
                <h2><Morph shape="attention" size={18} color="var(--attention)" /> Needs a person <span className="n">{approvals.length}</span></h2>
                {approvals.slice(0, 4).map((a) => (
                  <motion.button layout key={a.id} className="wall-row" onClick={() => navigate('/work?view=needs')} transition={fm.glide}>
                    <span className="grow"><b>{a.title}</b><span className="faint">{a.task?.title} · waiting {ago(a.createdAt).replace(' ago', '')}</span></span>
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          <div className="wall-panel">
            <h2><Morph shape="orbit" size={18} color="var(--accent)" /> Working <span className="n">{working.length}</span></h2>
            <AnimatePresence initial={false}>
              {working.slice(0, 6).map((t) => (
                <motion.button layout key={t.id} className="wall-row" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={fm.glide} onClick={() => openSheet({ type: 'task', id: t.id })}>
                  <TaskGlyph state={t.state} attention={t.attention} size={18} />
                  <span className="grow"><b>{t.agent ? `${t.agent.emoji} ` : ''}{t.title}</b><span className="faint">{t.nowLine ?? TASK_LABEL[t.state]}</span></span>
                  {t.plan.length > 0 && <span className="wall-progress"><motion.span animate={{ width: `${(t.plan.filter((p) => p.status === 'done').length / t.plan.length) * 100}%` }} transition={fm.settle} /></span>}
                </motion.button>
              ))}
            </AnimatePresence>
            {!working.length && <div className="faint wall-empty">Nothing running. Watchers stay on.</div>}
          </div>
          {resps.length > 0 && (
            <div className="wall-panel">
              <h2><Morph shape="eye" size={18} color="var(--settled)" /> Watching <span className="n">{resps.length}</span></h2>
              {resps.slice(0, 5).map((r) => {
                const w = r.watchers.find((x) => x.history?.length);
                return (
                  <div key={r.id} className="wall-row static">
                    <span className={`led ${r.state === 'NEEDS_USER' ? 'warn' : r.state === 'HANDLING' ? 'busy' : 'ok'}`} />
                    <span className="grow"><b>{r.title}</b><span className="faint">{r.statusLine}</span></span>
                    {w?.history && <Sparkline points={w.history} width={110} height={26} />}
                  </div>
                );
              })}
            </div>
          )}
          <div className="wall-panel systems">
            <h2><Morph shape="linked" size={18} color="var(--ink-3)" /> Systems</h2>
            <div className="wall-systems">
              {connectors.map((c) => <span key={c.id} className={`sys ${c.state}`} title={c.error ?? c.detail ?? c.state}><span className={`led ${c.state === 'connected' ? 'ok' : c.state === 'degraded' || c.state === 'error' ? 'bad' : 'off'}`} />{c.name}</span>)}
            </div>
          </div>
        </section>
      </main>

      <footer className="wall-feed" aria-label="Recent activity">
        <div className="wall-feed-track">
          {[...feed, ...feed].map((a, i) => (
            <span key={`${a.id}-${i}`} className={`feed-item k-${a.kind}`}><span className="tnum faint">{new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> {a.title}</span>
          ))}
        </div>
      </footer>
    </div>
  );
}
