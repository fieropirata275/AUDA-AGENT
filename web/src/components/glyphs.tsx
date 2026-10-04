import { Morph } from '../motion/Morph';
import { taskShape, presenceShape } from '../motion/shapes';

const TASK_COLOR: Record<string, string> = {
  RUNNING: 'var(--accent)', WAITING_USER: 'var(--attention)', COMPLETED: 'var(--settled)', FAILED: 'var(--problem)', RETRYING: 'var(--attention)', RECOVERING: 'var(--attention)',
};
export function TaskGlyph({ state, attention, size = 20 }: { state: string; attention?: string | null; size?: number }) {
  const shape = attention === 'problem' && state === 'WAITING_USER' ? 'blocked' : taskShape[state] ?? 'dots';
  return <Morph shape={shape} size={size} color={attention === 'problem' ? 'var(--problem)' : TASK_COLOR[state] ?? 'var(--ink-3)'} />;
}

const RESP: Record<string, string> = { WATCHING: 'eye', HANDLING: 'orbit', NEEDS_USER: 'attention', PAUSED: 'pause', ENDED: 'close', DRAFT: 'rest' };
export function RespGlyph({ state, size = 20 }: { state: string; size?: number }) {
  return <Morph shape={RESP[state] ?? 'eye'} size={size} color={state === 'NEEDS_USER' ? 'var(--attention)' : state === 'HANDLING' ? 'var(--accent)' : 'var(--ink-2)'} />;
}

export function PresenceGlyph({ presence, size = 16 }: { presence: string; size?: number }) {
  const c = presence === 'needs_you' ? 'var(--attention)' : presence === 'blocked' ? 'var(--problem)' : ['working', 'coding', 'browsing', 'thinking'].includes(presence) ? 'var(--accent)' : 'var(--ink-3)';
  return <Morph shape={presenceShape[presence] ?? 'dots'} size={size} color={c} />;
}

export const PRESENCE_LABEL: Record<string, string> = {
  available: 'Available', thinking: 'Thinking', working: 'Working', browsing: 'Browsing', coding: 'At the terminal', waiting: 'Waiting', watching: 'Watching',
  scheduled: 'Scheduled', needs_you: 'Needs you', blocked: 'Blocked', idle: 'Resting', recovering: 'Recovering', listening: 'Listening',
};
export const TASK_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PLANNING: 'Planning', READY: 'Up next', RUNNING: 'Working', WAITING_EXTERNAL: 'Waiting', WAITING_USER: 'Needs you', SCHEDULED: 'Scheduled',
  PAUSED: 'Paused', RETRYING: 'Retrying', RECOVERING: 'Recovering', COMPLETED: 'Done', FAILED: 'Hit a problem', CANCELLED: 'Stopped',
};
export const RESP_LABEL: Record<string, string> = { WATCHING: 'Watching', HANDLING: 'Handling', NEEDS_USER: 'Needs you', PAUSED: 'Paused', ENDED: 'Ended', DRAFT: 'Draft' };
