import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export type Row = Record<string, any>;
type Param = SQLInputValue | boolean | undefined;

export const db = new DatabaseSync(process.env.AUDA_DB ?? config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));

const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
function stmt(sql: string) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const norm = (p: Param[]): SQLInputValue[] =>
  p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export const q = {
  all<T = Row>(sql: string, ...p: Param[]): T[] { return stmt(sql).all(...norm(p)) as T[]; },
  get<T = Row>(sql: string, ...p: Param[]): T | undefined { return stmt(sql).get(...norm(p)) as T | undefined; },
  run(sql: string, ...p: Param[]) { return stmt(sql).run(...norm(p)); },
};

let depth = 0;
/** Run fn in a transaction (nested calls join the outer transaction). */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}

/** Insert a row from an object. */
export function insert(table: string, row: Row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  q.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}
/** Update columns of a row by id. */
export function update(table: string, id: string, patch: Row) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  q.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
}

export const now = () => Date.now();
export const uid = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
export const hash = (v: unknown) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

export function getSetting<T>(key: string, fallback: T): T {
  const r = q.get('SELECT value_json FROM settings WHERE key = ?', key);
  return r ? json<T>(r.value_json, fallback) : fallback;
}
export function setSetting(key: string, value: unknown) {
  q.run('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    key, JSON.stringify(value), now());
}
