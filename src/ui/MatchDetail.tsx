import { useMemo, useState } from 'react';
import { currentVersion } from '../domain/catalog';
import type { MatchRequest, MatchResult } from '../domain/match';
import { substitutionVariants } from '../domain/substitution';
import type { PlanTarget, RequestedYield } from '../domain/types';
import { formatBase, formatMoney, formatShortfall, UNITS } from '../domain/units';
import { Button, CostBadge, Field, GroupBadge, Notice, PoolBadge, ProvenanceBadge, cx } from './components';
import { useApp } from './store';

export function requestedLabel(r: RequestedYield): string {
  return r.kind === 'servings' ? `${r.servings} ${r.servings === 1 ? 'portion' : 'portions'}` : `${r.quantity} ${UNITS[r.unit].label}`;
}

export function capacityLabel(m: MatchResult): string {
  const c = m.capacity;
  if (c.maxServings !== null) return `Supports ${c.maxServings} ${c.maxServings === 1 ? 'portion' : 'portions'}${c.exact ? '' : '*'}`;
  if (c.maxQuantity !== null && c.unit) return `Supports ${Math.floor(c.maxQuantity)} ${UNITS[c.unit].label}${c.exact ? '' : '*'}`;
  if (c.multiplier !== null) return `Supports ${Math.round(c.multiplier * 100)}% of plan${c.exact ? '' : '*'}`;
  return 'Capacity unknown';
}

export function MatchSummaryNotices({ m }: { m: MatchResult }) {
  return (
    <div className="space-y-2">
      {m.protectionIncomplete && (
        <Notice tone="warn" title="Current menu protection incomplete">Some menu items have missing or unverified recipe mappings or no expected portions; protected quantities may be understated. Review the Current menu tab.</Notice>
      )}
      {!m.protectMenu && <Notice tone="warn" title="Menu protection relaxed">This check may use stock held for this workspace's current menu. The other workspace's protection on Shared stock still applies.</Notice>}
      {m.issues.length > 0 && (
        <Notice tone="review" title="Needs review before this can be planned">
          <ul className="ml-4 list-disc">{m.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
        </Notice>
      )}
      {m.menuConflicts.length > 0 && (
        <Notice tone="warn" title="Menu conflict">
          <ul className="ml-4 list-disc">
            {m.menuConflicts.map((c) => (
              <li key={c.ingredientId}>
                {c.name}: {c.own > 0 && <>{formatBase(c.own, c.dimension)} of the shortfall is held for this workspace's current menu. </>}
                {c.other > 0 && <>{formatBase(c.other, c.dimension)} is held by the other workspace's menu (not relaxable here).</>}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {m.assumptions.length > 0 && <Notice title="Assumptions (manager-confirmed staples)"><ul className="ml-4 list-disc">{m.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></Notice>}
      {m.omissions.length > 0 && <Notice title="Optional ingredients omitted"><ul className="ml-4 list-disc">{m.omissions.map((a) => <li key={a}>{a}</li>)}</ul></Notice>}
      {m.capacity.note && <Notice>{m.capacity.note}</Notice>}
    </div>
  );
}

export function RequirementsTable({ m }: { m: MatchResult }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr><th>Ingredient</th><th className="text-right">Needed</th><th>From stock (FEFO)</th><th className="text-right">Short</th></tr>
        </thead>
        <tbody>
          {m.requirements.map((r) => (
            <tr key={r.key} className={cx(r.status === 'review' && 'bg-review-soft/40', (r.status === 'short' || r.status === 'missing') && 'bg-warn-soft/40')}>
              <td>
                <div className="font-medium">{r.name}{r.form !== 'raw' && <span className="ml-1 text-xs text-ink-mute">({r.form})</span>}</div>
                {r.sources.some((s) => s.via.length > 0) && <div className="text-xs text-ink-mute">for {[...new Set(r.sources.flatMap((s) => s.via))].join(', ')}</div>}
                {r.status === 'review' && <div className="text-xs text-review">{r.reviewReasons.join('; ')}</div>}
              </td>
              <td className="text-right tabular-nums">{r.required > 0 ? formatBase(r.required, r.dimension) : '—'}</td>
              <td>
                <ul className="space-y-1">
                  {r.allocations.map((a) => (
                    <li key={a.lotId} className="flex flex-wrap items-center gap-1 text-xs">
                      <span className="tabular-nums font-medium">{formatBase(a.quantity, r.dimension)}</span>
                      <span className="text-ink-mute">from {a.lotRef}</span>
                      <PoolBadge pool={a.pool} />
                      {a.cutoff && <span className={cx('chip', a.atRisk ? 'border-risk/30 bg-risk-soft text-risk' : 'border-paper-line text-ink-mute')}>cutoff {a.cutoff}{a.daysToUrgency !== null ? ` · ${a.daysToUrgency}d` : ''}</span>}
                      {!a.cutoff && <span className="chip border-paper-line text-ink-mute">undated · by receipt age</span>}
                      {a.priority && <span className="chip border-ink bg-ink text-white">priority</span>}
                      {a.notes.filter((x) => !x.startsWith('No cutoff')).map((n) => <span key={n} className="text-ink-mute">· {n}</span>)}
                    </li>
                  ))}
                  {r.prepared > 0 && <li className="text-xs">Prepare {formatBase(r.prepared, r.dimension)} via <span className="font-medium">{r.producerName}</span> (inputs listed below)</li>}
                  {r.assumed > 0 && <li className="text-xs text-ink-mute">{formatBase(r.assumed, r.dimension)} assumed (confirmed staple)</li>}
                  {r.allocations.length === 0 && r.prepared === 0 && r.assumed === 0 && r.status !== 'review' && <li className="text-xs text-ink-mute">No free eligible stock</li>}
                </ul>
              </td>
              <td className="text-right tabular-nums">
                {r.shortfall > 0 ? <span className="font-semibold text-warn">{formatShortfall(r.shortfall, r.dimension)}{r.status === 'missing' ? ' (missing)' : ''}</span> : <span className="text-ink-mute">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.optional.filter((o) => o.used).length > 0 && (
        <p className="mt-2 text-xs text-ink-mute">Optional included: {m.optional.filter((o) => o.used).map((o) => o.name).join(', ')}</p>
      )}
      <p className="mt-1 text-xs text-ink-mute">Quantities shown in base units; shortfalls are rounded up.</p>
    </div>
  );
}

export function MatchDetail({ m, req, onPlanned }: { m: MatchResult; req: MatchRequest; onPlanned?: (planId: string) => void }) {
  const { state, catalog, run, workspace, cart, setCart, special, setSpecial, toast } = useApp();
  const target = m.targets[0];
  const recipe = catalog.recipes.get(target.recipeId);
  const version = recipe ? catalog.versions.get(target.versionId)?.version ?? currentVersion(recipe) : null;
  const subs = useMemo(() => (m.targets.length === 1 ? substitutionVariants(state, m, req) : []), [state, m, req]);
  const [planName, setPlanName] = useState(`${target.name} — ${m.plannedDate}`);
  const [busy, setBusy] = useState(false);
  const currency = state.org.currency;

  const createPlan = async () => {
    if (!recipe || !version) return;
    setBusy(true);
    const res = await run('createPlan', {
      workspace, name: planName, kind: recipe.produces ? 'component' : workspace === 'bar' ? 'drink' : 'special', serviceDate: m.plannedDate,
      targets: m.targets.map((t) => ({ recipeId: t.recipeId, recipeVersionId: t.versionId, requested: t.requested })),
      protectMenu: m.protectMenu, componentStrategy: req.strategy, priorityLotIds: req.priorityLotIds, source: recipe.provenance.kind === 'ai_draft' ? 'ai_draft' : 'manual',
    });
    setBusy(false);
    if (res) {
      toast('ok', 'Draft plan saved. No inventory has changed — reserve it from Plans when ready.');
      onPlanned?.(res.planId);
    }
  };
  const inCart = cart[workspace].some((c) => c.recipeId === target.recipeId);
  const inSpecial = special[workspace].some((c) => c.recipeId === target.recipeId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <GroupBadge group={m.group} />
        {m.provenance.map((p, i) => <ProvenanceBadge key={i} p={p} />)}
        <CostBadge cost={m.cost} currency={currency} />
        <span className="chip border-paper-line text-ink-soft">Requested {m.targets.map((t) => requestedLabel(t.requested)).join(' + ')}</span>
        <span className={cx('chip', m.group === 'make_now' ? 'border-ok/30 text-ok' : 'border-warn/30 text-warn')}>{capacityLabel(m)}</span>
        {m.alcohol.status === 'contains_alcohol' && <span className="chip border-bar/30 bg-bar-soft text-bar-ink" title={m.alcohol.sources.join(', ')}>Contains alcohol</span>}
        {m.alcohol.status === 'unknown' && <span className="chip border-review/30 bg-review-soft text-review">Alcohol status unknown</span>}
      </div>
      {recipe?.description && <p className="text-sm text-ink-soft">{recipe.description}</p>}
      <MatchSummaryNotices m={m} />

      {m.shortages.length > 0 && (
        <div className="card p-3">
          <h3 className="mb-1 text-base font-semibold">To buy ({m.distinctShortageCount} distinct ingredient{m.distinctShortageCount === 1 ? '' : 's'})</h3>
          <ul className="space-y-1 text-sm">
            {m.shortages.map((s) => (
              <li key={s.ingredientId} className="flex flex-wrap justify-between gap-2">
                <span>{s.name} <span className="text-xs text-ink-mute">{s.missingCompletely ? 'missing' : `have ${formatBase(s.have, s.dimension)} of ${formatBase(s.needed, s.dimension)}`}</span></span>
                <span className="font-semibold tabular-nums">+{formatShortfall(s.short, s.dimension)}{s.estCost !== null ? <span className="ml-2 text-xs font-normal text-ink-mute">est. {formatMoney(s.estCost, currency)}</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-base font-semibold">Exact requirements & lot allocations</h3>
        <RequirementsTable m={m} />
      </div>

      {m.prepSteps.length > 0 && (
        <div className="card p-3">
          <h3 className="text-base font-semibold">Components to prepare from raw</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {m.prepSteps.map((p) => {
              const ing = catalog.ingredients.get(p.key.split('|')[0]);
              return (
                <li key={p.key}>
                  <span className="font-medium">{p.recipeName}</span>: make {ing ? formatBase(p.outputQuantity, ing.dimension) : p.outputQuantity} ({Math.round(p.scale * 100) / 100}× recipe)
                  {p.totalMinutes !== null && <span className="text-ink-mute"> · {p.totalMinutes} min</span>}
                  {p.equipment.length > 0 && <span className="text-ink-mute"> · {p.equipment.join(', ')}</span>}
                  {!p.outputHoldVerified && <span className="text-review"> · output date not verified — set it when recording prep</span>}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs text-ink-mute">Viewing this does not change stock. Raw inputs are consumed once, only when the plan's preparation is recorded.</p>
        </div>
      )}

      {m.urgency.lots.length > 0 && (
        <div className="card p-3">
          <h3 className="text-base font-semibold">Older / at-risk stock used</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {m.urgency.lots.map((u) => (
              <li key={u.lotId}>
                Uses <span className="font-medium tabular-nums">{formatBase(u.used, u.dimension)}</span> of {formatBase(u.lotQuantity, u.dimension)} {u.ingredientName} ({Math.round(u.share * 100)}% of lot {u.lotRef}), {u.daysToUrgency <= 0 ? 'date is today' : `${u.daysToUrgency} day${u.daysToUrgency === 1 ? '' : 's'} to its date`}
                {!u.meaningful && <span className="text-ink-mute"> — small share; not evidence of waste reduction</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-mute">
            Stock value used: {formatMoney(m.urgency.valueUsed, currency)}{m.urgency.valueUnknownLots ? ` (+${m.urgency.valueUnknownLots} lot(s) with unknown cost)` : ''}. Potential waste avoided only if this stock would otherwise go unused before its date; not realized savings.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card p-3 text-sm">
          <h3 className="text-base font-semibold">Cost</h3>
          <p>Ingredient cost: {m.cost.status === 'unknown' ? 'unknown' : formatMoney(m.cost.knownCost, currency)}{m.cost.status === 'partial' ? ' (partial)' : ''}</p>
          {m.cost.portionCost !== null && <p>Per portion: {formatMoney(m.cost.portionCost, currency)}</p>}
          {m.cost.targetPrice !== null && <p>Price at target ingredient-cost %: {formatMoney(m.cost.targetPrice, currency)}</p>}
          {m.cost.unknownLines.length > 0 && <p className="text-xs text-ink-mute">No cost for: {m.cost.unknownLines.join(', ')}</p>}
          {m.cost.notes.map((n) => <p key={n} className="text-xs text-ink-mute">{n}</p>)}
        </div>
        <div className="card p-3 text-sm">
          <h3 className="text-base font-semibold">Allergens & diet</h3>
          <p>{m.allergens.contains.length ? `Contains: ${m.allergens.contains.join(', ').replace(/_/g, ' ')}` : m.allergens.status === 'incomplete' ? 'No tracked allergens found in known data' : 'None of the tracked allergens'}</p>
          {m.allergens.unknownIngredients.length > 0 && <p className="text-review">Allergen data unknown for: {m.allergens.unknownIngredients.join(', ')} — cannot be labeled allergen-free.</p>}
          {m.allergens.status === 'unverified' && <p className="text-xs text-ink-mute">Allergen data not fully verified.</p>}
          <p className="text-xs text-ink-mute">Vegetarian: {m.diet.vegetarian === null ? 'unknown' : m.diet.vegetarian ? 'yes' : 'no'} · Vegan: {m.diet.vegan === null ? 'unknown' : m.diet.vegan ? 'yes' : 'no'}</p>
          <p className="text-xs text-ink-mute">Filters are not cross-contact certification.</p>
          {m.alcohol.status === 'contains_alcohol' && <p className="text-xs">Alcohol from: {m.alcohol.sources.join(', ')}</p>}
        </div>
      </div>

      {subs.length > 0 && (
        <div className="card p-3">
          <h3 className="text-base font-semibold">Substitution options (separate, revalidated)</h3>
          <ul className="mt-1 space-y-2 text-sm">
            {subs.map((v, i) => (
              <li key={i} className="rounded-lg border border-paper-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <GroupBadge group={v.result.group} />
                  {v.changes.map((c) => <span key={c.lineId}>{c.from} ({c.fromQty}) → <span className="font-medium">{c.to}</span> ({c.toQty})</span>)}
                </div>
                <p className="text-xs text-ink-mute">{v.changes.map((c) => c.note).join('; ')}</p>
                {(v.allergenChanges.added.length > 0 || v.allergenChanges.removed.length > 0) && <p className="text-xs text-review">Allergens: {v.allergenChanges.added.length ? `adds ${v.allergenChanges.added.join(', ')}` : ''} {v.allergenChanges.removed.length ? `removes ${v.allergenChanges.removed.join(', ')}` : ''}</p>}
                {v.alcoholChange && <p className="text-xs text-review">Alcohol status: {v.alcoholChange}</p>}
                {v.result.shortages.length > 0 && <p className="text-xs text-warn">Still short: {v.result.shortages.map((s) => s.name).join(', ')}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {version && (
        <div className="card p-3 text-sm">
          <h3 className="text-base font-semibold">Method</h3>
          <p className="text-xs text-ink-mute">
            {version.totalMinutes !== null ? `${version.activeMinutes ?? '?'} min active · ${version.totalMinutes} min total` : 'Time not recorded'}
            {version.equipment.length > 0 && ` · Equipment: ${version.equipment.join(', ')}`} · v{version.version}
          </p>
          <ol className="ml-5 mt-1 list-decimal space-y-1">{version.method.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}

      <div className="no-print space-y-3 rounded-xl border border-paper-line bg-white p-3">
        <Field label="Plan name">{(id) => <input id={id} className="input" value={planName} onChange={(e) => setPlanName(e.target.value)} />}</Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={createPlan} busy={busy}>Save draft plan</Button>
          {(m.group === 'need_1' || m.group === 'need_2' || m.group === 'not_close') && m.targets.length === 1 && (
            <Button disabled={inCart} onClick={() => setCart(workspace, [...cart[workspace], { recipeId: target.recipeId, recipeVersionId: target.versionId, requested: target.requested }])}>
              {inCart ? 'On shopping list' : 'Add to shopping list'}
            </Button>
          )}
          {m.targets.length === 1 && (
            <Button disabled={inSpecial} onClick={() => setSpecial(workspace, [...special[workspace], { recipeId: target.recipeId, recipeVersionId: target.versionId, requested: target.requested } as PlanTarget])}>
              {inSpecial ? 'In special builder' : 'Add to special builder'}
            </Button>
          )}
        </div>
        <p className="text-xs text-ink-mute">Saving a draft never changes inventory. Reserving happens from Plans and is re-validated against current stock.</p>
      </div>
    </div>
  );
}
