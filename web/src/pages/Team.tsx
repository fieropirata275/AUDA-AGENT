/**
 * Team: one room with you, AUDA and every agent at work. Agents post when they
 * start, need you, finish or fail; @mention one to steer it mid-task; attach
 * files or whole folders and assign work with “/task …”.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, loadMessages } from '../lib/store';
import { api, post } from '../lib/api';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { GlyphStill, Aperture } from '../motion/Aperture';
import { TaskGlyph } from '../components/glyphs';
import { TaskCard } from '../components/TaskCard';
import { ApprovalCard } from '../components/ApprovalCard';
import { openSheet } from '../components/ui';
import { clock } from '../lib/time';
import type { Agent, Message } from '../lib/types';

const GROUP = 'group';

async function upload(file: File, dir?: string): Promise<string> {
  const qs = new URLSearchParams({ name: file.name, from: 'the web app', ...(dir ? { dir } : {}) });
  const r = await fetch(`/api/files?${qs}`, { method: 'POST', body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.path;
}

function Avatar({ m }: { m: Message }) {
  if (m.authorType === 'user') return null;
  if (m.authorType === 'agent') return <div className="agent-av"><TaskGlyph state={m.authorState ?? 'RUNNING'} size={16} /></div>;
  return <div className="msg-avatar"><GlyphStill size={30} /></div>;
}

function Bubble({ m }: { m: Message }) {
  const s = useStore();
  const mine = m.authorType === 'user';
  return (
    <motion.div className={`msg ${mine ? 'user' : 'auda'} ${m.authorType}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={fm.glide} layout="position">
      <Avatar m={m} />
      <div className="msg-col">
        {!mine && <button className="msg-author" onClick={() => m.authorId && openSheet({ type: 'task', id: m.authorId })} disabled={!m.authorId}>{m.authorName}</button>}
        <div className="msg-bubble">{m.content.split('\n').map((l, i) => <p key={i}>{l || ' '}</p>)}</div>
        {m.attachments?.length > 0 && (
          <div className="attach-row">{m.attachments.map((p) => (
            <a key={p} className="attach-chip" href={`/api/computer/download?path=${encodeURIComponent(p)}`}><Morph shape="rest" size={12} animate={false} />{p.split('/').pop()}</a>
          ))}</div>
        )}
        {m.objects.length > 0 && (
          <div className="msg-objects">{m.objects.map((o) => {
            if (o.type === 'task' && s.tasks[o.id]) return <TaskCard key={o.id} task={s.tasks[o.id]} />;
            if (o.type === 'approval' && s.approvals[o.id]) return <ApprovalCard key={o.id} a={s.approvals[o.id]} dense />;
            return null;
          })}</div>
        )}
        <div className="msg-time">{clock(m.createdAt)}{m.channel !== 'web' ? ` · from ${m.channel}` : ''}</div>
      </div>
    </motion.div>
  );
}

export function Team() {
  const s = useStore();
  const msgs = s.messages[GROUP] ?? [];
  const [agents, setAgents] = useState<Agent[]>([]);
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Agent[]>([]);
  const [files, setFiles] = useState<{ file: File; dir?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const taskKey = useMemo(() => Object.values(s.tasks).filter((t) => t.playbook === 'agent').map((t) => t.id + t.state).join(), [s.tasks]);

  useEffect(() => { void loadMessages(GROUP); }, []);
  useEffect(() => { api<Agent[]>('/api/agents').then(setAgents).catch(() => {}); }, [taskKey]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs.length]);

  const query = /@([\w-]*)$/.exec(text)?.[1];
  const suggestions = query !== undefined ? agents.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  const pick = (a: Agent) => { setText(text.replace(/@[\w-]*$/, '')); if (!mentions.some((m) => m.id === a.id)) setMentions([...mentions, a]); };

  const send = async () => {
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true); setErr('');
    try {
      const attachments: string[] = [];
      for (const f of files) attachments.push(await upload(f.file, f.dir));
      await post('/api/group', { text, attachments, mentions: mentions.map((m) => m.id) });
      setText(''); setFiles([]); setMentions([]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const addFiles = (list: FileList | null, folder = false) => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list).map((file) => {
      const rel = (file as any).webkitRelativePath as string | undefined;
      return { file, dir: folder && rel ? rel.split('/').slice(0, -1).join('/') : undefined };
    })]);
  };

  const live = agents.filter((a) => a.kind !== 'coordinator' && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(a.state));
  const recent = agents.filter((a) => a.kind !== 'coordinator' && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(a.state));

  return (
    <div className="team">
      <aside className="roster">
        <div className="roster-head"><Aperture state={s.identity?.presence ?? 'available'} size={34} /><div><div style={{ fontWeight: 650 }}>AUDA</div><div className="small faint">Coordinator</div></div></div>
        <div className="label" style={{ margin: '14px 4px 6px' }}>Working now · {live.length}</div>
        {live.map((a) => (
          <button key={a.id} className="roster-item" onClick={() => pick(a)} title="Mention">
            <TaskGlyph state={a.state} size={16} />
            <div className="grow"><div className="ellipsis" style={{ fontWeight: 550 }}>{a.name.replace(/^(Sub-)?[Aa]gent · /, '')}</div><div className="small faint ellipsis">{a.nowLine}</div></div>
          </button>
        ))}
        {!live.length && <div className="small faint" style={{ padding: '4px 6px' }}>No agents running. Assign work with “/task …”.</div>}
        {recent.length > 0 && <div className="label" style={{ margin: '16px 4px 6px' }}>Recently finished</div>}
        {recent.slice(0, 8).map((a) => (
          <button key={a.id} className="roster-item done" onClick={() => pick(a)} title="Mention to start a follow-up">
            <TaskGlyph state={a.state} size={16} /><div className="grow ellipsis">{a.name.replace(/^(Sub-)?[Aa]gent · /, '')}</div>
          </button>
        ))}
      </aside>
      <section className={`chat-main ${drag ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
        <div className="chat-scroll">
          {!msgs.length && (
            <div className="chat-empty">
              <h2 className="voice" style={{ fontSize: 30, fontWeight: 400, margin: '0 0 6px' }}>Your team</h2>
              <p className="muted">Everyone working for you, in one room. Type <b>/task</b> to assign work, <b>@</b> to talk to an agent mid-task, or drop files and folders here.</p>
            </div>
          )}
          <AnimatePresence initial={false}>{msgs.map((m) => <Bubble key={m.id} m={m} />)}</AnimatePresence>
          <div ref={endRef} />
        </div>
        <div className="chat-compose">
          {(mentions.length > 0 || files.length > 0) && (
            <div className="compose-chips">
              {mentions.map((m) => <button key={m.id} className="chip accent btnlike" onClick={() => setMentions(mentions.filter((x) => x.id !== m.id))}>@{m.name.replace(/^(Sub-)?[Aa]gent · /, '')} <Morph shape="close" size={11} animate={false} /></button>)}
              {files.map((f, i) => <button key={i} className="chip btnlike" onClick={() => setFiles(files.filter((_, k) => k !== i))}>{f.dir ? `${f.dir}/` : ''}{f.file.name} <Morph shape="close" size={11} animate={false} /></button>)}
            </div>
          )}
          <AnimatePresence>{suggestions.length > 0 && (
            <motion.div className="mention-pop" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.snap}>
              {suggestions.map((a) => <button key={a.id} onClick={() => pick(a)}>{a.kind === 'coordinator' ? <GlyphStill size={16} /> : <TaskGlyph state={a.state} size={14} />}<span className="ellipsis">{a.name}</span></button>)}
            </motion.div>
          )}</AnimatePresence>
          <div className="composer">
            <button className="btn ghost icon sm" title="Attach files" onClick={() => fileRef.current?.click()}><Morph shape="plus" size={16} /></button>
            <button className="btn ghost sm" title="Attach a folder" onClick={() => dirRef.current?.click()}>Folder</button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={dirRef} type="file" hidden {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => { addFiles(e.target.files, true); e.target.value = ''; }} />
            <textarea className="composer-input" rows={1} value={text} placeholder="Message the team · /task to assign · @ to mention an agent" aria-label="Message the team"
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (suggestions.length) pick(suggestions[0]); else void send(); } }} />
            <motion.button className="composer-send" onClick={send} disabled={busy || (!text.trim() && !files.length)} whileTap={{ scale: 0.92 }} transition={fm.snap} aria-label="Send">
              <Morph shape={busy ? 'wave' : 'arrowUp'} size={20} />
            </motion.button>
          </div>
          {err && <div className="chip problem" style={{ marginTop: 8 }}>{err}</div>}
        </div>
      </section>
    </div>
  );
}
