/**
 * AUDA core. One process, hard module boundaries, durable state.
 * Boot order matters: storage → identity → runtime → engines → gateway.
 */
import { config } from './core/config.ts';
import { db, getSetting, insert, now, q } from './core/db.ts';
import { log } from './core/log.ts';
import { initComputer } from './computer/index.ts';
import { ensureConnector } from './connectors/runtime.ts';
import { initGitHub } from './connectors/github.ts';
import { initDevices } from './connectors/devices.ts';
import { startEngine, stopEngine, onNarration } from './tasks/engine.ts';
import { initResponsibilities } from './responsibilities/service.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { startWatchers } from './watchers/runner.ts';
import { startSupervisor } from './supervisor/supervisor.ts';
import { initPresence } from './agent/presence.ts';
import { consolidate } from './memory/consolidate.ts';
import { createServer } from './gateway/http.ts';
import { initLmStudio } from './connectors/lmstudio.ts';
import { initGroup } from './agent/group.ts';
import { startDiscovery, stopDiscovery, lanAddresses } from './gateway/discovery.ts';
import { replayPending, pruneEvents } from './core/bus.ts';
import { backup, bootReport } from './core/db.ts';
import { system } from './core/system.ts';
import fs from 'node:fs';
import path from 'node:path';
import { attachRealtime } from './gateway/realtime.ts';
import { shutdown as shutdownBrowser } from './computer/browser.ts';
import { activity } from './core/activity.ts';
import { remember } from './memory/service.ts';
import { providerReady } from './models/router.ts';
import { registerTool } from './tools/broker.ts';
import { notify } from './notifications/service.ts';
import './playbooks/serverHealth.ts';
import './playbooks/webWatch.ts';
import './playbooks/routines.ts';
import './playbooks/githubCi.ts';
import './playbooks/agent.ts';
import { ensureOwner } from './org/users.ts';
import { initPlugins } from './plugins/runtime.ts';
import { initLearning } from './agents/learning.ts';

process.removeAllListeners('warning');

function firstBoot() {
  if (q.get('SELECT id FROM identity LIMIT 1')) return false;
  insert('identity', { id: 'auda', name: 'AUDA', presence: 'available', narration: 'Ready when you are.', persona: 'calm, competent, concise', updated_at: now() });
  insert('spaces', { id: 'space_personal', name: 'Personal', slug: 'personal', icon: 'home', created_at: now() });
  insert('spaces', { id: 'space_homelab', name: 'Home Lab', slug: 'home-lab', icon: 'server', created_at: now() });
  remember({ kind: 'identity', title: 'Who AUDA is', content: 'AUDA is an always-on digital operator with its own computer. It works within your rules and asks only when your judgment is needed.', source: 'system', weight: 'defining', confidence: 1, expiresAt: null });
  activity('system', 'AUDA woke up for the first time', { detail: 'Its computer is ready: a workspace, a terminal, a browser and one small service (demo-api) to look after.' });
  return true;
}

const fresh = firstBoot();
ensureOwner();
initComputer();
ensureConnector('computer', 'AUDA’s Computer', 'connected', `${config.computerDriver} driver · persistent workspace`);
ensureConnector('webhook', 'Webhooks', 'connected', `${config.publicUrl}/hooks/<name>`);
ensureConnector('github', 'GitHub', 'disconnected');
ensureConnector('anthropic', 'Claude (Anthropic)', providerReady({ provider: 'anthropic', model: '' }) ? 'connected' : 'disconnected',
  process.env.ANTHROPIC_API_KEY ? 'Using ANTHROPIC_API_KEY from the environment' : undefined);
initGitHub();
initDevices();
initLmStudio();
initGroup();
registerTool('notify.user', async (i) => ({ id: notify(i.level ?? 'fyi', i.title, i.body) }));
initPlugins();
initLearning();
initResponsibilities();
initPresence();
if (bootReport.integrity === 'restored') activity('recover', 'Restored the database from a backup', { detail: `The database failed its integrity check on startup (${bootReport.detail}). AUDA restored ${bootReport.restoredFrom} and kept the damaged copy for inspection. Anything after that backup may need redoing.` });
if (system.safeMode) {
  // Safe mode: the UI and API stay up; nothing executes until you say so.
  activity('problem', 'AUDA started in safe mode', { detail: 'The core crashed repeatedly, so task execution, watchers and schedules are paused. Inspect recent problems in Activity, then leave safe mode from Settings → Reliability.' });
  log.warn('SAFE MODE: engine, scheduler and watchers are paused');
} else {
  startEngine({ concurrency: getSetting('engine.concurrency', config.workerConcurrency) });
  startScheduler();
  startWatchers();
  const replayed = replayPending();
  if (replayed) activity('recover', `Replayed ${replayed} event${replayed > 1 ? 's' : ''} interrupted by the last shutdown`, { detail: 'They had been recorded but not fully handled; AUDA handled them now.' });
}
startSupervisor();
setInterval(() => void consolidate().catch((e) => log.warn('consolidation failed', String(e))), 10 * 60_000);
// Backups: one at boot (after the integrity check passed) and hourly; daily pruning of old events.
setTimeout(() => { try { system.lastBackup = backup(); } catch (e) { log.warn('backup failed', String(e)); } }, 15_000);
setInterval(() => { try { system.lastBackup = backup(); pruneEvents(); } catch (e) { log.warn('backup failed', String(e)); } }, 3600_000);
onNarration(() => {});

const server = createServer();
attachRealtime(server);
server.listen(config.port, config.host, () => {
  log.info(`AUDA ${fresh ? 'is awake for the first time' : 'resumed'} · ${config.publicUrl}${lanAddresses().length ? ` · LAN: ${lanAddresses().map((a) => `http://${a}:${config.port}`).join(', ')}` : ''}`);
  startDiscovery();
  if (!fresh) {
    const open = q.get("SELECT COUNT(*) n FROM tasks WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')")!.n;
    const resp = q.get("SELECT COUNT(*) n FROM responsibilities WHERE state NOT IN ('ENDED','PAUSED')")!.n;
    activity('system', 'AUDA restarted and picked up where it left off', { detail: `${resp} responsibilities and ${open} open tasks resumed from the database.` });
  }
});

let stopping = false;
async function stop(sig: string) {
  if (stopping) return; stopping = true;
  log.info(`stopping (${sig})`);
  stopEngine();
  stopDiscovery();
  server.close();
  await shutdownBrowser();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
// Unexpected errors are recorded with full stacks; the process keeps serving and the
// external supervisor restarts it if it ever stops answering.
const crashLog = (kind: string, e: unknown) => {
  log.error(kind, e);
  system.unexpectedErrors++;
  try { fs.appendFileSync(path.join(config.dataDir, 'crash.log'), `${new Date().toISOString()} ${kind}: ${(e as Error)?.stack ?? e}\n`); } catch { /* best effort */ }
};
process.on('uncaughtException', (e) => crashLog('uncaught exception', e));
process.on('unhandledRejection', (e) => crashLog('unhandled rejection', e));
