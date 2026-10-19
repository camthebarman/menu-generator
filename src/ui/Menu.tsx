import { useMemo, useState } from 'react';
import { currentVersion } from '../domain/catalog';
import { parseCsv } from '../domain/csv';
import { previewMenuImport } from '../domain/imports';
import { buildStockView } from '../domain/stock';
import type { Form, MenuItem, UnitCode } from '../domain/types';
import { formatBase, formatShortfall, UNITS } from '../domain/units';
import { Button, Empty, Field, Notice, Section, cx } from './components';
import { useApp } from './store';

export function Menu() {
  const { state, workspace, run, today, catalog, toast } = useApp();
  const items = state.menuItems.filter((m) => m.workspace === workspace);
  const view = useMemo(() => buildStockView(state, { workspace, plannedDate: today, protectMenu: true, catalog }), [state, workspace, today, catalog]);
  const outcome = view.protection.outcomes[workspace];
  const recipes = state.recipes.filter((r) => r.workspaces.includes(workspace) && !r.archived);
  const [draft, setDraft] = useState<Omit<MenuItem, 'id' | 'orgId'>>({ workspace, name: '', recipeId: null, recipeVersionId: null, mappingStatus: 'confirmed', expectedPortions: null, salePrice: null, active: true });
  const [prot, setProt] = useState<{ ingredientId: string; form: Form; quantity: string; unit: UnitCode; note: string }>({ ingredientId: '', form: 'raw', quantity: '', unit: 'g', note: '' });
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const menuPreview = useMemo(() => (csv ? previewMenuImport(state, parseCsv(csv.text).rows, workspace) : []), [csv, state, workspace]);
  const wsReasons = view.protection.reasons.filter((r) => r.toLowerCase().startsWith(workspace === 'food' ? 'food' : 'bar') || items.some((i) => r.includes(`"${i.name}"`)));

  const protectedRows = outcome ? [...outcome.keys.values()].filter((k) => k.requiredMicro > 0) : [];

  return (
    <div className="space-y-6">
      {wsReasons.length > 0 ? (
        <Notice tone="warn" title="Current menu protection incomplete">
          <ul className="ml-4 list-disc">{wsReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          Protection only covers confirmed mappings with expected portions or explicit protected quantities.
        </Notice>
      ) : (
        <Notice tone="ok">Current menu protection is complete for confirmed items. It is a soft hold: specials avoid this stock unless you relax protection.</Notice>
      )}

      <Section title={`${workspace === 'food' ? 'Food' : 'Bar'} current menu`} description="Link each item to a recipe version and enter expected portions. Without sales data, no forecast is invented.">
        {items.length === 0 ? <Empty title="No menu items yet" /> : (
          <div className="card overflow-x-auto p-2">
            <table className="table-base">
              <thead><tr><th>Item</th><th>Recipe mapping</th><th>Expected portions</th><th>Price</th><th>Active</th><th /></tr></thead>
              <tbody>
                {items.map((m) => {
                  const r = m.recipeId ? catalog.recipes.get(m.recipeId) : undefined;
                  const v = r && m.recipeVersionId ? catalog.versions.get(m.recipeVersionId)?.version : undefined;
                  const newer = r && v && r.currentVersionId !== v.id;
                  return (
                    <tr key={m.id}>
                      <td className="font-medium">{m.name}</td>
                      <td>
                        <select aria-label={`Recipe for ${m.name}`} className="input" value={m.recipeId ?? ''} onChange={(e) => {
                          const rec = catalog.recipes.get(e.target.value);
                          run('upsertMenuItem', { ...m, recipeId: rec?.id ?? null, recipeVersionId: rec ? currentVersion(rec).id : null, mappingStatus: rec ? 'unverified' : 'missing' });
                        }}>
                          <option value="">— not mapped —</option>
                          {recipes.map((rr) => <option key={rr.id} value={rr.id}>{rr.name}</option>)}
                        </select>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <span className={cx('chip', m.mappingStatus === 'confirmed' ? 'border-ok/30 bg-ok-soft text-ok' : m.mappingStatus === 'unverified' ? 'border-warn/30 bg-warn-soft text-warn' : 'border-block/30 bg-block-soft text-block')}>{m.mappingStatus}</span>
                          {v && <span className="text-ink-mute">v{v.version}</span>}
                          {newer && <button className="underline" onClick={() => run('upsertMenuItem', { ...m, recipeVersionId: r!.currentVersionId, mappingStatus: 'unverified' })}>Newer version available — switch</button>}
                          {m.mappingStatus === 'unverified' && m.recipeId && <Button size="sm" onClick={() => run('upsertMenuItem', { ...m, mappingStatus: 'confirmed' })}>Confirm mapping</Button>}
                        </div>
                      </td>
                      <td>
                        <input aria-label={`Expected portions for ${m.name}`} type="number" min={0} className="input w-28" defaultValue={m.expectedPortions ?? ''} onBlur={(e) => {
                          const v2 = e.target.value === '' ? null : Number(e.target.value);
                          if (v2 !== m.expectedPortions) run('upsertMenuItem', { ...m, expectedPortions: v2 });
                        }} />
                      </td>
                      <td className="tabular-nums">{m.salePrice ?? '—'}</td>
                      <td><input type="checkbox" aria-label={`${m.name} active`} checked={m.active} onChange={(e) => run('upsertMenuItem', { ...m, active: e.target.checked })} /></td>
                      <td><Button size="sm" variant="ghost" onClick={() => run('deleteMenuItem', m.id)}>Remove</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card grid gap-3 p-3 sm:grid-cols-5">
          <Field label="New item">{(id) => <input id={id} className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
          <Field label="Recipe" className="sm:col-span-2">{(id) => (
            <select id={id} className="input" value={draft.recipeId ?? ''} onChange={(e) => setDraft({ ...draft, recipeId: e.target.value || null })}>
              <option value="">— not mapped —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}</Field>
          <Field label="Expected portions">{(id) => <input id={id} type="number" min={0} className="input" value={draft.expectedPortions ?? ''} onChange={(e) => setDraft({ ...draft, expectedPortions: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={!draft.name.trim()} onClick={async () => {
              const r = draft.recipeId ? catalog.recipes.get(draft.recipeId) : null;
              const ok = await run('upsertMenuItem', { ...draft, workspace, recipeVersionId: r ? currentVersion(r).id : null, mappingStatus: r ? 'confirmed' : 'missing' });
              if (ok) setDraft({ ...draft, name: '', recipeId: null, expectedPortions: null });
            }}>Add item</Button>
          </div>
        </div>
      </Section>

      <Section title="Protected stock" description="What the current menu is holding, computed from confirmed mappings × expected portions plus explicit protections. Menu reservations are not double-counted.">
        <div className="card overflow-x-auto p-2">
          <table className="table-base">
            <thead><tr><th>Ingredient</th><th className="text-right">Menu needs</th><th className="text-right">Held from stock</th><th className="text-right">Not covered</th></tr></thead>
            <tbody>
              {protectedRows.map((k) => {
                const ing = catalog.ingredients.get(k.ingredientId);
                if (!ing) return null;
                return (
                  <tr key={k.key}>
                    <td>{ing.name}{k.form !== 'raw' && <span className="text-xs text-ink-mute"> ({k.form})</span>}{k.preparedMicro > 0 && <div className="text-xs text-ink-mute">rest would be prepared from raw</div>}</td>
                    <td className="text-right tabular-nums">{formatBase(k.requiredMicro / 1e6, ing.dimension)}</td>
                    <td className="text-right tabular-nums">{formatBase(k.allocatedMicro / 1e6, ing.dimension)}</td>
                    <td className={cx('text-right tabular-nums', k.shortfallMicro > 0 && 'font-semibold text-warn')}>{k.shortfallMicro > 0 ? formatShortfall(k.shortfallMicro / 1e6, ing.dimension) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {protectedRows.length === 0 && <Empty title="Nothing protected yet" />}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Explicit protected quantities</h3>
          {state.protections.filter((p) => p.workspace === workspace).map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-sm">
              <span>{catalog.ingredients.get(p.ingredientId)?.name} ({p.form}): {p.quantity} {UNITS[p.unit].label}{p.note ? ` — ${p.note}` : ''}</span>
              <Button size="sm" variant="ghost" onClick={() => run('deleteProtection', p.id)}>Remove</Button>
            </div>
          ))}
          <div className="card grid gap-2 p-3 sm:grid-cols-6">
            <Field label="Ingredient" className="sm:col-span-2">{(id) => (
              <select id={id} className="input" value={prot.ingredientId} onChange={(e) => { const i = catalog.ingredients.get(e.target.value); setProt({ ...prot, ingredientId: e.target.value, unit: i?.dimension === 'volume' ? 'ml' : i?.dimension === 'count' ? 'each' : 'g' }); }}>
                <option value="">Choose…</option>
                {state.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            )}</Field>
            <Field label="Form">{(id) => <select id={id} className="input" value={prot.form} onChange={(e) => setProt({ ...prot, form: e.target.value as Form })}><option>raw</option><option>cooked</option><option>prepared</option></select>}</Field>
            <Field label="Quantity">{(id) => <input id={id} type="number" min={0} className="input" value={prot.quantity} onChange={(e) => setProt({ ...prot, quantity: e.target.value })} />}</Field>
            <Field label="Unit">{(id) => <select id={id} className="input" value={prot.unit} onChange={(e) => setProt({ ...prot, unit: e.target.value as UnitCode })}>{(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'each', 'bottle'] as UnitCode[]).map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}</select>}</Field>
            <div className="flex items-end"><Button disabled={!prot.ingredientId || !(Number(prot.quantity) > 0)} onClick={async () => {
              const ok = await run('upsertProtection', { workspace, ingredientId: prot.ingredientId, form: prot.form, quantity: Number(prot.quantity), unit: prot.unit, note: prot.note || null });
              if (ok) setProt({ ...prot, quantity: '', note: '' });
            }}>Protect</Button></div>
          </div>
        </div>
      </Section>

      <Section title="Import menu CSV" description="Columns: name, recipe, expected_portions, sale_price, workspace. Name-matched recipes import as unverified until confirmed."
        actions={<a className="inline-flex min-h-[2.25rem] items-center rounded-lg border border-paper-line bg-white px-3 text-sm font-medium" href={`${import.meta.env.BASE_URL}templates/menu-example.csv`} download>Example CSV</a>}>
        <input type="file" accept=".csv" aria-label="Choose menu CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv({ name: f.name, text: await f.text() }); }} />
        {menuPreview.length > 0 && (
          <div className="card p-2">
            <ul className="text-sm">{menuPreview.map((p) => <li key={p.index}>{p.name} → {p.recipeId ? catalog.recipes.get(p.recipeId)?.name : <span className="text-block">no recipe match ({p.recipeText || 'blank'})</span>} {p.errors.length ? <span className="text-block">{p.errors.join(', ')}</span> : null}</li>)}</ul>
            <Button className="mt-2" variant="primary" disabled={menuPreview.some((p) => p.errors.length)} onClick={async () => { const r = await run('commitMenuImport', menuPreview, csv!.name, csv!.text); if (r) { toast('ok', `Imported ${r.created} item(s); confirm mappings to complete protection.`); setCsv(null); } }}>Commit menu import</Button>
          </div>
        )}
      </Section>
    </div>
  );
}
