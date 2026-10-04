import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, onEntityChange } from './lib/store';
import { useRoute, navigate } from './lib/router';
import { post } from './lib/api';
import { fm } from './motion/spring';
import { Morph } from './motion/Morph';
import { Aperture } from './motion/Aperture';
import { PRESENCE_LABEL } from './components/glyphs';
import { Sheets } from './components/Sheets';
import { openSheet } from './components/ui';
import { sound, setSoundEnabled } from './lib/sound';
import { ago } from './lib/time';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Work } from './pages/Work';
import { Computer } from './pages/Computer';
import { Memory } from './pages/Memory';
import { Connections } from './pages/Connections';
import { Activity } from './pages/Activity';
import { Settings } from './pages/Settings';
import { Spaces } from './pages/Spaces';
import { Team } from './pages/Team';
import { Agents } from './pages/Agents';
import { Plugins } from './pages/Plugins';
import { Org } from './pages/Org';
import type { Notification } from './lib/types';
import { Ambient } from './motion/Ambient';
import { Pulse } from './motion/Live';
import { CommandPalette, openPalette } from './components/CommandPalette';

const NAV = [
  { to: '/', label: 'Home', icon: 'dots' },
  { to: '/chat', label: 'Chat', icon: 'wave' },
  { to: '/work', label: 'Work', icon: 'orbit' },
  { to: '/team', label: 'Team', icon: 'flow' },
  { to: '/agents', label: 'Agents', icon: 'progress' },
  { to: '/computer', label: 'Computer', icon: 'play' },
  { to: '/memory', label: 'Memory', icon: 'eye' },
  { to: '/plugins', label: 'Plugins', icon: 'unplugged' },
  { to: '/connections', label: 'Connections', icon: 'linked' },
  { to: '/activity', label: 'Activity', icon: 'clock' },
];

function Inbox({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const items = Object.values(s.notifications).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  useEffect(() => { void post('/api/notifications/read'); }, []);
  return (
    <motion.div className="inbox" initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={fm.settle}>
      {items.map((n) => (
        <button key={n.id} className={`inbox-item l-${n.level}`} onClick={() => { onClose(); if (n.subjectType === 'task') openSheet({ type: 'task', id: n.subjectId! }); else if (n.subjectType === 'approval') navigate('/work?view=needs'); }}>
          <span className="inbox-dot" />
          <div className="grow"><div className="inbox-title">{n.title}</div>{n.body && <div className="small faint" style={{ whiteSpace: 'pre-line' }}>{n.body.slice(0, 180)}</div>}<div className="small faint">{ago(n.createdAt)}{n.suppressedReason ? ` · kept quiet (${n.suppressedReason})` : !n.delivered ? ' · inbox only' : ''}</div></div>
        </button>
      ))}
      {!items.length && <div className="faint small" style={{ padding: 16 }}>Nothing yet. AUDA keeps interruptions to a minimum.</div>}
    </motion.div>
  );
}

function Toasts() {
  const [toasts, setToasts] = useState<Notification[]>([]);
  useEffect(() => onEntityChange(({ entity, data, prev }) => {
    if (entity !== 'notification' || prev || !data?.delivered) return;
    if (['approval', 'attention', 'blocked', 'urgent'].includes(data.level)) sound.attention(); else sound.complete();
    setToasts((t) => [...t.slice(-2), data]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== data.id)), 7000);
  }), []);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((n) => (
          <motion.div key={n.id} className={`toast l-${n.level}`} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 30 }} transition={fm.glide}
            onClick={() => { setToasts((t) => t.filter((x) => x.id !== n.id)); if (n.subjectType === 'pairing') navigate('/connections'); else if (n.level === 'approval') navigate('/work?view=needs'); else if (n.subjectType === 'task') openSheet({ type: 'task', id: n.subjectId! }); }}>
            <Morph shape={n.level === 'approval' || n.level === 'attention' ? 'attention' : n.level === 'blocked' ? 'blocked' : 'check'} size={20} color={n.level === 'completed' || n.level === 'fyi' ? 'var(--settled)' : 'var(--attention)'} />
            <div className="grow"><div style={{ fontWeight: 600 }}>{n.title}</div>{n.body && <div className="small muted">{n.body.slice(0, 140)}</div>}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function App() {
  const s = useStore();
  const { path, parts } = useRoute();
  const [inbox, setInbox] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => { if (s.settings) setSoundEnabled(s.settings.sound); }, [s.settings?.sound]);
  const id = s.identity!;
  const needs = Object.values(s.approvals).filter((a) => a.state === 'pending').length + Object.values(s.rules).filter((r) => r.state === 'draft').length;
  const working = Object.values(s.tasks).filter((t) => t.state === 'RUNNING').length;
  const unread = Object.values(s.notifications).filter((n) => !n.readAt).length;
  const section = '/' + (parts[0] ?? '');
  const page = { '/': <Home />, '/chat': <Chat />, '/work': <Work />, '/computer': <Computer />, '/memory': <Memory />, '/connections': <Connections />, '/activity': <Activity />, '/settings': <Settings />, '/spaces': <Spaces />, '/team': <Team />, '/agents': <Agents />, '/plugins': <Plugins />, '/org': <Org />, '/join': <Org /> }[section] ?? <Home />;

  return (
    <div className="shell">
      <Ambient presence={id.presence} load={working} />
      <nav className="rail" aria-label="Main">
        <button className="rail-id" onClick={() => navigate('/')}>
          <Aperture state={id.presence} size={40} />
          <div><div className="name">AUDA</div><div className="state">{PRESENCE_LABEL[id.presence]}</div></div>
        </button>
        {NAV.map((n) => (
          <button key={n.to} className="nav-item" aria-current={section === n.to ? 'page' : undefined} onClick={() => navigate(n.to)}>
            {section === n.to && <motion.span layoutId="nav-pill" className="pill" transition={fm.settle} />}
            <Morph shape={n.icon} size={18} animate={section === n.to} color={section === n.to ? 'var(--accent)' : 'currentColor'} />
            <span>{n.label}</span>
            {n.to === '/work' && needs > 0 && <span className="count">{needs}</span>}
            {n.to === '/work' && !needs && working > 0 && <span className="count soft">{working}</span>}
          </button>
        ))}
        <div className="nav-sep" />
        <div className="nav-section">Spaces</div>
        {Object.values(s.spaces).map((sp) => (
          <button key={sp.id} className="nav-item" aria-current={path === `/spaces/${sp.id}` ? 'page' : undefined} onClick={() => navigate(`/spaces/${sp.id}`)}>
            {path === `/spaces/${sp.id}` && <motion.span layoutId="nav-pill" className="pill" transition={fm.settle} />}
            <span className="space-dot" />{sp.name}
          </button>
        ))}
        <div className="rail-foot">
          {s.me && (
            <button className="nav-item" aria-current={section === '/org' ? 'page' : undefined} onClick={() => navigate('/org')}>
              {section === '/org' && <motion.span layoutId="nav-pill" className="pill" transition={fm.settle} />}
              <span className="avatar xs">{s.me.name.slice(0, 1).toUpperCase()}</span><span className="ellipsis">{s.org.enabled ? s.me.name : 'Organization'}</span>
            </button>
          )}
          <button className="nav-item" aria-current={section === '/settings' ? 'page' : undefined} onClick={() => navigate('/settings')}>
            {section === '/settings' && <motion.span layoutId="nav-pill" className="pill" transition={fm.settle} />}
            <Morph shape="sun" size={18} animate={false} /><span>Settings</span>
          </button>
          <div className="rail-spend small faint">{s.settings && s.settings.spend.month > 0 ? `Models: $${s.settings.spend.today.toFixed(2)} today` : s.connected ? 'Connected' : 'Reconnecting…'}</div>
        </div>
      </nav>

      <main className="main">
        <Pulse running={working} waiting={needs} />
        <div className="topbar">
          <button className="cmdk" onClick={() => openPalette()} aria-label="Search or run a command (Ctrl+K)">
            <Morph shape="eye" size={15} animate={false} color="var(--ink-3)" /><span>Search, jump, or ask…</span><kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd>
          </button>
          <div style={{ position: 'relative' }}>
            <button className="btn ghost icon" aria-label="Notifications" onClick={() => setInbox(!inbox)}>
              <Morph shape={unread ? 'bellRing' : 'bell'} size={20} color={unread ? 'var(--accent)' : 'var(--ink-3)'} />
            </button>
            {unread > 0 && <span className="bell-n">{unread}</span>}
            <AnimatePresence>{inbox && <Inbox onClose={() => setInbox(false)} />}</AnimatePresence>
          </div>
        </div>
        {s.safeMode && (
          <div className="safe-banner">
            <Morph shape="blocked" size={20} color="var(--problem)" animate={false} />
            <span className="grow"><b>Safe mode.</b> AUDA crashed repeatedly, so it isn’t running tasks, watchers or schedules. Check Activity for what went wrong, then resume.</span>
            <button className="btn sm" onClick={() => navigate('/settings?tab=reliability')}>Details</button>
            <button className="btn primary sm" onClick={() => post('/api/system/leave-safe-mode').then(() => setTimeout(() => location.reload(), 4000))}>Resume normal operation</button>
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div key={section + (parts[1] ?? '')} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }} transition={fm.glide}>
            {page}
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="mobile-bar" aria-label="Main">
        {NAV.filter((n) => ['/', '/chat', '/work', '/team'].includes(n.to)).map((n) => (
          <button key={n.to} aria-current={section === n.to ? 'page' : undefined} onClick={() => navigate(n.to)}>
            {n.to === '/' ? <Aperture state={id.presence} size={22} /> : <Morph shape={n.icon} size={20} animate={section === n.to} color={section === n.to ? 'var(--accent)' : 'currentColor'} />}
            {n.label}
            {n.to === '/work' && needs > 0 && <span className="bell-n" style={{ top: 2, right: 4 }}>{needs}</span>}
          </button>
        ))}
        <button aria-current={['/memory', '/connections', '/activity', '/settings', '/spaces', '/agents', '/plugins', '/org'].includes(section) ? 'page' : undefined} onClick={() => setMore(!more)}>
          <Morph shape={more ? 'close' : 'dots'} size={20} animate={false} />More
        </button>
      </nav>
      <AnimatePresence>
        {more && (
          <motion.div className="more-menu mobile-only" initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.97 }} transition={fm.settle}>
            {[...NAV.filter((n) => !['/', '/chat', '/work', '/team'].includes(n.to)), { to: '/spaces', label: 'Spaces', icon: 'rest' }, { to: '/org', label: s.org.enabled ? s.org.name : 'Organization', icon: 'eye' }, { to: '/settings', label: 'Settings', icon: 'sun' }].map((n) => (
              <button key={n.to} onClick={() => { setMore(false); navigate(n.to); }}><Morph shape={n.icon} size={18} animate={false} />{n.label}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <Sheets />
      <Toasts />
      <CommandPalette />
    </div>
  );
}
