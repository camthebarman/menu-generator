import { useMemo, useState } from 'react';
import { contentHash, downloadText, parseCsv, toCsv } from '../domain/csv';
import { addDays } from '../domain/dates';
import { guessColumnMapping, INVENTORY_COLUMNS, normalizeName, previewInventoryImport, type InventoryPreviewRow } from '../domain/imports';
import { isManager, visiblePools, type LotInput } from '../domain/ops';
import { balances, buildStockView } from '../domain/stock';
import { POOLS, type Form, type Ingredient, type Lot, type LotStatus, type Pool, type StorageState, type UnitCode } from '../domain/types';
import { formatBase, formatQty, fromIngredientBase, UNIT_CODES, UNITS } from '../domain/units';
import { idemKey } from '../data/repository';
import { Button, Drawer, Empty, Field, Notice, PoolBadge, Section, StatusBadge, cx } from './components';
import { useApp } from './store';

type Tab = 'balances' | 'lots' | 'add' | 'bulk' | 'import';

export function lotQtyLabel(lot: Lot, ing: Ingredient | undefined): string {
  if (lot.quantity === null) return lot.enteredQuantity !== null && lot.enteredQuantity !== undefined ? `${lot.enteredQuantity} ${UNITS[lot.enteredUnit].label} (unconverted)` : 'Unknown';
  if (!ing) return String(lot.quantity);
  const disp = fromIngredientBase(lot.quantity, lot.enteredUnit, ing, lot.packageSize);
  const base = formatBase(lot.quantity, ing.dimension);
  if (disp !== null && lot.enteredUnit !== 'g' && lot.enteredUnit !== 'ml' && lot.enteredUnit !== 'each') return `${formatQty(disp)} ${UNITS[lot.enteredUnit].label} · ${base}`;
  return base;
}

export function Inventory() {
  const { state, workspace, today, catalog } = useApp();
  const [tab, setTab] = useState<Tab>('balances');
  const mgr = isManager(state.currentUser);
  const allowed = visiblePools(state.currentUser);
  const [poolFilter, setPoolFilter] = useState<'workspace' | Pool | 'all'>('workspace');
  const pools: Pool[] = poolFilter === 'workspace' ? (workspace === 'food' ? ['food', 'shared'] : ['bar', 'shared']) : poolFilter === 'all' ? allowed : [poolFilter];
  const view = useMemo(() => buildStockView(state, { workspace, plannedDate: today, protectMenu: true, catalog }), [state, workspace, today, catalog]);
  const [lotId, setLotId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyFlags, setOnlyFlags] = useState(false);

  const bal = balances(view, pools)
    .map((b) => ({ ...b, ing: catalog.ingredients.get(b.ingredientId)! }))
    .filter((b) => b.ing && (!q || b.ing.name.toLowerCase().includes(q.toLowerCase())))
    .filter((b) => !onlyFlags || b.atRiskLots + b.reviewLots + b.blockedLots + b.unknownQtyLots > 0)
    .sort((a, b) => a.ing.name.localeCompare(b.ing.name));
  const lots = view.slots
    .filter((s) => pools.includes(s.lot.pool) && allowed.includes(s.lot.pool))
    .filter((s) => !q || (catalog.ingredients.get(s.lot.ingredientId)?.name ?? '').toLowerCase().includes(q.toLowerCase()) || (s.lot.lotRef ?? '').toLowerCase().includes(q.toLowerCase()))
    .filter((s) => !onlyFlags || s.elig.state !== 'eligible' || s.elig.atRisk)
    .sort((a, b) => (a.elig.cutoff ?? '9999') .localeCompare(b.elig.cutoff ?? '9999'));

  const tabs: { id: Tab; label: string }[] = [
    { id: 'balances', label: 'Balances' }, { id: 'lots', label: 'Lots' }, { id: 'add', label: 'Quick add' }, { id: 'bulk', label: 'Bulk grid' }, { id: 'import', label: 'CSV import' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Inventory views">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx('rounded-lg border px-3 py-2 text-sm font-medium', tab === t.id ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')}>{t.label}</button>
        ))}
      </div>
      {(tab === 'balances' || tab === 'lots') && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Pools">{(id) => (
            <select id={id} className="input" value={poolFilter} onChange={(e) => setPoolFilter(e.target.value as typeof poolFilter)}>
              <option value="workspace">{workspace === 'food' ? 'Food + Shared (Food availability)' : 'Bar + Shared (Bar availability)'}</option>
              {mgr && <option value="all">All pools (manager view)</option>}
              {POOLS.filter((p) => allowed.includes(p)).map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)} only</option>)}
            </select>
          )}</Field>
          <Field label="Search">{(id) => <input id={id} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ingredient or lot ref" />}</Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} /> Only items needing attention</label>
          <Button size="sm" className="mb-1" onClick={() => exportLotsCsv(state)}>Export lots CSV</Button>
          <p className="pb-2 text-xs text-ink-mute">Eligibility shown for {today} ({state.org.timezone}). Alerts at ≤{state.org.policy.alertDays} days are reminders, not safety guarantees.</p>
        </div>
      )}
      {tab === 'balances' && (
        <div className="card overflow-x-auto p-2">
          <table className="table-base">
            <thead><tr><th>Ingredient</th><th>Pools</th><th className="text-right">Physical on hand</th><th className="text-right">Reserved</th><th className="text-right">Menu protected</th><th className="text-right">Free for specials</th><th>Flags</th></tr></thead>
            <tbody>
              {bal.map((b) => (
                <tr key={b.key}>
                  <td className="font-medium">{b.ing.name}{b.form !== 'raw' && <span className="text-xs text-ink-mute"> ({b.form})</span>}</td>
                  <td><div className="flex gap-1">{b.pools.map((p) => <PoolBadge key={p} pool={p} />)}</div></td>
                  <td className="text-right tabular-nums">{formatBase(b.physical, b.ing.dimension)}</td>
                  <td className="text-right tabular-nums">{b.reserved ? formatBase(b.reserved, b.ing.dimension) : '—'}</td>
                  <td className="text-right tabular-nums">{b.menuProtected ? formatBase(b.menuProtected, b.ing.dimension) : '—'}</td>
                  <td className="text-right font-semibold tabular-nums">{formatBase(b.freeForSpecials, b.ing.dimension)}</td>
                  <td className="space-x-1 text-xs">
                    {b.atRiskLots > 0 && <span className="chip border-risk/30 bg-risk-soft text-risk">{b.atRiskLots} near date</span>}
                    {b.reviewLots > 0 && <span className="chip border-review/30 bg-review-soft text-review">{b.reviewLots} needs review</span>}
                    {b.unknownQtyLots > 0 && <span className="chip border-review/30 bg-review-soft text-review">qty unknown</span>}
                    {b.blockedLots > 0 && <span className="chip border-block/30 bg-block-soft text-block">{b.blockedLots} blocked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bal.length === 0 && <Empty title="No stock in these pools" />}
          <p className="px-2 pt-2 text-xs text-ink-mute">Physical excludes blocked lots. Shared stock is one physical balance used by both workspaces; protection for both menus applies to the same lots.</p>
        </div>
      )}
      {tab === 'lots' && (
        <div className="card overflow-x-auto p-2">
          <table className="table-base">
            <thead><tr><th>Ingredient</th><th>Lot</th><th>Pool</th><th className="text-right">Quantity</th><th>Cutoff / dates</th><th>Status today</th></tr></thead>
            <tbody>
              {lots.map((s) => {
                const ing = catalog.ingredients.get(s.lot.ingredientId);
                return (
                  <tr key={s.lot.id} className="cursor-pointer hover:bg-paper-shade" onClick={() => setLotId(s.lot.id)}>
                    <td className="font-medium"><button className="text-left underline-offset-2 hover:underline" onClick={() => setLotId(s.lot.id)}>{ing?.name ?? s.lot.ingredientId}</button>{s.lot.form !== 'raw' && <span className="text-xs text-ink-mute"> ({s.lot.form})</span>}</td>
                    <td className="text-xs">{s.lot.lotRef ?? s.lot.id.slice(-6)}</td>
                    <td><PoolBadge pool={s.lot.pool} /></td>
                    <td className="text-right tabular-nums">{lotQtyLabel(s.lot, ing)}{s.reserved > 0 && <div className="text-xs text-ink-mute">{formatBase(s.reserved / 1e6, ing?.dimension ?? 'count')} reserved</div>}</td>
                    <td className="text-xs">
                      {s.elig.cutoff ? <span className={cx(s.elig.atRisk && 'font-semibold text-risk')}>{s.elig.cutoffSource}: {s.elig.cutoff}</span> : <span className="text-ink-mute">No cutoff · received {s.elig.receivedDate}</span>}
                      {s.lot.qualityDate && <div>Best-by {s.lot.qualityDate}</div>}
                    </td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={s.lot.status} />
                        {s.elig.state !== 'eligible' && <span className={cx('text-xs', s.elig.state === 'blocked' ? 'text-block' : 'text-review')}>{s.elig.state === 'blocked' ? 'Not usable' : 'Needs review'}: {s.elig.reasons[0]}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lots.length === 0 && <Empty title="No lots match" />}
        </div>
      )}
      {tab === 'add' && <QuickAdd />}
      {tab === 'bulk' && <BulkGrid />}
      {tab === 'import' && <CsvImport />}
      <LotDrawer lotId={lotId} onClose={() => setLotId(null)} />
    </div>
  );
}

const STORAGE: StorageState[] = ['dry', 'refrigerated', 'frozen', 'bar_rail', 'other'];

function emptyLot(workspace: 'food' | 'bar'): LotInput {
  return { ingredientId: '', form: 'raw', quantity: null, unit: 'g', pool: workspace, storage: 'refrigerated', dateVerification: 'verified', dateProvenance: 'label' };
}

function QuickAdd() {
  const { state, workspace, run, toast, catalog } = useApp();
  const [lot, setLot] = useState<LotInput>(emptyLot(workspace));
  const [unknownQty, setUnknownQty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [costText, setCostText] = useState('');
  const set = (p: Partial<LotInput>) => setLot((l) => ({ ...l, ...p }));
  const ing = catalog.ingredients.get(lot.ingredientId);
  const pools = visiblePools(state.currentUser);
  const submit = async () => {
    setBusy(true);
    const cost = costText ? { amount: Number(costText), perQuantity: lot.quantity ?? 1, perUnit: lot.unit } : null;
    const res = await run('receiveLot', { ...lot, quantity: unknownQty ? null : lot.quantity, cost }, idemKey('recv'));
    setBusy(false);
    if (res) {
      toast('ok', res.quantityResolved ? 'Lot received.' : 'Lot received but its unit could not be converted — it is marked Needs review.');
      setLot(emptyLot(workspace));
      setCostText('');
    }
  };
  const dateField = (k: keyof LotInput, label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <input id={id} type="date" className="input" value={(lot[k] as string) ?? ''} onChange={(e) => set({ [k]: e.target.value || null } as Partial<LotInput>)} />}</Field>
  );
  return (
    <div className="card space-y-4 p-4">
      <Section title="Receive stock" description="Enter what the label says. Leave unknown dates or quantities blank — they stay visible as unresolved instead of being guessed.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Ingredient">{(id) => (
            <select id={id} className="input" value={lot.ingredientId} onChange={(e) => { const i = catalog.ingredients.get(e.target.value); set({ ingredientId: e.target.value, unit: i ? (i.dimension === 'mass' ? 'g' : i.dimension === 'volume' ? 'ml' : 'each') : 'g', storage: i?.perishable ? 'refrigerated' : 'dry' }); }}>
              <option value="">Choose…</option>
              {[...catalog.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}</Field>
          <Field label="Form">{(id) => <select id={id} className="input" value={lot.form} onChange={(e) => set({ form: e.target.value as Form })}><option value="raw">Raw</option><option value="cooked">Cooked</option><option value="prepared">Prepared</option></select>}</Field>
          <Field label="Quantity">{(id) => (
            <div className="flex gap-2">
              <input id={id} type="number" min={0} step="any" className="input" disabled={unknownQty} value={lot.quantity ?? ''} onChange={(e) => set({ quantity: e.target.value === '' ? null : Number(e.target.value) })} />
              <select aria-label="Unit" className="input w-28" value={lot.unit} onChange={(e) => set({ unit: e.target.value as UnitCode })}>
                {UNIT_CODES.filter((u) => u !== 'serving').map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}
              </select>
            </div>
          )}</Field>
          <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unknownQty} onChange={(e) => setUnknownQty(e.target.checked)} /> Quantity unknown</label></div>
          {UNITS[lot.unit].dimension === 'package' && (
            <Field label="Package size" hint={ing ? `e.g. 750 ml per bottle. Without it, ${UNITS[lot.unit].label} needs a recorded conversion.` : undefined}>{(id) => (
              <div className="flex gap-2">
                <input id={id} type="number" min={0} className="input" value={lot.packageSize?.quantity ?? ''} onChange={(e) => set({ packageSize: e.target.value ? { quantity: Number(e.target.value), unit: lot.packageSize?.unit ?? (ing?.dimension === 'volume' ? 'ml' : 'g') } : null })} />
                <select aria-label="Package unit" className="input w-24" value={lot.packageSize?.unit ?? 'ml'} onChange={(e) => set({ packageSize: { quantity: lot.packageSize?.quantity ?? 0, unit: e.target.value as UnitCode } })}>
                  {['g', 'kg', 'ml', 'l', 'fl_oz', 'oz', 'lb', 'each'].map((u) => <option key={u} value={u}>{UNITS[u as UnitCode].label}</option>)}
                </select>
              </div>
            )}</Field>
          )}
          <Field label="Pool">{(id) => <select id={id} className="input" value={lot.pool} onChange={(e) => set({ pool: e.target.value as Pool })}>{pools.map((p) => <option key={p} value={p}>{p}</option>)}</select>}</Field>
          <Field label="Storage">{(id) => <select id={id} className="input" value={lot.storage} onChange={(e) => set({ storage: e.target.value as StorageState })}>{STORAGE.map((p) => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}</select>}</Field>
          <Field label="Location">{(id) => <input id={id} className="input" value={lot.location ?? ''} onChange={(e) => set({ location: e.target.value })} placeholder="Walk-in shelf 2" />}</Field>
          {dateField('useByDate', 'Use-by', 'Hard cutoff under current policy')}
          {dateField('expirationDate', 'Expiration')}
          {dateField('qualityDate', 'Best-by (quality)', 'Passing it triggers review, not discard')}
          {dateField('sellByDate', 'Sell-by')}
          {dateField('operationalDiscardDate', 'House discard date', 'From your verified SOP; never auto-filled')}
          {dateField('hardDiscardDate', 'Hard discard cutoff')}
          {dateField('openedOn', 'Opened on')}
          {dateField('packageDate', 'Pack date')}
          <Field label="Label wording">{(id) => <input id={id} className="input" value={lot.labelWording ?? ''} onChange={(e) => set({ labelWording: e.target.value })} placeholder='e.g. "BEST IF USED BY"' />}</Field>
          <Field label="Date check">{(id) => <select id={id} className="input" value={lot.dateVerification} onChange={(e) => set({ dateVerification: e.target.value as 'verified' })}><option value="verified">Verified against label/SOP</option><option value="unverified">Unverified</option></select>}</Field>
          <Field label={`Cost for this quantity (${state.org.currency})`} hint="Optional">{(id) => <input id={id} type="number" min={0} step="0.01" className="input" value={costText} onChange={(e) => setCostText(e.target.value)} />}</Field>
          <Field label="Supplier">{(id) => <input id={id} className="input" value={lot.supplier ?? ''} onChange={(e) => set({ supplier: e.target.value })} />}</Field>
          <Field label="Lot / invoice ref">{(id) => <input id={id} className="input" value={lot.lotRef ?? ''} onChange={(e) => set({ lotRef: e.target.value })} />}</Field>
          <Field label="Notes" className="sm:col-span-2">{(id) => <input id={id} className="input" value={lot.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />}</Field>
        </div>
        {ing?.perishable && !lot.useByDate && !lot.expirationDate && !lot.operationalDiscardDate && !lot.hardDiscardDate && (
          <Notice tone="review">{ing.name} is perishable. Without a use-by or discard date the lot will be held for review rather than assigned a guessed date.</Notice>
        )}
        <Button variant="primary" onClick={submit} busy={busy} disabled={!lot.ingredientId || (!unknownQty && lot.quantity === null)}>Receive lot</Button>
      </Section>
    </div>
  );
}

interface GridRow { ingredient: string; quantity: string; unit: string; pool: string; use_by: string; quality_date: string; cost: string; lot_ref: string }
const blankRow = (pool: string): GridRow => ({ ingredient: '', quantity: '', unit: '', pool, use_by: '', quality_date: '', cost: '', lot_ref: '' });

function BulkGrid() {
  const { state, workspace, run, toast } = useApp();
  const [rows, setRows] = useState<GridRow[]>([blankRow(workspace), blankRow(workspace), blankRow(workspace)]);
  const [verified, setVerified] = useState(true);
  const filled = rows.filter((r) => r.ingredient.trim());
  const preview = useMemo(() => previewInventoryImport(state, filled.map((r) => ({ ...r, date_verified: verified ? 'yes' : '', cost_unit: r.unit })) as never, Object.fromEntries([...INVENTORY_COLUMNS].map((c) => [c, c])), {}), [state, filled, verified]);
  const update = (i: number, k: keyof GridRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const commit = async () => {
    const text = toCsv(Object.keys(rows[0]), filled.map((r) => Object.values(r)));
    const res = await run('commitInventoryImport', preview, 'bulk-grid', `${text}${Date.now()}`);
    if (res) {
      toast('ok', `Added ${res.created} lot(s) in one atomic commit.`);
      setRows([blankRow(workspace), blankRow(workspace), blankRow(workspace)]);
    }
  };
  return (
    <div className="card space-y-3 p-4">
      <Section title="Bulk entry" description="Type names as they appear in the catalog; exact names and confirmed aliases map automatically. All rows commit together or not at all.">
        <div className="overflow-x-auto">
          <table className="table-base min-w-[48rem]">
            <thead><tr>{['Ingredient', 'Qty', 'Unit', 'Pool', 'Use-by', 'Best-by', 'Cost', 'Lot ref', 'Check'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const p = r.ingredient.trim() ? preview[filled.indexOf(r)] : null;
                return (
                  <tr key={i}>
                    {(Object.keys(r) as (keyof GridRow)[]).map((k) => (
                      <td key={k} className="p-1">
                        <input aria-label={`${k} row ${i + 1}`} className="input min-h-0 py-1" type={k === 'use_by' || k === 'quality_date' ? 'date' : 'text'} list={k === 'ingredient' ? 'ing-list' : k === 'unit' ? 'unit-list' : undefined} value={r[k]} onChange={(e) => update(i, k, e.target.value)} />
                      </td>
                    ))}
                    <td className="text-xs">{p ? (p.status === 'ready' ? <span className="text-ok">OK</span> : <span className="text-warn">{p.errors[0] ?? (p.status === 'needs_mapping' ? `Unknown name${p.mapping.suggestions[0] ? ` — did you mean ${p.mapping.suggestions[0].name}?` : ''}` : p.duplicateOf)}</span>) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="ing-list">{state.ingredients.map((i) => <option key={i.id} value={i.name} />)}</datalist>
          <datalist id="unit-list">{UNIT_CODES.map((u) => <option key={u} value={u} />)}</datalist>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setRows((r) => [...r, blankRow(workspace)])}>Add row</Button>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> Dates checked against labels</label>
          <Button variant="primary" disabled={filled.length === 0 || preview.some((p) => p.status === 'error' || p.status === 'needs_mapping')} onClick={commit}>Commit {filled.length} row(s)</Button>
        </div>
      </Section>
    </div>
  );
}

function CsvImport() {
  const { state, run, toast } = useApp();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const parsed = useMemo(() => (file ? parseCsv(file.text) : null), [file]);
  const [map, setMap] = useState<Record<string, string | null>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [includeDup, setIncludeDup] = useState(false);
  const colMap = useMemo(() => (parsed ? { ...guessColumnMapping(parsed.headers, INVENTORY_COLUMNS), ...map } : {}), [parsed, map]);
  const preview: InventoryPreviewRow[] = useMemo(() => (parsed ? previewInventoryImport(state, parsed.rows, colMap, overrides) : []), [parsed, state, colMap, overrides]);
  const counts = preview.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {} as Record<string, number>);
  const already = file ? state.imports.some((i) => i.kind === 'inventory' && i.contentHash === contentHash(file.text)) : false;
  const unmappedNames = [...new Set(preview.filter((r) => r.status === 'needs_mapping').map((r) => r.ingredientText))];
  return (
    <div className="card space-y-4 p-4">
      <Section title="Import inventory CSV" description="Map columns, review every row, then commit. Re-importing the same file is detected and has no effect."
        actions={<a className="inline-flex min-h-[2.25rem] items-center rounded-lg border border-paper-line bg-white px-3 text-sm font-medium" href={`${import.meta.env.BASE_URL}templates/inventory-example.csv`} download>Download example CSV</a>}>
        <input type="file" accept=".csv,text/csv" aria-label="Choose CSV file" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { toast('error', 'File too large (2 MB limit)'); return; }
          setFile({ name: f.name, text: await f.text() });
          setMap({}); setOverrides({});
        }} />
        {parsed && parsed.errors.length > 0 && <Notice tone="warn" title="Parse warnings">{parsed.errors.join(' · ')}</Notice>}
        {already && <Notice tone="info">This exact file was already imported; committing again will not add duplicates.</Notice>}
        {parsed && (
          <>
            <details open>
              <summary className="cursor-pointer text-sm font-semibold">Column mapping</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {INVENTORY_COLUMNS.map((f) => (
                  <Field key={f} label={f.replace(/_/g, ' ')}>{(id) => (
                    <select id={id} className="input" value={colMap[f] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value || null }))}>
                      <option value="">—</option>
                      {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  )}</Field>
                ))}
              </div>
            </details>
            {unmappedNames.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Map unknown ingredient names (fuzzy matches are suggestions only)</h3>
                {unmappedNames.map((name) => {
                  const sug = preview.find((r) => r.ingredientText === name)?.mapping.suggestions ?? [];
                  return (
                    <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">"{name}"</span> →
                      <select aria-label={`Map ${name}`} className="input max-w-xs" value={overrides[normalizeName(name)] ?? ''} onChange={(e) => setOverrides((o) => ({ ...o, [normalizeName(name)]: e.target.value }))}>
                        <option value="">Choose ingredient…</option>
                        {sug.map((s) => <option key={s.ingredientId} value={s.ingredientId}>Suggested: {s.name}</option>)}
                        {state.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-sm">
              {Object.entries(counts).map(([k, v]) => <span key={k} className="chip border-paper-line bg-white">{k.replace('_', ' ')}: {v}</span>)}
            </div>
            <div className="max-h-96 overflow-auto">
              <table className="table-base">
                <thead><tr><th>Row</th><th>Ingredient</th><th>Qty</th><th>Pool</th><th>Dates</th><th>Result</th></tr></thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={r.index}>
                      <td>{r.index + 2}</td>
                      <td>{r.ingredientText}{r.mapping.ingredientId && r.mapping.method !== 'exact' && <div className="text-xs text-ink-mute">→ {state.ingredients.find((i) => i.id === r.mapping.ingredientId)?.name} ({r.mapping.method})</div>}</td>
                      <td>{r.input?.quantity ?? 'unknown'} {r.input?.unit}</td>
                      <td>{r.input?.pool}</td>
                      <td className="text-xs">{[r.input?.useByDate && `use-by ${r.input.useByDate}`, r.input?.qualityDate && `best-by ${r.input.qualityDate}`].filter(Boolean).join(', ')}</td>
                      <td className="text-xs">
                        <span className={cx(r.status === 'ready' ? 'text-ok' : r.status === 'duplicate' ? 'text-warn' : 'text-block')}>{r.status.replace('_', ' ')}{r.duplicateOf ? ` (${r.duplicateOf})` : ''}</span>
                        {r.errors.map((e) => <div key={e} className="text-block">{e}</div>)}
                        {r.warnings.map((e) => <div key={e} className="text-ink-mute">{e}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeDup} onChange={(e) => setIncludeDup(e.target.checked)} /> Import rows flagged as duplicates too</label>
            <Button variant="primary" disabled={!file || preview.some((r) => r.status === 'error' || r.status === 'needs_mapping') || preview.length === 0}
              onClick={async () => {
                const res = await run('commitInventoryImport', preview, file!.name, file!.text, includeDup);
                if (res) toast('ok', `Imported ${res.created} lot(s).`);
              }}>Commit import</Button>
          </>
        )}
      </Section>
    </div>
  );
}

function LotDrawer({ lotId, onClose }: { lotId: string | null; onClose: () => void }) {
  const { state, run, catalog, today, workspace } = useApp();
  const lot = state.lots.find((l) => l.id === lotId);
  const ing = lot ? catalog.ingredients.get(lot.ingredientId) : undefined;
  const view = useMemo(() => (lot ? buildStockView(state, { workspace, plannedDate: today, protectMenu: true, catalog }) : null), [state, lot, workspace, today, catalog]);
  const slot = lot && view ? view.slotById.get(lot.id) : undefined;
  const mgr = isManager(state.currentUser);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<LotStatus>('quarantined');
  const [toPool, setToPool] = useState<Pool>('shared');
  const [reviewThrough, setReviewThrough] = useState(addDays(today, 1));
  if (!lot || !ing) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const base = Number(qty);
  const movements = state.movements.filter((m) => m.lotId === lot.id).sort((a, b) => b.at.localeCompare(a.at));
  const reserved = state.reservations.filter((r) => r.lotId === lot.id && r.status === 'active');
  return (
    <Drawer open={!!lotId} onClose={onClose} title={`${ing.name} · ${lot.lotRef ?? lot.id.slice(-6)}`}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2"><PoolBadge pool={lot.pool} /><StatusBadge status={lot.status} /><span className="chip border-paper-line">{lot.form}</span><span className="chip border-paper-line">{lot.storage.replace('_', ' ')}</span></div>
        <div className="grid grid-cols-2 gap-2">
          <div><div className="label">Quantity</div>{lotQtyLabel(lot, ing)}</div>
          <div><div className="label">Received</div>{slot?.elig.receivedDate}</div>
          {(['useByDate', 'expirationDate', 'qualityDate', 'sellByDate', 'operationalDiscardDate', 'hardDiscardDate', 'openedOn', 'preparedOn', 'packageDate'] as const).filter((k) => lot[k]).map((k) => (
            <div key={k}><div className="label">{k.replace(/([A-Z])/g, ' $1').replace('Date', '').trim()}</div>{lot[k]}</div>
          ))}
          <div><div className="label">Date provenance</div>{lot.dateProvenance.replace('_', ' ')} · {lot.dateVerification}</div>
          {lot.labelWording && <div><div className="label">Label wording</div>"{lot.labelWording}"</div>}
          {lot.supplier && <div><div className="label">Supplier</div>{lot.supplier}</div>}
          {lot.cost && <div><div className="label">Cost</div>{lot.cost.amount} {state.org.currency} per {lot.cost.perQuantity} {UNITS[lot.cost.perUnit].label}</div>}
        </div>
        {slot && slot.elig.reasons.length > 0 && <Notice tone={slot.elig.state === 'blocked' ? 'block' : 'review'} title={slot.elig.state === 'blocked' ? `Not usable on ${today}` : 'Needs review'}>{slot.elig.reasons.join('; ')}</Notice>}
        {slot && slot.elig.notes.length > 0 && <Notice>{slot.elig.notes.join('; ')}</Notice>}
        {lot.notes && <p className="text-ink-mute">{lot.notes}</p>}
        {lot.lineage && (
          <div className="card p-3">
            <div className="label">Prep lineage</div>
            <p>Made via {catalog.recipes.get(lot.lineage.recipeId)?.name} ({lot.lineage.recipeVersionId}); limited by earliest input cutoff {lot.lineage.inheritedCutoff ?? '—'}.</p>
            <ul className="ml-4 list-disc text-xs">{lot.lineage.sources.map((s) => <li key={s.lotId}>{formatBase(s.quantity, catalog.ingredients.get(s.ingredientId)?.dimension ?? 'count')} {catalog.ingredients.get(s.ingredientId)?.name} from {state.lots.find((l) => l.id === s.lotId)?.lotRef ?? s.lotId}</li>)}</ul>
          </div>
        )}
        {reserved.length > 0 && <Notice title="Reserved">{reserved.map((r) => `${formatBase(r.quantity - r.consumed, ing.dimension)} for plan ${state.plans.find((p) => p.id === r.planId)?.name ?? r.planId}`).join('; ')}</Notice>}

        <div className="no-print space-y-3 rounded-xl border border-paper-line bg-white p-3">
          <div className="label">Actions (reason required, audited)</div>
          <Field label="Reason / note">{(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Recount at close" />}</Field>
          <Field label={`Quantity (${ing.dimension === 'mass' ? 'g' : ing.dimension === 'volume' ? 'ml' : 'each'})`}>{(id) => <input id={id} type="number" min={0} step="any" className="input" value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!qty || !reason} onClick={() => run('adjustLot', lot.id, base, reason, idemKey('adj'))}>Set counted quantity</Button>
            <Button size="sm" disabled={!qty || !reason} onClick={() => run('recordWaste', lot.id, base, reason, idemKey('waste'))}>Record waste</Button>
            <Button size="sm" disabled={!reason} onClick={() => run('openLot', lot.id, today, null, reason)}>Mark opened today</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Status">{(id) => <select id={id} className="input" value={status} onChange={(e) => setStatus(e.target.value as LotStatus)}>{(['available', 'needs_review', 'quarantined', 'spoiled', 'discarded', 'recalled'] as LotStatus[]).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>}</Field>
            <Button size="sm" disabled={!reason} onClick={() => run('setLotStatus', lot.id, status, reason)}>Set status</Button>
          </div>
          {mgr && lot.qualityDate && slot?.elig.qualityPassed && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Quality review valid through" hint="Cannot extend past any hard cutoff.">{(id) => <input id={id} type="date" className="input" value={reviewThrough} onChange={(e) => setReviewThrough(e.target.value)} />}</Field>
              <Button size="sm" disabled={!reason} onClick={() => run('approveQualityReview', lot.id, reviewThrough, reason)}>Record manager review</Button>
            </div>
          )}
          {mgr && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Transfer to pool">{(id) => <select id={id} className="input" value={toPool} onChange={(e) => setToPool(e.target.value as Pool)}>{POOLS.filter((p) => p !== lot.pool).map((p) => <option key={p} value={p}>{p}</option>)}</select>}</Field>
              <Button size="sm" disabled={!reason} onClick={() => run('transferLot', lot.id, qty ? base : 'all', toPool, reason, idemKey('xfer'))}>{qty ? 'Transfer quantity' : 'Transfer whole lot'}</Button>
            </div>
          )}
          <p className="text-xs text-ink-mute">Transfers keep the lot's dates, cost, and history. Cooking, freezing, or mixing never makes blocked stock usable.</p>
        </div>

        <div>
          <div className="label">Movement history</div>
          <ul className="space-y-1 text-xs">
            {movements.map((m) => (
              <li key={m.id} className="flex justify-between gap-2 border-b border-paper-line py-1">
                <span>{m.at.slice(0, 16).replace('T', ' ')} · {m.type.replace('_', ' ')} · {m.reason}{m.fromPool ? ` (${m.fromPool}→${m.toPool})` : ''}</span>
                <span className="tabular-nums">{m.delta ? `${m.delta > 0 ? '+' : ''}${formatBase(m.delta, ing.dimension)}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Drawer>
  );
}

export function exportLotsCsv(state: ReturnType<typeof useApp>['state']) {
  const rows = state.lots.map((l) => [state.ingredients.find((i) => i.id === l.ingredientId)?.name, l.form, l.quantity, 'base', l.pool, l.useByDate, l.qualityDate, l.lotRef, l.status]);
  downloadText('inventory.csv', toCsv(['ingredient', 'form', 'quantity', 'unit', 'pool', 'use_by', 'quality_date', 'lot_ref', 'status'], rows));
}
