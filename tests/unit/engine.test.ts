import { describe, expect, it } from 'vitest';
import { buildCatalog, findComponentCycles } from '../../src/domain/catalog';
import { evaluateLot } from '../../src/domain/eligibility';
import { lines, makeIngredient, makeLot, makeRecipe } from '../../src/domain/factory';
import { match, discover, type DiscoverOptions } from '../../src/domain/match';
import { approveQualityReview } from '../../src/domain/ops';
import { balances, buildStockView } from '../../src/domain/stock';
import type { AppState } from '../../src/domain/types';
import { toIngredientBase, toMicro } from '../../src/domain/units';
import { manager, TODAY, world } from './fixtures';

const servings = (n: number) => ({ kind: 'servings' as const, servings: n });

function m(state: AppState, workspace: 'food' | 'bar', recipeIds: string[], n = 1, extra: Partial<Parameters<typeof match>[1]> = {}) {
  return match(state, { workspace, plannedDate: TODAY, targets: recipeIds.map((id) => ({ recipeId: id, requested: servings(n) })), protectMenu: true, ...extra });
}

describe('matching groups', () => {
  it('makes a recipe now when all required stock is eligible and sufficient', () => {
    const r = m(world(), 'food', ['r_rice_chicken'], 2);
    expect(r.group).toBe('make_now');
    expect(r.distinctShortageCount).toBe(0);
    expect(r.capacity.maxServings).toBe(5); // rice 500 g / 100 g
  });

  it('never labels Make now when requested yield exceeds capacity', () => {
    const r = m(world(), 'food', ['r_rice_chicken'], 6);
    expect(r.group).toBe('need_1');
    expect(r.capacity.maxServings).toBe(5);
    expect(r.shortages[0]).toMatchObject({ ingredientId: 'rice', short: 100, missingCompletely: false });
  });

  it('aggregates repeated shortage lines into one distinct ingredient', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_butter2', name: 'Double butter', workspaces: ['food'], category: 'sauce', version: { lines: lines('b2', [['butter', 50, 'g'], ['rice', 10, 'g'], ['butter', 30, 'g']]) } }));
    const r = m(s, 'food', ['r_butter2']);
    expect(r.group).toBe('need_1');
    expect(r.distinctShortageCount).toBe(1);
    expect(r.shortages[0]).toMatchObject({ ingredientId: 'butter', needed: 80, short: 80, missingCompletely: true });
  });

  it('one missing plus one insufficient yields Need 2 with exact amounts', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_two', name: 'Two short', workspaces: ['food'], category: 'main', version: { lines: lines('t2', [['butter', 40, 'g'], ['rice', 650, 'g'], ['chicken', 100, 'g']]) } }));
    const r = m(s, 'food', ['r_two']);
    expect(r.group).toBe('need_2');
    const byId = Object.fromEntries(r.shortages.map((x) => [x.ingredientId, x]));
    expect(byId.butter).toMatchObject({ missingCompletely: true, short: 40, have: 0 });
    expect(byId.rice).toMatchObject({ missingCompletely: false, short: 150, have: 500, needed: 650 });
  });

  it('unknown lot quantity makes a short ingredient Needs review, not sufficient or one-away', () => {
    const s = world([makeLot({ id: 'L_cream_unknown', ingredientId: 'cream', quantity: null, pool: 'food', useByDate: '2026-10-25', lotRef: 'CRM-?' })]);
    s.recipes.push(makeRecipe({ id: 'r_cream', name: 'Cream rice', workspaces: ['food'], category: 'side', version: { lines: lines('cr', [['cream', 100, 'ml'], ['rice', 100, 'g']]) } }));
    const r = m(s, 'food', ['r_cream']);
    expect(r.group).toBe('needs_review');
    expect(r.issues.some((i) => i.code === 'unknown_lot_quantity')).toBe(true);
  });

  it('missing conversion makes Needs review', () => {
    const s = world([makeLot({ id: 'L_mint', ingredientId: 'mint', quantity: 200, pool: 'bar', useByDate: '2026-10-22' })]);
    s.recipes.push(makeRecipe({ id: 'r_mint', name: 'Mint thing', workspaces: ['bar'], category: 'garnish', version: { lines: lines('mt', [['mint', 1, 'bunch']]) } }));
    const r = m(s, 'bar', ['r_mint']);
    expect(r.group).toBe('needs_review');
    expect(r.issues[0].code).toBe('missing_conversion');
  });

  it('unmapped imported line and unconfirmed recipe are Needs review', () => {
    const s = world();
    const rec = makeRecipe({ id: 'r_imp', name: 'Imported', workspaces: ['food'], category: 'main', provenance: { kind: 'imported', source: 'test.csv' }, version: { confirmed: false, lines: lines('im', [[null, 2, 'tbsp', { rawText: 'gochujang' }], ['rice', 100, 'g']]) } });
    s.recipes.push(rec);
    const r = m(s, 'food', ['r_imp']);
    expect(r.group).toBe('needs_review');
    expect(r.issues.map((i) => i.code).sort()).toEqual(['unconfirmed_recipe', 'unmapped_ingredient']);
  });
});

describe('pools, protection and conversion', () => {
  it('Food-pool stock is unavailable to Bar without a transfer', () => {
    const s = world();
    s.lots.find((l) => l.id === 'L_rum')!.pool = 'food';
    const r = m(s, 'bar', ['r_daiquiri']);
    expect(r.group).toBe('need_1');
    expect(r.shortages[0].ingredientId).toBe('rum');
  });

  it('menu protection with unit conversion produces exact free quantity', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_menu_chicken', name: 'Menu chicken', workspaces: ['food'], category: 'main', version: { lines: lines('mc', [['chicken', 6, 'oz']]) } }));
    s.menuItems.push({ id: 'mi1', orgId: 'org_demo', workspace: 'food', name: 'Chicken plate', recipeId: 'r_menu_chicken', recipeVersionId: 'r_menu_chicken_v1', mappingStatus: 'confirmed', expectedPortions: 10, active: true });
    const view = buildStockView(s, { workspace: 'food', plannedDate: TODAY, protectMenu: true });
    const chicken = balances(view).find((b) => b.ingredientId === 'chicken')!;
    const protectedG = 10 * 6 * 28.349523125;
    expect(chicken.physical).toBe(2000);
    expect(chicken.menuProtected).toBeCloseTo(protectedG, 5);
    expect(chicken.freeForSpecials).toBeCloseTo(2000 - protectedG, 5);
    expect(view.protection.incomplete).toBe(false);
    // 2 bowls need 300 g but only ~299.03 g is free => Need 1 with menu conflict; relaxing makes it possible.
    const r = m(s, 'food', ['r_rice_chicken'], 2);
    expect(r.group).toBe('need_1');
    expect(r.menuConflicts[0].ingredientId).toBe('chicken');
    expect(m(s, 'food', ['r_rice_chicken'], 2, { protectMenu: false }).group).toBe('make_now');
  });

  it('menu protection does not double-deduct stock already reserved for the menu', () => {
    const s = world();
    s.protections.push({ id: 'p1', orgId: 'org_demo', workspace: 'food', ingredientId: 'chicken', form: 'raw', quantity: 1000, unit: 'g' });
    s.reservations.push({ id: 'res_menu', orgId: 'org_demo', planId: 'menu_prep', lotId: 'L_chicken', ingredientId: 'chicken', form: 'raw', quantity: 400, consumed: 0, status: 'active', purpose: 'menu', workspace: 'food', serviceDate: TODAY, createdAt: TODAY, createdBy: 'x' });
    const view = buildStockView(s, { workspace: 'food', plannedDate: TODAY, protectMenu: true });
    const b = balances(view).find((x) => x.ingredientId === 'chicken')!;
    expect(b.reserved).toBe(400);
    expect(b.menuProtected).toBe(600);
    expect(b.freeForSpecials).toBe(1000);
  });

  it('flags incomplete protection when menu mappings are unverified or portions missing', () => {
    const s = world();
    s.menuItems.push({ id: 'mi2', orgId: 'org_demo', workspace: 'bar', name: 'House sour', recipeId: null, recipeVersionId: null, mappingStatus: 'missing', expectedPortions: 20, active: true });
    const r = m(s, 'bar', ['r_daiquiri']);
    expect(r.protectionIncomplete).toBe(true);
  });

  it('shared protection from both workspaces applies to the same physical lots', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_lj_food', name: 'Lime dressing', workspaces: ['food'], category: 'sauce', version: { lines: lines('ld', [['lime_juice', 40, 'ml']]) } }));
    s.menuItems.push({ id: 'mf', orgId: 'org_demo', workspace: 'food', name: 'Dressing', recipeId: 'r_lj_food', recipeVersionId: 'r_lj_food_v1', mappingStatus: 'confirmed', expectedPortions: 1, active: true });
    s.protections.push({ id: 'pb', orgId: 'org_demo', workspace: 'bar', ingredientId: 'lime_juice', form: 'raw', quantity: 50, unit: 'ml' });
    const food = balances(buildStockView(s, { workspace: 'food', plannedDate: TODAY, protectMenu: true })).find((b) => b.ingredientId === 'lime_juice')!;
    expect(food.physical).toBe(100); // one physical balance, not duplicated
    expect(food.menuProtected).toBe(90);
    expect(food.freeForSpecials).toBe(10);
    // Relaxing Food's own protection does not release Bar's claim on shared stock.
    const relaxed = balances(buildStockView(s, { workspace: 'food', plannedDate: TODAY, protectMenu: false })).find((b) => b.ingredientId === 'lime_juice')!;
    expect(relaxed.freeForSpecials).toBe(50);
  });

  it('converts US fl oz, bottles, and dashes with recorded factors and stable rounding', () => {
    const s = world();
    const cat = buildCatalog(s);
    const rum = cat.ingredients.get('rum')!;
    const bitters = cat.ingredients.get('bitters')!;
    expect(toIngredientBase(2, 'fl_oz', rum)).toEqual({ ok: true, value: 59.147059 });
    expect(toIngredientBase(3, 'bottle', rum, { quantity: 750, unit: 'ml' })).toMatchObject({ ok: true, value: 2250 });
    expect(toIngredientBase(1, 'bottle', rum).ok).toBe(false); // no universal bottle size
    expect(toIngredientBase(2, 'dash', bitters)).toMatchObject({ ok: true, value: 1.6 });
    expect(toIngredientBase(1, 'g', rum).ok).toBe(false); // mass vs volume stay distinct
    // 12 daiquiris at 2 fl oz each = 709.76 ml < 750 ml
    const r = m(s, 'bar', ['r_daiquiri'], 12, { strategy: 'stock_only' });
    expect(r.requirements.find((x) => x.ingredientId === 'rum')!.required).toBe(709.76471); // 24 fl oz = 709.7647095 ml, scaled first, rounded once at the 1e-6 boundary
    expect(toMicro(0.1) + toMicro(0.2)).toBe(toMicro(0.3));
  });
});

describe('eligibility and dates', () => {
  it('never allocates hard-discard-past lots, even if preparation is possible', () => {
    const s = world([makeLot({ id: 'L_rice_old', ingredientId: 'rice', quantity: 5000, pool: 'food', hardDiscardDate: '2026-10-18', lotRef: 'OLD' })]);
    const r = m(s, 'food', ['r_rice'], 6);
    expect(r.requirements[0].allocations.map((a) => a.lotId)).not.toContain('L_rice_old');
    expect(r.group).toBe('need_1');
  });

  it('applies the inclusive cutoff on the planned service date in the org timezone', () => {
    const s = world();
    const lot = s.lots.find((l) => l.id === 'L_lj')!; // use-by 2026-10-20
    const ing = buildCatalog(s).ingredients.get('lime_juice');
    expect(evaluateLot(lot, ing, '2026-10-20', s.org.policy, s.org.timezone).state).toBe('eligible');
    expect(evaluateLot(lot, ing, '2026-10-21', s.org.policy, s.org.timezone).state).toBe('blocked');
    const strict = { ...s.org.policy, cutoffInclusive: false };
    expect(evaluateLot(lot, ing, '2026-10-20', strict, s.org.timezone).state).toBe('blocked');
    // Receipt timestamp 02:00Z on the 20th is still the 19th in New York, but the 20th in Tokyo.
    const l2 = { ...lot, receivedAt: '2026-10-20T02:00:00.000Z' };
    expect(evaluateLot(l2, ing, TODAY, s.org.policy, 'America/New_York').receivedDate).toBe('2026-10-19');
    expect(evaluateLot(l2, ing, TODAY, s.org.policy, 'Asia/Tokyo').receivedDate).toBe('2026-10-20');
  });

  it('passed quality date requires review, and approval cannot bypass a hard cutoff', () => {
    const s = world([makeLot({ id: 'L_butter', ingredientId: 'butter', quantity: 500, pool: 'food', qualityDate: '2026-10-15', useByDate: '2026-10-30', lotRef: 'BTR' })]);
    s.recipes.push(makeRecipe({ id: 'r_bt', name: 'Butter rice', workspaces: ['food'], category: 'side', version: { lines: lines('br', [['butter', 20, 'g'], ['rice', 100, 'g']]) } }));
    const r = m(s, 'food', ['r_bt']);
    expect(r.group).toBe('needs_review');
    expect(r.issues[0].message).toMatch(/Quality/);
    expect(() => approveQualityReview(s, manager, 'L_butter', '2026-11-05', 'Smelled/checked')).toThrow(/hard cutoff/);
    const ok = approveQualityReview(s, manager, 'L_butter', '2026-10-22', 'Checked appearance and odor per SOP').state;
    expect(m(ok, 'food', ['r_bt']).group).toBe('make_now');
  });

  it('allocates FEFO with receipt age as fallback for undated shelf-stable stock', () => {
    const s = world([
      makeLot({ id: 'L_rice_a', ingredientId: 'rice', quantity: 100, pool: 'food', receivedAt: '2026-09-01T12:00:00Z', lotRef: 'A-oldest-undated' }),
      makeLot({ id: 'L_rice_b', ingredientId: 'rice', quantity: 100, pool: 'food', expirationDate: '2027-01-01', lotRef: 'B-dated' }),
    ]);
    const r = m(s, 'food', ['r_rice'], 3);
    expect(r.requirements[0].allocations.map((a) => a.lotRef)).toEqual(['B-dated', 'A-oldest-undated', 'RICE-1']);
    expect(r.requirements[0].allocations[1].notes.join()).toMatch(/receipt age/);
  });

  it('treats perishable lots without a cutoff as needing review rather than inventing a date', () => {
    const s = world([makeLot({ id: 'L_chk2', ingredientId: 'chicken', quantity: 1000, pool: 'food', lotRef: 'NODATE' })]);
    const e = evaluateLot(s.lots.find((l) => l.id === 'L_chk2')!, buildCatalog(s).ingredients.get('chicken'), TODAY, s.org.policy, s.org.timezone);
    expect(e.state).toBe('review');
    expect(e.cutoff).toBeNull();
  });

  it('explains urgency with actual quantities consumed', () => {
    const r = m(world(), 'food', ['r_rice_chicken'], 4, { priorityLotIds: ['L_chicken'] });
    const u = r.urgency.lots.find((l) => l.lotId === 'L_chicken')!;
    expect(u.used).toBe(600);
    expect(u.share).toBeCloseTo(0.3);
    expect(u.daysToUrgency).toBe(2);
    expect(r.priorityUse[0]).toMatchObject({ ingredientId: 'chicken', quantity: 600 });
    const tiny = m(world(), 'food', ['r_rice_chicken'], 1);
    expect(tiny.urgency.lots[0].meaningful).toBe(false); // 150 g of 2 kg is not evidence of waste reduction
  });
});

describe('components and forms', () => {
  it('combined recipes share one demand calculation and catch shared-ingredient shortages', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_gimlet', name: 'Gimlet-ish', workspaces: ['bar'], category: 'cocktail', version: { lines: lines('gm', [['lime_juice', 60, 'ml']]) } }));
    s.recipes.push(makeRecipe({ id: 'r_lime_soda', name: 'Lime soda', workspaces: ['bar'], category: 'zero_proof', version: { lines: lines('ls', [['lime_juice', 60, 'ml']]) } }));
    expect(m(s, 'bar', ['r_gimlet'], 1, { strategy: 'stock_only' }).group).toBe('make_now');
    expect(m(s, 'bar', ['r_lime_soda'], 1, { strategy: 'stock_only' }).group).toBe('make_now');
    const both = m(s, 'bar', ['r_gimlet', 'r_lime_soda'], 1, { strategy: 'stock_only' });
    expect(both.group).toBe('need_1');
    expect(both.shortages[0]).toMatchObject({ ingredientId: 'lime_juice', short: 20 });
  });

  it('uses prepared stock first and prepares only the shortfall from raw without double counting', () => {
    const s = world([makeLot({ id: 'L_lime', ingredientId: 'lime', quantity: 20, pool: 'shared', enteredUnit: 'each', useByDate: '2026-10-28', lotRef: 'LIME' })]);
    // 5 daiquiris need 150 ml lime juice: 100 ml from prepared stock + 50 ml prepared from limes (50/300*10 = 1.67 limes)
    const r = m(s, 'bar', ['r_daiquiri'], 5);
    const lj = r.requirements.find((x) => x.ingredientId === 'lime_juice')!;
    expect(lj.allocated).toBe(100);
    expect(lj.prepared).toBe(50);
    const lime = r.requirements.find((x) => x.ingredientId === 'lime')!;
    expect(lime.required).toBeCloseTo(50 / 30, 5);
    expect(r.prepSteps.map((p) => p.recipeName)).toEqual(['Fresh lime juice']);
    expect(r.group).toBe('make_now');
    // stock_only refuses to prepare
    expect(m(s, 'bar', ['r_daiquiri'], 5, { strategy: 'stock_only' }).group).toBe('need_1');
  });

  it('does not silently interchange raw and cooked forms', () => {
    const s = world();
    s.recipes.push(makeRecipe({ id: 'r_cooked', name: 'Chicken salad', workspaces: ['food'], category: 'main', version: { lines: lines('cs', [['chicken', 100, 'g', { form: 'cooked' }]]) } }));
    const r = m(s, 'food', ['r_cooked']);
    expect(r.group).toBe('need_1');
    expect(r.shortages[0]).toMatchObject({ ingredientId: 'chicken', forms: ['cooked'], missingCompletely: true });
  });

  it('detects component cycles and reports Needs review', () => {
    const s = world();
    s.ingredients.push(makeIngredient({ id: 'a', name: 'Base A', dimension: 'volume' }), makeIngredient({ id: 'b', name: 'Base B', dimension: 'volume' }));
    s.recipes.push(makeRecipe({ id: 'ra', name: 'Make A', workspaces: ['bar'], category: 'syrup', produces: { ingredientId: 'a', form: 'raw' }, version: { yield: { quantity: 100, unit: 'ml' }, lines: lines('ra', [['b', 50, 'ml']]) } }));
    s.recipes.push(makeRecipe({ id: 'rb', name: 'Make B', workspaces: ['bar'], category: 'syrup', produces: { ingredientId: 'b', form: 'raw' }, version: { yield: { quantity: 100, unit: 'ml' }, lines: lines('rb', [['a', 50, 'ml']]) } }));
    expect(findComponentCycles(buildCatalog(s)).length).toBeGreaterThan(0);
    const r = m(s, 'bar', ['ra']);
    expect(r.group).toBe('needs_review');
    expect(r.issues.some((i) => i.code === 'component_cycle')).toBe(true);
  });

  it('assumes only manager-confirmed staples and marks capacity non-exact', () => {
    const s = world([makeLot({ id: 'L_sugar', ingredientId: 'sugar', quantity: 1000, pool: 'bar' })]);
    const req = { kind: 'quantity' as const, quantity: 500, unit: 'ml' as const };
    const noStaple = match(s, { workspace: 'bar', plannedDate: TODAY, targets: [{ recipeId: 'r_syrup', requested: req, prepareOutput: true }], protectMenu: true });
    expect(noStaple.group).toBe('need_1');
    s.org.confirmedStaples.push({ ingredientId: 'water', assumeZeroCost: true, confirmedBy: 'Morgan', confirmedAt: TODAY });
    const r = match(s, { workspace: 'bar', plannedDate: TODAY, targets: [{ recipeId: 'r_syrup', requested: req, prepareOutput: true }], protectMenu: true });
    expect(r.group).toBe('make_now');
    expect(r.capacity.exact).toBe(false);
    expect(r.assumptions[0]).toMatch(/Water/);
  });
});

describe('costs, allergens, alcohol', () => {
  it('missing costs produce partial or unknown cost, never complete', () => {
    const s = world();
    const r = m(s, 'bar', ['r_daiquiri'], 1, { strategy: 'stock_only' });
    expect(r.cost.status).toBe('partial'); // rum has cost; lime juice and syrup do not
    expect(r.cost.portionCost).toBeNull();
    expect(m(s, 'food', ['r_rice']).cost.status).toBe('unknown');
    for (const l of s.lots) l.cost = { amount: 1, perQuantity: 100, perUnit: l.ingredientId === 'rice' || l.ingredientId === 'chicken' ? 'g' : 'ml' };
    s.lots.find((l) => l.id === 'L_rum')!.cost = { amount: 18, perQuantity: 750, perUnit: 'ml' };
    const full = match(s, { workspace: 'bar', plannedDate: TODAY, targets: [{ recipeId: 'r_daiquiri', requested: servings(1) }], protectMenu: true, strategy: 'stock_only', salePrice: 12, targetCostPct: 0.2 });
    expect(full.cost.status).toBe('complete');
    const expected = 59.147059 * (18 / 750) + 0.3 + 0.2;
    expect(full.cost.portionCost).toBeCloseTo(expected, 6);
    expect(full.cost.targetPrice).toBeCloseTo(expected / 0.2, 6);
    expect(full.cost.ingredientCostPct).toBeCloseTo(expected / 12, 6);
  });

  it('unknown allergen data is never labeled allergen-free; bitters make a drink alcoholic', () => {
    const s = world([makeLot({ id: 'L_bit', ingredientId: 'bitters', quantity: 100, pool: 'bar' }), makeLot({ id: 'L_my', ingredientId: 'mystery', quantity: 100, pool: 'bar' })]);
    s.recipes.push(makeRecipe({ id: 'r_zp', name: 'Zero-ish', workspaces: ['bar'], category: 'zero_proof', version: { lines: lines('zp', [['syrup', 20, 'ml'], ['bitters', 2, 'dash'], ['mystery', 10, 'ml']]) } }));
    const r = m(s, 'bar', ['r_zp']);
    expect(r.alcohol.status).toBe('contains_alcohol');
    expect(r.alcohol.sources).toContain('Aromatic bitters');
    expect(r.allergens.status).toBe('incomplete');
    const opts: DiscoverOptions = {
      workspace: 'bar', plannedDate: TODAY, mode: 'make_now', servings: 1, batches: 1, selectedIngredientIds: [], priorityLotIds: [], categories: ['zero_proof'],
      cuisine: null, vegetarian: false, vegan: false, excludeAllergens: ['peanut'], excludeEquipment: [], maxMinutes: null, protectMenu: true, strategy: 'prefer_stock', query: '',
    };
    const d = discover(s, opts);
    expect(d.groups.make_now.find((x) => x.targets[0].recipeId === 'r_zp')).toBeUndefined();
    expect(d.hidden.some((h) => /incomplete/.test(h.reason))).toBe(true);
  });
});
