import { createHmac } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';

// Supabase Auth isn't running in this harness, so we inject a signed session where supabase-js
// stores it. Everything after that is real: PostgREST, RLS, and the SQL functions.
const SECRET = process.env.LIVE_JWT_SECRET ?? 'test-only-jwt-secret-at-least-32-characters-long';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function session(sub: string, email: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub, role: 'authenticated', aud: 'authenticated', email, exp });
  const token = `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
  return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'unused', user: { id: sub, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
}
async function signedIn(context: BrowserContext, sub: string, email: string) {
  await context.addInitScript(([s]) => { window.localStorage.setItem('sb-127-auth-token', s); }, [JSON.stringify(session(sub, email))]);
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const tomorrow = (() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

test.describe.configure({ mode: 'serial' });
let inviteCode = '';

test('owner creates an org, stocks the bar, and runs a daiquiri plan end to end', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signedIn(ctx, '20000000-0000-4000-8000-000000000001', 'owner@example.test');
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByText('Try the local demo instead')).toHaveCount(0); // VITE_ALLOW_DEMO=false
  await page.getByLabel('Restaurant / bar name').fill('Live Bistro');
  await page.getByLabel('Your name', { exact: true }).fill('Olive');
  await page.getByLabel('Timezone (IANA)').fill('America/New_York');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
  await expect(page.getByText('DEMO DATA')).toHaveCount(0);
  await expect(page.getByText('Olive · owner')).toBeVisible();

  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Quick add' }).click();
  const receive = async (ingredient: string, form: string, qty: string, unit: string, pool: string, useBy?: string) => {
    await page.getByLabel('Ingredient').selectOption({ label: ingredient });
    await page.getByLabel('Form').selectOption(form);
    await page.getByLabel('Quantity', { exact: true }).fill(qty);
    await page.getByLabel('Unit', { exact: true }).selectOption(unit);
    await page.getByLabel('Pool').selectOption(pool);
    if (useBy) await page.getByLabel('Use-by').fill(useBy);
    await page.getByRole('button', { name: 'Receive lot' }).click();
    await expect(page.getByLabel('Ingredient')).toHaveValue(''); // form resets only after the server confirms
    await expect(page.getByText('Lot received.').last()).toBeVisible();
  };
  await receive('White rum (column still)', 'raw', '750', 'ml', 'bar');
  await receive('Lime juice (fresh)', 'prepared', '300', 'ml', 'shared', tomorrow);
  await receive('Simple syrup 1:1', 'prepared', '500', 'ml', 'bar', tomorrow);

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Assume Ice on hand' }).click();
  await expect(page.getByRole('button', { name: 'Stop assuming Ice on hand' })).toBeVisible();

  await page.getByRole('link', { name: 'Discover' }).click();
  await page.getByRole('tab', { name: 'Bar' }).click();
  await page.getByRole('region', { name: 'Make now' }).getByRole('button', { name: /^Daiquiri/ }).click();
  await page.getByRole('dialog', { name: 'Daiquiri' }).getByRole('button', { name: 'Save draft plan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Daiquiri/ })).toBeVisible();
  await page.getByRole('button', { name: 'Reserve stock' }).click();
  await expect(page.getByText(/Reserved \d+ lot allocation/)).toBeVisible();
  await page.getByRole('button', { name: 'Record usage' }).click();
  await expect(page.getByRole('heading', { name: 'Recorded' })).toBeVisible();

  // Fresh load from the server shows the consumed stock: 750 ml − 2 drinks × 2 US fl oz.
  await page.reload();
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('row', { name: /White rum \(column still\).*631\.7 ml/ })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('checkbox', { name: 'bar' }).last().check();
  await page.getByRole('checkbox', { name: 'food' }).last().uncheck();
  await page.getByLabel("Note (who it's for)").fill('New bartender');
  await page.getByRole('button', { name: 'Create invite code' }).click();
  inviteCode = (await page.locator('code').first().innerText()).trim();
  expect(inviteCode.length).toBeGreaterThan(8);
  await ctx.close();
});

test('bar staff joins with the invite code and is limited to Bar + Shared', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signedIn(ctx, '20000000-0000-4000-8000-000000000002', 'bar@example.test');
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Invite code').fill(inviteCode.toLowerCase());
  await page.getByLabel('Your name (shown to your team)').fill('Bea');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Bea · staff')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Food' })).toBeDisabled();
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('row', { name: /White rum/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /All pools/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Food only' })).toHaveCount(0);
  await ctx.close();
});

test('a stranger with no membership sees only the join/create screen', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signedIn(ctx, '20000000-0000-4000-8000-000000000003', 'stranger@example.test');
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Join with an invite code' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your organizations' })).toHaveCount(0);
  await ctx.close();
});
