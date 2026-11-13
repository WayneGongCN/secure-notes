import { expect, test } from '@playwright/test';

test('English and Chinese landing pages link to the app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Private notes. Your key.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Secure Notes' })).toHaveAttribute('href', '/app/');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '中文' }).click();
  await expect(page).toHaveURL(/\/zh\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: /私密笔记/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute('href', '/');

  await page.getByRole('link', { name: '打开加密记事本' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('button', { name: '新建笔记库', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '新建笔记库', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
