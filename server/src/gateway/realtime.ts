/** Realtime layer: entity upserts and live streams to every connected client. */
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { onChanges, type Entity } from '../core/changes.ts';
import { onStream, setViewers } from '../core/streams.ts';
import { q, now, setSetting } from '../core/db.ts';
import { load, canSee, PER_VIEWER } from './views.ts';
import { runAs } from '../core/context.ts';
import { userFor } from './http.ts';
import { handleDeviceSocket } from '../connectors/devices.ts';

interface Client { ws: WebSocket; subs: Set<string>; userId: string }
const clients = new Set<Client>();

export function attachRealtime(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/link') {
      wss.handleUpgrade(req, socket, head, (ws) => handleDeviceSocket(ws, url.searchParams.get('token') ?? ''));
      return;
    }
    const userId = url.pathname === '/ws' ? userFor(req, url) : null;
    if (!userId) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { ws, subs: new Set(), userId };
      clients.add(c);
      ws.send(JSON.stringify({ type: 'hello', ts: now() }));
      ws.on('message', (raw) => {
        let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === 'sub' && !c.subs.has(m.channel)) { c.subs.add(m.channel); setViewers(m.channel, 1); }
        if (m.type === 'unsub' && c.subs.has(m.channel)) { c.subs.delete(m.channel); setViewers(m.channel, -1); }
        if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      });
      ws.on('close', () => {
        for (const s of c.subs) setViewers(s, -1);
        clients.delete(c);
        if (!clients.size) setSetting('user.lastSeen', now());
      });
    });
  });

  onChanges((batch) => {
    if (!clients.size) return;
    const extra: { entity: Entity; id: string; removed?: boolean }[] = [];
    for (const b of batch) {
      // Watchers and schedules are shown inside their responsibility.
      if (b.entity === 'watcher' || b.entity === 'schedule') {
        const owner = b.entity === 'watcher' ? q.get('SELECT responsibility_id r FROM watchers WHERE id = ?', b.id)?.r : q.get("SELECT owner_id r FROM schedules WHERE id = ? AND owner_type = 'responsibility'", b.id)?.r;
        if (owner) extra.push({ entity: 'responsibility', id: owner });
      }
    }
    const msgs = [...batch, ...extra].map((b) => {
      if (b.removed) return { type: 'remove', entity: b.entity, id: b.id, data: null };
      const data = load(b.entity, b.id);
      return data ? { type: 'upsert', entity: b.entity, id: b.id, data } : { type: 'remove', entity: b.entity, id: b.id, data: null };
    });
    // Each person only receives what they may see.
    const byUser = new Map<string, string>();
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      let payload = byUser.get(c.userId);
      if (!payload) {
        const uid = c.userId;
        const items = msgs.map((m) => m.type === 'upsert' && PER_VIEWER.has(m.entity) ? { ...m, data: runAs(uid, () => load(m.entity, m.id)) } : m);
        payload = JSON.stringify({ type: 'batch', items: items.filter((m) => m.type === 'remove' || canSee(m.entity, m.data, uid)) });
        byUser.set(c.userId, payload);
      }
      c.ws.send(payload);
    }
  });

  onStream((channel, payload) => {
    const base = channel.split('.')[0];
    const msg = JSON.stringify({ type: 'stream', channel, payload });
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      if (channel === 'screen' && !c.subs.has('screen')) continue;
      if (c.ws.bufferedAmount > 4 << 20 && channel === 'screen') continue; // slow client: drop frames, never block
      if (base === 'screen' || base === 'terminal' || base === 'services') c.ws.send(msg);
    }
  });
}
