/** Subtle interaction acoustics, synthesized (no files). Off unless enabled. */
let ctx: AudioContext | null = null;
let enabled = false;
export const setSoundEnabled = (v: boolean) => { enabled = v; };
function ac() { if (!ctx) ctx = new AudioContext(); return ctx; }
function tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0) {
  const c = ac(); const t = c.currentTime + delay;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}
export const sound = {
  click() { if (enabled) tone(2200, 0.03, 0.03, 'triangle'); },
  complete() { if (enabled) { tone(660, 0.18, 0.035); tone(990, 0.26, 0.03, 'sine', 0.07); } },
  attention() { if (enabled) { tone(520, 0.22, 0.03); tone(520, 0.22, 0.025, 'sine', 0.28); } },
};
