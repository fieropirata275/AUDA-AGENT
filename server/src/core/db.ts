import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export type Row = Record<string, any>;
type Param = SQLInputValue | boolean | undefined;

const DB_PATH = process.env.AUDA_DB ?? config.dbPath;
export const BACKUP_DIR = path.join(config.dataDir, 'backups');
/** What happened when the database was opened (shown in the Reliability panel). */
export const bootReport: { integrity: 'ok' | 'restored' | 'fresh'; restoredFrom?: string; detail?: string } = { integrity: 'ok' };

function open(): DatabaseSync {
  const fresh = !fs.existsSync(DB_PATH);
  let d = new DatabaseSync(DB_PATH);
  if (fresh) { bootReport.integrity = 'fresh'; return d; }
  let ok = false, detail = '';
  try { const r = d.prepare('PRAGMA quick_check').get() as any; detail = String(Object.values(r ?? {})[0]); ok = detail === 'ok'; }
  catch (e) { detail = String(e); }
  if (ok) return d;
  // Corrupt database: keep it for forensics and restore the newest backup that passes a check.
  d.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(DB_PATH, `${DB_PATH}.corrupt-${stamp}`);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(DB_PATH + ext)) fs.renameSync(DB_PATH + ext, `${DB_PATH}${ext}.corrupt-${stamp}`);
  const backups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse() : [];
  for (const b of backups) {
    try {
      fs.copyFileSync(path.join(BACKUP_DIR, b), DB_PATH);
      d = new DatabaseSync(DB_PATH);
      if (String(Object.values((d.prepare('PRAGMA quick_check').get() as any) ?? {})[0]) === 'ok') {
        Object.assign(bootReport, { integrity: 'restored', restoredFrom: b, detail });
        return d;
      }
      d.close();
    } catch { /* try the next backup */ }
  }
  Object.assign(bootReport, { integrity: 'fresh', detail: `database was corrupt (${detail}) and no usable backup existed` });
  return new DatabaseSync(DB_PATH);
}

export const db = open();
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));

/** Additive migrations for databases created by earlier versions. */
function ensureColumn(table: string, column: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
ensureColumn('events', 'dispatched', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('tasks', 'plan_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('tasks', 'verification_json', 'TEXT');
ensureColumn('tasks', 'diagnosis', 'TEXT');
ensureColumn('tasks', 'recoveries', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'depth', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'inbox_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('messages', 'author_type', "TEXT NOT NULL DEFAULT ''");
ensureColumn('messages', 'author_id', 'TEXT');
ensureColumn('messages', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'");
db.exec('CREATE INDEX IF NOT EXISTS events_pending ON events(dispatched, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id)');

/** Online backup (consistent snapshot while running). Keeps the newest `keep`. */
export function backup(keep = 48): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `auda-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
  return name;
}
export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, at: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }));
}

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
