/** Settings: identity, autonomy, rules, models, notifications, security, resources. */
import { useState } from 'react';
import { useStore, getTheme, setTheme } from '../lib/store';
import { api, post } from '../lib/api';
import { useRoute, navigate } from '../lib/router';
import { Segmented, Button, Toggle, Empty } from '../components/controls';
import { RuleCard } from '../components/RuleCard';
import { setSoundEnabled } from '../lib/sound';

const TABS = [['identity', 'Identity'], ['autonomy', 'Autonomy'], ['rules', 'Rules'], ['models', 'Models'], ['notifications', 'Notifications'], ['security', 'Security'], ['resources', 'Resources']] as const;
const LEVEL_LABEL: Record<string, string> = { autonomous: 'On its own', rule: 'By your rules', approval: 'Always asks', deny: 'Never' };
const put = (key: string, value: unknown) => api(`/api/settings/${key}`, { method: 'PUT', body: { value } });

function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return <div className="set-row"><div className="grow"><div style={{ fontWeight: 560 }}>{title}</div>{sub && <div className="small faint">{sub}</div>}</div><div>{children}</div></div>;
}

function Rules() {
  const s = useStore();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const rules = Object.values(s.rules).sort((a, b) => ({ draft: 0, active: 1, disabled: 2 }[a.state] - { draft: 0, active: 1, disabled: 2 }[b.state]) || b.createdAt - a.createdAt);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>Write rules the way you’d say them. AUDA shows how it understood each one; nothing takes effect until you activate it.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await post('/api/rules', { text }); setText(''); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Always ask before deleting files outside /tmp" />
        <Button variant="primary" busy={busy} disabled={!text.trim()}>Interpret</Button>
      </form>
      <div className="row wrap" style={{ gap: 6 }}>{['Never spend money', 'Never contact clients after 20:00', "Don't wake me for low-priority completed jobs", 'You can re-run failed CI without asking', 'Spend up to €5 in API credits per day'].map((x) => <button key={x} className="chip btnlike" onClick={() => setText(x)}>{x}</button>)}</div>
      {err && <div className="chip problem">{err}</div>}
      {rules.map((r) => <RuleCard key={r.id} rule={r} />)}
      {!rules.length && <Empty title="No rules yet">Defaults apply: reading is autonomous, destructive and external actions always ask.</Empty>}
    </div>
  );
}

export function Settings() {
  const s = useStore();
  const { query } = useRoute();
  const tab = (query.get('tab') ?? 'identity') as typeof TABS[number][0];
  const st = s.settings;
  const [name, setName] = useState(s.identity?.userName ?? '');
  const [hook, setHook] = useState('');
  const [local, setLocal] = useState(st?.models.local ?? { baseUrl: '', model: '' });
  if (!st) return null;
  const groups = [...new Set(st.capabilities.map((c) => c.group))];
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">Settings</h1></div></div>
      <div className="settings-tabs"><Segmented id="settings" size="sm" value={tab} onChange={(v) => navigate(`/settings?tab=${v}`)} options={TABS.map(([v, l]) => ({ value: v, label: l }))} /></div>
      <div className="card settings-card">
        {tab === 'identity' && <div className="stack" style={{ gap: 4 }}>
          <Row title="What should AUDA call you?"><form className="row" onSubmit={(e) => { e.preventDefault(); void put('identity', { userName: name }); }}><input className="input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} /><Button size="sm">Save</Button></form></Row>
          <Row title="Appearance" sub="Follows your system unless you choose."><Segmented id="theme" size="sm" value={getTheme()} onChange={setTheme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Row>
          <Row title="AUDA" sub="One entity across every channel and model. Its name and glyph are fixed by design."><span className="chip">AUDA</span></Row>
        </div>}
        {tab === 'autonomy' && <div className="stack" style={{ gap: 18 }}>
          <p className="muted" style={{ margin: 0 }}>What AUDA may do on its own. “By your rules” means it asks unless one of your rules allows it.</p>
          {groups.map((g) => (
            <div key={g}><div className="label" style={{ marginBottom: 6 }}>{g}</div>
              {st.capabilities.filter((c) => c.group === g).map((c) => (
                <Row key={c.id} title={c.title} sub={`${c.id} · ${c.risk}${c.level !== c.default ? ` · default: ${LEVEL_LABEL[c.default]}` : ''}`}>
                  <Segmented id={`cap-${c.id}`} size="sm" value={c.level} onChange={(v) => post('/api/permissions', { capability: c.id, level: v })} options={['autonomous', 'rule', 'approval', 'deny'].map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} />
                </Row>
              ))}
            </div>
          ))}
        </div>}
        {tab === 'rules' && <Rules />}
        {tab === 'models' && <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>AUDA is one entity; models are interchangeable parts under the hood. Without a reasoning model AUDA still runs every built-in playbook.</p>
          {Object.entries(st.models.roles).map(([role, t]) => (
            <Row key={role} title={role[0].toUpperCase() + role.slice(1)} sub={role === 'reasoning' ? 'Open-ended tasks and chat' : role === 'utility' ? 'Summaries, rule compilation, consolidation' : role === 'fallback' ? 'Used when the primary fails' : role === 'coding' ? 'CI diagnosis and code' : 'Screenshots and images'}>
              <div className="row"><select className="input" style={{ width: 130 }} value={t.provider} onChange={(e) => put('models', { roles: { ...st.models.roles, [role]: { ...t, provider: e.target.value } } })}><option value="anthropic">Anthropic</option><option value="local">Local</option><option value="none">None</option></select>
                <input className="input" style={{ width: 190 }} defaultValue={t.model} onBlur={(e) => put('models', { roles: { ...st.models.roles, [role]: { ...t, model: e.target.value } } })} /></div>
            </Row>
          ))}
          <Row title="Claude" sub={st.models.anthropicConnected ? (st.models.anthropicFromEnv ? 'Using ANTHROPIC_API_KEY from the environment' : 'Connected — key encrypted at rest') : 'Not connected'}><Button size="sm" onClick={() => navigate('/connections')}>{st.models.anthropicConnected ? 'Manage' : 'Connect'}</Button></Row>
          <Row title="Local model endpoint" sub="OpenAI-compatible (Ollama, llama.cpp, vLLM). Used for text tasks."><form className="row" onSubmit={(e) => { e.preventDefault(); void put('models', { local }); }}><input className="input" style={{ width: 200 }} placeholder="http://localhost:11434" value={local.baseUrl} onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })} /><input className="input" style={{ width: 130 }} placeholder="model" value={local.model} onChange={(e) => setLocal({ ...local, model: e.target.value })} /><Button size="sm">Save</Button></form></Row>
        </div>}
        {tab === 'notifications' && <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>A useful operator works quietly. Choose what may interrupt you; everything else waits in the inbox.</p>
          {Object.entries(st.notificationPrefs).map(([lvl, pref]) => (
            <Row key={lvl} title={{ fyi: 'FYI', completed: 'Completed work', attention: 'Needs attention', approval: 'Approval required', blocked: 'Blocked', urgent: 'Urgent', watching: 'Watching updates' }[lvl] ?? lvl}>
              <Segmented id={`n-${lvl}`} size="sm" value={pref} onChange={(v) => put('notifications.prefs', { ...st.notificationPrefs, [lvl]: v })} options={[{ value: 'interrupt', label: 'Interrupt' }, { value: 'inbox', label: 'Inbox' }, { value: 'silent', label: 'Silent' }]} />
            </Row>
          ))}
          <Row title="Interaction sounds" sub="A tiny click, a soft completion tone. Off by default."><Toggle checked={st.sound} onChange={(v) => { setSoundEnabled(v); void put('ui.sound', v); }} /></Row>
          <Row title="Outbound channel" sub={st.notificationWebhook ? 'Configured — interrupting notifications are also POSTed there.' : 'Slack/Discord-compatible webhook or ntfy URL.'}><form className="row" onSubmit={(e) => { e.preventDefault(); void put('notifications.webhook', hook); setHook(''); }}><input className="input" style={{ width: 260 }} placeholder="https://…" value={hook} onChange={(e) => setHook(e.target.value)} /><Button size="sm">Save</Button></form></Row>
        </div>}
        {tab === 'security' && <div className="stack" style={{ gap: 14 }}>
          <dl className="kv">
            <dt>Credentials</dt><dd>Encrypted at rest with AES-256-GCM (key in <span className="mono">data/master.key</span> or <span className="mono">AUDA_MASTER_KEY</span>). Resolved only inside connectors at call time; never sent to a model, never shown in the UI.</dd>
            <dt>Capabilities</dt><dd>Models see tools like <span className="mono">github.rerun_workflow</span>, never tokens. Every use passes the policy engine.</dd>
            <dt>Computer</dt><dd>Commands run inside AUDA’s workspace with a scrubbed environment — no host secrets are inherited.</dd>
            <dt>Idempotency</dt><dd>Every side effect has an idempotency key; retries replay stored results instead of acting twice. External actions in an unknown state are never repeated without you.</dd>
            <dt>Access</dt><dd>Set <span className="mono">AUDA_TOKEN</span> to require a token for the UI and API.</dd>
          </dl>
          <Button size="sm" onClick={() => navigate('/activity')}>Open the audit log</Button>
        </div>}
        {tab === 'resources' && <div className="stack" style={{ gap: 4 }}>
          <Row title="Model spend today" sub={`This month: $${st.spend.month.toFixed(2)}`}><span className="tnum title" style={{ fontSize: 18 }}>${st.spend.today.toFixed(2)}</span></Row>
          <Row title="Daily model budget" sub="Work that needs a model pauses when reached."><input className="input" style={{ width: 100 }} type="number" min={0} step={0.5} defaultValue={st.models.dailyBudget} onBlur={(e) => put('models', { dailyBudget: Number(e.target.value) })} /></Row>
          <Row title="Monthly model budget"><input className="input" style={{ width: 100 }} type="number" min={0} step={1} defaultValue={st.models.monthlyBudget} onBlur={(e) => put('models', { monthlyBudget: Number(e.target.value) })} /></Row>
          <Row title="Concurrent tasks" sub="How many tasks AUDA works on at once (applies after restart)."><Segmented id="conc" size="sm" value={String(st.concurrency)} onChange={(v) => put('engine.concurrency', Number(v))} options={['1', '2', '3', '4', '6'].map((x) => ({ value: x, label: x }))} /></Row>
        </div>}
      </div>
    </div>
  );
}
