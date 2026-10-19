// Core domain types shared by the engine, repositories, and UI.
// Quantities on lots, reservations, and movements are stored in the ingredient's
// base unit (g, ml, or each). Entered units are preserved for display/provenance.

export type Workspace = 'food' | 'bar';
export type Pool = 'food' | 'bar' | 'shared';
export type Form = 'raw' | 'cooked' | 'prepared';
export type Dimension = 'mass' | 'volume' | 'count';
export type Role = 'owner' | 'manager' | 'staff';

export const WORKSPACES: Workspace[] = ['food', 'bar'];
export const POOLS: Pool[] = ['food', 'bar', 'shared'];
export const FORMS: Form[] = ['raw', 'cooked', 'prepared'];

export type UnitCode =
  | 'g' | 'kg' | 'oz' | 'lb'
  | 'ml' | 'l' | 'fl_oz' | 'cup' | 'tbsp' | 'tsp'
  | 'each' | 'dozen'
  | 'bottle' | 'case' | 'pack' | 'bunch' | 'can' | 'dash' | 'barspoon' | 'sprig' | 'wedge'
  | 'serving';

export type Allergen =
  | 'milk' | 'egg' | 'fish' | 'shellfish' | 'tree_nut' | 'peanut' | 'wheat' | 'soy' | 'sesame' | 'sulfites' | 'celery' | 'mustard';

export const ALLERGENS: Allergen[] = [
  'milk', 'egg', 'fish', 'shellfish', 'tree_nut', 'peanut', 'wheat', 'soy', 'sesame', 'sulfites', 'celery', 'mustard',
];

export type IngredientCategory =
  | 'protein' | 'produce' | 'dairy' | 'pantry' | 'grain' | 'spirit' | 'liqueur' | 'wine' | 'citrus' | 'juice'
  | 'bitters' | 'mixer' | 'syrup' | 'prepared' | 'herb' | 'other';

export interface Conversion {
  // fromQty fromUnit == toQty toUnit, for this ingredient only.
  fromQty: number;
  fromUnit: UnitCode;
  toQty: number;
  toUnit: UnitCode;
  note?: string;
  verified: boolean;
}

export interface Alias {
  text: string;
  confirmed: boolean;
}

export interface CostRef {
  amount: number; // currency amount
  perQuantity: number;
  perUnit: UnitCode;
}

export interface Ingredient {
  id: string;
  orgId: string;
  name: string;
  category: IngredientCategory;
  dimension: Dimension;
  aliases: Alias[];
  /** null = allergen data unknown. [] = verified none of the tracked allergens. */
  allergens: Allergen[] | null;
  allergensVerified: boolean;
  diet: { vegetarian: boolean | null; vegan: boolean | null };
  /** null = unknown alcohol status */
  alcoholic: boolean | null;
  abv?: number | null;
  perishable: boolean;
  pantryStaple: boolean;
  conversions: Conversion[];
  /** Edible-portion yield (EP/AP), 0..1. Required when a recipe line is on edible basis. */
  edibleYield?: number | null;
  referenceCost?: CostRef | null;
  spiritStyle?: string | null;
  notes?: string;
}

export type LotStatus =
  | 'available' | 'needs_review' | 'quarantined' | 'spoiled' | 'discarded' | 'depleted' | 'recalled';

export const BLOCKED_STATUSES: LotStatus[] = ['quarantined', 'spoiled', 'discarded', 'depleted', 'recalled'];

export type DateType =
  | 'use_by' | 'expiration' | 'sell_by' | 'best_by' | 'package' | 'prepared_on' | 'operational_discard' | 'hard_discard' | 'none';

export type DateProvenance = 'label' | 'supplier' | 'house_policy' | 'staff_entry' | 'derived_from_inputs' | 'unknown';

export type StorageState = 'dry' | 'refrigerated' | 'frozen' | 'bar_rail' | 'other';

export interface QualityReview {
  approvedBy: string;
  approvedAt: string;
  validThrough: string; // local date, inclusive
  note: string;
}

export interface LotLineage {
  prepBatchId: string;
  recipeId: string;
  recipeVersionId: string;
  sources: { lotId: string; ingredientId: string; quantity: number }[];
  /** Earliest hard cutoff across inputs at prep time. */
  inheritedCutoff: string | null;
  /** True only if a verified rule allows the output to have its own cutoff independent of inputs. */
  cutoffRuleVerified: boolean;
}

export interface Lot {
  id: string;
  orgId: string;
  ingredientId: string;
  form: Form;
  brand?: string | null;
  product?: string | null;
  /** Base-unit quantity; null = explicitly unknown. */
  quantity: number | null;
  enteredQuantity?: number | null;
  enteredUnit: UnitCode;
  packageSize?: { quantity: number; unit: UnitCode } | null;
  pool: Pool;
  storage: StorageState;
  location?: string | null;
  receivedAt: string; // ISO timestamp
  openedOn?: string | null;
  preparedOn?: string | null;
  packageDate?: string | null;
  qualityDate?: string | null; // best-by / best-if-used-by
  sellByDate?: string | null;
  useByDate?: string | null;
  expirationDate?: string | null;
  operationalDiscardDate?: string | null;
  hardDiscardDate?: string | null;
  labelWording?: string | null;
  labelDateType?: DateType | null;
  dateProvenance: DateProvenance;
  dateVerification: 'verified' | 'unverified';
  cost?: CostRef | null;
  supplier?: string | null;
  lotRef?: string | null;
  allergens?: Allergen[] | null;
  notes?: string | null;
  status: LotStatus;
  qualityReview?: QualityReview | null;
  lineage?: LotLineage | null;
  parentLotId?: string | null;
  version: number;
  createdAt: string;
}

export type MovementType =
  | 'receipt' | 'opening' | 'adjustment' | 'waste' | 'usage' | 'prep_output' | 'transfer_out' | 'transfer_in' | 'status_change';

export interface Movement {
  id: string;
  orgId: string;
  lotId: string;
  type: MovementType;
  /** Signed base-unit delta; 0 for non-quantity events. */
  delta: number;
  fromPool?: Pool | null;
  toPool?: Pool | null;
  planId?: string | null;
  reservationId?: string | null;
  prepBatchId?: string | null;
  reason: string;
  actorId: string;
  source: 'ui' | 'import' | 'system' | 'api';
  at: string;
  idempotencyKey?: string | null;
}

export type RecipeCategory =
  | 'main' | 'side' | 'sauce' | 'dessert' | 'special'
  | 'cocktail' | 'zero_proof' | 'syrup' | 'garnish' | 'batched';

export const FOOD_CATEGORIES: RecipeCategory[] = ['main', 'side', 'sauce', 'dessert', 'special'];
export const BAR_CATEGORIES: RecipeCategory[] = ['cocktail', 'zero_proof', 'syrup', 'garnish', 'batched'];

export type ProvenanceKind = 'house' | 'starter' | 'imported' | 'ai_draft';

export interface Provenance {
  kind: ProvenanceKind;
  source?: string | null;
  license?: string | null;
  importedAt?: string | null;
}

export interface LineSubstitute {
  ingredientId: string;
  form: Form;
  quantity: number;
  unit: UnitCode;
  note: string;
}

export interface RecipeLine {
  id: string;
  /** null = unmapped (e.g. imported text not yet mapped) */
  ingredientId: string | null;
  rawText?: string | null;
  form: Form;
  /** null = unknown quantity */
  quantity: number | null;
  unit: UnitCode;
  optional: boolean;
  /** as_purchased = stock quantity; edible = trimmed quantity (needs edibleYield) */
  basis: 'as_purchased' | 'edible';
  prepNote?: string | null;
  substitutes?: LineSubstitute[];
}

export interface RecipeVersion {
  id: string;
  recipeId: string;
  version: number;
  createdAt: string;
  createdBy: string;
  lines: RecipeLine[];
  yield: { quantity: number; unit: UnitCode };
  servings: number;
  method: string[];
  equipment: string[];
  activeMinutes: number | null;
  totalMinutes: number | null;
  allergenStatus: 'verified' | 'unverified';
  /** For imports/AI drafts: ingredients, quantities, yield, omissions confirmed by a person. */
  confirmed: boolean;
  /** Verified output shelf rule for prep outputs (days after prep). null = none recorded. */
  outputHoldDays?: number | null;
  outputHoldVerified?: boolean;
  notes?: string | null;
}

export interface Recipe {
  id: string;
  /** null = public starter content */
  orgId: string | null;
  name: string;
  workspaces: Workspace[];
  category: RecipeCategory;
  tags: string[];
  cuisine?: string | null;
  provenance: Provenance;
  currentVersionId: string;
  versions: RecipeVersion[];
  /** If set, this recipe produces this ingredient/form as a prep component. */
  produces?: { ingredientId: string; form: Form } | null;
  archived?: boolean;
  description?: string | null;
}

export interface MenuItem {
  id: string;
  orgId: string;
  workspace: Workspace;
  name: string;
  recipeId: string | null;
  recipeVersionId: string | null;
  mappingStatus: 'confirmed' | 'unverified' | 'missing';
  /** Manually entered expected portions for protection. null = not provided. */
  expectedPortions: number | null;
  salePrice?: number | null;
  active: boolean;
}

export interface ProtectionEntry {
  id: string;
  orgId: string;
  workspace: Workspace;
  ingredientId: string;
  form: Form;
  quantity: number;
  unit: UnitCode;
  note?: string | null;
}

export type ReservationStatus = 'active' | 'consumed' | 'released';

export interface Reservation {
  id: string;
  orgId: string;
  planId: string;
  lotId: string;
  ingredientId: string;
  form: Form;
  quantity: number; // base units
  consumed: number; // base units consumed so far
  status: ReservationStatus;
  purpose: 'plan' | 'menu';
  workspace: Workspace;
  menuItemId?: string | null;
  serviceDate: string;
  createdAt: string;
  createdBy: string;
}

export interface PlanTarget {
  recipeId: string;
  recipeVersionId: string;
  requested: RequestedYield;
}

export type RequestedYield = { kind: 'servings'; servings: number } | { kind: 'quantity'; quantity: number; unit: UnitCode };

export type PlanStatus = 'draft' | 'reserved' | 'completed' | 'cancelled';

export interface PlanAllocationSnapshot {
  lotId: string;
  ingredientId: string;
  form: Form;
  quantity: number;
  lotVersion: number;
}

export interface Plan {
  id: string;
  orgId: string;
  workspace: Workspace;
  name: string;
  kind: 'special' | 'prep' | 'drink' | 'component';
  serviceDate: string;
  targets: PlanTarget[];
  status: PlanStatus;
  options: { protectMenu: boolean; componentStrategy: ComponentStrategy; priorityLotIds: string[] };
  /** Fingerprint of inputs at last validation; differs => stale. */
  basisHash: string | null;
  allocations: PlanAllocationSnapshot[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  notes?: string | null;
  source: 'manual' | 'ai_draft';
}

export interface PrepBatch {
  id: string;
  orgId: string;
  planId: string;
  recipeId: string;
  recipeVersionId: string;
  outputLotId: string;
  outputQuantity: number;
  preparedOn: string;
  pool: Pool;
  createdBy: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  reason?: string | null;
  source: 'ui' | 'import' | 'system' | 'api';
  at: string;
  details?: Record<string, unknown>;
}

export type ComponentStrategy = 'prefer_stock' | 'prepare_fresh' | 'stock_only';

export interface DatePolicy {
  /** true: a lot is usable on its cutoff date; unusable the day after. */
  cutoffInclusive: boolean;
  useByIsHard: boolean;
  expirationIsHard: boolean;
  sellByPassed: 'info' | 'review';
  requireCutoffForPerishable: boolean;
  requireVerifiedDatesForPerishable: boolean;
  alertDays: number;
  jurisdictionNote: string;
}

export interface ConfirmedStaple {
  ingredientId: string;
  assumeZeroCost: boolean;
  confirmedBy: string;
  confirmedAt: string;
}

export interface OrgSettings {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  policy: DatePolicy;
  confirmedStaples: ConfirmedStaple[];
  targetCostPct?: number | null;
}

export interface CurrentUser {
  id: string;
  name: string;
  role: Role;
  workspaces: Workspace[];
}

export interface ShoppingSelection {
  recipeId: string;
  recipeVersionId: string;
  requested: RequestedYield;
}

export interface ShoppingList {
  id: string;
  orgId: string;
  workspace: Workspace;
  serviceDate: string;
  selections: ShoppingSelection[];
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  orgId: string;
  kind: 'inventory' | 'recipes' | 'menu';
  fileName: string;
  contentHash: string;
  rowCount: number;
  committedAt: string;
  createdIds: string[];
  actorId: string;
}

export interface AppState {
  schemaVersion: number;
  mode: 'demo' | 'live';
  org: OrgSettings;
  currentUser: CurrentUser;
  ingredients: Ingredient[];
  lots: Lot[];
  movements: Movement[];
  recipes: Recipe[];
  menuItems: MenuItem[];
  protections: ProtectionEntry[];
  plans: Plan[];
  reservations: Reservation[];
  prepBatches: PrepBatch[];
  shoppingLists: ShoppingList[];
  imports: ImportRecord[];
  audit: AuditEvent[];
  /** idempotency key -> serialized result reference */
  idempotency: Record<string, string>;
  clock: { override: string | null };
  equipment: string[];
}
