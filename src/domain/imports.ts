// CSV/JSON import: mapping, validation, preview, and idempotent all-or-nothing commit.

import { contentHash, MAX_IMPORT_ROWS } from './csv';
import { isLocalDate } from './dates';
import { newId } from './factory';
import { OpError, receiveLot, saveRecipe, upsertMenuItem, validateLotInput, type LotInput, type OpCtx, type OpResult, type RecipeDraft } from './ops';
import type { AppState, Form, Ingredient, LotStatus, Pool, RecipeCategory, StorageState, UnitCode, Workspace } from './types';
import { BAR_CATEGORIES, FOOD_CATEGORIES, FORMS, POOLS } from './types';
import { isUnitCode, normalizeUnitText } from './units';

// ------------------------------------------------------------------ ingredient mapping

export interface MappingResult {
  ingredientId: string | null;
  method: 'exact' | 'alias' | 'override' | 'none';
  suggestions: { ingredientId: string; name: string; score: number }[];
}

export const normalizeName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function similarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(' '));
  const tb = new Set(normalizeName(b).split(' '));
  let inter = 0;
  ta.forEach((t) => tb.has(t) && inter++);
  const jacc = inter / Math.max(1, new Set([...ta, ...tb]).size);
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const contains = na.includes(nb) || nb.includes(na) ? 0.3 : 0;
  return Math.min(1, jacc + contains);
}

/** Exact names and confirmed aliases normalize; fuzzy matches are only suggestions. */
export function mapIngredient(raw: string, ingredients: Ingredient[], overrides: Record<string, string> = {}): MappingResult {
  const n = normalizeName(raw);
  if (overrides[n]) return { ingredientId: overrides[n], method: 'override', suggestions: [] };
  const exact = ingredients.find((i) => normalizeName(i.name) === n);
  if (exact) return { ingredientId: exact.id, method: 'exact', suggestions: [] };
  const alias = ingredients.find((i) => i.aliases.some((a) => a.confirmed && normalizeName(a.text) === n));
  if (alias) return { ingredientId: alias.id, method: 'alias', suggestions: [] };
  const suggestions = ingredients
    .map((i) => ({ ingredientId: i.id, name: i.name, score: Math.max(similarity(raw, i.name), ...i.aliases.map((a) => similarity(raw, a.text) * (a.confirmed ? 1 : 0.8))) }))
    .filter((s) => s.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { ingredientId: null, method: 'none', suggestions };
}

// ------------------------------------------------------------------ inventory

export const INVENTORY_COLUMNS = [
  'ingredient', 'form', 'quantity', 'unit', 'package_size', 'package_unit', 'pool', 'storage', 'location', 'received_at', 'opened_on', 'prepared_on',
  'quality_date', 'sell_by', 'use_by', 'expiration', 'operational_discard', 'hard_discard', 'label_wording', 'date_verified', 'cost', 'cost_per_qty',
  'cost_unit', 'supplier', 'lot_ref', 'brand', 'status', 'notes',
] as const;

export type InventoryField = (typeof INVENTORY_COLUMNS)[number];

export function guessColumnMapping(headers: string[], fields: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    const h = headers.find((x) => normalizeName(x).replace(/ /g, '_') === f) ?? headers.find((x) => normalizeName(x).replace(/ /g, '_').includes(f)) ?? null;
    out[f] = h;
  }
  return out;
}

export interface InventoryPreviewRow {
  index: number;
  raw: Record<string, string>;
  ingredientText: string;
  mapping: MappingResult;
  input: LotInput | null;
  errors: string[];
  warnings: string[];
  duplicateOf: string | null;
  status: 'ready' | 'needs_mapping' | 'error' | 'duplicate';
}

export function previewInventoryImport(
  state: AppState,
  rows: Record<string, string>[],
  columnMap: Record<string, string | null>,
  overrides: Record<string, string>,
): InventoryPreviewRow[] {
  const get = (r: Record<string, string>, f: InventoryField) => {
    const col = columnMap[f];
    return col ? (r[col] ?? '').trim() : '';
  };
  const seen = new Map<string, number>();
  return rows.slice(0, MAX_IMPORT_ROWS).map((raw, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const ingredientText = get(raw, 'ingredient');
    const mapping = ingredientText ? mapIngredient(ingredientText, state.ingredients, overrides) : { ingredientId: null, method: 'none' as const, suggestions: [] };
    if (!ingredientText) errors.push('Ingredient is required');
    const qtyText = get(raw, 'quantity');
    const quantity = qtyText === '' || /^unknown$/i.test(qtyText) ? null : Number(qtyText);
    if (quantity === null) warnings.push('Quantity unknown — lot will need review before use');
    else if (!Number.isFinite(quantity) || quantity < 0) errors.push(`Invalid quantity "${qtyText}"`);
    const unitText = get(raw, 'unit') || 'each';
    const unit = normalizeUnitText(unitText);
    if (!unit) errors.push(`Unknown unit "${unitText}"`);
    const pool = (get(raw, 'pool') || '').toLowerCase() as Pool;
    if (!POOLS.includes(pool)) errors.push(`Pool must be food, bar, or shared (got "${get(raw, 'pool')}")`);
    const form = ((get(raw, 'form') || 'raw').toLowerCase() as Form);
    if (!FORMS.includes(form)) errors.push(`Form must be raw, cooked, or prepared`);
    const dateOf = (f: InventoryField) => {
      const v = get(raw, f);
      if (!v) return null;
      if (!isLocalDate(v)) {
        errors.push(`${f} "${v}" must be YYYY-MM-DD`);
        return null;
      }
      return v;
    };
    const pkgSize = get(raw, 'package_size');
    const pkgUnit = normalizeUnitText(get(raw, 'package_unit'));
    let packageSize: LotInput['packageSize'] = null;
    if (pkgSize) {
      if (!pkgUnit || !(Number(pkgSize) > 0)) errors.push('Package size needs a positive number and unit');
      else packageSize = { quantity: Number(pkgSize), unit: pkgUnit };
    }
    const costText = get(raw, 'cost');
    let cost: LotInput['cost'] = null;
    if (costText) {
      const amount = Number(costText.replace(/[$,]/g, ''));
      const perQ = Number(get(raw, 'cost_per_qty') || quantity || 0);
      const perU = normalizeUnitText(get(raw, 'cost_unit') || unitText);
      if (!(amount >= 0) || !(perQ > 0) || !perU) warnings.push('Cost ignored: needs amount, per-quantity, and unit');
      else cost = { amount, perQuantity: perQ, perUnit: perU };
    }
    const receivedText = get(raw, 'received_at');
    let receivedAt: string | undefined;
    if (receivedText) {
      const d = isLocalDate(receivedText) ? new Date(`${receivedText}T12:00:00Z`) : new Date(receivedText);
      if (Number.isNaN(d.getTime())) errors.push(`received_at "${receivedText}" is not a date`);
      else receivedAt = d.toISOString();
    }
    const statusText = (get(raw, 'status') || 'available').toLowerCase().replace(' ', '_') as LotStatus;
    const validStatuses: LotStatus[] = ['available', 'needs_review', 'quarantined', 'spoiled', 'discarded', 'depleted', 'recalled'];
    if (!validStatuses.includes(statusText)) errors.push(`Unknown status "${get(raw, 'status')}"`);
    const storage = (get(raw, 'storage') || 'dry').toLowerCase() as StorageState;
    const verified = /^(y|yes|true|verified|1)$/i.test(get(raw, 'date_verified'));
    const input: LotInput | null = mapping.ingredientId && unit && errors.length === 0
      ? {
          ingredientId: mapping.ingredientId, form, quantity, unit: unit as UnitCode, packageSize, pool, storage: ['dry', 'refrigerated', 'frozen', 'bar_rail', 'other'].includes(storage) ? storage : 'other',
          location: get(raw, 'location') || null, receivedAt, openedOn: dateOf('opened_on'), preparedOn: dateOf('prepared_on'), qualityDate: dateOf('quality_date'),
          sellByDate: dateOf('sell_by'), useByDate: dateOf('use_by'), expirationDate: dateOf('expiration'), operationalDiscardDate: dateOf('operational_discard'),
          hardDiscardDate: dateOf('hard_discard'), labelWording: get(raw, 'label_wording') || null, dateVerification: verified ? 'verified' : 'unverified',
          dateProvenance: 'label', cost, supplier: get(raw, 'supplier') || null, lotRef: get(raw, 'lot_ref') || null, brand: get(raw, 'brand') || null,
          notes: get(raw, 'notes') || null, status: statusText,
        }
      : null;
    if (input) errors.push(...validateLotInput(state, input));
    if (input && !verified && (input.useByDate || input.expirationDate)) warnings.push('Dates not marked verified — perishable lots will need review');
    let duplicateOf: string | null = null;
    if (input) {
      const sig = `${input.ingredientId}|${input.lotRef ?? ''}|${input.receivedAt ?? ''}|${input.quantity}`;
      if (seen.has(sig)) duplicateOf = `row ${seen.get(sig)! + 2}`;
      else seen.set(sig, index);
      if (!duplicateOf && input.lotRef) {
        const ex = state.lots.find((l) => l.ingredientId === input.ingredientId && l.lotRef === input.lotRef);
        if (ex) duplicateOf = `existing lot ${ex.lotRef}`;
      }
    }
    const status: InventoryPreviewRow['status'] = errors.length ? 'error' : !mapping.ingredientId ? 'needs_mapping' : duplicateOf ? 'duplicate' : 'ready';
    return { index, raw, ingredientText, mapping, input, errors, warnings, duplicateOf, status };
  });
}

/** Commits ready rows atomically; re-committing the same file content is a no-op. */
export function commitInventoryImport(state: AppState, ctx: OpCtx, rows: InventoryPreviewRow[], fileName: string, fileText: string, includeDuplicates = false): OpResult<{ importId: string; created: number }> {
  const hash = contentHash(fileText);
  const prior = state.imports.find((i) => i.kind === 'inventory' && i.contentHash === hash);
  if (prior) return { state, result: { importId: prior.id, created: prior.createdIds.length }, replayed: true };
  const blocking = rows.filter((r) => r.status === 'error' || r.status === 'needs_mapping');
  if (blocking.length) throw new OpError('invalid', `${blocking.length} row(s) need fixes or ingredient mapping before commit`);
  let s = state;
  const ids: string[] = [];
  const importId = newId('imp');
  const ictx: OpCtx = { ...ctx, source: 'import' };
  for (const r of rows) {
    if (!r.input || (r.status === 'duplicate' && !includeDuplicates)) continue;
    const out = receiveLot(s, ictx, r.input, `${importId}:${r.index}`, { reason: `Imported from ${fileName} row ${r.index + 2}` });
    s = out.state;
    ids.push(out.result.lotId);
  }
  s = structuredClone(s);
  s.imports.push({ id: importId, orgId: s.org.id, kind: 'inventory', fileName, contentHash: hash, rowCount: rows.length, committedAt: ctx.clock.now().toISOString(), createdIds: ids, actorId: ctx.actor.id });
  return { state: s, result: { importId, created: ids.length } };
}

// ------------------------------------------------------------------ recipes

export interface RecipeImportLine {
  name: string;
  quantity: number | null;
  unit: string;
  form?: string;
  optional?: boolean;
  basis?: 'as_purchased' | 'edible';
}

export interface RecipeImportItem {
  name: string;
  workspaces: string[];
  category: string;
  servings?: number;
  yield?: { quantity: number; unit: string };
  ingredients: RecipeImportLine[];
  method?: string[];
  equipment?: string[];
  activeMinutes?: number | null;
  totalMinutes?: number | null;
  tags?: string[];
  source: string;
  license?: string;
}

export interface RecipeImportPreview {
  item: RecipeImportItem;
  draft: RecipeDraft | null;
  errors: string[];
  warnings: string[];
  unmapped: string[];
}

export function parseRecipeJson(text: string): { items: RecipeImportItem[]; errors: string[] } {
  try {
    const data = JSON.parse(text) as unknown;
    const arr = Array.isArray(data) ? data : (data as { recipes?: unknown }).recipes;
    if (!Array.isArray(arr)) return { items: [], errors: ['Expected an array of recipes or {"recipes": [...]}'] };
    if (arr.length > 500) return { items: [], errors: ['Too many recipes in one import (limit 500)'] };
    return { items: arr as RecipeImportItem[], errors: [] };
  } catch (e) {
    return { items: [], errors: [`Invalid JSON: ${(e as Error).message}`] };
  }
}

/** CSV long format: one row per ingredient line; recipe-level columns repeat. */
export function recipeCsvToItems(rows: Record<string, string>[]): RecipeImportItem[] {
  const by = new Map<string, RecipeImportItem>();
  for (const r of rows) {
    const name = (r.recipe_name ?? '').trim();
    if (!name) continue;
    let item = by.get(name);
    if (!item) {
      item = {
        name, workspaces: (r.workspaces ?? r.workspace ?? '').split(/[|;]/).map((x) => x.trim()).filter(Boolean), category: (r.category ?? '').trim(),
        servings: r.servings ? Number(r.servings) : undefined, yield: r.yield_qty ? { quantity: Number(r.yield_qty), unit: r.yield_unit || 'serving' } : undefined,
        ingredients: [], method: r.method ? r.method.split('|').map((x) => x.trim()).filter(Boolean) : [], equipment: r.equipment ? r.equipment.split('|').map((x) => x.trim()) : [],
        totalMinutes: r.total_minutes ? Number(r.total_minutes) : null, source: (r.source ?? '').trim(), tags: r.tags ? r.tags.split('|') : [],
      };
      by.set(name, item);
    }
    if (r.ingredient) {
      item.ingredients.push({ name: r.ingredient, quantity: r.quantity === undefined || r.quantity === '' ? null : Number(r.quantity), unit: r.unit || 'each', form: r.form || 'raw', optional: /^(y|yes|true|1)$/i.test(r.optional ?? '') });
    }
  }
  return [...by.values()];
}

export function previewRecipeImport(state: AppState, items: RecipeImportItem[], overrides: Record<string, string>): RecipeImportPreview[] {
  return items.map((item) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const unmapped: string[] = [];
    if (!item.name?.trim()) errors.push('Recipe name required');
    if (!item.source?.trim()) errors.push('Source is required for imported recipes (provenance)');
    const ws = (item.workspaces ?? []).filter((w): w is Workspace => w === 'food' || w === 'bar');
    if (ws.length === 0) errors.push('Workspace must include food and/or bar');
    const cat = item.category as RecipeCategory;
    if (![...FOOD_CATEGORIES, ...BAR_CATEGORIES].includes(cat)) errors.push(`Unknown category "${item.category}"`);
    if (!Array.isArray(item.ingredients) || item.ingredients.length === 0) errors.push('No ingredients listed — a menu description is not a recipe');
    const lines = (item.ingredients ?? []).slice(0, 100).map((l) => {
      const m = mapIngredient(String(l.name ?? ''), state.ingredients, overrides);
      if (!m.ingredientId) unmapped.push(String(l.name));
      const unit = normalizeUnitText(String(l.unit ?? '')) ?? (isUnitCode(String(l.unit)) ? (l.unit as UnitCode) : null);
      if (!unit) errors.push(`Unknown unit "${l.unit}" for ${l.name}`);
      const q = l.quantity === null || l.quantity === undefined || Number.isNaN(Number(l.quantity)) ? null : Number(l.quantity);
      if (q === null) warnings.push(`${l.name}: quantity missing — must be confirmed`);
      return {
        id: newId('ln'), ingredientId: m.ingredientId, rawText: String(l.name ?? ''), form: (FORMS.includes(l.form as Form) ? l.form : 'raw') as Form, quantity: q,
        unit: unit ?? 'each', optional: !!l.optional, basis: l.basis === 'edible' ? 'edible' as const : 'as_purchased' as const,
      };
    });
    if (unmapped.length) warnings.push(`Unmapped ingredients: ${unmapped.join(', ')}`);
    if (!item.yield && !item.servings) warnings.push('Yield and servings missing — defaulted to 1 serving; confirm before use');
    const draft: RecipeDraft | null = errors.length
      ? null
      : {
          name: item.name.trim(), workspaces: ws, category: cat, tags: item.tags ?? [], provenance: { kind: 'imported', source: item.source.trim(), license: item.license ?? null, importedAt: new Date().toISOString() },
          version: {
            lines, yield: item.yield ? { quantity: Number(item.yield.quantity), unit: normalizeUnitText(item.yield.unit) ?? 'serving' } : { quantity: item.servings ?? 1, unit: 'serving' },
            servings: item.servings ?? 1, method: (item.method ?? []).map(String).slice(0, 50), equipment: (item.equipment ?? []).map(String).slice(0, 20),
            activeMinutes: item.activeMinutes ?? null, totalMinutes: item.totalMinutes ?? null, allergenStatus: 'unverified', confirmed: false,
          },
        };
    return { item, draft, errors, warnings, unmapped };
  });
}

export function commitRecipeImport(state: AppState, ctx: OpCtx, previews: RecipeImportPreview[], fileName: string, fileText: string): OpResult<{ importId: string; created: number }> {
  const hash = contentHash(fileText);
  const prior = state.imports.find((i) => i.kind === 'recipes' && i.contentHash === hash);
  if (prior) return { state, result: { importId: prior.id, created: prior.createdIds.length }, replayed: true };
  if (previews.some((p) => !p.draft)) throw new OpError('invalid', 'Fix errors before committing');
  let s = state;
  const ids: string[] = [];
  for (const p of previews) {
    // saveRecipe validation tolerates unmapped lines (ingredientId null); they stay Needs review.
    const out = saveRecipe(s, { ...ctx, source: 'import' }, p.draft!);
    s = out.state;
    ids.push(out.result.recipeId);
  }
  s = structuredClone(s);
  const importId = newId('imp');
  s.imports.push({ id: importId, orgId: s.org.id, kind: 'recipes', fileName, contentHash: hash, rowCount: previews.length, committedAt: ctx.clock.now().toISOString(), createdIds: ids, actorId: ctx.actor.id });
  return { state: s, result: { importId, created: ids.length } };
}

// ------------------------------------------------------------------ menu

export interface MenuImportPreview {
  index: number;
  name: string;
  workspace: Workspace | null;
  recipeId: string | null;
  recipeText: string;
  expectedPortions: number | null;
  salePrice: number | null;
  errors: string[];
}

export function previewMenuImport(state: AppState, rows: Record<string, string>[], workspace: Workspace): MenuImportPreview[] {
  return rows.map((r, index) => {
    const errors: string[] = [];
    const name = (r.name ?? r.item ?? '').trim();
    if (!name) errors.push('Name required');
    const ws = ((r.workspace ?? workspace).trim().toLowerCase() || workspace) as Workspace;
    if (ws !== 'food' && ws !== 'bar') errors.push('Workspace must be food or bar');
    const recipeText = (r.recipe ?? '').trim();
    const recipe = recipeText ? state.recipes.find((x) => normalizeName(x.name) === normalizeName(recipeText) && x.workspaces.includes(ws)) : undefined;
    const ep = r.expected_portions?.trim() ? Number(r.expected_portions) : null;
    if (ep !== null && !(ep >= 0)) errors.push('expected_portions must be a number');
    const sp = r.sale_price?.trim() ? Number(r.sale_price.replace(/[$,]/g, '')) : null;
    return { index, name, workspace: ws === 'food' || ws === 'bar' ? ws : null, recipeId: recipe?.id ?? null, recipeText, expectedPortions: ep, salePrice: sp !== null && Number.isFinite(sp) ? sp : null, errors };
  });
}

export function commitMenuImport(state: AppState, ctx: OpCtx, previews: MenuImportPreview[], fileName: string, fileText: string): OpResult<{ created: number }> {
  const hash = contentHash(fileText);
  if (state.imports.some((i) => i.kind === 'menu' && i.contentHash === hash)) return { state, result: { created: 0 }, replayed: true };
  if (previews.some((p) => p.errors.length)) throw new OpError('invalid', 'Fix errors before committing');
  let s = state;
  const ids: string[] = [];
  for (const p of previews) {
    // Name-matched recipes are imported as unverified: protection is incomplete until a person confirms.
    const out = upsertMenuItem(s, { ...ctx, source: 'import' }, {
      workspace: p.workspace!, name: p.name, recipeId: p.recipeId, recipeVersionId: null, mappingStatus: p.recipeId ? 'unverified' : 'missing',
      expectedPortions: p.expectedPortions, salePrice: p.salePrice, active: true,
    });
    s = out.state;
    ids.push(out.result.id);
  }
  s = structuredClone(s);
  s.imports.push({ id: newId('imp'), orgId: s.org.id, kind: 'menu', fileName, contentHash: hash, rowCount: previews.length, committedAt: ctx.clock.now().toISOString(), createdIds: ids, actorId: ctx.actor.id });
  return { state: s, result: { created: ids.length } };
}
