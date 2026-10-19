import { useEffect, useState } from 'react';
import type { AppState } from '../domain/types';
import type { SupabaseRepository } from '../data/live';
import { App } from './App';
import { Button, Field, Notice, Spinner } from './components';
import { AppProvider } from './store';

type Phase = 'checking' | 'signin' | 'recovery' | 'org' | 'ready' | 'error';

export const allowDemo = () => import.meta.env.VITE_ALLOW_DEMO !== 'false';

export function LiveBoot({ repo, onDemo }: { repo: SupabaseRepository; onDemo: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ tone: 'block' | 'ok' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<{ org_id: string; role: string; organizations: { name: string } | null }[]>([]);
  const [state, setState] = useState<AppState | null>(null);
  const [newOrg, setNewOrg] = useState({ name: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, display: '' });
  const [invite, setInvite] = useState({ code: '', display: '' });

  const choose = async (orgId: string) => {
    repo.orgId = orgId;
    try {
      localStorage.setItem('tzml.lastOrg', orgId);
    } catch {
      /* convenience only */
    }
    try {
      setState(await repo.load());
      setPhase('ready');
    } catch (e) {
      setMsg({ tone: 'block', text: (e as Error).message });
      setPhase('error');
    }
  };
  const afterAuth = async () => {
    try {
      const m = await repo.memberships();
      setOrgs(m);
      let last: string | null = null;
      try {
        last = localStorage.getItem('tzml.lastOrg');
      } catch {
        /* ignore */
      }
      const pick = m.find((x) => x.org_id === last) ?? (m.length === 1 ? m[0] : null);
      if (pick) return choose(pick.org_id);
      setPhase('org');
    } catch (e) {
      setMsg({ tone: 'block', text: (e as Error).message });
      setPhase('signin');
    }
  };

  useEffect(() => {
    const { data: sub } = repo.client.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setPhase('recovery');
      if (event === 'SIGNED_OUT') {
        setState(null);
        setPhase('signin');
      }
    });
    repo.client.auth.getSession().then(({ data }) => (data.session ? afterAuth() : setPhase('signin'))).catch(() => setPhase('signin'));
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'block', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'ready' && state) {
    return <AppProvider repo={repo} demo={null} initial={state}><App /></AppProvider>;
  }
  return (
    <div className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="font-serif text-3xl font-semibold">Table Zero Menu Lab</h1>
      {phase === 'checking' && <Spinner label="Checking session…" />}
      {msg && <Notice tone={msg.tone === 'info' ? 'info' : msg.tone}>{msg.text}</Notice>}

      {phase === 'signin' && (
        <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); guard(async () => {
          const { error } = await repo.client.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await afterAuth();
        }); }}>
          <Field label="Email">{(id) => <input id={id} type="email" autoComplete="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">{(id) => <input id={id} type="password" autoComplete="current-password" required minLength={8} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" busy={busy}>Sign in</Button>
            <Button disabled={busy || !email || password.length < 8} onClick={() => guard(async () => {
              const { data, error } = await repo.client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
              if (error) throw error;
              if (data.session) await afterAuth();
              else setMsg({ tone: 'ok', text: 'Check your email to confirm your account, then sign in.' });
            })}>Create account</Button>
            <Button variant="ghost" disabled={busy || !email} onClick={() => guard(async () => {
              const { error } = await repo.client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
              if (error) throw error;
              setMsg({ tone: 'ok', text: 'If that email has an account, a reset link is on its way.' });
            })}>Forgot password</Button>
          </div>
        </form>
      )}

      {phase === 'recovery' && (
        <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); guard(async () => {
          const { error } = await repo.client.auth.updateUser({ password });
          if (error) throw error;
          setMsg({ tone: 'ok', text: 'Password updated.' });
          await afterAuth();
        }); }}>
          <h2 className="text-lg font-semibold">Choose a new password</h2>
          <Field label="New password">{(id) => <input id={id} type="password" autoComplete="new-password" required minLength={8} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button variant="primary" type="submit" busy={busy}>Save password</Button>
        </form>
      )}

      {(phase === 'org' || phase === 'error') && (
        <div className="space-y-4">
          {orgs.length > 0 && (
            <div className="card space-y-2 p-4">
              <h2 className="text-lg font-semibold">Your organizations</h2>
              {orgs.map((o) => <Button key={o.org_id} className="w-full" onClick={() => choose(o.org_id)}>{o.organizations?.name ?? o.org_id} · {o.role}</Button>)}
            </div>
          )}
          <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); guard(async () => choose(await repo.acceptInvite(invite.code, invite.display))); }}>
            <h2 className="text-lg font-semibold">Join with an invite code</h2>
            <p className="text-sm text-ink-mute">Ask a manager for a code from Settings → Team.</p>
            <Field label="Invite code">{(id) => <input id={id} required className="input uppercase" autoComplete="off" value={invite.code} onChange={(e) => setInvite({ ...invite, code: e.target.value })} />}</Field>
            <Field label="Your name (shown to your team)">{(id) => <input id={id} className="input" value={invite.display} onChange={(e) => setInvite({ ...invite, display: e.target.value })} />}</Field>
            <Button variant="primary" type="submit" busy={busy} disabled={!invite.code.trim()}>Join</Button>
          </form>
          <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); guard(async () => choose(await repo.createOrganization(newOrg.name, newOrg.tz, newOrg.display || email))); }}>
            <h2 className="text-lg font-semibold">Create an organization</h2>
            <p className="text-sm text-ink-mute">You become its owner. The starter ingredient catalog and recipe library are included.</p>
            <Field label="Restaurant / bar name">{(id) => <input id={id} required className="input" value={newOrg.name} onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })} />}</Field>
            <Field label="Your name">{(id) => <input id={id} className="input" value={newOrg.display} onChange={(e) => setNewOrg({ ...newOrg, display: e.target.value })} />}</Field>
            <Field label="Timezone (IANA)" hint="Used for all date eligibility decisions.">{(id) => <input id={id} required className="input" value={newOrg.tz} onChange={(e) => setNewOrg({ ...newOrg, tz: e.target.value })} />}</Field>
            <Button type="submit" busy={busy} disabled={!newOrg.name.trim()}>Create</Button>
          </form>
          <Button variant="ghost" onClick={() => repo.client.auth.signOut()}>Sign out</Button>
        </div>
      )}

      {allowDemo() && phase !== 'ready' && (
        <div className="space-y-1 pt-2">
          <Button variant="ghost" onClick={onDemo}>Try the local demo instead</Button>
          <p className="text-xs text-ink-mute">Demo data stays in this browser and is isolated from live organizations.</p>
        </div>
      )}
    </div>
  );
}
