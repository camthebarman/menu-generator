// Live mode: Supabase PostgreSQL with RLS. Pure domain ops run locally first to validate input and
// derive engine results (base quantities, FEFO allocations); the SECURITY DEFINER RPCs then
// re-validate every hard constraint transactionally under row locks. State is reloaded after
// every mutation so derived matches are always recomputed from server truth.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { systemClock, type Clock } from '../domain/dates';
import { DEFAULT_POLICY } from '../domain/eligibility';
import * as ops from '../domain/ops';
import type { AppState, Ingredient, Lot, MenuItem, Movement, Plan, ProtectionEntry, Recipe, RecipeVersion, Reservation } from '../domain/types';
import { convertCostToBase } from '../domain/units';
import { contentHash } from '../domain/csv';
import { emptyState } from '../domain/factory';
import type { Command, CommandArgs, CommandResult, Repository } from './repository';

export interface LiveConfig {
  url: string;
  anonKey: string;
  /** Test/integration hook: supply a JWT directly instead of Supabase Auth sessions. */
  accessToken?: () => Promise<string | null>;
}

export interface MemberRow {
  userId: string;
  displayName: string | null;
  role: 'owner' | 'manager' | 'staff';
  workspaces: ('food' | 'bar')[];
}

export interface InviteRow {
  id: string;
  role: 'manager' | 'staff';
  workspaces: ('food' | 'bar')[];
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revoked: boolean;
}

export function liveConfigFromEnv(): LiveConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && anonKey ? { url, anonKey } : null;
}

type Row = Record<string, unknown>;
const d = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 10));
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class LiveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function mapError(e: { message?: string } | null): never {
  const msg = e?.message ?? 'Request failed';
  const m = /^(\w+): (.*)$/s.exec(msg);
  throw new ops.OpError(m ? m[1] : 'server', m ? m[2] : msg);
}

export class SupabaseRepository implements Repository {
  readonly mode = 'live' as const;
  readonly clock: Clock = systemClock;
  readonly client: SupabaseClient;
  private state: AppState | null = null;
  orgId: string | null = null;

  constructor(cfg: LiveConfig) {
    this.client = cfg.accessToken
      ? createClient(cfg.url, cfg.anonKey, { accessToken: cfg.accessToken })
      : createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  async memberships(): Promise<{ org_id: string; role: string; workspaces: string[]; organizations: { name: string } | null }[]> {
    const { data, error } = await this.client.from('memberships').select('org_id, role, workspaces, organizations(name)');
    if (error) mapError(error);
    return (data ?? []) as never;
  }

  async createOrganization(name: string, timezone: string, displayName: string): Promise<string> {
    const { data, error } = await this.client.rpc('create_organization', { p_name: name, p_timezone: timezone, p_display_name: displayName });
    if (error) mapError(error);
    return data as string;
  }

  private async select(table: string, orgScoped: boolean, order?: string): Promise<Row[]> {
    let q = this.client.from(table).select('*');
    if (orgScoped) q = q.eq('org_id', this.orgId as string);
    if (order) q = q.order(order, { ascending: false }).limit(5000);
    const { data, error } = await q;
    if (error) mapError(error);
    return (data ?? []) as Row[];
  }

  async userId(): Promise<string> {
    const me = (await this.rpc('whoami', {})) as { userId: string | null };
    if (!me.userId) throw new ops.OpError('unauthenticated', 'Sign in required');
    return me.userId;
  }

  async listMembers(): Promise<MemberRow[]> {
    const rows = await this.select('memberships', true);
    return rows.map((r) => ({ userId: String(r.user_id), displayName: (r.display_name as string) ?? null, role: r.role as MemberRow['role'], workspaces: r.workspaces as MemberRow['workspaces'] }));
  }

  async listInvites(): Promise<InviteRow[]> {
    const rows = await this.select('org_invites', true);
    return rows.map((r) => ({ id: String(r.id), role: r.role as InviteRow['role'], workspaces: r.workspaces as InviteRow['workspaces'], note: (r.note as string) ?? null, createdAt: String(r.created_at), expiresAt: String(r.expires_at), usedAt: (r.used_at as string) ?? null, revoked: !!r.revoked }));
  }

  async createInvite(role: 'manager' | 'staff', workspaces: ('food' | 'bar')[], note: string, days = 7): Promise<string> {
    const r = (await this.rpc('create_invite', { p_org: this.orgId, p_role: role, p_workspaces: workspaces, p_note: note || null, p_days: days })) as { code: string };
    return r.code;
  }

  async revokeInvite(id: string): Promise<void> {
    await this.rpc('revoke_invite', { p_org: this.orgId, p_invite: id });
  }

  async updateMember(userId: string, role: MemberRow['role'], workspaces: MemberRow['workspaces'], remove = false): Promise<void> {
    await this.rpc('update_member', { p_org: this.orgId, p_user: userId, p_role: role, p_workspaces: workspaces, p_remove: remove });
  }

  async acceptInvite(code: string, displayName: string): Promise<string> {
    return (await this.rpc('accept_invite', { p_code: code, p_display_name: displayName })) as string;
  }

  async load(): Promise<AppState> {
    if (!this.orgId) throw new ops.OpError('no_org', 'Choose an organization first');
    const org = this.orgId;
    const uid = await this.userId();
    const [orgRows, memRows, ing, staples, lots, movements, recipes, versions, menu, prot, plans, res, preps, shops, imps] = await Promise.all([
      this.client.from('organizations').select('*').eq('id', org).then(({ data, error }) => { if (error) mapError(error); return (data ?? []) as Row[]; }),
      this.select('memberships', true),
      this.select('ingredients', true),
      this.select('confirmed_staples', true),
      this.select('lots', true),
      this.select('lot_movements', true, 'at'),
      this.select('recipes', false),
      this.select('recipe_versions', false),
      this.select('menu_items', true),
      this.select('protections', true),
      this.select('plans', true),
      this.select('reservations', true),
      this.select('prep_batches', true),
      this.select('shopping_lists', true),
      this.select('imports', true),
    ]);
    const o = orgRows[0];
    if (!o) throw new ops.OpError('forbidden', 'Organization not found or not accessible');
    const me = memRows.find((m) => m.user_id === uid);
    const versionsBy = new Map<string, RecipeVersion[]>();
    for (const v of versions) {
      const arr = versionsBy.get(String(v.recipe_id)) ?? [];
      arr.push({
        id: String(v.id), recipeId: String(v.recipe_id), version: Number(v.version), createdAt: String(v.created_at), createdBy: String(v.created_by ?? ''),
        lines: v.lines as RecipeVersion['lines'], yield: v.yield as RecipeVersion['yield'], servings: Number(v.servings), method: (v.method as string[]) ?? [],
        equipment: (v.equipment as string[]) ?? [], activeMinutes: n(v.active_minutes), totalMinutes: n(v.total_minutes),
        allergenStatus: v.allergen_status as RecipeVersion['allergenStatus'], confirmed: !!v.confirmed, outputHoldDays: n(v.output_hold_days),
        outputHoldVerified: !!v.output_hold_verified, notes: (v.notes as string) ?? null,
      });
      versionsBy.set(String(v.recipe_id), arr);
    }
    const state = emptyState({
      mode: 'live',
      org: {
        id: String(o.id), name: String(o.name), timezone: String(o.timezone), currency: String(o.currency), policy: { ...DEFAULT_POLICY, ...(o.policy as object) },
        targetCostPct: n(o.target_cost_pct),
        confirmedStaples: staples.map((s) => ({ ingredientId: String(s.ingredient_id), assumeZeroCost: !!s.assume_zero_cost, confirmedBy: String(s.confirmed_by), confirmedAt: String(s.confirmed_at) })),
      },
      currentUser: { id: uid ?? '', name: String(me?.display_name ?? 'Me'), role: (me?.role as never) ?? 'staff', workspaces: (me?.workspaces as never) ?? [] },
      equipment: (o.equipment as string[]) ?? [],
      ingredients: ing.map((i): Ingredient => ({
        id: String(i.id), orgId: String(i.org_id), name: String(i.name), category: i.category as Ingredient['category'], dimension: i.dimension as Ingredient['dimension'],
        aliases: (i.aliases as Ingredient['aliases']) ?? [], allergens: (i.allergens as Ingredient['allergens']) ?? null, allergensVerified: !!i.allergens_verified,
        diet: { vegetarian: null, vegan: null, ...(i.diet as object) }, alcoholic: (i.alcoholic as boolean | null) ?? null, abv: n(i.abv), perishable: !!i.perishable,
        pantryStaple: !!i.pantry_staple, conversions: (i.conversions as Ingredient['conversions']) ?? [], edibleYield: n(i.edible_yield),
        referenceCost: (i.reference_cost as Ingredient['referenceCost']) ?? null, spiritStyle: (i.spirit_style as string) ?? null, notes: (i.notes as string) ?? undefined,
      })),
      lots: lots.map((l): Lot => ({
        id: String(l.id), orgId: String(l.org_id), ingredientId: String(l.ingredient_id), form: l.form as Lot['form'], brand: l.brand as string, product: l.product as string,
        quantity: n(l.quantity), enteredQuantity: n(l.entered_quantity), enteredUnit: l.entered_unit as Lot['enteredUnit'], packageSize: (l.package_size as Lot['packageSize']) ?? null,
        pool: l.pool as Lot['pool'], storage: l.storage as Lot['storage'], location: l.location as string, receivedAt: String(l.received_at), openedOn: d(l.opened_on),
        preparedOn: d(l.prepared_on), packageDate: d(l.package_date), qualityDate: d(l.quality_date), sellByDate: d(l.sell_by_date), useByDate: d(l.use_by_date),
        expirationDate: d(l.expiration_date), operationalDiscardDate: d(l.operational_discard_date), hardDiscardDate: d(l.hard_discard_date),
        labelWording: l.label_wording as string, labelDateType: l.label_date_type as Lot['labelDateType'], dateProvenance: l.date_provenance as Lot['dateProvenance'],
        dateVerification: l.date_verification as Lot['dateVerification'], cost: (l.cost as Lot['cost']) ?? null, supplier: l.supplier as string, lotRef: l.lot_ref as string,
        allergens: (l.allergens as Lot['allergens']) ?? null, notes: l.notes as string, status: l.status as Lot['status'], qualityReview: (l.quality_review as Lot['qualityReview']) ?? null,
        lineage: (l.lineage as Lot['lineage']) ?? null, parentLotId: (l.parent_lot_id as string) ?? null, version: Number(l.version), createdAt: String(l.created_at),
      })),
      movements: movements.map((m): Movement => ({
        id: String(m.id), orgId: String(m.org_id), lotId: String(m.lot_id), type: m.type as Movement['type'], delta: Number(m.delta), fromPool: m.from_pool as Movement['fromPool'],
        toPool: m.to_pool as Movement['toPool'], planId: m.plan_id as string, reservationId: m.reservation_id as string, prepBatchId: m.prep_batch_id as string,
        reason: String(m.reason), actorId: String(m.actor_id ?? ''), source: m.source as Movement['source'], at: String(m.at), idempotencyKey: m.idempotency_key as string,
      })),
      recipes: recipes.map((r): Recipe => ({
        id: String(r.id), orgId: (r.org_id as string) ?? null, name: String(r.name), workspaces: r.workspaces as Recipe['workspaces'], category: r.category as Recipe['category'],
        tags: (r.tags as string[]) ?? [], cuisine: (r.cuisine as string) ?? null, description: (r.description as string) ?? null, provenance: r.provenance as Recipe['provenance'],
        currentVersionId: String(r.current_version_id), versions: (versionsBy.get(String(r.id)) ?? []).sort((a, b) => a.version - b.version),
        produces: (r.produces as Recipe['produces']) ?? null, archived: !!r.archived,
      })),
      menuItems: menu.map((m): MenuItem => ({
        id: String(m.id), orgId: String(m.org_id), workspace: m.workspace as MenuItem['workspace'], name: String(m.name), recipeId: (m.recipe_id as string) ?? null,
        recipeVersionId: (m.recipe_version_id as string) ?? null, mappingStatus: m.mapping_status as MenuItem['mappingStatus'], expectedPortions: n(m.expected_portions),
        salePrice: n(m.sale_price), active: !!m.active,
      })),
      protections: prot.map((p): ProtectionEntry => ({
        id: String(p.id), orgId: String(p.org_id), workspace: p.workspace as ProtectionEntry['workspace'], ingredientId: String(p.ingredient_id), form: p.form as ProtectionEntry['form'],
        quantity: Number(p.quantity), unit: p.unit as ProtectionEntry['unit'], note: (p.note as string) ?? null,
      })),
      plans: plans.map((p): Plan => ({
        id: String(p.id), orgId: String(p.org_id), workspace: p.workspace as Plan['workspace'], name: String(p.name), kind: p.kind as Plan['kind'], serviceDate: d(p.service_date)!,
        targets: p.targets as Plan['targets'], status: p.status as Plan['status'],
        options: { protectMenu: true, componentStrategy: 'prefer_stock', priorityLotIds: [], ...(p.options as object) }, basisHash: (p.basis_hash as string) ?? null,
        allocations: (p.allocations as Plan['allocations']) ?? [], createdAt: String(p.created_at), createdBy: String(p.created_by ?? ''), updatedAt: String(p.updated_at),
        notes: (p.notes as string) ?? null, source: p.source as Plan['source'],
      })),
      reservations: res.map((r): Reservation => ({
        id: String(r.id), orgId: String(r.org_id), planId: String(r.plan_id), lotId: String(r.lot_id), ingredientId: String(r.ingredient_id), form: r.form as Reservation['form'],
        quantity: Number(r.quantity), consumed: Number(r.consumed), status: r.status as Reservation['status'], purpose: r.purpose as Reservation['purpose'],
        workspace: r.workspace as Reservation['workspace'], menuItemId: (r.menu_item_id as string) ?? null, serviceDate: d(r.service_date)!, createdAt: String(r.created_at), createdBy: String(r.created_by ?? ''),
      })),
      prepBatches: preps.map((p) => ({
        id: String(p.id), orgId: String(p.org_id), planId: String(p.plan_id), recipeId: String(p.recipe_id), recipeVersionId: String(p.recipe_version_id), outputLotId: String(p.output_lot_id),
        outputQuantity: Number(p.output_quantity), preparedOn: d(p.prepared_on)!, pool: p.pool as Lot['pool'], createdBy: String(p.created_by ?? ''), createdAt: String(p.created_at),
      })),
      shoppingLists: shops.map((s) => ({ id: String(s.id), orgId: String(s.org_id), workspace: s.workspace as Plan['workspace'], serviceDate: d(s.service_date)!, selections: s.selections as never, createdAt: String(s.created_at) })),
      imports: imps.map((i) => ({ id: String(i.id), orgId: String(i.org_id), kind: i.kind as 'inventory', fileName: String(i.file_name), contentHash: String(i.content_hash), rowCount: Number(i.row_count), committedAt: String(i.committed_at), createdIds: (i.created_ids as string[]) ?? [], actorId: String(i.actor_id ?? '') })),
    });
    this.state = state;
    return state;
  }

  private ctx(s: AppState): ops.OpCtx {
    return { actor: s.currentUser, clock: this.clock, source: 'ui' };
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) mapError(error);
    return data;
  }

  private lotPayload(s: AppState, lot: Lot) {
    const ing = s.ingredients.find((i) => i.id === lot.ingredientId);
    const perBase = lot.cost && ing ? convertCostToBase(lot.cost, ing, lot.packageSize) : null;
    return {
      ...lot, cost: lot.cost ? { ...lot.cost, perBase } : null,
    };
  }

  private async upsert(table: string, row: Row) {
    const { error } = await this.client.from(table).upsert(row);
    if (error) mapError(error);
  }

  async run<K extends Command>(cmd: K, ...args: CommandArgs<K>): Promise<{ state: AppState; result: CommandResult<K>; replayed?: boolean }> {
    const s = this.state ?? (await this.load());
    const ctx = this.ctx(s);
    const a = args as unknown[];
    const org = s.org.id;
    let result: unknown = null;
    switch (cmd) {
      case 'receiveLot': {
        const out = ops.receiveLot(s, ctx, a[0] as ops.LotInput);
        const lot = out.state.lots[out.state.lots.length - 1];
        const res = (await this.rpc('receive_lot', { p_org: org, p_lot: this.lotPayload(s, lot), p_idem: (a[1] as string) ?? `recv-${lot.id}` })) as { lotId: string; replayed?: boolean };
        result = { lotId: res.lotId, quantityResolved: out.result.quantityResolved };
        break;
      }
      case 'updateLotDetails':
        ops.updateLotDetails(s, ctx, a[0] as string, a[1] as ops.LotPatch, a[2] as string);
        await this.rpc('update_lot_details', { p_org: org, p_lot_id: a[0], p_patch: a[1], p_reason: a[2] });
        break;
      case 'adjustLot':
        ops.adjustLot(s, ctx, a[0] as string, a[1] as number, a[2] as string);
        result = await this.rpc('adjust_lot', { p_org: org, p_lot_id: a[0], p_new_quantity: a[1], p_reason: a[2], p_idem: a[3] ?? `adj-${Date.now()}` });
        break;
      case 'recordWaste':
        ops.recordWaste(s, ctx, a[0] as string, a[1] as number, a[2] as string);
        await this.rpc('record_waste', { p_org: org, p_lot_id: a[0], p_quantity: a[1], p_reason: a[2], p_idem: a[3] ?? `waste-${Date.now()}` });
        break;
      case 'setLotStatus':
        ops.setLotStatus(s, ctx, a[0] as string, a[1] as Lot['status'], a[2] as string);
        await this.rpc('set_lot_status', { p_org: org, p_lot_id: a[0], p_status: a[1], p_reason: a[2] });
        break;
      case 'approveQualityReview':
        ops.approveQualityReview(s, ctx, a[0] as string, a[1] as string, a[2] as string);
        await this.rpc('approve_quality_review', { p_org: org, p_lot_id: a[0], p_valid_through: a[1], p_note: a[2] });
        break;
      case 'openLot': {
        const out = ops.openLot(s, ctx, a[0] as string, a[1] as string, a[2] as string | null, a[3] as string);
        const lot = out.state.lots.find((l) => l.id === a[0])!;
        await this.rpc('update_lot_details', { p_org: org, p_lot_id: a[0], p_patch: { openedOn: lot.openedOn, operationalDiscardDate: lot.operationalDiscardDate }, p_reason: a[3] || 'Opened' });
        break;
      }
      case 'transferLot':
        ops.transferLot(s, ctx, a[0] as string, a[1] as number | 'all', a[2] as Lot['pool'], a[3] as string);
        result = await this.rpc('transfer_lot', { p_org: org, p_lot_id: a[0], p_quantity: a[1] === 'all' ? null : a[1], p_to_pool: a[2], p_reason: a[3], p_idem: a[4] ?? `xfer-${Date.now()}` });
        break;
      case 'createPlan':
      case 'updatePlanDraft': {
        const out = cmd === 'createPlan'
          ? ops.createPlan(s, ctx, a[0] as ops.PlanInput)
          : ops.updatePlanDraft(s, ctx, a[0] as string, a[1] as never);
        const planId = cmd === 'createPlan' ? (out.result as { planId: string }).planId : (a[0] as string);
        const p = out.state.plans.find((x) => x.id === planId)!;
        await this.upsert('plans', {
          id: p.id, org_id: org, workspace: p.workspace, name: p.name, kind: p.kind, service_date: p.serviceDate, targets: p.targets, status: 'draft',
          options: p.options, basis_hash: p.basisHash, allocations: p.allocations, notes: p.notes, source: p.source, created_by: s.currentUser.id, updated_at: new Date().toISOString(),
        });
        result = out.result;
        break;
      }
      case 'reservePlan': {
        const plan = s.plans.find((p) => p.id === a[0]);
        if (!plan) throw new ops.OpError('not_found', 'Plan not found');
        const res = ops.evaluatePlan(s, plan);
        if (res.group !== 'make_now') throw new ops.OpError('not_available', `Cannot reserve: current check is "${res.group.replace('_', ' ')}"`);
        const lotsById = new Map(s.lots.map((l) => [l.id, l]));
        const allocations = res.requirements.flatMap((r) => r.allocations.map((al) => ({ lotId: al.lotId, ingredientId: r.ingredientId, form: r.form, quantity: al.quantity, lotVersion: lotsById.get(al.lotId)?.version })));
        result = await this.rpc('reserve_plan', { p_org: org, p_plan_id: plan.id, p_allocations: allocations, p_basis_hash: ops.planBasisHash(s, plan), p_idem: a[1] });
        break;
      }
      case 'releasePlan':
        result = await this.rpc('release_plan', { p_org: org, p_plan_id: a[0], p_reason: a[1], p_cancel: a[2] });
        break;
      case 'completePlan': {
        const input = a[1] as ops.CompletionInput;
        const out = ops.completePlan(s, ctx, a[0] as string, input, a[2] as string);
        const created = out.state.lots.filter((l) => (out.result as { outputLotIds: string[] }).outputLotIds.includes(l.id));
        const outputs = created.map((l, i) => ({
          recipeId: input.outputs[i].recipeId, ingredientId: l.ingredientId, form: l.form, quantity: l.quantity, enteredQuantity: l.enteredQuantity, enteredUnit: l.enteredUnit,
          baseUnit: s.ingredients.find((x) => x.id === l.ingredientId)?.dimension === 'mass' ? 'g' : s.ingredients.find((x) => x.id === l.ingredientId)?.dimension === 'volume' ? 'ml' : 'each',
          pool: l.pool, storage: l.storage, location: l.location, useByDate: l.useByDate, dateVerified: l.dateVerification === 'verified',
        }));
        result = await this.rpc('complete_plan', { p_org: org, p_plan_id: a[0], p_usage: input.usage, p_waste: input.waste, p_outputs: outputs, p_note: input.note ?? null, p_idem: a[2] });
        break;
      }
      case 'upsertMenuItem': {
        const out = ops.upsertMenuItem(s, ctx, a[0] as never);
        const m = out.state.menuItems.find((x) => x.id === out.result.id)!;
        await this.upsert('menu_items', { id: m.id, org_id: org, workspace: m.workspace, name: m.name, recipe_id: m.recipeId, recipe_version_id: m.recipeVersionId, mapping_status: m.mappingStatus, expected_portions: m.expectedPortions, sale_price: m.salePrice ?? null, active: m.active });
        result = out.result;
        break;
      }
      case 'deleteMenuItem': {
        const { error } = await this.client.from('menu_items').delete().eq('id', a[0] as string);
        if (error) mapError(error);
        break;
      }
      case 'upsertProtection': {
        const out = ops.upsertProtection(s, ctx, a[0] as never);
        const p = out.state.protections.find((x) => x.id === out.result.id)!;
        await this.upsert('protections', { id: p.id, org_id: org, workspace: p.workspace, ingredient_id: p.ingredientId, form: p.form, quantity: p.quantity, unit: p.unit, note: p.note });
        result = out.result;
        break;
      }
      case 'deleteProtection': {
        const { error } = await this.client.from('protections').delete().eq('id', a[0] as string);
        if (error) mapError(error);
        break;
      }
      case 'saveRecipe': {
        const out = ops.saveRecipe(s, ctx, a[0] as ops.RecipeDraft, a[1] as string | undefined);
        const r = out.state.recipes.find((x) => x.id === out.result.recipeId)!;
        const v = r.versions.find((x) => x.id === out.result.versionId)!;
        await this.upsert('recipes', { id: r.id, org_id: org, name: r.name, workspaces: r.workspaces, category: r.category, tags: r.tags, cuisine: r.cuisine, description: r.description, provenance: r.provenance, current_version_id: r.currentVersionId, produces: r.produces, archived: !!r.archived });
        const { error } = await this.client.from('recipe_versions').insert({ id: v.id, recipe_id: r.id, org_id: org, version: v.version, lines: v.lines, yield: v.yield, servings: v.servings, method: v.method, equipment: v.equipment, active_minutes: v.activeMinutes, total_minutes: v.totalMinutes, allergen_status: v.allergenStatus, confirmed: v.confirmed, output_hold_days: v.outputHoldDays ?? null, output_hold_verified: !!v.outputHoldVerified, notes: v.notes ?? null, created_by: s.currentUser.id });
        if (error) mapError(error);
        result = out.result;
        break;
      }
      case 'confirmRecipeVersion':
        ops.confirmRecipeVersion(s, ctx, a[0] as string, a[1] as string, a[2] as string);
        await this.rpc('confirm_recipe_version', { p_org: org, p_version_id: a[1], p_note: a[2] });
        break;
      case 'archiveRecipe': {
        const { error } = await this.client.from('recipes').update({ archived: a[1] }).eq('id', a[0] as string).eq('org_id', org);
        if (error) mapError(error);
        break;
      }
      case 'upsertIngredient': {
        const out = ops.upsertIngredient(s, ctx, a[0] as Ingredient);
        const i = a[0] as Ingredient;
        await this.upsert('ingredients', { org_id: org, id: i.id, name: i.name, category: i.category, dimension: i.dimension, aliases: i.aliases, allergens: i.allergens, allergens_verified: i.allergensVerified, diet: i.diet, alcoholic: i.alcoholic, abv: i.abv ?? null, perishable: i.perishable, pantry_staple: i.pantryStaple, conversions: i.conversions, edible_yield: i.edibleYield ?? null, reference_cost: i.referenceCost ?? null, spirit_style: i.spiritStyle ?? null, notes: i.notes ?? null });
        result = out.result;
        break;
      }
      case 'setStaple':
        ops.setStaple(s, ctx, a[0] as string, a[1] as boolean, a[2] as boolean);
        await this.rpc('set_staple', { p_org: org, p_ingredient_id: a[0], p_confirmed: a[1], p_zero_cost: a[2] });
        break;
      case 'updateOrgSettings': {
        ops.updateOrgSettings(s, ctx, a[0] as never);
        const p = a[0] as Partial<AppState['org']>;
        const { error } = await this.client.from('organizations').update({ ...(p.name ? { name: p.name } : {}), ...(p.timezone ? { timezone: p.timezone } : {}), ...(p.policy ? { policy: p.policy } : {}), ...(p.targetCostPct !== undefined ? { target_cost_pct: p.targetCostPct } : {}) }).eq('id', org);
        if (error) mapError(error);
        break;
      }
      case 'commitInventoryImport': {
        const [rows, fileName, text, includeDup] = a as Parameters<typeof import('../domain/imports').commitInventoryImport> extends [unknown, unknown, ...infer R] ? R : never;
        const hash = contentHash(text);
        if (rows.some((r) => r.status === 'error' || r.status === 'needs_mapping')) throw new ops.OpError('invalid', 'Fix errors and ingredient mappings before commit');
        const lots = rows
          .filter((r) => r.input && (r.status !== 'duplicate' || includeDup))
          .map((r) => {
            const out = ops.receiveLot(s, { ...ctx, source: 'import' }, r.input!);
            return this.lotPayload(s, out.state.lots[out.state.lots.length - 1]);
          });
        // One transaction server-side: all rows land or none do; the same file is a no-op.
        result = await this.rpc('import_lots', { p_org: org, p_file: fileName, p_hash: hash, p_lots: lots });
        break;
      }
      case 'commitRecipeImport': {
        const [previews, fileName, text] = a as [import('../domain/imports').RecipeImportPreview[], string, string];
        const hash = contentHash(text);
        if (s.imports.some((i) => i.kind === 'recipes' && i.contentHash === hash)) return { state: s, result: { importId: hash, created: 0 } as CommandResult<K>, replayed: true };
        if (previews.some((p) => !p.draft)) throw new ops.OpError('invalid', 'Fix errors before committing');
        const ids: string[] = [];
        for (const p of previews) ids.push(((await this.run('saveRecipe', p.draft!)).result as { recipeId: string }).recipeId);
        await this.rpc('register_import', { p_org: org, p_kind: 'recipes', p_file: fileName, p_hash: hash, p_rows: previews.length, p_ids: ids });
        result = { importId: hash, created: ids.length };
        break;
      }
      case 'commitMenuImport': {
        const [previews, fileName, text] = a as [import('../domain/imports').MenuImportPreview[], string, string];
        const hash = contentHash(text);
        if (s.imports.some((i) => i.kind === 'menu' && i.contentHash === hash)) return { state: s, result: { created: 0 } as CommandResult<K>, replayed: true };
        if (previews.some((p) => p.errors.length)) throw new ops.OpError('invalid', 'Fix errors before committing');
        const ids: string[] = [];
        for (const p of previews) {
          ids.push(((await this.run('upsertMenuItem', { workspace: p.workspace!, name: p.name, recipeId: p.recipeId, recipeVersionId: null, mappingStatus: p.recipeId ? 'unverified' : 'missing', expectedPortions: p.expectedPortions, salePrice: p.salePrice, active: true })).result as { id: string }).id);
        }
        await this.rpc('register_import', { p_org: org, p_kind: 'menu', p_file: fileName, p_hash: hash, p_rows: previews.length, p_ids: ids });
        result = { created: ids.length };
        break;
      }
      case 'saveShoppingList': {
        const out = ops.saveShoppingList(s, ctx, a[0] as never);
        const l = out.state.shoppingLists.find((x) => x.id === out.result.id)!;
        await this.upsert('shopping_lists', { id: l.id, org_id: org, workspace: l.workspace, service_date: l.serviceDate, selections: l.selections });
        result = out.result;
        break;
      }
      default:
        throw new ops.OpError('not_supported', `Unknown command ${String(cmd)}`);
    }
    const state = await this.load();
    return { state, result: result as CommandResult<K> };
  }
}
