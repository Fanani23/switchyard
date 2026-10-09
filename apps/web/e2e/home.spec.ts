import { expect, test } from '@playwright/test';

test.describe('signed-out home page', () => {
  test('shows the pitch and the sign-in form', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Ship features without shipping code' }),
    ).toBeVisible();
    await expect(page.getByLabel('API key')).toBeVisible();
    // Nothing to submit until a key is typed.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  test('the brand returns to the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Switchyard' })).toBeVisible();
  });

  test('the theme toggle cycles system, light and dark', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^Theme: / });
    await expect(toggle).toHaveAccessibleName('Theme: follow system');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: follow system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  });

  test('the chosen theme survives a reload with no flash of the wrong one', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^Theme: / });
    await toggle.click();
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    // Set by the inline boot script, so it is already correct on the first paint.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAccessibleName('Theme: dark');
  });
});
