import type { AppState, Form, Ingredient, Recipe, RecipeVersion } from './types';

export const keyOf = (ingredientId: string, form: Form): string => `${ingredientId}|${form}`;
export const parseKey = (key: string): { ingredientId: string; form: Form } => {
  const i = key.lastIndexOf('|');
  return { ingredientId: key.slice(0, i), form: key.slice(i + 1) as Form };
};

export interface Catalog {
  ingredients: Map<string, Ingredient>;
  recipes: Map<string, Recipe>;
  versions: Map<string, { recipe: Recipe; version: RecipeVersion }>;
  /** ingredient|form -> recipe that produces it (house recipes preferred over starter). */
  producers: Map<string, Recipe>;
}

export function currentVersion(recipe: Recipe): RecipeVersion {
  return recipe.versions.find((v) => v.id === recipe.currentVersionId) ?? recipe.versions[recipe.versions.length - 1];
}

export function buildCatalog(state: Pick<AppState, 'ingredients' | 'recipes'>): Catalog {
  const ingredients = new Map(state.ingredients.map((i) => [i.id, i]));
  const recipes = new Map(state.recipes.map((r) => [r.id, r]));
  const versions = new Map<string, { recipe: Recipe; version: RecipeVersion }>();
  const producers = new Map<string, Recipe>();
  const rank = (r: Recipe) => (r.provenance.kind === 'house' ? 0 : r.provenance.kind === 'starter' ? 1 : 2);
  for (const r of state.recipes) {
    for (const v of r.versions) versions.set(v.id, { recipe: r, version: v });
    // Only reviewed content may act as an automatic producer for components.
    if (r.produces && !r.archived && currentVersion(r).confirmed) {
      const k = keyOf(r.produces.ingredientId, r.produces.form);
      const existing = producers.get(k);
      if (!existing || rank(r) < rank(existing)) producers.set(k, r);
    }
  }
  return { ingredients, recipes, versions, producers };
}

/**
 * Detect component cycles across all recipes. Returns arrays of recipe ids forming cycles.
 */
export function findComponentCycles(catalog: Catalog): string[][] {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const childrenOf = (r: Recipe): Recipe[] => {
    const v = currentVersion(r);
    const out: Recipe[] = [];
    for (const l of v.lines) {
      if (!l.ingredientId) continue;
      const p = catalog.producers.get(keyOf(l.ingredientId, l.form));
      if (p) out.push(p);
    }
    return out;
  };
  const visit = (r: Recipe) => {
    color.set(r.id, 1);
    stack.push(r.id);
    for (const c of childrenOf(r)) {
      const st = color.get(c.id) ?? 0;
      if (st === 1) cycles.push(stack.slice(stack.indexOf(c.id)).concat(c.id));
      else if (st === 0) visit(c);
    }
    stack.pop();
    color.set(r.id, 2);
  };
  for (const r of catalog.recipes.values()) if ((color.get(r.id) ?? 0) === 0) visit(r);
  return cycles;
}
