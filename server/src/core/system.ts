/** Process-level health facts shared by the supervisor loop, the API and the UI. */
export const system = {
  startedAt: Date.now(),
  safeMode: process.env.AUDA_SAFE_MODE === '1',
  supervised: process.env.AUDA_SUPERVISED === '1',
  restartsRecent: Number(process.env.AUDA_RESTARTS ?? 0),
  lastBackup: null as string | null,
  loopLagMs: 0,
  loopLagMaxMs: 0,
  diskFreeMb: null as number | null,
  unexpectedErrors: 0,
};

// Event-loop lag: if timers fire late, everything (watchers, heartbeats, UI) is late.
let expected = Date.now() + 1000;
setInterval(() => {
  const lag = Math.max(0, Date.now() - expected);
  system.loopLagMs = Math.round(system.loopLagMs * 0.8 + lag * 0.2);
  system.loopLagMaxMs = Math.max(system.loopLagMaxMs * 0.995, lag);
  expected = Date.now() + 1000;
}, 1000).unref();
