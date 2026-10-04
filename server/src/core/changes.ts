/**
 * Change feed for the realtime layer. Modules call changed(entity, id) after
 * writing; the gateway projects the row into a view and pushes it to clients.
 */
export type Entity =
  | 'identity' | 'task' | 'responsibility' | 'approval' | 'activity' | 'memory' | 'artifact'
  | 'connector' | 'notification' | 'rule' | 'computer' | 'schedule' | 'watcher' | 'message'
  | 'conversation' | 'space' | 'device' | 'settings';

type Listener = (batch: { entity: Entity; id: string; removed?: boolean }[]) => void;
const listeners: Listener[] = [];
let pending = new Map<string, { entity: Entity; id: string; removed?: boolean }>();
let scheduled = false;

export function onChanges(fn: Listener) { listeners.push(fn); }

export function changed(entity: Entity, id: string, removed = false) {
  pending.set(`${entity}:${id}`, { entity, id, removed });
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    const batch = [...pending.values()];
    pending = new Map();
    scheduled = false;
    for (const l of listeners) l(batch);
  });
}
