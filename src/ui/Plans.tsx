import { useMemo, useState } from 'react';
import { evaluatePlan, planStatusInfo } from '../domain/ops';
import type { CompletionInput } from '../domain/ops';
import type { Plan, Pool, StorageState, UnitCode } from '../domain/types';
import { formatBase, UNITS } from '../domain/units';
import { idemKey } from '../data/repository';
import { Button, Empty, Field, GroupBadge, Notice, PoolBadge, Section, cx } from './components';
import { MatchSummaryNotices, RequirementsTable, requestedLabel } from './MatchDetail';
import { useApp, useHashRoute } from './store';

const STATUS_STYLE: Record<Plan['status'], string> = {
  draft: 'border-paper-line bg-white text-ink-soft',
  reserved: 'border-bar/30 bg-bar-soft text-bar-ink',
  completed: 'border-ok/30 bg-ok-soft text-ok',
  cancelled: 'border-paper-line bg-paper-shade text-ink-mute',
};

export function Plans() {
  const { state, workspace, repo } = useApp();
  const [, nav] = useHashRoute();
  const plans = state.plans.filter((p) => p.workspace === workspace).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Section title="Plans" description="Drafts never change inventory. Reserving re-checks current stock and holds actual lots; recording prep consumes them once.">
      {plans.length === 0 ? <Empty title="No plans yet">Create one from Discover, a recipe, or the special builder.</Empty> : (
        <div className="grid gap-2 md:grid-cols-2">
          {plans.map((p) => {
            const info = planStatusInfo(state, p, repo.clock);
            return (
              <button key={p.id} className="card p-3 text-left hover:border-ink-mute" onClick={() => nav(`plan/${p.id}`)}>
                <div className="flex items-start justify-between gap-2"><span className="font-serif font-semibold">{p.name}</span><span className={cx('chip', STATUS_STYLE[p.status])}>{p.status}</span></div>
                <div className="text-xs text-ink-mute">Service {p.serviceDate} · {p.targets.length} item(s) · {p.kind}</div>
                {(p.status === 'draft' || p.status === 'reserved') && info.stale && <div className="mt-1 text-xs text-warn">Stale — re-check before {p.status === 'draft' ? 'reserving' : 'preparing'}</div>}
                {info.pastDue && <div className="mt-1 text-xs text-block">Past due — record usage or release reservations</div>}
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function PlanDetail({ id }: { id: string }) {
  const { state, run, catalog, repo, toast, today } = useApp();
  const [, nav] = useHashRoute();
  const plan = state.plans.find((p) => p.id === id);
  const info = plan ? planStatusInfo(state, plan, repo.clock) : null;
  const evaluation = useMemo(() => (plan && plan.status !== 'completed' && plan.status !== 'cancelled' ? evaluatePlan(state, plan, plan.status === 'reserved' ? plan.id : undefined) : null), [state, plan]);
  const [reserveKey, setReserveKey] = useState(() => idemKey('reserve'));
  const [completeKey] = useState(() => idemKey('complete'));
  const [reserving, setReserving] = useState(false);
  const reservations = plan ? state.reservations.filter((r) => r.planId === plan.id) : [];
  const active = reservations.filter((r) => r.status === 'active');
  const [usage, setUsage] = useState<Record<string, string>>({});
  const [waste, setWaste] = useState<Record<string, { q: string; reason: string }>>({});
  const componentTargets = plan ? plan.targets.filter((t) => catalog.recipes.get(t.recipeId)?.produces) : [];
  const [outputs, setOutputs] = useState<Record<string, { quantity: string; unit: UnitCode; pool: Pool; storage: StorageState; useBy: string; verified: boolean }>>({});
  const [note, setNote] = useState('');
  const [completing, setCompleting] = useState(false);
  const [name, setName] = useState(plan?.name ?? '');
  const [date, setDate] = useState(plan?.serviceDate ?? today);

  if (!plan || !info) return <Empty title="Plan not found" />;
  const draft = plan.status === 'draft';

  const doReserve = async () => {
    setReserving(true);
    const res = await run('reservePlan', plan.id, reserveKey);
    setReserving(false);
    if (res) toast('ok', `Reserved ${res.reservationIds.length} lot allocation(s). Stock is held, not consumed.`);
    else setReserveKey(idemKey('reserve')); // a failed attempt made no change; a new attempt gets a new key
  };

  const doComplete = async () => {
    const input: CompletionInput = {
      usage: active.map((r) => ({ reservationId: r.id, used: usage[r.id] !== undefined && usage[r.id] !== '' ? Number(usage[r.id]) : r.quantity - r.consumed })),
      waste: Object.entries(waste).filter(([, w]) => Number(w.q) > 0).map(([reservationId, w]) => ({ reservationId, quantity: Number(w.q), reason: w.reason || 'Prep waste' })),
      outputs: componentTargets.map((t) => {
        const o = outputs[t.recipeId];
        const v = catalog.recipes.get(t.recipeId)!.versions.find((x) => x.id === t.recipeVersionId)!;
        const planned = t.requested.kind === 'quantity' ? t.requested.quantity : v.yield.quantity * (t.requested.servings / v.servings);
        return {
          recipeId: t.recipeId, quantity: o ? Number(o.quantity) : planned, unit: o?.unit ?? (t.requested.kind === 'quantity' ? t.requested.unit : v.yield.unit),
          pool: o?.pool ?? (plan.workspace as Pool), storage: o?.storage ?? 'refrigerated', useByDate: o?.useBy || null, dateVerified: o?.verified ?? false,
        };
      }),
      note,
    };
    setCompleting(true);
    const res = await run('completePlan', plan.id, input, completeKey);
    setCompleting(false);
    if (res) toast('ok', `Recorded. ${res.outputLotIds.length ? `${res.outputLotIds.length} prepared lot(s) added with lineage. ` : ''}${res.released ? `${res.released} unused reservation remainder(s) released.` : ''}`);
  };

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => nav('plans')}>← Plans</Button>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}>Print prep sheet</Button>
      </div>
      <div className="print-only text-xs">Table Zero Menu Lab · {state.org.name} · printed {new Date().toLocaleString()}</div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{plan.name}</h1>
        <span className={cx('chip', STATUS_STYLE[plan.status])}>{plan.status}</span>
        {evaluation && <GroupBadge group={evaluation.group} />}
        {plan.source === 'ai_draft' && <span className="chip border-review/30 bg-review-soft text-review">from AI draft</span>}
      </div>
      <p className="text-sm text-ink-mute">{plan.workspace === 'food' ? 'Food' : 'Bar'} · service {plan.serviceDate} · {plan.targets.map((t) => `${catalog.recipes.get(t.recipeId)?.name ?? t.recipeId} (${requestedLabel(t.requested)})`).join(' + ')} · menu protection {plan.options.protectMenu ? 'on' : 'relaxed'}</p>

      {info.stale && (plan.status === 'draft' || plan.status === 'reserved') && (
        <Notice tone="warn" title="Stale plan">
          <ul className="ml-4 list-disc">{info.staleReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {info.blockedReservations.length > 0 && <ul className="ml-4 list-disc">{info.blockedReservations.map((r) => <li key={r}>{r}</li>)}</ul>}
          {draft && <Button size="sm" className="mt-2" onClick={() => run('updatePlanDraft', plan.id, {})}>Re-check against current stock</Button>}
          {plan.status === 'reserved' && <p className="mt-1">Release and re-reserve if allocations need to change.</p>}
        </Notice>
      )}
      {info.pastDue && <Notice tone="block" title="Past-due reservations">Service date has passed. Record what was used, or release the reservations so the stock is free again.</Notice>}

      {draft && (
        <div className="no-print card grid gap-3 p-3 sm:grid-cols-4">
          <Field label="Name" className="sm:col-span-2">{(fid) => <input id={fid} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Service date">{(fid) => <input id={fid} type="date" min={today} className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <div className="flex items-end"><Button onClick={() => run('updatePlanDraft', plan.id, { name, serviceDate: date })}>Save draft changes</Button></div>
          {plan.targets.map((t, i) => t.requested.kind === 'servings' ? (
            <Field key={i} label={`${catalog.recipes.get(t.recipeId)?.name} portions`}>{(fid) => (
              <input id={fid} type="number" min={1} className="input" defaultValue={t.requested.kind === 'servings' ? t.requested.servings : 1}
                onBlur={(e) => run('updatePlanDraft', plan.id, { targets: plan.targets.map((x, k) => (k === i ? { ...x, requested: { kind: 'servings', servings: Math.max(1, Number(e.target.value) || 1) } } : x)) })} />
            )}</Field>
          ) : null)}
        </div>
      )}

      {evaluation && (
        <div className="space-y-3">
          <MatchSummaryNotices m={evaluation} />
          {evaluation.shortages.length > 0 && <Notice tone="warn" title="Short">{evaluation.shortages.map((s) => `${s.name} (+${formatBase(s.short, s.dimension)})`).join(', ')}</Notice>}
          <div className="card p-3">
            <h2 className="mb-2 text-lg font-semibold">{plan.status === 'reserved' ? 'Current check (excluding this plan’s own reservations)' : 'Combined demand & FEFO allocation'}</h2>
            <RequirementsTable m={evaluation} />
          </div>
          {evaluation.prepSteps.length > 0 && (
            <div className="card p-3 text-sm">
              <h2 className="text-lg font-semibold">Prep components first</h2>
              <ul className="ml-4 list-disc">{evaluation.prepSteps.map((p) => <li key={p.key}>{p.recipeName} — {Math.round(p.scale * 100) / 100}× recipe{p.equipment.length ? ` · ${p.equipment.join(', ')}` : ''}{p.totalMinutes ? ` · ${p.totalMinutes} min` : ''}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {draft && (
        <div className="no-print card space-y-2 p-3">
          <Button variant="primary" busy={reserving} disabled={!evaluation || evaluation.group !== 'make_now'} onClick={doReserve}>
            {reserving ? 'Reserving — waiting for confirmation…' : 'Reserve stock'}
          </Button>
          {evaluation && evaluation.group !== 'make_now' && <p className="text-sm text-ink-mute">Only plans that are fully "Make now" against current stock can be reserved.</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => run('releasePlan', plan.id, 'Cancelled draft', true)}>Cancel plan</Button>
          </div>
        </div>
      )}

      {plan.status === 'reserved' && (
        <div className="space-y-3">
          <div className="card p-3">
            <h2 className="mb-2 text-lg font-semibold">Reserved lots — record actual usage</h2>
            <table className="table-base">
              <thead><tr><th>Ingredient / lot</th><th className="text-right">Reserved</th><th>Used</th><th className="no-print">Waste</th></tr></thead>
              <tbody>
                {active.map((r) => {
                  const lot = state.lots.find((l) => l.id === r.lotId);
                  const ing = catalog.ingredients.get(r.ingredientId);
                  const unit = ing?.dimension === 'mass' ? 'g' : ing?.dimension === 'volume' ? 'ml' : 'each';
                  return (
                    <tr key={r.id}>
                      <td>{ing?.name} <span className="text-xs text-ink-mute">· {lot?.lotRef ?? r.lotId}</span> {lot && <PoolBadge pool={lot.pool} />}</td>
                      <td className="text-right tabular-nums">{formatBase(r.quantity - r.consumed, ing?.dimension ?? 'count')}</td>
                      <td><input aria-label={`Used ${ing?.name} (${unit})`} type="number" min={0} step="any" className="input w-32" placeholder={String(Math.round((r.quantity - r.consumed) * 1000) / 1000)} value={usage[r.id] ?? ''} onChange={(e) => setUsage({ ...usage, [r.id]: e.target.value })} /> <span className="text-xs">{unit}</span></td>
                      <td className="no-print"><div className="flex gap-1"><input aria-label={`Waste ${ing?.name}`} type="number" min={0} className="input w-24" value={waste[r.id]?.q ?? ''} onChange={(e) => setWaste({ ...waste, [r.id]: { q: e.target.value, reason: waste[r.id]?.reason ?? '' } })} /><input aria-label={`Waste reason ${ing?.name}`} className="input w-32" placeholder="reason" value={waste[r.id]?.reason ?? ''} onChange={(e) => setWaste({ ...waste, [r.id]: { q: waste[r.id]?.q ?? '', reason: e.target.value } })} /></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink-mute">Blank = used as reserved. Any unused remainder is released automatically. Waste is recorded separately from usage.</p>
          </div>
          {componentTargets.length > 0 && (
            <div className="no-print card space-y-3 p-3">
              <h2 className="text-lg font-semibold">Prep output</h2>
              {componentTargets.map((t) => {
                const r = catalog.recipes.get(t.recipeId)!;
                const v = r.versions.find((x) => x.id === t.recipeVersionId)!;
                const o = outputs[t.recipeId] ?? { quantity: t.requested.kind === 'quantity' ? String(t.requested.quantity) : String(v.yield.quantity), unit: t.requested.kind === 'quantity' ? t.requested.unit : v.yield.unit, pool: plan.workspace as Pool, storage: 'refrigerated' as StorageState, useBy: '', verified: false };
                const setO = (p: Partial<typeof o>) => setOutputs({ ...outputs, [t.recipeId]: { ...o, ...p } });
                return (
                  <div key={t.recipeId} className="grid gap-2 sm:grid-cols-6">
                    <div className="sm:col-span-6 text-sm font-medium">{r.name} → {catalog.ingredients.get(r.produces!.ingredientId)?.name}</div>
                    <Field label="Actual yield">{(fid) => <input id={fid} type="number" min={0} className="input" value={o.quantity} onChange={(e) => setO({ quantity: e.target.value })} />}</Field>
                    <Field label="Unit">{(fid) => <select id={fid} className="input" value={o.unit} onChange={(e) => setO({ unit: e.target.value as UnitCode })}>{(['g', 'kg', 'ml', 'l', 'fl_oz', 'each'] as UnitCode[]).map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}</select>}</Field>
                    <Field label="Pool">{(fid) => <select id={fid} className="input" value={o.pool} onChange={(e) => setO({ pool: e.target.value as Pool })}><option value={plan.workspace}>{plan.workspace}</option><option value="shared">shared</option></select>}</Field>
                    <Field label="Use-by (from verified SOP)">{(fid) => <input id={fid} type="date" className="input" value={o.useBy} onChange={(e) => setO({ useBy: e.target.value })} />}</Field>
                    <label className="flex items-end gap-2 pb-2 text-sm sm:col-span-2"><input type="checkbox" checked={o.verified} onChange={(e) => setO({ verified: e.target.checked })} /> Date verified against our written procedure</label>
                    <p className="text-xs text-ink-mute sm:col-span-6">The output also inherits the earliest cutoff of its inputs; a later date here cannot extend that. Leaving the date blank keeps the lot in Needs review.</p>
                  </div>
                );
              })}
            </div>
          )}
          <div className="no-print card space-y-2 p-3">
            <Field label="Note">{(fid) => <input id={fid} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={completing} onClick={doComplete}>{componentTargets.length ? 'Record preparation' : 'Record usage'}</Button>
              <Button onClick={() => run('releasePlan', plan.id, 'Released to edit', false)}>Release reservations (back to draft)</Button>
              <Button variant="ghost" onClick={() => run('releasePlan', plan.id, 'Cancelled', true)}>Cancel & release</Button>
            </div>
            <p className="text-xs text-ink-mute">Retrying after a network error is safe: this action uses a single idempotency key.</p>
          </div>
        </div>
      )}

      {plan.status === 'completed' && (
        <div className="card space-y-2 p-3 text-sm">
          <h2 className="text-lg font-semibold">Recorded</h2>
          <ul className="ml-4 list-disc">
            {reservations.map((r) => <li key={r.id}>{catalog.ingredients.get(r.ingredientId)?.name}: used/wasted {formatBase(r.consumed, catalog.ingredients.get(r.ingredientId)?.dimension ?? 'count')} of {formatBase(r.quantity, catalog.ingredients.get(r.ingredientId)?.dimension ?? 'count')} reserved</li>)}
          </ul>
          {state.prepBatches.filter((b) => b.planId === plan.id).map((b) => {
            const lot = state.lots.find((l) => l.id === b.outputLotId);
            const ing = lot ? catalog.ingredients.get(lot.ingredientId) : undefined;
            return <p key={b.id}>Output: {ing?.name} {formatBase(b.outputQuantity, ing?.dimension ?? 'count')} → lot {lot?.lotRef} ({lot?.pool}), use-by {lot?.useByDate ?? 'not set'}, input limit {lot?.lineage?.inheritedCutoff ?? '—'}</p>;
          })}
        </div>
      )}
    </div>
  );
}
