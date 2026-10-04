/**
 * Consolidation: turns many small episodic memories into structured
 * understanding, expires scratch memory, and lets unreinforced mentions fade.
 */
import { json, now, q, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { remember } from './service.ts';
import { complete, hasReasoningModel } from '../models/router.ts';

export async function consolidate(reason = 'scheduled') {
  const t = now();
  let expired = 0, merged = 0, faded = 0;

  // 1. Expire working memory and anything past its expiry policy (pinned memories never expire).
  for (const r of q.all('SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ? AND pinned = 0', t)) {
    q.run('DELETE FROM memories WHERE id = ?', r.id); q.run('DELETE FROM memories_fts WHERE id = ?', r.id);
    changed('memory', r.id, true); expired++;
  }

  // 2. Fold episodic memories per responsibility into one operational understanding.
  const groups = q.all(`SELECT responsibility_id, COUNT(*) n FROM memories WHERE kind = 'episodic' AND superseded_by IS NULL
                         AND responsibility_id IS NOT NULL GROUP BY responsibility_id HAVING n >= 3`);
  for (const g of groups) {
    const resp = q.get('SELECT * FROM responsibilities WHERE id = ?', g.responsibility_id);
    if (!resp) continue;
    const eps = q.all("SELECT * FROM memories WHERE kind = 'episodic' AND responsibility_id = ? AND superseded_by IS NULL ORDER BY created_at", g.responsibility_id);
    let content: string;
    if (hasReasoningModel()) {
      content = (await complete({
        role: 'utility', purpose: 'memory consolidation', maxTokens: 400,
        system: 'You consolidate an autonomous operator\'s episodic memories into one short, factual understanding. 3-6 sentences. No preamble.',
        prompt: `Responsibility: ${resp.title}\n\nEpisodes:\n${eps.map((e) => `- ${new Date(e.created_at).toISOString()}: ${e.title} — ${e.content}`).join('\n')}`,
      })).text.trim();
    } else {
      const first = new Date(eps[0].created_at), last = new Date(eps[eps.length - 1].created_at);
      const causes = new Map<string, number>();
      for (const e of eps) { const c = json<any>(e.data_json, {}).cause; if (c) causes.set(c, (causes.get(c) ?? 0) + 1); }
      const top = [...causes.entries()].sort((a, b) => b[1] - a[1])[0];
      content = `AUDA has handled ${eps.length} episodes for “${resp.title}” between ${first.toLocaleDateString()} and ${last.toLocaleDateString()}.`
        + (top ? ` The usual cause is ${top[0]} (${top[1]} of ${eps.length}).` : '')
        + ` Most recent: ${eps[eps.length - 1].title}. ${eps[eps.length - 1].content}`;
    }
    const id = remember({
      kind: 'operational', title: `How “${resp.title}” usually goes`, content, source: 'consolidation',
      responsibilityId: resp.id, spaceId: resp.space_id, weight: 'established', confidence: 0.85, expiresAt: null,
      data: { episodes: eps.length },
    });
    for (const e of eps.slice(0, -1)) { update('memories', e.id, { superseded_by: id }); changed('memory', e.id); }
    merged += eps.length - 1;
  }

  // 3. Fade single mentions nobody has reinforced in 60 days.
  for (const r of q.all("SELECT id, confidence FROM memories WHERE weight = 'mentioned' AND pinned = 0 AND reinforced = 1 AND updated_at < ?", t - 60 * 24 * 3600_000)) {
    update('memories', r.id, { confidence: Math.max(0.3, r.confidence - 0.1) }); changed('memory', r.id); faded++;
  }

  if (expired + merged + faded > 0 || reason === 'manual') {
    activity('memory', 'Consolidated memory', { detail: `${merged} episodes folded into understanding · ${expired} expired · ${faded} faded` });
  }
  emit('memory.consolidated', { payload: { expired, merged, faded, reason } });
  return { expired, merged, faded };
}
