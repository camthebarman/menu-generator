import { buildCatalog } from './catalog';
import { match, type MatchResult } from './match';
import type { AppState, Dimension, ShoppingSelection, Workspace } from './types';
import { formatShortfall } from './units';

export interface ShoppingRow {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  short: number; // base units
  display: string; // rounded up
  missingCompletely: boolean;
  estCost: number | null;
  neededBy: string[];
}

export interface ShoppingResult {
  combined: MatchResult | null;
  rows: ShoppingRow[];
  /** What a naive per-recipe concatenation would have produced (for transparency). */
  naiveTotal: Map<string, number>;
  notes: string[];
}

/**
 * Recompute selected recipes together against shared stock: a single combined demand, so two
 * one-away recipes that both draw on the same limes are not each told the limes are available.
 */
export function computeShopping(state: AppState, workspace: Workspace, serviceDate: string, selections: ShoppingSelection[], protectMenu: boolean): ShoppingResult {
  if (selections.length === 0) return { combined: null, rows: [], naiveTotal: new Map(), notes: [] };
  const catalog = buildCatalog(state);
  const combined = match(state, {
    workspace, plannedDate: serviceDate, protectMenu, skipCapacity: true,
    targets: selections.map((s) => ({ recipeId: s.recipeId, versionId: s.recipeVersionId, requested: s.requested })),
  });
  const naive = new Map<string, number>();
  for (const s of selections) {
    const single = match(state, { workspace, plannedDate: serviceDate, protectMenu, skipCapacity: true, targets: [{ recipeId: s.recipeId, versionId: s.recipeVersionId, requested: s.requested }] });
    for (const sh of single.shortages) naive.set(sh.ingredientId, (naive.get(sh.ingredientId) ?? 0) + sh.short);
  }
  const rows: ShoppingRow[] = combined.shortages.map((sh) => {
    const neededBy = new Set<string>();
    for (const r of combined.requirements) if (r.ingredientId === sh.ingredientId) r.sources.forEach((src) => neededBy.add(src.via[0] ?? src.recipeName));
    return { ingredientId: sh.ingredientId, name: sh.name, dimension: sh.dimension, short: sh.short, display: formatShortfall(sh.short, sh.dimension), missingCompletely: sh.missingCompletely, estCost: sh.estCost, neededBy: [...neededBy] };
  });
  const notes: string[] = [];
  for (const row of rows) {
    const n = naive.get(row.ingredientId) ?? 0;
    if (row.short > n + 1e-6) notes.push(`${row.name}: combined need is ${formatShortfall(row.short, row.dimension)}; individually each recipe looked shorter because they share the same stock.`);
  }
  if (combined.issues.length) notes.push('Some selections need review; their shortages may be incomplete.');
  void catalog;
  return { combined, rows, naiveTotal: naive, notes };
}
