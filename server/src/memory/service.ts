/**
 * Memory Service. Memory is typed understanding, not a pile of chat fragments.
 *
 *   identity · preference · episodic · project · operational · semantic
 *   relationship · procedural · working
 *
 * Every memory carries source, confidence, scope, weight (mentioned →
 * established → defining), sensitivity and an expiry policy. Repeated
 * observations reinforce an existing memory instead of duplicating it.
 */
import { insert, json, now, q, uid, update, type Row } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { currentUserId } from '../core/context.ts';
import { emit } from '../core/bus.ts';

export const MEMORY_KINDS = ['identity', 'preference', 'episodic', 'project', 'operational', 'semantic', 'relationship', 'procedural', 'working'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export interface MemoryInput {
  kind: MemoryKind | string;
  title: string;
  content: string;
  source: string;
  sourceRef?: string;
  confidence?: number;
  scope?: 'global' | 'space' | 'responsibility';
  spaceId?: string | null;
  responsibilityId?: string | null;
  weight?: 'mentioned' | 'established' | 'defining' | string;
  sensitivity?: 'normal' | 'personal' | 'secret';
  expiresAt?: number | null;
  pinned?: boolean;
  data?: any;
  userId?: string;
}

const DEFAULT_TTL: Partial<Record<string, number>> = { working: 24 * 3600_000, operational: 30 * 24 * 3600_000 };

export function remember(m: MemoryInput): string {
  const owner = m.userId ?? (['chat', 'user'].includes(m.source) ? currentUserId() : null);
  const existing = q.get(
    `SELECT * FROM memories WHERE kind = ? AND lower(title) = lower(?) AND superseded_by IS NULL
       AND IFNULL(space_id,'') = IFNULL(?, '') AND IFNULL(responsibility_id,'') = IFNULL(?, '') AND IFNULL(user_id,'') = IFNULL(?, '')`,
    m.kind, m.title, m.spaceId ?? null, m.responsibilityId ?? null, owner);
  const t = now();
  if (existing) {
    const reinforced = existing.reinforced + 1;
    const weight = existing.weight === 'defining' || m.weight === 'defining' ? 'defining'
      : reinforced >= 3 || m.weight === 'established' ? 'established' : existing.weight;
    update('memories', existing.id, {
      content: m.content, reinforced, weight, updated_at: t, last_used_at: t,
      confidence: Math.min(0.99, Math.max(existing.confidence, m.confidence ?? 0.8) + 0.03),
      data_json: m.data ? JSON.stringify({ ...json(existing.data_json, {}), ...m.data }) : undefined,
      expires_at: m.expiresAt ?? (DEFAULT_TTL[m.kind] ? t + DEFAULT_TTL[m.kind]! : undefined),
    });
    q.run('UPDATE memories_fts SET title = ?, content = ? WHERE id = ?', m.title, m.content, existing.id);
    changed('memory', existing.id);
    emit('memory.updated', { subjectType: 'memory', subjectId: existing.id });
    return existing.id;
  }
  const id = uid('mem');
  insert('memories', {
    id, kind: m.kind, title: m.title, content: m.content, data_json: JSON.stringify(m.data ?? {}),
    source: m.source, source_ref: m.sourceRef, confidence: m.confidence ?? 0.8,
    scope: m.scope ?? (m.responsibilityId ? 'responsibility' : m.spaceId ? 'space' : 'global'),
    space_id: m.spaceId ?? undefined, responsibility_id: m.responsibilityId ?? undefined,
    weight: m.weight ?? 'mentioned', pinned: m.pinned ? 1 : 0, sensitivity: m.sensitivity ?? 'normal',
    user_id: owner ?? undefined,
    expires_at: m.expiresAt === undefined ? (DEFAULT_TTL[m.kind] ? t + DEFAULT_TTL[m.kind]! : undefined) : m.expiresAt ?? undefined,
    created_at: t, updated_at: t,
  });
  q.run('INSERT INTO memories_fts (id, title, content) VALUES (?, ?, ?)', id, m.title, m.content);
  changed('memory', id);
  emit('memory.created', { subjectType: 'memory', subjectId: id, payload: { kind: m.kind } });
  return id;
}

const WEIGHT_SCORE: Record<string, number> = { defining: 3, established: 1.5, mentioned: 0 };

/** Retrieve relevant memories. Ranks by text relevance, weight, pinning and recency. */
export function recall(query: string, o: { kinds?: string[]; spaceId?: string | null; responsibilityId?: string | null; limit?: number; includeSecret?: boolean } = {}): Row[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  let rows: Row[];
  if (terms.length) {
    const match = terms.slice(0, 12).map((t) => `"${t}"*`).join(' OR ');
    rows = q.all(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.id
                  WHERE memories_fts MATCH ? AND m.superseded_by IS NULL LIMIT 80`, match);
  } else {
    rows = q.all('SELECT *, 0 AS rank FROM memories WHERE superseded_by IS NULL ORDER BY updated_at DESC LIMIT 80');
  }
  const t = now();
  return rows
    .filter((r) => (!r.expires_at || r.expires_at > t) && (o.includeSecret || r.sensitivity !== 'secret'))
    .filter((r) => !r.user_id || r.user_id === currentUserId())
    .filter((r) => !o.kinds || o.kinds.includes(r.kind))
    .filter((r) => r.scope === 'global' || (o.spaceId && r.space_id === o.spaceId) || (o.responsibilityId && r.responsibility_id === o.responsibilityId) || (!o.spaceId && !o.responsibilityId))
    .map((r) => ({ ...r, score: -r.rank + WEIGHT_SCORE[r.weight] + (r.pinned ? 4 : 0) + r.confidence - (t - r.updated_at) / (30 * 24 * 3600_000) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, o.limit ?? 8);
}

export function editMemory(id: string, patch: Partial<{ title: string; content: string; kind: string; weight: string; pinned: boolean; scope: string; space_id: string | null; sensitivity: string; expires_at: number | null; confidence: number }>) {
  const row = q.get('SELECT * FROM memories WHERE id = ?', id);
  if (!row) throw new Error('No such memory');
  update('memories', id, {
    ...patch, pinned: patch.pinned === undefined ? undefined : patch.pinned ? 1 : 0,
    // A human correction is the most reliable source there is.
    source: patch.content || patch.title ? 'user' : undefined, confidence: patch.content || patch.title ? 0.99 : patch.confidence,
    updated_at: now(),
  });
  if (patch.title || patch.content) q.run('UPDATE memories_fts SET title = ?, content = ? WHERE id = ?', patch.title ?? row.title, patch.content ?? row.content, id);
  changed('memory', id);
  emit('memory.updated', { subjectType: 'memory', subjectId: id });
}

export function forget(id: string) {
  q.run('DELETE FROM memories WHERE id = ?', id);
  q.run('DELETE FROM memories_fts WHERE id = ?', id);
  changed('memory', id, true);
}
