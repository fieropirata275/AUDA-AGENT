/**
 * Policy engine. Decides, for every capability use, whether AUDA may act on its
 * own, must ask, or must never act — and says why.
 */
import { capabilities, type Capability, type Level } from './capabilities.ts';
import { json, q } from '../core/db.ts';

export interface CompiledRule {
  effect: 'allow' | 'deny' | 'ask' | 'quiet' | 'budget';
  /** Capability ids, globs ('money.*') or risk selectors ('risk:reversible'). */
  capabilities: string[];
  resource?: string;
  resourceNot?: string;
  /** Local-time window in which the rule applies, e.g. {from: 20, to: 8}. */
  hours?: { from: number; to: number };
  maxPerDay?: number;
  /** For quiet rules: notification levels to keep silent. */
  levels?: string[];
  /** For budget rules: daily model budget in currency units. */
  dailyBudget?: number;
}

export interface Decision {
  verdict: 'allow' | 'ask' | 'deny';
  via: string;           // default | rule:<id> | override:<id>
  reason: string;
  capability: Capability;
}

export function globMatch(glob: string, value: string | undefined) {
  if (!value) return false;
  const re = new RegExp('^' + glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

function capMatches(sel: string, cap: Capability) {
  if (sel.startsWith('risk:')) return cap.risk === sel.slice(5);
  if (sel.startsWith('group:')) return cap.group.toLowerCase() === sel.slice(6).toLowerCase();
  return globMatch(sel, cap.id);
}

function inHours(h: { from: number; to: number }, d = new Date()) {
  const x = d.getHours() + d.getMinutes() / 60;
  return h.from <= h.to ? x >= h.from && x < h.to : x >= h.from || x < h.to;
}

export function activeRules(): { id: string; text: string; rule: CompiledRule; spaceId: string | null }[] {
  return q.all("SELECT id, text, compiled_json, space_id FROM rules WHERE state = 'active'")
    .map((r) => ({ id: r.id, text: r.text, rule: json<CompiledRule>(r.compiled_json, { effect: 'ask', capabilities: [] }), spaceId: r.space_id }));
}

export function ruleApplies(rule: CompiledRule, cap: Capability, resource: string | undefined, ruleId: string) {
  if (!rule.capabilities.some((s) => capMatches(s, cap))) return false;
  if (rule.resource && !globMatch(rule.resource, resource)) return false;
  if (rule.resourceNot && resource && globMatch(rule.resourceNot, resource)) return false;
  if (rule.hours && !inHours(rule.hours)) return false;
  if (rule.maxPerDay != null) {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const used = q.get('SELECT COUNT(*) n FROM audit_log WHERE decision = ? AND ts >= ?', `rule:${ruleId}`, since.getTime())?.n ?? 0;
    if (used >= rule.maxPerDay) return false;
  }
  return true;
}

const levelVerdict: Record<Level, Decision['verdict']> = { autonomous: 'allow', rule: 'ask', approval: 'ask', deny: 'deny' };

export function decide(capId: string, input: any, ctx: { spaceId?: string | null } = {}): Decision {
  const cap = capabilities[capId];
  if (!cap) throw new Error(`Unknown capability ${capId}`);
  const resource = cap.resource?.(input);
  const rules = activeRules().filter((r) => !r.spaceId || r.spaceId === ctx.spaceId)
    .filter((r) => ['allow', 'deny', 'ask'].includes(r.rule.effect) && ruleApplies(r.rule, cap, resource, r.id));

  const deny = rules.find((r) => r.rule.effect === 'deny');
  if (deny) return { verdict: 'deny', via: `rule:${deny.id}`, reason: `Your rule: “${deny.text}”`, capability: cap };

  // More specific rules (with a resource) win; on equal specificity, asking beats allowing.
  const spec = (r: CompiledRule) => (r.resource ? 2 : 0) + (r.resourceNot ? 1 : 0);
  const ranked = rules.filter((r) => r.rule.effect !== 'deny')
    .sort((a, b) => spec(b.rule) - spec(a.rule) || (a.rule.effect === 'ask' ? -1 : 1));
  if (ranked[0]) {
    const r = ranked[0];
    return r.rule.effect === 'allow'
      ? { verdict: 'allow', via: `rule:${r.id}`, reason: `Allowed by your rule: “${r.text}”`, capability: cap }
      : { verdict: 'ask', via: `rule:${r.id}`, reason: `Your rule says to ask: “${r.text}”`, capability: cap };
  }

  const override = q.get(
    "SELECT * FROM permissions WHERE capability = ? AND (scope_type = 'global' OR (scope_type = 'space' AND scope_id = ?)) ORDER BY scope_type = 'space' DESC LIMIT 1",
    capId, ctx.spaceId ?? null);
  if (override) {
    return { verdict: levelVerdict[override.level as Level], via: `override:${override.id}`, reason: `Permission set to ${override.level}`, capability: cap };
  }
  const reasons: Record<Level, string> = {
    autonomous: 'AUDA may do this on its own',
    rule: 'No rule allows this yet, so AUDA asks',
    approval: 'This always needs your approval',
    deny: 'AUDA may never do this',
  };
  return { verdict: levelVerdict[cap.level], via: 'default', reason: reasons[cap.level], capability: cap };
}

export function effectiveLevel(capId: string): Level {
  const o = q.get("SELECT level FROM permissions WHERE capability = ? AND scope_type = 'global'", capId);
  return (o?.level as Level) ?? capabilities[capId].level;
}

/** Notification levels silenced by quiet rules. */
export function quietLevels(): Set<string> {
  const s = new Set<string>();
  for (const r of activeRules()) if (r.rule.effect === 'quiet' && (!r.rule.hours || inHours(r.rule.hours))) r.rule.levels?.forEach((l) => s.add(l));
  return s;
}
