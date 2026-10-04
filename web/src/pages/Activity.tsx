/** What happened, in human terms — with the raw record one click away. */
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { Timeline } from '../components/Timeline';
import { Segmented } from '../components/controls';
import { clock } from '../lib/time';
import type { Activity as A } from '../lib/types';

const FILTERS: Record<string, string[] | null> = { all: null, actions: ['act', 'complete', 'user'], decisions: ['approval', 'user'], problems: ['problem', 'recover'], memory: ['memory'] };

export function Activity() {
  const s = useStore();
  const [f, setF] = useState<keyof typeof FILTERS>('all');
  const [mode, setMode] = useState<'story' | 'audit' | 'events'>('story');
  const [older, setOlder] = useState<A[]>([]);
  const [raw, setRaw] = useState<any[]>([]);
  useEffect(() => { if (mode !== 'story') api(mode === 'audit' ? '/api/audit' : '/api/events').then(setRaw); }, [mode, Object.keys(s.activity).length]);
  const items = [...Object.values(s.activity), ...older.filter((o) => !s.activity[o.id])].sort((a, b) => b.ts - a.ts).filter((a) => !FILTERS[f] || FILTERS[f]!.includes(a.kind));
  return (
    <div>
      <div className="page-head">
        <div><h1 className="title-lg">Activity</h1><p>What AUDA noticed, decided, did and recovered from. Nothing consequential happens off the record.</p></div>
        <Segmented id="actmode" size="sm" value={mode} onChange={setMode} options={[{ value: 'story', label: 'Timeline' }, { value: 'audit', label: 'Audit log' }, { value: 'events', label: 'Raw events' }]} />
      </div>
      {mode === 'story' && <>
        <div style={{ marginBottom: 18 }}><Segmented id="actf" size="sm" value={f} onChange={setF} options={[{ value: 'all', label: 'Everything' }, { value: 'actions', label: 'Actions' }, { value: 'decisions', label: 'Decisions' }, { value: 'problems', label: 'Problems & recovery' }, { value: 'memory', label: 'Memory' }]} /></div>
        <div className="card"><Timeline items={items} /></div>
        <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={async () => { const last = items[items.length - 1]; if (last) setOlder([...older, ...(await api<A[]>(`/api/activity?before=${last.ts}`))]); }}>Load older</button>
      </>}
      {mode === 'audit' && (
        <div className="card"><table className="table small"><thead><tr><th>Time</th><th>Who</th><th>Capability</th><th>Target</th><th>Authority</th><th>Result</th></tr></thead>
          <tbody>{raw.map((x) => <tr key={x.id}><td className="tnum faint">{new Date(x.ts).toLocaleDateString()} {clock(x.ts)}</td><td>{x.actor}</td><td className="mono">{x.capability}</td><td className="ellipsis" style={{ maxWidth: 260 }}>{x.detail ?? x.target}</td><td><span className="chip">{x.decision}</span></td><td><span className={`chip ${x.result === 'ok' ? 'settled' : x.result === 'deduplicated' ? '' : 'problem'}`}>{x.result}</span></td></tr>)}</tbody></table>
          {!raw.length && <div className="faint small">No external actions yet.</div>}</div>
      )}
      {mode === 'events' && <div className="card"><table className="table small mono"><tbody>{raw.map((e) => <tr key={e.id}><td className="faint">{clock(e.created_at)}</td><td>{e.type}</td><td className="faint">{e.subject_type}:{e.subject_id?.slice(-6)}</td><td className="ellipsis" style={{ maxWidth: 420 }}>{e.payload_json}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
