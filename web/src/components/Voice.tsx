/**
 * Talk to AUDA. Hold Space (anywhere you aren't typing) or tap the mic:
 * the glyph listens and moves with your voice, your words appear as you
 * speak, and on release AUDA answers — on screen and, if you like, aloud.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { post } from '../lib/api';
import { navigate } from '../lib/router';
import { listen, speak, stopSpeaking, voiceSupported, speechSupported, speakReplies, setSpeakReplies, type Session } from '../lib/voice';
import { Aperture } from '../motion/Aperture';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { sound } from '../lib/sound';

type Phase = 'idle' | 'listening' | 'thinking' | 'answer' | 'error';
let toggleFn: (() => void) | null = null;
export const toggleVoice = () => toggleFn?.();

export function VoiceButton() {
  const [ok] = useState(voiceSupported);
  if (!ok) return null;
  return (
    <button className="btn ghost icon voice-btn" aria-label="Talk to AUDA (hold Space)" title="Talk to AUDA — hold Space" onClick={() => toggleVoice()}>
      <Morph shape="wave" size={20} color="var(--ink-3)" />
    </button>
  );
}

export function Voice() {
  const s = useStore();
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [err, setErr] = useState('');
  const [aloud, setAloud] = useState(speakReplies);
  const session = useRef<Session | null>(null);
  const held = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const send = async (said: string) => {
    if (!said) { setPhase('idle'); return; }
    setPhase('thinking');
    try {
      const r = await post<{ reply: { text: string } }>('/api/chat', { text: said, channel: 'voice' });
      const answer = r.reply?.text ?? '';
      setReply(answer);
      setPhase('answer');
      sound.complete();
      if (speakReplies() && answer) speak(answer);
    } catch (e) { setErr((e as Error).message); setPhase('error'); }
  };
  const start = async () => {
    if (phaseRef.current === 'listening') return;
    stopSpeaking();
    setText(''); setReply(''); setErr('');
    setPhase('listening');
    sound.click();
    session.current = await listen({
      onText: setText,
      // An error already explains itself on screen; the engine's trailing 'end' must not wipe it.
      onFinal: (t) => { session.current = null; if (phaseRef.current !== 'error') void send(t); },
      onError: (m) => { phaseRef.current = 'error'; setErr(m); setPhase('error'); },
    });
  };
  const finish = (sendIt = true) => { session.current?.stop(sendIt); if (!sendIt) setPhase('idle'); };
  const close = () => { finish(false); stopSpeaking(); setPhase('idle'); };

  useEffect(() => {
    toggleFn = () => (phaseRef.current === 'listening' ? finish(true) : phaseRef.current === 'idle' || phaseRef.current === 'answer' || phaseRef.current === 'error' ? void start() : undefined);
    if (!voiceSupported()) return;
    const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && phaseRef.current !== 'idle') { close(); return; }
      if (e.code !== 'Space' || e.repeat || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.pal, .sheet')) return;
      e.preventDefault();
      held.current = true;
      void start();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && held.current) { held.current = false; e.preventDefault(); finish(true); } };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); toggleFn = null; };
  }, []);

  const glyph = phase === 'listening' ? 'listening' : phase === 'thinking' ? 'thinking' : phase === 'error' ? 'blocked' : s.identity?.presence ?? 'available';
  return (
    <AnimatePresence>
      {phase !== 'idle' && (
        <motion.div className="voice-layer" role="dialog" aria-modal="true" aria-label="Talking to AUDA" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="voice-backdrop" onClick={close} />
          <motion.div className="voice-stage" initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 10, opacity: 0 }} transition={fm.expressive}>
            <Aperture state={glyph} size={220} reactive />
            <div className="voice-state">{phase === 'listening' ? (held.current ? 'Listening — release to send' : 'Listening — tap to send') : phase === 'thinking' ? 'Thinking…' : phase === 'answer' ? 'AUDA' : 'Something went wrong'}</div>
            <AnimatePresence mode="wait">
              <motion.div key={phase === 'answer' ? 'a' : 'q'} className={`voice-text ${phase === 'answer' ? 'answer' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={fm.glide}>
                {phase === 'answer' ? reply : phase === 'error' ? err : text || <span className="faint">Say what you need…</span>}
              </motion.div>
            </AnimatePresence>
            {phase === 'answer' && text && <div className="small faint voice-you">You: “{text}”</div>}
            <div className="row voice-actions">
              {phase === 'listening' && <button className="btn primary" onClick={() => finish(true)}><Morph shape="arrowUp" size={16} />Send</button>}
              {(phase === 'answer' || phase === 'error') && <button className="btn primary" onClick={() => void start()}><Morph shape="wave" size={16} />Talk again</button>}
              {phase === 'answer' && <button className="btn" onClick={() => { close(); navigate('/chat'); }}>Open chat</button>}
              <button className="btn ghost" onClick={close}>{phase === 'listening' ? 'Cancel' : 'Close'}</button>
              {speechSupported() && <label className="row small faint" style={{ gap: 6, marginLeft: 6 }}><input type="checkbox" checked={aloud} onChange={(e) => { setAloud(e.target.checked); setSpeakReplies(e.target.checked); if (!e.target.checked) stopSpeaking(); }} />Speak answers</label>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
