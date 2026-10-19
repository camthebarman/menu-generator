import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/domain/dates';
import { evaluatePlan, ledgerMismatches } from '../../src/domain/ops';
import { DEMO_STORAGE_KEY, DemoRepository, type StorageLike } from '../../src/data/demo';

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const clock = fixedClock('2026-10-19T16:00:00Z');

describe('DemoRepository', () => {
  it('persists across reloads under an isolated key and seeds relative to the anchor date', async () => {
    const storage = new MemStorage();
    const a = new DemoRepository(storage, clock);
    const s = await a.load();
    expect(s.mode).toBe('demo');
    expect(s.org.id).toBe('org_demo');
    const lot = s.lots.find((l) => l.lotRef === 'CHK-0412')!;
    expect(lot.useByDate).toBe('2026-10-20');
    await a.run('recordWaste', lot.id, 100, 'Dropped tray', 'w-1');
    expect([...storage.m.keys()]).toEqual([DEMO_STORAGE_KEY]);
    const b = new DemoRepository(storage, clock); // "refresh"
    const s2 = await b.load();
    expect(s2.lots.find((l) => l.id === lot.id)!.quantity).toBe(3100);
    expect(ledgerMismatches(s2)).toEqual([]);
  });

  it('serializes concurrent commands so shared stock cannot be double-reserved', async () => {
    const repo = new DemoRepository(new MemStorage(), clock);
    const s = await repo.load();
    // Two plans that together exceed the prepared lemon juice (200 ml shared lot, use-by tomorrow).
    const mk = (ws: 'food' | 'bar', recipeId: string, n: number) => repo.run('createPlan', {
      workspace: ws, name: `${ws} plan`, kind: 'special', serviceDate: '2026-10-19', protectMenu: false, componentStrategy: 'stock_only',
      targets: [{ recipeId, recipeVersionId: s.recipes.find((r) => r.id === recipeId)!.currentVersionId, requested: { kind: 'servings', servings: n } }],
    });
    const p1 = (await mk('food', 'st_chickpea_salad', 8)).result.planId; // 60 ml lemon juice
    const p2 = (await mk('bar', 'st_whiskey_sour', 8)).result.planId;     // ~177 ml lemon juice
    const st = await repo.load();
    expect(evaluatePlan(st, st.plans.find((p) => p.id === p1)!).group).toBe('make_now');
    expect(evaluatePlan(st, st.plans.find((p) => p.id === p2)!).group).toBe('make_now');
    const results = await Promise.allSettled([repo.run('reservePlan', p1, 'r1'), repo.run('reservePlan', p2, 'r2')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const final = await repo.load();
    const lemon = final.lots.find((l) => l.lotRef === 'PREP-LEMON')!;
    const reserved = final.reservations.filter((r) => r.lotId === lemon.id && r.status === 'active').reduce((a, r) => a + r.quantity, 0);
    expect(reserved).toBeLessThanOrEqual(lemon.quantity!);
  });

  it('component prep through the repository: inputs once, one output lot with lineage; retries are idempotent', async () => {
    const repo = new DemoRepository(new MemStorage(), clock);
    const s = await repo.load();
    const recipe = s.recipes.find((r) => r.id === 'st_simple_syrup')!;
    const { planId } = (await repo.run('createPlan', {
      workspace: 'bar', name: 'Syrup', kind: 'component', serviceDate: '2026-10-19', protectMenu: true,
      targets: [{ recipeId: recipe.id, recipeVersionId: recipe.currentVersionId, requested: { kind: 'quantity', quantity: 750, unit: 'ml' } }],
    })).result;
    const sugarBefore = s.lots.find((l) => l.lotRef === 'SUG-1')!.quantity!;
    await repo.run('reservePlan', planId, 'res-syrup');
    const input = { usage: [], waste: [], outputs: [{ recipeId: recipe.id, quantity: 740, unit: 'ml' as const, pool: 'bar' as const, storage: 'refrigerated' as const, useByDate: '2026-11-02', dateVerified: true }] };
    await repo.run('completePlan', planId, input, 'prep-syrup');
    const again = await repo.run('completePlan', planId, input, 'prep-syrup');
    expect(again.replayed).toBe(true);
    const st = await repo.load();
    expect(sugarBefore - st.lots.find((l) => l.lotRef === 'SUG-1')!.quantity!).toBe(500);
    const outs = st.lots.filter((l) => l.lineage?.recipeId === recipe.id);
    expect(outs).toHaveLength(1);
    expect(outs[0].quantity).toBe(740);
    expect(outs[0].lineage!.sources.map((x) => x.ingredientId)).toEqual(['sugar']); // water is an assumed staple
    expect(ledgerMismatches(st)).toEqual([]);
  });

  it('works without browser storage (in-memory, flagged non-persistent)', async () => {
    const broken: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    const repo = new DemoRepository(broken, clock);
    const s = await repo.load();
    expect(s.lots.length).toBeGreaterThan(50);
    expect(repo.persistent).toBe(false);
  });
});
