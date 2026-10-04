/**
 * Secret broker. Credentials are encrypted at rest (AES-256-GCM) and are only
 * ever resolved inside connector code at call time. Models never see them; the
 * UI only ever sees a reference id and a masked preview.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.ts';
import { insert, now, q, uid } from '../core/db.ts';

function masterKey(): Buffer {
  if (process.env.AUDA_MASTER_KEY) return crypto.createHash('sha256').update(process.env.AUDA_MASTER_KEY).digest();
  const file = path.join(config.dataDir, 'master.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}
const key = masterKey();

export function putSecret(name: string, value: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  const id = uid('sec');
  insert('secrets', { id, name, ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), created_at: now() });
  return id;
}

/** Resolve a secret. Call only from connector/runtime code, never pass to a model. */
export function resolveSecret(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const r = q.get('SELECT * FROM secrets WHERE id = ?', id);
  if (!r) return undefined;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'));
  d.setAuthTag(Buffer.from(r.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(r.ciphertext, 'base64')), d.final()]).toString('utf8');
}

export function deleteSecret(id: string) { q.run('DELETE FROM secrets WHERE id = ?', id); }

export function maskSecret(v: string) { return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`; }
