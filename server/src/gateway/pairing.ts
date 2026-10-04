/**
 * Pairing: how a phone becomes a trusted client.
 *   1. The app asks to pair and shows a 6-digit code.
 *   2. AUDA shows the same code in Connections (and notifies you).
 *   3. You approve; the app collects a token that is stored hashed here and
 *      can be revoked at any time.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { insert, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { notify } from '../notifications/service.ts';
import { requiresPairing } from './discovery.ts';
import { currentUserId, OWNER_ID } from '../core/context.ts';
import { orgEnabled, sessionUser, tokenFrom } from '../org/users.ts';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const TTL = 10 * 60_000;

export function requestPairing(name: string, platform?: string) {
  q.run("UPDATE pairings SET state = 'expired', token = NULL WHERE state = 'pending' AND expires_at < ?", now());
  if ((q.get("SELECT COUNT(*) n FROM pairings WHERE state = 'pending'")?.n ?? 0) > 10) throw new Error('Too many pending pairing requests; try again in a few minutes');
  const id = uid('pair');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const secret = crypto.randomBytes(18).toString('base64url');
  insert('pairings', { id, name: name.slice(0, 60) || 'Phone', platform: platform?.slice(0, 60), code, secret_hash: sha(secret), state: 'pending', created_at: now(), expires_at: now() + TTL });
  changed('pairing' as any, id);
  notify('attention', `${name} wants to connect to AUDA`, `Pairing code ${code}. Approve it in Connections if this is your device.`, { type: 'pairing', id });
  return { requestId: id, secret, code, expiresAt: now() + TTL };
}

export function pairingStatus(id: string, secret: string) {
  const p = q.get('SELECT * FROM pairings WHERE id = ?', id);
  if (!p || p.secret_hash !== sha(secret)) throw new Error('Unknown pairing request');
  if (p.state === 'pending' && p.expires_at < now()) { update('pairings', id, { state: 'expired' }); return { state: 'expired' }; }
  if (p.state === 'approved' && p.token) {
    const token = p.token;
    update('pairings', id, { state: 'claimed', token: null });
    changed('pairing' as any, id);
    return { state: 'approved', token, clientId: p.client_id };
  }
  return { state: p.state };
}

export function decidePairing(id: string, approve: boolean) {
  const p = q.get('SELECT * FROM pairings WHERE id = ?', id);
  if (!p || p.state !== 'pending') throw new Error('That request is no longer pending');
  if (!approve) { update('pairings', id, { state: 'rejected' }); changed('pairing' as any, id); activity('user', `You declined ${p.name}`); return; }
  const token = crypto.randomBytes(32).toString('base64url');
  const clientId = uid('cli');
  insert('clients', { id: clientId, name: p.name, platform: p.platform, token_hash: sha(token), user_id: currentUserId(), created_at: now() });
  update('pairings', id, { state: 'approved', client_id: clientId, token });
  changed('pairing' as any, id); changed('client' as any, clientId);
  activity('user', `You paired ${p.name}`, { detail: 'It can chat, supervise work and assign tasks. Revoke it any time in Connections.' });
}

export function revokeClient(id: string) {
  update('clients', id, { revoked_at: now() });
  changed('client' as any, id);
  activity('user', `You revoked ${q.get('SELECT name FROM clients WHERE id = ?', id)?.name ?? 'a client'}`);
}

/** Returns the client a token belongs to (and records that it was seen). */
export function clientForToken(token: string | undefined) {
  if (!token) return undefined;
  const c = q.get('SELECT * FROM clients WHERE token_hash = ? AND revoked_at IS NULL', sha(token));
  if (c && (!c.last_seen_at || now() - c.last_seen_at > 60_000)) { update('clients', c.id, { last_seen_at: now() }); changed('client' as any, c.id); }
  return c;
}

const isLoopback = (req: http.IncomingMessage) => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? '');

/**
 * Who is calling? A session (signed-in member), a paired app's token, or
 * AUDA_TOKEN. Without an organization, a trusted LAN/desktop is the owner.
 * Returns null when the caller must sign in or pair first.
 */
export function resolveUser(req: http.IncomingMessage, url: URL, masterToken?: string): string | null {
  const given = tokenFrom(req, url);
  if (masterToken && given && given.length === masterToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(masterToken))) return OWNER_ID;
  const s = sessionUser(given);
  if (s) return s.id;
  const c = clientForToken(given);
  if (c) return c.user_id ?? OWNER_ID;
  if (masterToken || orgEnabled()) return null;
  if (!requiresPairing()) return OWNER_ID;
  return isLoopback(req) ? OWNER_ID : null;
}
export function authorize(req: http.IncomingMessage, url: URL, masterToken?: string) { return resolveUser(req, url, masterToken) !== null; }
