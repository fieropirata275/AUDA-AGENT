/**
 * Watchers: cheap, edge-triggered observations. They never call a model.
 * They run on their own cadence, remember what they last saw, and only wake
 * a responsibility when something meaningful changes.
 */
import { insert, json, now, q, uid, update, type Row } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';

export interface ProbeResult {
  value: string;              // short human value, e.g. "83% of quota"
  fire: boolean;
  observation?: Record<string, any>;
  state: Record<string, any>; // persisted between checks
}
type Probe = (config: any, state: Record<string, any>, w: Row) => Promise<ProbeResult>;
const probes = new Map<string, Probe>();
export const registerProbe = (kind: string, p: Probe) => probes.set(kind, p);

export function addWatcher(responsibilityId: string, kind: string, config: any, intervalSec: number, description: string) {
  const id = uid('wat');
  insert('watchers', { id, responsibility_id: responsibilityId, kind, config_json: JSON.stringify(config), interval_sec: intervalSec, description, next_check_at: now() + 1500, created_at: now() });
  changed('watcher', id);
  return id;
}

export function setWatchersEnabled(responsibilityId: string, enabled: boolean) {
  q.run('UPDATE watchers SET enabled = ?, next_check_at = ? WHERE responsibility_id = ?', enabled ? 1 : 0, now() + 1000, responsibilityId);
  for (const w of q.all('SELECT id FROM watchers WHERE responsibility_id = ?', responsibilityId)) changed('watcher', w.id);
}

export async function checkNow(w: Row) {
  const probe = probes.get(w.kind);
  if (!probe) return;
  const state = json<Record<string, any>>(w.state_json, {});
  try {
    const r = await probe(json(w.config_json, {}), state, w);
    update('watchers', w.id, { state_json: JSON.stringify(r.state), last_value: r.value, last_checked_at: now(), next_check_at: now() + w.interval_sec * 1000, consecutive_errors: 0 });
    changed('watcher', w.id);
    if (r.fire) emit('watcher.fired', { source: `watcher:${w.kind}`, subjectType: 'responsibility', subjectId: w.responsibility_id, payload: { watcherId: w.id, kind: w.kind, value: r.value, ...r.observation } });
  } catch (e) {
    const errors = w.consecutive_errors + 1;
    const backoff = Math.min(3600, w.interval_sec * 2 ** Math.min(errors, 6));
    update('watchers', w.id, { consecutive_errors: errors, last_checked_at: now(), next_check_at: now() + backoff * 1000, last_value: `Couldn’t check: ${(e as Error).message}` });
    changed('watcher', w.id);
    if (errors === 3) {
      activity('problem', `Having trouble watching: ${w.description}`, { responsibilityId: w.responsibility_id, detail: `${(e as Error).message}. Checking less often until it works again.` });
      emit('watcher.error', { subjectType: 'responsibility', subjectId: w.responsibility_id, payload: { watcherId: w.id, error: String(e) } });
    }
    log.warn(`watcher ${w.kind} failed`, String(e));
  }
}

const inflight = new Set<string>();
let timer: NodeJS.Timeout | null = null;
export function startWatchers() {
  timer = setInterval(() => {
    for (const w of q.all('SELECT * FROM watchers WHERE enabled = 1 AND next_check_at <= ?', now())) {
      if (inflight.has(w.id)) continue;
      inflight.add(w.id);
      checkNow(w).finally(() => inflight.delete(w.id));
    }
  }, 1000);
}
export const stopWatchers = () => timer && clearInterval(timer);
