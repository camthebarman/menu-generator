// Stock view: per-lot eligibility, reservations, and soft menu protection for a planned date.

import { runAllocation, scaleFor, type AllocationOutcome, type ExtraDemand, type LotSlot, type ScaledTarget } from './allocate';
import { buildCatalog, currentVersion, keyOf, type Catalog } from './catalog';
import { evaluateLot, fefoCompare, poolsFor } from './eligibility';
import type { AppState, ConfirmedStaple, Pool, Workspace } from './types';
import { convertCostToBase, fromMicro, toIngredientBase, toMicro } from './units';

export interface ProtectionResult {
  incomplete: boolean;
  reasons: string[];
  outcomes: Record<Workspace, AllocationOutcome | null>;
  /** lotId -> micro claimed per workspace */
  claims: Map<string, { food: number; bar: number }>;
  /** menu demand not covered by eligible stock */
  menuShort: { workspace: Workspace; key: string; micro: number }[];
}

export interface StockView {
  plannedDate: string;
  workspace: Workspace;
  protectMenu: boolean;
  catalog: Catalog;
  slots: LotSlot[];
  slotById: Map<string, LotSlot>;
  slotsFor: (key: string) => LotSlot[];
  reviewSlotsFor: (key: string) => LotSlot[];
  /** Available micro per lot for this request (after reservations and applicable protection). */
  baseAvail: Map<string, number>;
  protection: ProtectionResult;
  staples: Map<string, ConfirmedStaple>;
  allowedPools: Pool[];
}

export function buildSlots(state: AppState, catalog: Catalog, plannedDate: string, priorityLotIds: string[] = []): LotSlot[] {
  const reservedBy = new Map<string, number>();
  for (const r of state.reservations) {
    if (r.status !== 'active') continue;
    reservedBy.set(r.lotId, (reservedBy.get(r.lotId) ?? 0) + toMicro(r.quantity - r.consumed));
  }
  const prio = new Set(priorityLotIds);
  return state.lots.map((lot) => {
    const ing = catalog.ingredients.get(lot.ingredientId);
    const elig = evaluateLot(lot, ing, plannedDate, state.org.policy, state.org.timezone);
    const costPerBase = lot.cost && ing ? convertCostToBase(lot.cost, ing, lot.packageSize) : null;
    return {
      lot, elig, key: keyOf(lot.ingredientId, lot.form), physical: lot.quantity === null ? 0 : toMicro(lot.quantity),
      reserved: reservedBy.get(lot.id) ?? 0, claimFood: 0, claimBar: 0, costPerBase, priority: prio.has(lot.id),
    };
  });
}

function freeOf(s: LotSlot): number {
  return s.elig.state === 'eligible' ? Math.max(0, s.physical - s.reserved) : 0;
}

export function computeProtection(state: AppState, catalog: Catalog, slots: LotSlot[]): ProtectionResult {
  const reasons: string[] = [];
  const claims = new Map<string, { food: number; bar: number }>();
  const menuShort: ProtectionResult['menuShort'] = [];
  const avail = new Map<string, number>(slots.map((s) => [s.lot.id, freeOf(s)]));
  const staples = new Map(state.org.confirmedStaples.map((s) => [s.ingredientId, s]));
  const outcomes: Record<Workspace, AllocationOutcome | null> = { food: null, bar: null };

  for (const ws of ['food', 'bar'] as Workspace[]) {
    const items = state.menuItems.filter((m) => m.workspace === ws && m.active);
    const targets: ScaledTarget[] = [];
    for (const m of items) {
      if (m.mappingStatus !== 'confirmed' || !m.recipeId) {
        reasons.push(`${ws === 'food' ? 'Food' : 'Bar'} menu: "${m.name}" recipe mapping is ${m.mappingStatus === 'missing' || !m.recipeId ? 'missing' : 'unverified'}`);
        continue;
      }
      const recipe = catalog.recipes.get(m.recipeId);
      const entry = recipe ? (m.recipeVersionId ? catalog.versions.get(m.recipeVersionId) : { recipe, version: currentVersion(recipe) }) : undefined;
      if (!recipe || !entry) {
        reasons.push(`Menu item "${m.name}" links to a recipe that no longer exists`);
        continue;
      }
      if (m.expectedPortions === null || m.expectedPortions === undefined) {
        reasons.push(`Menu item "${m.name}" has no expected portions entered`);
        continue;
      }
      if (m.expectedPortions <= 0) continue;
      const scale = scaleFor(entry.version, { kind: 'servings', servings: m.expectedPortions });
      if (scale === null) {
        reasons.push(`Menu item "${m.name}": recipe has no servings to scale from`);
        continue;
      }
      targets.push({ recipe: entry.recipe, version: entry.version, scale });
    }
    const extra: ExtraDemand[] = [];
    for (const p of state.protections.filter((x) => x.workspace === ws)) {
      const ing = catalog.ingredients.get(p.ingredientId);
      if (!ing) {
        reasons.push(`Protection entry references unknown ingredient ${p.ingredientId}`);
        continue;
      }
      const conv = toIngredientBase(p.quantity, p.unit, ing);
      if (!conv.ok) {
        reasons.push(`Protection for ${ing.name}: ${conv.reason}`);
        continue;
      }
      extra.push({ ingredientId: p.ingredientId, form: p.form, micro: toMicro(conv.value), label: `Protected: ${ing.name}${p.note ? ` (${p.note})` : ''}` });
    }
    if (targets.length === 0 && extra.length === 0) continue;

    const preCovered = new Map<string, number>();
    for (const r of state.reservations) {
      if (r.status === 'active' && r.purpose === 'menu' && r.workspace === ws) {
        const k = keyOf(r.ingredientId, r.form);
        preCovered.set(k, (preCovered.get(k) ?? 0) + toMicro(r.quantity - r.consumed));
      }
    }
    // Protection holds own-pool stock first, then shared; latest-dated first so older stock
    // remains free for specials (disclosed in UI).
    const ordered = new Map<string, typeof slots>();
    const slotsFor = (key: string) => {
      let o = ordered.get(key);
      if (!o) {
        const eligible = slots.filter((s) => s.key === key && s.elig.state === 'eligible');
        const rev = (a: LotSlot, b: LotSlot) => -fefoCompare(a, b);
        o = [...eligible.filter((s) => s.lot.pool === ws).sort(rev), ...eligible.filter((s) => s.lot.pool === 'shared').sort(rev)];
        ordered.set(key, o);
      }
      return o;
    };
    const before = new Map(avail);
    const outcome = runAllocation({ targets, extraDemands: extra, catalog, slotsFor, reviewSlotsFor: () => [], avail, strategy: 'prefer_stock', staples, preCovered });
    outcomes[ws] = outcome;
    for (const iss of outcome.issues) reasons.push(`${ws === 'food' ? 'Food' : 'Bar'} menu: ${iss.message}`);
    for (const [lotId, b] of before) {
      const diff = b - (avail.get(lotId) ?? 0);
      if (diff > 0) {
        const c = claims.get(lotId) ?? { food: 0, bar: 0 };
        c[ws] += diff;
        claims.set(lotId, c);
      }
    }
    for (const k of outcome.keys.values()) if (k.shortfallMicro > 0) menuShort.push({ workspace: ws, key: k.key, micro: k.shortfallMicro });
  }
  for (const s of slots) {
    const c = claims.get(s.lot.id);
    s.claimFood = c?.food ?? 0;
    s.claimBar = c?.bar ?? 0;
  }
  return { incomplete: reasons.length > 0, reasons, outcomes, claims, menuShort };
}

export interface StockOptions {
  workspace: Workspace;
  plannedDate: string;
  protectMenu: boolean;
  priorityLotIds?: string[];
  catalog?: Catalog;
}

export function buildStockView(state: AppState, opts: StockOptions): StockView {
  const catalog = opts.catalog ?? buildCatalog(state);
  const slots = buildSlots(state, catalog, opts.plannedDate, opts.priorityLotIds);
  const protection = computeProtection(state, catalog, slots);
  const allowedPools = poolsFor(opts.workspace);
  const ws = opts.workspace;
  const other: Workspace = ws === 'food' ? 'bar' : 'food';
  const baseAvail = new Map<string, number>();
  for (const s of slots) {
    if (!allowedPools.includes(s.lot.pool) || s.elig.state !== 'eligible') continue;
    const own = ws === 'food' ? s.claimFood : s.claimBar;
    const oth = other === 'food' ? s.claimFood : s.claimBar;
    // The other workspace's protection always applies; relaxing affects only this workspace's menu.
    baseAvail.set(s.lot.id, Math.max(0, freeOf(s) - oth - (opts.protectMenu ? own : 0)));
  }
  const byKey = new Map<string, LotSlot[]>();
  const reviewByKey = new Map<string, LotSlot[]>();
  for (const s of slots) {
    if (!allowedPools.includes(s.lot.pool)) continue;
    if (s.elig.state === 'eligible') {
      const a = byKey.get(s.key) ?? [];
      a.push(s);
      byKey.set(s.key, a);
    } else if (s.elig.state === 'review') {
      const a = reviewByKey.get(s.key) ?? [];
      a.push(s);
      reviewByKey.set(s.key, a);
    }
  }
  for (const arr of byKey.values()) arr.sort((a, b) => (a.priority !== b.priority ? (a.priority ? -1 : 1) : fefoCompare(a, b)));
  return {
    plannedDate: opts.plannedDate, workspace: ws, protectMenu: opts.protectMenu, catalog, slots,
    slotById: new Map(slots.map((s) => [s.lot.id, s])),
    slotsFor: (k) => byKey.get(k) ?? [],
    reviewSlotsFor: (k) => reviewByKey.get(k) ?? [],
    baseAvail, protection, staples: new Map(state.org.confirmedStaples.map((s) => [s.ingredientId, s])), allowedPools,
  };
}

export interface IngredientBalance {
  ingredientId: string;
  form: string;
  key: string;
  physical: number; // base units, known-quantity non-blocked lots in view pools
  reserved: number;
  menuProtected: number;
  freeForSpecials: number;
  reviewLots: number;
  blockedLots: number;
  unknownQtyLots: number;
  atRiskLots: number;
  pools: Pool[];
}

/** Physical on hand / reserved / additional menu protected / free for specials, per ingredient+form. */
export function balances(view: StockView, pools: Pool[] = view.allowedPools): IngredientBalance[] {
  const map = new Map<string, IngredientBalance>();
  for (const s of view.slots) {
    if (!pools.includes(s.lot.pool)) continue;
    const b = map.get(s.key) ?? {
      ingredientId: s.lot.ingredientId, form: s.lot.form, key: s.key, physical: 0, reserved: 0, menuProtected: 0, freeForSpecials: 0,
      reviewLots: 0, blockedLots: 0, unknownQtyLots: 0, atRiskLots: 0, pools: [],
    };
    if (!b.pools.includes(s.lot.pool)) b.pools.push(s.lot.pool);
    if (s.elig.state === 'blocked') b.blockedLots++;
    else {
      b.physical += fromMicro(s.physical);
      b.reserved += fromMicro(Math.min(s.reserved, s.physical));
      if (s.elig.state === 'review') b.reviewLots++;
      if (s.elig.unknownQuantity) b.unknownQtyLots++;
      if (s.elig.atRisk) b.atRiskLots++;
      if (s.elig.state === 'eligible') {
        const free = Math.max(0, s.physical - s.reserved);
        const prot = Math.min(free, s.claimFood + s.claimBar);
        b.menuProtected += fromMicro(prot);
        b.freeForSpecials += fromMicro(view.baseAvail.get(s.lot.id) ?? Math.max(0, free - prot));
      }
    }
    map.set(s.key, b);
  }
  return [...map.values()];
}
