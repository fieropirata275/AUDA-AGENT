/**
 * Playbook: keep a server healthy.
 *
 * Watches a service's volume against its quota and the service process itself.
 * When usage crosses the threshold it investigates with real commands on AUDA's
 * computer, proposes a specific fix, asks only for what policy says needs
 * asking, verifies, writes it up, and goes back to watching.
 */
import { definePlaybook } from './types.ts';
import { addWatcher, registerProbe } from '../watchers/runner.ts';
import { dirSize } from '../computer/files.ts';
import { status as serviceStatus } from '../computer/services.ts';
import { q, json } from '../core/db.ts';
import { createRule } from '../policy/rules.ts';

const MB = 1024 * 1024;
const fmt = (b: number) => b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
const rel = (p: string) => p.replace(/^~\//, '');

registerProbe('disk', async (c, state) => {
  const used = dirSize(c.path);
  const pct = Math.round((used / c.quotaBytes) * 100);
  const armed = state.armed ?? true;
  const fire = armed && pct >= c.thresholdPct;
  const nextArmed = fire ? false : pct <= c.rearmPct ? true : armed;
  return {
    value: `${pct}% of ${fmt(c.quotaBytes)} quota`, fire,
    observation: { headline: `${c.path} is at ${pct}% of its ${fmt(c.quotaBytes)} quota`, usedBytes: used, pct },
    state: { armed: nextArmed, lastPct: pct, history: [...(state.history ?? []).slice(-59), [Date.now(), pct]] },
  };
});

registerProbe('service', async (c, state) => {
  const s = serviceStatus(c.service);
  const down = !s.running;
  const fire = down && !state.down;
  return { value: s.running ? `running (pid ${s.pid})` : 'not running', fire, observation: { headline: `${c.service} is not running` }, state: { down } };
});

definePlaybook({
  id: 'server.health',
  title: 'Keep a server healthy',
  description: 'Watches disk usage and the service process; investigates and fixes problems within your rules.',

  plan(input) {
    if (input.mode === 'restart') return [
      { key: 'svc_check', title: 'Check the service' },
      { key: 'svc_restart', title: 'Restart it' },
      { key: 'svc_verify', title: 'Confirm it stays up' },
      { key: 'svc_record', title: 'Record what happened' },
    ];
    return [
      { key: 'measure', title: 'Measure the volume' },
      { key: 'largest', title: 'Find what’s taking the space' },
      { key: 'cause', title: 'Work out why it’s growing' },
      { key: 'plan_fix', title: 'Decide on a safe fix' },
      { key: 'apply', title: 'Apply the fix' },
      { key: 'verify', title: 'Verify the volume is healthy' },
      { key: 'record', title: 'Write up what happened' },
    ];
  },

  steps: {
    async measure(ctx) {
      const p = rel(ctx.input.path);
      ctx.narrate(`Measuring ${ctx.input.path} against its ${fmt(ctx.input.quotaBytes)} quota.`);
      const r = await ctx.tool('terminal.exec', { cmd: `du -sb ${p} | cut -f1; du -sh ${p}/logs 2>/dev/null; df -h . | tail -1` });
      const bytes = Number(r.stdout.split('\n')[0]);
      const pct = Math.round((bytes / ctx.input.quotaBytes) * 100);
      Object.assign(ctx.vars, { before: bytes, beforePct: pct });
      ctx.log('observe', `${ctx.input.path} is at ${pct}% of its quota`, `${fmt(bytes)} used of ${fmt(ctx.input.quotaBytes)}.`, r);
      return { output: { bytes, pct }, narration: `${fmt(bytes)} of ${fmt(ctx.input.quotaBytes)} (${pct}%)` };
    },

    async largest(ctx) {
      const p = rel(ctx.input.path);
      ctx.narrate('Listing the largest files to see where the space went.');
      const r = await ctx.tool('terminal.exec', { cmd: `find ${p} -type f -printf '%s %P\\n' | sort -rn | head -40` });
      const files = r.stdout.trim().split('\n').filter(Boolean).map((l: string) => { const [s, ...n] = l.split(' '); return { size: Number(s), path: n.join(' ') }; });
      const rotated = files.filter((f: any) => /^logs\/app\.log\.\d+$/.test(f.path))
        .sort((a: any, b: any) => Number(a.path.split('.').pop()) - Number(b.path.split('.').pop()));
      const rotatedBytes = rotated.reduce((s: number, f: any) => s + f.size, 0);
      Object.assign(ctx.vars, { rotated, rotatedBytes, files: files.slice(0, 8) });
      const msg = rotated.length ? `Rotated logs take ${fmt(rotatedBytes)} across ${rotated.length} archives` : `No rotated archives; the biggest file is ${files[0]?.path} (${fmt(files[0]?.size ?? 0)})`;
      ctx.log('observe', msg, files.slice(0, 6).map((f: any) => `${fmt(f.size).padStart(8)}  ${f.path}`).join('\n'));
      return { output: { rotated: rotated.length, rotatedBytes }, narration: msg };
    },

    async cause(ctx) {
      const p = rel(ctx.input.path);
      ctx.narrate('Sampling growth for a few seconds — size alone doesn’t say whether it’s still growing.');
      const r = await ctx.tool('terminal.exec', { cmd: `du -sb ${p}/logs | cut -f1; sleep 3; du -sb ${p}/logs | cut -f1; tail -n 2 ${p}/logs/app.log | cut -c1-140; cat ${p}/config.json` });
      const [a, b] = r.stdout.split('\n').map(Number);
      const rate = Math.max(0, (b - a) / 3);
      const debug = /DEBUG/.test(r.stdout) || /"logLevel":\s*"debug"/.test(r.stdout);
      const cause = debug ? 'debug logging left on' : rate > 100 * 1024 ? 'unusually high log volume' : 'gradual log accumulation';
      const past = ctx.memories(`${ctx.input.service} disk incident logs`, 5).filter((m) => m.kind === 'episodic');
      const remaining = ctx.input.quotaBytes - b;
      const secondsToFull = remaining <= 0 ? 0 : rate > 0 ? Math.round(remaining / rate) : null;
      Object.assign(ctx.vars, { rate, cause, debug, secondsToFull, seenBefore: past.length > 0 });
      ctx.log('reason', debug ? 'Debug logging is switched on — that’s the growth' : `Growth looks like ${cause}`,
        `Logs grow ${fmt(rate)}/s.${secondsToFull === 0 ? ' The volume is already over its quota.' : secondsToFull != null ? ` At this rate the volume is full in ~${secondsToFull < 120 ? secondsToFull + ' s' : Math.round(secondsToFull / 60) + ' min'}.` : ''}${past.length ? ` This has happened before: ${past[0].title}.` : ''}`, r);
      if (ctx.input.manual && ctx.vars.beforePct < ctx.input.thresholdPct && !debug) {
        return { complete: `All healthy: ${ctx.vars.beforePct}% of quota, growing ${fmt(rate)}/s.` };
      }
      return { output: { rate, cause }, narration: `${fmt(rate)}/s — ${cause}` };
    },

    async plan_fix(ctx) {
      const v = ctx.vars;
      const dir = ctx.input.path;
      // Keep up to the 2 newest archives for debugging, but only while that leaves the volume at or below half its quota.
      const rotated = v.rotated as any[];
      const target = ctx.input.quotaBytes * 0.5 - (v.before - v.rotatedBytes);
      let keep = 0, kept = 0;
      while (keep < Math.min(2, rotated.length) && kept + rotated[keep].size <= target) kept += rotated[keep++].size;
      const old = rotated.slice(keep);
      const freeBytes = old.reduce((s, f) => s + f.size, 0);
      const actions: { capability: string; input: any }[] = [];
      if (old.length) actions.push({ capability: 'fs.delete', input: { dir, paths: old.map((f) => `${dir}/${f.path}`) } });
      if (v.debug) actions.push({ capability: 'service.configure', input: { service: ctx.input.service, key: 'logLevel', value: 'info' } });
      v.actions = actions;
      v.freeBytes = freeBytes;
      if (!actions.length) { v.decision = 'not-needed'; return { narration: 'Nothing safe to remove; will compress instead.' }; }

      ctx.narrate('Preparing a specific fix and checking what your rules allow.');
      const priorApprovals = q.all("SELECT decided_at FROM approvals WHERE capability = 'plan' AND state = 'approved' AND title LIKE ? ORDER BY decided_at DESC", `%${ctx.input.service}%`);
      const fill = v.secondsToFull === 0 ? null : v.secondsToFull != null ? (v.secondsToFull < 120 ? `about ${v.secondsToFull} seconds` : `about ${Math.round(v.secondsToFull / 60)} minutes`) : null;
      const what = [old.length ? `delete ${old.length} old rotated log archives (${fmt(freeBytes)})` : null, v.debug ? 'switch logging from debug back to info' : null].filter(Boolean).join(' and ');
      v.decision = await ctx.decide({
        title: `Clean up ${ctx.input.service} logs?`,
        summary: `${ctx.input.path} is ${v.beforePct >= 100 ? `over its ${fmt(ctx.input.quotaBytes)} quota (${v.beforePct}%)` : `at ${v.beforePct}% of its ${fmt(ctx.input.quotaBytes)} quota`} and growing ${fmt(v.rate)}/s${v.debug ? ' because debug logging is switched on' : ''}.${fill ? ` At this rate it fills in ${fill}.` : ''}`,
        recommendation: `${what[0].toUpperCase()}${what.slice(1)}.${keep ? ` The ${keep === 1 ? 'newest archive stays' : `${keep} newest archives stay`} so recent history is still there for debugging.` : ''}`,
        impact: v.debug ? `No downtime — ${ctx.input.service} picks up the new log level within a second.` : 'No downtime.',
        ifYes: `AUDA frees ${fmt(freeBytes)}${v.debug ? ' and stops the runaway growth' : ''}, then verifies the volume.`,
        ifNo: 'AUDA compresses the archives instead (reversible, nothing deleted) and leaves logging as it is. The volume will fill up again.',
        approveLabel: 'Clean up logs', rejectLabel: 'Don’t delete anything',
        evidence: [
          { label: 'Volume', value: `${fmt(v.before)} of ${fmt(ctx.input.quotaBytes)}` },
          { label: 'Growth', value: `${fmt(v.rate)}/s` },
          { label: 'Cause', value: v.debug ? 'DEBUG lines in app.log; config.json has logLevel=debug' : v.cause },
          ...(priorApprovals.length ? [{ label: 'History', value: `You approved the same fix ${priorApprovals.length === 1 ? 'once before' : `${priorApprovals.length} times before`} (last ${new Date(priorApprovals[0].decided_at).toLocaleDateString()})` }] : []),
        ],
      }, actions);
      return { output: { decision: v.decision }, narration: v.decision === 'not-needed' ? 'Your rules allow this — no need to ask.' : v.decision === 'approved' ? 'Approved.' : 'Declined — using the reversible option.' };
    },

    async apply(ctx) {
      const v = ctx.vars;
      if (v.decision === 'rejected' || !(v.actions as any[]).length) {
        const paths = (v.rotated as any[]).map((f) => `${ctx.input.path}/${f.path}`);
        if (!paths.length) return { narration: 'Nothing to change.' };
        ctx.narrate('Compressing rotated archives instead of deleting them.');
        const r = await ctx.tool('fs.compress', { dir: ctx.input.path, paths }, { why: 'You declined deletion; compression is reversible.' });
        v.applied = `Compressed ${r.files.length} archives (${fmt(r.before)} → ${fmt(r.after)}). Nothing deleted; logging unchanged.`;
        ctx.log('act', 'Compressed old logs instead of deleting them', v.applied);
        return { narration: v.applied };
      }
      const done: string[] = [];
      for (const a of v.actions as { capability: string; input: any }[]) {
        if (a.capability === 'fs.delete') {
          ctx.narrate(`Deleting ${a.input.paths.length} old archives.`);
          const r = await ctx.tool('fs.delete', a.input);
          done.push(`Deleted ${r.removed} old archives (${fmt(r.freed)})`);
        } else if (a.capability === 'service.configure') {
          ctx.narrate(`Switching ${a.input.service} back to ${a.input.value} logging.`);
          await ctx.tool('service.configure', a.input);
          done.push(`Set ${a.input.service} logging to ${a.input.value}`);
        }
      }
      v.applied = done.join('. ') + '.';
      ctx.log('act', 'Applied the fix', v.applied);
      return { narration: v.applied };
    },

    async verify(ctx) {
      const p = rel(ctx.input.path);
      ctx.narrate('Re-measuring to make sure the fix actually worked.');
      const r = await ctx.tool('terminal.exec', { cmd: `du -sb ${p} | cut -f1; sleep 2; du -sb ${p}/logs | cut -f1; sleep 2; du -sb ${p}/logs | cut -f1` });
      const [after, l1, l2] = r.stdout.split('\n').map(Number);
      const pct = Math.round((after / ctx.input.quotaBytes) * 100);
      const rate = Math.max(0, (l2 - l1) / 2);
      Object.assign(ctx.vars, { after, afterPct: pct, afterRate: rate });
      const healthy = pct < ctx.input.thresholdPct && rate < 100 * 1024;
      ctx.log(healthy ? 'observe' : 'problem', healthy ? `Healthy again: ${pct}% of quota` : `Still not healthy: ${pct}% of quota`,
        `Growth is now ${fmt(rate)}/s (was ${fmt(ctx.vars.rate)}/s).`, r);
      return { output: { pct, rate, healthy }, narration: `${pct}% of quota, growing ${fmt(rate)}/s` };
    },

    async record(ctx) {
      const v = ctx.vars;
      const date = new Date();
      const healthy = v.afterPct < ctx.input.thresholdPct && v.afterRate < 100 * 1024;
      const report = `# ${ctx.input.service}: disk usage incident

*${date.toLocaleString()} · handled by AUDA*

## What happened
${ctx.input.path} reached **${v.beforePct}%** of its ${fmt(ctx.input.quotaBytes)} quota, growing **${fmt(v.rate)}/s**.

## Cause
${v.debug ? 'Debug logging was switched on in `config.json`, so the service was writing verbose DEBUG lines (~450 bytes each, hundreds per second).' : v.cause}

## What AUDA did
${v.applied}
${v.decision === 'approved' ? '\nYou approved the cleanup.' : v.decision === 'not-needed' ? '\nYour rules allowed this without asking.' : v.decision === 'rejected' ? '\nYou declined deletion, so AUDA used the reversible option.' : ''}

## Result
Now at **${v.afterPct}%** of quota, growing ${fmt(v.afterRate)}/s. ${healthy ? 'Healthy.' : 'Still above the threshold — AUDA will keep watching closely.'}

## Largest files at the time
${(v.files as any[]).map((f) => `- \`${f.path}\` — ${fmt(f.size)}`).join('\n')}
`;
      const art = await ctx.artifact(`${ctx.input.service}-disk-incident.md`, report, { why: `Incident write-up for “${ctx.task.title}”` });
      ctx.remember({
        kind: 'episodic', title: `${ctx.input.service} disk incident — ${date.toLocaleDateString()} ${date.toTimeString().slice(0, 5)}`,
        content: `Volume hit ${v.beforePct}% (${fmt(v.rate)}/s, ${v.cause}). ${v.applied} Ended at ${v.afterPct}%.`,
        confidence: 0.95, data: { cause: v.cause, artifact: art.id },
      });
      if (v.decision !== 'rejected' && v.debug) {
        ctx.remember({
          kind: 'procedural', title: `Fixing runaway ${ctx.input.service} logs`,
          content: `When ${ctx.input.path} fills because debug logging is on: delete old rotated archives (keep up to the 2 newest while staying under half the quota) and set logLevel back to info in config.json. The service reloads config within a second; no restart needed.`,
          weight: 'established', confidence: 0.9,
        });
        ctx.remember({ kind: 'semantic', title: `${ctx.input.service} log volume in debug mode`, content: `In debug mode ${ctx.input.service} writes roughly ${fmt(v.rate)}/s of logs; in info mode only a few KB/s.`, confidence: 0.85 });
      }
      const summary = healthy
        ? `${v.applied.replace(/\.$/, '')}. Volume back to ${v.afterPct}%.`
        : `${v.applied.replace(/\.$/, '')}. Still at ${v.afterPct}% — watching closely.`;
      // After the same approval twice, offer a rule instead of asking a third time.
      const approvals = q.get("SELECT COUNT(*) n FROM approvals WHERE capability = 'plan' AND state = 'approved' AND title = ?", `Clean up ${ctx.input.service} logs?`)?.n ?? 0;
      const existing = q.get("SELECT id FROM rules WHERE origin = ? AND state != 'disabled'", `suggested:${ctx.input.service}-logs`);
      if (approvals >= 2 && !existing) {
        createRule(`AUDA may clean up ${ctx.input.service} logs (delete old rotated archives, switch debug logging off) without asking.`, {
          origin: `suggested:${ctx.input.service}-logs`, spaceId: ctx.task.space_id,
          compiled: { effect: 'allow', capabilities: ['fs.delete', 'service.configure'], resource: `*${ctx.input.service}*` },
          interpretation: `Allow deleting files and changing configuration, but only for ${ctx.input.service} (${ctx.input.path}). Everything else still asks.`,
        });
        ctx.log('reason', 'Suggested a rule so AUDA stops asking about this', `You approved the same cleanup ${approvals} times. Activate the rule in Needs you if you agree.`);
      }
      if (!healthy) {
        // Still over the line: re-arm the watcher so the responsibility wakes again instead of going quiet.
        for (const w of q.all("SELECT id, state_json FROM watchers WHERE responsibility_id = ? AND kind = 'disk'", ctx.task.responsibility_id)) {
          q.run('UPDATE watchers SET state_json = ?, next_check_at = ? WHERE id = ?', JSON.stringify({ ...json(w.state_json, {}), armed: true }), Date.now() + 20_000, w.id);
        }
      }
      ctx.notify(healthy ? 'completed' : 'attention', healthy ? `Fixed: ${ctx.input.service} disk usage` : `${ctx.input.service} still needs attention`, summary);
      return { complete: summary, output: { artifact: art.id } };
    },

    async svc_check(ctx) {
      const s = serviceStatus(ctx.input.service);
      ctx.vars.wasRunning = s.running;
      const r = await ctx.tool('terminal.exec', { cmd: `tail -n 3 services/${ctx.input.service}/logs/app.log 2>/dev/null | cut -c1-140; ls services/${ctx.input.service}` });
      ctx.log('observe', s.running ? `${ctx.input.service} is running again on its own` : `${ctx.input.service} is down`, undefined, r);
      if (s.running) return { complete: `${ctx.input.service} recovered by itself; nothing to do.` };
      return { narration: 'Service process is not running.' };
    },
    async svc_restart(ctx) {
      ctx.narrate(`Restarting ${ctx.input.service}.`);
      await ctx.tool('service.restart', { service: ctx.input.service }, {
        approval: {
          title: `Restart ${ctx.input.service}?`,
          summary: `${ctx.input.service} stopped running. Nothing is serving its requests right now.`,
          recommendation: 'Restart the service.', impact: 'It is already down; a restart takes about a second.',
          ifNo: 'AUDA leaves it down and keeps watching.', approveLabel: 'Restart', rejectLabel: 'Leave it down',
        },
      });
      return { narration: 'Restart issued.' };
    },
    async svc_verify(ctx) {
      await new Promise((r) => setTimeout(r, 2500));
      const s = serviceStatus(ctx.input.service);
      if (!s.running) throw new Error(`${ctx.input.service} did not stay up after restart`);
      ctx.log('observe', `${ctx.input.service} is up (pid ${s.pid})`);
      return { output: { pid: s.pid } };
    },
    async svc_record(ctx) {
      ctx.remember({ kind: 'episodic', title: `${ctx.input.service} restarted — ${new Date().toLocaleString()}`, content: `${ctx.input.service} had stopped; AUDA restarted it and confirmed it stayed up.`, data: { cause: 'process stopped' } });
      ctx.notify('completed', `Restarted ${ctx.input.service}`, 'It had stopped; it’s running again.');
      return { complete: `Restarted ${ctx.input.service}; it’s running again.` };
    },
  },

  responsibility: {
    describe: (c) => `Watching ${c.path} (alert at ${c.thresholdPct}% of ${fmt(c.quotaBytes)}) and the ${c.service} process`,
    setup(resp) {
      const c = json<any>(resp.config_json, {});
      addWatcher(resp.id, 'disk', { path: c.path, quotaBytes: c.quotaBytes, thresholdPct: c.thresholdPct, rearmPct: c.rearmPct ?? 60 }, c.intervalSec ?? 5, `Disk usage of ${c.path}`);
      addWatcher(resp.id, 'service', { service: c.service }, 10, `${c.service} process`);
    },
    onWake(resp, event) {
      const c = json<any>(resp.config_json, {});
      if (event.payload.kind === 'service') return { title: `Bring ${c.service} back up`, goal: `${c.service} stopped running`, input: { mode: 'restart' }, priority: 1 };
      if (event.type === 'responsibility.manual') return { title: `Check on ${c.service}`, goal: 'You asked AUDA to check now', input: { mode: 'disk', manual: true } };
      return { title: 'Investigate unexpected disk growth', goal: `${c.path} crossed ${c.thresholdPct}% of its quota`, input: { mode: 'disk' }, priority: 1 };
    },
  },
});
