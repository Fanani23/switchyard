import { expect, test } from '@playwright/test';
import { api, openFlags, signIn, world } from './support';

test.describe('flag list (UX.md view 1)', () => {
  test('lists flags with their rollout, and distinguishes empty from filtered-empty', async ({
    page,
  }) => {
    const w = await world([
      { key: 'checkout-v2', rules: [{ kind: 'percentage', weights: { on: 10 } }] },
      { key: 'dark-mode', default: 'on' },
    ]);
    await signIn(page);
    await openFlags(page, w, 'staging');

    const rows = page.getByRole('list', { name: 'Flags' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'checkout-v2' })).toContainText('10% on');
    await expect(rows.filter({ hasText: 'dark-mode' })).toContainText('100% on');

    // Filter debounced; a filter that excludes everything offers to clear it.
    await page.getByLabel('Filter flags').fill('nothing-like-this');
    await expect(page.getByText('No flags match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(rows).toHaveCount(2);
  });

  test('an environment with no flags says so and offers Create flag', async ({ page }) => {
    const w = await world([]);
    await signIn(page);
    await openFlags(page, w, 'staging');
    await expect(page.getByText('No flags yet.')).toBeVisible();

    // Creating is not optimistic: the row appears once the server has it.
    await page.getByRole('button', { name: 'Create flag' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create flag' });
    await expect(dialog.getByLabel('Key')).toBeFocused();
    await dialog.getByLabel('Key').fill('brand-new');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('link', { name: 'brand-new' })).toBeVisible();
  });

  test('toggles are switches named after the flag, immediate outside production, with undo', async ({
    page,
  }) => {
    const w = await world([{ key: 'new-search' }]);
    await signIn(page);
    await openFlags(page, w, 'staging');

    const toggle = page.getByRole('switch', { name: 'new-search' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('status').getByText('new-search disabled')).toBeVisible();
    await expect
      .poll(async () => (await api.flag(w.staging.flags['new-search']!)).enabled)
      .toBe(false);

    // Undo issues the inverse request; the server is the judge.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await api.flag(w.staging.flags['new-search']!)).enabled)
      .toBe(true);
  });

  test('a partial rollout in production needs the flag key typed before it changes', async ({
    page,
  }) => {
    const rules = [{ kind: 'percentage', weights: { on: 25 } }];
    const w = await world([{ key: 'risky-change', rules }]);
    await signIn(page);
    await openFlags(page, w, 'production');

    const toggle = page.getByRole('switch', { name: 'risky-change' });
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: /Disable risky-change in production/ });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Disable' });
    await expect(confirm).toBeDisabled();

    // Escape cancels and nothing changes.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeFocused(); // focus returns to the trigger

    await toggle.click();
    await page.getByLabel(/Type risky-change to confirm/).fill('risky-change');
    await page.getByRole('button', { name: 'Disable' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => (await api.flag(w.production.flags['risky-change']!)).enabled)
      .toBe(false);
  });

  test('a change made elsewhere updates the row in place, without a reload', async ({ page }) => {
    const w = await world([{ key: 'live-flag' }]);
    await signIn(page);
    await openFlags(page, w, 'staging');
    const row = page.getByRole('listitem').filter({ hasText: 'live-flag' });
    await expect(row).toContainText('100% off');

    await api.rules(w.staging.flags['live-flag']!, [{ kind: 'percentage', weights: { on: 40 } }]);
    await expect(row).toContainText('40% on', { timeout: 5000 });
  });
});

test.describe('the incident path at phone width (UX.md: tested at 375 px)', () => {
  test.use({ viewport: { width: 375, height: 740 } });

  test('open, find the flag, toggle it off', async ({ page }) => {
    const w = await world([
      { key: 'payments-v3', default: 'on' },
      { key: 'other-thing' },
      { key: 'something-else' },
    ]);
    await signIn(page);
    await openFlags(page, w, 'production');

    await page.getByLabel('Filter flags').fill('payments');
    await expect(page.getByRole('listitem').filter({ hasText: 'other-thing' })).toHaveCount(0);
    const toggle = page.getByRole('switch', { name: 'payments-v3' });
    const box = await toggle.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box && box.x + box.width).toBeLessThanOrEqual(375);

    // At 100%, turning off is immediate even in production: no dialog in the way.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => (await api.flag(w.production.flags['payments-v3']!)).enabled)
      .toBe(false);
  });
});

test.describe('flag detail (UX.md view 2)', () => {
  test('a flag with no rules states the resulting behavior; rules can be added and saved', async ({
    page,
  }) => {
    const w = await world([{ key: 'detail-flag' }]);
    await signIn(page);
    await page.goto(`/flags/${w.staging.flags['detail-flag']}`);
    await expect(page.getByText('No rules. Every user gets off.')).toBeVisible();

    await page.getByRole('button', { name: 'Add percentage rule' }).click();
    await page.getByRole('spinbutton', { name: 'on percent' }).fill('30');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await expect(page.getByRole('status').getByText('Rules saved for detail-flag')).toBeVisible();
    await expect
      .poll(async () => (await api.flag(w.staging.flags['detail-flag']!)).rules)
      .toEqual([{ kind: 'percentage', weights: { on: 30 } }]);
  });

  test('rules reorder from the keyboard with Ctrl+Arrow', async ({ page }) => {
    const w = await world([
      {
        key: 'ordered',
        rules: [
          {
            kind: 'segment',
            clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
            serve: 'on',
          },
          { kind: 'percentage', weights: { on: 5 } },
        ],
      },
    ]);
    await signIn(page);
    await page.goto(`/flags/${w.staging.flags.ordered}`);
    const second = page.getByRole('listitem', { name: 'Rule 2: percentage' });
    await second.focus();
    await page.keyboard.press('Control+ArrowUp');
    await expect(page.getByRole('listitem', { name: 'Rule 1: percentage' })).toBeFocused();
    await page.getByRole('button', { name: 'Save rules' }).click();
    await expect
      .poll(
        async () => ((await api.flag(w.staging.flags.ordered!)).rules[0] as { kind: string }).kind,
      )
      .toBe('percentage');
  });

  test('a concurrent edit enters the conflict state instead of overwriting silently', async ({
    page,
  }) => {
    const w = await world([{ key: 'contended' }]);
    await signIn(page);
    await page.goto(`/flags/${w.staging.flags.contended}`);
    await page.getByRole('button', { name: 'Add percentage rule' }).click();

    // Someone else saves first.
    await api.rules(w.staging.flags.contended!, [{ kind: 'percentage', weights: { on: 90 } }]);

    // The live stream sees their change while ours is unsaved: the editor enters the
    // conflict state instead of updating underneath us, and Save is held until we choose.
    // (The save-time 409 precondition is covered by the API's integration tests.)
    const banner = page.getByText('Someone else changed this flag while you were editing.');
    await expect(banner).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save rules' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reload theirs' }).click();
    await expect(page.getByRole('spinbutton', { name: 'on percent' })).toHaveValue('90');
  });
});

test.describe('API keys (UX.md view 4) and audit (view 3)', () => {
  test('a new key is shown once, and is gone after navigating away', async ({ page }) => {
    const w = await world([]);
    await signIn(page);
    await page.goto(`/environments/${w.staging.id}/keys`);
    await expect(page.getByText('No keys yet.')).toBeVisible();

    await page.getByLabel('Name').fill('mobile app');
    await page.getByRole('button', { name: 'Create key' }).click();
    const secret = page.getByTestId('revealed-key');
    await expect(secret).toHaveText(/^sy_client_/);
    await expect(page.getByText('It will not be shown again.')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'mobile app' })).toBeVisible();

    // Never written to browser storage.
    const plaintext = await secret.textContent();
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    );
    expect(stored).not.toContain(plaintext);

    await page.getByRole('link', { name: 'Projects' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.goto(`/environments/${w.staging.id}/keys`);
    await expect(page.getByRole('listitem').filter({ hasText: 'mobile app' })).toBeVisible();
    await expect(page.getByTestId('revealed-key')).toHaveCount(0);
  });

  test('the audit log shows who changed what, newest first', async ({ page }) => {
    const w = await world([{ key: 'audited' }]);
    await api.patch(w.staging.flags.audited!, { enabled: false });
    await signIn(page);
    await page.goto(`/environments/${w.staging.id}/audit`);
    const entries = page.getByRole('listitem');
    await expect(entries.first()).toContainText('flag.disabled');
    await expect(entries.first()).toContainText('by root');
    await expect(entries.first()).toContainText('enabled');
    await expect(page.getByText('Beginning of history')).toBeVisible();
  });
});
