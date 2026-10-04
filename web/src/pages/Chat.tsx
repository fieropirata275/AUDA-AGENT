/**
 * Chat is a control surface. AUDA turns what you say into persistent state,
 * and those objects render inline — live — right in the conversation.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, loadMessages } from '../lib/store';
import { post } from '../lib/api';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { Aperture, GlyphStill } from '../motion/Aperture';
import { navigate, useRoute } from '../lib/router';
import { TaskCard } from '../components/TaskCard';
import { ResponsibilityCard } from '../components/ResponsibilityCard';
import { RuleCard } from '../components/RuleCard';
import { MemoryCard } from '../components/MemoryCard';
import { ApprovalCard } from '../components/ApprovalCard';
import { clock, ago } from '../lib/time';
import { sound } from '../lib/sound';
import type { Message } from '../lib/types';

const SUGGESTIONS = [
  'Keep the server healthy',
  'Keep an eye on http://localhost:4610/demo/supplier every minute',
  'Every Monday morning, summarise what you did last week',
  'Never spend money',
  "Don't wake me for low-priority completed jobs",
  'Remember that I prefer short, direct updates',
];

function InlineObject({ o }: { o: { type: string; id: string } }) {
  const s = useStore();
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

function Bubble({ m, live }: { m: Message; live?: boolean }) {
  const auda = m.role === 'auda';
  return (
    <motion.div className={`msg ${auda ? 'auda' : 'user'}`} initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={fm.glide} layout="position">
      {auda && <div className="msg-avatar">{live ? <Aperture state="available" size={30} /> : <GlyphStill size={30} />}</div>}
      <div className="msg-col">
        <div className="msg-bubble">{m.content.split('\n').map((l, i) => <p key={i}>{l || ' '}</p>)}</div>
        {m.objects.length > 0 && <div className="msg-objects">{m.objects.map((o) => <InlineObject key={o.type + o.id} o={o} />)}</div>}
        <div className="msg-time">{clock(m.createdAt)}{m.channel !== 'web' ? ` · via ${m.channel}` : ''}</div>
      </div>
    </motion.div>
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
  const convs = Object.values(s.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  const cid = query.get('c') ?? (query.get('new') ? undefined : convs[0]?.id);
  const msgs = cid ? s.messages[cid] ?? [] : [];
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cid && !s.messages[cid]) void loadMessages(cid); }, [cid]); // eslint-disable-line
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs.length]);
  const thinking = msgs.length > 0 && msgs[msgs.length - 1].role === 'user';

  return (
    <div className="chat">
      <aside className="chat-list">
        <button className="btn sm" onClick={() => navigate('/chat?new=1')}><Morph shape="plus" size={15} />New conversation</button>
        <div className="stack" style={{ gap: 2, marginTop: 10 }}>
          {convs.map((c) => (
            <button key={c.id} className={`conv ${c.id === cid ? 'on' : ''}`} onClick={() => navigate(`/chat?c=${c.id}`)}>
              <span className="ellipsis">{c.title}</span><span className="small faint">{ago(c.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>
      <section className="chat-main">
        <div className="chat-scroll">
          {!msgs.length && (
            <div className="chat-empty">
              <Aperture state={s.identity?.presence ?? 'available'} size={120} />
              <h2 className="voice" style={{ fontSize: 30, fontWeight: 400, margin: '18px 0 6px' }}>What should I take care of?</h2>
              <p className="muted" style={{ marginTop: 0 }}>Say it the way you'd say it to a person. Ongoing things become responsibilities; rules become policy; I keep going after you close this.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((t) => <button key={t} className="chip btnlike" onClick={() => post('/api/chat', { text: t, conversationId: cid }).then((r: any) => navigate(`/chat?c=${r.conversationId}`))}>{t}</button>)}
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>{msgs.map((m, i) => <Bubble key={m.id} m={m} live={i === msgs.length - 1} />)}</AnimatePresence>
          {thinking && <div className="msg auda"><div className="msg-avatar"><Aperture state="thinking" size={30} /></div><div className="msg-bubble typing"><Morph shape="wave" size={26} color="var(--ink-3)" /></div></div>}
          <div ref={endRef} />
        </div>
        <div className="chat-compose"><Composer conversationId={cid} onSent={(id) => { if (id !== cid) navigate(`/chat?c=${id}`); }} /></div>
      </section>
    </div>
  );
}
