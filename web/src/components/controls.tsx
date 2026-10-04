import { useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { sound } from '../lib/sound';

export function Button({ variant, size, icon, children, onClick, busy, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'lg'; icon?: string; busy?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <motion.button
      {...(rest as any)}
      className={['btn', variant, size, !children && icon ? 'icon' : '', rest.className].filter(Boolean).join(' ')}
      data-pressed={pressed}
      whileTap={{ scale: 0.975 }}
      transition={fm.snap}
      onPointerDown={() => setPressed(true)} onPointerUp={() => setPressed(false)} onPointerLeave={() => setPressed(false)}
      onClick={(e) => { sound.click(); onClick?.(e as any); }}
    >
      {(icon || busy) && <Morph shape={busy ? 'orbit' : icon!} size={size === 'sm' ? 15 : 17} />}
      {children}
    </motion.button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => { sound.click(); onChange(!checked); }}>
      <motion.span className="knob" animate={{ x: checked ? 18 : 0 }} transition={fm.settle} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size, id }: {
  value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; size?: 'sm'; id: string;
}) {
  return (
    <div className={`seg ${size ?? ''}`} role="group">
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => { sound.click(); onChange(o.value); }}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="thumb" transition={fm.settle} />}
          {o.label}
          {o.count != null && o.count > 0 && <span className="faint tnum">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside className="sheet" role="dialog" aria-modal="true"
            initial={{ x: 40, opacity: 0, scale: 0.985 }} animate={{ x: 0, opacity: 1, scale: 1 }} exit={{ x: 40, opacity: 0, scale: 0.985 }} transition={fm.glide}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => <button key={o.value} role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><span className="voice">{title}</span>{children}</div>;
}
