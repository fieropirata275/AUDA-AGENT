/** Organization: who works with this AUDA, their roles, and invites. Plus the sign-in and join screens. */
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useStore, bootstrap } from '../lib/store';
import { api, post, patch, del } from '../lib/api';
import { Button, Empty } from '../components/controls';
import { Aperture } from '../motion/Aperture';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { ago } from '../lib/time';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function Setup() {
  const s = useStore();
  const [f, setF] = useState({ orgName: '', name: s.me?.name === 'Owner' ? '' : s.me?.name ?? '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await post('/api/org/setup', f); await bootstrap(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card stack" style={{ gap: 12, maxWidth: 560 }}>
      <div className="title" style={{ fontSize: 18 }}>Bring your team</div>
      <p className="small muted" style={{ margin: 0 }}>Turning the organization on gives everyone their own account: their own chats, tasks, plugin connections and agents — shared only when they choose. You become the owner; after this, everyone signs in, including you.</p>
      <input className="input" placeholder="Organization name" value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value })} />
      <div className="row"><input className="input" placeholder="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><input className="input" type="email" placeholder="Your email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <input className="input" type="password" placeholder="Password (8+ characters)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <Button variant="primary" style={{ alignSelf: 'flex-start' }} busy={busy} disabled={!f.orgName || !f.email || f.password.length < 8} onClick={go}>Turn on the organization</Button>
      {err && <div className="chip problem">{err}</div>}
    </div>
  );
}

export function Org() {
  const s = useStore();
  const [data, setData] = useState<{ members: any[]; invites: any[] } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [link, setLink] = useState('');
  const [err, setErr] = useState('');
  const me = s.me;
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const load = () => api('/api/org/members').then(setData).catch(() => {});
  useEffect(() => { void load(); }, [Object.keys(s.members).length]);
  const invite = async () => {
    setErr('');
    try { const r = await post('/api/org/invites', { email: email || undefined, role }); setLink(r.link); setEmail(''); void load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">{s.org.enabled ? s.org.name : 'Organization'}</h1><p>{s.org.enabled ? 'People who work with this AUDA. Everyone has their own agents, plugin connections and work; admins can supervise all of it.' : 'AUDA is single-user right now.'}</p></div>
        {s.org.enabled && <Button variant="ghost" onClick={() => post('/api/auth/logout').then(() => location.assign('/'))}>Sign out</Button>}
      </div>
      {!s.org.enabled && (me?.role === 'owner' ? <Setup /> : <Empty title="Only the owner can set this up" />)}
      {s.org.enabled && (
        <>
          <section className="section">
            <div className="section-head"><h2>Members</h2><span className="n">{data?.members.length ?? 0}</span></div>
            <div className="stack" style={{ gap: 8 }}>
              {data?.members.map((m) => (
                <motion.div key={m.id} layout className="member-row" transition={fm.glide}>
                  <span className="avatar">{m.name.slice(0, 1).toUpperCase()}</span>
                  <div className="grow"><div style={{ fontWeight: 600 }}>{m.name}{m.id === me?.id && <span className="faint small"> · you</span>}</div><div className="small faint">{m.email} · {m.lastSeenAt ? `seen ${ago(m.lastSeenAt)}` : 'not signed in yet'}</div></div>
                  {me?.role === 'owner' && m.role !== 'owner'
                    ? <select className="input" style={{ width: 120 }} value={m.role} onChange={(e) => patch(`/api/org/members/${m.id}`, { role: e.target.value }).then(load)}><option value="member">Member</option><option value="admin">Admin</option></select>
                    : <span className={`chip ${m.role === 'member' ? '' : 'accent'}`}>{ROLE[m.role]}</span>}
                  {admin && m.role !== 'owner' && m.id !== me?.id && <button className="btn ghost sm danger" onClick={() => { if (confirm(`Remove ${m.name}? Their sessions and paired phones stop working.`)) void del(`/api/org/members/${m.id}`).then(load); }}>Remove</button>}
                </motion.div>
              ))}
            </div>
          </section>
          {admin && (
            <section className="section">
              <div className="section-head"><h2>Invite</h2><span className="faint small">Links work once and expire in 7 days.</span></div>
              <div className="row" style={{ maxWidth: 640 }}>
                <input className="input" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
                <select className="input" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value as any)}><option value="member">Member</option><option value="admin">Admin</option></select>
                <Button variant="primary" onClick={invite}>Create link</Button>
              </div>
              {link && (
                <motion.div className="row" style={{ marginTop: 10, maxWidth: 640 }} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                  <code className="mono small well grow" style={{ padding: '8px 12px', overflowWrap: 'anywhere' }}>{link}</code>
                  <Button size="sm" onClick={() => navigator.clipboard?.writeText(link)}>Copy</Button>
                </motion.div>
              )}
              {err && <div className="chip problem" style={{ marginTop: 8 }}>{err}</div>}
              {(data?.invites.length ?? 0) > 0 && (
                <div className="stack" style={{ gap: 6, marginTop: 14 }}>
                  <div className="label">Pending</div>
                  {data!.invites.map((i) => <div key={i.id} className="kb-row"><Morph shape="clock" size={14} color="var(--ink-3)" animate={false} /><span className="grow small">{i.email ?? 'Anyone with the link'} · {ROLE[i.role]} · expires {ago(i.expiresAt).replace(' ago', '')}</span><button className="btn ghost sm" onClick={() => del(`/api/org/invites/${i.id}`).then(load)}>Revoke</button></div>)}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Shown instead of the app when the organization is on and this browser isn't signed in. */
export function SignIn() {
  const s = useStore();
  const code = new URLSearchParams(location.search).get('code');
  const joining = location.pathname === '/join' && !!code;
  const [invite, setInvite] = useState<any>(null);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (joining) api(`/api/join/${code}`).then((i) => { setInvite(i); if (i.email) setF((x) => ({ ...x, email: i.email })); }).catch((e) => setErr(e.message)); }, []);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (joining) await post('/api/join', { code, ...f }); else await post('/api/auth/login', { email: f.email, password: f.password });
      history.replaceState(null, '', '/');
      location.reload();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="signin">
      <motion.div className="signin-card" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={fm.glide}>
        <Aperture state={busy ? 'thinking' : err ? 'blocked' : 'available'} size={96} />
        <h1 className="voice" style={{ fontSize: 30, fontWeight: 400, margin: '14px 0 2px' }}>{joining ? `Join ${invite?.org ?? s.org.name ?? 'the team'}` : s.org.name || 'AUDA'}</h1>
        <p className="muted small" style={{ marginTop: 0 }}>{joining ? (invite ? `${invite.invitedBy ?? 'Someone'} invited you as ${ROLE[invite.role]?.toLowerCase()}.` : 'Checking your invite…') : 'Sign in to your AUDA.'}</p>
        <form className="stack" style={{ gap: 10, width: '100%' }} onSubmit={(e) => { e.preventDefault(); void go(); }}>
          {joining && <input className="input" placeholder="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />}
          <input className="input" type="email" placeholder="Email" value={f.email} disabled={joining && !!invite?.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
          <input className="input" type="password" placeholder={joining ? 'Choose a password (8+ characters)' : 'Password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={joining ? 'new-password' : 'current-password'} />
          <Button variant="primary" size="lg" busy={busy} disabled={!f.email || !f.password || (joining && !invite)} type="submit">{joining ? 'Create account' : 'Sign in'}</Button>
        </form>
        {err && <div className="chip problem" style={{ marginTop: 10 }}>{err}</div>}
        {joining && <button className="link small" style={{ marginTop: 12 }} onClick={() => { history.replaceState(null, '', '/'); location.reload(); }}>I already have an account</button>}
      </motion.div>
    </div>
  );
}
