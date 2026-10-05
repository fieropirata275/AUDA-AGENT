/**
 * ⌘K — one place to go anywhere and do anything: pages, tasks, agents,
 * plugins, memory and actions, fuzzy-matched as you type. Text that matches
 * nothing becomes a request to AUDA; "@agent …" hands work to that agent.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, getTheme, setTheme } from '../lib/store';
import { navigate } from '../lib/router';
import { post } from '../lib/api';
import { openSheet } from './ui';
import { Morph } from '../motion/Morph';
import { TaskGlyph, TASK_LABEL } from './glyphs';
import { fm } from '../motion/spring';
import { sound } from '../lib/sound';
import { toggleVoice } from './Voice';
import { voiceSupported } from '../lib/voice';

interface Item { id: string; group: string; title: string; hint?: string; icon: ReactNode; keywords?: string; run: () => void | Promise<void> }

let openFn: ((q?: string) => void) | null = null;
export const openPalette = (q?: string) => openFn?.(q);

/** Subsequence fuzzy match with bonuses for word starts and runs. Returns score and matched indexes. */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().trim(), s = text.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hits: number[] = [];
  let score = 0, qi = 0, prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    const start = i === 0 || /[\s\-_/·:]/.test(s[i - 1]);
    score += 1 + (start ? 3 : 0) + (prev === i - 1 ? 2 : 0);
    hits.push(i); prev = i; qi++;
  }
  if (qi < q.length) return null;
  return { score: score - s.length * 0.01 + (s.startsWith(q) ? 6 : 0), hits };
}

function Hl({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  return <>{text.split('').map((ch, i) => set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>)}</>;
}

const PAGES = [
  ['/', 'Home', 'dots'], ['/chat', 'Chat', 'wave'], ['/work', 'Work', 'orbit'], ['/team', 'Team', 'flow'], ['/agents', 'Agents', 'progress'],
  ['/computer', 'Computer', 'play'], ['/memory', 'Memory', 'eye'], ['/plugins', 'Plugins', 'unplugged'], ['/connections', 'Connections', 'linked'],
  ['/activity', 'Activity', 'clock'], ['/org', 'Organization', 'eye'], ['/settings', 'Settings', 'sun'],
] as const;

export function CommandPalette() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openFn = (initial) => { setQ(initial ?? ''); setSel(0); setOpen(true); };
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setSel(0); }
      else if (e.key === '/' && !typing && !open) { e.preventDefault(); setOpen(true); setQ(''); setSel(0); }
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); openFn = null; };
  }, [open]);
  useEffect(() => { if (open) { sound.click(); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  const close = () => setOpen(false);
  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => { navigate(to); close(); };
    const out: Item[] = [
      { id: 'a:assign', group: 'Actions', title: 'Assign work…', hint: 'with a “done when”', icon: <Morph shape="plus" size={16} animate={false} />, keywords: 'task new create do', run: () => { close(); openSheet({ type: 'assign', id: 'new' }); } },
      { id: 'a:agent', group: 'Actions', title: 'Create an agent…', hint: 'one click', icon: <Morph shape="progress" size={16} animate={false} />, keywords: 'new specialist custom', run: go('/agents') },
      { id: 'a:plugin', group: 'Actions', title: 'Connect an app…', hint: 'GitHub, Google, Slack, MCP…', icon: <Morph shape="unplugged" size={16} animate={false} />, keywords: 'plugin oauth integration', run: go('/plugins') },
      { id: 'a:theme', group: 'Actions', title: `Switch to ${getTheme() === 'dark' ? 'light' : 'dark'} theme`, icon: <Morph shape={getTheme() === 'dark' ? 'sun' : 'moon'} size={16} animate={false} />, keywords: 'appearance mode', run: () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); close(); } },
      ...(voiceSupported() ? [{ id: 'a:voice', group: 'Actions', title: 'Talk to AUDA', hint: 'or hold Space', icon: <Morph shape="wave" size={16} animate={false} />, keywords: 'voice speak microphone', run: () => { close(); setTimeout(toggleVoice, 150); } }] : []),
      { id: 'a:wall', group: 'Actions', title: 'Wall display', hint: 'full-screen, for a monitor', icon: <Morph shape="sun" size={16} animate={false} />, keywords: 'noc tv kiosk monitor dashboard fullscreen', run: go('/wall') },
      ...(s.me && (s.me.role === 'owner' || s.me.role === 'admin') ? [{ id: 'a:invite', group: 'Actions', title: 'Invite someone', icon: <Morph shape="plus" size={16} animate={false} />, keywords: 'team member org', run: go('/org') }] : []),
      ...PAGES.map(([to, title, icon]) => ({ id: `p:${to}`, group: 'Go to', title, icon: <Morph shape={icon} size={16} animate={false} />, run: go(to) })),
      ...Object.values(s.customAgents).map((a) => ({ id: `ag:${a.id}`, group: 'Agents', title: a.name, hint: a.description ?? undefined, icon: <span className="pal-emoji">{a.emoji}</span>, keywords: 'agent', run: go(`/agents/${a.id}`) })),
      ...Object.values(s.tasks).filter((t) => !t.parentTaskId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 80).map((t) => ({ id: `t:${t.id}`, group: 'Tasks', title: t.title, hint: TASK_LABEL[t.state], icon: <TaskGlyph state={t.state} size={15} />, run: () => { close(); openSheet({ type: 'task', id: t.id }); } })),
      ...Object.values(s.responsibilities).filter((r) => r.state !== 'ENDED').map((r) => ({ id: `r:${r.id}`, group: 'Watching', title: r.title, hint: r.statusLine, icon: <Morph shape="eye" size={15} animate={false} />, run: () => { close(); openSheet({ type: 'responsibility', id: r.id }); } })),
      ...Object.values(s.plugins).map((p) => ({ id: `pl:${p.id}`, group: 'Plugins', title: p.name, hint: p.connection?.state === 'connected' ? 'connected' : 'not connected', icon: <Morph shape="linked" size={15} animate={false} />, run: go('/plugins') })),
      ...Object.values(s.memories).filter((m) => !m.supersededBy).slice(0, 200).map((m) => ({ id: `m:${m.id}`, group: 'Memory', title: m.title, hint: m.content.slice(0, 60), icon: <Morph shape="eye" size={15} animate={false} />, keywords: m.content.slice(0, 200), run: () => { close(); openSheet({ type: 'memory', id: m.id }); } })),
    ];
    return out;
  }, [s.customAgents, s.tasks, s.responsibilities, s.plugins, s.memories, s.me]);

  const query = q.trim();
  const mention = /^@(\S+)\s+([\s\S]+)$/.exec(query);
  const mentionAgent = mention ? Object.values(s.customAgents).find((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(mention[1].toLowerCase())) : undefined;
  const results = useMemo(() => {
    if (!query) return items.filter((i) => i.group === 'Actions' || i.group === 'Go to').slice(0, 12).map((i) => ({ item: i, hits: [] as number[] }));
    const scored: { item: Item; hits: number[]; score: number }[] = [];
    for (const it of items) {
      const m = fuzzy(query, it.title);
      const k = !m && it.keywords ? fuzzy(query, it.keywords) : null;
      if (m) scored.push({ item: it, hits: m.hits, score: m.score + (it.group === 'Actions' || it.group === 'Go to' ? 1 : 0) });
      else if (k) scored.push({ item: it, hits: [], score: k.score * 0.4 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 14);
  }, [items, query]);

  // Free text always has somewhere to go.
  const extra: Item[] = [];
  if (mentionAgent && mention) extra.push({ id: 'x:agent', group: 'Ask', title: `Give ${mentionAgent.name}: “${mention[2]}”`, icon: <span className="pal-emoji">{mentionAgent.emoji}</span>, run: async () => { const r = await post(`/api/custom-agents/${mentionAgent.id}/run`, { goal: mention[2] }); close(); openSheet({ type: 'task', id: r.id }); } });
  if (query.length > 2) extra.push({ id: 'x:ask', group: 'Ask', title: `Ask AUDA: “${query}”`, icon: <Morph shape="wave" size={16} animate={false} />, run: async () => { await post('/api/chat', { text: query, channel: 'web' }); close(); navigate('/chat'); } });
  const flat = [...results.map((r) => ({ ...r, extra: false })), ...extra.map((e) => ({ item: e, hits: [] as number[], extra: true }))];
  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = async (i: number) => {
    const r = flat[i];
    if (!r || busy) return;
    setBusy(true);
    try { sound.click(); await r.item.run(); } finally { setBusy(false); }
  };
  let lastGroup = '';

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="pal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
          <motion.div className="pal" role="dialog" aria-modal="true" aria-label="Command palette"
            initial={{ opacity: 0, y: -14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }} transition={fm.expressive}>
            <div className="pal-input">
              <Morph shape={busy ? 'orbit' : query ? 'arrowRight' : 'eye'} size={18} color="var(--accent)" />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, jump, or ask AUDA…  (@agent to hand off work)" aria-label="Command"
                role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={flat[sel] ? `pal-${flat[sel].item.id}` : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(flat.length - 1, x + 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
                  else if (e.key === 'Enter') { e.preventDefault(); void run(sel); }
                  else if (e.key === 'Escape') { e.preventDefault(); close(); }
                }} />
              <kbd>esc</kbd>
            </div>
            <div className="pal-list" id="pal-list" role="listbox" ref={list}>
              {flat.map((r, i) => {
                const head = r.item.group !== lastGroup ? (lastGroup = r.item.group) : null;
                return (
                  <div key={r.item.id}>
                    {head && <div className="pal-group">{head}</div>}
                    <motion.button layout="position" transition={fm.snap} id={`pal-${r.item.id}`} role="option" aria-selected={i === sel} className="pal-item"
                      onMouseMove={() => sel !== i && setSel(i)} onClick={() => run(i)}>
                      {i === sel && <motion.span layoutId="pal-sel" className="pal-sel" transition={fm.snap} />}
                      <span className="pal-ico">{r.item.icon}</span>
                      <span className="pal-title ellipsis"><Hl text={r.item.title} hits={r.hits} /></span>
                      {r.item.hint && <span className="pal-hint ellipsis">{r.item.hint}</span>}
                      {i === sel && <kbd>↵</kbd>}
                    </motion.button>
                  </div>
                );
              })}
              {!flat.length && <div className="pal-empty">Nothing matches. Keep typing to ask AUDA.</div>}
            </div>
            <div className="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>@</kbd> hand work to an agent</span><span className="grow" /><span><kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd> anywhere</span></div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
