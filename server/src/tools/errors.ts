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
