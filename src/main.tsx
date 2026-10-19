import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { isLocalDate } from './domain/dates';
import type { AppState } from './domain/types';
import { DemoRepository } from './data/demo';
import { liveConfigFromEnv, SupabaseRepository } from './data/live';
import { App } from './ui/App';
import { Button, Field, Notice, Spinner } from './ui/components';
import { AppProvider } from './ui/store';

function safeStorage(): Storage | null {
  try {
    const k = '__tzml_probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return null;
  }
}

function DemoBoot() {
  const [boot, setBoot] = useState<{ repo: DemoRepository; state: AppState } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const repo = new DemoRepository(safeStorage());
      const date = params.get('demoDate');
      let state = await repo.load();
      if (params.get('demoReset') === '1') state = await repo.reset(date && isLocalDate(date) ? date : undefined);
      if (params.has('demoReset') || params.has('demoDate')) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      setBoot({ repo, state });
    })().catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="p-6"><Notice tone="block" title="Could not start demo">{error}</Notice></div>;
  if (!boot) return <div className="flex min-h-screen items-center justify-center"><Spinner label="Loading demo kitchen…" /></div>;
  return <AppProvider repo={boot.repo} demo={boot.repo} initial={boot.state}><App /></AppProvider>;
}

function LiveBoot({ repo, onDemo }: { repo: SupabaseRepository; onDemo: () => void }) {
  const [phase, setPhase] = useState<'checking' | 'signin' | 'org' | 'ready' | 'error'>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<{ org_id: string; role: string; organizations: { name: string } | null }[]>([]);
  const [state, setState] = useState<AppState | null>(null);
  const [newOrg, setNewOrg] = useState({ name: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, display: '' });

  const afterAuth = async () => {
    const m = await repo.memberships();
    setOrgs(m);
    if (m.length === 1) return choose(m[0].org_id);
    setPhase('org');
  };
  const choose = async (orgId: string) => {
    repo.orgId = orgId;
    try {
      setState(await repo.load());
      setPhase('ready');
    } catch (e) {
      setMsg((e as Error).message);
      setPhase('error');
    }
  };
  useEffect(() => {
    repo.client.auth.getSession().then(({ data }) => (data.session ? afterAuth() : setPhase('signin'))).catch(() => setPhase('signin'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'ready' && state) return <AppProvider repo={repo} demo={null} initial={state}><App /></AppProvider>;
  return (
    <div className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="font-serif text-3xl font-semibold">Table Zero Menu Lab</h1>
      {phase === 'checking' && <Spinner label="Checking session…" />}
      {msg && <Notice tone="block">{msg}</Notice>}
      {phase === 'signin' && (
        <form className="card space-y-3 p-4" onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          const { error } = await repo.client.auth.signInWithPassword({ email, password });
          if (error) setMsg(error.message);
          else await afterAuth();
        }}>
          <Field label="Email">{(id) => <input id={id} type="email" autoComplete="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">{(id) => <input id={id} type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit">Sign in</Button>
            <Button onClick={async () => { const { error } = await repo.client.auth.signUp({ email, password }); setMsg(error ? error.message : 'Check your email to confirm, then sign in.'); }}>Create account</Button>
          </div>
        </form>
      )}
      {phase === 'org' && (
        <div className="card space-y-3 p-4">
          {orgs.map((o) => <Button key={o.org_id} className="w-full" onClick={() => choose(o.org_id)}>{o.organizations?.name ?? o.org_id} · {o.role}</Button>)}
          <h2 className="text-lg font-semibold">Create an organization</h2>
          <Field label="Name">{(id) => <input id={id} className="input" value={newOrg.name} onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })} />}</Field>
          <Field label="Your display name">{(id) => <input id={id} className="input" value={newOrg.display} onChange={(e) => setNewOrg({ ...newOrg, display: e.target.value })} />}</Field>
          <Field label="Timezone">{(id) => <input id={id} className="input" value={newOrg.tz} onChange={(e) => setNewOrg({ ...newOrg, tz: e.target.value })} />}</Field>
          <Button variant="primary" disabled={!newOrg.name} onClick={async () => { try { await choose(await repo.createOrganization(newOrg.name, newOrg.tz, newOrg.display || email)); } catch (e) { setMsg((e as Error).message); } }}>Create</Button>
        </div>
      )}
      <Button variant="ghost" onClick={onDemo}>Use the local demo instead</Button>
      <p className="text-xs text-ink-mute">Demo data stays in this browser and is isolated from live organizations.</p>
    </div>
  );
}

function Root() {
  const cfg = liveConfigFromEnv();
  const forceDemo = new URLSearchParams(window.location.search).has('demo') || new URLSearchParams(window.location.search).has('demoReset');
  const [mode, setMode] = useState<'demo' | 'live'>(cfg && !forceDemo ? 'live' : 'demo');
  const [repo] = useState(() => (cfg ? new SupabaseRepository(cfg) : null));
  if (mode === 'live' && repo) return <LiveBoot repo={repo} onDemo={() => setMode('demo')} />;
  return <DemoBoot />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
