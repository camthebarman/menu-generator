import { useMemo, useState } from 'react';
import { currentVersion } from '../domain/catalog';
import { parseCsv } from '../domain/csv';
import { newId } from '../domain/factory';
import { normalizeName, parseRecipeJson, previewRecipeImport, recipeCsvToItems, type RecipeImportPreview } from '../domain/imports';
import { match, requestedFor } from '../domain/match';
import type { RecipeDraft } from '../domain/ops';
import { BAR_CATEGORIES, FOOD_CATEGORIES, FORMS, type Form, type Recipe, type RecipeCategory, type RecipeLine, type UnitCode, type Workspace } from '../domain/types';
import { UNIT_CODES, UNITS } from '../domain/units';
import { aiAvailability, requestAiSuggestions, type AiMode, type AiRunResult } from '../data/ai';
import { Button, Drawer, Empty, Field, GroupBadge, Notice, ProvenanceBadge, Section, cx } from './components';
import { CATEGORY_LABEL } from './Discover';
import { MatchDetail } from './MatchDetail';
import { useApp, useHashRoute } from './store';

export function Recipes() {
  const { state, workspace, catalog } = useApp();
  const [q, setQ] = useState('');
  const [prov, setProv] = useState<string>('all');
  const [cat, setCat] = useState<RecipeCategory | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ recipe: Recipe | null } | null>(null);
  const [panel, setPanel] = useState<'library' | 'import' | 'ai'>('library');
  const list = [...catalog.recipes.values()]
    .filter((r) => r.workspaces.includes(workspace) && !r.archived)
    .filter((r) => prov === 'all' || r.provenance.kind === prov)
    .filter((r) => cat === 'all' || r.category === cat)
    .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()) || r.tags.some((t) => t.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cats = workspace === 'food' ? FOOD_CATEGORIES : BAR_CATEGORIES;
  const selected = open ? catalog.recipes.get(open) : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        {(['library', 'import', 'ai'] as const).map((p) => (
          <button key={p} role="tab" aria-selected={panel === p} onClick={() => setPanel(p)} className={cx('rounded-lg border px-3 py-2 text-sm font-medium', panel === p ? 'border-ink bg-ink text-white' : 'border-paper-line bg-white')}>
            {p === 'library' ? 'Library' : p === 'import' ? 'Import' : 'AI assist (optional)'}
          </button>
        ))}
        <Button variant="primary" className="ml-auto" onClick={() => setEditing({ recipe: null })}>New house recipe</Button>
      </div>
      {panel === 'library' && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search">{(id) => <input id={id} className="input" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
            <Field label="Category">{(id) => <select id={id} className="input" value={cat} onChange={(e) => setCat(e.target.value as RecipeCategory)}><option value="all">All</option>{cats.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>}</Field>
            <Field label="Provenance">{(id) => <select id={id} className="input" value={prov} onChange={(e) => setProv(e.target.value)}><option value="all">All</option><option value="house">House</option><option value="starter">Starter</option><option value="imported">Imported</option><option value="ai_draft">AI draft</option></select>}</Field>
            <span className="pb-2 text-sm text-ink-mute">{list.length} recipes</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((r) => {
              const v = currentVersion(r);
              return (
                <button key={r.id} onClick={() => setOpen(r.id)} className="card p-3 text-left hover:border-ink-mute">
                  <div className="flex items-start justify-between gap-2"><span className="font-serif font-semibold">{r.name}</span><ProvenanceBadge p={r.provenance} /></div>
                  <div className="text-xs text-ink-mute">{CATEGORY_LABEL[r.category]} · v{v.version} · {v.lines.length} ingredients{v.totalMinutes !== null ? ` · ${v.totalMinutes} min` : ''}{r.produces ? ' · component' : ''}</div>
                  {!v.confirmed && <div className="mt-1 text-xs text-review">Unconfirmed — needs review before use</div>}
                </button>
              );
            })}
          </div>
          {list.length === 0 && <Empty title="No recipes match" />}
        </>
      )}
      {panel === 'import' && <RecipeImport />}
      {panel === 'ai' && <AiPanel />}
      <Drawer open={!!selected} onClose={() => setOpen(null)} title={selected?.name ?? ''} wide>
        {selected && <RecipeView recipe={selected} onEdit={() => { setEditing({ recipe: selected }); setOpen(null); }} />}
      </Drawer>
      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.recipe ? (editing.recipe.orgId ? `New version of ${editing.recipe.name}` : `House copy of ${editing.recipe.name}`) : 'New house recipe'} wide>
        {editing && <RecipeEditor recipe={editing.recipe} onSaved={(id) => { setEditing(null); setOpen(id); }} />}
      </Drawer>
      {state.recipes.length === 0 && <Empty title="No recipes" />}
    </div>
  );
}

function RecipeView({ recipe, onEdit }: { recipe: Recipe; onEdit: () => void }) {
  const { state, workspace, today, run, catalog } = useApp();
  const [versionId, setVersionId] = useState(recipe.currentVersionId);
  const v = recipe.versions.find((x) => x.id === versionId) ?? currentVersion(recipe);
  const [n, setN] = useState(workspace === 'bar' ? 2 : 4);
  const req = useMemo(() => ({
    workspace, plannedDate: today, protectMenu: true,
    targets: [{ recipeId: recipe.id, versionId: v.id, requested: recipe.produces ? requestedFor(recipe, v, { servings: n, batches: n, mode: 'component' }) : { kind: 'servings' as const, servings: n }, prepareOutput: !!recipe.produces }],
  }), [workspace, today, recipe, v, n]);
  const m = useMemo(() => match({ ...state, recipes: state.recipes.map((r) => (r.id === recipe.id ? { ...r, currentVersionId: v.id } : r)) }, req), [state, req, recipe.id, v.id]);
  const canConfirm = recipe.orgId !== null && !v.confirmed;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge p={recipe.provenance} />
        {recipe.provenance.source && <span className="text-xs text-ink-mute">Source: {recipe.provenance.source}{recipe.provenance.license ? ` · ${recipe.provenance.license}` : ''}</span>}
        <select aria-label="Version" className="input ml-auto w-36" value={v.id} onChange={(e) => setVersionId(e.target.value)}>
          {recipe.versions.map((x) => <option key={x.id} value={x.id}>v{x.version}{x.id === recipe.currentVersionId ? ' (current)' : ''}</option>)}
        </select>
      </div>
      {!v.confirmed && (
        <Notice tone="review" title={recipe.provenance.kind === 'ai_draft' ? 'AI draft — review required' : 'Imported — confirmation required'}>
          Confirm every ingredient is mapped, quantities and yield are correct, and nothing was omitted. Until then it stays in Needs review and cannot be reserved or used for menu protection.
          {canConfirm && <div className="mt-2"><Button size="sm" onClick={() => run('confirmRecipeVersion', recipe.id, v.id, 'Reviewed ingredients, quantities, yield, and omissions')}>I reviewed it — confirm v{v.version}</Button></div>}
        </Notice>
      )}
      <div className="card p-3">
        <h3 className="text-base font-semibold">Ingredients (v{v.version}) · yields {v.yield.quantity} {UNITS[v.yield.unit].label} · {v.servings} servings</h3>
        <ul className="mt-1 space-y-0.5 text-sm">
          {v.lines.map((l) => (
            <li key={l.id}>
              {l.quantity ?? '?'} {UNITS[l.unit].label} {l.ingredientId ? catalog.ingredients.get(l.ingredientId)?.name : <span className="text-review">"{l.rawText}" (unmapped)</span>}
              {l.form !== 'raw' && <span className="text-ink-mute"> ({l.form})</span>}{l.optional && <span className="text-ink-mute"> — optional</span>}{l.basis === 'edible' && <span className="text-ink-mute"> — trimmed weight</span>}
              {l.ingredientId && state.recipes.some((r) => r.produces?.ingredientId === l.ingredientId && r.produces.form === l.form) && <span className="text-xs text-ink-mute"> · house component</span>}
            </li>
          ))}
        </ul>
        {recipe.produces && <p className="mt-1 text-xs text-ink-mute">Produces {catalog.ingredients.get(recipe.produces.ingredientId)?.name} ({recipe.produces.form}) as a prep component.</p>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={recipe.produces ? 'Batches to check' : 'Portions to check'}>{(id) => <input id={id} type="number" min={1} className="input w-28" value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} />}</Field>
        <GroupBadge group={m.group} />
        <div className="ml-auto flex gap-2">
          <Button onClick={onEdit}>{recipe.orgId ? 'Edit (new version)' : 'Copy to house recipe'}</Button>
          {recipe.orgId && <Button variant="ghost" onClick={() => run('archiveRecipe', recipe.id, true)}>Archive</Button>}
        </div>
      </div>
      <MatchDetail m={m} req={req} />
    </div>
  );
}

type EditLine = RecipeLine;

function RecipeEditor({ recipe, onSaved }: { recipe: Recipe | null; onSaved: (id: string) => void }) {
  const { state, workspace, run, catalog } = useApp();
  const base = recipe ? currentVersion(recipe) : null;
  const [name, setName] = useState(recipe?.name ?? '');
  const [workspaces, setWorkspaces] = useState<Workspace[]>(recipe?.workspaces ?? [workspace]);
  const [category, setCategory] = useState<RecipeCategory>(recipe?.category ?? (workspace === 'food' ? 'special' : 'cocktail'));
  const [tags, setTags] = useState((recipe?.tags ?? []).join(', '));
  const [produces, setProduces] = useState<{ ingredientId: string; form: Form } | null>(recipe?.produces ?? null);
  const [servings, setServings] = useState(base?.servings ?? 1);
  const [yieldQ, setYieldQ] = useState(base?.yield.quantity ?? 1);
  const [yieldU, setYieldU] = useState<UnitCode>(base?.yield.unit ?? 'serving');
  const [active, setActive] = useState<number | null>(base?.activeMinutes ?? null);
  const [total, setTotal] = useState<number | null>(base?.totalMinutes ?? null);
  const [equipment, setEquipment] = useState((base?.equipment ?? []).join(', '));
  const [method, setMethod] = useState((base?.method ?? []).join('\n'));
  const [lines, setLines] = useState<EditLine[]>(base ? base.lines.map((l) => ({ ...l, id: newId('ln') })) : [{ id: newId('ln'), ingredientId: null, form: 'raw', quantity: null, unit: 'g', optional: false, basis: 'as_purchased' }]);
  const [allergenVerified, setAllergenVerified] = useState(base?.allergenStatus === 'verified');
  const setLine = (i: number, p: Partial<EditLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const cats = [...(workspaces.includes('food') ? FOOD_CATEGORIES : []), ...(workspaces.includes('bar') ? BAR_CATEGORIES : [])];
  const save = async () => {
    const draft: RecipeDraft = {
      name, workspaces, category, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), produces,
      version: {
        lines, yield: { quantity: yieldQ, unit: yieldU }, servings, method: method.split('\n').map((s) => s.trim()).filter(Boolean),
        equipment: equipment.split(',').map((s) => s.trim()).filter(Boolean), activeMinutes: active, totalMinutes: total, allergenStatus: allergenVerified ? 'verified' : 'unverified',
        // Imported and AI content always needs an explicit human confirmation step.
        confirmed: recipe?.provenance.kind !== 'imported' && recipe?.provenance.kind !== 'ai_draft' && lines.every((l) => l.optional || (l.ingredientId && l.quantity !== null)),
      },
    };
    const res = await run('saveRecipe', draft, recipe?.id);
    if (res) onSaved(res.recipeId);
  };
  return (
    <div className="space-y-4">
      {recipe && !recipe.orgId && <Notice>Starter recipes are read-only. Saving creates a House recipe that records it was adapted from "{recipe.name}".</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div>
          <div className="label">Workspaces</div>
          <div className="flex gap-3 pt-2 text-sm">
            {(['food', 'bar'] as Workspace[]).map((w) => <label key={w} className="flex items-center gap-1"><input type="checkbox" checked={workspaces.includes(w)} onChange={(e) => setWorkspaces(e.target.checked ? [...workspaces, w] : workspaces.filter((x) => x !== w))} />{w}</label>)}
          </div>
        </div>
        <Field label="Category">{(id) => <select id={id} className="input" value={category} onChange={(e) => setCategory(e.target.value as RecipeCategory)}>{cats.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>}</Field>
        <Field label="Tags (comma separated)">{(id) => <input id={id} className="input" value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
        <Field label="Produces stock component (optional)">{(id) => (
          <select id={id} className="input" value={produces?.ingredientId ?? ''} onChange={(e) => setProduces(e.target.value ? { ingredientId: e.target.value, form: produces?.form ?? 'prepared' } : null)}>
            <option value="">No — finished dish/drink</option>
            {state.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}</Field>
        <Field label="Servings">{(id) => <input id={id} type="number" min={0.01} step="any" className="input" value={servings} onChange={(e) => setServings(Number(e.target.value))} />}</Field>
        <Field label="Yield">{(id) => (
          <div className="flex gap-2"><input id={id} type="number" min={0.01} step="any" className="input" value={yieldQ} onChange={(e) => setYieldQ(Number(e.target.value))} />
            <select aria-label="Yield unit" className="input w-28" value={yieldU} onChange={(e) => setYieldU(e.target.value as UnitCode)}>{UNIT_CODES.map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}</select></div>
        )}</Field>
        <Field label="Active / total minutes">{(id) => (
          <div className="flex gap-2"><input id={id} type="number" min={0} className="input" value={active ?? ''} onChange={(e) => setActive(e.target.value ? Number(e.target.value) : null)} /><input aria-label="Total minutes" type="number" min={0} className="input" value={total ?? ''} onChange={(e) => setTotal(e.target.value ? Number(e.target.value) : null)} /></div>
        )}</Field>
        <Field label="Equipment (comma separated)" className="sm:col-span-2">{(id) => <input id={id} className="input" value={equipment} onChange={(e) => setEquipment(e.target.value)} />}</Field>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={allergenVerified} onChange={(e) => setAllergenVerified(e.target.checked)} /> Allergen info verified</label>
      </div>
      <div>
        <h3 className="mb-2 text-base font-semibold">Ingredients</h3>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={l.id} className="grid grid-cols-2 gap-2 rounded-lg border border-paper-line bg-white p-2 sm:grid-cols-7">
              <select aria-label={`Ingredient ${i + 1}`} className="input sm:col-span-2" value={l.ingredientId ?? ''} onChange={(e) => setLine(i, { ingredientId: e.target.value || null })}>
                <option value="">{l.rawText ? `Unmapped: ${l.rawText}` : 'Choose ingredient…'}</option>
                {[...catalog.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select aria-label={`Form ${i + 1}`} className="input" value={l.form} onChange={(e) => setLine(i, { form: e.target.value as Form })}>{FORMS.map((f) => <option key={f}>{f}</option>)}</select>
              <input aria-label={`Quantity ${i + 1}`} type="number" min={0} step="any" className="input" value={l.quantity ?? ''} placeholder="qty" onChange={(e) => setLine(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
              <select aria-label={`Unit ${i + 1}`} className="input" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value as UnitCode })}>{UNIT_CODES.filter((u) => u !== 'serving').map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}</select>
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" checked={l.optional} onChange={(e) => setLine(i, { optional: e.target.checked })} />optional</label>
                <label className="flex items-center gap-1" title="Quantity is trimmed (edible) weight; needs an edible-yield factor"><input type="checkbox" checked={l.basis === 'edible'} onChange={(e) => setLine(i, { basis: e.target.checked ? 'edible' : 'as_purchased' })} />trimmed</label>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setLines((ls) => [...ls, { id: newId('ln'), ingredientId: null, form: 'raw', quantity: null, unit: 'g', optional: false, basis: 'as_purchased' }])}>Add ingredient</Button>
        </div>
      </div>
      <Field label="Method (one step per line)">{(id) => <textarea id={id} rows={5} className="input" value={method} onChange={(e) => setMethod(e.target.value)} />}</Field>
      <Button variant="primary" onClick={save} disabled={!name.trim() || workspaces.length === 0}>Save {recipe?.orgId ? 'new version' : 'recipe'}</Button>
      <p className="text-xs text-ink-mute">Versions are immutable; plans and menu items keep pointing at the version they were built on and show a stale warning when a newer version exists.</p>
    </div>
  );
}

function RecipeImport() {
  const { state, run, toast } = useApp();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const parsed = useMemo(() => {
    if (!file) return null;
    if (file.name.toLowerCase().endsWith('.json')) return parseRecipeJson(file.text);
    const csv = parseCsv(file.text);
    return { items: recipeCsvToItems(csv.rows), errors: csv.errors };
  }, [file]);
  const previews: RecipeImportPreview[] = useMemo(() => (parsed ? previewRecipeImport(state, parsed.items, overrides) : []), [parsed, state, overrides]);
  const unmapped = [...new Set(previews.flatMap((p) => p.unmapped))];
  return (
    <Section title="Import recipes" description="Structured JSON or CSV only — no scraping. Imports are labeled with their source and stay unconfirmed (Needs review) until a person checks ingredients, quantities, yield, and omissions."
      actions={<>
        <a className="inline-flex min-h-[2.25rem] items-center rounded-lg border border-paper-line bg-white px-3 text-sm font-medium" href={`${import.meta.env.BASE_URL}templates/recipes-example.json`} download>Example JSON</a>
        <a className="inline-flex min-h-[2.25rem] items-center rounded-lg border border-paper-line bg-white px-3 text-sm font-medium" href={`${import.meta.env.BASE_URL}templates/recipes-example.csv`} download>Example CSV</a>
      </>}>
      <input type="file" accept=".json,.csv" aria-label="Choose recipe file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFile({ name: f.name, text: await f.text() }); setOverrides({}); } }} />
      {parsed?.errors.length ? <Notice tone="block">{parsed.errors.join(' · ')}</Notice> : null}
      {unmapped.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Map ingredients (leave unmapped to keep as Needs review)</h3>
          {unmapped.map((u) => (
            <div key={u} className="flex items-center gap-2 text-sm">"{u}" →
              <select aria-label={`Map ${u}`} className="input max-w-xs" value={overrides[normalizeName(u)] ?? ''} onChange={(e) => setOverrides((o) => ({ ...o, [normalizeName(u)]: e.target.value }))}>
                <option value="">Leave unmapped</option>
                {state.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      {previews.map((p, i) => (
        <div key={i} className="card p-3 text-sm">
          <div className="font-semibold">{p.item.name}</div>
          {p.errors.map((e) => <div key={e} className="text-block">{e}</div>)}
          {p.warnings.map((e) => <div key={e} className="text-warn">{e}</div>)}
        </div>
      ))}
      {previews.length > 0 && (
        <Button variant="primary" disabled={previews.some((p) => !p.draft)} onClick={async () => {
          const r = await run('commitRecipeImport', previews, file!.name, file!.text);
          if (r) { toast('ok', `Imported ${r.created} recipe(s) as unconfirmed.`); setFile(null); }
        }}>Import {previews.length} recipe(s)</Button>
      )}
    </Section>
  );
}

function AiPanel() {
  const { state, repo, workspace, today, run, toast } = useApp();
  const avail = aiAvailability(repo);
  const [mode, setMode] = useState<AiMode>('special');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<AiRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, nav] = useHashRoute();
  if (!avail.available) {
    return <Notice title="AI assistant not configured">{avail.reason} Every Discover, planning, costing, and inventory feature works without it.</Notice>;
  }
  return (
    <Section title="AI suggestions" description="AI may propose specials or drafts. Every suggestion is validated and recomputed by the deterministic engine; drafts must be reviewed before use and are never reserved automatically.">
      <Notice>Shared with the provider: ingredient names, units, and free quantities for this workspace. Not shared: costs, suppliers, lot references, or staff details.</Notice>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Ask for">{(id) => <select id={id} className="input" value={mode} onChange={(e) => setMode(e.target.value as AiMode)}><option value="make_now">Make now (no new ingredients)</option><option value="special">Special ideas</option><option value="one_two_away">One or two ingredients away</option></select>}</Field>
        <Field label="Notes (optional)" className="min-w-[16rem] flex-1">{(id) => <input id={id} maxLength={500} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. light, autumn, uses the chicken" />}</Field>
        <Button variant="primary" busy={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { setOut(await requestAiSuggestions(repo, state, workspace, today, mode, note)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Ask</Button>
      </div>
      {err && <Notice tone="block" title="AI request failed">{err} — nothing was changed. You can keep working without AI.</Notice>}
      {out && (
        <div className="space-y-3">
          <p className="text-xs text-ink-mute">Model: {out.model}. Rejected suggestions: {out.validation.rejected.length}. Dropped invalid lines: {out.validation.droppedLines.length}.</p>
          {out.reviews.map((r, i) => (
            <div key={i} className="card space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2"><span className="font-serif font-semibold">{r.draft.name}</span><ProvenanceBadge p={r.draft.provenance!} /><GroupBadge group={r.engine.group} /></div>
              {r.discrepancies.length > 0 && <Notice tone="review" title="Engine disagrees with or cannot confirm AI claims"><ul className="ml-4 list-disc">{r.discrepancies.map((d) => <li key={d}>{d}</li>)}</ul></Notice>}
              <Button size="sm" onClick={async () => {
                const res = await run('saveRecipe', r.draft);
                if (res) { toast('ok', 'Saved as an unconfirmed AI draft. Review it in Recipes before planning.'); nav('recipes'); }
              }}>Save as AI draft for review</Button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
