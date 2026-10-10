/**
 * Chat is a control surface. AUDA turns what you say into persistent state,
 * and those objects render inline — live — right in the conversation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, loadMessages } from '../lib/store';
import { post, patch, del } from '../lib/api';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { Aperture, GlyphStill } from '../motion/Aperture';
import { navigate, useRoute } from '../lib/router';
import { TaskCard } from '../components/TaskCard';
import { ResponsibilityCard } from '../components/ResponsibilityCard';
import { RuleCard } from '../components/RuleCard';
import { MemoryCard } from '../components/MemoryCard';
import { ApprovalCard } from '../components/ApprovalCard';
import { Markdown } from '../components/Markdown';
import { Attachment } from '../components/Attachment';
import { RunLive, RunDone, useRun } from '../components/ChatRun';
import { clock, ago } from '../lib/time';
import { sound } from '../lib/sound';
import type { Conversation, Message } from '../lib/types';

const SUGGESTIONS = [
  'When does the next iPhone come out?',
  'Test how fast example.com loads on desktop and mobile',
  'Make a 5-slide presentation about home network security',
  'Plot the population of the 10 largest EU countries with Python',
  'Write a Python script that pings a list of hosts and reports which are down',
  'Keep the server healthy',
  'Remember that I prefer short, direct updates',
];

function InlineObject({ o }: { o: { type: string; id: string } }) {
  const s = useStore();
  if (o.type === 'artifact') return <Attachment id={o.id} />;
  if (o.type === 'task' && s.tasks[o.id]) {
    const pending = Object.values(s.approvals).filter((a) => a.taskId === o.id && a.state === 'pending');
    return <div className="stack"><TaskCard task={s.tasks[o.id]} />{pending.map((a) => <ApprovalCard key={a.id} a={a} dense />)}</div>;
  }
  if (o.type === 'responsibility' && s.responsibilities[o.id]) return <ResponsibilityCard r={s.responsibilities[o.id]} />;
  if (o.type === 'rule' && s.rules[o.id]) return <RuleCard rule={s.rules[o.id]} />;
  if (o.type === 'memory' && s.memories[o.id]) return <MemoryCard m={s.memories[o.id]} />;
  if (o.type === 'connector') {
    const c = s.connectors[o.id];
    return <button className="connector-mini" onClick={() => navigate('/connections')}><Morph shape={c?.state === 'connected' ? 'linked' : 'unplugged'} size={20} /> <span>{c?.name ?? o.id}</span><span className="faint small">{c?.state === 'connected' ? 'Connected' : 'Connect in Connections'}</span></button>;
  }
  return null;
}

function Bubble({ m, live, onRetry }: { m: Message; live?: boolean; onRetry?: () => void }) {
  const auda = m.role === 'auda';
  const runId = m.objects.find((o) => o.type === 'run')?.id;
  const { running } = useRun(runId);
  const objects = m.objects.filter((o) => o.type !== 'run');
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return (
    <motion.div className={`msg ${auda ? 'auda' : 'user'}`} initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={fm.glide} layout="position">
      {auda && <div className="msg-avatar">{running ? <Aperture state="thinking" size={30} /> : live ? <Aperture state="available" size={30} /> : <GlyphStill size={30} />}</div>}
      <div className="msg-col">
        {runId && (running ? <RunLive taskId={runId} /> : <RunDone taskId={runId} />)}
        {m.content.trim() && (auda
          ? <div className="msg-bubble"><Markdown text={m.content} /></div>
          : <div className="msg-bubble">{m.content.split('\n').map((l, i) => <p key={i}>{l || ' '}</p>)}</div>)}
        {objects.length > 0 && <div className="msg-objects">{objects.map((o) => <InlineObject key={o.type + o.id} o={o} />)}</div>}
        {!running && (
          <div className="msg-time">
            {clock(m.createdAt)}{m.channel !== 'web' ? ` · via ${m.channel}` : ''}
            {auda && m.content.trim() && <button className="msg-act" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
            {auda && onRetry && <button className="msg-act" onClick={onRetry}>Retry</button>}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ConvItem({ c, on }: { c: Conversation; on: boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const save = async () => { setEditing(false); if (title.trim() && title.trim() !== c.title) await patch(`/api/conversations/${c.id}`, { title: title.trim() }); else setTitle(c.title); };
  const remove = async () => {
    setMenu(false);
    if (!confirm(`Delete “${c.title}”? This can’t be undone.`)) return;
    await del(`/api/conversations/${c.id}`);
    if (on) navigate('/chat?new=1');
  };
  useEffect(() => { if (!menu) return; const close = () => setMenu(false); setTimeout(() => addEventListener('click', close, { once: true })); return () => removeEventListener('click', close); }, [menu]);
  if (editing) {
    return (
      <div className="conv on">
        <input className="conv-edit" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { setTitle(c.title); setEditing(false); } }} aria-label="Conversation name" />
      </div>
    );
  }
  return (
    <div className={`conv ${on ? 'on' : ''}`}>
      <button className="conv-main" onClick={() => navigate(`/chat?c=${c.id}`)} onDoubleClick={() => setEditing(true)}>
        <span className="ellipsis">{c.pinned ? <span className="conv-pin" title="Pinned">●</span> : null}{c.title}</span><span className="small faint">{ago(c.updatedAt)}</span>
      </button>
      <button className="conv-more" aria-label="Conversation options" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>⋯</button>
      {menu && (
        <div className="conv-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenu(false); setEditing(true); }}>Rename</button>
          <button role="menuitem" onClick={() => { setMenu(false); void patch(`/api/conversations/${c.id}`, { pinned: !c.pinned }); }}>{c.pinned ? 'Unpin' : 'Pin to top'}</button>
          <button role="menuitem" className="danger" onClick={remove}>Delete</button>
        </div>
      )}
    </div>
  );
}

export function Composer({ conversationId, placeholder, compact, onSent }: { conversationId?: string; placeholder?: string; compact?: boolean; onSent?: (cid: string) => void }) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = async (t = text) => {
    if (!t.trim() || phase === 'sending') return;
    setPhase('sending'); sound.click();
    try {
      const r = await post<{ conversationId: string }>('/api/chat', { text: t, conversationId });
      setText(''); setPhase('sent');
      setTimeout(() => setPhase('idle'), 900);
      if (onSent) onSent(r.conversationId); else navigate(`/chat?c=${r.conversationId}`);
    } catch { setPhase('idle'); }
  };
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(180, el.scrollHeight) + 'px'; } }, [text]);
  return (
    <div className={`composer ${compact ? 'compact' : ''}`}>
      <textarea ref={ref} className="composer-input" rows={1} value={text} placeholder={placeholder ?? 'Tell AUDA what to handle…'} aria-label="Message AUDA"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
      <motion.button className="composer-send" onClick={() => send()} disabled={!text.trim() && phase === 'idle'} whileTap={{ scale: 0.92 }} transition={fm.snap} aria-label="Send">
        <Morph shape={phase === 'sending' ? 'wave' : phase === 'sent' ? 'check' : 'arrowUp'} size={20} color="currentColor" />
      </motion.button>
    </div>
  );
}

export function Chat() {
  const s = useStore();
  const { query } = useRoute();
  const [search, setSearch] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const convs = useMemo(() => Object.values(s.conversations).sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || b.updatedAt - a.updatedAt), [s.conversations]);
  const shown = search.trim() ? convs.filter((c) => c.title.toLowerCase().includes(search.trim().toLowerCase())) : convs;
  const cid = query.get('c') ?? (query.get('new') ? undefined : convs[0]?.id);
  const msgs = cid ? s.messages[cid] ?? [] : [];
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cid && !s.messages[cid]) void loadMessages(cid); }, [cid]); // eslint-disable-line
  const last = msgs[msgs.length - 1];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs.length, last?.content, last?.objects.length]);
  const thinking = msgs.length > 0 && last.role === 'user';
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const retry = lastUser && cid ? () => post('/api/chat', { text: lastUser.content, conversationId: cid }) : undefined;

  return (
    <div className={`chat ${listOpen ? 'list-open' : ''}`}>
      <aside className="chat-list" onClick={(e) => { if ((e.target as HTMLElement).closest('.conv-main, .btn')) setListOpen(false); }}>
        <button className="btn sm" onClick={() => navigate('/chat?new=1')}><Morph shape="plus" size={15} />New chat</button>
        {convs.length > 6 && <input className="conv-search" placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search chats" />}
        <div className="stack" style={{ gap: 2, marginTop: 10 }}>
          {shown.map((c) => <ConvItem key={c.id} c={c} on={c.id === cid} />)}
          {search && !shown.length && <p className="small faint" style={{ padding: '6px 12px' }}>No chats match.</p>}
        </div>
      </aside>
      <section className="chat-main">
        <div className="chat-top">
          <button className="btn sm ghost" onClick={() => setListOpen(!listOpen)}>{listOpen ? 'Close' : `Chats${convs.length ? ` (${convs.length})` : ''}`}</button>
          <span className="ellipsis grow small faint" style={{ textAlign: 'center' }}>{cid ? s.conversations[cid]?.title : 'New chat'}</span>
          <button className="btn sm ghost" onClick={() => navigate('/chat?new=1')}><Morph shape="plus" size={14} />New</button>
        </div>
        <div className="chat-scroll">
          {!msgs.length && (
            <div className="chat-empty">
              <Aperture state={s.identity?.presence ?? 'available'} size={120} />
              <h2 className="voice" style={{ fontSize: 30, fontWeight: 400, margin: '18px 0 6px' }}>What can I do for you?</h2>
              <p className="muted" style={{ marginTop: 0 }}>Ask anything, or have me do it: research the web, test a site, write and run Python, make a PDF, deck or spreadsheet. Ongoing things become responsibilities I keep after you close this.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((t) => <button key={t} className="chip btnlike" onClick={() => post('/api/chat', { text: t, conversationId: cid }).then((r: any) => navigate(`/chat?c=${r.conversationId}`))}>{t}</button>)}
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>{msgs.map((m, i) => <Bubble key={m.id} m={m} live={i === msgs.length - 1} onRetry={i === msgs.length - 1 && m.role === 'auda' ? retry : undefined} />)}</AnimatePresence>
          {thinking && <div className="msg auda"><div className="msg-avatar"><Aperture state="thinking" size={30} /></div><div className="run-live"><div className="run-now"><span className="run-spinner"><Morph shape="orbit" size={16} color="var(--accent)" /></span><span className="run-now-text">Reading your message…</span></div></div></div>}
          <div ref={endRef} />
        </div>
        <div className="chat-compose"><Composer conversationId={cid} placeholder="Message AUDA…" onSent={(id) => { if (id !== cid) navigate(`/chat?c=${id}`); }} /></div>
      </section>
    </div>
  );
}
