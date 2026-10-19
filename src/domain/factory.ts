// Small constructors used by seed data, imports, and tests.

import { DEFAULT_POLICY } from './eligibility';
import type { AppState, Ingredient, Lot, Recipe, RecipeLine, RecipeVersion } from './types';

let counter = 0;
export function newId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}_${g.crypto.randomUUID()}`;
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function makeIngredient(p: Partial<Ingredient> & Pick<Ingredient, 'id' | 'name' | 'dimension'>): Ingredient {
  return {
    orgId: 'org_demo',
    category: 'other',
    aliases: [],
    allergens: [],
    allergensVerified: true,
    diet: { vegetarian: true, vegan: true },
    alcoholic: false,
    perishable: false,
    pantryStaple: false,
    conversions: [],
    edibleYield: null,
    referenceCost: null,
    ...p,
  };
}

export function makeLot(p: Partial<Lot> & Pick<Lot, 'id' | 'ingredientId' | 'quantity' | 'pool'>): Lot {
  return {
    orgId: 'org_demo',
    form: 'raw',
    enteredQuantity: p.quantity,
    enteredUnit: 'g',
    storage: 'dry',
    receivedAt: '2026-10-01T15:00:00.000Z',
    dateProvenance: 'label',
    dateVerification: 'verified',
    status: 'available',
    version: 1,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...p,
  };
}

export type LineSpec = [ingredientId: string | null, quantity: number | null, unit: RecipeLine['unit'], extra?: Partial<RecipeLine>];

export function lines(prefix: string, specs: LineSpec[]): RecipeLine[] {
  return specs.map(([ingredientId, quantity, unit, extra], i) => ({
    id: `${prefix}_l${i + 1}`,
    ingredientId,
    form: 'raw',
    quantity,
    unit,
    optional: false,
    basis: 'as_purchased',
    ...extra,
  }));
}

export function makeRecipe(
  p: Omit<Partial<Recipe>, 'versions'> & Pick<Recipe, 'id' | 'name' | 'workspaces' | 'category'> & {
    version: Partial<RecipeVersion> & { lines: RecipeLine[] };
  },
): Recipe {
  const vId = `${p.id}_v1`;
  const version: RecipeVersion = {
    id: vId,
    recipeId: p.id,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    yield: { quantity: 1, unit: 'serving' },
    servings: 1,
    method: [],
    equipment: [],
    activeMinutes: null,
    totalMinutes: null,
    allergenStatus: 'unverified',
    confirmed: true,
    ...p.version,
  };
  const { version: _v, ...rest } = p;
  void _v;
  return {
    orgId: null,
    tags: [],
    provenance: { kind: 'starter', source: 'Table Zero starter library (original)', license: 'Original content, free to use and adapt' },
    currentVersionId: vId,
    versions: [version],
    produces: null,
    ...rest,
  };
}

export function emptyState(over: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 1,
    mode: 'demo',
    org: { id: 'org_demo', name: 'Demo Kitchen & Bar', timezone: 'America/New_York', currency: 'USD', policy: { ...DEFAULT_POLICY }, confirmedStaples: [], targetCostPct: 0.28 },
    currentUser: { id: 'user_manager', name: 'Demo Manager', role: 'manager', workspaces: ['food', 'bar'] },
    ingredients: [],
    lots: [],
    movements: [],
    recipes: [],
    menuItems: [],
    protections: [],
    plans: [],
    reservations: [],
    prepBatches: [],
    shoppingLists: [],
    imports: [],
    audit: [],
    idempotency: {},
    clock: { override: null },
    equipment: [],
    ...over,
  };
}
