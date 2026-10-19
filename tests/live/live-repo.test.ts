// Exercises the app's real SupabaseRepository (supabase-js → PostgREST → Postgres with RLS and the
// SQL functions) using signed JWTs. Started by scripts/test-db.sh when PostgREST is available.
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/domain/csv';
import { guessColumnMapping, INVENTORY_COLUMNS, previewInventoryImport } from '../../src/domain/imports';
import { evaluatePlan, ledgerMismatches, OpError } from '../../src/domain/ops';
import { SupabaseRepository } from '../../src/data/live';

const REST = process.env.LIVE_REST_URL;
const SECRET = process.env.LIVE_JWT_SECRET ?? '';
const suite = REST ? describe : describe.skip;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// supabase-js calls {url}/rest/v1/...; PostgREST serves at /. A tiny path-stripping proxy.
let proxy: http.Server;
let base = '';
const OWNER = '10000000-0000-4000-8000-000000000001';
const BAR = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const repoFor = (sub: string) => new SupabaseRepository({ url: base, anonKey: 'anon-key-unused-by-postgrest', accessToken: async () => jwt(sub) });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

suite('SupabaseRepository against PostgREST', () => {
  beforeAll(async () => {
    const target = new URL(REST!);
    proxy = http.createServer((req, res) => {
      const path = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/';
      const p = http.request({ host: target.hostname, port: target.port, path, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers);
        r.pipe(res);
      });
      p.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      req.pipe(p);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => proxy.close(() => r())));

  let orgId = '';
  const owner = () => { const r = repoFor(OWNER); r.orgId = orgId; return r; };

  it('creates an organization and loads it with the starter catalog and recipes', async () => {
    const r = repoFor(OWNER);
    expect(await r.memberships()).toEqual([]);
    orgId = await r.createOrganization('Live Test Bistro', 'America/New_York', 'Olive (owner)');
    r.orgId = orgId;
    const s = await r.load();
    expect(s.mode).toBe('live');
    expect(s.currentUser).toMatchObject({ id: OWNER, role: 'owner', name: 'Olive (owner)' });
    expect(s.ingredients.length).toBe(106);
    expect(s.recipes.filter((x) => x.provenance.kind === 'starter').length).toBe(56);
    expect(s.recipes.find((x) => x.id === 'st_daiquiri')!.versions[0].lines.length).toBe(4);
  });

  it('runs the full bar workflow: receive → draft → reserve → record usage, with a balanced ledger', async () => {
    const r = owner();
    await r.load();
    const rec = await r.run('receiveLot', { ingredientId: 'white_rum', form: 'raw', quantity: 1, unit: 'bottle', packageSize: { quantity: 750, unit: 'ml' }, pool: 'bar', storage: 'dry', cost: { amount: 19, perQuantity: 1, perUnit: 'bottle' }, lotRef: 'RUM' }, 'k-rum');
    expect(rec.result).toEqual({ lotId: expect.any(String), quantityResolved: true });
    await r.run('receiveLot', { ingredientId: 'lime_juice', form: 'prepared', quantity: 300, unit: 'ml', pool: 'shared', storage: 'refrigerated', useByDate: plus(1), dateVerification: 'verified', lotRef: 'LJ' }, 'k-lj');
    await r.run('receiveLot', { ingredientId: 'simple_syrup', form: 'prepared', quantity: 500, unit: 'ml', pool: 'bar', storage: 'refrigerated', useByDate: plus(10), dateVerification: 'verified', lotRef: 'SS' }, 'k-ss');
    let s = (await r.run('setStaple', 'ice', true, true)).state;
    const rum = s.lots.find((l) => l.lotRef === 'RUM')!;
    expect(rum.quantity).toBe(750);
    const v = s.recipes.find((x) => x.id === 'st_daiquiri')!.currentVersionId;
    const created = await r.run('createPlan', { workspace: 'bar', name: 'Daiquiri x4', kind: 'drink', serviceDate: today, targets: [{ recipeId: 'st_daiquiri', recipeVersionId: v, requested: { kind: 'servings', servings: 4 } }], protectMenu: true });
    s = created.state;
    const plan = s.plans.find((p) => p.id === created.result.planId)!;
    expect(plan.status).toBe('draft');
    expect(evaluatePlan(s, plan).group).toBe('make_now');
    s = (await r.run('reservePlan', plan.id, 'k-res')).state;
    expect(s.plans.find((p) => p.id === plan.id)!.status).toBe('reserved');
    expect(s.reservations.filter((x) => x.planId === plan.id && x.status === 'active').length).toBe(3);
    s = (await r.run('completePlan', plan.id, { usage: [], waste: [], outputs: [] }, 'k-done')).state;
    expect(s.plans.find((p) => p.id === plan.id)!.status).toBe('completed');
    expect(s.lots.find((l) => l.lotRef === 'RUM')!.quantity).toBeCloseTo(750 - 4 * 59.147059, 4);
    expect(ledgerMismatches(s)).toEqual([]);
  });

  it('prepares a component with lineage and transfers stock between pools', async () => {
    const r = owner();
    let s = await r.load();
    await r.run('receiveLot', { ingredientId: 'lime', form: 'raw', quantity: 20, unit: 'each', pool: 'shared', storage: 'refrigerated', operationalDiscardDate: plus(6), dateVerification: 'verified', lotRef: 'LIMES', cost: { amount: 6, perQuantity: 20, perUnit: 'each' } });
    s = await r.load();
    const v = s.recipes.find((x) => x.id === 'st_lime_juice')!.currentVersionId;
    const { result } = await r.run('createPlan', { workspace: 'bar', name: 'Juice', kind: 'component', serviceDate: today, targets: [{ recipeId: 'st_lime_juice', recipeVersionId: v, requested: { kind: 'quantity', quantity: 300, unit: 'ml' } }], protectMenu: true, componentStrategy: 'prefer_stock' });
    await r.run('reservePlan', result.planId, 'k-res-juice');
    s = (await r.run('completePlan', result.planId, { usage: [], waste: [], outputs: [{ recipeId: 'st_lime_juice', quantity: 290, unit: 'ml', pool: 'bar', storage: 'refrigerated', useByDate: plus(1), dateVerified: true }] }, 'k-prep')).state;
    const out = s.lots.find((l) => l.lineage?.recipeId === 'st_lime_juice')!;
    expect(out.quantity).toBe(290);
    expect(out.lineage!.inheritedCutoff).toBe(plus(6));
    expect(out.cost!.amount).toBeCloseTo(3, 4);
    expect(s.lots.find((l) => l.lotRef === 'LIMES')!.quantity).toBe(10);
    s = (await r.run('transferLot', s.lots.find((l) => l.lotRef === 'LIMES')!.id, 4, 'bar', 'Bar garnish', 'k-xfer')).state;
    expect(s.lots.filter((l) => l.lotRef === 'LIMES').map((l) => [l.pool, l.quantity]).sort()).toEqual([['bar', 4], ['shared', 6]]);
    expect(ledgerMismatches(s)).toEqual([]);
  });

  it('supports lot maintenance, menus, protection, recipes, settings, and shopping lists', async () => {
    const r = owner();
    let s = await r.load();
    const lot = s.lots.find((l) => l.lotRef === 'SS')!;
    s = (await r.run('adjustLot', lot.id, 450, 'Recount', 'k-adj')).state;
    s = (await r.run('recordWaste', lot.id, 50, 'Spill', 'k-waste')).state;
    expect(s.lots.find((l) => l.id === lot.id)!.quantity).toBe(400);
    s = (await r.run('openLot', lot.id, today, plus(5), 'Opened')).state;
    expect(s.lots.find((l) => l.id === lot.id)!.operationalDiscardDate).toBe(plus(5));
    await r.run('receiveLot', { ingredientId: 'parmesan', form: 'raw', quantity: 500, unit: 'g', pool: 'food', storage: 'refrigerated', qualityDate: plus(-2), useByDate: plus(5), dateVerification: 'verified', lotRef: 'PARM' });
    s = await r.load();
    const parm = s.lots.find((l) => l.lotRef === 'PARM')!;
    s = (await r.run('approveQualityReview', parm.id, plus(1), 'Checked per SOP')).state;
    expect(s.lots.find((l) => l.id === parm.id)!.qualityReview?.validThrough).toBe(plus(1));
    s = (await r.run('setLotStatus', parm.id, 'quarantined', 'Supplier notice')).state;
    expect(s.lots.find((l) => l.id === parm.id)!.status).toBe('quarantined');

    const m = await r.run('upsertMenuItem', { workspace: 'bar', name: 'House daiquiri', recipeId: 'st_daiquiri', recipeVersionId: null, mappingStatus: 'confirmed', expectedPortions: 10, salePrice: 13, active: true });
    await r.run('upsertProtection', { workspace: 'bar', ingredientId: 'white_rum', form: 'raw', quantity: 750, unit: 'ml', note: 'Events' });
    s = (await r.run('deleteMenuItem', m.result.id)).state;
    expect(s.menuItems).toHaveLength(0);
    expect(s.protections).toHaveLength(1);
    await r.run('deleteProtection', s.protections[0].id);

    const saved = await r.run('saveRecipe', {
      name: 'House lime soda', workspaces: ['bar'], category: 'zero_proof', tags: ['house'],
      version: { lines: [{ id: 'l1', ingredientId: 'lime_juice', form: 'prepared', quantity: 30, unit: 'ml', optional: false, basis: 'as_purchased' }], yield: { quantity: 1, unit: 'serving' }, servings: 1, method: ['Build'], equipment: [], activeMinutes: 1, totalMinutes: 1, allergenStatus: 'verified', confirmed: true },
    });
    const v2 = await r.run('saveRecipe', {
      name: 'House lime soda', workspaces: ['bar'], category: 'zero_proof', tags: ['house'],
      version: { lines: [{ id: 'l1', ingredientId: 'lime_juice', form: 'prepared', quantity: 25, unit: 'ml', optional: false, basis: 'as_purchased' }], yield: { quantity: 1, unit: 'serving' }, servings: 1, method: ['Build'], equipment: [], activeMinutes: 1, totalMinutes: 1, allergenStatus: 'verified', confirmed: true },
    }, saved.result.recipeId);
    s = v2.state;
    expect(s.recipes.find((x) => x.id === saved.result.recipeId)!.versions.map((x) => x.version)).toEqual([1, 2]);
    const imported = await r.run('saveRecipe', {
      name: 'Imported thing', workspaces: ['food'], category: 'special', tags: [], provenance: { kind: 'imported', source: 'test.json' },
      version: { lines: [{ id: 'l1', ingredientId: 'rice', form: 'raw', quantity: 100, unit: 'g', optional: false, basis: 'as_purchased' }], yield: { quantity: 1, unit: 'serving' }, servings: 1, method: [], equipment: [], activeMinutes: null, totalMinutes: null, allergenStatus: 'unverified', confirmed: false },
    });
    s = (await r.run('confirmRecipeVersion', imported.result.recipeId, imported.result.versionId, 'Reviewed')).state;
    expect(s.recipes.find((x) => x.id === imported.result.recipeId)!.versions[0].confirmed).toBe(true);
    s = (await r.run('archiveRecipe', imported.result.recipeId, true)).state;
    expect(s.recipes.find((x) => x.id === imported.result.recipeId)!.archived).toBe(true);

    s = (await r.run('updateOrgSettings', { policy: { ...s.org.policy, alertDays: 3 }, targetCostPct: 0.25 })).state;
    expect(s.org.policy.alertDays).toBe(3);
    expect(s.org.targetCostPct).toBe(0.25);
    s = (await r.run('saveShoppingList', { workspace: 'bar', serviceDate: today, selections: [{ recipeId: 'st_margarita', recipeVersionId: 'st_margarita_v1', requested: { kind: 'servings', servings: 2 } }] })).state;
    expect(s.shoppingLists).toHaveLength(1);
    s = (await r.run('upsertIngredient', { ...s.ingredients.find((i) => i.id === 'mint')!, aliases: [{ text: 'spearmint', confirmed: true }] })).state;
    expect(s.ingredients.find((i) => i.id === 'mint')!.aliases).toEqual([{ text: 'spearmint', confirmed: true }]);
  });

  it('imports CSV atomically and idempotently', async () => {
    const r = owner();
    const s = await r.load();
    const text = 'ingredient,quantity,unit,pool,lot_ref\nJasmine rice,5,kg,food,CSV-R\nGranulated sugar,2,kg,shared,CSV-S\n';
    const parsed = parseCsv(text);
    const rows = previewInventoryImport(s, parsed.rows, guessColumnMapping(parsed.headers, INVENTORY_COLUMNS), {});
    const a = await r.run('commitInventoryImport', rows, 'stock.csv', text);
    expect(a.result).toMatchObject({ created: 2 });
    const b = await r.run('commitInventoryImport', rows, 'stock.csv', text);
    expect(b.result).toMatchObject({ replayed: true });
    expect(b.state.lots.filter((l) => l.lotRef?.startsWith('CSV-'))).toHaveLength(2);
  });

  it('team invites scope staff to their workspace, and other orgs see nothing', async () => {
    const r = owner();
    await r.load();
    const code = await r.createInvite('staff', ['bar'], 'Bartender');
    const bar = repoFor(BAR);
    bar.orgId = await bar.acceptInvite(code, 'Bea (bar)');
    const bs = await bar.load();
    expect(bs.currentUser).toMatchObject({ role: 'staff', workspaces: ['bar'] });
    expect(bs.lots.every((l) => l.pool !== 'food')).toBe(true);
    expect(bs.lots.some((l) => l.pool === 'shared')).toBe(true);
    await expect(bar.run('receiveLot', { ingredientId: 'rice', form: 'raw', quantity: 1, unit: 'kg', pool: 'food', storage: 'dry' })).rejects.toBeInstanceOf(OpError);
    expect((await r.listMembers()).map((m) => m.role).sort()).toEqual(['owner', 'staff']);
    expect((await r.listInvites())[0].usedAt).not.toBeNull();
    await r.updateMember(BAR, 'staff', ['bar', 'food']);
    expect((await bar.load()).lots.some((l) => l.pool === 'food')).toBe(true);

    const other = repoFor(OTHER);
    expect(await other.memberships()).toEqual([]);
    other.orgId = orgId;
    await expect(other.load()).rejects.toThrow(/not found or not accessible/);
  });
});
