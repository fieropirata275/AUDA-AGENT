/**
 * Supervisor: an independent loop that watches the execution engine and AUDA's
 * computer. It assumes things WILL fail and makes recovery visible:
 *   - task runs whose lease expired (worker died mid-step) → resume from checkpoint
 *   - an unresponsive browser → restart it and restore the last page
 *   - the demo service dying is NOT handled here: that's a responsibility's job
 *   - tasks stuck past their deadline → surfaced to you
 */
import { now, q, update } from '../core/db.ts';
import { abandonRun } from '../tasks/engine.ts';
import { activity } from '../core/activity.ts';
import { emit } from '../core/bus.ts';
import { changed } from '../core/changes.ts';
import { log } from '../core/log.ts';
import * as browser from '../computer/browser.ts';
import { note } from '../computer/terminal.ts';
import { setRecovering } from '../agent/presence.ts';
import { COMPUTER_ID } from '../computer/index.ts';

let busy = false;
let browserFailures = 0;
export const supervisorState = { lastBeat: 0, recoveries: 0 };

async function beat() {
  if (busy) return;
  busy = true;
  supervisorState.lastBeat = now();
  try {
    // 1. Dead task runs.
    for (const r of q.all("SELECT * FROM task_runs WHERE state = 'running' AND lease_expires_at < ?", now())) {
      supervisorState.recoveries++;
      setRecovering(4000);
      abandonRun(r, 'The worker running this stopped responding');
    }

    // 2. Browser health.
    const healthy = await browser.health(4000);
    if (!healthy) {
      browserFailures++;
      if (browserFailures >= 2) {
        browserFailures = 0;
        supervisorState.recoveries++;
        setRecovering(8000);
        const sess = browser.status().sessionId;
        emit('computer.session.crashed', { subjectType: 'computer', subjectId: COMPUTER_ID, payload: { sessionId: sess } });
        activity('recover', 'Browser session became unresponsive', { detail: 'The supervisor noticed two failed health checks. Restarting the browser and restoring the last page.' });
        note('supervisor: browser unresponsive — restarting');
        try {
          const r = await browser.restart('unresponsive');
          activity('recover', 'Recovered the browser automatically', { detail: `Restored ${r.url === 'about:blank' ? 'a fresh session' : r.url}. Saved logins and cookies are intact.` });
          note('supervisor: browser recovered');
          emit('computer.session.recovered', { subjectType: 'computer', subjectId: COMPUTER_ID, payload: r });
        } catch (e) {
          activity('problem', 'Couldn’t restart the browser', { detail: String(e) });
        }
      }
    } else browserFailures = 0;
    update('computers', COMPUTER_ID, { last_health_at: now() });

    // 3. Deadlines.
    for (const t of q.all("SELECT id, title, responsibility_id FROM tasks WHERE deadline_at IS NOT NULL AND deadline_at < ? AND state NOT IN ('COMPLETED','FAILED','CANCELLED') AND attention IS NULL", now())) {
      update('tasks', t.id, { attention: 'problem', now_line: 'Past its deadline' });
      changed('task', t.id);
      activity('problem', `Past deadline: ${t.title}`, { taskId: t.id, responsibilityId: t.responsibility_id });
    }
  } catch (e) {
    log.error('supervisor beat failed', e);
  } finally { busy = false; }
}

export function startSupervisor() { setInterval(beat, 5000); }
