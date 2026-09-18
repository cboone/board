import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('renders the fixture preview and can change the theme', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      name: 'A clearer way to decide what to start next.',
    }),
  ).toBeVisible();
  await expect(page.getByText('No GitHub access in previews')).toBeVisible();

  await page.getByRole('button', { name: 'Use dark theme' }).click();

  await expect(
    page.getByRole('button', { name: 'Use light theme' }),
  ).toBeVisible();

  const themeButton = page.getByRole('button', {
    name: 'Use light theme',
  });
  await themeButton.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Use dark theme' }),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('preserves an explicit theme when the device prefers dark colors', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Use light theme' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Use light theme' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('link', { name: 'View sample report' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('heading', { name: 'Sample backlog report' }),
  ).toBeVisible();
});
