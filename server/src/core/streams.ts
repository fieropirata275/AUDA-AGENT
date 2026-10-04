/** Ephemeral high-frequency streams (screen frames, terminal output). Not persisted. */
type Fn = (channel: string, payload: unknown) => void;
const listeners: Fn[] = [];
const viewers = new Map<string, number>();
const viewerHooks = new Map<string, (count: number) => void>();

export function onStream(fn: Fn) { listeners.push(fn); }
export function publish(channel: string, payload: unknown) { for (const l of listeners) l(channel, payload); }

export function setViewers(channel: string, delta: number) {
  const n = Math.max(0, (viewers.get(channel) ?? 0) + delta);
  viewers.set(channel, n);
  viewerHooks.get(channel)?.(n);
}
export function onViewers(channel: string, fn: (count: number) => void) { viewerHooks.set(channel, fn); }
export const viewerCount = (channel: string) => viewers.get(channel) ?? 0;
