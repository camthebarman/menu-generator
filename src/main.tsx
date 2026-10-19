import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { isLocalDate } from './domain/dates';
import type { AppState } from './domain/types';
import { DemoRepository } from './data/demo';
import { liveConfigFromEnv, SupabaseRepository } from './data/live';
import { App } from './ui/App';
import { Notice, Spinner } from './ui/components';
import { allowDemo, LiveBoot } from './ui/LiveAuth';
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

function Root() {
  const cfg = liveConfigFromEnv();
  const params = new URLSearchParams(window.location.search);
  const forceDemo = allowDemo() && (params.has('demo') || params.has('demoReset'));
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
