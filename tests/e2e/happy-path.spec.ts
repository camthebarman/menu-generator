import { expect, test } from '@playwright/test';

// Demo mode, frozen to a known anchor date so seed scenarios are deterministic.
const START = '/?demoReset=1&demoDate=2026-10-19#/discover';

test('bar: discover → draft plan → reserve → record usage, persisted across reload', async ({ page }) => {
  await page.goto(START);
  await expect(page.getByText('DEMO DATA')).toBeVisible();
  await page.getByRole('tab', { name: 'Bar' }).click();
  const makeNow = page.getByRole('region', { name: 'Make now' });
  await makeNow.getByRole('button', { name: /^Daiquiri/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Daiquiri' });
  await expect(dialog.getByText('Exact requirements & lot allocations')).toBeVisible();
  await expect(dialog.getByText('White rum (column still)', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save draft plan' }).click();
  await expect(page.getByText(/Draft plan saved/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /Daiquiri/ })).toBeVisible();

  await page.getByRole('button', { name: 'Reserve stock' }).click();
  await expect(page.getByText(/Reserved \d+ lot allocation/)).toBeVisible();
  await expect(page.getByText('Reserved lots — record actual usage')).toBeVisible();
  await page.getByRole('button', { name: 'Record usage' }).click();
  await expect(page.getByText(/^Recorded\./)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recorded' })).toBeVisible();

  await page.reload();
  await page.goto('/#/plans');
  await expect(page.getByRole('button', { name: /Daiquiri.*completed/ })).toBeVisible();
});

test('food: one-away recipe goes to a combined shopping list with exact amounts; CSV export', async ({ page }) => {
  await page.goto(START);
  await page.getByRole('tab', { name: 'Food' }).click();
  const need1 = page.getByRole('region', { name: 'Need 1 ingredient' });
  await need1.getByRole('button', { name: /Garlic shrimp/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Garlic shrimp' });
  await expect(dialog.getByText(/To buy \(1 distinct ingredient\)/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to shopping list' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: /Shopping list/ }).click();
  await expect(page.getByRole('cell', { name: 'Shrimp 16/20 (peeled)' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '600 g' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/shopping-food-2026-10-19\.csv/);
});

test('needs review and menu protection are visible; relaxing protection changes results', async ({ page }) => {
  await page.goto(START);
  const review = page.getByRole('region', { name: 'Needs review' });
  await expect(review.getByRole('button', { name: /Mushrooms with thyme & parmesan/ })).toBeVisible();
  await expect(page.getByText('Current menu protection incomplete').first()).toBeVisible();
  const need1 = page.getByRole('region', { name: 'Need 1 ingredient' });
  await expect(need1.getByRole('button', { name: /Beef & mushroom rice bowl/ })).toBeVisible();
  await page.getByRole('switch', { name: /Protect current menu stock/ }).click();
  await expect(page.getByRole('region', { name: 'Make now' }).getByRole('button', { name: /Beef & mushroom rice bowl/ })).toBeVisible();
});

test('responsive: phone layout has no horizontal scroll and core controls are reachable', async ({ page }) => {
  await page.goto(START);
  await expect(page.locator('[data-testid=result-card]').first()).toBeVisible();
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sw).toBeLessThanOrEqual(0);
  await expect(page.getByLabel('Portions')).toBeVisible();
  await expect(page.getByLabel('Service date')).toBeVisible();
  for (const s of ['inventory', 'menu', 'plans', 'shopping', 'recipes', 'settings']) {
    await page.goto(`/#/${s}`);
    await page.waitForTimeout(200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, s).toBeLessThanOrEqual(0);
  }
});
