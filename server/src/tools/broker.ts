/**
 * Tool Broker — the only path to side effects.
 *
 *   capability → idempotency check → policy decision → approval (if needed)
 *   → execute → record action + audit → result
 *
 * A retry of the same step with the same input never performs a completed
 * action twice; the stored result is returned instead.
 */
import { capabilities, classifyCommand } from '../policy/capabilities.ts';
import { decide } from '../policy/engine.ts';
import { hash, insert, json, now, q, uid } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { ApprovalRejected, NeedsApproval, PolicyDenied, UncertainAction } from './errors.ts';

export interface ApprovalSpec {
  title: string;
  summary: string;
  recommendation?: string;
  impact?: string;
  ifYes?: string;
  ifNo?: string;
  approveLabel?: string;
  rejectLabel?: string;
  evidence?: { label: string; value: string }[];
}

export interface CallContext {
  taskId?: string;
  stepIdx?: number;
  spaceId?: string | null;
  actor?: 'auda' | 'user';
  why?: string;
  approval?: ApprovalSpec;
}

type Impl = (input: any, ctx: CallContext) => Promise<any>;
const impls = new Map<string, Impl>();

export function registerTool(capId: string, impl: Impl) {
  if (!capabilities[capId]) throw new Error(`register unknown capability ${capId}`);
  impls.set(capId, impl);
}

/** terminal.exec is a convenience that resolves to read/write/destructive. */
export function resolveCapability(capId: string, input: any) {
  if (capId === 'terminal.exec') return classifyCommand(String(input.cmd ?? ''));
  return capId;
}

export async function call<T = any>(capIdIn: string, input: any, ctx: CallContext = {}): Promise<T> {
  const capId = resolveCapability(capIdIn, input);
  const cap = capabilities[capId];
  const impl = impls.get(capId) ?? (capId.startsWith('terminal.') ? impls.get('terminal.read') : undefined);
  if (!cap || !impl) throw new Error(`No tool implements ${capId}`);
  const inputHash = hash(input);
  const key = ctx.taskId != null ? `${ctx.taskId}:${ctx.stepIdx ?? 0}:${capId}:${inputHash}` : undefined;

  // 1. Idempotency.
  if (key) {
    const prior = q.get('SELECT * FROM actions WHERE idempotency_key = ?', key);
    if (prior?.state === 'done') {
      audit(capId, input, ctx, 'replay', 'deduplicated', key, prior.external_id);
      return json(prior.result_json, null) as T;
    }
    if (prior?.state === 'started' && ['external', 'spend'].includes(cap.risk)) throw new UncertainAction(capId);
  }

  // 2. Policy.
  const d = decide(capId, input, { spaceId: ctx.spaceId });
  let decision = d.via === 'default' ? (d.verdict === 'allow' ? 'autonomous' : d.via) : d.via;
  if (d.verdict === 'deny') {
    audit(capId, input, ctx, d.via, 'blocked', key);
    throw new PolicyDenied(capId, d.reason);
  }
  if (d.verdict === 'ask') {
    if (!ctx.taskId) throw new PolicyDenied(capId, 'needs approval but has no task to attach it to');
    // A plan approval covers an exact list of actions decided together.
    const plan = q.all("SELECT id, actions_json FROM approvals WHERE task_id = ? AND capability = 'plan' AND state = 'approved'", ctx.taskId)
      .find((a) => json<any[]>(a.actions_json, []).some((x) => x.capability === capId && x.inputHash === inputHash));
    const existing = plan ? undefined : q.get(
      'SELECT * FROM approvals WHERE task_id = ? AND step_idx = ? AND capability = ? AND input_hash = ? ORDER BY created_at DESC LIMIT 1',
      ctx.taskId, ctx.stepIdx ?? 0, capId, inputHash);
    if (plan) decision = `approved:${plan.id}`;
    else if (existing?.state === 'approved') decision = `approved:${existing.id}`;
    else if (existing?.state === 'rejected') throw new ApprovalRejected(existing.id, capId);
    else if (existing?.state === 'pending') throw new NeedsApproval(existing.id, existing.title);
    else {
      const id = requestApproval(capId, input, inputHash, ctx, d.reason);
      throw new NeedsApproval(id, ctx.approval?.title ?? cap.title);
    }
  }

  // 3. Execute.
  if (key) {
    q.run(`INSERT INTO actions (idempotency_key, task_id, capability, state, created_at, updated_at) VALUES (?, ?, ?, 'started', ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET state = 'started', updated_at = excluded.updated_at`, key, ctx.taskId, capId, now(), now());
  }
  try {
    const result = await impl(input, ctx);
    const externalId = result && typeof result === 'object' ? result.externalId : undefined;
    if (key) q.run("UPDATE actions SET state = 'done', result_json = ?, external_id = ?, updated_at = ? WHERE idempotency_key = ?",
      JSON.stringify(result ?? null), externalId, now(), key);
    if (cap.risk !== 'read' && cap.risk !== 'internal') audit(capId, input, ctx, decision, 'ok', key, externalId);
    else if (ctx.actor === 'user') audit(capId, input, ctx, 'user', 'ok', key);
    return result as T;
  } catch (e) {
    if (key) q.run("UPDATE actions SET state = 'failed', result_json = ?, updated_at = ? WHERE idempotency_key = ?", JSON.stringify({ error: String(e) }), now(), key);
    audit(capId, input, ctx, decision, 'error', key, undefined, String((e as Error).message ?? e));
    throw e;
  }
}

function requestApproval(capId: string, input: any, inputHash: string, ctx: CallContext, reason: string) {
  const cap = capabilities[capId];
  const spec: ApprovalSpec = ctx.approval ?? {
    title: `Allow AUDA to ${cap.describe(input)}?`,
    summary: `${ctx.why ? ctx.why + ' ' : ''}${reason}.`,
  };
  const id = uid('apr');
  insert('approvals', {
    id, task_id: ctx.taskId, step_idx: ctx.stepIdx ?? 0, capability: capId, input_hash: inputHash,
    title: spec.title, summary: spec.summary, recommendation: spec.recommendation, impact: spec.impact,
    if_yes: spec.ifYes, if_no: spec.ifNo, approve_label: spec.approveLabel, reject_label: spec.rejectLabel,
    evidence_json: JSON.stringify([...(spec.evidence ?? []), { label: 'Exact action', value: cap.describe(input) }, { label: 'Why it asks', value: reason }]),
    state: 'pending', created_at: now(),
  });
  changed('approval', id);
  const task = q.get('SELECT responsibility_id, space_id FROM tasks WHERE id = ?', ctx.taskId);
  activity('approval', spec.title, { detail: spec.summary, taskId: ctx.taskId, responsibilityId: task?.responsibility_id, spaceId: task?.space_id });
  emit('approval.requested', { subjectType: 'approval', subjectId: id, payload: { taskId: ctx.taskId, capability: capId } });
  return id;
}

function audit(capId: string, input: any, ctx: CallContext, decision: string, result: string, key?: string, externalId?: string, detail?: string) {
  const cap = capabilities[capId];
  const id = uid('aud');
  insert('audit_log', {
    id, ts: now(), actor: ctx.actor ?? 'auda', capability: capId, target: cap.resource?.(input) ?? cap.describe(input),
    task_id: ctx.taskId, decision, result, idempotency_key: key, external_id: externalId,
    detail: detail ?? cap.describe(input),
  });
}
