/** Artifact Store: work products live in AUDA's workspace and always know why they exist. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.ts';
import { insert, now, q, uid } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { bundleHtml } from './bundle.ts';

const MIME: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html', '.log': 'text/plain', '.diff': 'text/plain',
  '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip' };

export function saveArtifact(o: { name: string; content: string | Buffer; mime?: string; why: string; taskId?: string; responsibilityId?: string; spaceId?: string | null }) {
  const id = uid('art');
  const slug = q.get('SELECT slug FROM spaces WHERE id = ?', o.spaceId ?? '')?.slug ?? 'general';
  const date = new Date().toISOString().slice(0, 10);
  const rel = path.join('artifacts', slug, date, `${id.slice(4, 10)}-${o.name}`);
  const abs = path.join(config.workspaceDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, o.content);
  const size = typeof o.content === 'string' ? Buffer.byteLength(o.content) : o.content.length;
  insert('artifacts', {
    id, task_id: o.taskId, responsibility_id: o.responsibilityId, space_id: o.spaceId ?? undefined, name: o.name,
    path: '~/' + rel.split(path.sep).join('/'), mime: o.mime ?? MIME[path.extname(o.name)] ?? 'application/octet-stream', size, why: o.why, created_at: now(),
  });
  changed('artifact', id);
  return { id, path: '~/' + rel };
}

export function artifactFile(id: string) {
  const a = q.get('SELECT * FROM artifacts WHERE id = ?', id);
  if (!a) return undefined;
  return { row: a, abs: path.join(config.workspaceDir, a.path.replace(/^~\//, '')) };
}

/**
 * Repair HTML artifacts that hold a description instead of the page ("…View at: ~/work/x/index.html") — what agents
 * saved before save_artifact took a path. The page the description points to is bundled in, once, at startup.
 */
export function repairPointerArtifacts() {
  let fixed = 0;
  for (const a of q.all("SELECT * FROM artifacts WHERE mime = 'text/html' AND size < 6000")) {
    const abs = path.join(config.workspaceDir, a.path.replace(/^~\//, ''));
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (/<(html|body|div|head|!doctype|p|h1|section)\b/i.test(text)) continue;
    const ref = /~\/[^\s'"`)<>]+\.html?\b/i.exec(text)?.[0];
    if (!ref) continue;
    const page = path.join(config.workspaceDir, ref.slice(2));
    if (!page.startsWith(config.workspaceDir + path.sep) || !fs.existsSync(page)) continue;
    try {
      const { html } = bundleHtml(page, config.workspaceDir);
      fs.writeFileSync(abs, html);
      q.run('UPDATE artifacts SET size = ? WHERE id = ?', Buffer.byteLength(html), a.id);
      changed('artifact', a.id);
      fixed++;
    } catch { /* leave it */ }
  }
  return fixed;
}
