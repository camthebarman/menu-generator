// Pure, validated state transitions. Each op returns a new state; inventory-changing ops
// are all-or-nothing (they throw OpError before any change is applied) and audited.
// The Supabase backend implements the same rules transactionally in SQL (see migrations).

import { buildCatalog, currentVersion, keyOf } from './catalog';
import { addDays, isLocalDate, localDateOf, minDate, todayIn, type Clock } from './dates';
import { evaluateLot, hardCutoffs, poolsFor } from './eligibility';
import { newId } from './factory';
import { match, type MatchResult } from './match';
import type {
  AppState, AuditEvent, CostRef, CurrentUser, DateProvenance, Form, Lot, LotStatus, MenuItem, Movement, MovementType, Plan, PlanTarget, Pool,
  ProtectionEntry, Recipe, RecipeVersion, Reservation, StorageState, UnitCode, Workspace,
} from './types';
import { BLOCKED_STATUSES } from './types';
import { roundBase, toIngredientBase, toMicro, fromMicro } from './units';

export class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface OpCtx {
  actor: CurrentUser;
  clock: Clock;
  source?: 'ui' | 'import' | 'system' | 'api';
}

export interface OpResult<T> {
  state: AppState;
  result: T;
  replayed?: boolean;
}

const EPS = 1e-9;

// ------------------------------------------------------------------ permissions

export function isManager(u: CurrentUser): boolean {
  return u.role === 'manager' || u.role === 'owner';
}

export function visiblePools(u: CurrentUser): Pool[] {
  if (isManager(u)) return ['food', 'bar', 'shared'];
  const pools = new Set<Pool>(['shared']);
  u.workspaces.forEach((w) => pools.add(w));
  return [...pools];
}

export function canUseWorkspace(u: CurrentUser, ws: Workspace): boolean {
  return isManager(u) || u.workspaces.includes(ws);
}

function requireManager(ctx: OpCtx, what: string) {
  if (!isManager(ctx.actor)) throw new OpError('forbidden', `Only managers can ${what}`);
}
function requirePool(ctx: OpCtx, pool: Pool) {
  if (!visiblePools(ctx.actor).includes(pool)) throw new OpError('forbidden', `You do not have access to the ${pool} pool`);
}
function requireWorkspace(ctx: OpCtx, ws: Workspace) {
  if (!canUseWorkspace(ctx.actor, ws)) throw new OpError('forbidden', `You do not have access to the ${ws} workspace`);
}

// ------------------------------------------------------------------ helpers

function clone(state: AppState): AppState {
  return structuredClone(state);
}

function nowIso(ctx: OpCtx) {
  return ctx.clock.now().toISOString();
}

export function today(state: AppState, clock: Clock): string {
  return state.clock.override ?? todayIn(clock, state.org.timezone);
}

function audit(s: AppState, ctx: OpCtx, action: string, entity: string, entityId: string, reason?: string | null, details?: Record<string, unknown>) {
  const ev: AuditEvent = { id: newId('aud'), orgId: s.org.id, actorId: ctx.actor.id, action, entity, entityId, reason: reason ?? null, source: ctx.source ?? 'ui', at: nowIso(ctx), details };
  s.audit.push(ev);
}

function movement(s: AppState, ctx: OpCtx, lot: Lot, type: MovementType, delta: number, reason: string, extra: Partial<Movement> = {}) {
  s.movements.push({
    id: newId('mov'), orgId: s.org.id, lotId: lot.id, type, delta: roundBase(delta), reason, actorId: ctx.actor.id, source: ctx.source ?? 'ui', at: nowIso(ctx), ...extra,
  });
}

function getLot(s: AppState, lotId: string): Lot {
  const lot = s.lots.find((l) => l.id === lotId);
  if (!lot) throw new OpError('not_found', `Lot ${lotId} not found`);
  return lot;
}

export function activeReservedOn(s: AppState, lotId: string, excludePlanId?: string): number {
  let sum = 0;
  for (const r of s.reservations) if (r.lotId === lotId && r.status === 'active' && r.planId !== excludePlanId) sum += r.quantity - r.consumed;
  return roundBase(sum);
}

function idem<T>(state: AppState, key: string | undefined | null, run: () => OpResult<T>): OpResult<T> {
  if (key && Object.prototype.hasOwnProperty.call(state.idempotency, key)) {
    return { state, result: JSON.parse(state.idempotency[key]) as T, replayed: true };
  }
  const out = run();
  if (key) out.state.idempotency[key] = JSON.stringify(out.result ?? null);
  return out;
}

function bumpLot(lot: Lot) {
  lot.version += 1;
  if (lot.quantity !== null && lot.quantity <= EPS && lot.status === 'available') lot.status = 'depleted';
}

// ------------------------------------------------------------------ inventory

export interface LotInput {
  ingredientId: string;
  form: Form;
  quantity: number | null;
  unit: UnitCode;
  packageSize?: { quantity: number; unit: UnitCode } | null;
  pool: Pool;
  storage: StorageState;
  location?: string | null;
  receivedAt?: string;
  brand?: string | null;
  product?: string | null;
  openedOn?: string | null;
  preparedOn?: string | null;
  packageDate?: string | null;
  qualityDate?: string | null;
  sellByDate?: string | null;
  useByDate?: string | null;
  expirationDate?: string | null;
  operationalDiscardDate?: string | null;
  hardDiscardDate?: string | null;
  labelWording?: string | null;
  labelDateType?: Lot['labelDateType'];
  dateProvenance?: DateProvenance;
  dateVerification?: 'verified' | 'unverified';
  cost?: CostRef | null;
  supplier?: string | null;
  lotRef?: string | null;
  notes?: string | null;
  status?: LotStatus;
}

const DATE_FIELDS = ['openedOn', 'preparedOn', 'packageDate', 'qualityDate', 'sellByDate', 'useByDate', 'expirationDate', 'operationalDiscardDate', 'hardDiscardDate'] as const;

export function validateLotInput(state: AppState, input: LotInput): string[] {
  const errs: string[] = [];
  if (!state.ingredients.some((i) => i.id === input.ingredientId)) errs.push('Unknown ingredient');
  if (input.quantity !== null && (!Number.isFinite(input.quantity) || input.quantity < 0)) errs.push('Quantity must be a non-negative number or left unknown');
  for (const f of DATE_FIELDS) {
    const v = input[f];
    if (v !== null && v !== undefined && v !== '' && !isLocalDate(v)) errs.push(`${f} must be a YYYY-MM-DD date`);
  }
  if (input.cost && (!(input.cost.amount >= 0) || !(input.cost.perQuantity > 0))) errs.push('Cost must have a non-negative amount and positive quantity');
  return errs;
}

export function receiveLot(state: AppState, ctx: OpCtx, input: LotInput, idemKey?: string, extraMovement?: Partial<Movement>): OpResult<{ lotId: string; quantityResolved: boolean }> {
  return idem(state, idemKey, () => {
    requirePool(ctx, input.pool);
    const errs = validateLotInput(state, input);
    if (errs.length) throw new OpError('invalid', errs.join('; '));
    const s = clone(state);
    const ing = s.ingredients.find((i) => i.id === input.ingredientId)!;
    let base: number | null = null;
    let status: LotStatus = input.status ?? 'available';
    let note = input.notes ?? null;
    if (input.quantity !== null) {
      const conv = toIngredientBase(input.quantity, input.unit, ing, input.packageSize);
      if (conv.ok) base = conv.value;
      else {
        status = 'needs_review';
        note = [note, `Entered ${input.quantity} ${input.unit}: ${conv.reason}`].filter(Boolean).join(' · ');
      }
    }
    const at = input.receivedAt ?? nowIso(ctx);
    const clean = <T>(v: T | '' | undefined): T | null => (v === '' || v === undefined ? null : v);
    const lot: Lot = {
      id: newId('lot'), orgId: s.org.id, ingredientId: input.ingredientId, form: input.form, brand: clean(input.brand), product: clean(input.product),
      quantity: base, enteredQuantity: input.quantity, enteredUnit: input.unit, packageSize: input.packageSize ?? null, pool: input.pool, storage: input.storage,
      location: clean(input.location), receivedAt: at, openedOn: clean(input.openedOn), preparedOn: clean(input.preparedOn), packageDate: clean(input.packageDate),
      qualityDate: clean(input.qualityDate), sellByDate: clean(input.sellByDate), useByDate: clean(input.useByDate), expirationDate: clean(input.expirationDate),
      operationalDiscardDate: clean(input.operationalDiscardDate), hardDiscardDate: clean(input.hardDiscardDate), labelWording: clean(input.labelWording),
      labelDateType: input.labelDateType ?? null, dateProvenance: input.dateProvenance ?? 'unknown', dateVerification: input.dateVerification ?? 'unverified',
      cost: input.cost ?? null, supplier: clean(input.supplier), lotRef: clean(input.lotRef), notes: note, status, version: 1, createdAt: nowIso(ctx),
    };
    s.lots.push(lot);
    movement(s, ctx, lot, extraMovement?.type ?? 'receipt', base ?? 0, extraMovement?.reason ?? (base === null ? 'Received (quantity unknown)' : 'Received'), { idempotencyKey: idemKey ?? null, ...extraMovement });
    audit(s, ctx, 'lot.receive', 'lot', lot.id, null, { ingredientId: lot.ingredientId, quantity: base, pool: lot.pool });
    return { state: s, result: { lotId: lot.id, quantityResolved: base !== null || input.quantity === null } };
  });
}

export type LotPatch = Partial<Omit<LotInput, 'ingredientId' | 'quantity' | 'unit' | 'pool' | 'status'>>;

export function updateLotDetails(state: AppState, ctx: OpCtx, lotId: string, patch: LotPatch, reason: string): OpResult<null> {
  const s = clone(state);
  const lot = getLot(s, lotId);
  requirePool(ctx, lot.pool);
  for (const f of DATE_FIELDS) {
    const v = patch[f];
    if (v !== undefined && v !== null && v !== '' && !isLocalDate(v)) throw new OpError('invalid', `${f} must be a YYYY-MM-DD date`);
  }
  if (lot.lineage && patch.hardDiscardDate === null) throw new OpError('invalid', 'Cannot remove a hard discard cutoff from a prepared lot');
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (lot as unknown as Record<string, unknown>)[k];
    (lot as unknown as Record<string, unknown>)[k] = v === '' ? null : v;
  }
  lot.version += 1;
  audit(s, ctx, 'lot.update', 'lot', lotId, reason, { before, after: patch });
  return { state: s, result: null };
}

export function adjustLot(state: AppState, ctx: OpCtx, lotId: string, newQuantityBase: number, reason: string, idemKey?: string): OpResult<{ delta: number }> {
  return idem(state, idemKey, () => {
    if (!reason.trim()) throw new OpError('invalid', 'A reason is required for adjustments');
    if (!(newQuantityBase >= 0)) throw new OpError('invalid', 'Quantity cannot be negative');
    const s = clone(state);
    const lot = getLot(s, lotId);
    requirePool(ctx, lot.pool);
    const reserved = activeReservedOn(s, lotId);
    if (newQuantityBase + EPS < reserved) throw new OpError('conflict', `Cannot set below reserved quantity (${reserved}); release reservations first`);
    const delta = roundBase(newQuantityBase - (lot.quantity ?? 0));
    lot.quantity = roundBase(newQuantityBase);
    if (lot.status === 'needs_review' && lot.notes?.includes('Entered')) lot.status = 'available';
    if (lot.status === 'depleted' && lot.quantity > 0) lot.status = 'available';
    bumpLot(lot);
    movement(s, ctx, lot, 'adjustment', delta, reason, { idempotencyKey: idemKey ?? null });
    audit(s, ctx, 'lot.adjust', 'lot', lotId, reason, { delta });
    return { state: s, result: { delta } };
  });
}

export function recordWaste(state: AppState, ctx: OpCtx, lotId: string, quantityBase: number, reason: string, idemKey?: string, planId?: string): OpResult<null> {
  return idem(state, idemKey, () => {
    if (!reason.trim()) throw new OpError('invalid', 'A waste reason is required');
    if (!(quantityBase > 0)) throw new OpError('invalid', 'Waste quantity must be positive');
    const s = clone(state);
    const lot = getLot(s, lotId);
    requirePool(ctx, lot.pool);
    if (lot.quantity === null) throw new OpError('invalid', 'Set a known quantity before recording waste');
    const free = lot.quantity - activeReservedOn(s, lotId);
    if (quantityBase > free + EPS) throw new OpError('conflict', `Only ${roundBase(free)} is unreserved on this lot`);
    lot.quantity = roundBase(lot.quantity - quantityBase);
    bumpLot(lot);
    movement(s, ctx, lot, 'waste', -quantityBase, reason, { planId: planId ?? null, idempotencyKey: idemKey ?? null });
    audit(s, ctx, 'lot.waste', 'lot', lotId, reason, { quantity: quantityBase, planId });
    return { state: s, result: null };
  });
}

export function setLotStatus(state: AppState, ctx: OpCtx, lotId: string, status: LotStatus, reason: string): OpResult<{ affectedPlans: string[] }> {
  if (!reason.trim()) throw new OpError('invalid', 'A reason is required');
  const s = clone(state);
  const lot = getLot(s, lotId);
  requirePool(ctx, lot.pool);
  if (lot.status === status) return { state, result: { affectedPlans: [] } };
  if (!isManager(ctx.actor) && (status === 'available' && BLOCKED_STATUSES.includes(lot.status))) {
    throw new OpError('forbidden', 'Only managers can return a blocked lot to available');
  }
  const prev = lot.status;
  lot.status = status;
  lot.version += 1;
  movement(s, ctx, lot, 'status_change', 0, `${prev} → ${status}: ${reason}`);
  const affected = [...new Set(s.reservations.filter((r) => r.lotId === lotId && r.status === 'active').map((r) => r.planId))];
  audit(s, ctx, 'lot.status', 'lot', lotId, reason, { from: prev, to: status, affectedPlans: affected });
  return { state: s, result: { affectedPlans: affected } };
}

export function approveQualityReview(state: AppState, ctx: OpCtx, lotId: string, validThrough: string, note: string): OpResult<null> {
  requireManager(ctx, 'approve quality-date reviews');
  if (!isLocalDate(validThrough)) throw new OpError('invalid', 'Valid-through must be a date');
  if (!note.trim()) throw new OpError('invalid', 'Describe the review performed');
  const s = clone(state);
  const lot = getLot(s, lotId);
  const cut = minDate(hardCutoffs(lot, s.org.policy).map((c) => c.date));
  if (cut && validThrough > cut) throw new OpError('invalid', `Review cannot extend past the hard cutoff ${cut}`);
  if (BLOCKED_STATUSES.includes(lot.status)) throw new OpError('invalid', 'Blocked lots cannot be approved');
  lot.qualityReview = { approvedBy: ctx.actor.name, approvedAt: nowIso(ctx), validThrough, note };
  lot.version += 1;
  audit(s, ctx, 'lot.quality_review', 'lot', lotId, note, { validThrough });
  return { state: s, result: null };
}

export function openLot(state: AppState, ctx: OpCtx, lotId: string, openedOn: string, operationalDiscardDate: string | null, reason: string): OpResult<null> {
  if (!isLocalDate(openedOn)) throw new OpError('invalid', 'Opened date required');
  if (operationalDiscardDate && !isLocalDate(operationalDiscardDate)) throw new OpError('invalid', 'Discard date must be a date');
  const s = clone(state);
  const lot = getLot(s, lotId);
  requirePool(ctx, lot.pool);
  lot.openedOn = openedOn;
  if (operationalDiscardDate) {
    // Opening may shorten, never extend, an existing cutoff.
    const cur = minDate(hardCutoffs(lot, s.org.policy).map((c) => c.date));
    lot.operationalDiscardDate = cur && cur < operationalDiscardDate ? lot.operationalDiscardDate ?? null : operationalDiscardDate;
  }
  lot.version += 1;
  movement(s, ctx, lot, 'opening', 0, reason || 'Opened');
  audit(s, ctx, 'lot.open', 'lot', lotId, reason, { openedOn, operationalDiscardDate });
  return { state: s, result: null };
}

/**
 * Transfer between pools preserving lot identity, dates, cost, and provenance.
 * Full transfers move the lot; partial transfers split into a child lot with identical attributes.
 */
export function transferLot(state: AppState, ctx: OpCtx, lotId: string, quantityBase: number | 'all', toPool: Pool, reason: string, idemKey?: string): OpResult<{ lotId: string }> {
  return idem(state, idemKey, () => {
    requireManager(ctx, 'transfer stock between pools');
    if (!reason.trim()) throw new OpError('invalid', 'A transfer reason is required');
    const s = clone(state);
    const lot = getLot(s, lotId);
    if (lot.pool === toPool) throw new OpError('invalid', 'Lot is already in that pool');
    if (BLOCKED_STATUSES.includes(lot.status)) throw new OpError('invalid', 'Blocked lots cannot be transferred');
    const reserved = activeReservedOn(s, lotId);
    if (quantityBase === 'all' || (lot.quantity !== null && Math.abs(quantityBase - lot.quantity) < EPS)) {
      if (reserved > EPS) throw new OpError('conflict', 'Release active reservations before moving the whole lot');
      const from = lot.pool;
      lot.pool = toPool;
      lot.version += 1;
      movement(s, ctx, lot, 'transfer_out', 0, reason, { fromPool: from, toPool, idempotencyKey: idemKey ?? null });
      movement(s, ctx, lot, 'transfer_in', 0, reason, { fromPool: from, toPool });
      audit(s, ctx, 'lot.transfer', 'lot', lotId, reason, { from, toPool, quantity: 'all' });
      return { state: s, result: { lotId } };
    }
    if (lot.quantity === null) throw new OpError('invalid', 'Quantity unknown; resolve before a partial transfer');
    if (!(quantityBase > 0) || quantityBase > lot.quantity - reserved + EPS) throw new OpError('conflict', `Only ${roundBase(lot.quantity - reserved)} is unreserved`);
    const child: Lot = { ...structuredClone(lot), id: newId('lot'), pool: toPool, quantity: roundBase(quantityBase), enteredQuantity: null, parentLotId: lot.id, version: 1, createdAt: nowIso(ctx) };
    lot.quantity = roundBase(lot.quantity - quantityBase);
    bumpLot(lot);
    s.lots.push(child);
    movement(s, ctx, lot, 'transfer_out', -quantityBase, reason, { fromPool: lot.pool, toPool, idempotencyKey: idemKey ?? null });
    movement(s, ctx, child, 'transfer_in', quantityBase, reason, { fromPool: lot.pool, toPool });
    audit(s, ctx, 'lot.transfer', 'lot', lotId, reason, { toPool, quantity: quantityBase, childLotId: child.id });
    return { state: s, result: { lotId: child.id } };
  });
}

// ------------------------------------------------------------------ plans

export interface PlanInput {
  workspace: Workspace;
  name: string;
  kind: Plan['kind'];
  serviceDate: string;
  targets: PlanTarget[];
  protectMenu: boolean;
  componentStrategy?: Plan['options']['componentStrategy'];
  priorityLotIds?: string[];
  notes?: string | null;
  source?: Plan['source'];
}

function hashString(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Fingerprint of everything a plan's validation depends on. */
export function planBasisHash(state: AppState, plan: Pick<Plan, 'id' | 'targets' | 'workspace' | 'serviceDate'>): string {
  const catalog = buildCatalog(state);
  const keys = new Set<string>();
  const visit = (recipeId: string, versionId: string | null, depth: number) => {
    if (depth > 8) return;
    const r = catalog.recipes.get(recipeId);
    if (!r) return;
    const v = (versionId && catalog.versions.get(versionId)?.version) || currentVersion(r);
    for (const l of v.lines) {
      if (!l.ingredientId) continue;
      const k = keyOf(l.ingredientId, l.form);
      keys.add(k);
      const p = catalog.producers.get(k);
      if (p) visit(p.id, null, depth + 1);
    }
  };
  const recipeBits: string[] = [];
  for (const t of plan.targets) {
    visit(t.recipeId, t.recipeVersionId, 0);
    const r = catalog.recipes.get(t.recipeId);
    recipeBits.push(`${t.recipeId}:${t.recipeVersionId}:${r?.currentVersionId ?? 'missing'}`);
  }
  const pools = poolsFor(plan.workspace);
  const lotBits = state.lots
    .filter((l) => keys.has(keyOf(l.ingredientId, l.form)) && pools.includes(l.pool))
    .map((l) => `${l.id}:${l.version}:${l.quantity}:${l.status}`)
    .sort();
  const resBits = state.reservations
    .filter((r) => r.status === 'active' && r.planId !== plan.id && keys.has(keyOf(r.ingredientId, r.form)))
    .map((r) => `${r.id}:${r.quantity}:${r.consumed}`)
    .sort();
  const menuBits = [
    ...state.menuItems.map((m) => `${m.id}:${m.recipeVersionId}:${m.expectedPortions}:${m.mappingStatus}:${m.active}`),
    ...state.protections.map((p) => `${p.id}:${p.quantity}:${p.unit}`),
  ].sort();
  return hashString([plan.serviceDate, ...recipeBits, '|', ...lotBits, '|', ...resBits, '|', ...menuBits, state.org.timezone, JSON.stringify(state.org.policy)].join(','));
}

export function evaluatePlan(state: AppState, plan: Pick<Plan, 'workspace' | 'serviceDate' | 'targets' | 'options' | 'kind'>, excludePlanReservations?: string): MatchResult {
  // When re-checking a reserved plan, its own reservations must not count against it.
  const s = excludePlanReservations
    ? { ...state, reservations: state.reservations.filter((r) => r.planId !== excludePlanReservations) }
    : state;
  return match(s, {
    workspace: plan.workspace,
    plannedDate: plan.serviceDate,
    targets: plan.targets.map((t) => ({ recipeId: t.recipeId, versionId: t.recipeVersionId, requested: t.requested, prepareOutput: plan.kind === 'component' })),
    protectMenu: plan.options.protectMenu,
    strategy: plan.options.componentStrategy,
    priorityLotIds: plan.options.priorityLotIds,
    skipCapacity: true,
  });
}

function snapshotAllocations(state: AppState, res: MatchResult): Plan['allocations'] {
  const out: Plan['allocations'] = [];
  const lotsById = new Map(state.lots.map((l) => [l.id, l]));
  for (const r of res.requirements) {
    for (const a of r.allocations) out.push({ lotId: a.lotId, ingredientId: r.ingredientId, form: r.form, quantity: a.quantity, lotVersion: lotsById.get(a.lotId)?.version ?? 0 });
  }
  return out;
}

export function createPlan(state: AppState, ctx: OpCtx, input: PlanInput): OpResult<{ planId: string; result: MatchResult }> {
  requireWorkspace(ctx, input.workspace);
  if (!isLocalDate(input.serviceDate)) throw new OpError('invalid', 'Service date required');
  if (input.targets.length === 0) throw new OpError('invalid', 'Select at least one recipe');
  const s = clone(state);
  const plan: Plan = {
    id: newId('plan'), orgId: s.org.id, workspace: input.workspace, name: input.name || 'Untitled plan', kind: input.kind, serviceDate: input.serviceDate,
    targets: input.targets, status: 'draft',
    options: { protectMenu: input.protectMenu, componentStrategy: input.componentStrategy ?? 'prefer_stock', priorityLotIds: input.priorityLotIds ?? [] },
    basisHash: null, allocations: [], createdAt: nowIso(ctx), createdBy: ctx.actor.id, updatedAt: nowIso(ctx), notes: input.notes ?? null, source: input.source ?? 'manual',
  };
  const res = evaluatePlan(s, plan);
  plan.allocations = snapshotAllocations(s, res);
  plan.basisHash = planBasisHash(s, plan);
  s.plans.push(plan);
  audit(s, ctx, 'plan.create', 'plan', plan.id, null, { targets: plan.targets.length, group: res.group });
  return { state: s, result: { planId: plan.id, result: res } };
}

export function updatePlanDraft(state: AppState, ctx: OpCtx, planId: string, patch: Partial<Pick<Plan, 'name' | 'serviceDate' | 'targets' | 'notes'>> & { protectMenu?: boolean }): OpResult<MatchResult> {
  const s = clone(state);
  const plan = s.plans.find((p) => p.id === planId);
  if (!plan) throw new OpError('not_found', 'Plan not found');
  requireWorkspace(ctx, plan.workspace);
  if (plan.status !== 'draft') throw new OpError('invalid', 'Only draft plans can be edited; release reservations first');
  if (patch.name !== undefined) plan.name = patch.name;
  if (patch.serviceDate !== undefined) {
    if (!isLocalDate(patch.serviceDate)) throw new OpError('invalid', 'Service date required');
    plan.serviceDate = patch.serviceDate;
  }
  if (patch.targets) plan.targets = patch.targets;
  if (patch.notes !== undefined) plan.notes = patch.notes;
  if (patch.protectMenu !== undefined) plan.options.protectMenu = patch.protectMenu;
  const res = evaluatePlan(s, plan);
  plan.allocations = snapshotAllocations(s, res);
  plan.basisHash = planBasisHash(s, plan);
  plan.updatedAt = nowIso(ctx);
  audit(s, ctx, 'plan.update', 'plan', plan.id);
  return { state: s, result: res };
}

export interface PlanStatusInfo {
  stale: boolean;
  staleReasons: string[];
  pastDue: boolean;
  blockedReservations: string[];
}

export function planStatusInfo(state: AppState, plan: Plan, clock: Clock): PlanStatusInfo {
  const reasons: string[] = [];
  const stale = plan.basisHash !== null && plan.basisHash !== planBasisHash(state, plan) && (plan.status === 'draft' || plan.status === 'reserved');
  if (stale) reasons.push('Inventory, dates, reservations, menu protection, or recipe versions changed since this plan was last validated');
  for (const t of plan.targets) {
    const r = state.recipes.find((x) => x.id === t.recipeId);
    if (r && r.currentVersionId !== t.recipeVersionId) reasons.push(`${r.name} has a newer version than the one planned`);
  }
  const blocked: string[] = [];
  const catalog = buildCatalog(state);
  for (const r of state.reservations.filter((x) => x.planId === plan.id && x.status === 'active')) {
    const lot = state.lots.find((l) => l.id === r.lotId);
    if (!lot) continue;
    const e = evaluateLot(lot, catalog.ingredients.get(lot.ingredientId), plan.serviceDate, state.org.policy, state.org.timezone);
    if (e.state !== 'eligible') blocked.push(`${lot.lotRef ?? lot.id}: ${e.reasons.join('; ')}`);
  }
  if (blocked.length) reasons.push('Some reserved lots are no longer eligible');
  const pastDue = plan.status === 'reserved' && plan.serviceDate < today(state, clock);
  return { stale: stale || reasons.length > 0, staleReasons: reasons, pastDue, blockedReservations: blocked };
}

/**
 * Atomically revalidate and reserve actual lots. Fails without changes unless the plan is Make now
 * against current stock (reservations, menu protection, eligibility, dates).
 */
export function reservePlan(state: AppState, ctx: OpCtx, planId: string, idemKey: string): OpResult<{ reservationIds: string[] }> {
  return idem(state, idemKey, () => {
    const s = clone(state);
    const plan = s.plans.find((p) => p.id === planId);
    if (!plan) throw new OpError('not_found', 'Plan not found');
    requireWorkspace(ctx, plan.workspace);
    if (plan.status !== 'draft') throw new OpError('invalid', `Plan is ${plan.status}`);
    if (plan.source === 'ai_draft') {
      for (const t of plan.targets) {
        const v = s.recipes.find((r) => r.id === t.recipeId)?.versions.find((x) => x.id === t.recipeVersionId);
        if (!v?.confirmed) throw new OpError('invalid', 'AI-drafted recipes must be reviewed and confirmed before reserving');
      }
    }
    if (plan.serviceDate < today(s, ctx.clock)) throw new OpError('invalid', 'Service date is in the past');
    const res = evaluatePlan(s, plan);
    if (res.group !== 'make_now') {
      throw new OpError('not_available', `Cannot reserve: current check is "${res.group.replace('_', ' ')}"${res.shortages.length ? ` (short: ${res.shortages.map((x) => x.name).join(', ')})` : ''}${res.issues.length ? ` (${res.issues[0].message})` : ''}`);
    }
    const ids: string[] = [];
    const lotsById = new Map(s.lots.map((l) => [l.id, l]));
    const addRes = (lotId: string, ingredientId: string, form: Form, qty: number) => {
      const lot = lotsById.get(lotId)!;
      // Defensive atomic check against physical quantity.
      if ((lot.quantity ?? 0) + EPS < activeReservedOn(s, lotId) + qty) throw new OpError('conflict', `Lot ${lot.lotRef ?? lotId} would be over-reserved`);
      const r: Reservation = {
        id: newId('res'), orgId: s.org.id, planId, lotId, ingredientId, form, quantity: roundBase(qty), consumed: 0, status: 'active', purpose: 'plan',
        workspace: plan.workspace, serviceDate: plan.serviceDate, createdAt: nowIso(ctx), createdBy: ctx.actor.id,
      };
      s.reservations.push(r);
      ids.push(r.id);
    };
    for (const r of res.requirements) for (const a of r.allocations) addRes(a.lotId, r.ingredientId, r.form, a.quantity);
    plan.status = 'reserved';
    plan.allocations = snapshotAllocations(s, res);
    plan.basisHash = planBasisHash(s, plan);
    plan.updatedAt = nowIso(ctx);
    audit(s, ctx, 'plan.reserve', 'plan', planId, null, { reservations: ids.length });
    return { state: s, result: { reservationIds: ids } };
  });
}

export function releasePlan(state: AppState, ctx: OpCtx, planId: string, reason: string, cancel: boolean): OpResult<{ released: number }> {
  const s = clone(state);
  const plan = s.plans.find((p) => p.id === planId);
  if (!plan) throw new OpError('not_found', 'Plan not found');
  requireWorkspace(ctx, plan.workspace);
  let released = 0;
  for (const r of s.reservations) {
    if (r.planId === planId && r.status === 'active') {
      r.status = 'released';
      released++;
    }
  }
  plan.status = cancel ? 'cancelled' : 'draft';
  plan.basisHash = planBasisHash(s, plan);
  plan.updatedAt = nowIso(ctx);
  audit(s, ctx, cancel ? 'plan.cancel' : 'plan.release', 'plan', planId, reason, { released });
  return { state: s, result: { released } };
}

export interface CompletionInput {
  /** Actual base quantity used per reservation (defaults to reserved quantity). */
  usage: { reservationId: string; used: number }[];
  /** Waste recorded during prep, from reserved stock. */
  waste: { reservationId: string; quantity: number; reason: string }[];
  /** Prep outputs (component plans). */
  outputs: {
    recipeId: string;
    quantity: number;
    unit: UnitCode;
    pool: Pool;
    storage: StorageState;
    useByDate: string | null;
    dateVerified: boolean;
    location?: string | null;
  }[];
  note?: string;
}

/**
 * Record preparation/usage for a reserved plan: consume inputs once, create outputs once with
 * lineage, release any unused reservation remainder, and record waste separately.
 */
export function completePlan(state: AppState, ctx: OpCtx, planId: string, input: CompletionInput, idemKey: string): OpResult<{ outputLotIds: string[]; released: number }> {
  return idem(state, idemKey, () => {
    const s = clone(state);
    const plan = s.plans.find((p) => p.id === planId);
    if (!plan) throw new OpError('not_found', 'Plan not found');
    requireWorkspace(ctx, plan.workspace);
    if (plan.status !== 'reserved') throw new OpError('invalid', 'Reserve the plan before recording preparation');
    const info = planStatusInfo(s, plan, ctx.clock);
    if (info.blockedReservations.length) throw new OpError('not_available', `Reserved stock is no longer eligible: ${info.blockedReservations.join('; ')}`);
    const resById = new Map(s.reservations.filter((r) => r.planId === planId && r.status === 'active').map((r) => [r.id, r]));
    const lotsById = new Map(s.lots.map((l) => [l.id, l]));
    const usageMap = new Map(input.usage.map((u) => [u.reservationId, u.used]));
    const wasteBy = new Map<string, { quantity: number; reason: string }[]>();
    for (const w of input.waste) {
      if (!resById.has(w.reservationId)) throw new OpError('invalid', 'Waste references an unknown reservation');
      if (!(w.quantity > 0) || !w.reason.trim()) throw new OpError('invalid', 'Waste needs a positive quantity and reason');
      const arr = wasteBy.get(w.reservationId) ?? [];
      arr.push(w);
      wasteBy.set(w.reservationId, arr);
    }
    const sources: { lotId: string; ingredientId: string; quantity: number }[] = [];
    let totalCost = 0;
    let costKnown = true;
    const catalog = buildCatalog(s);
    for (const r of resById.values()) {
      const used = usageMap.has(r.id) ? usageMap.get(r.id)! : r.quantity - r.consumed;
      const wasted = (wasteBy.get(r.id) ?? []).reduce((a, w) => a + w.quantity, 0);
      if (used < 0) throw new OpError('invalid', 'Usage cannot be negative');
      if (used + wasted > r.quantity - r.consumed + EPS) throw new OpError('invalid', 'Usage plus waste exceeds the reserved quantity; reserve more stock first');
      const lot = lotsById.get(r.lotId)!;
      if (lot.quantity === null || lot.quantity + EPS < used + wasted) throw new OpError('conflict', `Lot ${lot.lotRef ?? lot.id} does not have enough stock`);
      if (used > 0) {
        lot.quantity = roundBase(lot.quantity - used);
        movement(s, ctx, lot, 'usage', -used, `Used for ${plan.name}`, { planId, reservationId: r.id, idempotencyKey: idemKey });
        sources.push({ lotId: lot.id, ingredientId: lot.ingredientId, quantity: used });
        const ing = catalog.ingredients.get(lot.ingredientId);
        const c = lot.cost && ing ? toIngredientBase(lot.cost.perQuantity, lot.cost.perUnit, ing, lot.packageSize) : null;
        if (lot.cost && c && c.ok) totalCost += (used / c.value) * lot.cost.amount;
        else costKnown = false;
      }
      for (const w of wasteBy.get(r.id) ?? []) {
        lot.quantity = roundBase(lot.quantity - w.quantity);
        movement(s, ctx, lot, 'waste', -w.quantity, w.reason, { planId, reservationId: r.id });
      }
      r.consumed = roundBase(r.consumed + used + wasted);
      r.status = 'consumed';
      bumpLot(lot);
    }
    const released = [...resById.values()].filter((r) => r.consumed + EPS < r.quantity).length;

    const outputLotIds: string[] = [];
    const prepDate = today(s, ctx.clock);
    for (const o of input.outputs) {
      const recipe = s.recipes.find((r) => r.id === o.recipeId);
      if (!recipe?.produces) throw new OpError('invalid', 'Output recipe does not produce a stock component');
      requirePool(ctx, o.pool);
      const ing = s.ingredients.find((i) => i.id === recipe.produces!.ingredientId)!;
      const conv = toIngredientBase(o.quantity, o.unit, ing);
      if (!conv.ok) throw new OpError('invalid', conv.reason);
      if (o.useByDate && !isLocalDate(o.useByDate)) throw new OpError('invalid', 'Output use-by must be a date');
      const target = plan.targets.find((t) => t.recipeId === o.recipeId);
      const version = recipe.versions.find((v) => v.id === (target?.recipeVersionId ?? recipe.currentVersionId))!;
      const inputCutoffs = sources
        .map((src) => lotsById.get(src.lotId)!)
        .map((l) => minDate(hardCutoffs(l, s.org.policy).map((c) => c.date)));
      const inherited = minDate(inputCutoffs);
      const ruleVerified = !!version.outputHoldVerified;
      let useBy = o.useByDate;
      if (!useBy && ruleVerified && version.outputHoldDays) useBy = addDays(prepDate, version.outputHoldDays);
      const batchId = newId('prep');
      const lot: Lot = {
        id: newId('lot'), orgId: s.org.id, ingredientId: ing.id, form: recipe.produces.form, quantity: conv.value, enteredQuantity: o.quantity, enteredUnit: o.unit,
        pool: o.pool, storage: o.storage, location: o.location ?? null, receivedAt: nowIso(ctx), preparedOn: prepDate, useByDate: useBy ?? null,
        labelDateType: useBy ? 'use_by' : 'none', dateProvenance: useBy ? (o.useByDate ? 'staff_entry' : 'house_policy') : 'unknown',
        dateVerification: o.dateVerified || (!o.useByDate && ruleVerified) ? 'verified' : 'unverified',
        cost: costKnown && conv.value > 0 && sources.length ? { amount: Math.round(totalCost * 10000) / 10000, perQuantity: conv.value, perUnit: ing.dimension === 'mass' ? 'g' : ing.dimension === 'volume' ? 'ml' : 'each' } : null,
        status: 'available', version: 1, createdAt: nowIso(ctx), lotRef: `PREP-${prepDate}`,
        lineage: { prepBatchId: batchId, recipeId: recipe.id, recipeVersionId: version.id, sources, inheritedCutoff: inherited, cutoffRuleVerified: false },
        notes: input.note ?? null,
      };
      s.lots.push(lot);
      movement(s, ctx, lot, 'prep_output', conv.value, `Prepared via ${recipe.name} v${version.version}`, { planId, prepBatchId: batchId });
      s.prepBatches.push({ id: batchId, orgId: s.org.id, planId, recipeId: recipe.id, recipeVersionId: version.id, outputLotId: lot.id, outputQuantity: conv.value, preparedOn: prepDate, pool: o.pool, createdBy: ctx.actor.id, createdAt: nowIso(ctx) });
      outputLotIds.push(lot.id);
    }
    plan.status = 'completed';
    plan.updatedAt = nowIso(ctx);
    audit(s, ctx, 'plan.complete', 'plan', planId, input.note ?? null, { outputs: outputLotIds, released });
    return { state: s, result: { outputLotIds, released } };
  });
}

// ------------------------------------------------------------------ menus

export function upsertMenuItem(state: AppState, ctx: OpCtx, item: Omit<MenuItem, 'orgId' | 'id'> & { id?: string }): OpResult<{ id: string }> {
  requireWorkspace(ctx, item.workspace);
  if (!item.name.trim()) throw new OpError('invalid', 'Menu item name required');
  if (item.expectedPortions !== null && !(item.expectedPortions >= 0)) throw new OpError('invalid', 'Expected portions must be 0 or more');
  const s = clone(state);
  const id = item.id ?? newId('menu');
  let mapping = item.mappingStatus;
  if (!item.recipeId) mapping = 'missing';
  const recipe = item.recipeId ? s.recipes.find((r) => r.id === item.recipeId) : undefined;
  if (item.recipeId && !recipe) throw new OpError('invalid', 'Recipe not found');
  const full: MenuItem = { ...item, id, orgId: s.org.id, mappingStatus: mapping, recipeVersionId: recipe ? item.recipeVersionId ?? recipe.currentVersionId : null };
  const idx = s.menuItems.findIndex((m) => m.id === id);
  if (idx >= 0) s.menuItems[idx] = full;
  else s.menuItems.push(full);
  audit(s, ctx, idx >= 0 ? 'menu.update' : 'menu.create', 'menu_item', id);
  return { state: s, result: { id } };
}

export function deleteMenuItem(state: AppState, ctx: OpCtx, id: string): OpResult<null> {
  const s = clone(state);
  const m = s.menuItems.find((x) => x.id === id);
  if (!m) throw new OpError('not_found', 'Menu item not found');
  requireWorkspace(ctx, m.workspace);
  s.menuItems = s.menuItems.filter((x) => x.id !== id);
  audit(s, ctx, 'menu.delete', 'menu_item', id);
  return { state: s, result: null };
}

export function upsertProtection(state: AppState, ctx: OpCtx, p: Omit<ProtectionEntry, 'orgId' | 'id'> & { id?: string }): OpResult<{ id: string }> {
  requireWorkspace(ctx, p.workspace);
  if (!(p.quantity > 0)) throw new OpError('invalid', 'Protected quantity must be positive');
  const s = clone(state);
  const ing = s.ingredients.find((i) => i.id === p.ingredientId);
  if (!ing) throw new OpError('invalid', 'Unknown ingredient');
  const conv = toIngredientBase(p.quantity, p.unit, ing);
  if (!conv.ok) throw new OpError('invalid', conv.reason);
  const id = p.id ?? newId('prot');
  const full: ProtectionEntry = { ...p, id, orgId: s.org.id };
  const idx = s.protections.findIndex((x) => x.id === id);
  if (idx >= 0) s.protections[idx] = full;
  else s.protections.push(full);
  audit(s, ctx, 'protection.upsert', 'protection', id);
  return { state: s, result: { id } };
}

export function deleteProtection(state: AppState, ctx: OpCtx, id: string): OpResult<null> {
  const s = clone(state);
  const p = s.protections.find((x) => x.id === id);
  if (!p) throw new OpError('not_found', 'Not found');
  requireWorkspace(ctx, p.workspace);
  s.protections = s.protections.filter((x) => x.id !== id);
  audit(s, ctx, 'protection.delete', 'protection', id);
  return { state: s, result: null };
}

// ------------------------------------------------------------------ recipes

export interface RecipeDraft {
  name: string;
  workspaces: Workspace[];
  category: Recipe['category'];
  tags: string[];
  cuisine?: string | null;
  description?: string | null;
  produces?: Recipe['produces'];
  version: Omit<RecipeVersion, 'id' | 'recipeId' | 'version' | 'createdAt' | 'createdBy'>;
  provenance?: Recipe['provenance'];
}

export function validateRecipeDraft(state: AppState, d: RecipeDraft): string[] {
  const errs: string[] = [];
  if (!d.name.trim()) errs.push('Name required');
  if (d.workspaces.length === 0) errs.push('Choose at least one workspace');
  if (!(d.version.servings > 0)) errs.push('Servings must be positive');
  if (!(d.version.yield.quantity > 0)) errs.push('Yield must be positive');
  if (d.version.lines.length === 0) errs.push('Add at least one ingredient');
  for (const l of d.version.lines) {
    if (l.ingredientId && !state.ingredients.some((i) => i.id === l.ingredientId)) errs.push(`Unknown ingredient on line ${l.id}`);
    if (l.quantity !== null && !(l.quantity > 0)) errs.push(`Quantity on line ${l.rawText ?? l.id} must be positive or unknown`);
  }
  if (d.produces && !state.ingredients.some((i) => i.id === d.produces!.ingredientId)) errs.push('Produced ingredient not found');
  return errs;
}

function detectCycleWith(state: AppState, recipe: Recipe): string | null {
  const tmp = { ...state, recipes: [...state.recipes.filter((r) => r.id !== recipe.id), recipe] };
  const catalog = buildCatalog(tmp);
  const seen = new Set<string>();
  const walk = (r: Recipe, path: string[]): string | null => {
    if (path.includes(r.id)) return [...path, r.id].map((id) => catalog.recipes.get(id)?.name ?? id).join(' → ');
    if (seen.has(r.id)) return null;
    for (const l of currentVersion(r).lines) {
      if (!l.ingredientId) continue;
      const p = catalog.producers.get(keyOf(l.ingredientId, l.form));
      if (p) {
        const c = walk(p, [...path, r.id]);
        if (c) return c;
      }
    }
    seen.add(r.id);
    return null;
  };
  return walk(recipe, []);
}

/** Create a house recipe, or a new immutable version of an existing org recipe. Starter recipes are forked. */
export function saveRecipe(state: AppState, ctx: OpCtx, draft: RecipeDraft, existingId?: string): OpResult<{ recipeId: string; versionId: string }> {
  const errs = validateRecipeDraft(state, draft);
  if (errs.length) throw new OpError('invalid', errs.join('; '));
  const s = clone(state);
  const at = nowIso(ctx);
  const existing = existingId ? s.recipes.find((r) => r.id === existingId) : undefined;
  let recipe: Recipe;
  if (existing && existing.orgId === s.org.id) {
    const vnum = Math.max(...existing.versions.map((v) => v.version)) + 1;
    const vid = newId('rv');
    existing.versions.push({ ...draft.version, id: vid, recipeId: existing.id, version: vnum, createdAt: at, createdBy: ctx.actor.id });
    Object.assign(existing, { name: draft.name, workspaces: draft.workspaces, category: draft.category, tags: draft.tags, cuisine: draft.cuisine ?? null, description: draft.description ?? null, produces: draft.produces ?? null, currentVersionId: vid });
    recipe = existing;
  } else {
    const id = newId('rec');
    const vid = newId('rv');
    const prov: Recipe['provenance'] = existing
      ? { kind: 'house', source: `Adapted from ${existing.provenance.kind} recipe "${existing.name}"` }
      : draft.provenance ?? { kind: 'house', source: null };
    recipe = {
      id, orgId: s.org.id, name: draft.name, workspaces: draft.workspaces, category: draft.category, tags: draft.tags, cuisine: draft.cuisine ?? null,
      description: draft.description ?? null, provenance: prov, currentVersionId: vid, produces: draft.produces ?? null,
      versions: [{ ...draft.version, id: vid, recipeId: id, version: 1, createdAt: at, createdBy: ctx.actor.id }],
    };
    s.recipes.push(recipe);
  }
  const cycle = detectCycleWith(s, recipe);
  if (cycle) throw new OpError('invalid', `Component cycle: ${cycle}`);
  audit(s, ctx, existing ? 'recipe.version' : 'recipe.create', 'recipe', recipe.id, null, { versionId: recipe.currentVersionId, provenance: recipe.provenance.kind });
  return { state: s, result: { recipeId: recipe.id, versionId: recipe.currentVersionId } };
}

/** Human confirmation that an imported/AI recipe's ingredients, quantities, yield, and omissions are complete. */
export function confirmRecipeVersion(state: AppState, ctx: OpCtx, recipeId: string, versionId: string, note: string): OpResult<null> {
  const s = clone(state);
  const r = s.recipes.find((x) => x.id === recipeId);
  const v = r?.versions.find((x) => x.id === versionId);
  if (!r || !v) throw new OpError('not_found', 'Recipe version not found');
  if (r.orgId !== s.org.id) throw new OpError('forbidden', 'Starter recipes are already confirmed');
  if (v.lines.some((l) => !l.optional && (l.ingredientId === null || l.quantity === null))) {
    throw new OpError('invalid', 'Map every required ingredient and enter its quantity before confirming');
  }
  v.confirmed = true;
  if (r.provenance.kind === 'ai_draft') r.provenance = { ...r.provenance, source: `${r.provenance.source ?? 'AI draft'} · reviewed by ${ctx.actor.name}` };
  audit(s, ctx, 'recipe.confirm', 'recipe', recipeId, note, { versionId });
  return { state: s, result: null };
}

export function archiveRecipe(state: AppState, ctx: OpCtx, recipeId: string, archived: boolean): OpResult<null> {
  const s = clone(state);
  const r = s.recipes.find((x) => x.id === recipeId);
  if (!r || r.orgId !== s.org.id) throw new OpError('forbidden', 'Only house/imported recipes can be archived');
  r.archived = archived;
  audit(s, ctx, archived ? 'recipe.archive' : 'recipe.unarchive', 'recipe', recipeId);
  return { state: s, result: null };
}

// ------------------------------------------------------------------ ingredients & settings

export function upsertIngredient(state: AppState, ctx: OpCtx, ing: AppState['ingredients'][number]): OpResult<{ id: string }> {
  if (!ing.name.trim()) throw new OpError('invalid', 'Name required');
  const s = clone(state);
  const dup = s.ingredients.find((i) => i.id !== ing.id && i.name.trim().toLowerCase() === ing.name.trim().toLowerCase());
  if (dup) throw new OpError('conflict', `An ingredient named "${dup.name}" already exists`);
  if (ing.edibleYield !== null && ing.edibleYield !== undefined && !(ing.edibleYield > 0 && ing.edibleYield <= 1)) throw new OpError('invalid', 'Edible yield must be between 0 and 1');
  const idx = s.ingredients.findIndex((i) => i.id === ing.id);
  if (idx >= 0) {
    if (s.ingredients[idx].dimension !== ing.dimension && s.lots.some((l) => l.ingredientId === ing.id)) {
      throw new OpError('conflict', 'Cannot change the measuring dimension of an ingredient that has stock');
    }
    s.ingredients[idx] = { ...ing, orgId: s.org.id };
  } else s.ingredients.push({ ...ing, orgId: s.org.id });
  audit(s, ctx, idx >= 0 ? 'ingredient.update' : 'ingredient.create', 'ingredient', ing.id);
  return { state: s, result: { id: ing.id } };
}

export function setStaple(state: AppState, ctx: OpCtx, ingredientId: string, confirmed: boolean, assumeZeroCost: boolean): OpResult<null> {
  requireManager(ctx, 'confirm pantry-staple assumptions');
  const s = clone(state);
  s.org.confirmedStaples = s.org.confirmedStaples.filter((x) => x.ingredientId !== ingredientId);
  if (confirmed) s.org.confirmedStaples.push({ ingredientId, assumeZeroCost, confirmedBy: ctx.actor.name, confirmedAt: nowIso(ctx) });
  audit(s, ctx, confirmed ? 'staple.confirm' : 'staple.remove', 'ingredient', ingredientId);
  return { state: s, result: null };
}

export function updateOrgSettings(state: AppState, ctx: OpCtx, patch: Partial<Pick<AppState['org'], 'name' | 'timezone' | 'policy' | 'targetCostPct'>>): OpResult<null> {
  requireManager(ctx, 'change organization settings');
  const s = clone(state);
  Object.assign(s.org, patch);
  audit(s, ctx, 'org.settings', 'org', s.org.id, null, patch as Record<string, unknown>);
  return { state: s, result: null };
}

// ------------------------------------------------------------------ ledger integrity

/** Verify each lot's balance equals the sum of its movement deltas. Returns mismatched lot ids. */
export function ledgerMismatches(state: AppState): string[] {
  const sums = new Map<string, number>();
  for (const m of state.movements) sums.set(m.lotId, (sums.get(m.lotId) ?? 0) + toMicro(m.delta));
  const out: string[] = [];
  for (const l of state.lots) {
    if (l.quantity === null) continue;
    if (Math.abs((sums.get(l.id) ?? 0) - toMicro(l.quantity)) > 1) out.push(l.id);
  }
  return out;
}

export function lotLocalReceived(state: AppState, lot: Lot): string {
  return localDateOf(lot.receivedAt, state.org.timezone);
}

export { fromMicro };

// ------------------------------------------------------------------ shopping lists

export function saveShoppingList(state: AppState, ctx: OpCtx, list: Omit<import('./types').ShoppingList, 'id' | 'orgId' | 'createdAt'>): OpResult<{ id: string }> {
  requireWorkspace(ctx, list.workspace);
  if (list.selections.length === 0) throw new OpError('invalid', 'Select at least one recipe');
  const s = clone(state);
  const id = newId('shop');
  s.shoppingLists.push({ ...list, id, orgId: s.org.id, createdAt: nowIso(ctx) });
  audit(s, ctx, 'shopping.save', 'shopping_list', id);
  return { state: s, result: { id } };
}
