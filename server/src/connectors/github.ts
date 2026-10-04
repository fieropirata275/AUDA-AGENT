/** GitHub connector: real API, token held by the secret broker. */
import { json, q } from '../core/db.ts';
import { putSecret, resolveSecret, deleteSecret } from '../secrets/broker.ts';
import { ensureConnector, guarded, setConnector } from './runtime.ts';
import { registerTool } from '../tools/broker.ts';
import { registerProbe } from '../watchers/runner.ts';
import { Transient } from '../tools/errors.ts';

async function gh(path: string, init: RequestInit = {}, raw = false): Promise<any> {
  const row = q.get("SELECT * FROM connectors WHERE id = 'github'");
  const token = resolveSecret(row?.credential_ref);
  if (!token) throw new Error('GitHub is not connected');
  return guarded('github', async () => {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init, signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'AUDA', ...(init.headers ?? {}) },
    });
    if (res.status === 429 || res.status >= 500) throw new Transient(`GitHub HTTP ${res.status}`);
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return raw ? res.text() : res.status === 204 || res.status === 201 && !res.headers.get('content-length') ? {} : res.json();
  });
}

export async function connectGitHub(token: string) {
  const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'AUDA', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(res.status === 401 ? 'GitHub rejected that token' : `GitHub HTTP ${res.status}`);
  const user: any = await res.json();
  const old = q.get("SELECT credential_ref FROM connectors WHERE id = 'github'");
  if (old?.credential_ref) deleteSecret(old.credential_ref);
  const ref = putSecret('github-token', token);
  ensureConnector('github', 'GitHub', 'connected');
  let repos = 0;
  try { repos = (await (await fetch('https://api.github.com/user/repos?per_page=100', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'AUDA' } })).json() as any[]).length; } catch { /* optional */ }
  setConnector('github', { state: 'connected', credential_ref: ref, detail: `@${user.login} · ${repos >= 100 ? '100+' : repos} repositories`, error: null, config_json: JSON.stringify({ login: user.login }) });
  return { login: user.login, repos };
}

export function disconnectGitHub() {
  const old = q.get("SELECT credential_ref FROM connectors WHERE id = 'github'");
  if (old?.credential_ref) deleteSecret(old.credential_ref);
  setConnector('github', { state: 'disconnected', credential_ref: null, detail: null });
}

export function initGitHub() {
  registerTool('github.read', async (i) => gh(i.path ?? `/repos/${i.repo}`, {}, i.raw));
  registerTool('github.rerun_workflow', async (i) => { await gh(`/repos/${i.repo}/actions/runs/${i.runId}/rerun-failed-jobs`, { method: 'POST' }); return { externalId: `rerun:${i.runId}` }; });
  registerTool('github.comment', async (i) => { const r = await gh(`/repos/${i.repo}/issues/${i.number}/comments`, { method: 'POST', body: JSON.stringify({ body: i.body }) }); return { externalId: String(r.id), url: r.html_url }; });

  registerProbe('github_ci', async (c, state) => {
    const runs = (await gh(`/repos/${c.repo}/actions/runs?per_page=15${c.branch ? `&branch=${encodeURIComponent(c.branch)}` : ''}`)).workflow_runs as any[];
    const seen: number[] = state.seen ?? [];
    const first = !state.seen;
    const newFailures = runs.filter((r) => r.status === 'completed' && ['failure', 'timed_out'].includes(r.conclusion) && !seen.includes(r.id));
    const latest = runs[0];
    const value = latest ? `${latest.name}: ${latest.status === 'completed' ? latest.conclusion : latest.status} on ${latest.head_branch}` : 'No runs yet';
    const nextSeen = [...new Set([...runs.filter((r) => r.status === 'completed').map((r) => r.id), ...seen])].slice(0, 200);
    if (first || !newFailures.length) return { value, fire: false, state: { seen: nextSeen } };
    const r = newFailures[0];
    return { value, fire: true, observation: { headline: `${r.name} failed on ${c.repo}@${r.head_branch}`, repo: c.repo, runId: r.id, runName: r.name, branch: r.head_branch, sha: r.head_sha, url: r.html_url }, state: { seen: nextSeen } };
  });
}

export const githubConnected = () => q.get("SELECT state FROM connectors WHERE id = 'github'")?.state === 'connected';
export { gh, json };
