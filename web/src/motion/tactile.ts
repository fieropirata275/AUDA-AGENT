/**
 * Tactile light: ceramic surfaces catch a soft specular highlight that
 * follows the pointer, as if lit from where you are. One delegated listener
 * for the whole app; it only writes two CSS variables on the surface under
 * the pointer, and does nothing on touch or under reduced motion.
 */
import { prefersReducedMotion } from './spring';

const SURFACES = '.task-card, .agent-card, .conn, .count-tile, .resp-card, .member-row, .tpl, .approval, .agent-create, .finished, .pal, .card:not(.flat), .hit, .settings-card, .rule-card, .memory';

export function initTactile() {
  if (prefersReducedMotion() || matchMedia('(hover: none)').matches) return;
  let lit: HTMLElement | null = null;
  let frame = 0, ev: PointerEvent | null = null;
  const off = () => { lit?.classList.remove('lit'); lit = null; };
  const apply = () => {
    frame = 0;
    if (!ev) return;
    const el = (ev.target as Element | null)?.closest?.(SURFACES) as HTMLElement | null;
    if (el !== lit) { off(); if (el) { lit = el; el.classList.add('lit'); } }
    if (!lit) return;
    const r = lit.getBoundingClientRect();
    lit.style.setProperty('--mx', `${ev.clientX - r.left}px`);
    lit.style.setProperty('--my', `${ev.clientY - r.top}px`);
  };
  addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; ev = e; if (!frame) frame = requestAnimationFrame(apply); }, { passive: true });
  document.addEventListener('pointerleave', off);
  addEventListener('blur', off);
}
