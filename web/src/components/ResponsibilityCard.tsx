import { motion } from 'motion/react';
import type { Responsibility } from '../lib/types';
import { fm } from '../motion/spring';
import { RespGlyph, RESP_LABEL } from './glyphs';
import { Sparkline } from './Sparkline';
import { ago, until } from '../lib/time';
import { openSheet } from './ui';

export function ResponsibilityCard({ r, compact }: { r: Responsibility; compact?: boolean }) {
  const disk = r.watchers.find((w) => w.kind === 'disk');
  const next = r.schedules.filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
  return (
    <motion.button layout="position" layoutId={`resp-${r.id}`} className={`resp-card s-${r.state}`} onClick={() => openSheet({ type: 'responsibility', id: r.id })}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: r.state === 'ENDED' ? 0.6 : 1, y: 0 }} whileTap={{ scale: 0.985 }} transition={fm.glide}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div className="resp-glyph"><RespGlyph state={r.state} size={22} /></div>
        <div className="grow">
          <div className="task-title">{r.title}</div>
          <div className="resp-status">{r.statusLine}</div>
        </div>
        <span className={`chip ${r.state === 'NEEDS_USER' ? 'attention' : r.state === 'HANDLING' ? 'accent' : ''}`}>{RESP_LABEL[r.state]}</span>
      </div>
      {!compact && (
        <div className="resp-live">
          {r.watchers.filter((w) => w.enabled).map((w) => (
            <div key={w.id} className="watch-line">
              <span className="faint small">{w.description}</span>
              <span className="small tnum">{w.lastValue ?? 'Starting…'}</span>
            </div>
          ))}
          {next && <div className="watch-line"><span className="faint small">Next run</span><span className="small">{next.description} · {until(next.nextRunAt)}</span></div>}
          {disk?.history && <Sparkline points={disk.history} threshold={r.config.thresholdPct} width={260} height={36} />}
          {r.lastOutcome && <div className="resp-outcome small"><span className="faint">Last time{r.lastTriggeredAt ? ` (${ago(r.lastTriggeredAt)})` : ''}: </span>{r.lastOutcome}</div>}
        </div>
      )}
    </motion.button>
  );
}
