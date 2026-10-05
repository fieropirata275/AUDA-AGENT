/**
 * Playbook: watch a web page. A watcher reads the page in AUDA's own browser on
 * a schedule and fires only when the meaningful text changes. The task then
 * captures evidence, works out what changed, and tells you only if it matters.
 */
import crypto from 'node:crypto';
import { definePlaybook } from './types.ts';
import { addWatcher, registerProbe } from '../watchers/runner.ts';
import { readPage, screenshot } from '../computer/browser.ts';
import { controller } from '../computer/index.ts';
import { json } from '../core/db.ts';
import { complete, hasReasoningModel } from '../models/router.ts';

const normalize = (t: string) => t.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function lineDiff(a: string, b: string) {
  const A = new Set(a.split('\n').map((l) => l.trim()).filter(Boolean));
  const B = new Set(b.split('\n').map((l) => l.trim()).filter(Boolean));
  return { added: [...B].filter((l) => !A.has(l)).slice(0, 40), removed: [...A].filter((l) => !B.has(l)).slice(0, 40) };
}

registerProbe('url', async (c, state) => {
  if (controller() === 'human') return { value: state.value ?? 'paused while you have the computer', fire: false, state };
  const page = await readPage(c.url);
  const text = normalize(page.text).slice(0, 20_000);
  const h = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (!state.hash) return { value: `Baseline captured · ${page.title || c.url}`, fire: false, state: { hash: h, text, title: page.title, value: 'baseline' } };
  if (h === state.hash) return { value: `No change · ${page.title || c.url}`, fire: false, state: { ...state, value: 'unchanged' } };
  const d = lineDiff(state.text, text);
  const keywords: string[] = c.keywords ?? [];
  const hit = keywords.length ? [...d.added, ...d.removed].some((l) => keywords.some((k) => l.toLowerCase().includes(k.toLowerCase()))) : true;
  return {
    value: `Changed · ${d.added.length} lines added, ${d.removed.length} removed`, fire: hit,
    observation: { headline: `${page.title || c.url} changed`, previous: state.text, current: text, added: d.added, removed: d.removed },
    state: { hash: h, text, title: page.title, value: 'changed' },
  };
});

definePlaybook({
  id: 'web.watch',
  title: 'Watch a web page',
  description: 'Reads a page in AUDA’s browser on a schedule and reports meaningful changes.',
  plan: () => [
    { key: 'capture', title: 'Capture the page' },
    { key: 'compare', title: 'Work out what changed' },
    { key: 'report', title: 'Report if it matters' },
  ],
  steps: {
    async capture(ctx) {
      ctx.narrate(`Opening ${ctx.input.url} in my browser.`);
      const page = await ctx.tool('browser.read', { url: ctx.input.url });
      const png = await screenshot();
      const art = await ctx.artifact(`${new URL(ctx.input.url).host}.png`, png, { mime: 'image/png', why: `Screenshot of ${ctx.input.url} when the change was detected` });
      Object.assign(ctx.vars, { title: page.title, current: normalize(page.text).slice(0, 20_000), shot: art.id });
      ctx.log('observe', `Captured ${page.title || ctx.input.url}`, `${page.text.length.toLocaleString()} characters of text; screenshot saved.`);
      return { output: { title: page.title, screenshot: art.id } };
    },
    async compare(ctx) {
      const d = ctx.input.added ? { added: ctx.input.added, removed: ctx.input.removed } : lineDiff(ctx.input.previous ?? '', ctx.vars.current);
      let summary: string;
      if (hasReasoningModel()) {
        ctx.narrate('Summarising the change.');
        summary = (await complete({ role: 'utility', purpose: 'page change summary', taskId: ctx.task.id, maxTokens: 300,
          system: 'Summarise what changed on a watched web page in 1-3 plain sentences for a busy person. Mention numbers, prices, dates, availability. No preamble.',
          prompt: `Page: ${ctx.vars.title} (${ctx.input.url})\nWhat the user cares about: ${ctx.input.focus ?? 'any meaningful change'}\n\nAdded lines:\n${d.added.join('\n')}\n\nRemoved lines:\n${d.removed.join('\n')}` })).text.trim();
      } else {
        const pick = (xs: string[]) => xs.slice(0, 3).map((l) => `“${l.slice(0, 90)}”`).join(', ');
        summary = [d.added.length ? `New: ${pick(d.added)}` : '', d.removed.length ? `Gone: ${pick(d.removed)}` : ''].filter(Boolean).join('. ') || 'Layout changed; no text difference.';
      }
      Object.assign(ctx.vars, { added: d.added, removed: d.removed, summary });
      ctx.log('reason', 'What changed', summary);
      return { output: { summary } };
    },
    async report(ctx) {
      const v = ctx.vars;
      const md = `# ${v.title || ctx.input.url} changed\n\n*${new Date().toLocaleString()} · ${ctx.input.url}*\n\n${v.summary}\n\n## Added\n${v.added.map((l: string) => `+ ${l}`).join('\n') || '—'}\n\n## Removed\n${v.removed.map((l: string) => `- ${l}`).join('\n') || '—'}\n`;
      await ctx.artifact(`${new URL(ctx.input.url).host}-change.md`, md, { why: `What changed on ${ctx.input.url}` });
      ctx.remember({ kind: 'semantic', title: `Latest state of ${new URL(ctx.input.url).host}`, content: `${new Date().toLocaleDateString()}: ${v.summary}`, confidence: 0.9 });
      ctx.notify(ctx.input.notifyLevel ?? 'attention', `${v.title || new URL(ctx.input.url).host} changed`, v.summary);
      return { complete: v.summary };
    },
  },
  responsibility: {
    describe: (c) => `Checking ${c.url} every ${c.intervalSec >= 3600 ? `${Math.round(c.intervalSec / 3600)} h` : c.intervalSec >= 60 ? `${Math.round(c.intervalSec / 60)} min` : `${c.intervalSec} s`}${c.keywords?.length ? ` for ${c.keywords.join(', ')}` : ''}`,
    setup(resp) {
      const c = json<any>(resp.config_json, {});
      addWatcher(resp.id, 'url', { url: c.url, keywords: c.keywords }, c.intervalSec ?? 3600, `Page ${c.url}`);
    },
    onWake(resp, e) {
      const c = json<any>(resp.config_json, {});
      if (e.type !== 'watcher.fired') return null;
      return { title: `Review the change on ${new URL(c.url).host}`, input: { previous: e.payload.previous, added: e.payload.added, removed: e.payload.removed } };
    },
  },
});
