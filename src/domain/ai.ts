// Optional AI assistance. All AI output is untrusted: it is schema-validated here, then every
// availability, shortage, serving, allergen, and cost claim is recomputed by the deterministic engine.
// AI output can never set cutoffs, extend dates, change stock, or reserve anything.

import { newId } from './factory';
import { GROUP_LABEL, match, type MatchGroup, type MatchResult } from './match';
import type { RecipeDraft } from './ops';
import type { AppState, Form, Recipe, RecipeCategory, RecipeLine, UnitCode, Workspace } from './types';
import { BAR_CATEGORIES, FOOD_CATEGORIES, FORMS } from './types';
import { isUnitCode } from './units';

export interface AiSuggestion {
  name: string;
  category: RecipeCategory;
  servings: number;
  yield: { quantity: number; unit: UnitCode };
  ingredients: { ingredientId: string; form: Form; quantity: number; unit: UnitCode; optional: boolean }[];
  method: string[];
  equipment: string[];
  activeMinutes: number | null;
  totalMinutes: number | null;
  rationale: string;
  claimedStatus: 'make_now' | 'need_1' | 'need_2' | null;
  claimedAdditions: string[];
}

export interface AiValidation {
  suggestions: AiSuggestion[];
  rejected: { index: number; errors: string[] }[];
  droppedLines: { suggestion: string; ingredientId: string; reason: string }[];
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null);
const num = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

export function validateAiResponse(raw: unknown, state: AppState, workspace: Workspace): AiValidation {
  const out: AiValidation = { suggestions: [], rejected: [], droppedLines: [] };
  const list = raw && typeof raw === 'object' ? (raw as { suggestions?: unknown }).suggestions : null;
  if (!Array.isArray(list)) {
    out.rejected.push({ index: -1, errors: ['Response did not contain a suggestions array'] });
    return out;
  }
  const allowedCats = workspace === 'food' ? FOOD_CATEGORIES : BAR_CATEGORIES;
  const ingIds = new Set(state.ingredients.map((i) => i.id));
  list.slice(0, 5).forEach((s: unknown, index) => {
    const errors: string[] = [];
    const o = (s ?? {}) as Record<string, unknown>;
    const name = str(o.name, 80);
    if (!name) errors.push('name missing');
    const category = o.category as RecipeCategory;
    if (!allowedCats.includes(category)) errors.push(`category "${String(o.category)}" not valid for ${workspace}`);
    const servings = num(o.servings, 1, 500);
    if (servings === null) errors.push('servings must be 1–500');
    const y = (o.yield ?? {}) as Record<string, unknown>;
    const yq = num(y.quantity, 0.000001, 100000);
    const yu = typeof y.unit === 'string' && isUnitCode(y.unit) ? (y.unit as UnitCode) : null;
    if (yq === null || !yu) errors.push('yield must have a positive quantity and a known unit');
    const ingredients: AiSuggestion['ingredients'] = [];
    if (!Array.isArray(o.ingredients) || o.ingredients.length === 0) errors.push('ingredients missing');
    for (const l of (Array.isArray(o.ingredients) ? o.ingredients : []).slice(0, 30) as Record<string, unknown>[]) {
      const id = typeof l.ingredientId === 'string' ? l.ingredientId : '';
      const q = num(l.quantity, 0.000001, 100000);
      const u = typeof l.unit === 'string' && isUnitCode(l.unit) ? (l.unit as UnitCode) : null;
      const f = FORMS.includes(l.form as Form) ? (l.form as Form) : null;
      if (!ingIds.has(id)) out.droppedLines.push({ suggestion: name ?? `#${index}`, ingredientId: id, reason: 'ingredient id not in catalog' });
      else if (q === null || !u || !f) out.droppedLines.push({ suggestion: name ?? `#${index}`, ingredientId: id, reason: 'quantity/unit/form invalid' });
      else ingredients.push({ ingredientId: id, form: f, quantity: q, unit: u, optional: l.optional === true });
    }
    if (out.droppedLines.some((d) => d.suggestion === (name ?? `#${index}`))) errors.push('one or more ingredient lines were invalid; the draft would be incomplete');
    const method = Array.isArray(o.method) ? o.method.map((m) => str(m, 500)).filter((m): m is string => !!m).slice(0, 20) : [];
    if (method.length === 0) errors.push('method missing');
    const equipment = Array.isArray(o.equipment) ? o.equipment.map((m) => str(m, 40)).filter((m): m is string => !!m).slice(0, 10) : [];
    const claimed = o.claimedStatus === 'make_now' || o.claimedStatus === 'need_1' || o.claimedStatus === 'need_2' ? o.claimedStatus : null;
    if (errors.length) {
      out.rejected.push({ index, errors });
      return;
    }
    out.suggestions.push({
      name: name!, category, servings: servings!, yield: { quantity: yq!, unit: yu! }, ingredients, method, equipment,
      activeMinutes: num(o.activeMinutes, 0, 10000), totalMinutes: num(o.totalMinutes, 0, 100000), rationale: str(o.rationale, 600) ?? '',
      claimedStatus: claimed, claimedAdditions: Array.isArray(o.claimedAdditions) ? o.claimedAdditions.filter((x): x is string => typeof x === 'string').slice(0, 5) : [],
    });
  });
  return out;
}

export function suggestionToDraft(s: AiSuggestion, workspace: Workspace, model: string): RecipeDraft {
  const lines: RecipeLine[] = s.ingredients.map((l) => ({ id: newId('ln'), ingredientId: l.ingredientId, form: l.form, quantity: l.quantity, unit: l.unit, optional: l.optional, basis: 'as_purchased' }));
  return {
    name: s.name, workspaces: [workspace], category: s.category, tags: ['ai-draft'], description: s.rationale,
    provenance: { kind: 'ai_draft', source: `AI draft (${model})`, importedAt: new Date().toISOString() },
    version: {
      lines, yield: s.yield, servings: s.servings, method: s.method, equipment: s.equipment, activeMinutes: s.activeMinutes, totalMinutes: s.totalMinutes,
      allergenStatus: 'unverified', confirmed: false, notes: 'Generated by AI. Review ingredients, quantities, yield, method, and allergens before use.',
    },
  };
}

export interface AiReview {
  draft: RecipeDraft;
  /** Engine result computed as if the draft were confirmed (stock check only). */
  engine: MatchResult;
  discrepancies: string[];
}

/** Recompute the AI's claims through the deterministic engine and list every disagreement. */
export function reviewSuggestion(state: AppState, s: AiSuggestion, workspace: Workspace, plannedDate: string, mode: 'make_now' | 'special' | 'one_two_away', model: string): AiReview {
  const draft = suggestionToDraft(s, workspace, model);
  const tmp: Recipe = {
    id: 'ai_preview', orgId: state.org.id, name: draft.name, workspaces: draft.workspaces, category: draft.category, tags: draft.tags, provenance: draft.provenance!,
    currentVersionId: 'ai_preview_v', versions: [{ ...draft.version, confirmed: true, id: 'ai_preview_v', recipeId: 'ai_preview', version: 1, createdAt: '', createdBy: 'ai' }],
  };
  const engine = match({ ...state, recipes: [...state.recipes, tmp] }, {
    workspace, plannedDate, protectMenu: true, targets: [{ recipeId: tmp.id, requested: { kind: 'servings', servings: s.servings } }],
  });
  const discrepancies: string[] = [];
  const group: MatchGroup = engine.group;
  if (s.claimedStatus && s.claimedStatus !== group) discrepancies.push(`AI claimed "${GROUP_LABEL[s.claimedStatus]}" but the engine computes "${GROUP_LABEL[group]}"`);
  if (mode === 'make_now' && engine.shortages.length > 0) discrepancies.push(`Not a Make-now option: needs ${engine.shortages.map((x) => x.name).join(', ')} (AI may not introduce ingredients here)`);
  const actualAdds = new Set(engine.shortages.map((x) => x.ingredientId));
  const claimedAdds = new Set(s.claimedAdditions);
  for (const id of actualAdds) if (!claimedAdds.has(id)) discrepancies.push(`Undisclosed addition: ${state.ingredients.find((i) => i.id === id)?.name ?? id}`);
  for (const id of claimedAdds) if (!actualAdds.has(id)) discrepancies.push(`AI listed ${state.ingredients.find((i) => i.id === id)?.name ?? id} as an addition, but it is on hand`);
  if (engine.capacity.maxServings !== null && engine.capacity.maxServings < s.servings) discrepancies.push(`AI proposed ${s.servings} servings; verified stock supports ${engine.capacity.maxServings}`);
  if (engine.allergens.status !== 'verified') discrepancies.push('Allergen information is not fully verified');
  for (const iss of engine.issues) discrepancies.push(iss.message);
  return { draft, engine, discrepancies };
}

/** Minimal, non-sensitive context sent to the AI provider (no costs, suppliers, or lot refs). */
export function aiContext(state: AppState, workspace: Workspace, plannedDate: string, freeByIngredient: Map<string, number>) {
  const pools = workspace === 'food' ? ['food', 'shared'] : ['bar', 'shared'];
  const relevant = new Set(state.lots.filter((l) => pools.includes(l.pool)).map((l) => l.ingredientId));
  return {
    workspace, plannedDate,
    categories: workspace === 'food' ? FOOD_CATEGORIES : BAR_CATEGORIES,
    ingredients: state.ingredients
      .filter((i) => relevant.has(i.id))
      .map((i) => ({ id: i.id, name: i.name, dimension: i.dimension, baseUnit: i.dimension === 'mass' ? 'g' : i.dimension === 'volume' ? 'ml' : 'each', freeQuantity: Math.round((freeByIngredient.get(i.id) ?? 0) * 100) / 100 })),
    units: ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'cup', 'tbsp', 'tsp', 'each', 'serving'],
  };
}
