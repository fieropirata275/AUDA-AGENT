import { motion } from 'motion/react';
import type { Rule } from '../lib/types';
import { fm } from '../motion/spring';
import { post, api } from '../lib/api';
import { Button } from './controls';
import { Morph } from '../motion/Morph';

const EFFECT: Record<string, [string, string]> = {
  allow: ['May do without asking', 'settled'], deny: ['Never', 'problem'], ask: ['Always asks first', 'attention'], quiet: ['Stay quiet', ''], budget: ['Budget', ''],
};

export function RuleCard({ rule }: { rule: Rule }) {
  const c = rule.compiled ?? {};
  const [label, tone] = EFFECT[c.effect] ?? ['Rule', ''];
  return (
    <motion.div layout className={`rule-card s-${rule.state}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: rule.state === 'disabled' ? 0.55 : 1, y: 0 }} transition={fm.glide}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Morph shape={rule.state === 'active' ? 'check' : rule.state === 'draft' ? 'dots' : 'pause'} size={18} color={rule.state === 'active' ? 'var(--settled)' : 'var(--ink-3)'} />
        <div className="grow">
          <div className="rule-text">“{rule.text}”</div>
          <div className="rule-interp"><span className="label">How AUDA reads it · </span>{rule.interpretation}</div>
          <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
            <span className={`chip ${tone}`}>{label}</span>
            {(c.capabilities ?? []).map((x: string) => <span key={x} className="chip mono">{x}</span>)}
            {c.resource && <span className="chip">only {c.resource.replace(/\*/g, '')}</span>}
            {c.resourceNot && <span className="chip">except {c.resourceNot.replace(/\*/g, '')}</span>}
            {c.hours && <span className="chip">{String(Math.floor(c.hours.from)).padStart(2, '0')}:00–{String(Math.floor(c.hours.to)).padStart(2, '0')}:00</span>}
            {c.levels && <span className="chip">{c.levels.join(', ')}</span>}
            {c.dailyBudget != null && <span className="chip">{c.dailyBudget}/day</span>}
            {rule.state === 'active' && rule.hits > 0 && <span className="chip settled">used {rule.hits}×</span>}
            {rule.origin?.startsWith('suggested') && rule.state === 'draft' && <span className="chip accent">Suggested by AUDA</span>}
          </div>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
        {rule.state === 'draft' && <>
          <Button size="sm" variant="ghost" onClick={() => api(`/api/rules/${rule.id}`, { method: 'DELETE' })}>Discard</Button>
          <Button size="sm" variant="primary" icon="check" onClick={() => post(`/api/rules/${rule.id}/activate`)}>Activate rule</Button>
        </>}
        {rule.state === 'active' && <Button size="sm" variant="ghost" onClick={() => post(`/api/rules/${rule.id}/disable`)}>Turn off</Button>}
        {rule.state === 'disabled' && <>
          <Button size="sm" variant="ghost" onClick={() => api(`/api/rules/${rule.id}`, { method: 'DELETE' })}>Delete</Button>
          <Button size="sm" onClick={() => post(`/api/rules/${rule.id}/activate`)}>Turn back on</Button>
        </>}
      </div>
    </motion.div>
  );
}
