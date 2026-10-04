/**
 * Client store: a projection of AUDA's state, kept live by the realtime
 * layer. The client never invents state; it only renders what the server says.
 */
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type * as T from './types';

export interface State {
  ready: boolean;
  connected: boolean;
  identity: T.Identity | null;
  tasks: Record<string, T.Task>;
  responsibilities: Record<string, T.Responsibility>;
  approvals: Record<string, T.Approval>;
  rules: Record<string, T.Rule>;
  connectors: Record<string, T.Connector>;
  memories: Record<string, T.Memory>;
  notifications: Record<string, T.Notification>;
  activity: Record<string, T.Activity>;
  artifacts: Record<string, T.Artifact>;
  spaces: Record<string, T.Space>;
  conversations: Record<string, T.Conversation>;
  devices: Record<string, T.Device>;
  pairings: Record<string, T.Pairing>;
  clients: Record<string, T.Client>;
  instance: { id: string; name: string; version: string; port: number; requiresPairing: boolean } | null;
  schedules: Record<string, T.Schedule>;
  messages: Record<string, T.Message[]>;
  computer: T.Computer | null;
  settings: T.Settings | null;
  catalog: T.CatalogItem[];
  playbooks: { id: string; title: string; description: string; ongoing: boolean }[];
  lastSeen: number | null;
  bootAt: number;
  publicUrl: string;
  safeMode: boolean;
  me: T.Member | null;
  org: { enabled: boolean; name: string };
  members: Record<string, T.Member>;
  plugins: Record<string, T.Plugin>;
  customAgents: Record<string, T.CustomAgent>;
  /** The organization is on and this browser isn't signed in. */
  needsLogin: boolean;
  /** ids of things that just completed, for celebratory motion */
  justCompleted: Record<string, number>;
}

let state: State = {
  ready: false, connected: false, identity: null, tasks: {}, responsibilities: {}, approvals: {}, rules: {}, connectors: {}, memories: {},
  notifications: {}, activity: {}, artifacts: {}, spaces: {}, conversations: {}, devices: {}, pairings: {}, clients: {}, instance: null, schedules: {}, messages: {},
  computer: null, settings: null, catalog: [], playbooks: [], lastSeen: null, bootAt: Date.now(), safeMode: false, publicUrl: '', justCompleted: {},
  me: null, org: { enabled: false, name: '' }, members: {}, plugins: {}, customAgents: {}, needsLogin: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getState = () => state;
export function useStore() { return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state); }

const byId = <X extends { id: string }>(xs: X[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

export async function bootstrap() {
  let b: any;
  try { b = await api<any>('/api/bootstrap'); }
  catch (e) {
    if ((e as any).status === 401) { const me = await api<any>('/api/auth/me').catch(() => null); set({ needsLogin: true, ready: true, org: me?.org ?? state.org }); return; }
    throw e;
  }
  set({
    needsLogin: false, me: b.me ?? null, org: b.org ?? { enabled: false, name: '' }, members: byId(b.members ?? []), plugins: byId(b.plugins ?? []), customAgents: byId(b.customAgents ?? []),
    ready: true, identity: b.identity, tasks: byId(b.tasks), responsibilities: byId(b.responsibilities), approvals: byId(b.approvals), rules: byId(b.rules),
    connectors: byId(b.connectors), memories: byId(b.memories), notifications: byId(b.notifications), activity: byId(b.activity), artifacts: byId(b.artifacts),
    spaces: byId(b.spaces), conversations: byId(b.conversations), devices: byId(b.devices), pairings: byId(b.pairings ?? []), clients: byId(b.clients ?? []), instance: b.instance ?? null, schedules: byId(b.schedules), computer: b.computer,
    settings: b.settings, catalog: b.catalog, playbooks: b.playbooks, publicUrl: b.publicUrl, safeMode: !!b.safeMode,
    ...(state.ready ? {} : { lastSeen: b.lastSeen, bootAt: Date.now() }),
  });
}

const MAP: Record<string, keyof State> = {
  task: 'tasks', responsibility: 'responsibilities', approval: 'approvals', rule: 'rules', connector: 'connectors', memory: 'memories',
  notification: 'notifications', activity: 'activity', artifact: 'artifacts', space: 'spaces', conversation: 'conversations', device: 'devices', schedule: 'schedules',
  pairing: 'pairings', client: 'clients', plugin: 'plugins', agent: 'customAgents', member: 'members',
};

type StreamFn = (payload: any) => void;
const streamSubs = new Map<string, Set<StreamFn>>();
export function onStream(channel: string, fn: StreamFn) {
  if (!streamSubs.has(channel)) streamSubs.set(channel, new Set());
  streamSubs.get(channel)!.add(fn);
  return () => { streamSubs.get(channel)!.delete(fn); };
}
type EventFn = (e: { entity: string; data: any; prev: any }) => void;
const changeSubs = new Set<EventFn>();
export const onEntityChange = (fn: EventFn) => { changeSubs.add(fn); return () => { changeSubs.delete(fn); }; };

let ws: WebSocket | null = null;
const wanted = new Set<string>();
export function subscribe(channel: string) {
  wanted.add(channel);
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'sub', channel }));
  return () => { wanted.delete(channel); if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'unsub', channel })); };
}

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    set({ connected: true });
    for (const c of wanted) ws!.send(JSON.stringify({ type: 'sub', channel: c }));
    if (state.ready) void bootstrap(); // catch up on anything missed while disconnected
  };
  ws.onclose = () => { set({ connected: false }); if (!state.needsLogin) setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'stream') { streamSubs.get(m.channel)?.forEach((f) => f(m.payload)); return; }
    if (m.type !== 'batch') return;
    const patch: Partial<State> = {};
    const events: Parameters<EventFn>[0][] = [];
    for (const it of m.items) {
      if (it.entity === 'identity') { patch.identity = it.data; continue; }
      if (it.entity === 'computer') { patch.computer = it.data; continue; }
      if (it.entity === 'settings') { patch.settings = it.data; continue; }
      if (it.entity === 'message') {
        const msgs = { ...(patch.messages ?? state.messages) };
        const list = [...(msgs[it.data.conversationId] ?? [])].filter((x) => x.id !== it.data.id);
        list.push(it.data); list.sort((a, b) => a.createdAt - b.createdAt);
        msgs[it.data.conversationId] = list; patch.messages = msgs;
        continue;
      }
      const key = MAP[it.entity];
      if (!key) continue;
      const cur = { ...((patch[key] as any) ?? (state[key] as any)) };
      const prev = cur[it.id];
      if (it.type === 'remove') delete cur[it.id]; else cur[it.id] = it.data;
      (patch as any)[key] = cur;
      events.push({ entity: it.entity, data: it.data, prev });
      if (it.entity === 'task' && it.data?.state === 'COMPLETED' && prev && prev.state !== 'COMPLETED') {
        patch.justCompleted = { ...(patch.justCompleted ?? state.justCompleted), [it.id]: Date.now() };
      }
    }
    set(patch);
    for (const e of events) changeSubs.forEach((f) => f(e));
  };
}

export async function loadMessages(conversationId: string) {
  const list = await api<T.Message[]>(`/api/conversations/${conversationId}/messages`);
  set({ messages: { ...state.messages, [conversationId]: list } });
}

// Theme: system by default, overridable.
export function getTheme(): 'system' | 'light' | 'dark' {
  try { return (localStorage.getItem('auda.theme') as any) ?? 'system'; } catch { return 'system'; }
}
export function setTheme(t: 'system' | 'light' | 'dark') {
  try { localStorage.setItem('auda.theme', t); } catch { /* private mode */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  listeners.forEach((l) => l());
}
