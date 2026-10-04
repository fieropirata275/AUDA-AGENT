/**
 * Linked devices: the user's own machines, separate from AUDA's computer.
 * A device connects outbound over WebSocket with a pairing token, advertises
 * what it *could* offer, and AUDA may only use what you explicitly grant.
 * Access is visible, revocable, and enforced on both ends.
 */
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { insert, json, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { registerTool } from '../tools/broker.ts';

const sockets = new Map<string, WebSocket>();
const pending = new Map<string, (r: any) => void>();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const DEVICE_CAPS = ['terminal', 'files', 'browser', 'camera', 'microphone'] as const;

export function createDevice(name: string) {
  const id = uid('dev');
  const token = crypto.randomBytes(24).toString('base64url');
  insert('devices', { id, name, token_hash: sha(token), capabilities_json: JSON.stringify(Object.fromEntries(DEVICE_CAPS.map((c) => [c, false]))), state: 'offline', created_at: now() });
  changed('device', id);
  activity('user', `You started linking “${name}”`, { detail: 'Nothing is granted until you allow it.' });
  return { id, token };
}

export function setGrants(id: string, grants: Record<string, boolean>) {
  const d = q.get('SELECT * FROM devices WHERE id = ?', id);
  if (!d || d.revoked_at) throw new Error('No such device');
  const merged = { ...json(d.capabilities_json, {}), ...grants };
  update('devices', id, { capabilities_json: JSON.stringify(merged) });
  changed('device', id);
  sockets.get(id)?.send(JSON.stringify({ type: 'grants', grants: merged }));
  activity('user', `Changed what AUDA may use on “${d.name}”`, { detail: Object.entries(merged).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ') });
}

export function revokeDevice(id: string) {
  update('devices', id, { state: 'revoked', revoked_at: now(), token_hash: 'revoked' });
  changed('device', id);
  sockets.get(id)?.close(4001, 'revoked');
  sockets.delete(id);
  activity('user', `Revoked AUDA’s access to ${q.get('SELECT name FROM devices WHERE id = ?', id)?.name}`);
}

export function handleDeviceSocket(ws: WebSocket, token: string) {
  const d = q.get('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', sha(token));
  if (!d) { ws.close(4003, 'unknown device'); return; }
  sockets.set(d.id, ws);
  update('devices', d.id, { state: 'online', last_seen_at: now() });
  changed('device', d.id);
  ws.send(JSON.stringify({ type: 'grants', grants: json(d.capabilities_json, {}) }));
  ws.on('message', (raw) => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'hello') { update('devices', d.id, { platform: m.platform, last_seen_at: now() }); changed('device', d.id); }
    if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    if (m.type === 'ping') update('devices', d.id, { last_seen_at: now() });
  });
  ws.on('close', () => {
    if (sockets.get(d.id) === ws) sockets.delete(d.id);
    if (q.get('SELECT state FROM devices WHERE id = ?', d.id)?.state !== 'revoked') { update('devices', d.id, { state: 'offline', last_seen_at: now() }); changed('device', d.id); }
  });
}

export function initDevices() {
  q.run("UPDATE devices SET state = 'offline' WHERE state = 'online'");
  registerTool('device.exec', async (i) => {
    const d = q.get('SELECT * FROM devices WHERE id = ?', i.deviceId);
    if (!d || d.revoked_at) throw new Error('That device is not linked');
    if (!json<any>(d.capabilities_json, {}).terminal) throw new Error(`Terminal access on ${d.name} is not granted`);
    const ws = sockets.get(d.id);
    if (!ws) throw new Error(`${d.name} is offline`);
    const id = uid('job');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Device did not answer in time')); }, 60_000);
      pending.set(id, (r) => { clearTimeout(t); r.error ? reject(new Error(r.error)) : resolve({ code: r.code, stdout: r.stdout, stderr: r.stderr }); });
      ws.send(JSON.stringify({ type: 'exec', id, cmd: i.cmd }));
    });
  });
}
