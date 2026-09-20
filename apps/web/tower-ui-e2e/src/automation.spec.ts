import { expect, test } from '@playwright/test';

test('the browser can explore the catalog and clearly sees the desktop requirement', async ({ page }) => {
  await page.goto('/automation');
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View Ping results and details', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/ping$/);
  await expect(page.getByRole('heading', { name: 'Open Admin-Tower for Linux' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run ping', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ping', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Automation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task catalog' })).toBeVisible();
});
