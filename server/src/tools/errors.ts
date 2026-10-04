export class NeedsApproval extends Error {
  constructor(public approvalId: string, public title: string) { super(`Waiting for approval: ${title}`); }
}
export class ApprovalRejected extends Error {
  constructor(public approvalId: string, public capability: string) { super(`You declined: ${capability}`); }
}
export class PolicyDenied extends Error {
  constructor(public capability: string, public reason: string) { super(`Not permitted: ${reason}`); }
}
/** An external action was started but we cannot tell whether it completed. */
export class UncertainAction extends Error {
  constructor(public capability: string) { super(`An earlier attempt at ${capability} may or may not have completed`); }
}
/** Transient failure: retry with backoff. */
export class Transient extends Error {}

/** A failure retrying won't fix (bad input, missing permission, wrong credentials). */
export class Permanent extends Error {}
/** The step exceeded its time budget. */
export class StepTimeout extends Transient {}

export type ErrorClass = 'transient' | 'permanent' | 'unknown';

const TRANSIENT_RE = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|timed? ?out|overloaded|rate.?limit|too many requests|\b429\b|\b50[0-9]\b|\b529\b|service unavailable|bad gateway|SQLITE_BUSY|database is locked|Target page, context or browser has been closed|browser has disconnected|Navigation failed because page crashed)/i;
const PERMANENT_RE = /(\b40[0-4]\b|invalid[_ ]request|authentication|unauthori[sz]ed|forbidden|permission denied|not found|no such file|ENOENT|EACCES|is not connected|outside AUDA|unknown capability|No tool implements|declined this request)/i;

/** Decide whether to retry. Unknown errors are retried a bounded number of times. */
export function classify(e: unknown): ErrorClass {
  if (e instanceof Transient) return 'transient';
  if (e instanceof Permanent) return 'permanent';
  const err = e as any;
  const status = err?.status ?? err?.statusCode;
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'permanent';
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'transient';
  const msg = `${err?.name ?? ''} ${err?.message ?? err ?? ''} ${err?.cause?.code ?? ''}`;
  if (TRANSIENT_RE.test(msg)) return 'transient';
  if (PERMANENT_RE.test(msg)) return 'permanent';
  return 'unknown';
}

/** A plain explanation and a suggested next move, for people. */
export function diagnose(e: unknown, cls: ErrorClass, context: string): string {
  const msg = String((e as any)?.message ?? e);
  const hints: [RegExp, string][] = [
    [/authentication|unauthori[sz]ed|invalid.*key|\b401\b/i, 'The credentials were rejected. Reconnect the service in Connections, then retry.'],
    [/forbidden|\b403\b|permission denied|EACCES/i, 'Access was denied. Check the permissions of the account or file, then retry.'],
    [/not found|\b404\b|ENOENT|no such file/i, 'Something AUDA expected no longer exists. Check the path or resource name in the task details.'],
    [/rate.?limit|\b429\b|too many requests/i, 'The service is rate-limiting AUDA. It will be fine later; retry in a few minutes.'],
    [/budget/i, 'The model budget for today is used up. Raise it in Settings → Resources or wait until tomorrow.'],
    [/No reasoning model/i, 'Connect Claude in Connections so AUDA can do open-ended work.'],
    [/loop/i, 'AUDA kept repeating itself without making progress. Add detail to the task or split it into smaller pieces.'],
    [/keeps crashing/i, 'This task crashed AUDA’s worker repeatedly, so it was quarantined to protect everything else. Inspect it before retrying.'],
    [/timed? ?out|ETIMEDOUT/i, 'An operation took too long. The service may be slow or down; retrying later usually works.'],
  ];
  const hint = hints.find(([re]) => re.test(msg))?.[1]
    ?? (cls === 'transient' ? 'This looks temporary. Retrying later should work.' : cls === 'permanent' ? 'Retrying the same way won’t help; something about the task or environment needs to change.' : 'This was unexpected. The raw error is recorded under the hood; retrying may work.');
  return `${context}: ${msg.split('\n')[0].slice(0, 300)}. ${hint}`;
}
