/** Playbooks: recurring reports, reminders and webhook reactions. */
import { definePlaybook } from './types.ts';
import { addSchedule } from '../scheduler/scheduler.ts';
import { addTrigger } from '../responsibilities/service.ts';
import { json, q } from '../core/db.ts';
import { complete, hasReasoningModel } from '../models/router.ts';

definePlaybook({
  id: 'routine.report',
  title: 'Recurring report',
  description: 'Summarises what AUDA did over a period and saves it as a report.',
  plan: () => [
    { key: 'gather', title: 'Gather what happened' },
    { key: 'write', title: 'Write the report' },
  ],
  steps: {
    async gather(ctx) {
      const since = Date.now() - (ctx.input.periodDays ?? 7) * 86400_000;
      const done = q.all("SELECT title, result_summary, completed_at FROM tasks WHERE state = 'COMPLETED' AND completed_at >= ? ORDER BY completed_at", since);
      const failed = q.all("SELECT title, error FROM tasks WHERE state = 'FAILED' AND completed_at >= ?", since);
      const approvals = q.all('SELECT title, state FROM approvals WHERE decided_at >= ?', since);
      const recov = q.get("SELECT COUNT(*) n FROM activity WHERE kind = 'recover' AND ts >= ?", since)?.n ?? 0;
      const resps = q.all("SELECT title, state, last_outcome FROM responsibilities WHERE state != 'ENDED'");
      Object.assign(ctx.vars, { done, failed, approvals, recov, resps, since });
      ctx.log('observe', `Found ${done.length} completed tasks, ${approvals.length} decisions, ${recov} recoveries`);
    },
    async write(ctx) {
      const v = ctx.vars;
      let body = '';
      if (hasReasoningModel()) {
        body = (await complete({ role: 'utility', purpose: 'report', taskId: ctx.task.id, maxTokens: 900,
          system: 'Write a short, calm weekly operator report in Markdown for the person AUDA works for. Lead with what matters. No fluff.',
          prompt: JSON.stringify({ completed: v.done, failed: v.failed, decisions: v.approvals, recoveries: v.recov, responsibilities: v.resps }) })).text;
      }
      const md = `# ${ctx.input.title ?? 'What AUDA did'}\n\n*${new Date(v.since).toLocaleDateString()} – ${new Date().toLocaleDateString()}*\n\n${body ||
        `## Finished\n${v.done.map((t: any) => `- **${t.title}** — ${t.result_summary ?? ''}`).join('\n') || '- Nothing this period.'}\n\n## Your decisions\n${v.approvals.map((a: any) => `- ${a.title} — ${a.state}`).join('\n') || '- None needed.'}\n\n## Problems\n${v.failed.map((t: any) => `- ${t.title}: ${t.error}`).join('\n') || '- None.'}${v.recov ? `\n\nAUDA recovered automatically ${v.recov} time(s).` : ''}\n\n## Still responsible for\n${v.resps.map((r: any) => `- ${r.title} (${r.state.toLowerCase()})`).join('\n') || '- Nothing.'}\n`}`;
      const a = await ctx.artifact('report.md', md, { why: `${ctx.input.title ?? 'Recurring report'} you asked for` });
      ctx.notify('fyi', ctx.input.title ?? 'Your report is ready', `${v.done.length} things finished. Saved to ${a.path}.`);
      return { complete: `Report saved — ${v.done.length} finished, ${v.approvals.length} decisions.` };
    },
  },
  responsibility: {
    describe: (c) => `Writing “${c.title ?? 'a report'}” ${c.scheduleText}`,
    setup(resp) { const c = json<any>(resp.config_json, {}); addSchedule('responsibility', resp.id, c.schedule); },
    onWake: (resp) => ({ title: json<any>(resp.config_json, {}).title ?? 'Write the report', input: {} }),
  },
});

definePlaybook({
  id: 'routine.reminder',
  title: 'Reminder',
  description: 'Reminds you of something at the right time.',
  plan: () => [{ key: 'remind', title: 'Remind you' }],
  steps: {
    async remind(ctx) {
      ctx.notify('attention', ctx.input.text, ctx.input.detail);
      return { complete: `Reminded you: ${ctx.input.text}` };
    },
  },
  responsibility: {
    describe: (c) => `Reminding you ${c.scheduleText}: ${c.text}`,
    setup(resp) { const c = json<any>(resp.config_json, {}); addSchedule('responsibility', resp.id, c.schedule); },
    onWake: (resp) => ({ title: `Remind you: ${json<any>(resp.config_json, {}).text}`, input: {} }),
  },
});

definePlaybook({
  id: 'webhook.react',
  title: 'React to a webhook',
  description: 'Wakes when a named webhook arrives, records it and tells you if it matches what you care about.',
  plan: () => [
    { key: 'read', title: 'Read the payload' },
    { key: 'act', title: 'Decide whether you need to know' },
  ],
  steps: {
    async read(ctx) {
      const p = ctx.input.payload ?? {};
      const text = JSON.stringify(p, null, 2);
      await ctx.artifact(`webhook-${ctx.input.slug}.json`, text, { why: `Payload of the “${ctx.input.slug}” webhook`, mime: 'application/json' });
      ctx.vars.text = text;
      ctx.log('observe', `Webhook “${ctx.input.slug}” carried ${Object.keys(p).length} fields`, text.slice(0, 600));
    },
    async act(ctx) {
      const k: string[] = ctx.input.keywords ?? [];
      const matched = !k.length || k.some((w) => ctx.vars.text.toLowerCase().includes(w.toLowerCase()));
      if (matched) ctx.notify(ctx.input.notifyLevel ?? 'attention', `Webhook: ${ctx.input.slug}`, ctx.vars.text.slice(0, 280));
      return { complete: matched ? 'Told you about it.' : 'Recorded; nothing you asked to hear about.' };
    },
  },
  responsibility: {
    describe: (c) => `Listening for the “${c.slug}” webhook${c.keywords?.length ? ` mentioning ${c.keywords.join(', ')}` : ''}`,
    setup(resp) { const c = json<any>(resp.config_json, {}); addTrigger(resp.id, 'connector.webhook.received', { slug: c.slug }, `Webhook ${c.slug}`); },
    onWake: (resp, e) => ({ title: `Handle “${json<any>(resp.config_json, {}).slug}” webhook`, input: { payload: e.payload.body } }),
  },
});
