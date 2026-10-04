/**
 * Organization: accounts, roles, sessions and invites.
 *
 * A fresh AUDA is single-user: everything belongs to the owner and no login is
 * needed on a trusted machine. Turning the organization on (inviting someone)
 * makes accounts real: every request is a person, your agents, plugin
 * connections and knowledge are yours, and you choose what to share.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { getSetting, insert, now, q, setSetting, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { OWNER_ID } from '../core/context.ts';
import { config } from '../core/config.ts';

export type Role = 'owner' | 'admin' | 'member';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_MS = 30 * 86400_000;

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [, salt, key] = stored.split('$');
  const k = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(key, 'base64');
  return ref.length === k.length && crypto.timingSafeEqual(ref, k);
}

export function ensureOwner() {
  if (!q.get('SELECT id FROM users WHERE id = ?', OWNER_ID)) {
    const ident = q.get('SELECT user_name FROM identity LIMIT 1');
    insert('users', { id: OWNER_ID, email: 'owner@local', name: ident?.user_name ?? 'Owner', role: 'owner', created_at: now() });
  }
  // Work created before accounts existed belongs to the owner.
  q.run('UPDATE tasks SET owner_id = ? WHERE owner_id IS NULL', OWNER_ID);
}

export const orgEnabled = () => getSetting('org.enabled', false) as boolean;
export const orgName = () => getSetting('org.name', 'My organization') as string;

export function userView(u: any) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastSeenAt: u.last_seen_at, disabled: !!u.disabled, hasPassword: !!u.password_hash };
}
export const getUser = (id: string) => q.get('SELECT * FROM users WHERE id = ?', id);
export const members = () => q.all('SELECT * FROM users WHERE disabled = 0 ORDER BY created_at').map(userView);
export const isAdmin = (id: string) => ['owner', 'admin'].includes(getUser(id)?.role);

export function createSession(userId: string, userAgent?: string) {
  const token = `sess_${crypto.randomBytes(32).toString('base64url')}`;
  insert('sessions', { token_hash: sha(token), user_id: userId, created_at: now(), expires_at: now() + SESSION_MS, user_agent: userAgent?.slice(0, 200) });
  return token;
}
export function sessionUser(token: string | undefined) {
  if (!token?.startsWith('sess_')) return undefined;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha(token), now());
  if (!s) return undefined;
  const u = getUser(s.user_id);
  if (!u || u.disabled) return undefined;
  if (!u.last_seen_at || now() - u.last_seen_at > 60_000) update('users', u.id, { last_seen_at: now() });
  return u;
}
export function endSession(token: string) { q.run('DELETE FROM sessions WHERE token_hash = ?', sha(token)); }

export function login(email: string, password: string) {
  const u = q.get('SELECT * FROM users WHERE lower(email) = lower(?) AND disabled = 0', email.trim());
  if (!u || !verifyPassword(password, u.password_hash)) throw new Error('Email or password is not right');
  return u;
}

/** Turn the organization on: the owner gets real credentials. */
export function setupOrganization(o: { orgName: string; ownerName: string; email: string; password: string }) {
  if (o.password.length < 8) throw new Error('Use at least 8 characters for the password');
  update('users', OWNER_ID, { name: o.ownerName.trim() || 'Owner', email: o.email.trim().toLowerCase(), password_hash: hashPassword(o.password) });
  setSetting('org.name', o.orgName.trim() || 'My organization');
  setSetting('org.enabled', true);
  changed('settings', 'settings');
  activity('user', `Organization “${orgName()}” is on`, { detail: 'Everyone now signs in. Agents, plugin connections and knowledge belong to their creators unless shared.' });
}

export function createInvite(createdBy: string, role: Role = 'member', email?: string) {
  if (!isAdmin(createdBy)) throw new Error('Only owners and admins can invite');
  const code = crypto.randomBytes(9).toString('base64url');
  const id = uid('inv');
  insert('invites', { id, code_hash: sha(code), email: email?.toLowerCase(), role: role === 'owner' ? 'admin' : role, created_by: createdBy, created_at: now(), expires_at: now() + 7 * 86400_000 });
  return { id, code, link: `${config.publicUrl}/join?code=${code}`, expiresAt: now() + 7 * 86400_000 };
}
export function inviteInfo(code: string) {
  const inv = q.get('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?', sha(code), now());
  if (!inv) throw new Error('This invite is invalid or has expired');
  return { email: inv.email, role: inv.role, org: orgName(), invitedBy: getUser(inv.created_by)?.name };
}
export function acceptInvite(code: string, o: { name: string; email: string; password: string }) {
  const inv = q.get('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?', sha(code), now());
  if (!inv) throw new Error('This invite is invalid or has expired');
  if (o.password.length < 8) throw new Error('Use at least 8 characters for the password');
  const email = (inv.email ?? o.email).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email');
  if (q.get('SELECT id FROM users WHERE lower(email) = ?', email)) throw new Error('An account with that email already exists');
  const id = uid('user');
  insert('users', { id, email, name: o.name.trim() || email.split('@')[0], role: inv.role, password_hash: hashPassword(o.password), created_at: now() });
  update('invites', inv.id, { used_by: id });
  activity('user', `${o.name || email} joined ${orgName()}`, { detail: `Role: ${inv.role}` });
  return getUser(id);
}
export function setRole(actor: string, userId: string, role: Role) {
  if (getUser(actor)?.role !== 'owner') throw new Error('Only the owner can change roles');
  if (userId === OWNER_ID) throw new Error('The owner stays the owner');
  update('users', userId, { role: role === 'owner' ? 'admin' : role });
}
export function removeMember(actor: string, userId: string) {
  if (!isAdmin(actor)) throw new Error('Only owners and admins can remove members');
  if (userId === OWNER_ID) throw new Error('The owner can’t be removed');
  update('users', userId, { disabled: 1 });
  q.run('DELETE FROM sessions WHERE user_id = ?', userId);
  q.run('UPDATE clients SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId);
}

export function tokenFrom(req: http.IncomingMessage, url: URL) {
  const cookie = /(?:^|;\s*)auda_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  return (req.headers['x-auda-token'] as string | undefined) ?? bearer ?? url.searchParams.get('token') ?? (cookie ? decodeURIComponent(cookie) : undefined);
}
