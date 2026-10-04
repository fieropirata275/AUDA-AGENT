/** Computer Runtime: AUDA's persistent desk and the tools that act on it. */
import { insert, now, q, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { registerTool } from '../tools/broker.ts';
import { driverInfo } from './driver.ts';
import * as terminal from './terminal.ts';
import * as files from './files.ts';
import * as browser from './browser.ts';
import * as services from './services.ts';

export const COMPUTER_ID = 'computer';

export function initComputer() {
  if (!q.get('SELECT id FROM computers WHERE id = ?', COMPUTER_ID)) {
    insert('computers', { id: COMPUTER_ID, name: 'AUDA’s Computer', driver: driverInfo().driver, state: 'ready', controller: 'auda', created_at: now() });
  }
  services.installDemo();
  services.start('demo-api');
  update('computers', COMPUTER_ID, { state: 'ready', last_health_at: now(), driver: driverInfo().driver });
  registerComputerTools();
}

export function controller(): 'auda' | 'human' {
  return (q.get('SELECT controller FROM computers WHERE id = ?', COMPUTER_ID)?.controller ?? 'auda') as 'auda' | 'human';
}

export function setController(who: 'auda' | 'human') {
  if (controller() === who) return;
  update('computers', COMPUTER_ID, { controller: who });
  changed('computer', COMPUTER_ID);
  terminal.note(who === 'human' ? 'You took control of AUDA’s computer. AUDA will pause anything that needs it.' : 'Control returned to AUDA.', who === 'human' ? 'human' : 'auda');
  activity('user', who === 'human' ? 'You took control of AUDA’s computer' : 'You returned control to AUDA', {
    detail: who === 'human' ? 'Tasks that need the computer wait until you hand it back.' : 'Paused computer work resumes now.',
  });
  emit('computer.control.changed', { subjectType: 'computer', subjectId: COMPUTER_ID, payload: { controller: who } });
}

export function computerView() {
  const row = q.get('SELECT * FROM computers WHERE id = ?', COMPUTER_ID);
  return {
    id: COMPUTER_ID, name: row?.name, state: row?.state, controller: row?.controller ?? 'auda',
    driver: driverInfo(), browser: browser.status(), services: services.list(),
  };
}

/** Thrown when a tool needs the computer but the human is driving. */
export class HumanHasControl extends Error { constructor() { super('You have control of AUDA’s computer'); } }
const needsComputer = () => { if (controller() === 'human') throw new HumanHasControl(); };

function registerComputerTools() {
  const term = async (i: any, c: any) => {
    needsComputer();
    const r = await terminal.run(i.cmd, { taskId: c.taskId, cwd: i.cwd, timeoutMs: i.timeoutMs, actor: c.actor === 'user' ? 'human' : 'auda' });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs, timedOut: r.timedOut };
  };
  registerTool('terminal.read', term);
  registerTool('terminal.write', term);
  registerTool('terminal.destructive', term);
  registerTool('fs.read', async (i) => files.read(i.path, i.maxBytes));
  registerTool('fs.write', async (i) => files.write(i.path, i.content));
  registerTool('fs.delete', async (i, c) => {
    needsComputer();
    const r = files.remove(i.paths);
    terminal.note(`deleted ${i.paths.length} file(s), freed ${(r.freed / 1048576).toFixed(1)} MB`, c.actor === 'user' ? 'human' : 'auda');
    return r;
  });
  registerTool('fs.compress', async (i, c) => {
    needsComputer();
    const r = await files.gzip(i.paths);
    terminal.note(`compressed ${r.files.length} file(s): ${(r.before / 1048576).toFixed(1)} MB → ${(r.after / 1048576).toFixed(1)} MB`, c.actor === 'user' ? 'human' : 'auda');
    return r;
  });
  registerTool('service.restart', async (i) => { needsComputer(); terminal.note(`restarting ${i.service}`); return services.restart(i.service); });
  registerTool('service.configure', async (i) => { needsComputer(); terminal.note(`${i.service}: set ${i.key}=${i.value}`); return services.configure(i.service, i.key, i.value); });
  registerTool('browser.read', async (i) => { needsComputer(); return browser.readPage(i.url); });
  registerTool('browser.interact', async (i) => { needsComputer(); await browser.humanInput(i); return { ok: true }; });
  registerTool('http.fetch', async (i) => {
    const res = await fetch(i.url, { headers: { 'user-agent': 'AUDA/0.1' }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 100_000) };
  });
}

export { terminal, files, browser, services };
