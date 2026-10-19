// Post-deploy smoke test against the REAL Supabase project.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
//   SMOKE_EMAIL=smoke@yourdomain SMOKE_PASSWORD=... [APP_URL=https://app.yourdomain] \
//   node scripts/smoke-live.mjs
//
// Uses a dedicated smoke-test account (create it once in the app or the Supabase dashboard).
// It creates/reuses an organization named "Smoke test (do not use)" owned by that account and
// writes only there. Each run adds one tiny lot and immediately zeroes it via an audited adjustment.
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_ACCESS_TOKEN, APP_URL } = process.env;
// SMOKE_ACCESS_TOKEN (a signed JWT) replaces the password sign-in; used to self-test this script locally.
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || (!SMOKE_ACCESS_TOKEN && (!SMOKE_EMAIL || !SMOKE_PASSWORD))) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY, SMOKE_EMAIL, SMOKE_PASSWORD');
  process.exit(2);
}
const ORG_NAME = 'Smoke test (do not use)';
let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name} — ${e.message ?? e}`);
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const db = SMOKE_ACCESS_TOKEN
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { accessToken: async () => SMOKE_ACCESS_TOKEN })
  : createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
let orgId = null;

console.log(`Smoke test: ${SUPABASE_URL}`);
await check('anonymous users cannot read tenant data', async () => {
  const { data, error } = await anon.from('lots').select('id').limit(1);
  must(error || (data ?? []).length === 0, 'anon could read lots');
  return error ? `denied (${error.code ?? error.message})` : 'empty result';
});
await check('anonymous users cannot call inventory functions', async () => {
  const { error } = await anon.rpc('whoami');
  must(error, 'anon could execute whoami');
});
if (!SMOKE_ACCESS_TOKEN) {
  await check('sign in with smoke account', async () => {
    const { error } = await db.auth.signInWithPassword({ email: SMOKE_EMAIL, password: SMOKE_PASSWORD });
    must(!error, error?.message);
  });
}
await check('whoami returns the signed-in user', async () => {
  const { data, error } = await db.rpc('whoami');
  must(!error && data?.userId, error?.message ?? 'no user id');
});
await check('public starter library is present (migrations applied)', async () => {
  const { count, error } = await db.from('recipes').select('id', { count: 'exact', head: true }).is('org_id', null);
  must(!error, error?.message);
  must(count >= 56, `expected >= 56 starter recipes, found ${count}`);
  return `${count} starter recipes`;
});
await check('smoke organization exists (created on first run)', async () => {
  const { data, error } = await db.from('memberships').select('org_id, role, organizations(name)');
  must(!error, error?.message);
  const found = (data ?? []).find((m) => m.organizations?.name === ORG_NAME);
  if (found) { orgId = found.org_id; return `reused ${orgId}`; }
  const res = await db.rpc('create_organization', { p_name: ORG_NAME, p_timezone: 'America/New_York', p_display_name: 'Smoke test' });
  must(!res.error, res.error?.message);
  orgId = res.data;
  return `created ${orgId}`;
});
await check('starter ingredients were provisioned into the org', async () => {
  const { count, error } = await db.from('ingredients').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  must(!error && count >= 100, error?.message ?? `only ${count} ingredients`);
  return `${count} ingredients`;
});
await check('receive, adjust, and ledger balance in one round trip', async () => {
  const key = `smoke-${new Date().toISOString()}`;
  const recv = await db.rpc('receive_lot', { p_org: orgId, p_lot: { ingredientId: 'sugar', form: 'raw', quantity: 1, enteredUnit: 'g', pool: 'shared', storage: 'dry', lotRef: 'SMOKE' }, p_idem: key });
  must(!recv.error, recv.error?.message);
  const again = await db.rpc('receive_lot', { p_org: orgId, p_lot: { ingredientId: 'sugar', form: 'raw', quantity: 1, enteredUnit: 'g', pool: 'shared', storage: 'dry', lotRef: 'SMOKE' }, p_idem: key });
  must(again.data?.replayed === true && again.data.lotId === recv.data.lotId, 'retry was not idempotent');
  const adj = await db.rpc('adjust_lot', { p_org: orgId, p_lot_id: recv.data.lotId, p_new_quantity: 0, p_reason: 'Smoke test cleanup', p_idem: `${key}-zero` });
  must(!adj.error, adj.error?.message);
  const neg = await db.rpc('adjust_lot', { p_org: orgId, p_lot_id: recv.data.lotId, p_new_quantity: -1, p_reason: 'x', p_idem: `${key}-neg` });
  must(neg.error, 'negative stock was accepted');
  const { data: mv } = await db.from('lot_movements').select('delta').eq('lot_id', recv.data.lotId);
  const sum = (mv ?? []).reduce((a, m) => a + Number(m.delta), 0);
  must(Math.abs(sum) < 1e-9, `ledger sum ${sum} != 0`);
  return 'idempotent, non-negative, balanced';
});
await check('ledger is append-only for clients', async () => {
  const { error, count } = await db.from('lot_movements').update({ reason: 'tamper' }, { count: 'exact' }).eq('org_id', orgId);
  must(error || !count, 'movement rows were updated');
});
if (APP_URL) {
  await check('web app serves with security headers', async () => {
    const r = await fetch(APP_URL);
    must(r.ok, `HTTP ${r.status}`);
    const csp = r.headers.get('content-security-policy') ?? '';
    must(csp.includes("frame-ancestors 'none'"), 'missing CSP header');
    must(csp.includes(new URL(SUPABASE_URL).hostname) || csp.includes('*.supabase.co'), 'CSP connect-src does not allow the Supabase URL');
    return 'CSP present';
  });
  await check('ai-assist function is deployed (optional)', async () => {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-assist`, { method: 'OPTIONS' });
    return r.ok ? 'reachable' : `not deployed (HTTP ${r.status}) — fine if AI is off`;
  });
}
if (!SMOKE_ACCESS_TOKEN) await db.auth.signOut();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
