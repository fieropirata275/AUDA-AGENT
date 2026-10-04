/** Projections from rows to what clients see. The UI never sees secrets. */
import { json, q, type Row } from '../core/db.ts';
import type { Entity } from '../core/changes.ts';
import { computerView } from '../computer/index.ts';
import { capabilities } from '../policy/capabilities.ts';
import { effectiveLevel } from '../policy/engine.ts';
import { CATALOG } from '../connectors/runtime.ts';
import { getSetting } from '../core/db.ts';
import { DEFAULT_PREFS } from '../notifications/service.ts';
import { modelSettings, providerReady, spend } from '../models/router.ts';

export const taskView = (t: Row) => ({
  id: t.id, title: t.title, goal: t.goal, state: t.state, playbook: t.playbook, spaceId: t.space_id, responsibilityId: t.responsibility_id,
  nowLine: t.now_line, currentStep: t.current_step, stepCount: t.step_count, attention: t.attention, priority: t.priority,
  result: t.result_summary, error: t.error, retryCount: t.retry_count, maxRetries: t.max_retries, nextEventAt: t.next_event_at,
  waitingOn: t.waiting_on, cost: t.cost_micro / 1e6, createdAt: t.created_at, startedAt: t.started_at, completedAt: t.completed_at,
  updatedAt: t.updated_at, origin: json(t.origin_json, {}),
  parentTaskId: t.parent_task_id, depth: t.depth ?? 0, plan: json(t.plan_json, []), verification: json(t.verification_json, null),
  diagnosis: t.diagnosis, recoveries: t.recoveries ?? 0, criteria: json<any>(t.input_json, {}).criteria ?? null,
  children: q.all('SELECT id, title, state FROM tasks WHERE parent_task_id = ? ORDER BY created_at', t.id),
  steps: q.all('SELECT idx, key, title, state, narration, started_at, ended_at, attempts FROM task_steps WHERE task_id = ? ORDER BY idx', t.id)
    .map((s) => ({ idx: s.idx, key: s.key, title: s.title, state: s.state, narration: s.narration, startedAt: s.started_at, endedAt: s.ended_at, attempts: s.attempts })),
});

export const respView = (r: Row) => ({
  id: r.id, title: r.title, description: r.description, playbook: r.playbook, state: r.state, spaceId: r.space_id,
  config: redactConfig(json(r.config_json, {})), statusLine: r.status_line, lastTriggeredAt: r.last_triggered_at, lastOutcome: r.last_outcome,
  triggerCount: r.trigger_count, createdAt: r.created_at, updatedAt: r.updated_at, origin: json(r.origin_json, {}),
  watchers: q.all('SELECT * FROM watchers WHERE responsibility_id = ?', r.id).map(watcherView),
  schedules: q.all("SELECT * FROM schedules WHERE owner_id = ?", r.id).map(scheduleView),
  triggers: q.all('SELECT id, event_pattern, description, enabled, last_fired_at FROM triggers WHERE responsibility_id = ?', r.id),
  tasks: q.get('SELECT COUNT(*) n FROM tasks WHERE responsibility_id = ?', r.id)!.n,
});
const redactConfig = (c: any) => { const { previous, current, ...rest } = c; void previous; void current; return rest; };

export const watcherView = (w: Row) => {
  const st = json<any>(w.state_json, {});
  return { id: w.id, responsibilityId: w.responsibility_id, kind: w.kind, description: w.description, intervalSec: w.interval_sec, lastValue: w.last_value, lastCheckedAt: w.last_checked_at, nextCheckAt: w.next_check_at, enabled: !!w.enabled, errors: w.consecutive_errors, history: st.history ?? null, armed: st.armed ?? null };
};
export const scheduleView = (s: Row) => ({ id: s.id, ownerType: s.owner_type, ownerId: s.owner_id, kind: s.kind, spec: s.spec, description: s.description, nextRunAt: s.next_run_at, windowEnd: s.window_end, lastRunAt: s.last_run_at, enabled: !!s.enabled });

export const approvalView = (a: Row) => ({
  id: a.id, taskId: a.task_id, capability: a.capability, title: a.title, summary: a.summary, recommendation: a.recommendation, impact: a.impact,
  ifYes: a.if_yes, ifNo: a.if_no, approveLabel: a.approve_label, rejectLabel: a.reject_label, evidence: json(a.evidence_json, []),
  actions: json(a.actions_json, []), state: a.state, decidedAt: a.decided_at, createdAt: a.created_at,
  task: (() => { const t = q.get('SELECT title, responsibility_id FROM tasks WHERE id = ?', a.task_id); return t ? { title: t.title, responsibilityId: t.responsibility_id } : null; })(),
});

export const activityView = (a: Row) => ({ id: a.id, ts: a.ts, kind: a.kind, title: a.title, detail: a.detail, taskId: a.task_id, responsibilityId: a.responsibility_id, spaceId: a.space_id, hasRaw: !!a.raw_json });
export const memoryView = (m: Row) => ({
  id: m.id, kind: m.kind, title: m.title, content: m.content, source: m.source, sourceRef: m.source_ref, confidence: m.confidence, scope: m.scope,
  spaceId: m.space_id, responsibilityId: m.responsibility_id, weight: m.weight, pinned: !!m.pinned, sensitivity: m.sensitivity,
  expiresAt: m.expires_at, reinforced: m.reinforced, supersededBy: m.superseded_by, createdAt: m.created_at, updatedAt: m.updated_at, data: json(m.data_json, {}),
});
export const artifactView = (a: Row) => ({
  id: a.id, name: a.name, path: a.path, mime: a.mime, size: a.size, why: a.why, taskId: a.task_id, responsibilityId: a.responsibility_id, spaceId: a.space_id, createdAt: a.created_at,
  taskTitle: a.task_id ? q.get('SELECT title FROM tasks WHERE id = ?', a.task_id)?.title : null,
});
export const connectorView = (c: Row) => {
  const cat = CATALOG.find((k) => k.kind === c.kind);
  return { id: c.id, kind: c.kind, name: c.name, state: c.state, detail: c.detail, error: c.error, lastOkAt: c.last_ok_at, config: json(c.config_json, {}), capabilities: (cat?.capabilities ?? []).map((id) => ({ id, title: capabilities[id]?.title, level: effectiveLevel(id) })) };
};
export const ruleView = (r: Row) => ({ id: r.id, text: r.text, compiled: json(r.compiled_json, {}), interpretation: r.interpretation, state: r.state, spaceId: r.space_id, origin: r.origin, createdAt: r.created_at, activatedAt: r.activated_at, hits: q.get('SELECT COUNT(*) n FROM audit_log WHERE decision = ?', `rule:${r.id}`)!.n });
export const notificationView = (n: Row) => ({ id: n.id, level: n.level, title: n.title, body: n.body, subjectType: n.subject_type, subjectId: n.subject_id, delivered: !!n.delivered, suppressedReason: n.suppressed_reason, readAt: n.read_at, createdAt: n.created_at });
export const messageView = (m: Row) => {
  const t = m.author_type === 'agent' && m.author_id ? q.get('SELECT id, title, depth, state FROM tasks WHERE id = ?', m.author_id) : null;
  return {
    id: m.id, conversationId: m.conversation_id, role: m.role, content: m.content, objects: json(m.objects_json, []), channel: m.channel, createdAt: m.created_at,
    authorType: m.author_type || (m.role === 'user' ? 'user' : 'auda'), authorId: m.author_id, attachments: json(m.attachments_json, []),
    authorName: t ? `${t.depth ? 'Sub-agent' : 'Agent'} · ${t.title.length > 34 ? t.title.slice(0, 32) + '…' : t.title}` : m.role === 'user' ? 'You' : 'AUDA', authorState: t?.state ?? null,
  };
};
export const pairingView = (p: Row) => ({ id: p.id, name: p.name, platform: p.platform, code: p.code, state: p.state, createdAt: p.created_at, expiresAt: p.expires_at });
export const clientView = (c: Row) => ({ id: c.id, name: c.name, platform: c.platform, createdAt: c.created_at, lastSeenAt: c.last_seen_at, revokedAt: c.revoked_at });
export const deviceView = (d: Row) => ({ id: d.id, name: d.name, state: d.state, platform: d.platform, grants: json(d.capabilities_json, {}), lastSeenAt: d.last_seen_at, createdAt: d.created_at, revokedAt: d.revoked_at });
export const identityView = (i: Row) => ({ id: i.id, name: i.name, userName: i.user_name, presence: i.presence, narration: i.narration, subject: i.presence_subject, updatedAt: i.updated_at });

export function settingsView() {
  const m = modelSettings();
  return {
    notificationPrefs: { ...DEFAULT_PREFS, ...getSetting('notifications.prefs', {}) },
    notificationWebhook: getSetting('notifications.webhook', '') ? 'configured' : '',
    sound: getSetting('ui.sound', false),
    models: { roles: m.roles, dailyBudget: m.dailyBudget, monthlyBudget: m.monthlyBudget, local: m.local, anthropicConnected: providerReady({ provider: 'anthropic', model: '' }), anthropicFromEnv: !m.anthropicSecret && !!process.env.ANTHROPIC_API_KEY },
    spend: spend(),
    capabilities: Object.values(capabilities).map((c) => ({ id: c.id, title: c.title, group: c.group, risk: c.risk, default: c.level, level: effectiveLevel(c.id) })),
    concurrency: getSetting('engine.concurrency', 3),
    instanceName: getSetting('instance.name', ''),
    requirePairing: getSetting('security.requirePairing', false),
    agentVerify: getSetting('agent.verify', true),
    agentWebSearch: getSetting('agent.webSearch', true),
  };
}

const loaders: Partial<Record<Entity, (id: string) => any>> = {
  identity: (id) => { const r = q.get('SELECT * FROM identity WHERE id = ?', id); return r && identityView(r); },
  task: (id) => { const r = q.get('SELECT * FROM tasks WHERE id = ?', id); return r && taskView(r); },
  responsibility: (id) => { const r = q.get('SELECT * FROM responsibilities WHERE id = ?', id); return r && respView(r); },
  approval: (id) => { const r = q.get('SELECT * FROM approvals WHERE id = ?', id); return r && approvalView(r); },
  activity: (id) => { const r = q.get('SELECT * FROM activity WHERE id = ?', id); return r && activityView(r); },
  memory: (id) => { const r = q.get('SELECT * FROM memories WHERE id = ?', id); return r && memoryView(r); },
  artifact: (id) => { const r = q.get('SELECT * FROM artifacts WHERE id = ?', id); return r && artifactView(r); },
  connector: (id) => { const r = q.get('SELECT * FROM connectors WHERE id = ?', id); return r && connectorView(r); },
  rule: (id) => { const r = q.get('SELECT * FROM rules WHERE id = ?', id); return r && ruleView(r); },
  notification: (id) => { const r = q.get('SELECT * FROM notifications WHERE id = ?', id); return r && notificationView(r); },
  message: (id) => { const r = q.get('SELECT * FROM messages WHERE id = ?', id); return r && messageView(r); },
  conversation: (id) => q.get('SELECT id, title, channel, space_id AS spaceId, updated_at AS updatedAt FROM conversations WHERE id = ?', id),
  space: (id) => q.get('SELECT * FROM spaces WHERE id = ?', id),
  device: (id) => { const r = q.get('SELECT * FROM devices WHERE id = ?', id); return r && deviceView(r); },
  computer: () => computerView(),
  schedule: (id) => { const r = q.get('SELECT * FROM schedules WHERE id = ?', id); return r && scheduleView(r); },
  watcher: (id) => { const r = q.get('SELECT * FROM watchers WHERE id = ?', id); return r && watcherView(r); },
  settings: () => settingsView(),
  pairing: (id) => { const r = q.get('SELECT * FROM pairings WHERE id = ?', id); return r && pairingView(r); },
  client: (id) => { const r = q.get('SELECT * FROM clients WHERE id = ?', id); return r && clientView(r); },
};

export function load(entity: Entity, id: string) { return loaders[entity]?.(id); }
