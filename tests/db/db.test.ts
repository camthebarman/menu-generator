// Real-database tests: migrations, RLS tenant isolation, pool permissions, atomic concurrent
// reservations, idempotency, and ledger rules. Requires PG_TEST_URL (see scripts/test-db.sh).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.PG_TEST_URL;
if (!url) throw new Error('PG_TEST_URL not set; run `npm run test:db`');
const pool = new pg.Pool({ connectionString: url, max: 10 });

const U = {
  ownerA: '00000000-0000-4000-8000-00000000000a',
  barA: '00000000-0000-4000-8000-0000000000b0',
  foodA: '00000000-0000-4000-8000-0000000000f0',
  ownerB: '00000000-0000-4000-8000-00000000000b',
};
let orgA = '';
let orgB = '';

async function begin(uid: string | null) {
  const c = await pool.connect();
  await c.query('begin');
  if (uid) {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await c.query('set local role authenticated');
  } else await c.query('set local role anon');
  return c;
}

async function as<T>(uid: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await begin(uid);
  try {
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const one = async <T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []) => (await as(uid, (c) => c.query(sql, params))).rows[0] as T;
const rows = async (uid: string | null, sql: string, params: unknown[] = []) => (await as(uid, (c) => c.query(sql, params))).rows;

let idem = 0;
const key = (p: string) => `${p}-key-${++idem}-${Date.now()}`;

async function receive(uid: string, org: string, lot: Record<string, unknown>): Promise<string> {
  const r = await one<{ receive_lot: { lotId: string } }>(uid, 'select public.receive_lot($1, $2, $3)', [org, JSON.stringify(lot), key('recv')]);
  return r.receive_lot.lotId;
}

async function draftPlan(uid: string, org: string, id: string, workspace: 'food' | 'bar', serviceDate = 'today', kind = 'special', targets: unknown[] = []) {
  await as(uid, (c) => c.query(
    `insert into public.plans(id, org_id, workspace, name, kind, service_date, targets) values ($1, $2, $3, $4, $5, case when $6 = 'today' then (now() at time zone 'America/New_York')::date else $6::date end, $7)`,
    [id, org, workspace, id, kind, serviceDate, JSON.stringify(targets)],
  ));
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plusDays = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const root = join(__dirname, '..', '..');
  const c = await pool.connect();
  try {
    await c.query(readFileSync(join(root, 'tests/db/supabase-shim.sql'), 'utf8'));
    for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await c.query(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
  } finally {
    c.release();
  }
  orgA = (await one<{ create_organization: string }>(U.ownerA, `select public.create_organization('Org A', 'America/New_York', 'Alex (owner)')`)).create_organization;
  orgB = (await one<{ create_organization: string }>(U.ownerB, `select public.create_organization('Org B', 'America/New_York', 'Blair (owner)')`)).create_organization;
  const inviteBar = await one<{ create_invite: { code: string } }>(U.ownerA, `select public.create_invite($1, 'staff', '{bar}', 'bar team')`, [orgA]);
  const inviteFood = await one<{ create_invite: { code: string } }>(U.ownerA, `select public.create_invite($1, 'staff', '{food}', 'kitchen')`, [orgA]);
  await one(U.barA, 'select public.accept_invite($1, $2)', [inviteBar.create_invite.code, 'Bar staff']);
  await one(U.foodA, 'select public.accept_invite($1, $2)', [inviteFood.create_invite.code.toLowerCase(), 'Food staff']);
});

afterAll(async () => {
  await pool.end();
});

describe('schema & RLS coverage', () => {
  it('enables RLS on every public table', async () => {
    const r = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it('provisions the starter catalog per org and exposes public starter recipes', async () => {
    const ing = await one<{ n: string }>(U.ownerA, 'select count(*)::text as n from public.ingredients where org_id = $1', [orgA]);
    expect(Number(ing.n)).toBeGreaterThan(100);
    const rec = await one<{ n: string }>(U.foodA, `select count(*)::text as n from public.recipes where org_id is null`);
    expect(Number(rec.n)).toBeGreaterThanOrEqual(44);
  });

  it('anon can read nothing', async () => {
    await expect(rows(null, 'select * from public.lots')).rejects.toThrow(/permission denied/);
    await expect(rows(null, 'select * from public.recipes')).rejects.toThrow(/permission denied/);
  });
});

describe('tenant isolation', () => {
  let lotA = '';
  let privateRecipe = '';
  beforeAll(async () => {
    lotA = await receive(U.ownerA, orgA, { ingredientId: 'rice', form: 'raw', quantity: 5000, enteredUnit: 'g', pool: 'food', storage: 'dry', lotRef: 'A-RICE' });
    privateRecipe = 'rec_private_a';
    await as(U.ownerA, async (c) => {
      await c.query(`insert into public.recipes(id, org_id, name, workspaces, category, provenance, current_version_id) values ($1, $2, 'Secret sauce', '{food}', 'sauce', '{"kind":"house"}', $3)`, [privateRecipe, orgA, `${privateRecipe}_v1`]);
      await c.query(`insert into public.recipe_versions(id, recipe_id, org_id, version, lines, yield, servings) values ($1, $2, $3, 1, '[]', '{"quantity":1,"unit":"serving"}', 1)`, [`${privateRecipe}_v1`, privateRecipe, orgA]);
    });
  });

  it('denies direct cross-organization reads', async () => {
    expect(await rows(U.ownerB, 'select * from public.lots where id = $1', [lotA])).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.ingredients where org_id = $1', [orgA])).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.recipes where id = $1', [privateRecipe])).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.organizations where id = $1', [orgA])).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.audit_events where org_id = $1', [orgA])).toEqual([]);
  });

  it('denies nested cross-organization reads through joins', async () => {
    const r = await rows(U.ownerB, `select m.* from public.lot_movements m join public.lots l on l.id = m.lot_id where l.id = $1`, [lotA]);
    expect(r).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.lot_movements where lot_id = $1', [lotA])).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.recipe_versions where recipe_id = $1', [privateRecipe])).toEqual([]);
  });

  it('denies cross-organization mutations, including nested references', async () => {
    await expect(one(U.ownerB, 'select public.adjust_lot($1, $2, 0, $3, $4)', [orgA, lotA, 'hack', key('x')])).rejects.toThrow(/forbidden/);
    await expect(one(U.ownerB, 'select public.adjust_lot($1, $2, 0, $3, $4)', [orgB, lotA, 'hack', key('x')])).rejects.toThrow(/not_found/);
    await expect(rows(U.ownerB, `insert into public.ingredients(org_id, id, name, category, dimension) values ($1, 'evil', 'Evil', 'other', 'mass')`, [orgA])).rejects.toThrow(/row-level security/);
    // Menu item in org B pointing at org A's private recipe
    await expect(rows(U.ownerB, `insert into public.menu_items(id, org_id, workspace, name, recipe_id, mapping_status) values ('mi_x', $1, 'food', 'Stolen', $2, 'confirmed')`, [orgB, privateRecipe])).rejects.toThrow(/cross-organization/);
    // Version smuggled into another org's recipe
    await expect(rows(U.ownerB, `insert into public.recipe_versions(id, recipe_id, org_id, version, lines, yield, servings) values ('v_evil', $1, $2, 2, '[]', '{}', 1)`, [privateRecipe, orgB])).rejects.toThrow(/org must match|row-level/);
    // Self-granting membership into another org
    await expect(rows(U.ownerB, `insert into public.memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [orgA, U.ownerB])).rejects.toThrow(/permission denied/);
    // Updates silently affect zero rows under RLS
    const upd = await as(U.ownerB, (c) => c.query(`update public.organizations set name = 'pwned' where id = $1`, [orgA]));
    expect(upd.rowCount).toBe(0);
  });

  it('never allows direct writes to lots or the ledger', async () => {
    await expect(rows(U.ownerA, `update public.lots set quantity = 999999 where id = $1`, [lotA])).rejects.toThrow(/permission denied/);
    await expect(rows(U.ownerA, `insert into public.reservations(org_id, plan_id, lot_id, ingredient_id, form, quantity, workspace, service_date) values ($1, 'p', $2, 'rice', 'raw', 1, 'food', now())`, [orgA, lotA])).rejects.toThrow(/permission denied/);
    const c = await pool.connect();
    try {
      await expect(c.query(`update public.lot_movements set delta = 0 where lot_id = $1`, [lotA])).rejects.toThrow(/append-only/);
    } finally {
      c.release();
    }
  });
});

describe('pool permissions', () => {
  let foodLot = '';
  let barLot = '';
  let sharedLot = '';
  beforeAll(async () => {
    foodLot = await receive(U.ownerA, orgA, { ingredientId: 'white_rum', form: 'raw', quantity: 750, enteredUnit: 'ml', pool: 'food', storage: 'dry', lotRef: 'RUM-IN-FOOD' });
    barLot = await receive(U.ownerA, orgA, { ingredientId: 'gin', form: 'raw', quantity: 750, enteredUnit: 'ml', pool: 'bar', storage: 'dry', lotRef: 'GIN' });
    sharedLot = await receive(U.ownerA, orgA, { ingredientId: 'sugar', form: 'raw', quantity: 1000, enteredUnit: 'g', pool: 'shared', storage: 'dry', lotRef: 'SUG' });
  });

  it('staff see Shared plus their workspace; managers see all pools', async () => {
    const barSees = (await rows(U.barA, 'select id from public.lots where id = any($1)', [[foodLot, barLot, sharedLot]])).map((r) => r.id).sort();
    expect(barSees).toEqual([barLot, sharedLot].sort());
    const mgr = await rows(U.ownerA, 'select id from public.lots where id = any($1)', [[foodLot, barLot, sharedLot]]);
    expect(mgr).toHaveLength(3);
  });

  it('Food-pool stock cannot be reserved for Bar without a transfer; transfer preserves identity', async () => {
    await draftPlan(U.barA, orgA, 'plan_bar_rum', 'bar');
    const alloc = [{ lotId: foodLot, ingredientId: 'white_rum', form: 'raw', quantity: 60 }];
    await expect(one(U.barA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_bar_rum', JSON.stringify(alloc), key('r')])).rejects.toThrow(/food pool/);
    await expect(one(U.barA, 'select public.transfer_lot($1, $2, 375, $3, $4, $5)', [orgA, foodLot, 'bar', 'move', key('t')])).rejects.toThrow(/only managers/);
    const t = await one<{ transfer_lot: { lotId: string } }>(U.ownerA, 'select public.transfer_lot($1, $2, 375, $3, $4, $5)', [orgA, foodLot, 'bar', 'Bar needs rum', key('t')]);
    const child = await one<Record<string, unknown>>(U.ownerA, 'select * from public.lots where id = $1', [t.transfer_lot.lotId]);
    const parent = await one<Record<string, unknown>>(U.ownerA, 'select * from public.lots where id = $1', [foodLot]);
    expect(child.pool).toBe('bar');
    expect(child.parent_lot_id).toBe(foodLot);
    expect(String(child.received_at)).toBe(String(parent.received_at));
    expect(Number(child.quantity) + Number(parent.quantity)).toBe(750);
    const ok = await one(U.barA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_bar_rum', JSON.stringify([{ lotId: child.id, ingredientId: 'white_rum', form: 'raw', quantity: 60 }]), key('r')]);
    expect(ok).toBeTruthy();
  });
});

describe('atomic reservations', () => {
  it('concurrent Shared reservations from Food and Bar cannot over-reserve', async () => {
    const lot = await receive(U.ownerA, orgA, { ingredientId: 'lime_juice', form: 'prepared', quantity: 100, enteredUnit: 'ml', pool: 'shared', storage: 'refrigerated', useByDate: plusDays(1), dateVerification: 'verified', lotRef: 'LJ-SHARED' });
    await draftPlan(U.foodA, orgA, 'plan_food_lj', 'food');
    await draftPlan(U.barA, orgA, 'plan_bar_lj', 'bar');
    const alloc = JSON.stringify([{ lotId: lot, ingredientId: 'lime_juice', form: 'prepared', quantity: 60, lotVersion: 1 }]);
    const c1 = await begin(U.foodA);
    const c2 = await begin(U.barA);
    try {
      await c1.query('select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_food_lj', alloc, key('c1')]);
      let settled = false;
      const p2 = c2.query('select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_bar_lj', alloc, key('c2')]).finally(() => { settled = true; });
      p2.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the row lock held by c1
      await c1.query('commit');
      await expect(p2).rejects.toThrow(/over_reservation/);
      await c2.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    const total = await one<{ s: string }>(U.ownerA, `select coalesce(sum(quantity), 0)::text as s from public.reservations where lot_id = $1 and status = 'active'`, [lot]);
    expect(Number(total.s)).toBe(60);
  });

  it('rejects stale lot versions, past hard cutoffs, and unreviewed quality dates', async () => {
    const stale = await receive(U.ownerA, orgA, { ingredientId: 'rice', form: 'raw', quantity: 1000, enteredUnit: 'g', pool: 'food', storage: 'dry', lotRef: 'STALE' });
    await one(U.ownerA, 'select public.adjust_lot($1, $2, 900, $3, $4)', [orgA, stale, 'recount', key('a')]);
    await draftPlan(U.foodA, orgA, 'plan_stale', 'food');
    await expect(one(U.foodA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_stale', JSON.stringify([{ lotId: stale, ingredientId: 'rice', form: 'raw', quantity: 100, lotVersion: 1 }]), key('r')])).rejects.toThrow(/stale_plan/);

    const expired = await receive(U.ownerA, orgA, { ingredientId: 'rice', form: 'cooked', quantity: 1000, enteredUnit: 'g', pool: 'food', storage: 'refrigerated', hardDiscardDate: plusDays(-1), dateVerification: 'verified', lotRef: 'OLD-RICE' });
    await draftPlan(U.foodA, orgA, 'plan_expired', 'food');
    await expect(one(U.foodA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_expired', JSON.stringify([{ lotId: expired, ingredientId: 'rice', form: 'cooked', quantity: 100 }]), key('r')])).rejects.toThrow(/not_eligible.*hard cutoff/);

    const parm = await receive(U.ownerA, orgA, { ingredientId: 'parmesan', form: 'raw', quantity: 500, enteredUnit: 'g', pool: 'food', storage: 'refrigerated', qualityDate: plusDays(-2), useByDate: plusDays(3), dateVerification: 'verified', lotRef: 'PARM' });
    await draftPlan(U.foodA, orgA, 'plan_parm', 'food');
    const alloc = JSON.stringify([{ lotId: parm, ingredientId: 'parmesan', form: 'raw', quantity: 40 }]);
    await expect(one(U.foodA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_parm', alloc, key('r')])).rejects.toThrow(/quality date passed/);
    await expect(one(U.foodA, 'select public.approve_quality_review($1, $2, $3, $4)', [orgA, parm, plusDays(1), 'checked'])).rejects.toThrow(/only managers/);
    await expect(one(U.ownerA, 'select public.approve_quality_review($1, $2, $3, $4)', [orgA, parm, plusDays(10), 'checked'])).rejects.toThrow(/hard cutoff/);
    await one(U.ownerA, 'select public.approve_quality_review($1, $2, $3, $4)', [orgA, parm, plusDays(1), 'Checked rind and paste per SOP']);
    await expect(one(U.foodA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_parm', alloc, key('r')])).resolves.toBeTruthy();
  });

  it('prevents negative stock', async () => {
    const lot = await receive(U.ownerA, orgA, { ingredientId: 'flour', form: 'raw', quantity: 100, enteredUnit: 'g', pool: 'food', storage: 'dry', lotRef: 'FLR' });
    await expect(one(U.ownerA, 'select public.record_waste($1, $2, 150, $3, $4)', [orgA, lot, 'spill', key('w')])).rejects.toThrow(/exceeds unreserved/);
    await expect(one(U.ownerA, 'select public.adjust_lot($1, $2, -5, $3, $4)', [orgA, lot, 'oops', key('a')])).rejects.toThrow(/negative/);
    const c = await pool.connect();
    try {
      await expect(c.query('update public.lots set quantity = -1 where id = $1', [lot])).rejects.toThrow(/check constraint/);
    } finally {
      c.release();
    }
  });
});

describe('usage, prep, and idempotency', () => {
  it('retried receive and usage are idempotent; prep outputs keep lineage; ledger balances', async () => {
    const k = key('recv-once');
    const lotJson = JSON.stringify({ ingredientId: 'lime', form: 'raw', quantity: 20, enteredUnit: 'each', pool: 'shared', storage: 'refrigerated', operationalDiscardDate: plusDays(5), dateVerification: 'verified', lotRef: 'LIME-20', cost: { amount: 0.3, perQuantity: 1, perUnit: 'each' } });
    const r1 = await one<{ receive_lot: { lotId: string } }>(U.barA, 'select public.receive_lot($1, $2, $3)', [orgA, lotJson, k]);
    const r2 = await one<{ receive_lot: { lotId: string; replayed: boolean } }>(U.barA, 'select public.receive_lot($1, $2, $3)', [orgA, lotJson, k]);
    expect(r2.receive_lot.lotId).toBe(r1.receive_lot.lotId);
    expect(r2.receive_lot.replayed).toBe(true);
    const lime = r1.receive_lot.lotId;
    expect((await rows(U.ownerA, `select * from public.lots where lot_ref = 'LIME-20'`))).toHaveLength(1);

    await draftPlan(U.barA, orgA, 'plan_juice', 'bar', 'today', 'component', [{ recipeId: 'st_lime_juice', recipeVersionId: 'st_lime_juice_v1', requested: { kind: 'quantity', quantity: 300, unit: 'ml' } }]);
    await one(U.barA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_juice', JSON.stringify([{ lotId: lime, ingredientId: 'lime', form: 'raw', quantity: 10 }]), key('r')]);
    const outputs = JSON.stringify([{ recipeId: 'st_lime_juice', ingredientId: 'lime_juice', form: 'prepared', quantity: 290, enteredQuantity: 290, enteredUnit: 'ml', baseUnit: 'ml', pool: 'bar', storage: 'refrigerated', useByDate: plusDays(1), dateVerified: true }]);
    const ck = key('complete');
    const c1 = await one<{ complete_plan: { outputLotIds: string[] } }>(U.barA, 'select public.complete_plan($1, $2, $3, $4, $5, $6, $7)', [orgA, 'plan_juice', '[]', '[]', outputs, 'AM prep', ck]);
    const c2 = await one<{ complete_plan: { outputLotIds: string[]; replayed: boolean } }>(U.barA, 'select public.complete_plan($1, $2, $3, $4, $5, $6, $7)', [orgA, 'plan_juice', '[]', '[]', outputs, 'AM prep', ck]);
    expect(c2.complete_plan.replayed).toBe(true);
    expect(c2.complete_plan.outputLotIds).toEqual(c1.complete_plan.outputLotIds);
    const usage = await rows(U.ownerA, `select * from public.lot_movements where lot_id = $1 and type = 'usage'`, [lime]);
    expect(usage).toHaveLength(1);
    expect(Number((await one<{ quantity: string }>(U.ownerA, 'select quantity from public.lots where id = $1', [lime])).quantity)).toBe(10);
    const out = await rows(U.ownerA, `select * from public.lots where lineage->>'recipeId' = 'st_lime_juice'`);
    expect(out).toHaveLength(1);
    const lineage = out[0].lineage as { sources: { lotId: string; quantity: number }[]; inheritedCutoff: string };
    expect(lineage.sources).toEqual([{ lotId: lime, ingredientId: 'lime', quantity: 10 }]);
    expect(lineage.inheritedCutoff).toBe(plusDays(5));
    expect(Number((out[0].cost as { amount: number }).amount)).toBeCloseTo(3, 4);
    expect(await rows(U.ownerA, `select * from public.prep_batches where plan_id = 'plan_juice'`)).toHaveLength(1);

    const mismatch = await rows(U.ownerA, `
      select l.id from public.lots l left join public.lot_movements m on m.lot_id = l.id
      where l.org_id = $1 and l.quantity is not null group by l.id, l.quantity having l.quantity <> coalesce(sum(m.delta), 0)`, [orgA]);
    expect(mismatch).toEqual([]);
  });

  it('cancelling releases reservations', async () => {
    const lot = await receive(U.ownerA, orgA, { ingredientId: 'sugar', form: 'raw', quantity: 500, enteredUnit: 'g', pool: 'shared', storage: 'dry', lotRef: 'SUG-REL' });
    await draftPlan(U.barA, orgA, 'plan_cancel', 'bar');
    await one(U.barA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_cancel', JSON.stringify([{ lotId: lot, ingredientId: 'sugar', form: 'raw', quantity: 400 }]), key('r')]);
    await expect(one(U.ownerA, 'select public.record_waste($1, $2, 200, $3, $4)', [orgA, lot, 'spill', key('w')])).rejects.toThrow(/exceeds unreserved/);
    await one(U.barA, 'select public.release_plan($1, $2, $3, true)', [orgA, 'plan_cancel', 'event cancelled']);
    await expect(one(U.ownerA, 'select public.record_waste($1, $2, 200, $3, $4)', [orgA, lot, 'spill', key('w')])).resolves.toBeTruthy();
  });

  it('recipe versions are immutable and AI-draft plans cannot be reserved before review', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query(`update public.recipe_versions set lines = '[]' where id = 'st_daiquiri_v1'`)).rejects.toThrow(/immutable/);
    } finally {
      c.release();
    }
    await as(U.ownerA, async (cx) => {
      await cx.query(`insert into public.recipes(id, org_id, name, workspaces, category, provenance, current_version_id) values ('rec_ai', $1, 'AI fizz', '{bar}', 'zero_proof', '{"kind":"ai_draft","source":"AI draft"}', 'rec_ai_v1')`, [orgA]);
      await cx.query(`insert into public.recipe_versions(id, recipe_id, org_id, version, lines, yield, servings, confirmed) values ('rec_ai_v1', 'rec_ai', $1, 1, '[{"ingredientId":"sugar","quantity":10,"unit":"g"}]', '{"quantity":1,"unit":"serving"}', 1, false)`, [orgA]);
      await cx.query(`insert into public.plans(id, org_id, workspace, name, kind, service_date, targets, source) values ('plan_ai', $1, 'bar', 'AI', 'drink', (now() at time zone 'America/New_York')::date, '[{"recipeId":"rec_ai","recipeVersionId":"rec_ai_v1"}]', 'ai_draft')`, [orgA]);
    });
    const lot = await receive(U.ownerA, orgA, { ingredientId: 'sugar', form: 'raw', quantity: 100, enteredUnit: 'g', pool: 'shared', storage: 'dry', lotRef: 'SUG-AI' });
    await expect(one(U.barA, 'select public.reserve_plan($1, $2, $3, null, $4)', [orgA, 'plan_ai', JSON.stringify([{ lotId: lot, ingredientId: 'sugar', form: 'raw', quantity: 10 }]), key('r')])).rejects.toThrow(/AI-drafted/);
  });
});

describe('team management and atomic import', () => {
  const NEW = '00000000-0000-4000-8000-0000000000c1';
  const MGR = '00000000-0000-4000-8000-0000000000c2';

  it('invite codes are single-use, hashed at rest, and role-limited', async () => {
    const inv = (await one<{ create_invite: { code: string; inviteId: string } }>(U.ownerA, `select public.create_invite($1, 'manager', '{food,bar}', 'new sous')`, [orgA])).create_invite;
    const stored = await one<{ code_hash: string }>(U.ownerA, 'select code_hash from public.org_invites where id = $1', [inv.inviteId]);
    expect(stored.code_hash).not.toContain(inv.code);
    await one(MGR, 'select public.accept_invite($1, $2)', [inv.code, 'Sous chef']);
    await expect(one(NEW, 'select public.accept_invite($1, $2)', [inv.code, 'Again'])).rejects.toThrow(/invalid, used, or expired/);
    // managers cannot mint manager invites or promote anyone; staff cannot invite at all
    await expect(one(MGR, `select public.create_invite($1, 'manager', '{food}')`, [orgA])).rejects.toThrow(/only owners/);
    await expect(one(U.barA, `select public.create_invite($1, 'staff', '{bar}')`, [orgA])).rejects.toThrow(/only managers/);
    await expect(one(MGR, `select public.update_member($1, $2, 'owner', '{food,bar}')`, [orgA, U.barA])).rejects.toThrow(/only owners/);
    // managers can change staff workspaces
    await one(MGR, `select public.update_member($1, $2, 'staff', '{bar,food}')`, [orgA, U.barA]);
    expect((await one<{ workspaces: string[] }>(U.ownerA, 'select workspaces from public.memberships where org_id = $1 and user_id = $2', [orgA, U.barA])).workspaces).toEqual(['bar', 'food']);
    await one(MGR, `select public.update_member($1, $2, 'staff', '{bar}')`, [orgA, U.barA]);
    await expect(one(U.ownerA, `select public.update_member($1, $2, 'staff', '{food}', true)`, [orgA, U.ownerA])).rejects.toThrow(/at least one owner/);
    const revoked = (await one<{ create_invite: { code: string; inviteId: string } }>(U.ownerA, `select public.create_invite($1, 'staff', '{food}')`, [orgA])).create_invite;
    await one(U.ownerA, 'select public.revoke_invite($1, $2)', [orgA, revoked.inviteId]);
    await expect(one(NEW, 'select public.accept_invite($1, $2)', [revoked.code, 'x'])).rejects.toThrow(/invalid/);
    // invite rows are visible only to managers
    expect(await rows(U.barA, 'select * from public.org_invites')).toEqual([]);
    expect(await rows(U.ownerB, 'select * from public.org_invites where org_id = $1', [orgA])).toEqual([]);
  });

  it('import_lots is all-or-nothing and idempotent per file hash', async () => {
    const good = { ingredientId: 'rice', form: 'raw', quantity: 1000, enteredUnit: 'g', pool: 'food', storage: 'dry', lotRef: 'IMP-1' };
    const bad = { ...good, lotRef: 'IMP-BAD', ingredientId: 'no_such_ingredient' };
    await expect(one(U.ownerA, 'select public.import_lots($1, $2, $3, $4)', [orgA, 'a.csv', 'hash-bad', JSON.stringify([good, bad])])).rejects.toThrow();
    expect(await rows(U.ownerA, `select * from public.lots where lot_ref = 'IMP-1'`)).toEqual([]);
    const r1 = await one<{ import_lots: { created: number } }>(U.ownerA, 'select public.import_lots($1, $2, $3, $4)', [orgA, 'a.csv', 'hash-ok', JSON.stringify([good, { ...good, lotRef: 'IMP-2' }])]);
    expect(r1.import_lots.created).toBe(2);
    const r2 = await one<{ import_lots: { replayed: boolean } }>(U.ownerA, 'select public.import_lots($1, $2, $3, $4)', [orgA, 'a.csv', 'hash-ok', JSON.stringify([good])]);
    expect(r2.import_lots.replayed).toBe(true);
    expect(await rows(U.ownerA, `select * from public.lots where lot_ref in ('IMP-1','IMP-2')`)).toHaveLength(2);
    // staff cannot import into pools they cannot access
    await expect(one(U.barA, 'select public.import_lots($1, $2, $3, $4)', [orgA, 'b.csv', 'hash-staff', JSON.stringify([good])])).rejects.toThrow(/forbidden/);
  });
});
