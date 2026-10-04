/**
 * Home is not a dashboard. It is the room where AUDA lives:
 * its presence first, then what it's doing, watching, and what needs you.
 */
import { useMemo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useStore } from '../lib/store';
import { Aperture } from '../motion/Aperture';
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

export function Home() {
  const s = useStore();
  const id = s.identity!;
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

  return (
    <div className="home">
      <section className="presence">
        <motion.div className="presence-glyph" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={fm.expressive}>
          <Aperture state={glyphState} size={232} flash={flash} />
        </motion.div>
        <div className="presence-text">
          <div className="presence-state"><PresenceGlyph presence={id.presence} size={16} /><span>{PRESENCE_LABEL[id.presence]}</span>{!s.connected && <span className="chip problem">reconnecting…</span>}</div>
          <h1 className="display">{greeting()}{s.identity?.userName ? `, ${s.identity.userName}` : ''}.</h1>
          <AnimatePresence mode="wait">
            <motion.p key={id.narration} className="presence-narration voice" initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -4 }} transition={fm.glide}>
              “{id.narration}”
            </motion.p>
          </AnimatePresence>
          {whileAway.length > 0 && <p className="muted" style={{ margin: '4px 0 0' }}>I finished {whileAway.length} thing{whileAway.length > 1 ? 's' : ''} while you were away.</p>}
          <div className="counts">
            {counts.map((c) => (
              <button key={c.k} className={`count-tile ${c.hot ? 'hot' : ''}`} onClick={() => navigate(c.to)}>
                <motion.span key={c.n} className="count-n tnum" initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={fm.settle}>{c.n}</motion.span>
                <span className="count-k">{c.k}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="home-compose"><Composer placeholder="Give AUDA something to handle, or ask what it's doing…" compact /></div>

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
