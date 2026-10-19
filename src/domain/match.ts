// Deterministic matching: typed, explainable results for one recipe or a combined plan.

import { runAllocation, scaleFor, type AllocationOutcome, type DemandSource, type Issue, type PrepStep, type ScaledTarget } from './allocate';
import { buildCatalog, currentVersion, keyOf, type Catalog } from './catalog';
import { buildStockView, type StockView } from './stock';
import type {
  Allergen, AppState, ComponentStrategy, Dimension, Form, Ingredient, Pool, Recipe, RecipeCategory, RecipeVersion, RequestedYield, UnitCode, Workspace,
} from './types';
import { fromMicro, toIngredientBase } from './units';

export type MatchGroup = 'make_now' | 'need_1' | 'need_2' | 'needs_review' | 'not_close';

export const GROUP_LABEL: Record<MatchGroup, string> = {
  make_now: 'Make now',
  need_1: 'Need 1 ingredient',
  need_2: 'Need 2 ingredients',
  needs_review: 'Needs review',
  not_close: 'Need 3+ ingredients',
};

export interface AllocationDetail {
  lotId: string;
  lotRef: string;
  pool: Pool;
  quantity: number; // base units
  lotQuantity: number; // base units physical before this plan
  share: number; // fraction of lot physical quantity used
  cutoff: string | null;
  qualityDate: string | null;
  daysToUrgency: number | null;
  atRisk: boolean;
  priority: boolean;
  cost: number | null;
  notes: string[];
}

export type RequirementStatus = 'ok' | 'short' | 'missing' | 'review' | 'assumed';

export interface RequirementRow {
  key: string;
  ingredientId: string;
  name: string;
  form: Form;
  dimension: Dimension;
  required: number;
  allocated: number;
  prepared: number;
  producerRecipeId: string | null;
  producerName: string | null;
  assumed: number;
  shortfall: number;
  status: RequirementStatus;
  allocations: AllocationDetail[];
  sources: DemandSource[];
  reviewReasons: string[];
  menuConflict: { own: number; other: number } | null;
  isComponent: boolean;
}

export interface ShortageItem {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  forms: Form[];
  needed: number;
  have: number;
  short: number;
  missingCompletely: boolean;
  estCost: number | null;
}

export interface CostSummary {
  status: 'complete' | 'partial' | 'unknown';
  knownCost: number;
  unknownLines: string[];
  portionCost: number | null;
  servings: number | null;
  estShortfallCost: number | null;
  salePrice: number | null;
  ingredientCostPct: number | null;
  targetPrice: number | null;
  notes: string[];
}

export interface AllergenSummary {
  contains: Allergen[];
  unknownIngredients: string[];
  unverifiedIngredients: string[];
  status: 'verified' | 'unverified' | 'incomplete';
}

export interface AlcoholSummary {
  status: 'contains_alcohol' | 'non_alcoholic' | 'unknown';
  sources: string[];
  unknown: string[];
}

export interface DietSummary {
  vegetarian: boolean | null;
  vegan: boolean | null;
}

export interface UrgencyLot {
  lotId: string;
  lotRef: string;
  ingredientName: string;
  used: number;
  lotQuantity: number;
  share: number;
  daysToUrgency: number;
  meaningful: boolean;
  value: number | null;
  dimension: Dimension;
}

export interface UrgencySummary {
  lots: UrgencyLot[];
  score: number;
  meaningful: boolean;
  valueUsed: number;
  valueUnknownLots: number;
}

export interface TargetInfo {
  recipeId: string;
  versionId: string;
  name: string;
  requested: RequestedYield;
  scale: number | null;
  servings: number | null;
}

export interface Capacity {
  /** Max multiplier of the requested plan supported by verified eligible stock. */
  multiplier: number | null;
  /** For single-target servings requests. */
  maxServings: number | null;
  /** For single-target quantity requests, in the requested unit. */
  maxQuantity: number | null;
  unit: UnitCode | null;
  exact: boolean;
  note: string;
}

export interface MatchResult {
  id: string;
  workspace: Workspace;
  plannedDate: string;
  targets: TargetInfo[];
  group: MatchGroup;
  shortages: ShortageItem[];
  distinctShortageCount: number;
  requirements: RequirementRow[];
  optional: { name: string; used: boolean; reason?: string; quantity: number; dimension: Dimension }[];
  issues: Issue[];
  assumptions: string[];
  omissions: string[];
  menuConflicts: { ingredientId: string; name: string; own: number; other: number; dimension: Dimension }[];
  urgency: UrgencySummary;
  priorityUse: { ingredientId: string; name: string; quantity: number; dimension: Dimension }[];
  capacity: Capacity;
  cost: CostSummary;
  allergens: AllergenSummary;
  alcohol: AlcoholSummary;
  diet: DietSummary;
  prepSteps: (PrepStep & { recipeName: string; outputQuantity: number; equipment: string[]; totalMinutes: number | null; outputHoldVerified: boolean })[];
  provenance: Recipe['provenance'][];
  protectMenu: boolean;
  protectionIncomplete: boolean;
}

export interface MatchRequest {
  workspace: Workspace;
  plannedDate: string;
  targets: { recipeId: string; versionId?: string; requested: RequestedYield; prepareOutput?: boolean }[];
  protectMenu: boolean;
  strategy?: ComponentStrategy;
  priorityLotIds?: string[];
  priorityIngredientIds?: string[];
  salePrice?: number | null;
  targetCostPct?: number | null;
  /** skip capacity search (used internally) */
  skipCapacity?: boolean;
}

function resolveTargets(catalog: Catalog, req: MatchRequest): { scaled: ScaledTarget[]; infos: TargetInfo[]; issues: Issue[] } {
  const scaled: ScaledTarget[] = [];
  const infos: TargetInfo[] = [];
  const issues: Issue[] = [];
  for (const t of req.targets) {
    const recipe = catalog.recipes.get(t.recipeId);
    if (!recipe) {
      issues.push({ code: 'unknown_ingredient', message: `Recipe ${t.recipeId} not found`, recipeId: t.recipeId });
      continue;
    }
    const version: RecipeVersion = (t.versionId ? catalog.versions.get(t.versionId)?.version : undefined) ?? currentVersion(recipe);
    const scale = scaleFor(version, t.requested, catalog, recipe);
    infos.push({
      recipeId: recipe.id, versionId: version.id, name: recipe.name, requested: t.requested, scale,
      servings: scale !== null ? version.servings * scale : null,
    });
    scaled.push({ recipe, version, scale: scale ?? NaN, prepareOutput: t.prepareOutput });
  }
  return { scaled, infos, issues };
}

function allocate(view: StockView, scaled: ScaledTarget[], strategy: ComponentStrategy, multiplier = 1): AllocationOutcome {
  return runAllocation({
    targets: scaled.map((t) => ({ ...t, scale: t.scale * multiplier })),
    catalog: view.catalog,
    slotsFor: view.slotsFor,
    reviewSlotsFor: view.reviewSlotsFor,
    avail: new Map(view.baseAvail),
    strategy,
    staples: view.staples,
  });
}

function feasible(o: AllocationOutcome): boolean {
  if (o.issues.length > 0) return false;
  for (const k of o.keys.values()) if (k.shortfallMicro > 0 || k.reviewReasons.length > 0) return false;
  return true;
}

function computeCapacity(view: StockView, scaled: ScaledTarget[], infos: TargetInfo[], strategy: ComponentStrategy, exact: boolean): Capacity {
  const single = infos.length === 1 ? infos[0] : null;
  let step = 0.01;
  let unit: UnitCode | null = null;
  if (single && single.requested.kind === 'servings' && single.requested.servings > 0) step = 1 / single.requested.servings;
  else if (single && single.requested.kind === 'quantity' && single.requested.quantity > 0) {
    step = 1 / single.requested.quantity;
    unit = single.requested.unit;
  }
  if (scaled.some((t) => !Number.isFinite(t.scale) || t.scale <= 0)) {
    return { multiplier: null, maxServings: null, maxQuantity: null, unit, exact: false, note: 'Capacity unknown: yield cannot be scaled' };
  }
  const ok = (k: number) => feasible(allocate(view, scaled, strategy, k * step));
  let maxK = 0;
  if (ok(1)) {
    let lo = 1;
    let hi = 2;
    const LIMIT = Math.max(2, Math.ceil(10000 / step));
    while (hi <= LIMIT && ok(hi)) {
      lo = hi;
      hi *= 2;
    }
    if (hi > LIMIT) maxK = lo;
    else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      maxK = lo;
    }
  }
  const multiplier = maxK * step;
  const note = exact ? '' : 'Capacity relies on manager-confirmed untracked staples; it is not an exact stock count.';
  if (single && single.requested.kind === 'servings') {
    return { multiplier, maxServings: Math.round(maxK), maxQuantity: null, unit: null, exact, note };
  }
  if (single && single.requested.kind === 'quantity') {
    return { multiplier, maxServings: null, maxQuantity: maxK, unit, exact, note };
  }
  return { multiplier: Math.floor(multiplier * 100) / 100, maxServings: null, maxQuantity: null, unit: null, exact, note };
}

export function match(state: AppState, req: MatchRequest, view?: StockView): MatchResult {
  const catalog = view?.catalog ?? buildCatalog(state);
  const stock = view ?? buildStockView(state, { workspace: req.workspace, plannedDate: req.plannedDate, protectMenu: req.protectMenu, priorityLotIds: req.priorityLotIds, catalog });
  return matchWithView(state, req, stock);
}

export function matchWithView(state: AppState, req: MatchRequest, view: StockView): MatchResult {
  const catalog = view.catalog;
  const strategy = req.strategy ?? 'prefer_stock';
  const { scaled, infos, issues: targetIssues } = resolveTargets(catalog, req);
  const outcome = allocate(view, scaled, strategy);
  const issues = [...targetIssues, ...outcome.issues];
  const prioIng = new Set(req.priorityIngredientIds ?? []);
  const policy = state.org.policy;

  // Protection effect per key (for menu conflict explanations).
  const ownClaim = (s: { claimFood: number; claimBar: number }) => (req.workspace === 'food' ? s.claimFood : s.claimBar);
  const otherClaim = (s: { claimFood: number; claimBar: number }) => (req.workspace === 'food' ? s.claimBar : s.claimFood);

  const requirements: RequirementRow[] = [];
  const assumptions: string[] = [];
  let exact = true;
  for (const key of outcome.order) {
    const k = outcome.keys.get(key);
    if (!k || k.requiredMicro <= 0) continue;
    const ing = catalog.ingredients.get(k.ingredientId);
    if (!ing) continue;
    const allocations: AllocationDetail[] = k.allocations.map((a) => {
      const s = view.slotById.get(a.lotId)!;
      const qty = fromMicro(a.micro);
      const lotQty = fromMicro(s.physical);
      const notes = [...s.elig.notes];
      if (s.elig.fefoBucket === 1) notes.push('No cutoff date: ordered by receipt age (FEFO fallback)');
      return {
        lotId: a.lotId, lotRef: s.lot.lotRef ?? s.lot.id.slice(-6), pool: s.lot.pool, quantity: qty, lotQuantity: lotQty,
        share: lotQty > 0 ? qty / lotQty : 0, cutoff: s.elig.cutoff, qualityDate: s.lot.qualityDate ?? null, daysToUrgency: s.elig.daysToUrgency,
        atRisk: s.elig.atRisk, priority: s.priority || prioIng.has(k.ingredientId), cost: s.costPerBase !== null ? qty * s.costPerBase : null, notes,
      };
    });
    let menuConflict: RequirementRow['menuConflict'] = null;
    if (k.shortfallMicro > 0) {
      let own = 0;
      let other = 0;
      for (const s of view.slotsFor(key)) {
        own += ownClaim(s);
        other += otherClaim(s);
      }
      if (own > 0 || other > 0) {
        menuConflict = { own: fromMicro(Math.min(own, k.shortfallMicro)), other: fromMicro(other) };
      }
    }
    if (k.assumedMicro > 0) {
      exact = false;
      const st = view.staples.get(k.ingredientId);
      assumptions.push(`${ing.name}: ${fromMicro(k.assumedMicro).toFixed(1)} ${ing.dimension === 'mass' ? 'g' : ing.dimension === 'volume' ? 'ml' : 'each'} assumed on hand as a manager-confirmed staple${st?.assumeZeroCost ? ' (cost treated as zero)' : ''}`);
    }
    const status: RequirementStatus = k.reviewReasons.length > 0
      ? 'review'
      : k.shortfallMicro > 0
        ? k.allocatedMicro + k.preparedMicro > 0 ? 'short' : 'missing'
        : k.assumedMicro > 0 ? 'assumed' : 'ok';
    const producer = k.producerRecipeId ? catalog.recipes.get(k.producerRecipeId) : null;
    requirements.push({
      key, ingredientId: k.ingredientId, name: ing.name, form: k.form, dimension: ing.dimension, required: fromMicro(k.requiredMicro),
      allocated: fromMicro(k.allocatedMicro), prepared: fromMicro(k.preparedMicro), producerRecipeId: k.producerRecipeId, producerName: producer?.name ?? null,
      assumed: fromMicro(k.assumedMicro), shortfall: fromMicro(k.shortfallMicro), status, allocations, sources: k.sources,
      reviewReasons: k.reviewReasons, menuConflict, isComponent: k.isComponent,
    });
  }
  // Lines with issues (unmapped, unknown qty, conversions) are review rows too.
  for (const iss of issues) {
    if (iss.code === 'unmapped_ingredient' || iss.code === 'unknown_line_quantity' || iss.code === 'missing_conversion' || iss.code === 'missing_edible_yield') {
      const ing = iss.ingredientId ? catalog.ingredients.get(iss.ingredientId) : undefined;
      if (ing && requirements.some((r) => r.ingredientId === ing.id && r.status === 'review')) continue;
      requirements.push({
        key: iss.key ?? `issue|${iss.lineId}`, ingredientId: iss.ingredientId ?? '', name: ing?.name ?? 'Unmapped ingredient', form: 'raw',
        dimension: ing?.dimension ?? 'count', required: 0, allocated: 0, prepared: 0, producerRecipeId: null, producerName: null, assumed: 0,
        shortfall: 0, status: 'review', allocations: [], sources: [], reviewReasons: [iss.message], menuConflict: null, isComponent: false,
      });
    }
  }

  // Shortages: distinct canonical procurement ingredients (ingredientId), not lines or units.
  const shortMap = new Map<string, ShortageItem>();
  for (const r of requirements) {
    if (r.status !== 'short' && r.status !== 'missing') continue;
    const ing = catalog.ingredients.get(r.ingredientId)!;
    const cur = shortMap.get(r.ingredientId) ?? {
      ingredientId: r.ingredientId, name: ing.name, dimension: ing.dimension, forms: [], needed: 0, have: 0, short: 0, missingCompletely: true, estCost: null,
    };
    if (!cur.forms.includes(r.form)) cur.forms.push(r.form);
    cur.needed += r.required - r.prepared;
    cur.have += r.allocated;
    cur.short += r.shortfall;
    if (r.allocated > 0) cur.missingCompletely = false;
    shortMap.set(r.ingredientId, cur);
  }
  for (const s of shortMap.values()) {
    const ing = catalog.ingredients.get(s.ingredientId)!;
    if (ing.referenceCost) {
      const per = ing.referenceCost.amount / Math.max(1e-9, toBaseSafe(ing.referenceCost.perQuantity, ing.referenceCost.perUnit, ing));
      s.estCost = Number.isFinite(per) ? per * s.short : null;
    }
  }
  const shortages = [...shortMap.values()];
  const hasReview = issues.length > 0 || requirements.some((r) => r.status === 'review');
  const distinct = shortages.length;
  const group: MatchGroup = hasReview ? 'needs_review' : distinct === 0 ? 'make_now' : distinct === 1 ? 'need_1' : distinct === 2 ? 'need_2' : 'not_close';

  const optional = outcome.optional.map((o) => {
    const ing = catalog.ingredients.get(o.ingredientId);
    return { name: ing?.name ?? o.source.label ?? 'Unmapped optional', used: o.used, reason: o.reason, quantity: fromMicro(o.micro), dimension: ing?.dimension ?? ('count' as Dimension) };
  });
  const omissions = optional.filter((o) => !o.used).map((o) => `Optional ${o.name}: ${o.reason}`);

  // Cost.
  const unknownLines: string[] = [];
  let knownCost = 0;
  let anyKnown = false;
  for (const r of requirements) {
    for (const a of r.allocations) {
      if (a.cost === null) unknownLines.push(`${r.name} (lot ${a.lotRef})`);
      else {
        knownCost += a.cost;
        anyKnown = true;
      }
    }
    if (r.assumed > 0) {
      if (view.staples.get(r.ingredientId)?.assumeZeroCost) anyKnown = true;
      else unknownLines.push(`${r.name} (assumed staple)`);
    }
    if (r.status === 'review') unknownLines.push(`${r.name} (needs review)`);
  }
  for (const o of outcome.optional.filter((x) => x.used)) {
    for (const a of o.allocations) {
      const s = view.slotById.get(a.lotId)!;
      if (s.costPerBase === null) unknownLines.push(`${catalog.ingredients.get(o.ingredientId)?.name ?? ''} (optional)`);
      else {
        knownCost += fromMicro(a.micro) * s.costPerBase;
        anyKnown = true;
      }
    }
  }
  const totalServings = infos.reduce((s, t) => s + (t.servings ?? 0), 0);
  const costComplete = unknownLines.length === 0 && shortages.length === 0 && anyKnown;
  const costStatus: CostSummary['status'] = costComplete ? 'complete' : anyKnown ? 'partial' : 'unknown';
  const portionCost = costComplete && totalServings > 0 ? knownCost / totalServings : null;
  const estShort = shortages.every((s) => s.estCost !== null) && shortages.length > 0 ? shortages.reduce((s, x) => s + (x.estCost ?? 0), 0) : null;
  const salePrice = req.salePrice ?? null;
  const targetPct = req.targetCostPct ?? state.org.targetCostPct ?? null;
  const costNotes: string[] = ['Ingredient cost only; labor and overhead are not included.'];
  if (costStatus !== 'complete') costNotes.push(costStatus === 'partial' ? 'Partial cost: some ingredients have no cost recorded or are short.' : 'Cost unknown: no consumed stock has a recorded cost.');
  const cost: CostSummary = {
    status: costStatus, knownCost, unknownLines, portionCost, servings: totalServings || null, estShortfallCost: estShort, salePrice,
    ingredientCostPct: portionCost !== null && salePrice ? portionCost / salePrice : null,
    targetPrice: portionCost !== null && targetPct ? portionCost / targetPct : null, notes: costNotes,
  };

  // Allergens / alcohol / diet over everything used or needed.
  const involved = new Set<string>();
  for (const r of requirements) if (r.ingredientId) involved.add(r.ingredientId);
  for (const o of outcome.optional) if (o.used) involved.add(o.ingredientId);
  const contains = new Set<Allergen>();
  const unknownIngredients: string[] = [];
  const unverified: string[] = [];
  const alcoholSources: string[] = [];
  const alcoholUnknown: string[] = [];
  let vegetarian: boolean | null = true;
  let vegan: boolean | null = true;
  for (const id of involved) {
    const ing = catalog.ingredients.get(id);
    if (!ing) continue;
    if (ing.allergens === null) unknownIngredients.push(ing.name);
    else {
      ing.allergens.forEach((a) => contains.add(a));
      if (!ing.allergensVerified) unverified.push(ing.name);
    }
    if (ing.alcoholic === true) alcoholSources.push(ing.name);
    else if (ing.alcoholic === null) alcoholUnknown.push(ing.name);
    if (ing.diet.vegetarian === false) vegetarian = false;
    else if (ing.diet.vegetarian === null && vegetarian !== false) vegetarian = null;
    if (ing.diet.vegan === false) vegan = false;
    else if (ing.diet.vegan === null && vegan !== false) vegan = null;
  }
  for (const r of requirements) {
    for (const a of r.allocations) {
      const lot = view.slotById.get(a.lotId)?.lot;
      lot?.allergens?.forEach((x) => contains.add(x));
    }
  }
  const versionsUnverified = scaled.some((t) => t.version.allergenStatus !== 'verified');
  const allergens: AllergenSummary = {
    contains: [...contains].sort(), unknownIngredients, unverifiedIngredients: unverified,
    status: unknownIngredients.length > 0 ? 'incomplete' : unverified.length > 0 || versionsUnverified ? 'unverified' : 'verified',
  };
  const alcohol: AlcoholSummary = {
    status: alcoholSources.length > 0 ? 'contains_alcohol' : alcoholUnknown.length > 0 ? 'unknown' : 'non_alcoholic', sources: alcoholSources, unknown: alcoholUnknown,
  };

  // Urgency: actual quantities consumed from at-risk lots.
  const ulots: UrgencyLot[] = [];
  let score = 0;
  let valueUsed = 0;
  let valueUnknown = 0;
  for (const r of requirements) {
    for (const a of r.allocations) {
      if (!a.atRisk || a.daysToUrgency === null) continue;
      const meaningful = a.share >= 0.2;
      const weight = (policy.alertDays + 1 - Math.max(0, a.daysToUrgency)) / (policy.alertDays + 1);
      score += a.share * weight;
      if (a.cost !== null) valueUsed += a.cost;
      else valueUnknown++;
      ulots.push({ lotId: a.lotId, lotRef: a.lotRef, ingredientName: r.name, used: a.quantity, lotQuantity: a.lotQuantity, share: a.share, daysToUrgency: a.daysToUrgency, meaningful, value: a.cost, dimension: r.dimension });
    }
  }
  const urgency: UrgencySummary = { lots: ulots, score, meaningful: ulots.some((l) => l.meaningful), valueUsed, valueUnknownLots: valueUnknown };

  const priorityUse: MatchResult['priorityUse'] = [];
  for (const r of requirements) {
    const q = r.allocations.filter((a) => a.priority).reduce((s, a) => s + a.quantity, 0);
    if (q > 0) priorityUse.push({ ingredientId: r.ingredientId, name: r.name, quantity: q, dimension: r.dimension });
  }

  const menuConflicts = requirements.filter((r) => r.menuConflict).map((r) => ({ ingredientId: r.ingredientId, name: r.name, own: r.menuConflict!.own, other: r.menuConflict!.other, dimension: r.dimension }));

  const capacity = req.skipCapacity
    ? { multiplier: null, maxServings: null, maxQuantity: null, unit: null, exact, note: '' }
    : computeCapacity(view, scaled, infos, strategy, exact);

  const prepSteps = outcome.prepSteps.map((p) => {
    const rec = catalog.recipes.get(p.recipeId)!;
    const v = catalog.versions.get(p.versionId)!.version;
    return { ...p, recipeName: rec.name, outputQuantity: fromMicro(p.outputMicro), equipment: v.equipment, totalMinutes: v.totalMinutes, outputHoldVerified: !!v.outputHoldVerified };
  });

  return {
    id: req.targets.map((t) => `${t.recipeId}:${t.versionId ?? ''}`).join('+'),
    workspace: req.workspace, plannedDate: req.plannedDate, targets: infos, group, shortages, distinctShortageCount: distinct, requirements, optional,
    issues, assumptions, omissions, menuConflicts, urgency, priorityUse, capacity, cost, allergens, alcohol, diet: { vegetarian, vegan }, prepSteps,
    provenance: scaled.map((t) => t.recipe.provenance), protectMenu: view.protectMenu, protectionIncomplete: view.protection.incomplete,
  };
}

function toBaseSafe(q: number, u: UnitCode, ing: Ingredient): number {
  const r = toIngredientBase(q, u, ing);
  return r.ok ? r.value : NaN;
}

// ---------------------------------------------------------------------------------------------
// Discovery

export type DiscoverMode = 'make_now' | 'use_older' | 'special' | 'component';

export interface DiscoverOptions {
  workspace: Workspace;
  plannedDate: string;
  mode: DiscoverMode;
  /** portions / drinks for dishes */
  servings: number;
  /** batches (multiples of recorded yield) for components */
  batches: number;
  selectedIngredientIds: string[];
  priorityLotIds: string[];
  categories: RecipeCategory[];
  cuisine: string | null;
  vegetarian: boolean;
  vegan: boolean;
  excludeAllergens: Allergen[];
  excludeEquipment: string[];
  maxMinutes: number | null;
  protectMenu: boolean;
  strategy: ComponentStrategy;
  query: string;
}

export interface DiscoverResult {
  groups: Record<MatchGroup, MatchResult[]>;
  hidden: { reason: string; count: number }[];
  view: StockView;
  considered: number;
}

export function requestedFor(recipe: Recipe, version: RecipeVersion, opts: Pick<DiscoverOptions, 'servings' | 'batches' | 'mode'>): RequestedYield {
  if (recipe.produces || opts.mode === 'component') {
    return { kind: 'quantity', quantity: version.yield.quantity * opts.batches, unit: version.yield.unit };
  }
  return { kind: 'servings', servings: opts.servings };
}

export function discover(state: AppState, opts: DiscoverOptions, catalogIn?: Catalog): DiscoverResult {
  const catalog = catalogIn ?? buildCatalog(state);
  const view = buildStockView(state, { workspace: opts.workspace, plannedDate: opts.plannedDate, protectMenu: opts.protectMenu, priorityLotIds: opts.priorityLotIds, catalog });
  const groups: Record<MatchGroup, MatchResult[]> = { make_now: [], need_1: [], need_2: [], needs_review: [], not_close: [] };
  const hiddenCounts = new Map<string, number>();
  const hide = (r: string) => hiddenCounts.set(r, (hiddenCounts.get(r) ?? 0) + 1);
  const q = opts.query.trim().toLowerCase();
  let considered = 0;
  for (const recipe of catalog.recipes.values()) {
    if (recipe.archived || !recipe.workspaces.includes(opts.workspace)) continue;
    if (recipe.provenance.kind === 'ai_draft' && !currentVersion(recipe).confirmed) continue; // unreviewed AI drafts stay in review
    if (opts.mode === 'component' && !recipe.produces) continue;
    if (opts.categories.length > 0 && !opts.categories.includes(recipe.category)) continue;
    if (opts.cuisine && recipe.cuisine !== opts.cuisine && !recipe.tags.includes(opts.cuisine)) continue;
    if (q && !recipe.name.toLowerCase().includes(q) && !recipe.tags.some((t) => t.toLowerCase().includes(q))) continue;
    const version = currentVersion(recipe);
    if (opts.maxMinutes !== null && (version.totalMinutes === null || version.totalMinutes > opts.maxMinutes)) {
      hide(version.totalMinutes === null ? 'Prep time unknown (time filter active)' : 'Over prep-time limit');
      continue;
    }
    if (opts.excludeEquipment.length > 0 && version.equipment.some((e) => opts.excludeEquipment.includes(e))) {
      hide('Needs excluded equipment');
      continue;
    }
    considered++;
    const res = matchWithView(state, {
      workspace: opts.workspace, plannedDate: opts.plannedDate,
      targets: [{ recipeId: recipe.id, versionId: version.id, requested: requestedFor(recipe, version, opts), prepareOutput: opts.mode === 'component' }],
      protectMenu: opts.protectMenu, strategy: opts.strategy, priorityLotIds: opts.priorityLotIds, priorityIngredientIds: opts.selectedIngredientIds,
    }, view);
    if (opts.selectedIngredientIds.length > 0) {
      const used = new Set(res.requirements.map((r) => r.ingredientId));
      if (!opts.selectedIngredientIds.every((id) => used.has(id))) continue;
    }
    if (opts.vegetarian && res.diet.vegetarian !== true) {
      hide(res.diet.vegetarian === null ? 'Vegetarian status unknown' : 'Not vegetarian');
      continue;
    }
    if (opts.vegan && res.diet.vegan !== true) {
      hide(res.diet.vegan === null ? 'Vegan status unknown' : 'Not vegan');
      continue;
    }
    if (opts.excludeAllergens.length > 0) {
      if (res.allergens.contains.some((a) => opts.excludeAllergens.includes(a))) {
        hide('Contains excluded allergen');
        continue;
      }
      if (res.allergens.status === 'incomplete') {
        hide('Allergen data incomplete (cannot confirm free-from)');
        continue;
      }
    }
    if (opts.mode === 'use_older' && !res.urgency.meaningful) {
      hide('Does not use a meaningful share of at-risk stock');
      continue;
    }
    groups[res.group].push(res);
  }
  const sortFn = (a: MatchResult, b: MatchResult) => {
    if (opts.mode === 'use_older' || opts.selectedIngredientIds.length > 0 || opts.priorityLotIds.length > 0) {
      const pa = a.priorityUse.length + a.urgency.score;
      const pb = b.priorityUse.length + b.urgency.score;
      if (pb !== pa) return pb - pa;
    }
    return a.targets[0].name.localeCompare(b.targets[0].name);
  };
  for (const g of Object.values(groups)) g.sort(sortFn);
  return { groups, hidden: [...hiddenCounts].map(([reason, count]) => ({ reason, count })), view, considered };
}

/** Key in the shopping/combination sense, exported for callers that need a stable id. */
export { keyOf };
