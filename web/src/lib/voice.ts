/**
 * Voice: talk to AUDA and (optionally) hear it answer.
 *
 * Recognition uses the browser's SpeechRecognition; the microphone level
 * comes from a Web Audio analyser so the glyph can move with your voice.
 * When AUDA speaks, word boundaries pulse the same signal, so the glyph
 * "talks". Everything degrades quietly: no recognition → no mic button.
 */
export const voiceSignal = { level: 0, listening: false, speaking: false };

const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;
export const voiceSupported = () => !!SR && !!navigator.mediaDevices?.getUserMedia;
export const speechSupported = () => typeof speechSynthesis !== 'undefined';

export function speakReplies(): boolean { try { return localStorage.getItem('auda.voice.speak') !== '0'; } catch { return true; } }
export function setSpeakReplies(v: boolean) { try { localStorage.setItem('auda.voice.speak', v ? '1' : '0'); } catch { /* private mode */ } }

export interface Session { stop: (send?: boolean) => void }

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the browser to talk to AUDA.',
  'service-not-allowed': 'This browser doesn’t allow speech recognition here.',
  'audio-capture': 'AUDA couldn’t hear your microphone. Check that it’s connected and not used by another app.',
  network: 'Speech recognition in this browser needs an internet connection.',
  'language-not-supported': 'Speech recognition doesn’t support this language here.',
};

/** Start listening. Interim text streams to onText; onFinal fires once with the whole utterance (or '' if cancelled/empty). */
export async function listen(o: { onText: (t: string) => void; onFinal: (t: string) => void; onError: (msg: string) => void; lang?: string }): Promise<Session> {
  let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, done = false, cancelled = false, failed = false;
  let finalText = '', interim = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    o.onError((e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser to talk to AUDA.' : 'No microphone is available.');
    return { stop: () => {} };
  }
  // Live level for the glyph.
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const loop = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    voiceSignal.level += (Math.min(1, rms * 5) - voiceSignal.level) * 0.35;
    raf = requestAnimationFrame(loop);
  };
  loop();
  voiceSignal.listening = true;

  const rec = new SR();
  rec.lang = o.lang ?? navigator.language ?? 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e: any) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    o.onText((finalText + interim).trim());
  };
  rec.onerror = (e: any) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return;
    failed = true; // the trailing 'end' must not turn this into an empty request
    o.onError(ERRORS[e.error] ?? `Speech recognition failed (${e.error}).`);
  };
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    voiceSignal.listening = false;
    voiceSignal.level = 0;
    if (!failed) o.onFinal(cancelled ? '' : (finalText + interim).trim());
  };
  rec.onend = finish;
  try { rec.start(); } catch { finish(); }
  return {
    stop: (send = true) => {
      cancelled = !send;
      try { send ? rec.stop() : rec.abort(); } catch { finish(); }
      setTimeout(finish, 1200); // some engines never fire onend after abort
    },
  };
}

/** Speak text aloud; the glyph pulses on each word. Markdown and long lists are trimmed to something sayable. */
export function speak(text: string) {
  if (!speechSupported()) return;
  const say = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').split('\n').filter(Boolean).slice(0, 4).join('. ').slice(0, 600);
  if (!say.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(say);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => v.lang.startsWith((navigator.language ?? 'en').slice(0, 2)) && /natural|neural|premium|enhanced/i.test(v.name))
    ?? voices.find((v) => v.lang.startsWith((navigator.language ?? 'en').slice(0, 2))) ?? null;
  u.rate = 1.02;
  let decay = 0;
  const tick = () => { if (!voiceSignal.speaking) return; voiceSignal.level *= 0.9; decay = requestAnimationFrame(tick); };
  u.onstart = () => { voiceSignal.speaking = true; tick(); };
  u.onboundary = () => { voiceSignal.level = 0.55 + Math.random() * 0.35; };
  u.onend = u.onerror = () => { voiceSignal.speaking = false; voiceSignal.level = 0; cancelAnimationFrame(decay); };
  speechSynthesis.speak(u);
}
export const stopSpeaking = () => { if (speechSupported()) speechSynthesis.cancel(); voiceSignal.speaking = false; voiceSignal.level = 0; };
