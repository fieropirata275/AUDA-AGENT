/**
 * Playbook: open-ended work driven by a reasoning model.
 *
 * Each model turn is one durable step. Pending tool calls are checkpointed
 * before they run, so a crash or an approval pause resumes by executing the
 * same calls (deduplicated by the broker) instead of re-asking the model.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { definePlaybook, type StepCtx } from './types.ts';
import { complete, canUseTools } from '../models/router.ts';
import { getSetting, q } from '../core/db.ts';
import { ApprovalRejected, NeedsApproval, PolicyDenied } from '../tools/errors.ts';
import { HumanHasControl } from '../computer/index.ts';

const MAX_TURNS = 24;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'terminal', description: 'Run a bash command on your own Linux computer (cwd is your home). Read-only commands run freely; commands that change or delete things are checked against the user\'s rules and may pause for approval.', input_schema: { type: 'object', properties: { cmd: { type: 'string' }, why: { type: 'string', description: 'One sentence the user will see explaining why.' } }, required: ['cmd', 'why'] } },
  { name: 'read_file', description: 'Read a file in your workspace (~/...).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a file in your workspace (~/...).', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'browse', description: 'Open a URL in your browser and return its title and visible text.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'fetch_url', description: 'HTTP GET a URL and return the body (for APIs and raw files).', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'save_artifact', description: 'Save a work product (report, table, notes) for the user. Always explain why it exists.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'file name with extension, e.g. comparison.md' }, content: { type: 'string' }, why: { type: 'string' } }, required: ['name', 'content', 'why'] } },
  { name: 'remember', description: 'Store something worth remembering beyond this task.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['preference', 'semantic', 'relationship', 'procedural', 'project'] }, title: { type: 'string' }, content: { type: 'string' } }, required: ['kind', 'title', 'content'] } },
  { name: 'recall', description: 'Search your memory.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'ask_user', description: 'Ask the user to make a decision only they can make (preference, commitment, money, irreversible). Give exactly two options, your recommendation and why. Do not ask about harmless things.', input_schema: { type: 'object', properties: { question: { type: 'string' }, context: { type: 'string' }, option_a: { type: 'string' }, option_b: { type: 'string' }, recommendation: { type: 'string' } }, required: ['question', 'context', 'option_a', 'option_b', 'recommendation'] } },
  { name: 'run_on_device', description: 'Run a command on one of the user\'s own linked devices (not your computer). Only works where the user granted terminal access; it always asks the user first. Use only when the task is explicitly about that machine.', input_schema: { type: 'object', properties: { device: { type: 'string', description: 'device name' }, cmd: { type: 'string' }, why: { type: 'string' } }, required: ['device', 'cmd', 'why'] } },
  { name: 'narrate', description: 'Tell the user in one short sentence what you are doing now and why (operational reasoning, not private thoughts).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

function systemPrompt() {
  const name = q.get('SELECT name, user_name FROM identity LIMIT 1');
  const prefs = q.all("SELECT title, content FROM memories WHERE kind IN ('preference','identity') AND superseded_by IS NULL ORDER BY weight = 'defining' DESC, updated_at DESC LIMIT 12");
  return `You are ${name?.name ?? 'AUDA'}, a persistent digital operator working for ${name?.user_name ?? 'the user'}. You have your own Linux computer, browser and memory. You are executing one task autonomously; the user is not watching in real time.

Work like a calm, competent operator:
- Use narrate before meaningful phases with one sentence of operational reasoning ("I'm checking X because Y").
- Do the mechanical work yourself. Ask the user (ask_user) only for genuine judgment calls, with two concrete options and a recommendation.
- Save substantial results with save_artifact. Remember durable facts with remember.
- Never invent progress or results. If something fails, say what happened and what you'll try.
- Finish with a short plain summary of the outcome (2-4 sentences). That final message is shown to the user.

Linked devices of the user: ${q.all("SELECT name, state FROM devices WHERE revoked_at IS NULL").map((d) => `${d.name} (${d.state})`).join(', ') || 'none'}.

What you know about the user:
${prefs.map((p) => `- ${p.title}: ${p.content}`).join('\n') || '- (nothing yet)'}`;
}

async function runTool(ctx: StepCtx, name: string, input: any): Promise<string> {
  switch (name) {
    case 'narrate': ctx.narrate(input.text); ctx.log('reason', input.text); return 'ok';
    case 'terminal': {
      ctx.narrate(input.why);
      const r = await ctx.tool('terminal.exec', { cmd: input.cmd }, { why: input.why });
      return JSON.stringify({ exit: r.code, stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 2000) });
    }
    case 'read_file': return (await ctx.tool('fs.read', { path: input.path, maxBytes: 40_000 })).text;
    case 'write_file': return JSON.stringify(await ctx.tool('fs.write', { path: input.path, content: input.content }));
    case 'browse': { const p = await ctx.tool('browser.read', { url: input.url }); return `${p.title}\n${p.url}\n\n${p.text.slice(0, 15_000)}`; }
    case 'fetch_url': { const r = await ctx.tool('http.fetch', { url: input.url }); return `HTTP ${r.status}\n${r.text.slice(0, 15_000)}`; }
    case 'run_on_device': {
      const d = q.get("SELECT id, name FROM devices WHERE revoked_at IS NULL AND lower(name) LIKE lower(?)", `%${input.device}%`);
      if (!d) return `No linked device matches “${input.device}”.`;
      ctx.narrate(input.why);
      const r = await ctx.tool('device.exec', { deviceId: d.id, deviceName: d.name, cmd: input.cmd }, { why: input.why });
      return JSON.stringify({ exit: r.code, stdout: String(r.stdout).slice(0, 8000), stderr: String(r.stderr).slice(0, 2000) });
    }
    case 'save_artifact': { const a = await ctx.artifact(input.name, input.content, { why: input.why }); ctx.log('act', `Saved ${input.name}`, input.why); return `saved at ${a.path}`; }
    case 'remember': ctx.remember({ kind: input.kind, title: input.title, content: input.content }); return 'remembered';
    case 'recall': return JSON.stringify(ctx.memories(input.query, 6).map((m) => ({ kind: m.kind, title: m.title, content: m.content, weight: m.weight })));
    case 'ask_user': {
      const d = await ctx.decide({
        title: input.question, summary: input.context, recommendation: input.recommendation,
        approveLabel: input.option_a, rejectLabel: input.option_b,
        ifYes: input.option_a, ifNo: input.option_b,
      }, [{ capability: 'decision.ask', input: { question: input.question } }]);
      return d === 'approved' ? `The user chose: ${input.option_a}` : d === 'rejected' ? `The user chose: ${input.option_b}` : `Proceed with your recommendation: ${input.recommendation}`;
    }
    default: return `Unknown tool ${name}`;
  }
}

definePlaybook({
  id: 'agent',
  title: 'Open-ended task',
  description: 'AUDA plans and executes with its tools, pausing only for real decisions.',
  plan: () => [{ key: 'turn', title: 'Understand the goal' }],
  steps: {
    async turn(ctx) {
      if (!canUseTools()) throw new PolicyDenied('model', 'No reasoning model is connected. Connect Claude in Connections to let AUDA handle open-ended work');
      const v = ctx.vars;
      v.messages ??= [{ role: 'user', content: `Task: ${ctx.task.title}\n${ctx.task.goal ? `Details: ${ctx.task.goal}\n` : ''}${ctx.input.context ? `Context:\n${ctx.input.context}` : ''}` }];
      v.turns = (v.turns ?? 0);

      if (!v.pending) {
        if (v.turns >= MAX_TURNS) return { complete: 'Stopped after reaching the step limit for one task. What I found so far is in the activity timeline.' };
        const r = await complete({ role: 'reasoning', purpose: 'agent turn', taskId: ctx.task.id, system: systemPrompt(), messages: v.messages, tools: TOOLS, effort: getSetting('models.effort', 'medium') as any });
        v.turns++;
        v.messages.push({ role: 'assistant', content: r.content });
        if (r.stopReason === 'max_tokens') { v.messages.push({ role: 'user', content: 'Continue.' }); return { insert: [{ key: 'turn', title: 'Continue' }] }; }
        if (!r.toolUses.length) return { complete: r.text.trim() || 'Done.' };
        v.pending = r.toolUses;
        v.results = {};
      }

      for (const tu of v.pending as { id: string; name: string; input: any }[]) {
        if (v.results[tu.id] !== undefined) continue;
        try {
          v.results[tu.id] = { content: await runTool(ctx, tu.name, tu.input) };
        } catch (e) {
          if (e instanceof NeedsApproval || e instanceof HumanHasControl) throw e; // checkpointed; resumes here
          v.results[tu.id] = { content: e instanceof ApprovalRejected ? 'The user declined this action. Choose another approach or finish.' : e instanceof PolicyDenied ? `Not permitted: ${e.reason}` : `Error: ${(e as Error).message}`, is_error: true };
        }
      }
      v.messages.push({ role: 'user', content: (v.pending as any[]).map((tu) => ({ type: 'tool_result', tool_use_id: tu.id, content: v.results[tu.id].content, ...(v.results[tu.id].is_error ? { is_error: true } : {}) })) });
      const label = (v.pending as any[]).find((t) => t.name === 'narrate')?.input.text ?? (v.pending as any[]).map((t) => t.name.replace('_', ' ')).join(', ');
      v.pending = null; v.results = null;
      return { insert: [{ key: 'turn', title: 'Continue' }], narration: label };
    },
  },
});
