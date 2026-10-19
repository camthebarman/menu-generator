import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildCatalog, type Catalog } from '../domain/catalog';
import { todayIn } from '../domain/dates';
import { OpError } from '../domain/ops';
import type { AppState, PlanTarget, ShoppingSelection, Workspace } from '../domain/types';
import type { DemoRepository } from '../data/demo';
import type { Command, CommandArgs, CommandResult, Repository } from '../data/repository';

export interface Toast {
  id: number;
  tone: 'ok' | 'error' | 'info';
  text: string;
}

interface Ctx {
  state: AppState;
  repo: Repository;
  demo: DemoRepository | null;
  catalog: Catalog;
  workspace: Workspace;
  setWorkspace: (w: Workspace) => void;
  today: string;
  /** Runs a command; resolves to the result only after the repository confirms. */
  run: <K extends Command>(cmd: K, ...args: CommandArgs<K>) => Promise<CommandResult<K> | undefined>;
  replaceState: (s: AppState) => void;
  reload: () => Promise<void>;
  toasts: Toast[];
  toast: (tone: Toast['tone'], text: string) => void;
  dismissToast: (id: number) => void;
  pending: number;
  cart: Record<Workspace, ShoppingSelection[]>;
  setCart: (ws: Workspace, sel: ShoppingSelection[]) => void;
  special: Record<Workspace, PlanTarget[]>;
  setSpecial: (ws: Workspace, t: PlanTarget[]) => void;
}

const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

let toastId = 0;
const WS_KEY = 'tzml.workspace';

export function AppProvider({ repo, demo, initial, children }: { repo: Repository; demo: DemoRepository | null; initial: AppState; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState(0);
  const [workspace, setWs] = useState<Workspace>(() => {
    try {
      const w = localStorage.getItem(WS_KEY);
      if (w === 'food' || w === 'bar') return w;
    } catch {
      /* per-viewer convenience only */
    }
    return initial.currentUser.workspaces[0] ?? 'food';
  });
  const setWorkspace = useCallback((w: Workspace) => {
    setWs(w);
    try {
      localStorage.setItem(WS_KEY, w);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (state.currentUser.role === 'staff' && !state.currentUser.workspaces.includes(workspace)) setWs(state.currentUser.workspaces[0] ?? 'food');
  }, [state.currentUser, workspace]);

  const toast = useCallback((tone: Toast['tone'], text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 4500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const run = useCallback(async <K extends Command>(cmd: K, ...args: CommandArgs<K>) => {
    setPending((p) => p + 1);
    try {
      const out = await repo.run(cmd, ...args);
      setState(out.state);
      if (out.replayed) toast('info', 'Already recorded — retry had no additional effect.');
      return out.result;
    } catch (e) {
      const msg = e instanceof OpError ? e.message : e instanceof Error ? `Something went wrong: ${e.message}` : 'Something went wrong';
      toast('error', msg);
      return undefined;
    } finally {
      setPending((p) => p - 1);
    }
  }, [repo, toast]);

  const reload = useCallback(async () => {
    setState(await repo.load());
  }, [repo]);

  const [cart, setCartState] = useState<Record<Workspace, ShoppingSelection[]>>({ food: [], bar: [] });
  const setCart = useCallback((ws: Workspace, sel: ShoppingSelection[]) => setCartState((c) => ({ ...c, [ws]: sel })), []);
  const [special, setSpecialState] = useState<Record<Workspace, PlanTarget[]>>({ food: [], bar: [] });
  const setSpecial = useCallback((ws: Workspace, t: PlanTarget[]) => setSpecialState((c) => ({ ...c, [ws]: t })), []);
  const catalog = useMemo(() => buildCatalog(state), [state]);
  const today = state.clock.override ?? todayIn(repo.clock, state.org.timezone);

  const value: Ctx = { state, repo, demo, catalog, workspace, setWorkspace, today, run, replaceState: setState, reload, toasts, toast, dismissToast, pending, cart, setCart, special, setSpecial };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useHashRoute(): [string[], (path: string) => void] {
  const parse = () => (window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'discover').split('/').map(decodeURIComponent);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav = useCallback((p: string) => {
    window.location.hash = `#/${p}`;
  }, []);
  return [route, nav];
}

export function ingName(catalog: Catalog, id: string) {
  return catalog.ingredients.get(id)?.name ?? id;
}
