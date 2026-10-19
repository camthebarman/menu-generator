// Demo dataset. All dates are relative to an anchor date so the demo stays meaningful whenever it
// is seeded. Clearly labeled DEMO: it lives only in this browser and never syncs.

import { addDays } from '../domain/dates';
import { emptyState, makeLot, makeRecipe } from '../domain/factory';
import type { AppState, CostRef, Lot, Movement } from '../domain/types';
import { toIngredientBase } from '../domain/units';
import { SEED_INGREDIENTS } from './ingredients';
import { STARTER_RECIPES } from './recipes';

export const DEMO_ORG_ID = 'org_demo';

type LotSpec = Partial<Lot> & { ing: string; qty: number | null; unit?: Lot['enteredUnit']; pool: Lot['pool']; recv: number; cost?: CostRef | null };

export function buildDemoState(anchor: string, timeZone = 'America/New_York'): AppState {
  const d = (n: number) => addDays(anchor, n);
  const recvAt = (n: number) => `${d(n)}T14:00:00.000Z`;
  const byId = new Map(SEED_INGREDIENTS.map((i) => [i.id, i]));
  let n = 0;
  const L = (s: LotSpec): Lot => {
    n += 1;
    const ing = byId.get(s.ing)!;
    const unit = s.unit ?? (ing.dimension === 'mass' ? 'g' : ing.dimension === 'volume' ? 'ml' : 'each');
    let base: number | null = null;
    if (s.qty !== null) {
      const conv = toIngredientBase(s.qty, unit, ing, s.packageSize);
      if (!conv.ok) throw new Error(`seed conversion ${s.ing}: ${conv.reason}`);
      base = conv.value;
    }
    const { ing: _i, qty: _q, unit: _u, recv, cost, ...rest } = s;
    void _i; void _q; void _u;
    return makeLot({
      id: `lot_demo_${String(n).padStart(3, '0')}`, orgId: DEMO_ORG_ID, ingredientId: s.ing, quantity: base, enteredQuantity: s.qty, enteredUnit: unit,
      receivedAt: recvAt(recv), createdAt: recvAt(recv), dateVerification: 'verified', dateProvenance: 'label', cost: cost ?? null,
      storage: ing.perishable ? 'refrigerated' : 'dry', ...rest,
    });
  };
  const perKg = (amount: number): CostRef => ({ amount, perQuantity: 1, perUnit: 'kg' });
  const perL = (amount: number): CostRef => ({ amount, perQuantity: 1, perUnit: 'l' });
  const perBottle = (amount: number, ml = 750): CostRef => ({ amount, perQuantity: ml, perUnit: 'ml' });
  const each = (amount: number): CostRef => ({ amount, perQuantity: 1, perUnit: 'each' });
  const house = { dateProvenance: 'house_policy' as const };

  const lots: Lot[] = [
    // ---------------- Food pool
    L({ ing: 'chicken_thigh', qty: 3.2, unit: 'kg', pool: 'food', recv: -3, useByDate: d(1), lotRef: 'CHK-0412', supplier: 'Valley Poultry', cost: perKg(9.7), labelWording: 'USE BY', labelDateType: 'use_by' }),
    L({ ing: 'chicken_thigh', qty: 2, unit: 'kg', pool: 'food', recv: 0, useByDate: d(5), lotRef: 'CHK-0419', supplier: 'Valley Poultry', cost: perKg(9.7) }),
    L({ ing: 'ground_beef', qty: 4.5, unit: 'kg', pool: 'food', recv: -1, useByDate: d(3), lotRef: 'GB-221', cost: perKg(11), supplier: 'Prairie Meats' }),
    L({ ing: 'salmon', qty: 1.2, unit: 'kg', pool: 'food', recv: -1, useByDate: d(2), lotRef: 'SAL-88', cost: perKg(26) }),
    L({ ing: 'pork_shoulder', qty: 3, unit: 'kg', pool: 'food', recv: -2, useByDate: d(4), lotRef: 'PRK-17', cost: perKg(7.5) }),
    L({ ing: 'tofu', qty: 800, pool: 'food', recv: -4, useByDate: d(10), lotRef: 'TOF-3', cost: perKg(5) }),
    L({ ing: 'potato', qty: 5, unit: 'kg', pool: 'food', recv: -6, lotRef: 'POT-1', cost: perKg(2.2), storage: 'dry', dateProvenance: 'unknown' }),
    L({ ing: 'carrot', qty: 2, unit: 'kg', pool: 'food', recv: -5, operationalDiscardDate: d(6), ...house, lotRef: 'CAR-1', cost: perKg(1.8) }),
    L({ ing: 'onion', qty: 3, unit: 'kg', pool: 'food', recv: -8, lotRef: 'ONI-1', cost: perKg(1.6), dateProvenance: 'unknown' }),
    L({ ing: 'red_onion', qty: 1, unit: 'kg', pool: 'food', recv: -4, lotRef: 'RON-1', cost: perKg(2.4), dateProvenance: 'unknown' }),
    L({ ing: 'garlic', qty: 500, pool: 'shared', recv: -10, lotRef: 'GAR-1', cost: perKg(8), dateProvenance: 'unknown' }),
    L({ ing: 'shallot', qty: 300, pool: 'food', recv: -6, lotRef: 'SHA-1', dateProvenance: 'unknown' }),
    L({ ing: 'romaine', qty: 1.5, unit: 'kg', pool: 'food', recv: -2, operationalDiscardDate: d(3), ...house, lotRef: 'ROM-1', cost: perKg(4.4) }),
    L({ ing: 'cucumber', qty: 1, unit: 'kg', pool: 'shared', recv: -2, operationalDiscardDate: d(4), ...house, lotRef: 'CUC-1', cost: perKg(3) }),
    L({ ing: 'tomato', qty: 1.2, unit: 'kg', pool: 'food', recv: -2, operationalDiscardDate: d(3), ...house, lotRef: 'TOM-1', cost: perKg(4.8) }),
    L({ ing: 'bell_pepper', qty: 800, pool: 'food', recv: -3, operationalDiscardDate: d(5), ...house, lotRef: 'PEP-1', cost: perKg(5.5) }),
    L({ ing: 'mushroom', qty: 600, pool: 'food', recv: -4, operationalDiscardDate: d(1), ...house, lotRef: 'MUSH-7', cost: perKg(9) }),
    L({ ing: 'scallion', qty: 200, pool: 'food', recv: -2, operationalDiscardDate: d(3), ...house, lotRef: 'SCA-1' }),
    L({ ing: 'apple', qty: 2, unit: 'kg', pool: 'food', recv: -5, operationalDiscardDate: d(7), ...house, lotRef: 'APL-1', cost: perKg(3.3) }),
    L({ ing: 'parsley', qty: 150, pool: 'food', recv: -2, operationalDiscardDate: d(2), ...house, lotRef: 'PAR-1' }),
    L({ ing: 'cilantro', qty: 100, pool: 'food', recv: -3, operationalDiscardDate: d(1), ...house, lotRef: 'CIL-1' }),
    L({ ing: 'thyme', qty: 30, pool: 'food', recv: -3, operationalDiscardDate: d(6), ...house, lotRef: 'THY-1' }),
    L({ ing: 'butter', qty: 2, unit: 'kg', pool: 'food', recv: -7, useByDate: d(30), lotRef: 'BTR-1', cost: perKg(9) }),
    L({ ing: 'whole_milk', qty: 2, unit: 'l', pool: 'food', recv: -2, useByDate: d(5), lotRef: 'MLK-1', cost: perL(1.4) }),
    // Passed quality (best-by) date: requires manager review, not automatically unsafe or safe.
    L({ ing: 'parmesan', qty: 500, pool: 'food', recv: -40, qualityDate: d(-3), labelWording: 'BEST IF USED BY', labelDateType: 'best_by', lotRef: 'PARM-2', cost: perKg(28) }),
    L({ ing: 'feta', qty: 400, pool: 'food', recv: -5, useByDate: d(8), lotRef: 'FETA-1', cost: perKg(12) }),
    L({ ing: 'cheddar', qty: 60, unit: 'each', pool: 'food', recv: -5, useByDate: d(20), lotRef: 'CHD-1', cost: perKg(13) }),
    L({ ing: 'rice', qty: 10, unit: 'kg', pool: 'food', recv: -40, lotRef: 'RICE-50', cost: perKg(3.2), dateProvenance: 'unknown' }),
    // Hard-discard-past cooked rice: never allocated, never "rescued" by reheating.
    L({ ing: 'rice', form: 'cooked', qty: 1.5, unit: 'kg', pool: 'food', recv: -4, preparedOn: d(-4), hardDiscardDate: d(-1), ...house, lotRef: 'RICE-COOKED-4', storage: 'refrigerated' }),
    L({ ing: 'flour', qty: 5, unit: 'kg', pool: 'food', recv: -30, lotRef: 'FLR-1', cost: perKg(1.4), dateProvenance: 'unknown' }),
    L({ ing: 'brown_sugar', qty: 1, unit: 'kg', pool: 'food', recv: -30, lotRef: 'BSG-1', dateProvenance: 'unknown' }),
    L({ ing: 'oats', qty: 1, unit: 'kg', pool: 'food', recv: -20, lotRef: 'OAT-1', dateProvenance: 'unknown' }),
    L({ ing: 'pasta', qty: 3, unit: 'kg', pool: 'food', recv: -25, lotRef: 'PAS-1', cost: perKg(2.5), dateProvenance: 'unknown' }),
    L({ ing: 'soy_sauce', qty: 1, unit: 'l', pool: 'food', recv: -60, lotRef: 'SOY-1', dateProvenance: 'unknown' }),
    L({ ing: 'sesame_oil', qty: 250, pool: 'food', recv: -60, lotRef: 'SES-1', dateProvenance: 'unknown' }),
    L({ ing: 'olive_oil', qty: 3, unit: 'l', pool: 'food', recv: -15, lotRef: 'EVOO-1', cost: perL(14), dateProvenance: 'unknown' }),
    L({ ing: 'neutral_oil', qty: 5, unit: 'l', pool: 'food', recv: -15, lotRef: 'CAN-1', cost: perL(3.5), dateProvenance: 'unknown' }),
    L({ ing: 'red_wine_vinegar', qty: 1, unit: 'l', pool: 'food', recv: -50, lotRef: 'RWV-1', dateProvenance: 'unknown' }),
    L({ ing: 'dijon', qty: 500, pool: 'food', recv: -30, lotRef: 'DIJ-1', dateProvenance: 'unknown' }),
    L({ ing: 'canned_tomato', qty: 6, unit: 'can', packageSize: { quantity: 794, unit: 'g' }, pool: 'food', recv: -30, lotRef: 'CTOM-1', cost: { amount: 3.2, perQuantity: 1, perUnit: 'can' }, dateProvenance: 'unknown' }),
    L({ ing: 'chickpeas', qty: 4, unit: 'can', packageSize: { quantity: 425, unit: 'g' }, pool: 'food', recv: -30, lotRef: 'CHP-1', dateProvenance: 'unknown' }),
    L({ ing: 'dark_chocolate', qty: 600, pool: 'food', recv: -20, lotRef: 'CHOC-1', cost: perKg(18), dateProvenance: 'unknown' }),
    L({ ing: 'vanilla', qty: 120, pool: 'food', recv: -90, lotRef: 'VAN-1', dateProvenance: 'unknown' }),
    L({ ing: 'burger_bun', qty: 30, pool: 'food', recv: -1, useByDate: d(3), lotRef: 'BUN-1', cost: each(0.65) }),
    L({ ing: 'tortilla', qty: 40, pool: 'food', recv: -3, useByDate: d(10), lotRef: 'TOR-1', cost: each(0.08) }),
    L({ ing: 'chili_flake', qty: 100, pool: 'food', recv: -60, lotRef: 'CHI-1', dateProvenance: 'unknown' }),
    L({ ing: 'cumin', qty: 100, pool: 'food', recv: -60, lotRef: 'CUM-1', dateProvenance: 'unknown' }),
    L({ ing: 'paprika', qty: 100, pool: 'food', recv: -60, lotRef: 'PAP-1', dateProvenance: 'unknown' }),
    L({ ing: 'mystery_hot_sauce', qty: 500, pool: 'food', recv: -2, lotRef: 'SAMPLE-1', dateProvenance: 'unknown', notes: 'Supplier sample — allergen sheet not received' }),
    // Prepared components already in stock (lineage recorded at prep time in real use)
    L({ ing: 'aioli', form: 'prepared', qty: 400, pool: 'food', recv: -1, preparedOn: d(-1), useByDate: d(2), ...house, lotRef: 'PREP-AIOLI', storage: 'refrigerated' }),
    L({ ing: 'vinaigrette', form: 'prepared', qty: 500, pool: 'food', recv: -2, preparedOn: d(-2), useByDate: d(5), ...house, lotRef: 'PREP-VIN', storage: 'refrigerated' }),
    // ---------------- Shared pool
    L({ ing: 'eggs', qty: 30, pool: 'shared', recv: -3, useByDate: d(18), lotRef: 'EGG-1', cost: each(0.35) }),
    L({ ing: 'heavy_cream', qty: 600, pool: 'shared', recv: -2, useByDate: d(6), lotRef: 'CRM-1', cost: perL(5.2) }),
    // Opened container with an unknown remaining amount: stays unresolved and visible.
    L({ ing: 'heavy_cream', qty: null, pool: 'shared', recv: -6, useByDate: d(3), openedOn: d(-1), lotRef: 'CRM-OPEN', notes: 'Opened; remaining amount not counted' }),
    L({ ing: 'sugar', qty: 10, unit: 'kg', pool: 'shared', recv: -20, lotRef: 'SUG-1', cost: perKg(1.8), dateProvenance: 'unknown' }),
    L({ ing: 'honey', qty: 1, unit: 'kg', pool: 'shared', recv: -40, lotRef: 'HON-1', cost: perKg(12), dateProvenance: 'unknown' }),
    L({ ing: 'cider_vinegar', qty: 2, unit: 'l', pool: 'shared', recv: -40, lotRef: 'ACV-1', dateProvenance: 'unknown' }),
    L({ ing: 'ginger', qty: 400, pool: 'shared', recv: -5, lotRef: 'GIN-ROOT', dateProvenance: 'unknown' }),
    L({ ing: 'lemon', qty: 20, pool: 'shared', recv: -3, operationalDiscardDate: d(10), ...house, lotRef: 'LEM-1', cost: each(0.45) }),
    L({ ing: 'lime', qty: 40, pool: 'shared', recv: -2, operationalDiscardDate: d(9), ...house, lotRef: 'LIM-1', cost: each(0.3) }),
    L({ ing: 'orange', qty: 10, pool: 'shared', recv: -3, operationalDiscardDate: d(12), ...house, lotRef: 'ORA-1', cost: each(0.6) }),
    L({ ing: 'rosemary', qty: 60, pool: 'shared', recv: -2, operationalDiscardDate: d(6), ...house, lotRef: 'ROS-1' }),
    L({ ing: 'lemon_juice', form: 'prepared', qty: 200, pool: 'shared', recv: 0, preparedOn: d(0), useByDate: d(1), ...house, lotRef: 'PREP-LEMON', storage: 'refrigerated' }),
    L({ ing: 'lime_juice', form: 'prepared', qty: 300, pool: 'shared', recv: 0, preparedOn: d(0), useByDate: d(0), ...house, lotRef: 'PREP-LIME', storage: 'refrigerated' }),
    // ---------------- Bar pool
    L({ ing: 'gin', qty: 2, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', recv: -14, lotRef: 'GIN-1', cost: perBottle(22) }),
    L({ ing: 'white_rum', qty: 1, unit: 'bottle', packageSize: { quantity: 1, unit: 'l' }, pool: 'bar', recv: -14, lotRef: 'RUM-W', cost: perBottle(19, 1000) }),
    L({ ing: 'aged_rum', qty: 1, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', recv: -30, lotRef: 'RUM-A', cost: perBottle(30) }),
    L({ ing: 'tequila', qty: 2, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', recv: -10, lotRef: 'TEQ-1', cost: perBottle(28) }),
    L({ ing: 'mezcal', qty: 1, unit: 'bottle', packageSize: { quantity: 700, unit: 'ml' }, pool: 'bar', recv: -30, lotRef: 'MEZ-1', cost: perBottle(42, 700) }),
    L({ ing: 'bourbon', qty: 2, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', recv: -20, lotRef: 'BOU-1', cost: perBottle(30) }),
    L({ ing: 'rye', qty: 700, unit: 'ml', pool: 'bar', recv: -30, lotRef: 'RYE-1', cost: perBottle(34, 700) }),
    L({ ing: 'vodka', qty: 1, unit: 'l', pool: 'bar', recv: -20, lotRef: 'VOD-1', cost: perBottle(20, 1000) }),
    L({ ing: 'sweet_vermouth', qty: 500, pool: 'bar', recv: -15, openedOn: d(-10), operationalDiscardDate: d(20), ...house, lotRef: 'VER-1', cost: perBottle(14, 1000), storage: 'refrigerated' }),
    L({ ing: 'orange_aperitivo', qty: 750, pool: 'bar', recv: -15, lotRef: 'APE-1', cost: perBottle(24) }),
    // Opened coffee liqueur with only 30 ml left: insufficient, not missing.
    L({ ing: 'coffee_liqueur', qty: 30, pool: 'bar', recv: -60, lotRef: 'COF-1', cost: perBottle(21) }),
    L({ ing: 'prosecco', qty: 2, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', recv: -5, lotRef: 'PRO-1', cost: perBottle(13) }),
    L({ ing: 'aromatic_bitters', qty: 200, pool: 'bar', recv: -60, lotRef: 'BIT-A', cost: perBottle(12, 200) }),
    L({ ing: 'orange_bitters', qty: 100, pool: 'bar', recv: -60, lotRef: 'BIT-O' }),
    L({ ing: 'soda_water', qty: 24, unit: 'can', packageSize: { quantity: 355, unit: 'ml' }, pool: 'bar', recv: -5, lotRef: 'SODA-1', cost: { amount: 0.5, perQuantity: 1, perUnit: 'can' } }),
    L({ ing: 'tonic', qty: 12, unit: 'can', packageSize: { quantity: 200, unit: 'ml' }, pool: 'bar', recv: -5, lotRef: 'TON-1', cost: { amount: 0.9, perQuantity: 1, perUnit: 'can' } }),
    L({ ing: 'ginger_beer', qty: 6, unit: 'can', packageSize: { quantity: 355, unit: 'ml' }, pool: 'bar', recv: -5, lotRef: 'GB-1' }),
    L({ ing: 'grapefruit', qty: 6, pool: 'bar', recv: -3, operationalDiscardDate: d(10), ...house, lotRef: 'GRP-1', cost: each(1.1) }),
    L({ ing: 'mint', qty: 120, pool: 'bar', recv: -1, operationalDiscardDate: d(2), ...house, lotRef: 'MINT-1' }),
    L({ ing: 'simple_syrup', form: 'prepared', qty: 1, unit: 'l', pool: 'bar', recv: -3, preparedOn: d(-3), useByDate: d(20), ...house, lotRef: 'PREP-SS', storage: 'refrigerated', cost: perL(1.2) }),
    // Ginger syrup with an unverified date (handwritten label): perishable => needs review.
    L({ ing: 'ginger_syrup', form: 'prepared', qty: 250, pool: 'bar', recv: -6, preparedOn: d(-6), useByDate: d(4), dateVerification: 'unverified', dateProvenance: 'staff_entry', labelWording: 'handwritten "good til Fri?"', lotRef: 'PREP-GS', storage: 'refrigerated' }),
  ];
  const movements: Movement[] = lots.map((l) => ({
    id: `mov_seed_${l.id}`, orgId: DEMO_ORG_ID, lotId: l.id, type: l.lineage ? 'prep_output' : 'receipt', delta: l.quantity ?? 0, reason: 'Demo seed', actorId: 'system', source: 'system', at: l.receivedAt,
  }));

  const recipes = [...STARTER_RECIPES.map((r) => structuredClone(r))];
  // An imported recipe whose description is not yet a complete recipe.
  recipes.push(makeRecipe({
    id: 'imp_gochujang_chicken', orgId: DEMO_ORG_ID, name: 'Gochujang glazed chicken (imported)', workspaces: ['food'], category: 'special', tags: ['imported'],
    provenance: { kind: 'imported', source: 'sample-import.json (supplier menu description)', importedAt: `${d(-1)}T12:00:00.000Z` },
    version: {
      confirmed: false, servings: 4, method: ['Glaze grilled chicken thighs with gochujang sauce.'], allergenStatus: 'unverified',
      lines: [
        { id: 'imp_g_l1', ingredientId: 'chicken_thigh', form: 'raw', quantity: 700, unit: 'g', optional: false, basis: 'as_purchased' },
        { id: 'imp_g_l2', ingredientId: null, rawText: 'gochujang', form: 'raw', quantity: 60, unit: 'g', optional: false, basis: 'as_purchased' },
        { id: 'imp_g_l3', ingredientId: 'honey', form: 'raw', quantity: null, unit: 'g', optional: false, basis: 'as_purchased', rawText: 'honey (amount not stated)' },
      ],
    },
  }));

  const v = (id: string) => recipes.find((r) => r.id === id)!.currentVersionId;
  const state = emptyState({
    mode: 'demo',
    org: {
      id: DEMO_ORG_ID, name: 'Table Zero Demo Kitchen & Bar', timezone: timeZone, currency: 'USD', targetCostPct: 0.28,
      policy: {
        cutoffInclusive: true, useByIsHard: true, expirationIsHard: true, sellByPassed: 'info', requireCutoffForPerishable: true,
        requireVerifiedDatesForPerishable: true, alertDays: 2,
        jurisdictionNote: 'DEMO policy. Configure to match your local health code and verified operating procedures; these defaults are not a compliance determination.',
      },
      confirmedStaples: [
        { ingredientId: 'salt', assumeZeroCost: true, confirmedBy: 'Demo Manager', confirmedAt: `${d(-30)}T12:00:00.000Z` },
        { ingredientId: 'black_pepper', assumeZeroCost: true, confirmedBy: 'Demo Manager', confirmedAt: `${d(-30)}T12:00:00.000Z` },
        { ingredientId: 'water', assumeZeroCost: true, confirmedBy: 'Demo Manager', confirmedAt: `${d(-30)}T12:00:00.000Z` },
        { ingredientId: 'ice', assumeZeroCost: true, confirmedBy: 'Demo Manager', confirmedAt: `${d(-30)}T12:00:00.000Z` },
      ],
    },
    currentUser: { id: 'user_demo_manager', name: 'Demo Manager', role: 'manager', workspaces: ['food', 'bar'] },
    ingredients: SEED_INGREDIENTS.map((i) => structuredClone(i)),
    lots,
    movements,
    recipes,
    menuItems: [
      { id: 'menu_burger', orgId: DEMO_ORG_ID, workspace: 'food', name: 'Smash burger', recipeId: 'st_smash_burger', recipeVersionId: v('st_smash_burger'), mappingStatus: 'confirmed', expectedPortions: 28, salePrice: 16, active: true },
      { id: 'menu_thighs', orgId: DEMO_ORG_ID, workspace: 'food', name: 'Crispy chicken thighs', recipeId: 'st_crispy_thighs', recipeVersionId: v('st_crispy_thighs'), mappingStatus: 'confirmed', expectedPortions: 12, salePrice: 24, active: true },
      { id: 'menu_salad', orgId: DEMO_ORG_ID, workspace: 'food', name: 'Garden salad', recipeId: 'st_garden_salad', recipeVersionId: v('st_garden_salad'), mappingStatus: 'confirmed', expectedPortions: 16, salePrice: 11, active: true },
      { id: 'menu_potatoes', orgId: DEMO_ORG_ID, workspace: 'food', name: 'Rosemary potatoes', recipeId: 'st_roast_potatoes', recipeVersionId: v('st_roast_potatoes'), mappingStatus: 'confirmed', expectedPortions: 20, salePrice: 7, active: true },
      { id: 'menu_pots', orgId: DEMO_ORG_ID, workspace: 'food', name: "Chef's chocolate pot", recipeId: 'st_pots_de_creme', recipeVersionId: v('st_pots_de_creme'), mappingStatus: 'unverified', expectedPortions: 8, salePrice: 10, active: true },
      { id: 'menu_daiquiri', orgId: DEMO_ORG_ID, workspace: 'bar', name: 'House daiquiri', recipeId: 'st_daiquiri', recipeVersionId: v('st_daiquiri'), mappingStatus: 'confirmed', expectedPortions: 12, salePrice: 13, active: true },
      { id: 'menu_gt', orgId: DEMO_ORG_ID, workspace: 'bar', name: 'Gin & tonic', recipeId: 'st_gin_tonic', recipeVersionId: v('st_gin_tonic'), mappingStatus: 'confirmed', expectedPortions: 20, salePrice: 11, active: true },
      { id: 'menu_of', orgId: DEMO_ORG_ID, workspace: 'bar', name: 'Old fashioned', recipeId: 'st_old_fashioned', recipeVersionId: v('st_old_fashioned'), mappingStatus: 'confirmed', expectedPortions: 10, salePrice: 14, active: true },
    ],
    protections: [
      { id: 'prot_cream_brunch', orgId: DEMO_ORG_ID, workspace: 'food', ingredientId: 'heavy_cream', form: 'raw', quantity: 300, unit: 'ml', note: 'Weekend brunch sauces' },
    ],
    equipment: ['oven', 'cast iron', 'flat-top', 'sauté pan', 'dutch oven', 'wok', 'skillet', 'rice cooker', 'sheet pan', 'immersion blender', 'saucepan', 'ramekins', 'moulds', 'whisk', 'food processor', 'shaker', 'mixing glass', 'muddler', 'juicer', 'dehydrator', 'espresso machine', 'bottles', 'funnel'],
  });
  return state;
}
