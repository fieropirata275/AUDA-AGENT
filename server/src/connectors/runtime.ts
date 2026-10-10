/**
 * Connector Runtime. Connectors are pieces of AUDA's environment: each one
 * declares capabilities, permissions and a connection state, and wraps its
 * calls in a circuit breaker so a failing service degrades instead of looping.
 */
import { insert, json, now, q, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';

export interface ConnectorKind {
  kind: string;
  name: string;
  description: string;
  capabilities: string[];
  available: boolean;           // implemented in this build
  setup?: 'token' | 'none' | 'device' | 'endpoint';
  tokenHelp?: string;
}

export const CATALOG: ConnectorKind[] = [
  { kind: 'computer', name: 'AUDA’s Computer', description: 'AUDA’s own persistent workspace: terminal, files and a Chromium browser.', capabilities: ['terminal.read', 'terminal.write', 'terminal.destructive', 'fs.read', 'fs.write', 'fs.compress', 'fs.delete', 'service.restart', 'service.configure', 'browser.read', 'browser.interact', 'browser.submit', 'http.fetch'], available: true, setup: 'none' },
  { kind: 'webhook', name: 'Webhooks', description: 'Anything that can send an HTTP POST can wake AUDA.', capabilities: [], available: true, setup: 'none' },
  { kind: 'github', name: 'GitHub', description: 'Repositories and CI. AUDA can watch workflows and re-run or comment within your rules.', capabilities: ['github.read', 'github.rerun_workflow', 'github.comment'], available: true, setup: 'token', tokenHelp: 'A fine-grained personal access token with read access to Actions and Contents (and write to Actions if AUDA may re-run CI).' },
  { kind: 'anthropic', name: 'Claude (Anthropic)', description: 'Reasoning for open-ended tasks, summaries and rule compilation.', capabilities: [], available: true, setup: 'token', tokenHelp: 'An Anthropic API key. It is encrypted at rest and never shown to any model.' },
  { kind: 'lmstudio', name: 'LM Studio', description: 'Run AUDA on local models through LM Studio’s headless server (lms server start). Tool calling included, nothing leaves your network.', capabilities: [], available: true, setup: 'endpoint' },
  { kind: 'device', name: 'Your devices', description: 'Link one of your own machines and grant specific capabilities. Visible and revocable.', capabilities: ['device.exec'], available: true, setup: 'device' },
  { kind: 'gmail', name: 'Gmail', description: 'Read mail, draft replies; sending would always ask.', capabilities: ['email.send'], available: false },
  { kind: 'calendar', name: 'Google Calendar', description: 'Know your schedule; propose events.', capabilities: [], available: false },
  { kind: 'slack', name: 'Slack', description: 'A channel into the same AUDA.', capabilities: ['message.send'], available: false },
  { kind: 'proxmox', name: 'Proxmox', description: 'Dedicated agent VMs from existing templates, with resume and suspend.', capabilities: [], available: true, setup: 'endpoint' },
  { kind: 'homeassistant', name: 'Home Assistant', description: 'Sensors as triggers; devices as actions.', capabilities: [], available: false },
];

export function ensureConnector(kind: string, name: string, state = 'connected', detail?: string, config: any = {}) {
  if (!q.get('SELECT id FROM connectors WHERE id = ?', kind)) {
    insert('connectors', { id: kind, kind, name, state, detail, config_json: JSON.stringify(config), created_at: now(), last_ok_at: state === 'connected' ? now() : undefined });
    changed('connector', kind);
  }
}

export function setConnector(id: string, patch: Record<string, any>) {
  const before = q.get('SELECT state FROM connectors WHERE id = ?', id);
  update('connectors', id, patch);
  changed('connector', id);
  if (patch.state && before?.state !== patch.state) emit('connector.state', { subjectType: 'connector', subjectId: id, payload: { state: patch.state } });
}

/** Circuit breaker: 5 consecutive failures open the circuit for a cooldown. */
export async function guarded<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const row = q.get('SELECT * FROM connectors WHERE id = ?', id);
  const b = json<{ failures?: number; openUntil?: number }>(row?.breaker_json, {});
  if (b.openUntil && b.openUntil > now()) throw new Error(`${row?.name ?? id} is cooling down after repeated failures (until ${new Date(b.openUntil).toLocaleTimeString()})`);
  try {
    const r = await fn();
    if (b.failures || row?.state !== 'connected') setConnector(id, { breaker_json: '{}', state: 'connected', error: null, last_ok_at: now() });
    else update('connectors', id, { last_ok_at: now() });
    return r;
  } catch (e) {
    const failures = (b.failures ?? 0) + 1;
    const open = failures >= 5;
    setConnector(id, { breaker_json: JSON.stringify({ failures, openUntil: open ? now() + 5 * 60_000 : undefined }), state: open ? 'degraded' : row?.state, error: String((e as Error).message ?? e) });
    if (open) activity('problem', `${row?.name ?? id} keeps failing — pausing calls for 5 minutes`, { detail: String((e as Error).message ?? e) });
    throw e;
  }
}
