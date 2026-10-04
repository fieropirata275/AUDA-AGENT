/**
 * Capability registry. Every tool AUDA can use is a capability with a default
 * autonomy level and a risk class. Policy-only capabilities (money.spend,
 * email.send) exist so rules can reason about them even before a connector
 * implements them.
 */
export type Level = 'autonomous' | 'rule' | 'approval' | 'deny';
export type Risk = 'read' | 'internal' | 'reversible' | 'external' | 'destructive' | 'spend' | 'privileged';

export interface Capability {
  id: string;
  title: string;
  group: string;
  level: Level;
  risk: Risk;
  /** Human sentence for audit/approvals. */
  describe: (input: any) => string;
  /** Resource string rules can glob-match (path, host, repo…). */
  resource?: (input: any) => string | undefined;
}

const c = (x: Capability) => x;

export const capabilities: Record<string, Capability> = Object.fromEntries([
  c({ id: 'terminal.read', title: 'Run read-only commands', group: 'Computer', level: 'autonomous', risk: 'read',
      describe: (i) => `run \`${i.cmd}\``, resource: (i) => i.cwd }),
  c({ id: 'terminal.write', title: 'Run commands that change files', group: 'Computer', level: 'autonomous', risk: 'reversible',
      describe: (i) => `run \`${i.cmd}\``, resource: (i) => i.cwd }),
  c({ id: 'terminal.destructive', title: 'Run destructive commands', group: 'Computer', level: 'approval', risk: 'destructive',
      describe: (i) => `run \`${i.cmd}\``, resource: (i) => i.cwd }),
  c({ id: 'fs.read', title: 'Read files', group: 'Computer', level: 'autonomous', risk: 'read',
      describe: (i) => `read ${i.path}`, resource: (i) => i.path }),
  c({ id: 'fs.write', title: 'Write files in its workspace', group: 'Computer', level: 'autonomous', risk: 'internal',
      describe: (i) => `write ${i.path}`, resource: (i) => i.path }),
  c({ id: 'fs.compress', title: 'Compress files', group: 'Computer', level: 'autonomous', risk: 'reversible',
      describe: (i) => `compress ${i.paths?.length ?? 1} file(s) in ${i.dir ?? i.path}`, resource: (i) => i.dir ?? i.path }),
  c({ id: 'fs.delete', title: 'Delete files', group: 'Computer', level: 'approval', risk: 'destructive',
      describe: (i) => `delete ${i.paths?.length ?? 1} file(s) in ${i.dir ?? i.path}`, resource: (i) => i.dir ?? i.path }),
  c({ id: 'service.restart', title: 'Restart a service', group: 'Computer', level: 'rule', risk: 'reversible',
      describe: (i) => `restart ${i.service}`, resource: (i) => i.service }),
  c({ id: 'service.configure', title: 'Change service configuration', group: 'Computer', level: 'approval', risk: 'reversible',
      describe: (i) => `set ${i.key}=${i.value} on ${i.service}`, resource: (i) => i.service }),
  c({ id: 'browser.read', title: 'Browse and read web pages', group: 'Browser', level: 'autonomous', risk: 'read',
      describe: (i) => `open ${i.url}`, resource: (i) => hostOf(i.url) }),
  c({ id: 'browser.interact', title: 'Click and type in pages', group: 'Browser', level: 'autonomous', risk: 'internal',
      describe: (i) => `interact with ${i.url ?? 'the current page'}`, resource: (i) => hostOf(i.url) }),
  c({ id: 'browser.submit', title: 'Submit forms', group: 'Browser', level: 'approval', risk: 'external',
      describe: (i) => `submit a form on ${i.url}`, resource: (i) => hostOf(i.url) }),
  c({ id: 'http.fetch', title: 'Fetch URLs', group: 'Network', level: 'autonomous', risk: 'read',
      describe: (i) => `fetch ${i.url}`, resource: (i) => hostOf(i.url) }),
  c({ id: 'github.read', title: 'Read repositories and CI', group: 'GitHub', level: 'autonomous', risk: 'read',
      describe: (i) => `read ${i.repo ?? 'GitHub'}`, resource: (i) => i.repo }),
  c({ id: 'github.rerun_workflow', title: 'Re-run CI workflows', group: 'GitHub', level: 'rule', risk: 'reversible',
      describe: (i) => `re-run workflow run ${i.runId} on ${i.repo}`, resource: (i) => i.repo }),
  c({ id: 'github.comment', title: 'Comment on issues and PRs', group: 'GitHub', level: 'approval', risk: 'external',
      describe: (i) => `comment on ${i.repo}#${i.number}`, resource: (i) => i.repo }),
  c({ id: 'plugin.read', title: 'Read from connected apps', group: 'Plugins', level: 'autonomous', risk: 'read',
      describe: (i) => `read from ${i.plugin} (${i.tool})`, resource: (i) => `${String(i.plugin ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${i.tool}` }),
  c({ id: 'plugin.write', title: 'Change data in connected apps', group: 'Plugins', level: 'approval', risk: 'external',
      describe: (i) => `use ${i.plugin} → ${i.tool}`, resource: (i) => `${String(i.plugin ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${i.tool}` }),
  c({ id: 'device.exec', title: 'Run jobs on a linked device', group: 'Devices', level: 'approval', risk: 'privileged',
      describe: (i) => `run \`${i.cmd}\` on ${i.deviceName ?? 'a linked device'}`, resource: (i) => i.deviceId }),
  c({ id: 'decision.ask', title: 'Ask you to decide', group: 'AUDA', level: 'approval', risk: 'internal', describe: (i) => `ask you: ${i.question}` }),
  c({ id: 'notify.user', title: 'Notify you', group: 'AUDA', level: 'autonomous', risk: 'internal', describe: (i) => `notify you: ${i.title}` }),
  c({ id: 'memory.write', title: 'Remember things', group: 'AUDA', level: 'autonomous', risk: 'internal', describe: (i) => `remember "${i.title}"` }),
  c({ id: 'artifact.write', title: 'Save work products', group: 'AUDA', level: 'autonomous', risk: 'internal', describe: (i) => `save ${i.name}` }),
  c({ id: 'email.send', title: 'Send email', group: 'Communication', level: 'approval', risk: 'external', describe: (i) => `send an email to ${i.to}`, resource: (i) => i.to }),
  c({ id: 'message.send', title: 'Message people', group: 'Communication', level: 'approval', risk: 'external', describe: (i) => `message ${i.to}`, resource: (i) => i.to }),
  c({ id: 'money.spend', title: 'Spend money', group: 'Money', level: 'approval', risk: 'spend', describe: (i) => `spend ${i.amount} ${i.currency ?? ''}` }),
].map((x) => [x.id, x]));

function hostOf(url?: string) { try { return url ? new URL(url).host : undefined; } catch { return undefined; } }

/** Classify a shell command into a terminal capability. Conservative by design. */
export function classifyCommand(cmd: string): 'terminal.read' | 'terminal.write' | 'terminal.destructive' {
  const s = ` ${cmd} `;
  const redirects = cmd.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '');
  const destructive =
    /\b(rm|rmdir|shred|truncate|mkfs|dd|kill|pkill|killall|reboot|shutdown|sudo|su)\b/.test(s)
    || /systemctl\s+(stop|disable|mask)|docker\s+(rm|kill|stop|system\s+prune)|git\s+(reset\s+--hard|push\s+(-f|--force)|clean)/.test(s)
    || /find\b.*\s-(delete|exec\s+rm)/.test(s)
    || /(^|[;&|]\s*)(:|true)?\s*>\s*[\w./~-]+/.test(redirects.trim());
  if (destructive) return 'terminal.destructive';
  const write =
    /\b(mv|cp|mkdir|touch|tee|gzip|gunzip|tar|zip|unzip|chmod|chown|ln|npm|pnpm|pip|apt|apt-get)\b/.test(s)
    || /sed\s+-i|git\s+(commit|push|checkout|merge|pull)|curl\s.*-X\s*(POST|PUT|PATCH|DELETE)/.test(s)
    || />/.test(redirects);
  return write ? 'terminal.write' : 'terminal.read';
}
