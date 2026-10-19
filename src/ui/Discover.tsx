import { useDeferredValue, useMemo, useState } from 'react';
import { currentVersion } from '../domain/catalog';
import { addDays } from '../domain/dates';
import { discover, match, requestedFor, GROUP_LABEL, type DiscoverMode, type DiscoverOptions, type MatchGroup, type MatchRequest, type MatchResult } from '../domain/match';
import { balances } from '../domain/stock';
import { ALLERGENS, BAR_CATEGORIES, FOOD_CATEGORIES, type Allergen, type ComponentStrategy, type RecipeCategory } from '../domain/types';
import { formatBase, formatShortfall } from '../domain/units';
import { Button, CostBadge, Drawer, Empty, Field, GroupBadge, Notice, ProvenanceBadge, Toggle, cx } from './components';
import { capacityLabel, MatchDetail, MatchSummaryNotices, RequirementsTable, requestedLabel } from './MatchDetail';
import { useApp, useHashRoute } from './store';

export const CATEGORY_LABEL: Record<RecipeCategory, string> = {
  main: 'Proteins & mains', side: 'Sides, veg & starches', sauce: 'Sauces & condiments', dessert: 'Desserts', special: 'Plated specials',
  cocktail: 'Cocktails', zero_proof: 'Zero-proof', syrup: 'Syrups, cordials & shrubs', garnish: 'Garnishes & prep', batched: 'Batched drinks',
};

const MODES: { id: DiscoverMode; label: string; hint: string }[] = [
  { id: 'make_now', label: 'Make something now', hint: 'What can we make with free, eligible stock?' },
  { id: 'use_older', label: 'Use older inventory', hint: 'Rank by meaningful use of stock near its date' },
  { id: 'special', label: 'Create a special', hint: 'Combine dishes/components into one plan' },
  { id: 'component', label: 'Make one component', hint: 'Sauces, syrups, juices, prep items' },
];

const GROUPS: MatchGroup[] = ['make_now', 'need_1', 'need_2', 'needs_review'];

function defaultOptions(workspace: 'food' | 'bar', today: string): DiscoverOptions {
  return {
    workspace, plannedDate: today, mode: 'make_now', servings: workspace === 'bar' ? 2 : 4, batches: 1, selectedIngredientIds: [], priorityLotIds: [],
    categories: [], cuisine: null, vegetarian: false, vegan: false, excludeAllergens: [], excludeEquipment: [], maxMinutes: null, protectMenu: true,
    strategy: 'prefer_stock', query: '',
  };
}

export function Discover() {
  const { state, workspace, today, catalog } = useApp();
  const [optsBy, setOptsBy] = useState<Record<string, DiscoverOptions>>({});
  const opts = optsBy[workspace] ?? defaultOptions(workspace, today);
  const setOpts = (p: Partial<DiscoverOptions>) => setOptsBy((o) => ({ ...o, [workspace]: { ...opts, ...p } }));
  const deferredOpts = useDeferredValue(opts);
  const deferredState = useDeferredValue(state);
  const stale = deferredOpts !== opts || deferredState !== state;
  const result = useMemo(() => discover(deferredState, deferredOpts, catalog), [deferredState, deferredOpts, catalog]);
  const relaxed = useMemo(
    () => (deferredOpts.protectMenu ? discover(deferredState, { ...deferredOpts, protectMenu: false }, catalog) : null),
    [deferredState, deferredOpts, catalog],
  );
  const [selected, setSelected] = useState<MatchResult | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [catFilter, setCatFilter] = useState<RecipeCategory | null>(null);
  const [showFar, setShowFar] = useState(false);
  const [, nav] = useHashRoute();

  const cats = workspace === 'food' ? FOOD_CATEGORIES : BAR_CATEGORIES;
  const ingredientOptions = useMemo(() => {
    const bs = balances(result.view);
    return bs
      .filter((b) => b.physical > 0 || b.reviewLots > 0)
      .map((b) => ({ ...b, name: catalog.ingredients.get(b.ingredientId)?.name ?? b.ingredientId, dim: catalog.ingredients.get(b.ingredientId)?.dimension ?? 'count' }))
      .sort((a, b) => (b.atRiskLots - a.atRiskLots) || a.name.localeCompare(b.name));
  }, [result.view, catalog]);
  const [ingQuery, setIngQuery] = useState('');

  const relaxedGain = relaxed ? relaxed.groups.make_now.length - result.groups.make_now.length : 0;
  const reqFor = (m: MatchResult): MatchRequest => ({
    workspace, plannedDate: opts.plannedDate, protectMenu: opts.protectMenu, strategy: opts.strategy, priorityLotIds: opts.priorityLotIds, priorityIngredientIds: opts.selectedIngredientIds,
    targets: m.targets.map((t) => ({ recipeId: t.recipeId, versionId: t.versionId, requested: t.requested, prepareOutput: opts.mode === 'component' })),
  });
  const totalShown = GROUPS.reduce((s, g) => s + result.groups[g].length, 0);
  const selectedSet = new Set(opts.selectedIngredientIds);

  return (
    <div className="space-y-5">
      <div className="card p-4">
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-3">
            <div role="radiogroup" aria-label="Mode" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={opts.mode === m.id} onClick={() => setOpts({ mode: m.id })}
                  className={cx('rounded-lg border px-3 py-2 text-left text-sm transition', opts.mode === m.id ? (workspace === 'food' ? 'border-food bg-food-soft' : 'border-bar bg-bar-soft') : 'border-paper-line bg-white hover:border-ink-mute')}>
                  <div className="font-semibold">{m.label}</div>
                  <div className="text-xs text-ink-mute">{m.hint}</div>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {opts.mode === 'component' ? (
                <Field label="Batches">{(id) => <input id={id} type="number" min={0.25} step={0.25} className="input" value={opts.batches} onChange={(e) => setOpts({ batches: Math.max(0.25, Number(e.target.value) || 1) })} />}</Field>
              ) : (
                <Field label={workspace === 'bar' ? 'Drinks' : 'Portions'}>{(id) => <input id={id} type="number" min={1} step={1} className="input" value={opts.servings} onChange={(e) => setOpts({ servings: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />}</Field>
              )}
              <Field label="Service date">{(id) => <input id={id} type="date" min={today} className="input" value={opts.plannedDate} onChange={(e) => e.target.value && setOpts({ plannedDate: e.target.value })} />}</Field>
              <Field label="Search" className="col-span-2">{(id) => <input id={id} className="input" placeholder="Recipe or tag" value={opts.query} onChange={(e) => setOpts({ query: e.target.value })} />}</Field>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-mute">
              <span>Quick dates:</span>
              {[0, 1, 2].map((n) => (
                <button key={n} className={cx('chip', opts.plannedDate === addDays(today, n) ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')} onClick={() => setOpts({ plannedDate: addDays(today, n) })}>
                  {n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : addDays(today, n)}
                </button>
              ))}
              <span className="ml-auto">Timezone: {state.org.timezone}</span>
            </div>
          </div>
          <div className="space-y-3">
            <Toggle checked={opts.protectMenu} onChange={(v) => setOpts({ protectMenu: v })} label="Protect current menu stock"
              description={opts.protectMenu
                ? relaxedGain > 0 ? `Relaxing would make ${relaxedGain} more recipe${relaxedGain === 1 ? '' : 's'} "Make now" by using menu stock.` : 'Relaxing would not change what you can make right now.'
                : 'Off: results may use stock held for your current menu.'} />
            {result.view.protection.incomplete && (
              <button className="w-full text-left" onClick={() => nav('menu')}>
                <Notice tone="warn" title="Current menu protection incomplete">{result.view.protection.reasons.slice(0, 2).join(' · ')}{result.view.protection.reasons.length > 2 ? ` · +${result.view.protection.reasons.length - 2} more` : ''}</Notice>
              </button>
            )}
            <div>
              <div className="label">Ingredients to use</div>
              <input className="input" placeholder="Find an ingredient (e.g. chicken)" value={ingQuery} onChange={(e) => setIngQuery(e.target.value)} aria-label="Find an ingredient to use" />
              <div className="mt-2 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {ingredientOptions
                  .filter((o) => !ingQuery || o.name.toLowerCase().includes(ingQuery.toLowerCase()) || selectedSet.has(o.ingredientId))
                  .slice(0, ingQuery ? 30 : 14)
                  .map((o) => {
                    const on = opts.selectedIngredientIds.includes(o.ingredientId);
                    return (
                      <button key={o.key} aria-pressed={on} onClick={() => setOpts({ selectedIngredientIds: on ? opts.selectedIngredientIds.filter((x) => x !== o.ingredientId) : [...opts.selectedIngredientIds, o.ingredientId] })}
                        className={cx('chip', on ? 'border-ink bg-ink text-white' : o.atRiskLots > 0 ? 'border-risk/40 bg-risk-soft text-risk' : 'border-paper-line bg-white')}>
                        {o.name}{o.form !== 'raw' ? ` (${o.form})` : ''} · {formatBase(o.freeForSpecials, o.dim)} free{o.atRiskLots > 0 ? ' · near date' : ''}
                      </button>
                    );
                  })}
              </div>
              {opts.selectedIngredientIds.length > 0 && (
                <div className="mt-2 space-y-1">
                  {opts.selectedIngredientIds.map((id) => {
                    const lots = result.view.slots.filter((s) => s.lot.ingredientId === id && result.view.allowedPools.includes(s.lot.pool) && s.elig.state === 'eligible');
                    return lots.length > 1 ? (
                      <div key={id} className="flex flex-wrap items-center gap-1 text-xs">
                        <span className="text-ink-mute">Prioritize lot of {catalog.ingredients.get(id)?.name}:</span>
                        {lots.map((s) => {
                          const on = opts.priorityLotIds.includes(s.lot.id);
                          return (
                            <button key={s.lot.id} aria-pressed={on} className={cx('chip', on ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')}
                              onClick={() => setOpts({ priorityLotIds: on ? opts.priorityLotIds.filter((x) => x !== s.lot.id) : [...opts.priorityLotIds, s.lot.id] })}>
                              {s.lot.lotRef ?? s.lot.id.slice(-5)}{s.elig.cutoff ? ` · ${s.elig.cutoff}` : ''}
                            </button>
                          );
                        })}
                      </div>
                    ) : null;
                  })}
                </div>
              )}
            </div>
            <Button size="sm" variant="ghost" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>{showFilters ? 'Hide filters' : 'More filters'}</Button>
          </div>
        </div>
        {showFilters && (
          <div className="mt-4 grid gap-4 border-t border-paper-line pt-4 md:grid-cols-3">
            <div>
              <div className="label">Categories</div>
              <div className="flex flex-wrap gap-1">
                {cats.map((c) => {
                  const on = opts.categories.includes(c);
                  return <button key={c} aria-pressed={on} className={cx('chip', on ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')} onClick={() => setOpts({ categories: on ? opts.categories.filter((x) => x !== c) : [...opts.categories, c] })}>{CATEGORY_LABEL[c]}</button>;
                })}
              </div>
              <Field label="Cuisine / style" className="mt-3">{(id) => (
                <select id={id} className="input" value={opts.cuisine ?? ''} onChange={(e) => setOpts({ cuisine: e.target.value || null })}>
                  <option value="">Any</option>
                  {[...new Set([...catalog.recipes.values()].filter((r) => r.workspaces.includes(workspace)).flatMap((r) => [r.cuisine, ...r.tags]).filter((x): x is string => !!x))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}</Field>
            </div>
            <div>
              <div className="label">Dietary</div>
              <div className="space-y-2">
                <Toggle checked={opts.vegetarian} onChange={(v) => setOpts({ vegetarian: v })} label="Vegetarian (verified data only)" />
                <Toggle checked={opts.vegan} onChange={(v) => setOpts({ vegan: v })} label="Vegan (verified data only)" />
              </div>
              <div className="label mt-3">Exclude allergens</div>
              <div className="flex flex-wrap gap-1">
                {ALLERGENS.map((a) => {
                  const on = opts.excludeAllergens.includes(a);
                  return <button key={a} aria-pressed={on} className={cx('chip', on ? 'border-block bg-block text-white' : 'border-paper-line bg-white')} onClick={() => setOpts({ excludeAllergens: on ? opts.excludeAllergens.filter((x) => x !== a) : [...opts.excludeAllergens, a as Allergen] })}>{a.replace('_', ' ')}</button>;
                })}
              </div>
              <p className="mt-1 text-xs text-ink-mute">Recipes with unknown allergen data are hidden when excluding allergens. Not cross-contact certification.</p>
            </div>
            <div className="space-y-3">
              <Field label="Max total time (minutes)">{(id) => <input id={id} type="number" min={1} className="input" value={opts.maxMinutes ?? ''} placeholder="Any" onChange={(e) => setOpts({ maxMinutes: e.target.value ? Number(e.target.value) : null })} />}</Field>
              <div>
                <div className="label">Exclude equipment</div>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                  {state.equipment.map((e) => {
                    const on = opts.excludeEquipment.includes(e);
                    return <button key={e} aria-pressed={on} className={cx('chip', on ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')} onClick={() => setOpts({ excludeEquipment: on ? opts.excludeEquipment.filter((x) => x !== e) : [...opts.excludeEquipment, e] })}>{e}</button>;
                  })}
                </div>
              </div>
              <Field label="Prepared components">{(id) => (
                <select id={id} className="input" value={opts.strategy} onChange={(e) => setOpts({ strategy: e.target.value as ComponentStrategy })}>
                  <option value="prefer_stock">Use prepared stock first, prepare the rest</option>
                  <option value="stock_only">Use existing prepared stock only</option>
                </select>
              )}</Field>
            </div>
          </div>
        )}
      </div>

      {opts.mode === 'special' && <SpecialBuilder plannedDate={opts.plannedDate} protectMenu={opts.protectMenu} />}

      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-sm text-ink-mute">{stale ? 'Updating…' : `${totalShown} of ${result.considered} recipes`} · {opts.mode === 'component' ? `${opts.batches} batch${opts.batches === 1 ? '' : 'es'}` : requestedLabel({ kind: 'servings', servings: opts.servings })} (components: 1 batch) · {opts.plannedDate}</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <button className={cx('chip', catFilter === null ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')} onClick={() => setCatFilter(null)}>All</button>
          {cats.map((c) => {
            const n = GROUPS.reduce((s, g) => s + result.groups[g].filter((r) => catalog.recipes.get(r.targets[0].recipeId)?.category === c).length, 0);
            return n ? <button key={c} className={cx('chip', catFilter === c ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')} onClick={() => setCatFilter(catFilter === c ? null : c)}>{CATEGORY_LABEL[c]} · {n}</button> : null;
          })}
        </div>
      </div>

      <nav aria-label="Result groups" className="flex flex-wrap gap-2">
        {GROUPS.map((g) => <a key={g} href={`#group-${g}`} onClick={(e) => { e.preventDefault(); document.getElementById(`group-${g}`)?.scrollIntoView({ behavior: 'smooth' }); }} className="no-underline"><GroupBadge group={g} /> <span className="text-sm text-ink-mute">{result.groups[g].length}</span></a>)}
      </nav>
      <div className={cx('space-y-6', stale && 'opacity-70')}>
        {GROUPS.map((g) => {
          const items = result.groups[g].filter((r) => !catFilter || catalog.recipes.get(r.targets[0].recipeId)?.category === catFilter);
          return (
            <section key={g} id={`group-${g}`} aria-label={GROUP_LABEL[g]} className="scroll-mt-28 space-y-2">
              <h2 className="flex items-center gap-2 font-sans text-sm font-semibold uppercase tracking-wide">
                <GroupBadge group={g} /> <span className="text-ink-mute">{items.length}</span>
                <span className="font-normal normal-case tracking-normal text-ink-mute">{g === 'make_now' ? '— every required check passes for the requested yield' : g === 'needs_review' ? '— unresolved quantity, conversion, mapping, or date eligibility' : '— exact additional amounts shown'}</span>
              </h2>
              {items.length === 0 && <Empty title={g === 'make_now' ? 'Nothing ready yet' : 'None'}>{g === 'make_now' ? 'Try fewer portions, a later date, or check menu protection.' : null}</Empty>}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((r) => <ResultCard key={r.id} m={r} onOpen={() => setSelected(r)} />)}
              </div>
            </section>
          );
        })}
      </div>
      <p className="text-xs text-ink-mute">* Capacity relies on manager-confirmed untracked staples (e.g. salt, water, ice), so it is not an exact stock count.</p>
      {result.groups.not_close.length > 0 && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowFar((v) => !v)} aria-expanded={showFar}>{showFar ? 'Hide' : 'Show'} {result.groups.not_close.length} recipes needing 3+ ingredients</Button>
          {showFar && <div className="mt-2 grid gap-2 md:grid-cols-3">{result.groups.not_close.map((r) => <ResultCard key={r.id} m={r} onOpen={() => setSelected(r)} />)}</div>}
        </div>
      )}
      {result.hidden.length > 0 && (
        <p className="text-xs text-ink-mute">Hidden by filters: {result.hidden.map((h) => `${h.reason} (${h.count})`).join(' · ')}</p>
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.targets[0].name ?? ''} wide>
        {selected && <MatchDetail m={selected} req={reqFor(selected)} onPlanned={(id) => { setSelected(null); nav(`plan/${id}`); }} />}
      </Drawer>
    </div>
  );
}

function ResultCard({ m, onOpen }: { m: MatchResult; onOpen: () => void }) {
  const { catalog, state } = useApp();
  const recipe = catalog.recipes.get(m.targets[0].recipeId)!;
  const v = currentVersion(recipe);
  return (
    <button onClick={onOpen} className="card block w-full p-3 text-left transition hover:border-ink-mute focus-visible:ring-2" data-testid="result-card">
      <div className="flex flex-wrap items-start justify-between gap-1">
        <div className="min-w-0 font-serif text-base font-semibold leading-tight">{recipe.name}</div>
        <ProvenanceBadge p={recipe.provenance} />
      </div>
      <div className="mt-1 text-xs text-ink-mute">{CATEGORY_LABEL[recipe.category]}{v.totalMinutes !== null ? ` · ${v.totalMinutes} min` : ''}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        <span className={cx('chip', m.group === 'make_now' ? 'border-ok/30 text-ok' : 'border-paper-line text-ink-soft')}>{capacityLabel(m)} · asked {requestedLabel(m.targets[0].requested)}</span>
        <CostBadge cost={m.cost} currency={state.org.currency} />
        {m.alcohol.status === 'contains_alcohol' && recipe.category === 'zero_proof' && <span className="chip border-review/30 bg-review-soft text-review">contains alcohol</span>}
      </div>
      {m.priorityUse.length > 0 && <div className="mt-2 text-xs">Uses {m.priorityUse.map((p) => `${formatBase(p.quantity, p.dimension)} ${p.name}`).join(', ')}</div>}
      {m.urgency.lots.filter((u) => u.meaningful).slice(0, 2).map((u) => (
        <div key={u.lotId} className="mt-1 text-xs text-risk">Uses {Math.round(u.share * 100)}% of {u.ingredientName} lot ({u.daysToUrgency <= 0 ? 'date today' : `${u.daysToUrgency}d left`})</div>
      ))}
      {m.shortages.length > 0 && (
        <div className="mt-2 text-xs text-warn">Need: {m.shortages.map((s) => `${s.name} ${s.missingCompletely ? '' : '+'}${formatShortfall(s.short, s.dimension)}`).join(', ')}</div>
      )}
      {m.group === 'needs_review' && <div className="mt-2 line-clamp-2 text-xs text-review">{m.issues[0]?.message}</div>}
      {m.menuConflicts.length > 0 && <div className="mt-1 text-xs text-ink-mute">Menu conflict: {m.menuConflicts.map((c) => c.name).join(', ')}</div>}
      {m.prepSteps.length > 0 && <div className="mt-1 text-xs text-ink-mute">Prep first: {m.prepSteps.map((p) => p.recipeName).join(', ')}</div>}
    </button>
  );
}

function SpecialBuilder({ plannedDate, protectMenu }: { plannedDate: string; protectMenu: boolean }) {
  const { state, workspace, special, setSpecial, run, toast } = useApp();
  const [, nav] = useHashRoute();
  const targets = special[workspace];
  const [name, setName] = useState('Tonight\'s special');
  const combined = useMemo(() => (targets.length ? match(state, { workspace, plannedDate, protectMenu, targets: targets.map((t) => ({ recipeId: t.recipeId, versionId: t.recipeVersionId, requested: t.requested })) }) : null), [state, workspace, plannedDate, protectMenu, targets]);
  const recipes = state.recipes.filter((r) => r.workspaces.includes(workspace) && !r.archived && !(r.provenance.kind === 'ai_draft' && !currentVersion(r).confirmed));
  const [pick, setPick] = useState('');
  const add = () => {
    const r = state.recipes.find((x) => x.id === pick);
    if (!r) return;
    const v = currentVersion(r);
    setSpecial(workspace, [...targets, { recipeId: r.id, recipeVersionId: v.id, requested: requestedFor(r, v, { servings: workspace === 'bar' ? 2 : 4, batches: 1, mode: 'make_now' }) }]);
    setPick('');
  };
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <h2 className="mr-auto text-lg font-semibold">Special builder</h2>
        <select className="input max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a dish or component">
          <option value="">Add a dish, side, sauce, dessert, or component…</option>
          {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <Button size="sm" onClick={add} disabled={!pick}>Add</Button>
      </div>
      {targets.length === 0 ? (
        <p className="text-sm text-ink-mute">Add components here (or from a result's detail). Combined components share one demand calculation, so they can't each count the same stock.</p>
      ) : (
        <>
          <ul className="space-y-1">
            {targets.map((t, i) => {
              const r = state.recipes.find((x) => x.id === t.recipeId);
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{r?.name}</span>
                  {t.requested.kind === 'servings' ? (
                    <input type="number" min={1} aria-label={`Portions of ${r?.name}`} className="input w-24" value={t.requested.servings} onChange={(e) => setSpecial(workspace, targets.map((x, k) => (k === i ? { ...x, requested: { kind: 'servings', servings: Math.max(1, Number(e.target.value) || 1) } } : x)))} />
                  ) : (
                    <span className="text-ink-mute">{requestedLabel(t.requested)}</span>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setSpecial(workspace, targets.filter((_, k) => k !== i))} aria-label={`Remove ${r?.name}`}>Remove</Button>
                </li>
              );
            })}
          </ul>
          {combined && (
            <div className="space-y-3 border-t border-paper-line pt-3">
              <div className="flex flex-wrap items-center gap-2"><GroupBadge group={combined.group} /><span className="text-sm">{capacityLabel(combined)}</span><CostBadge cost={combined.cost} currency={state.org.currency} /></div>
              <MatchSummaryNotices m={combined} />
              <details>
                <summary className="cursor-pointer text-sm font-medium">Combined requirements & allocations</summary>
                <RequirementsTable m={combined} />
              </details>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Special name" className="min-w-[14rem] flex-1">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                <Button variant="primary" onClick={async () => {
                  const res = await run('createPlan', { workspace, name, kind: 'special', serviceDate: plannedDate, targets, protectMenu });
                  if (res) {
                    toast('ok', 'Special saved as a draft plan. Inventory unchanged.');
                    setSpecial(workspace, []);
                    nav(`plan/${res.planId}`);
                  }
                }}>Save special as draft plan</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
