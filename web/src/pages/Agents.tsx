/**
 * Agents: specialists you build in one click, teach with documents and
 * sources, share with your organization — and that keep learning from every
 * task and every 👍/👎.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { useRoute, navigate } from '../lib/router';
import { api, post, patch, del, upload } from '../lib/api';
import { Button, Toggle, Tabs, Empty } from '../components/controls';
import { Sparkline } from '../components/Sparkline';
import { TaskGlyph, TASK_LABEL } from '../components/glyphs';
import { openSheet } from '../components/ui';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { ago } from '../lib/time';
import type { CustomAgent, KbDocument } from '../lib/types';

const FEATURE_LABEL: Record<string, string> = { bm25: 'Keyword match', cosine: 'Meaning match', useful: 'Helped before', lesson: 'Is a lesson', confidence: 'Confidence', fresh: 'Freshness' };
const FEATURES = ['bm25', 'cosine', 'useful', 'lesson', 'confidence', 'fresh'];

export function AgentTile({ a, size = 46 }: { a: Pick<CustomAgent, 'emoji' | 'color'>; size?: number }) {
  return <span className="agent-emoji" style={{ width: size, height: size, fontSize: size * 0.5, background: `color-mix(in oklab, ${a.color} 20%, var(--ceramic))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${a.color} 35%, transparent), var(--shadow-raised)` }}>{a.emoji}</span>;
}

function Create() {
  const s = useStore();
  const [templates, setTemplates] = useState<{ id: string; name: string; emoji: string; color: string; description: string }[]>([]);
  const [describe, setDescribe] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/custom-agents').then((r) => setTemplates(r.templates)).catch(() => {}); }, []);
  const create = async (body: any, key: string) => {
    setBusy(key); setErr('');
    try { const a = await post<CustomAgent>('/api/custom-agents', { ...body, visibility: share ? 'org' : 'private' }); navigate(`/agents/${a.id}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  return (
    <section className="agent-create raised">
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <span className="agent-emoji" style={{ width: 46, height: 46, fontSize: 22 }}><Morph shape="plus" size={22} color="var(--accent)" /></span>
        <div className="grow stack" style={{ gap: 10 }}>
          <div><div className="title" style={{ fontSize: 18 }}>New agent</div><div className="small muted">Describe what it should do — AUDA drafts its role and instructions. Or pick a template.</div></div>
          <div className="row">
            <input className="input" value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="e.g. Keeps our supplier prices up to date and flags increases" aria-label="Describe the agent"
              onKeyDown={(e) => { if (e.key === 'Enter' && describe.trim()) void create({ describe }, 'describe'); }} />
            <Button variant="primary" busy={busy === 'describe'} disabled={!describe.trim() || !!busy} onClick={() => create({ describe }, 'describe')}>Create</Button>
          </div>
          <div className="tpl-row">
            {templates.map((t) => (
              <motion.button key={t.id} className="tpl" whileTap={{ scale: 0.97 }} transition={fm.snap} disabled={!!busy} onClick={() => create({ template: t.id }, t.id)} title={t.description}>
                <span>{busy === t.id ? '…' : t.emoji}</span>{t.name}
              </motion.button>
            ))}
          </div>
          {s.org.enabled && <label className="row small muted" style={{ gap: 8 }}><Toggle checked={share} onChange={setShare} label="Share with organization" /> Share with everyone in {s.org.name}</label>}
          {err && <div className="chip problem">{err}</div>}
        </div>
      </div>
    </section>
  );
}

function AgentCard({ a }: { a: CustomAgent }) {
  const acc = a.learning.history.map((h) => h.accuracy ?? 0);
  return (
    <motion.article layout className="agent-card" transition={fm.glide} onClick={() => navigate(`/agents/${a.id}`)} whileHover={{ y: -2 }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/agents/${a.id}`); }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <AgentTile a={a} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}><h3 className="title ellipsis" style={{ fontSize: 16 }}>{a.name}</h3>{a.visibility === 'org' && <span className="chip accent">Shared</span>}</div>
          <div className="small muted clamp2">{a.description || a.instructions}</div>
          {!a.mine && <div className="small faint">by {a.ownerName}</div>}
        </div>
      </div>
      <div className="agent-stats">
        <span title="Knowledge"><b className="tnum">{a.knowledge.documents - a.knowledge.lessons - a.knowledge.skills}</b> docs</span>
        <span title="Lessons it learned"><b className="tnum">{a.knowledge.lessons + a.knowledge.skills}</b> learned</span>
        <span title="Tasks"><b className="tnum">{a.stats.completed}</b> done</span>
        {a.stats.rating != null && <span title="Rating"><b className="tnum">{a.stats.rating}%</b> 👍</span>}
        {acc.length > 1 && <Sparkline points={acc.map((v, i) => [i, v * 100] as [number, number])} width={60} height={18} />}
      </div>
      {a.stats.active > 0 && <div className="small" style={{ color: 'var(--accent)' }}><Morph shape="orbit" size={12} /> {a.stats.active} working now</div>}
    </motion.article>
  );
}

function RunBox({ a }: { a: CustomAgent }) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (g = goal) => {
    if (!g.trim()) return;
    setBusy(true); setErr('');
    try { const r = await post(`/api/custom-agents/${a.id}/run`, { goal: g }); setGoal(''); openSheet({ type: 'task', id: r.id }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="composer">
        <textarea className="composer-input" rows={1} value={goal} placeholder={`Give ${a.name} work…`} aria-label="Give work" onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(); } }} />
        <motion.button className="composer-send" onClick={() => run()} disabled={busy || !goal.trim()} whileTap={{ scale: 0.92 }} transition={fm.snap} aria-label="Start"><Morph shape={busy ? 'wave' : 'arrowUp'} size={20} /></motion.button>
      </div>
      {a.starters.length > 0 && <div className="tpl-row">{a.starters.map((st) => <button key={st} className="tpl small" onClick={() => setGoal(st)}>{st}</button>)}</div>}
      {err && <div className="chip problem">{err}</div>}
    </div>
  );
}

function Knowledge({ a, docs, reload }: { a: CustomAgent; docs: KbDocument[]; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: 'settled', text: ok }); reload(); } catch (e) { setMsg({ tone: 'problem', text: (e as Error).message }); } finally { setBusy(''); }
  };
  const files = async (list: FileList | null) => {
    if (!list?.length) return;
    const arr = Array.from(list);
    await run('upload', async () => { for (const f of arr) await upload(`/api/custom-agents/${a.id}/knowledge/upload?name=${encodeURIComponent(f.name)}`, f); }, `Learned from ${arr.length} file${arr.length > 1 ? 's' : ''}.`);
  };
  const docsOnly = docs.filter((d) => d.kind === 'doc');
  return (
    <div className="stack" style={{ gap: 18 }}>
      {a.canEdit && (
        <>
          <div className={`dropzone ${drag ? 'over' : ''}`} onClick={() => fileRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void files(e.dataTransfer.files); }} role="button" tabIndex={0}>
            <Morph shape={busy === 'upload' ? 'orbit' : 'plus'} size={22} color="var(--accent)" />
            <div><b>Drop documents to teach {a.name}</b><div className="small faint">PDF, Word, Markdown, text, CSV, HTML, code — up to 80 MB each</div></div>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void files(e.target.files); e.target.value = ''; }} />
          </div>
          <div className="grid-2">
            <div className="stack" style={{ gap: 6 }}>
              <div className="label">Study a web page</div>
              <div className="row"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.com/guide" /><Button busy={busy === 'url'} disabled={!url.trim()} onClick={() => run('url', () => post(`/api/custom-agents/${a.id}/knowledge`, { type: 'url', url, everyHours: 24 }).then(() => setUrl('')), 'Added. It re-reads the page daily and learns what changed.')}>Add</Button></div>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <div className="label">Write a note</div>
              <div className="row"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Facts, preferences, how you like things done…" /><Button busy={busy === 'note'} disabled={!note.trim()} onClick={() => run('note', () => post(`/api/custom-agents/${a.id}/knowledge`, { type: 'note', text: note }).then(() => setNote('')), 'Noted.')}>Add</Button></div>
            </div>
          </div>
        </>
      )}
      {msg && <div className={`chip ${msg.tone}`}>{msg.text}</div>}
      {a.sources.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Sources it studies</div>
          {a.sources.map((src) => (
            <div key={src.id} className="kb-row">
              <Morph shape="eye" size={15} color="var(--ink-3)" animate={false} />
              <div className="grow ellipsis"><a href={src.url} target="_blank" rel="noreferrer">{src.url}</a><div className="small faint">every {src.everyHours} h · {src.lastFetchedAt ? `read ${ago(src.lastFetchedAt)}` : 'not read yet'}{src.error ? ` · ${src.error}` : ''}</div></div>
              {a.canEdit && <button className="btn ghost sm" onClick={() => del(`/api/custom-agents/${a.id}/sources/${src.id}`).then(reload)}>Stop</button>}
            </div>
          ))}
          {a.canEdit && <Button size="sm" variant="ghost" icon="recover" busy={busy === 'study'} onClick={() => run('study', () => post(`/api/custom-agents/${a.id}/study`), 'Re-read its sources.')}>Study now</Button>}
        </div>
      )}
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Documents · {docsOnly.length}</div>
        {docsOnly.map((d) => (
          <div key={d.id} className="kb-row">
            <span className="kb-ico">{d.source === 'url' ? '🌐' : d.source === 'note' ? '📝' : '📄'}</span>
            <div className="grow ellipsis"><div className="ellipsis" style={{ fontWeight: 550 }}>{d.title}</div><div className="small faint">{d.passages} passages · {(d.chars / 1000).toFixed(1)}k chars · used {d.uses}× · {ago(d.updatedAt)}</div></div>
            {a.canEdit && <button className="btn ghost icon sm" aria-label={`Remove ${d.title}`} onClick={() => del(`/api/custom-agents/${a.id}/knowledge/${d.id}`).then(reload)}><Morph shape="close" size={14} /></button>}
          </div>
        ))}
        {!docsOnly.length && <Empty title="No documents yet">Teach it with files, pages or notes. It also learns on its own from every task.</Empty>}
      </div>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Try a search</div>
        <div className="row"><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What would it find for…" onKeyDown={(e) => { if (e.key === 'Enter' && query.trim()) void api(`/api/custom-agents/${a.id}/search?q=${encodeURIComponent(query)}`).then(setHits); }} />
          <Button disabled={!query.trim()} onClick={() => api(`/api/custom-agents/${a.id}/search?q=${encodeURIComponent(query)}`).then(setHits)}>Search</Button></div>
        {hits && (hits.length ? hits.map((h, i) => (
          <div key={i} className="hit">
            <div className="row small"><b className="grow ellipsis">{h.kind !== 'doc' ? `${h.kind === 'lesson' ? 'Lesson' : 'Skill'}: ` : ''}{h.title}</b><span className="chip">{Math.round(h.score * 100)}%</span></div>
            <div className="small muted clamp3">{h.text}</div>
          </div>
        )) : <div className="small faint" style={{ marginTop: 8 }}>Nothing relevant.</div>)}
      </div>
    </div>
  );
}

function Learning({ a, docs, reload }: { a: CustomAgent; docs: KbDocument[]; reload: () => void }) {
  const lessons = docs.filter((d) => d.kind !== 'doc').sort((x, y) => y.confidence - x.confidence);
  const h = a.learning.history;
  const maxW = Math.max(1, ...a.learning.weights.map((w) => Math.abs(w)));
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="learn-tiles">
        <div className="count-tile"><div className="count-n tnum">{a.learning.updates}</div><div className="count-k">training examples</div></div>
        <div className="count-tile"><div className="count-n tnum">{lessons.length}</div><div className="count-k">lessons & skills</div></div>
        <div className="count-tile"><div className="count-n tnum">{h.length ? `${Math.round((h[h.length - 1].accuracy ?? 0) * 100)}%` : '—'}</div><div className="count-k">ranking accuracy</div></div>
        <div className="count-tile"><div className="count-n tnum">{a.stats.rating != null ? `${a.stats.rating}%` : '—'}</div><div className="count-k">rated good ({a.stats.rated})</div></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        After every task, {a.name} checks which passages it actually used and updates its own ranking model, writes down lessons, and turns approaches that worked into skills.
        Your 👍/👎 and comments count most. Lessons that never help fade out.
      </p>
      {h.length > 1 && <div className="card flat"><div className="label">Ranking accuracy over time</div><Sparkline points={h.map((x, i) => [i, (x.accuracy ?? 0) * 100] as [number, number])} width={520} height={56} /></div>}
      <div className="card flat">
        <div className="label" style={{ marginBottom: 8 }}>What it has learned to value when choosing knowledge</div>
        {FEATURES.map((f, i) => {
          const w = a.learning.weights[i] ?? 0;
          return (
            <div key={f} className="weight-row">
              <span className="small grow">{FEATURE_LABEL[f]}</span>
              <div className="weight-bar"><motion.span animate={{ width: `${(Math.abs(w) / maxW) * 100}%` }} transition={fm.settle} style={{ background: w >= 0 ? 'var(--accent)' : 'var(--problem)' }} /></div>
              <span className="mono small faint tnum" style={{ width: 48, textAlign: 'right' }}>{w.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Lessons & skills</div>
        {lessons.map((d) => (
          <div key={d.id} className="kb-row">
            <span className="kb-ico">{d.kind === 'skill' ? '🧭' : '💡'}</span>
            <div className="grow ellipsis"><div className="ellipsis" style={{ fontWeight: 550 }}>{d.title}</div><div className="small faint">{d.kind} · used {d.uses}× · helped {d.helpful}× · {ago(d.updatedAt)}</div></div>
            <div className="conf" title={`Confidence ${Math.round(d.confidence * 100)}%`}><span style={{ width: `${d.confidence * 100}%` }} /></div>
            {a.canEdit && <button className="btn ghost icon sm" aria-label="Forget" onClick={() => del(`/api/custom-agents/${a.id}/knowledge/${d.id}`).then(reload)}><Morph shape="close" size={14} /></button>}
          </div>
        ))}
        {!lessons.length && <Empty title="Nothing learned yet">Give it work. It reflects after each task.</Empty>}
      </div>
      {a.canEdit && (
        <div className="stack" style={{ gap: 10 }}>
          <label className="set-row"><span className="grow">Reflect after each task<div className="small faint">Write lessons and skills from what happened.</div></span><Toggle checked={a.reflect} onChange={(v) => patch(`/api/custom-agents/${a.id}`, { reflect: v })} /></label>
          <label className="set-row"><span className="grow">Study its sources on schedule<div className="small faint">Re-read pages and re-learn what changed.</div></span><Toggle checked={a.study} onChange={(v) => patch(`/api/custom-agents/${a.id}`, { study: v })} /></label>
          <a className="btn ghost sm" style={{ alignSelf: 'flex-start' }} href={`/api/custom-agents/${a.id}/training.jsonl`}>Export training data (JSONL)</a>
        </div>
      )}
    </div>
  );
}

function Setup({ a }: { a: CustomAgent }) {
  const s = useStore();
  const [instructions, setInstructions] = useState(a.instructions);
  const [criteria, setCriteria] = useState(a.criteria ?? '');
  const [saved, setSaved] = useState(false);
  const plugins = Object.values(s.plugins);
  const allowed = a.plugins;
  const save = async () => { await patch(`/api/custom-agents/${a.id}`, { instructions, criteria }); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  const togglePlugin = (id: string) => {
    const cur = allowed ?? plugins.map((p) => p.id);
    patch(`/api/custom-agents/${a.id}`, { plugins: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="label">Instructions</div>
        <textarea className="textarea" rows={7} value={instructions} disabled={!a.canEdit} onChange={(e) => setInstructions(e.target.value)} />
        <div className="label" style={{ marginTop: 6 }}>Done when (default for its tasks)</div>
        <input className="input" value={criteria} disabled={!a.canEdit} onChange={(e) => setCriteria(e.target.value)} placeholder="What a finished task looks like" />
        {a.canEdit && <Button variant="primary" size="sm" style={{ alignSelf: 'flex-start' }} disabled={instructions === a.instructions && criteria === (a.criteria ?? '')} onClick={save}>{saved ? 'Saved' : 'Save'}</Button>}
      </div>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Apps it may use</div>
        <p className="small muted" style={{ marginTop: 0 }}>Whoever gives it work lends their own connected accounts — never yours. Changes in an app ask first.</p>
        {plugins.map((p) => (
          <label key={p.id} className="set-row">
            <span className="grow">{p.name}<div className="small faint">{p.tools.length} tools · {p.connection?.state === 'connected' ? 'you’re connected' : 'not connected for you'}</div></span>
            <Toggle checked={!allowed || allowed.includes(p.id)} onChange={() => a.canEdit && togglePlugin(p.id)} />
          </label>
        ))}
        {!plugins.length && <div className="small faint">No plugins yet. <button className="link" onClick={() => navigate('/plugins')}>Add one</button></div>}
        {a.canEdit && allowed && <button className="link small" onClick={() => patch(`/api/custom-agents/${a.id}`, { plugins: null })}>Allow every app the person has connected</button>}
      </div>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const s = useStore();
  const a = s.customAgents[id];
  const [detail, setDetail] = useState<{ documents: KbDocument[]; recentTasks: any[] } | null>(null);
  const [tab, setTab] = useState<'work' | 'knowledge' | 'learning' | 'setup'>('work');
  const [name, setName] = useState(a?.name ?? '');
  const reload = () => api(`/api/custom-agents/${id}`).then(setDetail).catch(() => setDetail({ documents: [], recentTasks: [] }));
  useEffect(() => { void reload(); }, [id, a?.updatedAt, a?.knowledge.documents]);
  useEffect(() => { if (a) setName(a.name); }, [a?.name]);
  if (!a) return <Empty title="This agent isn’t available">It may have been archived or isn’t shared with you. <button className="link" onClick={() => navigate('/agents')}>All agents</button></Empty>;
  const docs = detail?.documents ?? [];
  return (
    <div>
      <button className="btn ghost sm back" onClick={() => navigate('/agents')}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Morph shape="chevronRight" size={14} animate={false} /></span> Agents</button>
      <div className="agent-hero">
        <AgentTile a={a} size={64} />
        <div className="grow" style={{ minWidth: 0 }}>
          {a.canEdit
            ? <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== a.name && patch(`/api/custom-agents/${id}`, { name })} aria-label="Name" />
            : <h1 className="title-lg" style={{ margin: 0 }}>{a.name}</h1>}
          <div className="muted">{a.description}</div>
          <div className="row small faint" style={{ gap: 10, marginTop: 4 }}>
            <span>{a.mine ? 'Yours' : `by ${a.ownerName}`}</span>
            <span>{a.knowledge.passages} passages · {a.knowledge.embedder.startsWith('local:') ? 'local embeddings' : 'built-in embeddings'}</span>
          </div>
        </div>
        <div className="stack" style={{ gap: 8, alignItems: 'flex-end' }}>
          {a.canEdit && s.org.enabled && <label className="row small" style={{ gap: 8 }}>{a.visibility === 'org' ? `Shared with ${s.org.name}` : 'Private'}<Toggle checked={a.visibility === 'org'} onChange={(v) => patch(`/api/custom-agents/${id}`, { visibility: v ? 'org' : 'private' })} label="Share" /></label>}
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="ghost" onClick={() => post<CustomAgent>(`/api/custom-agents/${id}/duplicate`).then((c) => navigate(`/agents/${c.id}`))}>Duplicate</Button>
            {a.canEdit && <Button size="sm" variant="ghost" className="danger" onClick={() => { if (confirm(`Archive ${a.name}? Its tasks stay in history.`)) void del(`/api/custom-agents/${id}`).then(() => navigate('/agents')); }}>Archive</Button>}
          </div>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'work', label: 'Work' }, { value: 'knowledge', label: `Knowledge · ${docs.filter((d) => d.kind === 'doc').length}` }, { value: 'learning', label: 'Learning' }, { value: 'setup', label: 'Setup' }]} />
      <div style={{ marginTop: 18 }}>
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.glide}>
            {tab === 'work' && (
              <div className="stack" style={{ gap: 18 }}>
                <RunBox a={a} />
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Recent work</div>
                  {(detail?.recentTasks ?? []).map((t) => (
                    <button key={t.id} className="kb-row btnlike" onClick={() => openSheet({ type: 'task', id: t.id })}>
                      <TaskGlyph state={t.state} size={18} />
                      <div className="grow ellipsis" style={{ textAlign: 'left' }}><div className="ellipsis" style={{ fontWeight: 550 }}>{t.title}</div><div className="small faint">{TASK_LABEL[t.state]}{t.completedAt ? ` · ${ago(t.completedAt)}` : ''}{t.ownerId !== s.me?.id && s.members[t.ownerId] ? ` · for ${s.members[t.ownerId].name}` : ''}</div></div>
                      {t.rating != null && <span>{t.rating > 0 ? '👍' : '👎'}</span>}
                    </button>
                  ))}
                  {!detail?.recentTasks?.length && <div className="small faint">No work yet. You can also @mention {a.name} in Team.</div>}
                </div>
              </div>
            )}
            {tab === 'knowledge' && <Knowledge a={a} docs={docs} reload={reload} />}
            {tab === 'learning' && <Learning a={a} docs={docs} reload={reload} />}
            {tab === 'setup' && <Setup a={a} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function Agents() {
  const s = useStore();
  const { parts } = useRoute();
  if (parts[1]) return <Detail id={parts[1]} />;
  const all = Object.values(s.customAgents).sort((x, y) => y.updatedAt - x.updatedAt);
  const mine = all.filter((a) => a.mine);
  const shared = all.filter((a) => !a.mine);
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">Agents</h1><p>Specialists you build in one click. Teach them with documents and sources; they keep learning from every task.</p></div></div>
      <Create />
      <section className="section">
        <div className="section-head"><h2>Yours</h2><span className="n">{mine.length}</span></div>
        <div className="agent-grid">{mine.map((a) => <AgentCard key={a.id} a={a} />)}</div>
        {!mine.length && <Empty title="No agents yet">Describe one above, or start from a template.</Empty>}
      </section>
      {shared.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Shared with you</h2><span className="n">{shared.length}</span><span className="faint small">They work with your own connected accounts.</span></div>
          <div className="agent-grid">{shared.map((a) => <AgentCard key={a.id} a={a} />)}</div>
        </section>
      )}
    </div>
  );
}
