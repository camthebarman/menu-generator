// Substitutions are presented separately from the original recipe, disclose every change, and are
// fully revalidated through the engine (availability, allergens, alcohol status, cost).

import { currentVersion } from './catalog';
import { match, type MatchRequest, type MatchResult } from './match';
import type { AppState, Recipe, RecipeLine } from './types';

export interface SubstitutionVariant {
  changes: { lineId: string; from: string; to: string; fromQty: string; toQty: string; note: string }[];
  result: MatchResult;
  allergenChanges: { added: string[]; removed: string[] };
  alcoholChange: string | null;
}

export function substitutionVariants(state: AppState, base: MatchResult, req: MatchRequest): SubstitutionVariant[] {
  if (req.targets.length !== 1) return [];
  const recipe = state.recipes.find((r) => r.id === req.targets[0].recipeId);
  if (!recipe) return [];
  const version = recipe.versions.find((v) => v.id === req.targets[0].versionId) ?? currentVersion(recipe);
  const ingName = (id: string) => state.ingredients.find((i) => i.id === id)?.name ?? id;
  const out: SubstitutionVariant[] = [];
  for (const line of version.lines) {
    if (!line.ingredientId || !line.substitutes?.length) continue;
    // Every declared substitute is offered as its own revalidated variant.
    for (const sub of line.substitutes) {
      const newLine: RecipeLine = { ...line, ingredientId: sub.ingredientId, form: sub.form, quantity: sub.quantity, unit: sub.unit, substitutes: [] };
      const variantVersion = { ...version, id: `${version.id}__sub_${line.id}_${sub.ingredientId}`, lines: version.lines.map((l) => (l.id === line.id ? newLine : l)) };
      const variant: Recipe = { ...recipe, id: `${recipe.id}__sub`, currentVersionId: variantVersion.id, versions: [variantVersion] };
      const result = match({ ...state, recipes: [...state.recipes, variant] }, { ...req, targets: [{ ...req.targets[0], recipeId: variant.id, versionId: variantVersion.id }] });
      const before = new Set(base.allergens.contains);
      const after = new Set(result.allergens.contains);
      const added = [...after].filter((a) => !before.has(a));
      const removed = [...before].filter((a) => !after.has(a));
      out.push({
        changes: [{ lineId: line.id, from: ingName(line.ingredientId), to: ingName(sub.ingredientId), fromQty: `${line.quantity} ${line.unit}`, toQty: `${sub.quantity} ${sub.unit}`, note: sub.note }],
        result,
        allergenChanges: { added, removed },
        alcoholChange: base.alcohol.status !== result.alcohol.status ? `${base.alcohol.status.replace('_', ' ')} → ${result.alcohol.status.replace('_', ' ')}` : null,
      });
    }
  }
  return out;
}
