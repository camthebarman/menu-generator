import { describe, expect, it } from 'vitest';
import { buildCatalog, findComponentCycles } from '../../src/domain/catalog';
import { discover, type DiscoverOptions, type MatchResult } from '../../src/domain/match';
import { ledgerMismatches } from '../../src/domain/ops';
import { buildStockView } from '../../src/domain/stock';
import { buildDemoState } from '../../src/seed/demo';
import { BAR_RECIPES, FOOD_RECIPES } from '../../src/seed/recipes';
import { BAR_CATEGORIES, FOOD_CATEGORIES } from '../../src/domain/types';

const ANCHOR = '2026-10-19';
const base = (workspace: 'food' | 'bar', servings: number): DiscoverOptions => ({
  workspace, plannedDate: ANCHOR, mode: 'make_now', servings, batches: 1, selectedIngredientIds: [], priorityLotIds: [], categories: [], cuisine: null,
  vegetarian: false, vegan: false, excludeAllergens: [], excludeEquipment: [], maxMinutes: null, protectMenu: true, strategy: 'prefer_stock', query: '',
});
const names = (rs: MatchResult[]) => rs.map((r) => r.targets[0].name);

describe('demo seed', () => {
  const s = buildDemoState(ANCHOR);

  it('ships at least 24 Food and 20 Bar starter recipes covering every category', () => {
    expect(FOOD_RECIPES.length).toBeGreaterThanOrEqual(24);
    expect(BAR_RECIPES.length).toBeGreaterThanOrEqual(20);
    for (const c of FOOD_CATEGORIES) expect(FOOD_RECIPES.some((r) => r.category === c)).toBe(true);
    for (const c of BAR_CATEGORIES) expect(BAR_RECIPES.some((r) => r.category === c)).toBe(true);
    expect(FOOD_RECIPES.concat(BAR_RECIPES).every((r) => r.provenance.kind === 'starter' && r.provenance.source)).toBe(true);
  });

  it('is internally consistent', () => {
    const cat = buildCatalog(s);
    expect(findComponentCycles(cat)).toEqual([]);
    for (const r of s.recipes) for (const v of r.versions) for (const l of v.lines) if (l.ingredientId) expect(cat.ingredients.has(l.ingredientId), `${r.id}:${l.ingredientId}`).toBe(true);
    expect(ledgerMismatches(s)).toEqual([]);
  });

  it('covers Make now, one-away, two-away, menu protection, and Needs review in Food', () => {
    const d = discover(s, base('food', 4));
    const g = d.groups;
    expect(g.make_now.length).toBeGreaterThan(3);
    expect(names(g.need_1)).toContain('Garlic shrimp');
    expect(names(g.need_2)).toContain('Basil pesto spaghetti');
    expect(names(g.needs_review)).toEqual(expect.arrayContaining(['Mushrooms with thyme & parmesan', 'Gochujang glazed chicken (imported)']));
    const beef = g.need_1.find((r) => r.targets[0].name === 'Beef & mushroom rice bowl');
    expect(beef?.menuConflicts[0]?.name).toMatch(/beef/i);
    expect(d.view.protection.incomplete).toBe(true); // the unverified pots de crème mapping
    const fried = g.make_now.find((r) => r.targets[0].name === 'Chicken fried rice');
    expect(fried?.prepSteps[0]?.recipeName).toBe('Steamed jasmine rice'); // expired cooked rice is never used
    console.log('FOOD', Object.fromEntries(Object.entries(g).map(([k, v]) => [k, names(v)])));
  });

  it('covers bar scenarios including insufficient-plus-missing and bitters alcohol status', () => {
    const d = discover(s, base('bar', 2));
    const g = d.groups;
    expect(names(g.make_now)).toContain('Daiquiri');
    expect(names(g.need_1)).toContain('Margarita');
    const esp = g.need_2.find((r) => r.targets[0].name === 'Espresso martini')!;
    expect(esp.shortages.map((x) => x.missingCompletely).sort()).toEqual([false, true]);
    expect(names(g.needs_review)).toContain('Ginger-lime fizz');
    const bitters = [...g.make_now, ...g.need_1].find((r) => r.targets[0].name === 'Bitters & soda')!;
    expect(bitters.alcohol.status).toBe('contains_alcohol');
    console.log('BAR', Object.fromEntries(Object.entries(g).map(([k, v]) => [k, names(v)])));
  });

  it('use-older mode ranks recipes that consume a meaningful share of at-risk stock', () => {
    const d = discover(s, { ...base('food', 4), mode: 'use_older' });
    const top = d.groups.make_now[0];
    expect(top.urgency.meaningful).toBe(true);
    expect(d.groups.make_now.every((r) => r.urgency.meaningful)).toBe(true);
  });

  it('Shared stock is a single balance for both workspaces', () => {
    const food = buildStockView(s, { workspace: 'food', plannedDate: ANCHOR, protectMenu: true });
    const bar = buildStockView(s, { workspace: 'bar', plannedDate: ANCHOR, protectMenu: true });
    const limeLot = s.lots.find((l) => l.lotRef === 'LIM-1')!;
    expect(food.slotById.get(limeLot.id)!.claimBar).toBe(bar.slotById.get(limeLot.id)!.claimBar);
  });
});
