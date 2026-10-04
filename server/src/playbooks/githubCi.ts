/** Playbook: watch CI on a repository and handle failures within your rules. */
import { definePlaybook } from './types.ts';
import { addWatcher } from '../watchers/runner.ts';
import { json } from '../core/db.ts';
import { complete, hasReasoningModel } from '../models/router.ts';

const FLAKY = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|rate limit|503 Service|502 Bad Gateway|network|timed out|Could not resolve host|runner .* lost)/i;

definePlaybook({
  id: 'github.ci',
  title: 'Watch CI',
  description: 'Notices failing GitHub Actions runs, reads the logs and proposes the right next step.',
  plan: () => [
    { key: 'inspect', title: 'Inspect the failed run' },
    { key: 'logs', title: 'Read the failing logs' },
    { key: 'diagnose', title: 'Diagnose the failure' },
    { key: 'act', title: 'Take the next step' },
  ],
  steps: {
    async inspect(ctx) {
      const { repo, runId } = ctx.input;
      const jobs = (await ctx.tool('github.read', { repo, path: `/repos/${repo}/actions/runs/${runId}/jobs` })).jobs as any[];
      const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
      ctx.vars.failed = failed.map((j) => ({ id: j.id, name: j.name, step: j.steps?.find((s: any) => s.conclusion === 'failure')?.name }));
      ctx.log('observe', `${failed.length} of ${jobs.length} jobs failed`, ctx.vars.failed.map((j: any) => `${j.name} → ${j.step ?? '?'}`).join('\n'));
    },
    async logs(ctx) {
      const out: string[] = [];
      for (const j of (ctx.vars.failed as any[]).slice(0, 2)) {
        ctx.narrate(`Reading logs for “${j.name}”.`);
        const text: string = await ctx.tool('github.read', { repo: ctx.input.repo, path: `/repos/${ctx.input.repo}/actions/jobs/${j.id}/logs`, raw: true });
        out.push(`## ${j.name}\n${text.split('\n').slice(-80).join('\n')}`);
      }
      ctx.vars.logs = out.join('\n\n').slice(-12_000);
      await ctx.artifact(`ci-${ctx.input.runId}.log`, ctx.vars.logs, { why: `Failing log tail for ${ctx.input.repo} run ${ctx.input.runId}` });
    },
    async diagnose(ctx) {
      const flaky = FLAKY.test(ctx.vars.logs);
      let diagnosis = flaky ? 'Looks like an infrastructure blip (network/timeout), not a code problem.' : 'Looks like a real failure in the code or tests.';
      if (hasReasoningModel()) {
        diagnosis = (await complete({ role: 'coding', purpose: 'CI diagnosis', taskId: ctx.task.id, maxTokens: 500,
          system: 'You diagnose CI failures from log tails. 2-4 sentences: the failing step, the likely root cause, and whether a re-run could plausibly pass (say "flaky: yes" or "flaky: no" at the end).',
          prompt: ctx.vars.logs })).text.trim();
      }
      ctx.vars.flaky = hasReasoningModel() ? /flaky:\s*yes/i.test(diagnosis) : flaky;
      ctx.vars.diagnosis = diagnosis;
      ctx.log('reason', ctx.vars.flaky ? 'Probably flaky — a re-run may pass' : 'Probably a real failure', diagnosis);
    },
    async act(ctx) {
      const { repo, runId, runName, branch, url } = ctx.input;
      if (ctx.vars.flaky) {
        await ctx.tool('github.rerun_workflow', { repo, runId }, {
          approval: {
            title: `Re-run “${runName}” on ${repo}?`,
            summary: `It failed on ${branch}. ${ctx.vars.diagnosis}`,
            recommendation: 'Re-run only the failed jobs.', impact: 'Uses a few CI minutes. No code changes.',
            ifNo: 'AUDA leaves it failed and keeps watching.', approveLabel: 'Re-run failed jobs', rejectLabel: 'Leave it',
          },
        });
        ctx.notify('fyi', `Re-ran ${runName} on ${repo}`, ctx.vars.diagnosis);
        return { complete: `Re-ran the failed jobs of ${runName}. ${ctx.vars.diagnosis}` };
      }
      ctx.notify('attention', `${runName} failed on ${repo}@${branch}`, `${ctx.vars.diagnosis}\n${url}`);
      ctx.remember({ kind: 'episodic', title: `CI failure on ${repo} — ${new Date().toLocaleDateString()}`, content: ctx.vars.diagnosis, data: { cause: ctx.vars.flaky ? 'flaky infrastructure' : 'code failure' } });
      return { complete: `Reported to you: ${ctx.vars.diagnosis}` };
    },
  },
  responsibility: {
    describe: (c) => `Watching GitHub Actions on ${c.repo}${c.branch ? `@${c.branch}` : ''}`,
    setup(resp) { const c = json<any>(resp.config_json, {}); addWatcher(resp.id, 'github_ci', { repo: c.repo, branch: c.branch }, c.intervalSec ?? 120, `CI on ${c.repo}`); },
    onWake(resp, e) {
      if (e.type !== 'watcher.fired' && e.type !== 'connector.github.workflow_failed') return null;
      return { title: `Look into failing CI on ${e.payload.repo}`, input: { repo: e.payload.repo, runId: e.payload.runId, runName: e.payload.runName, branch: e.payload.branch, url: e.payload.url }, priority: 1 };
    },
  },
});
