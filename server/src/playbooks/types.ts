import type { ApprovalSpec } from '../tools/broker.ts';
import type { AudaEvent } from '../core/bus.ts';
import type { Row } from '../core/db.ts';

export interface StepCtx {
  task: Row;
  input: Record<string, any>;
  /** Checkpointed variables: persisted after every step. */
  vars: Record<string, any>;
  stepIdx: number;
  narrate(text: string): void;
  log(kind: 'observe' | 'reason' | 'act' | 'wait' | 'memory' | 'complete' | 'problem' | 'recover', title: string, detail?: string, raw?: unknown): void;
  tool<T = any>(capability: string, input: any, opts?: { why?: string; approval?: ApprovalSpec }): Promise<T>;
  /** Ask once for a set of exact actions. Returns 'approved' | 'rejected' | 'not-needed'. */
  decide(spec: ApprovalSpec, actions: { capability: string; input: any }[]): Promise<'approved' | 'rejected' | 'not-needed'>;
  artifact(name: string, content: string | Buffer, opts: { mime?: string; why: string }): Promise<{ id: string; path: string }>;
  remember(m: { kind: string; title: string; content: string; weight?: string; confidence?: number; data?: any; expiresInMs?: number }): void;
  notify(level: string, title: string, body?: string): void;
  memories(query: string, limit?: number): Row[];
}

export type StepResult =
  | void
  | { output?: any; narration?: string }
  | { wait: 'external'; until?: number; reason: string }
  | { complete: string }
  | { insert: { key: string; title: string }[] };

export interface ResponsibilityHooks {
  /** Create watchers, schedules and triggers for a new responsibility. */
  setup(resp: Row): void;
  /** Decide whether a wake-up should spawn a task, and with what input. */
  onWake(resp: Row, event: AudaEvent): { title: string; goal?: string; input: Record<string, any>; priority?: number } | null;
  /** One-line description of what is being watched. */
  describe(config: any): string;
}

export interface Playbook {
  id: string;
  title: string;
  description: string;
  plan(input: Record<string, any>): { key: string; title: string }[];
  steps: Record<string, (ctx: StepCtx) => Promise<StepResult>>;
  responsibility?: ResponsibilityHooks;
}

const registry = new Map<string, Playbook>();
export function definePlaybook(p: Playbook) { registry.set(p.id, p); return p; }
export function playbook(id: string) {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown playbook ${id}`);
  return p;
}
export const playbooks = () => [...registry.values()];
