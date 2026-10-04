/**
 * Rules: natural language in, structured policy out. A rule is shown back to
 * you as AUDA's interpretation and only takes effect once you activate it.
 */
import { getSetting, insert, json, now, q, setSetting, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import type { CompiledRule } from './engine.ts';
import { capabilities } from './capabilities.ts';
import { complete, hasReasoningModel } from '../models/router.ts';

interface Compiled { compiled: CompiledRule; interpretation: string }

const CAP_WORDS: [RegExp, string[], string][] = [
  [/\b(spend|pay|purchase|buy|money)\b/, ['money.spend'], 'spending money'],
  [/\b(e-?mails?)\b/, ['email.send'], 'sending email'],
  [/\b(contact|message|text|dm|slack|discord)\b/, ['email.send', 'message.send'], 'contacting people'],
  [/\b(delet\w*|remov\w*|erase)\b/, ['fs.delete', 'terminal.destructive'], 'deleting files'],
  [/\brestart\w*\b/, ['service.restart'], 'restarting services'],
  [/\b(publish|post)\b/, ['github.comment', 'message.send', 'browser.submit'], 'publishing or posting'],
  [/\b(submit|forms?)\b/, ['browser.submit'], 'submitting forms'],
  [/\b(re-?run|retry)\b.*\b(ci|workflow|build|actions)\b|\b(ci|workflow)\b.*\b(re-?run|retry)\b/, ['github.rerun_workflow'], 're-running CI'],
  [/\b(comment)\b/, ['github.comment'], 'commenting on GitHub'],
  [/\b(compress|archive|rotate)\b/, ['fs.compress'], 'compressing or archiving files'],
  [/\b(config|configuration|log level|logging)\b/, ['service.configure'], 'changing service configuration'],
  [/\b(run jobs?|commands?) on (my|the) (desktop|laptop|machine|computer)\b/, ['device.exec'], 'running jobs on your devices'],
];

function hoursOf(s: string): CompiledRule['hours'] | undefined {
  const after = s.match(/\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(pm|am|h)?/);
  const before = s.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(pm|am|h)?/);
  const conv = (m: RegExpMatchArray) => { let h = Number(m[1]); if (m[3] === 'pm' && h < 12) h += 12; return h + Number(m[2] ?? 0) / 60; };
  if (after) return { from: conv(after), to: before ? conv(before) : 8 };
  if (/\b(at night|overnight)\b/.test(s)) return { from: 22, to: 7 };
  if (/\bweekends?\b/.test(s)) return undefined;
  return undefined;
}
const hh = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

export function compileBuiltin(text: string): Compiled | null {
  const s = text.toLowerCase().trim();

  const budget = s.match(/(?:spend|use)\s+(?:up to|at most|max(?:imum)?)\s*[€$£]?\s*(\d+(?:[.,]\d+)?)\s*[€$£]?\s*(?:in|on|of)?\s*(?:api|model|llm|ai)?\s*(?:credits?|tokens?)?\s*(?:per|a|each)\s*(day|month)/);
  if (budget) {
    const amount = Number(budget[1].replace(',', '.'));
    return { compiled: { effect: 'budget', capabilities: [], dailyBudget: budget[2] === 'day' ? amount : undefined },
      interpretation: `Cap AUDA's model spending at ${amount} per ${budget[2]}. When the cap is reached, model-dependent work pauses until the next ${budget[2]}.` };
  }

  if (/\b(don'?t|do not|never)\s+(wake|ping|notify|bother|interrupt)\b/.test(s)) {
    const levels = /\b(low[- ]priority|completed|finished|done)\b/.test(s) ? ['completed', 'fyi'] : /\bfyi|info\b/.test(s) ? ['fyi'] : ['completed', 'fyi', 'watching'];
    const hours = hoursOf(s) ?? (/\b(wake)\b/.test(s) ? { from: 22, to: 8 } : undefined);
    return { compiled: { effect: 'quiet', capabilities: [], levels, hours },
      interpretation: `Don't interrupt you for ${levels.join(' or ')} notifications${hours ? ` between ${hh(hours.from)} and ${hh(hours.to)}` : ''}. They still appear in your inbox. Approvals and urgent problems still reach you.` };
  }

  const caps = new Set<string>(); const labels: string[] = [];
  for (const [re, ids, label] of CAP_WORDS) if (re.test(s)) { ids.forEach((i) => caps.add(i)); labels.push(label); }
  const reversible = /\b(reversible|safely fix|safe fixes?|undoable)\b/.test(s);
  if (reversible) { caps.add('risk:reversible'); labels.push('reversible fixes'); }
  if (!caps.size) return null;

  const path = s.match(/(?:outside|except(?: in)?|other than)\s+(\/[\w./-]*|~\/[\w./-]*)/);
  const inPath = s.match(/\b(?:in|under|inside|within)\s+(\/[\w./-]+|~\/[\w./-]+)/);
  const named = s.match(/\b(?:the|this|my)\s+([\w.-]+-[\w.-]+|[\w.-]+\d)\s*(?:service|container|server|vm|repo)?\b/);
  const hours = hoursOf(s);
  const negated = /\b(never|don'?t|do not|must not)\b/.test(s);
  const askish = /\b(ask|check with|confirm)\b/.test(s) || (negated && /\bwithout (asking|checking)\b/.test(s));
  const permissive = /\b(can|may|allowed to|go ahead|feel free|do it|without asking)\b/.test(s);
  const effect: CompiledRule['effect'] = askish && (negated || /\b(always|before)\b/.test(s)) ? 'ask' : negated ? 'deny' : permissive ? 'allow' : 'ask';

  const compiled: CompiledRule = { effect, capabilities: [...caps] };
  if (path) compiled.resourceNot = path[1].replace(/[.,;:!?]+$/, '').replace(/\/$/, '') + '*';
  else if (inPath) compiled.resource = '*' + inPath[1].replace(/[.,;:!?]+$/, '').replace(/^~\//, '') + '*';
  else if (named && !/^(my|the)$/.test(named[1])) compiled.resource = `*${named[1]}*`;
  if (/development server|dev server|staging/.test(s)) compiled.resource = compiled.resource ?? '*services*';
  if (hours) compiled.hours = hours;
  const maxPerDay = s.match(/\b(?:up to|at most)\s+(\d+)\s+times?\s+(?:a|per)\s+day/); if (maxPerDay) compiled.maxPerDay = Number(maxPerDay[1]);

  const verb = { allow: 'Let AUDA do', deny: 'Never let AUDA do', ask: 'Always ask before', quiet: '', budget: '' }[effect];
  const what = labels.join(', ');
  const where = compiled.resourceNot ? ` anywhere except ${compiled.resourceNot.replace(/\*$/, '')}` : compiled.resource ? ` — only for ${compiled.resource.replace(/\*/g, '')}` : '';
  const when = hours ? ` between ${hh(hours.from)} and ${hh(hours.to)}` : '';
  const capList = [...caps].map((c) => c.startsWith('risk:') ? `any ${c.slice(5)} action` : capabilities[c]?.title ?? c).join(', ');
  return { compiled, interpretation: `${verb} ${what}${where}${when}${effect === 'allow' ? ' without asking' : ''}. Covers: ${capList}.${effect === 'allow' ? ' Anything outside this still follows your other rules.' : ''}` };
}

export async function compileRule(text: string): Promise<Compiled | null> {
  if (hasReasoningModel()) {
    try {
      const capList = Object.values(capabilities).map((c) => `${c.id} (${c.title}; risk ${c.risk})`).join('\n');
      const r = await complete({
        role: 'utility', purpose: 'rule compilation', maxTokens: 800,
        system: 'You compile a user\'s natural-language rule for an autonomous operator into JSON policy. Respond with JSON only: {"effect":"allow|deny|ask|quiet|budget","capabilities":[ids or "risk:<risk>"],"resource"?:glob,"resourceNot"?:glob,"hours"?:{"from":h,"to":h},"maxPerDay"?:n,"levels"?:[notification levels fyi|completed|attention|watching],"dailyBudget"?:number,"interpretation":"one or two plain sentences restating exactly what will and won\'t happen"}. Be conservative: if unsure between allow and ask, choose ask.',
        prompt: `Capabilities:\n${capList}\n\nRule: ${text}`,
      });
      const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
      const { interpretation, ...compiled } = j;
      if (compiled.effect && Array.isArray(compiled.capabilities)) return { compiled, interpretation };
    } catch { /* fall back to the built-in compiler */ }
  }
  return compileBuiltin(text);
}

export function createRule(text: string, o: { compiled: CompiledRule; interpretation: string; origin?: string; spaceId?: string | null; state?: 'draft' | 'active' }) {
  const id = uid('rule');
  insert('rules', { id, text, compiled_json: JSON.stringify(o.compiled), interpretation: o.interpretation, state: o.state ?? 'draft', origin: o.origin ?? 'user', space_id: o.spaceId ?? undefined, created_at: now(), activated_at: o.state === 'active' ? now() : undefined });
  changed('rule', id);
  if (o.state === 'active') applySideEffects(o.compiled);
  return id;
}

function applySideEffects(c: CompiledRule) {
  if (c.effect === 'budget' && c.dailyBudget != null) {
    setSetting('models', { ...getSetting<any>('models', {}), dailyBudget: c.dailyBudget });
    changed('settings', 'models');
  }
}

export function activateRule(id: string) {
  const r = q.get('SELECT * FROM rules WHERE id = ?', id);
  if (!r) throw new Error('No such rule');
  update('rules', id, { state: 'active', activated_at: now() });
  applySideEffects(json(r.compiled_json, {} as CompiledRule));
  changed('rule', id);
  activity('user', `Rule activated: “${r.text}”`, { detail: r.interpretation });
  emit('rule.activated', { subjectType: 'rule', subjectId: id });
}
export function disableRule(id: string) { update('rules', id, { state: 'disabled' }); changed('rule', id); }
export function deleteRule(id: string) { q.run('DELETE FROM rules WHERE id = ?', id); changed('rule', id, true); }
