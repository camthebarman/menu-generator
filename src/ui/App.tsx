import { Component, type ReactNode } from 'react';
import { canUseWorkspace } from '../domain/ops';
import { SupabaseRepository } from '../data/live';
import type { Workspace } from '../domain/types';
import { cx, Spinner } from './components';
import { Discover } from './Discover';
import { Inventory } from './Inventory';
import { Menu } from './Menu';
import { PlanDetail, Plans } from './Plans';
import { Recipes } from './Recipes';
import { Settings } from './Settings';
import { Shopping } from './Shopping';
import { useApp, useHashRoute } from './store';

const NAV = [
  { id: 'discover', label: 'Discover' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'menu', label: 'Current menu' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'plans', label: 'Plans' },
  { id: 'shopping', label: 'Shopping list' },
  { id: 'settings', label: 'Settings' },
];

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="card m-4 p-4">
          <h2 className="text-lg font-semibold">This screen hit an error</h2>
          <p className="text-sm text-ink-mute">{this.state.error.message}. Your data was not changed. </p>
          <button className="mt-2 underline" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const { state, workspace, setWorkspace, toasts, dismissToast, pending, cart, repo, reload } = useApp();
  const [route] = useHashRoute();
  const section = route[0];
  const user = state.currentUser;
  const wsButton = (w: Workspace) => {
    const allowed = canUseWorkspace(user, w);
    const on = workspace === w;
    return (
      <button key={w} role="tab" aria-selected={on} disabled={!allowed} onClick={() => setWorkspace(w)} title={allowed ? undefined : `Your role does not include the ${w} workspace`}
        className={cx('min-h-[2.75rem] rounded-lg px-5 text-base font-semibold transition disabled:opacity-40',
          on ? (w === 'food' ? 'bg-food text-white shadow' : 'bg-bar text-white shadow') : 'bg-white/10 text-white hover:bg-white/20')}>
        {w === 'food' ? 'Food' : 'Bar'}
      </button>
    );
  };
  return (
    <div className="min-h-screen">
      {state.mode === 'demo' && (
        <div className="no-print bg-warn-soft px-4 py-1.5 text-center text-xs text-warn" role="note">
          <strong>DEMO DATA</strong> — stored only in this browser; does not sync across devices. Not connected to a live organization.
        </div>
      )}
      <header className="no-print sticky top-0 z-30 bg-ink text-white shadow">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2">
          <a href="#/discover" className="mr-2 font-serif text-lg font-semibold tracking-tight">Table Zero <span className="font-sans text-xs font-normal opacity-70">Menu Lab</span></a>
          <div role="tablist" aria-label="Workspace" className="flex gap-1 rounded-xl bg-white/5 p-1">{(['food', 'bar'] as Workspace[]).map(wsButton)}</div>
          <div className="ml-auto flex items-center gap-3 text-xs">
            {pending > 0 && <Spinner label="Saving…" />}
            <span className="opacity-80">{user.name} · {user.role}</span>
            {repo instanceof SupabaseRepository && (
              <>
                <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => reload()}>Refresh</button>
                <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => repo.client.auth.signOut()}>Sign out</button>
              </>
            )}
          </div>
        </div>
        <nav aria-label="Sections" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 pb-2">
          {NAV.map((n) => (
            <a key={n.id} href={`#/${n.id}`} aria-current={section === n.id || (n.id === 'plans' && section === 'plan') ? 'page' : undefined}
              className={cx('whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium', section === n.id || (n.id === 'plans' && section === 'plan') ? 'bg-white text-ink' : 'text-white/85 hover:bg-white/10')}>
              {n.label}{n.id === 'shopping' && cart[workspace].length > 0 ? ` (${cart[workspace].length})` : ''}
            </a>
          ))}
        </nav>
      </header>
      <main className={cx('mx-auto max-w-7xl px-4 py-5', workspace === 'food' ? 'border-t-4 border-food' : 'border-t-4 border-bar')}>
        <div className="mb-4 flex items-baseline gap-2">
          <h1 className="text-2xl font-semibold">{NAV.find((n) => n.id === section)?.label ?? (section === 'plan' ? 'Plan' : 'Discover')}</h1>
          <span className={cx('text-sm font-medium', workspace === 'food' ? 'text-food' : 'text-bar')}>{workspace === 'food' ? 'Food workspace' : 'Bar workspace'} · {state.org.name}</span>
        </div>
        <Boundary key={section}>
          {section === 'inventory' ? <Inventory /> : section === 'menu' ? <Menu /> : section === 'recipes' ? <Recipes /> : section === 'plans' ? <Plans />
            : section === 'plan' && route[1] ? <PlanDetail id={route[1]} key={route[1]} /> : section === 'shopping' ? <Shopping /> : section === 'settings' ? <Settings /> : <Discover />}
        </Boundary>
      </main>
      <div className="no-print fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg', t.tone === 'error' ? 'border-block/40 bg-block-soft text-block' : t.tone === 'ok' ? 'border-ok/40 bg-ok-soft text-ok' : 'border-paper-line bg-white')}>
            <span className="flex-1">{t.text}</span>
            <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>✕</button>
          </div>
        ))}
      </div>
      <footer className="no-print mx-auto max-w-7xl px-4 pb-8 pt-4 text-xs text-ink-mute">
        Date alerts and eligibility rules follow your configured policy; they are planning aids, not safety guarantees or compliance determinations.
      </footer>
    </div>
  );
}
