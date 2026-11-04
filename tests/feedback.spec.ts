import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByText('ご意見・不具合を送る', { exact: true }).click();
});

test('feedback validates Unicode count and sends only explicit content without a ticket', async ({ page }) => {
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/feedback', async route => {
    payload = route.request().postDataJSON();
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({ json: { id: 'confirmed-feedback' } });
  });
  const input = page.getByLabel('ご意見（1〜500文字）');
  const submit = page.getByRole('button', { name: '運営に送る', exact: true });
  await expect(submit).toBeDisabled();
  await input.fill('🌊'.repeat(501));
  await expect(submit).toBeDisabled();
  await input.fill('🌊'.repeat(500));
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('.feedback [role="status"]')).toContainText('ご意見を受け付けました');
  expect(Object.keys(payload!).sort()).toEqual(['category', 'idempotencyKey', 'text']);
  expect(payload!.text).toBe('🌊'.repeat(500));
  expect(payload!.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  await expect(input).toHaveValue('');
});

test('feedback retains failed content, retries the same key and changes key on edits', async ({ page }) => {
  const keys: string[] = [];
  await page.route('**/api/feedback', async route => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length < 3) await route.abort('failed');
    else await route.fulfill({ json: { id: 'received' } });
  });
  const input = page.getByLabel('ご意見（1〜500文字）');
  const submit = page.getByRole('button', { name: '運営に送る', exact: true });
  await input.fill('海の色が好きです');
  await submit.click();
  await expect(page.locator('.feedback [role="alert"]')).toBeVisible();
  await expect(input).toHaveValue('海の色が好きです');
  await submit.click();
  await expect(page.locator('.feedback [role="alert"]')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await input.fill('海の色が好きです。また使いたいです');
  await submit.click();
  await expect(page.locator('.feedback [role="status"]')).toContainText('ご意見を受け付けました');
  expect(keys[2]).not.toBe(keys[1]);
});

test('feedback ignores duplicate submission and requires confirmed server receipt', async ({ page }) => {
  let requests = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/feedback', async route => {
    requests++;
    await gate;
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByLabel('ご意見（1〜500文字）').fill('機能を増やしてほしい');
  await page.locator('.feedback form').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: '送信中…', exact: true })).toBeDisabled();
  await expect.poll(() => requests).toBe(1);
  release!();
  await expect(page.locator('.feedback [role="alert"]')).toContainText('送信を確認できませんでした');
  await expect(page.getByLabel('ご意見（1〜500文字）')).toHaveValue('機能を増やしてほしい');
  await expect(page.locator('.feedback [role="status"]')).not.toContainText('受け付けました');
});

test('feedback remains readable at 320px with native keyboard disclosure', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const disclosure = page.locator('.feedback summary');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('ご意見（1〜500文字）')).not.toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('ご意見（1〜500文字）')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
