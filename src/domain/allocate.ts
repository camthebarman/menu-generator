// Demand expansion + FEFO allocation shared by matching, menu protection, and planning.
// Pure: operates on a caller-provided mutable availability map so combined targets share stock.

import { currentVersion, keyOf, parseKey, type Catalog } from './catalog';
import type { Eligibility } from './eligibility';
import type { ComponentStrategy, ConfirmedStaple, Lot, Recipe, RecipeLine, RecipeVersion, RequestedYield, UnitCode } from './types';
import { toIngredientBase, toMicro, UNITS } from './units';

export interface LotSlot {
  lot: Lot;
  elig: Eligibility;
  key: string;
  /** micro base units */
  physical: number;
  reserved: number;
  /** micro base units claimed by soft menu protection, per workspace */
  claimFood: number;
  claimBar: number;
  costPerBase: number | null;
  priority: boolean;
}

export interface DemandSource {
  recipeId: string;
  recipeName: string;
  lineId: string;
  /** chain of component recipe names this demand came through */
  via: string[];
  display: { quantity: number; unit: UnitCode };
  label?: string;
}

export type IssueCode =
  | 'unmapped_ingredient' | 'unknown_ingredient' | 'unknown_line_quantity' | 'missing_conversion' | 'missing_edible_yield'
  | 'component_cycle' | 'component_yield_conversion' | 'lot_needs_review' | 'unknown_lot_quantity' | 'unconfirmed_recipe'
  | 'invalid_yield' | 'ai_draft_unreviewed';

export interface Issue {
  code: IssueCode;
  message: string;
  key?: string;
  ingredientId?: string | null;
  recipeId?: string;
  lineId?: string;
}

export interface LotAllocation {
  lotId: string;
  micro: number;
}

export interface KeyOutcome {
  key: string;
  ingredientId: string;
  form: RecipeLine['form'];
  requiredMicro: number;
  allocations: LotAllocation[];
  allocatedMicro: number;
  /** portion prepared from raw via a component recipe */
  preparedMicro: number;
  producerRecipeId: string | null;
  assumedMicro: number;
  shortfallMicro: number;
  reviewReasons: string[];
  sources: DemandSource[];
  isComponent: boolean;
}

export interface OptionalOutcome {
  key: string;
  ingredientId: string;
  micro: number;
  used: boolean;
  allocations: LotAllocation[];
  source: DemandSource;
  reason?: string;
}

export interface PrepStep {
  recipeId: string;
  versionId: string;
  key: string;
  scale: number;
  outputMicro: number;
}

export interface AllocationOutcome {
  keys: Map<string, KeyOutcome>;
  order: string[];
  optional: OptionalOutcome[];
  prepSteps: PrepStep[];
  issues: Issue[];
}

export interface ScaledTarget {
  recipe: Recipe;
  version: RecipeVersion;
  scale: number;
  /** When true, the target's own output is prepared fresh rather than drawn from prepared stock. */
  prepareOutput?: boolean;
}

export interface ExtraDemand {
  ingredientId: string;
  form: RecipeLine['form'];
  micro: number;
  label: string;
}

export interface AllocationInput {
  targets: ScaledTarget[];
  extraDemands?: ExtraDemand[];
  catalog: Catalog;
  /** Ordered candidate slots for a key (already filtered to allowed pools & eligible lots). */
  slotsFor: (key: string) => LotSlot[];
  /** Lots for a key that would need review before use (unknown quantity, review state). */
  reviewSlotsFor: (key: string) => LotSlot[];
  /** Remaining micro per lot id; mutated. */
  avail: Map<string, number>;
  strategy: ComponentStrategy;
  staples: Map<string, ConfirmedStaple>;
  /** micro already covered for a key before allocation (e.g. menu reservations) */
  preCovered?: Map<string, number>;
}

export function scaleFor(version: RecipeVersion, requested: RequestedYield, catalog?: Catalog, recipe?: Recipe): number | null {
  if (requested.kind === 'servings') {
    if (!(version.servings > 0)) return null;
    return requested.servings / version.servings;
  }
  if (requested.unit === version.yield.unit) return requested.quantity / version.yield.quantity;
  const a = UNITS[requested.unit];
  const b = UNITS[version.yield.unit];
  if (a.dimension === b.dimension && a.toBase && b.toBase) return (requested.quantity * a.toBase) / (version.yield.quantity * b.toBase);
  if (recipe?.produces && catalog) {
    const ing = catalog.ingredients.get(recipe.produces.ingredientId);
    if (ing) {
      const r = toIngredientBase(requested.quantity, requested.unit, ing);
      const y = toIngredientBase(version.yield.quantity, version.yield.unit, ing);
      if (r.ok && y.ok && y.value > 0) return r.value / y.value;
    }
  }
  return null;
}

interface PendingDemand {
  micro: number;
  source: DemandSource;
}

export function runAllocation(input: AllocationInput): AllocationOutcome {
  const { catalog, avail, strategy } = input;
  const issues: Issue[] = [];
  const required = new Map<string, PendingDemand[]>();
  const optional: { key: string; ingredientId: string; d: PendingDemand }[] = [];
  const prepareFresh = new Set<string>();
  const prepSteps: PrepStep[] = [];
  const cyclicEdges = new Set<string>();
  const issueSeen = new Set<string>();
  const addIssue = (i: Issue) => {
    const sig = `${i.code}|${i.key ?? ''}|${i.recipeId ?? ''}|${i.lineId ?? ''}`;
    if (!issueSeen.has(sig)) {
      issueSeen.add(sig);
      issues.push(i);
    }
  };

  const addRequired = (key: string, d: PendingDemand) => {
    const arr = required.get(key) ?? [];
    arr.push(d);
    required.set(key, arr);
  };

  /** Resolve a recipe line at a given scale into base micro demand. */
  const resolveLine = (recipe: Recipe, line: RecipeLine, scale: number, via: string[]): { key: string; ingredientId: string; micro: number; source: DemandSource } | null => {
    const source: DemandSource = { recipeId: recipe.id, recipeName: recipe.name, lineId: line.id, via, display: { quantity: (line.quantity ?? 0) * scale, unit: line.unit } };
    if (!line.ingredientId) {
      if (!line.optional) addIssue({ code: 'unmapped_ingredient', message: `"${line.rawText ?? 'Unnamed line'}" in ${recipe.name} is not mapped to a catalog ingredient`, recipeId: recipe.id, lineId: line.id, ingredientId: null });
      return null;
    }
    const ing = catalog.ingredients.get(line.ingredientId);
    const key = keyOf(line.ingredientId, line.form);
    if (!ing) {
      if (!line.optional) addIssue({ code: 'unknown_ingredient', message: `Ingredient ${line.ingredientId} in ${recipe.name} is missing from the catalog`, recipeId: recipe.id, lineId: line.id, key });
      return null;
    }
    if (line.quantity === null || !Number.isFinite(line.quantity)) {
      if (!line.optional) addIssue({ code: 'unknown_line_quantity', message: `${ing.name} in ${recipe.name} has no confirmed quantity`, recipeId: recipe.id, lineId: line.id, key, ingredientId: ing.id });
      return null;
    }
    const conv = toIngredientBase(line.quantity * scale, line.unit, ing);
    if (!conv.ok) {
      if (!line.optional) addIssue({ code: 'missing_conversion', message: `${conv.reason} (${recipe.name})`, recipeId: recipe.id, lineId: line.id, key, ingredientId: ing.id });
      return null;
    }
    let base = conv.value;
    if (line.basis === 'edible') {
      if (!ing.edibleYield || ing.edibleYield <= 0 || ing.edibleYield > 1) {
        if (!line.optional) addIssue({ code: 'missing_edible_yield', message: `${ing.name} in ${recipe.name} is specified as edible weight but no edible-yield factor is recorded`, recipeId: recipe.id, lineId: line.id, key, ingredientId: ing.id });
        return null;
      }
      base = base / ing.edibleYield; // trim applied once, at demand resolution
    }
    return { key, ingredientId: ing.id, micro: toMicro(base), source };
  };

  const expandRecipe = (recipe: Recipe, version: RecipeVersion, scale: number, via: string[]) => {
    for (const line of version.lines) {
      const r = resolveLine(recipe, line, scale, via);
      if (!r) {
        if (line.optional) {
          optional.push({ key: line.ingredientId ? keyOf(line.ingredientId, line.form) : `unmapped|${line.id}`, ingredientId: line.ingredientId ?? '', d: { micro: -1, source: { recipeId: recipe.id, recipeName: recipe.name, lineId: line.id, via, display: { quantity: (line.quantity ?? 0) * scale, unit: line.unit }, label: line.rawText ?? undefined } } });
        }
        continue;
      }
      if (line.optional) optional.push({ key: r.key, ingredientId: r.ingredientId, d: { micro: r.micro, source: r.source } });
      else addRequired(r.key, { micro: r.micro, source: r.source });
    }
  };

  for (const t of input.targets) {
    if (!t.version.confirmed) {
      addIssue({ code: t.recipe.provenance.kind === 'ai_draft' ? 'ai_draft_unreviewed' : 'unconfirmed_recipe', message: `${t.recipe.name} v${t.version.version} has not been confirmed (ingredients, quantities, yield, omissions)`, recipeId: t.recipe.id });
    }
    if (!(t.scale > 0) || !Number.isFinite(t.scale)) {
      addIssue({ code: 'invalid_yield', message: `Requested yield for ${t.recipe.name} cannot be scaled from its recorded yield`, recipeId: t.recipe.id });
      continue;
    }
    if (t.prepareOutput && t.recipe.produces) {
      prepareFresh.add(keyOf(t.recipe.produces.ingredientId, t.recipe.produces.form));
    }
    expandRecipe(t.recipe, t.version, t.scale, []);
  }
  for (const e of input.extraDemands ?? []) {
    addRequired(keyOf(e.ingredientId, e.form), { micro: e.micro, source: { recipeId: '', recipeName: e.label, lineId: '', via: [], display: { quantity: e.micro / 1e6, unit: 'g' }, label: e.label } });
  }

  // Topological order over keys reachable through producers (parents before children).
  const producerFor = (key: string): Recipe | null => {
    if (strategy === 'stock_only' && !prepareFresh.has(key)) return null;
    return catalog.producers.get(key) ?? null;
  };
  const color = new Map<string, number>();
  const post: string[] = [];
  const path: string[] = [];
  const visit = (key: string) => {
    color.set(key, 1);
    path.push(key);
    const p = producerFor(key);
    if (p) {
      for (const l of currentVersion(p).lines) {
        if (!l.ingredientId) continue;
        const ck = keyOf(l.ingredientId, l.form);
        const c = color.get(ck) ?? 0;
        if (c === 1) {
          cyclicEdges.add(key);
          const names = path.slice(path.indexOf(ck)).concat(ck).map((k) => catalog.ingredients.get(parseKey(k).ingredientId)?.name ?? k);
          addIssue({ code: 'component_cycle', message: `Component cycle detected: ${names.join(' → ')}`, key, recipeId: p.id });
        } else if (c === 0) visit(ck);
      }
    }
    path.pop();
    color.set(key, 2);
    post.push(key);
  };
  for (const k of [...required.keys()]) if ((color.get(k) ?? 0) === 0) visit(k);
  const order = post.reverse();

  const outcomes = new Map<string, KeyOutcome>();
  const takeFromSlots = (key: string, need: number): { allocations: LotAllocation[]; got: number } => {
    const allocations: LotAllocation[] = [];
    let got = 0;
    for (const s of input.slotsFor(key)) {
      if (got >= need) break;
      const a = avail.get(s.lot.id) ?? 0;
      if (a <= 0) continue;
      const take = Math.min(a, need - got);
      avail.set(s.lot.id, a - take);
      allocations.push({ lotId: s.lot.id, micro: take });
      got += take;
    }
    return { allocations, got };
  };

  for (const key of order) {
    const demands = required.get(key) ?? [];
    const { ingredientId, form } = parseKey(key);
    const total = demands.reduce((s, d) => s + d.micro, 0);
    const out: KeyOutcome = {
      key, ingredientId, form, requiredMicro: total, allocations: [], allocatedMicro: 0, preparedMicro: 0, producerRecipeId: null,
      assumedMicro: 0, shortfallMicro: 0, reviewReasons: [], sources: demands.map((d) => d.source), isComponent: !!catalog.producers.get(key),
    };
    outcomes.set(key, out);
    if (total <= 0) continue;
    let remaining = total;
    const pre = input.preCovered?.get(key) ?? 0;
    if (pre > 0) remaining = Math.max(0, remaining - pre);

    if (!prepareFresh.has(key) && remaining > 0) {
      const { allocations, got } = takeFromSlots(key, remaining);
      out.allocations = allocations;
      out.allocatedMicro = got;
      remaining -= got;
    }
    if (remaining <= 0) continue;

    const review = prepareFresh.has(key) ? [] : input.reviewSlotsFor(key);
    if (review.length > 0) {
      for (const s of review) {
        out.reviewReasons.push(`${s.lot.lotRef ?? s.lot.id}: ${s.elig.reasons.join('; ')}`);
        addIssue({ code: s.elig.unknownQuantity ? 'unknown_lot_quantity' : 'lot_needs_review', message: `${catalog.ingredients.get(ingredientId)?.name ?? ingredientId}: stock is short without lot ${s.lot.lotRef ?? s.lot.id}, which needs review (${s.elig.reasons.join('; ')})`, key, ingredientId });
      }
      out.shortfallMicro = remaining;
      continue;
    }

    const producer = cyclicEdges.has(key) ? null : producerFor(key);
    if (producer) {
      const pv = currentVersion(producer);
      const ing = catalog.ingredients.get(ingredientId);
      const y = ing ? toIngredientBase(pv.yield.quantity, pv.yield.unit, ing) : { ok: false as const, reason: 'missing ingredient' };
      if (!y.ok || y.value <= 0) {
        addIssue({ code: 'component_yield_conversion', message: `${producer.name} yield (${pv.yield.quantity} ${pv.yield.unit}) cannot be converted to ${ing?.name ?? ingredientId} stock units`, key, recipeId: producer.id });
        out.shortfallMicro = remaining;
        continue;
      }
      const scale = remaining / toMicro(y.value);
      if (!pv.confirmed) addIssue({ code: 'unconfirmed_recipe', message: `Component recipe ${producer.name} is not confirmed`, recipeId: producer.id });
      const via = [...(demands[0]?.source.via ?? []), producer.name];
      for (const line of pv.lines) {
        const r = resolveLine(producer, line, scale, via);
        if (!r) continue;
        if (line.optional) optional.push({ key: r.key, ingredientId: r.ingredientId, d: { micro: r.micro, source: r.source } });
        else {
          // Children are later in topo order; append demand so it aggregates.
          addRequired(r.key, { micro: r.micro, source: r.source });
          const child = outcomes.get(r.key);
          if (child) {
            // Should not happen in a DAG ordering; guard against double processing.
            addIssue({ code: 'component_cycle', message: `Component ordering conflict at ${r.key}`, key: r.key });
          }
        }
      }
      out.preparedMicro = remaining;
      out.producerRecipeId = producer.id;
      prepSteps.push({ recipeId: producer.id, versionId: pv.id, key, scale, outputMicro: remaining });
      continue;
    }

    const staple = input.staples.get(ingredientId);
    const ing = catalog.ingredients.get(ingredientId);
    if (staple && ing?.pantryStaple) {
      out.assumedMicro = remaining;
      continue;
    }
    out.shortfallMicro = remaining;
  }

  // Optional lines: only from stock left after all required demand; never partially used.
  const optionalOut: OptionalOutcome[] = [];
  for (const o of optional) {
    if (o.d.micro < 0) {
      optionalOut.push({ key: o.key, ingredientId: o.ingredientId, micro: 0, used: false, allocations: [], source: o.d.source, reason: 'Optional line is unmapped or has no confirmed quantity/conversion; omitted' });
      continue;
    }
    const before = new Map<string, number>();
    const slots = input.slotsFor(o.key);
    for (const s of slots) before.set(s.lot.id, avail.get(s.lot.id) ?? 0);
    const { allocations, got } = takeFromSlots(o.key, o.d.micro);
    if (got < o.d.micro) {
      for (const [id, v] of before) avail.set(id, v);
      optionalOut.push({ key: o.key, ingredientId: o.ingredientId, micro: o.d.micro, used: false, allocations: [], source: o.d.source, reason: got > 0 ? 'Not enough free stock; omitted' : 'Not in free stock; omitted' });
    } else {
      optionalOut.push({ key: o.key, ingredientId: o.ingredientId, micro: o.d.micro, used: true, allocations, source: o.d.source });
    }
  }

  return { keys: outcomes, order, optional: optionalOut, prepSteps, issues };
}
