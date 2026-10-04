/**
 * Built-in intent compiler. Maps natural language onto persistent state
 * without a model, so AUDA is useful (and testable) fully offline. When a
 * reasoning model is connected, agent/chat.ts uses it instead and falls back
 * to this on failure.
 */
import { q, type Row } from '../core/db.ts';
import { createResponsibility, endResponsibility, pauseResponsibility, resumeResponsibility, wakeNow } from '../responsibilities/service.ts';
import { createTask } from '../tasks/engine.ts';
import { parseSchedule } from '../scheduler/fuzzy.ts';
import { compileRule, createRule } from '../policy/rules.ts';
import { forget, recall, remember } from '../memory/service.ts';
import { canUseTools } from '../models/router.ts';
import { presenceSummary } from './presence.ts';

export interface Reply { text: string; objects: { type: string; id: string }[] }
const MB = 1024 * 1024;

export function findResponsibility(text: string): Row | undefined {
  const rows = q.all("SELECT * FROM responsibilities WHERE state != 'ENDED' ORDER BY updated_at DESC");
  const words = text.toLowerCase().match(/[\p{L}\p{N}.-]{3,}/gu) ?? [];
  let best: Row | undefined; let score = 0;
  for (const r of rows) {
    const hay = `${r.title} ${r.config_json} ${r.status_line}`.toLowerCase();
    const s = words.filter((w) => !['stop', 'watching', 'pause', 'resume', 'that', 'this', 'the', 'keep', 'check'].includes(w) && hay.includes(w)).length;
    if (s > score) { score = s; best = r; }
  }
  return best ?? (/\b(this|that|it)\b/.test(text) ? rows[0] : undefined);
}

export async function compileIntent(text: string, ctx: { spaceId?: string | null; messageId?: string }): Promise<Reply> {
  const s = text.trim();
  const l = s.toLowerCase();
  const origin = { type: 'chat', messageId: ctx.messageId };
  const url = s.match(/https?:\/\/[^\s)]+/)?.[0];

  // Status
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b|what are you (doing|up to)|what'?s (happening|going on)|\bstatus\b|how are things/.test(l)) {
    return { text: presenceSummary(), objects: [] };
  }

  // Why did you…?
  if (/^(why|how come)\b/.test(l)) {
    const words = l.match(/[a-z0-9-]{4,}/g)?.filter((w) => !['why', 'did', 'you', 'that', 'this', 'have', 'were', 'what'].includes(w)) ?? [];
    const acts = q.all('SELECT * FROM activity ORDER BY ts DESC LIMIT 400');
    const hit = acts.find((a) => words.some((w) => `${a.title} ${a.detail ?? ''}`.toLowerCase().includes(w)) && a.task_id);
    if (!hit) return { text: 'I couldn’t find anything in my activity that matches. Try naming the thing I did — for example “why did you delete those logs?”', objects: [] };
    const task = q.get('SELECT * FROM tasks WHERE id = ?', hit.task_id)!;
    const reasons = q.all("SELECT title, detail FROM activity WHERE task_id = ? AND kind IN ('observe','reason','approval','user','act') ORDER BY ts", task.id);
    const audit = q.all('SELECT capability, decision FROM audit_log WHERE task_id = ? ORDER BY ts', task.id);
    const why = reasons.map((r) => `• ${r.title}${r.detail ? ` — ${r.detail.split('\n')[0]}` : ''}`).join('\n');
    const auth = audit.length ? `\n\nAuthority: ${[...new Set(audit.map((a) => a.decision.startsWith('approved') ? 'you approved it' : a.decision.startsWith('rule') ? 'one of your rules allowed it' : 'it’s within what I may do on my own'))].join('; ')}.` : '';
    return { text: `Here’s the reasoning behind “${task.title}”:\n\n${why}${auth}`, objects: [{ type: 'task', id: task.id }] };
  }

  // Stop / pause / resume / check
  const ctl = l.match(/^(stop|quit|end|pause|resume|unpause|check on|check)\b/);
  if (ctl && !/remind/.test(l)) {
    const r = findResponsibility(l);
    if (!r) return { text: 'I’m not sure which responsibility you mean. You can stop or pause any of them from Work.', objects: [] };
    if (/^(stop|quit|end)/.test(ctl[1])) { endResponsibility(r.id); return { text: `Done — I’m no longer responsible for “${r.title}”. Its history stays in Activity.`, objects: [{ type: 'responsibility', id: r.id }] }; }
    if (ctl[1] === 'pause') { pauseResponsibility(r.id); return { text: `Paused “${r.title}”. Nothing will wake it until you resume it.`, objects: [{ type: 'responsibility', id: r.id }] }; }
    if (/resume|unpause/.test(ctl[1])) { resumeResponsibility(r.id); return { text: `Resumed “${r.title}”.`, objects: [{ type: 'responsibility', id: r.id }] }; }
    const t = await wakeNow(r.id);
    return { text: t ? `Checking “${r.title}” now.` : `I’m already working on “${r.title}”.`, objects: t ? [{ type: 'task', id: t }] : [{ type: 'responsibility', id: r.id }] };
  }

  // Remember / forget
  const rem = s.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)/i);
  const pref = s.match(/^(?:i (?:prefer|like|want|hate|don'?t like)|my (?:name|timezone|time zone|email|role) is)\s+.+/i);
  if (rem || pref) {
    const content = (rem ? rem[1] : s).replace(/\.$/, '');
    const defining = /\b(always|defines|rule of thumb|non-negotiable|how (this|the) project works)\b/i.test(content);
    const kind = /^my (name|timezone|time zone|email|role)/i.test(content) || /^my (name|timezone|role)/i.test(s) ? 'identity' : /\b(prefer|like|hate|want|always|never)\b/i.test(content) ? 'preference' : /\b(is|are|works|uses)\b/.test(content) ? 'semantic' : 'semantic';
    const title = content.length > 60 ? content.slice(0, 57).replace(/\s+\S*$/, '') + '…' : content;
    const id = remember({ kind, title, content, source: 'chat', sourceRef: ctx.messageId, confidence: 0.95, weight: defining ? 'defining' : 'mentioned', spaceId: ctx.spaceId, scope: ctx.spaceId ? 'space' : 'global', expiresAt: null });
    const nm = s.match(/my name is\s+([\p{L}' -]+)/iu);
    if (nm) q.run('UPDATE identity SET user_name = ?', nm[1].trim());
    return { text: defining ? 'Got it — I’ll treat that as defining, not a passing mention.' : 'Noted. If it keeps coming up I’ll treat it as established.', objects: [{ type: 'memory', id }] };
  }
  const fg = s.match(/^forget(?:\s+that|\s+about)?\s+(.+)/i);
  if (fg) {
    const m = recall(fg[1], { limit: 1 })[0];
    if (!m) return { text: 'I don’t have a memory matching that.', objects: [] };
    forget(m.id);
    return { text: `Forgotten: “${m.title}”.`, objects: [] };
  }

  // Rules
  if (/^(never|always|don'?t|do not|you (can|may)|auda (can|may)|when you can|only|feel free|it'?s ok)/i.test(s) && !/remind/i.test(s)) {
    const c = await compileRule(s);
    if (c) {
      const id = createRule(s, { ...c, spaceId: ctx.spaceId, origin: 'chat' });
      return { text: 'Here’s how I understand that rule. It takes effect once you activate it.', objects: [{ type: 'rule', id }] };
    }
  }

  // Reminders (one-off → scheduled task; recurring → responsibility)
  const remind = s.match(/^(?:please\s+)?remind me\b\s*(.*)$/i);
  if (remind) {
    const sched = parseSchedule(s);
    if (!sched) return { text: 'When should I remind you? For example “tomorrow at 9” or “every Monday morning”.', objects: [] };
    const what = remind[1]
      .replace(/\b(every|each)\s+(\d+\s+)?(day|week|weekday|morning|evening|minute|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, '')
      .replace(/\b(tomorrow|tonight|today|next week)\b/gi, '')
      .replace(/\b(in\s+(\d+|an?|one)\s*(minute|min|hour|day|week)s?)\b/gi, '')
      .replace(/\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
      .replace(/\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm|h)?\b/gi, '')
      .replace(/\b(in the\s+)?(morning|afternoon|evening|night)\b/gi, '')
      .replace(/\s+/g, ' ').trim().replace(/^(to|about|that)\s+/i, '').replace(/[.,;]+$/, '') || 'check in';
    if (sched.kind === 'cron' || sched.kind === 'interval') {
      const id = createResponsibility({ playbook: 'routine.reminder', title: `Remind you to ${what}`, config: { text: what, schedule: sched, scheduleText: sched.description }, spaceId: ctx.spaceId, origin });
      return { text: `I’ll remind you ${sched.description}.`, objects: [{ type: 'responsibility', id }] };
    }
    const id = createTask({ title: `Remind you to ${what}`, playbook: 'routine.reminder', input: { text: what }, runAt: sched.nextRunAt, spaceId: ctx.spaceId, origin });
    return { text: `I’ll remind you ${sched.description}.`, objects: [{ type: 'task', id }] };
  }

  // Server health
  if (/\b(server|disk|volume|demo-api|service)\b/.test(l) && /\b(healthy|health|watch|eye on|monitor|look after|take care)\b/.test(l)) {
    const existing = q.get("SELECT id FROM responsibilities WHERE playbook = 'server.health' AND state != 'ENDED'");
    if (existing) return { text: 'I’m already looking after that server.', objects: [{ type: 'responsibility', id: existing.id }] };
    const id = createResponsibility({
      playbook: 'server.health', title: 'Keep demo-api healthy', spaceId: ctx.spaceId, origin,
      description: 'Keep the demo-api service on AUDA’s computer running and its volume under quota.',
      config: { service: 'demo-api', path: '~/services/demo-api', quotaBytes: 48 * MB, thresholdPct: 80, rearmPct: 60, intervalSec: 5 },
    });
    return { text: 'I’ll keep demo-api healthy. I’m watching its volume against the 48 MB quota and the process itself, and I’ll fix what I safely can. Anything destructive comes to you first.', objects: [{ type: 'responsibility', id }] };
  }

  // GitHub CI
  const repo = s.match(/\b([\w.-]+\/[\w.-]+)\b/)?.[1];
  if (repo && !url && /\b(ci|actions|workflows?|builds?|pipeline)\b/i.test(s)) {
    const connected = q.get("SELECT state FROM connectors WHERE id = 'github'")?.state === 'connected';
    if (!connected) return { text: `I need GitHub access first. Connect GitHub in Connections and ask me again — I’ll watch ${repo}.`, objects: [{ type: 'connector', id: 'github' }] };
    const branch = s.match(/\b(?:on|branch)\s+([\w./-]+)\s*$/i)?.[1];
    const id = createResponsibility({ playbook: 'github.ci', title: `Watch CI on ${repo}`, config: { repo, branch, intervalSec: 120 }, spaceId: ctx.spaceId, origin });
    return { text: `Watching GitHub Actions on ${repo}. If a run fails I’ll read the logs and either re-run it (if it looks flaky, within your rules) or tell you what broke.`, objects: [{ type: 'responsibility', id }] };
  }

  // Webhooks
  const hook = l.match(/\bwhen(?:ever)?\s+(?:the\s+)?["“]?([\w-]+)["”]?\s+webhook\b/);
  if (hook) {
    const id = createResponsibility({ playbook: 'webhook.react', title: `React to the “${hook[1]}” webhook`, config: { slug: hook[1] }, spaceId: ctx.spaceId, origin });
    return { text: `Listening. Anything POSTed to /hooks/${hook[1]} will wake me.`, objects: [{ type: 'responsibility', id }] };
  }

  // Recurring reports
  if (/\b(report|summary|summarise|summarize|digest|recap)\b/.test(l) && /\b(every|each|weekly|daily|monday|friday|morning)\b/.test(l)) {
    const sched = parseSchedule(s) ?? parseSchedule('every monday at 9')!;
    const title = /\bweek/.test(l) || sched.spec.endsWith(' 1') ? 'Weekly summary' : 'Summary';
    const id = createResponsibility({ playbook: 'routine.report', title, config: { title, schedule: sched, scheduleText: sched.description, periodDays: sched.description.startsWith('every day') ? 1 : 7 }, spaceId: ctx.spaceId, origin });
    return { text: `I’ll write it ${sched.description} and keep it in Files. You’ll get a quiet heads-up, not an alarm.`, objects: [{ type: 'responsibility', id }] };
  }

  // Watch a URL
  if (url && /\b(watch|eye on|monitor|track|tell me|let me know|notify|check)\b/.test(l)) {
    const sched = parseSchedule(l);
    const intervalSec = sched?.kind === 'interval' ? Number(sched.spec) : /\bday|daily\b/.test(l) ? 86400 : /\bminute/.test(l) ? 300 : 3600;
    const kw = [...s.matchAll(/["“']([^"”']{2,40})["”']/g)].map((m) => m[1]);
    const id = createResponsibility({ playbook: 'web.watch', title: `Watch ${new URL(url).host}`, config: { url, intervalSec, keywords: kw.length ? kw : undefined, focus: s }, spaceId: ctx.spaceId, origin });
    return { text: `I’ll check ${url} ${intervalSec >= 86400 ? 'every day' : intervalSec >= 3600 ? `every ${Math.round(intervalSec / 3600)} h` : `every ${Math.round(intervalSec / 60)} min`} in my own browser and only tell you when something meaningful changes.`, objects: [{ type: 'responsibility', id }] };
  }

  // Everything else is open-ended work.
  if (canUseTools()) {
    const sched = /\b(tomorrow|tonight|next week|at \d|in \d+ (min|hour|day))/.test(l) ? parseSchedule(l) : null;
    const id = createTask({ title: s.length > 80 ? s.slice(0, 77).replace(/\s+\S*$/, '') + '…' : s, goal: s, playbook: 'agent', input: {}, spaceId: ctx.spaceId, origin, runAt: sched?.nextRunAt });
    return { text: sched ? `I’ll take care of it ${sched.description}.` : 'On it. You can watch the work in progress, or close this — I’ll keep going.', objects: [{ type: 'task', id }] };
  }
  return {
    text: 'I can’t take on open-ended work yet because no reasoning model is connected (Connections → Claude). Without one I can still: keep a server healthy, watch web pages, watch CI, react to webhooks, write recurring reports, remind you, remember things and follow your rules.',
    objects: [{ type: 'connector', id: 'anthropic' }],
  };
}
