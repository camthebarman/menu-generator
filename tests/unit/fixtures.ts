import { fixedClock } from '../../src/domain/dates';
import { emptyState, lines, makeIngredient, makeLot, makeRecipe } from '../../src/domain/factory';
import type { OpCtx } from '../../src/domain/ops';
import type { AppState, Lot } from '../../src/domain/types';

// Frozen time: 2026-10-19 12:00 New York (16:00Z).
export const NOW = '2026-10-19T16:00:00.000Z';
export const TODAY = '2026-10-19';
export const clock = fixedClock(NOW);
export const manager: OpCtx = { actor: { id: 'u_mgr', name: 'Morgan (manager)', role: 'manager', workspaces: ['food', 'bar'] }, clock };
export const barStaff: OpCtx = { actor: { id: 'u_bar', name: 'Riley (bar)', role: 'staff', workspaces: ['bar'] }, clock };
export const foodStaff: OpCtx = { actor: { id: 'u_food', name: 'Sam (kitchen)', role: 'staff', workspaces: ['food'] }, clock };

export function world(extraLots: Lot[] = [], opts: { lots?: Lot[] } = {}): AppState {
  const ingredients = [
    makeIngredient({ id: 'chicken', name: 'Chicken thigh', dimension: 'mass', category: 'protein', perishable: true, diet: { vegetarian: false, vegan: false } }),
    makeIngredient({ id: 'rice', name: 'Jasmine rice', dimension: 'mass', category: 'grain' }),
    makeIngredient({ id: 'lime', name: 'Lime', dimension: 'count', category: 'citrus', perishable: true, conversions: [{ fromQty: 1, fromUnit: 'each', toQty: 67, toUnit: 'g', verified: true }] }),
    makeIngredient({ id: 'lime_juice', name: 'Lime juice (fresh)', dimension: 'volume', category: 'juice', perishable: true }),
    makeIngredient({ id: 'rum', name: 'White rum', dimension: 'volume', category: 'spirit', alcoholic: true }),
    makeIngredient({ id: 'syrup', name: 'Simple syrup', dimension: 'volume', category: 'syrup', perishable: true }),
    makeIngredient({ id: 'sugar', name: 'Sugar', dimension: 'mass', category: 'pantry' }),
    makeIngredient({ id: 'water', name: 'Water', dimension: 'volume', category: 'pantry', pantryStaple: true }),
    makeIngredient({ id: 'butter', name: 'Butter', dimension: 'mass', category: 'dairy', perishable: true, allergens: ['milk'], diet: { vegetarian: true, vegan: false } }),
    makeIngredient({ id: 'cream', name: 'Heavy cream', dimension: 'volume', category: 'dairy', perishable: true, allergens: ['milk'], diet: { vegetarian: true, vegan: false } }),
    makeIngredient({ id: 'bitters', name: 'Aromatic bitters', dimension: 'volume', category: 'bitters', alcoholic: true, conversions: [{ fromQty: 1, fromUnit: 'dash', toQty: 0.8, toUnit: 'ml', verified: true }] }),
    makeIngredient({ id: 'mint', name: 'Mint', dimension: 'mass', category: 'herb', perishable: true }),
    makeIngredient({ id: 'mystery', name: 'Mystery sauce', dimension: 'volume', allergens: null, allergensVerified: false }),
  ];
  const recipes = [
    makeRecipe({ id: 'r_rice_chicken', name: 'Chicken rice bowl', workspaces: ['food'], category: 'main', version: { servings: 1, lines: lines('rc', [['chicken', 150, 'g'], ['rice', 100, 'g']]) } }),
    makeRecipe({ id: 'r_rice', name: 'Plain rice', workspaces: ['food'], category: 'side', version: { servings: 1, lines: lines('rr', [['rice', 100, 'g']]) } }),
    makeRecipe({ id: 'r_daiquiri', name: 'Daiquiri', workspaces: ['bar'], category: 'cocktail', version: { servings: 1, lines: lines('dq', [['rum', 2, 'fl_oz'], ['lime_juice', 30, 'ml'], ['syrup', 20, 'ml']]) } }),
    makeRecipe({
      id: 'r_lime_juice', name: 'Fresh lime juice', workspaces: ['bar', 'food'], category: 'garnish', produces: { ingredientId: 'lime_juice', form: 'raw' },
      version: { servings: 10, yield: { quantity: 300, unit: 'ml' }, lines: lines('lj', [['lime', 10, 'each']]) },
    }),
    makeRecipe({
      id: 'r_syrup', name: 'Simple syrup', workspaces: ['bar'], category: 'syrup', produces: { ingredientId: 'syrup', form: 'raw' },
      version: { servings: 25, yield: { quantity: 500, unit: 'ml' }, lines: lines('ss', [['sugar', 300, 'g'], ['water', 300, 'ml']]) },
    }),
  ];
  const lots = opts.lots ?? [
    makeLot({ id: 'L_chicken', ingredientId: 'chicken', quantity: 2000, pool: 'food', useByDate: '2026-10-21', storage: 'refrigerated', lotRef: 'CHK-1' }),
    makeLot({ id: 'L_rice', ingredientId: 'rice', quantity: 500, pool: 'food', lotRef: 'RICE-1' }),
    makeLot({ id: 'L_rum', ingredientId: 'rum', quantity: 750, pool: 'bar', enteredUnit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, lotRef: 'RUM-1', cost: { amount: 18, perQuantity: 750, perUnit: 'ml' } }),
    makeLot({ id: 'L_lj', ingredientId: 'lime_juice', quantity: 100, pool: 'shared', useByDate: '2026-10-20', lotRef: 'LJ-1', enteredUnit: 'ml' }),
    makeLot({ id: 'L_syrup', ingredientId: 'syrup', quantity: 400, pool: 'bar', useByDate: '2026-11-15', lotRef: 'SS-1', enteredUnit: 'ml' }),
    ...extraLots,
  ];
  return emptyState({ ingredients, recipes, lots, movements: lots.map((l) => ({ id: `m_${l.id}`, orgId: 'org_demo', lotId: l.id, type: 'receipt' as const, delta: l.quantity ?? 0, reason: 'seed', actorId: 'system', source: 'system' as const, at: l.receivedAt })) });
}
