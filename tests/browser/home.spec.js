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

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
