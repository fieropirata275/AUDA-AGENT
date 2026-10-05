/**
 * Home is not a dashboard. It is the room where AUDA lives:
 * its presence first, then what it's doing, watching, and what needs you.
 */
import { useMemo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useStore } from '../lib/store';
import { Constellation } from '../motion/Constellation';
import { Ticker, Spoken } from '../motion/Live';
import { useEffect, useState } from 'react';
import { fm } from '../motion/spring';
import { PRESENCE_LABEL, PresenceGlyph } from '../components/glyphs';
import { ApprovalCard } from '../components/ApprovalCard';
import { TaskCard } from '../components/TaskCard';
import { ResponsibilityCard } from '../components/ResponsibilityCard';
import { RuleCard } from '../components/RuleCard';
import { Empty } from '../components/controls';
import { greeting, ago } from '../lib/time';
import { navigate } from '../lib/router';
import { Composer } from './Chat';
import { openSheet } from '../components/ui';
import { LocalSetup } from '../components/LocalSetup';
import { Morph } from '../motion/Morph';
import { Button } from '../components/controls';

export function Home() {
  const s = useStore();
  const id = s.identity!;
  const orbit = useOrbitSize();
  const tasks = Object.values(s.tasks);
  const resps = Object.values(s.responsibilities).filter((r) => r.state !== 'ENDED');
  const approvals = Object.values(s.approvals).filter((a) => a.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const suggested = Object.values(s.rules).filter((r) => r.state === 'draft' && r.origin?.startsWith('suggested'));
  const working = tasks.filter((t) => !t.parentTaskId).filter((t) => ['RUNNING', 'READY', 'RETRYING', 'RECOVERING', 'WAITING_EXTERNAL', 'PAUSED'].includes(t.state) || (t.state === 'WAITING_USER' && t.attention !== 'approval')).sort((a, b) => b.updatedAt - a.updatedAt);
  const later = tasks.filter((t) => t.state === 'SCHEDULED').sort((a, b) => (a.nextEventAt ?? 0) - (b.nextEventAt ?? 0));
  const since = s.lastSeen ?? Date.now() - 12 * 3600_000;
  const finished = tasks.filter((t) => t.state === 'COMPLETED').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  const whileAway = s.lastSeen ? finished.filter((t) => (t.completedAt ?? 0) > since && (t.completedAt ?? 0) < s.bootAt) : [];
  const recent = (whileAway.length ? whileAway : finished).slice(0, 4);
  const flash = useMemo(() => Math.max(0, ...Object.values(s.justCompleted)), [s.justCompleted]);
  const glyphState = flash && Date.now() - flash < 1500 ? 'completed' : id.presence;
  const counts = [
    { k: 'Working on', n: working.length, to: '/work' },
    { k: 'Watching', n: resps.length, to: '/work?view=watching' },
    { k: 'Needs you', n: approvals.length + suggested.length, to: '/work?view=needs', hot: approvals.length > 0 },
    { k: 'Later', n: later.length + resps.reduce((n, r) => n + r.schedules.filter((x) => x.enabled).length, 0), to: '/work?view=scheduled' },
  ];

  const [firstRunHidden, setFirstRunHidden] = useState(() => { try { return localStorage.getItem('auda.firstRun.hidden') === '1'; } catch { return false; } });
  const hideFirstRun = () => { setFirstRunHidden(true); try { localStorage.setItem('auda.firstRun.hidden', '1'); } catch { /* private mode */ } };
  const mind = s.settings?.models;
  const ls = mind?.localSetup;
  const justConnected = !!ls?.firstRun && !ls.running && (ls.outcome === 'connected' || ls.outcome === 'text-only') && Date.now() - (ls.finishedAt ?? 0) < 90_000;
  const noModel = !!mind && !mind.anthropicConnected && !mind.local?.baseUrl;
  const needsMind = (noModel && (!firstRunHidden || !!ls?.running)) || (justConnected && !firstRunHidden);

  return (
    <div className="home">
      <section className="presence">
        <motion.div className="presence-glyph" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={fm.expressive}>
          <Constellation tasks={tasks} state={glyphState} flash={flash} size={orbit} reactive />
        </motion.div>
        <div className="presence-text">
          <div className="presence-state"><PresenceGlyph presence={id.presence} size={16} /><span>{PRESENCE_LABEL[id.presence]}</span>{!s.connected && <span className="chip problem">reconnecting…</span>}</div>
          <h1 className="display">{greeting()}{s.identity?.userName ? `, ${s.identity.userName}` : ''}.</h1>
          <Spoken text={`“${id.narration}”`} className="presence-narration voice" />
          {whileAway.length > 0 && <p className="muted" style={{ margin: '4px 0 0' }}>I finished {whileAway.length} thing{whileAway.length > 1 ? 's' : ''} while you were away.</p>}
          <div className="counts">
            {counts.map((c) => (
              <button key={c.k} className={`count-tile ${c.hot ? 'hot' : ''}`} onClick={() => navigate(c.to)}>
                <Ticker value={c.n} className="count-n tnum" />
                <span className="count-k">{c.k}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="home-compose"><Composer placeholder="Give AUDA something to handle, or ask what it's doing…" compact /></div>

      <AnimatePresence>{needsMind && <FirstRun key="first-run" done={justConnected} onHide={hideFirstRun} />}</AnimatePresence>

      <LayoutGroup>
        <AnimatePresence>
          {(approvals.length > 0 || suggested.length > 0) && (
            <motion.section className="section needs" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.glide}>
              <div className="section-head"><h2>{approvals.length + suggested.length === 1 ? 'One thing needs you' : `${approvals.length + suggested.length} things need you`}</h2></div>
              <div className="stack" style={{ gap: 14 }}>
                <AnimatePresence>{approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}</AnimatePresence>
                {suggested.map((r) => <RuleCard key={r.id} rule={r} />)}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <div className="home-cols">
          <section className="section">
            <div className="section-head"><h2>Working on</h2><span className="n">{working.length}</span></div>
            <div className="stack">
              <AnimatePresence>{working.map((t) => <TaskCard key={t.id} task={t} />)}</AnimatePresence>
              {!working.length && <Empty title="Nothing in motion">AUDA is between tasks. Watchers keep running.</Empty>}
            </div>
            {later.length > 0 && <>
              <div className="section-head" style={{ marginTop: 24 }}><h2>Later</h2><span className="n">{later.length}</span></div>
              <div className="stack">{later.slice(0, 4).map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
            </>}
          </section>
          <section className="section">
            <div className="section-head"><h2>Watching</h2><span className="n">{resps.length}</span></div>
            <div className="stack">
              {resps.slice(0, 5).map((r) => <ResponsibilityCard key={r.id} r={r} />)}
              {!resps.length && <Empty title="Not responsible for anything yet">Try “Keep the server healthy” or “Keep an eye on a page for me.”</Empty>}
            </div>
          </section>
        </div>

        {recent.length > 0 && (
          <section className="section">
            <div className="section-head"><h2>{whileAway.length ? 'While you were away' : 'Recently finished'}</h2><span className="grow" /><button className="btn ghost sm" onClick={() => navigate('/work?view=completed')}>All</button></div>
            <div className="finished">
              {recent.map((t) => (
                <motion.button key={t.id} layoutId={`task-${t.id}`} className="finished-item" onClick={() => openSheet({ type: 'task', id: t.id })} transition={fm.glide}>
                  <span className="check-dot" />
                  <span className="grow"><span className="finished-title">{t.title}</span><span className="finished-res">{t.result}</span></span>
                  <span className="small faint">{ago(t.completedAt)}</span>
                </motion.button>
              ))}
            </div>
          </section>
        )}
      </LayoutGroup>
    </div>
  );
}

/** The constellation's size follows the viewport so it never crowds the text. */
function useOrbitSize() {
  const pick = () => (innerWidth < 640 ? 260 : innerWidth < 1100 ? 320 : 360);
  const [n, setN] = useState(pick);
  useEffect(() => { const f = () => setN(pick()); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return n;
}

/** First run: AUDA works without a model, but open-ended work needs one — local (guided) or Claude. */
function FirstRun({ done, onHide }: { done: boolean; onHide: () => void }) {
  useEffect(() => { if (!done) return; const t = setTimeout(onHide, 45_000); return () => clearTimeout(t); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.section className="section" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0 }} transition={fm.glide}>
      <div className="card lift lsu-first">
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <div className="conn-plug"><Morph shape="wave" size={24} color="var(--accent)" /></div>
          <div className="grow">
            <h2 className="title" style={{ fontSize: 18 }}>{done ? 'AUDA has a mind of its own now' : 'Give AUDA a mind'}</h2>
            <p className="small muted" style={{ margin: '3px 0 0' }}>{done ? 'It runs on your hardware: ask for research, a report, a deck or some code, and it works on it by itself.' : <>AUDA already watches, checks and reminds on its own. For open-ended work — research, documents, decks, code — it needs a model. Run one on your own hardware (private and free), or connect Claude.</>}</p>
          </div>
          <button className="btn ghost sm icon" aria-label="Not now" title="Not now" onClick={onHide}><Morph shape="close" size={14} /></button>
        </div>
        <div className={`lsu-first-grid ${done ? 'one' : ''}`}>
          <div className="lsu-first-pane"><div className="lsu-eyebrow">On your computer · LM Studio</div><LocalSetup compact /></div>
          {!done && <div className="lsu-first-pane alt">
            <div className="lsu-eyebrow">In the cloud · Claude</div>
            <p className="small muted" style={{ margin: '0 0 10px' }}>The most capable option for long, open-ended work. Bring an Anthropic API key.</p>
            <Button size="sm" icon="arrowRight" onClick={() => navigate('/connections')}>Connect Claude</Button>
          </div>}
        </div>
      </div>
    </motion.section>
  );
}
