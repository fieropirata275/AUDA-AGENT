/** Small living details: rolling numbers, narration that speaks word by word, and the activity pulse. */
import { motion, AnimatePresence } from 'motion/react';
import { prefersReducedMotion } from './spring';

/** An odometer: each digit rolls to its new value on a spring. */
export function Ticker({ value, className }: { value: number; className?: string }) {
  const digits = String(Math.max(0, Math.round(value))).split('');
  if (prefersReducedMotion()) return <span className={className}>{value}</span>;
  return (
    <span className={`ticker ${className ?? ''}`} aria-label={String(value)}>
      <AnimatePresence initial={false} mode="popLayout">
        {digits.map((d, i) => (
          <span key={`${digits.length - i}`} className="ticker-col" aria-hidden="true">
            <motion.span className="ticker-strip" initial={false} animate={{ y: `-${Number(d) * 10}%` }} transition={{ type: 'spring', stiffness: 260, damping: 24, mass: 0.8 }}>
              {'0123456789'.split('').map((n) => <span key={n}>{n}</span>)}
            </motion.span>
          </span>
        ))}
      </AnimatePresence>
    </span>
  );
}

/** Narration that arrives the way speech does: word by word, settling out of a soft blur. */
export function Spoken({ text, className }: { text: string; className?: string }) {
  if (prefersReducedMotion()) return <p className={className}>{text}</p>;
  const words = text.split(/(\s+)/);
  return (
    <AnimatePresence mode="wait">
      <motion.p key={text} className={className} exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }} aria-label={text}>
        {words.map((w, i) => /^\s+$/.test(w) ? w : (
          <motion.span key={i} aria-hidden="true" style={{ display: 'inline-block' }}
            initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ delay: i * 0.028, type: 'spring', stiffness: 300, damping: 26 }}>{w}</motion.span>
        ))}
      </motion.p>
    </AnimatePresence>
  );
}

/** A hairline across the top of the page; each agent at work is a comet of light travelling along it. */
export function Pulse({ running, waiting }: { running: number; waiting: number }) {
  if (prefersReducedMotion() || (!running && !waiting)) return null;
  const comets = Math.min(running, 6);
  return (
    <div className="pulse-line" aria-hidden="true">
      {Array.from({ length: comets }, (_, i) => (
        <span key={i} className="comet" style={{ animationDuration: `${3.2 + i * 0.7}s`, animationDelay: `${-i * 1.1}s` }} />
      ))}
      {waiting > 0 && <span className="pulse-wait" />}
    </div>
  );
}
