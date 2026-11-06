import { test, expect } from '@playwright/test';

test('outsiders read aggregated statuses without GPS, tickets, or individual posts', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {value: {getCurrentPosition: () => { throw new Error('Public viewing must not request GPS'); }}});
  });
  let requests = 0;
  await page.route('**/api/congestion', async route => {
    requests++;
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({json:{generatedAt: Date.now(), windowStart: Date.now()-900000, windowMinutes:15,minimumSamples:3,directions:[
      {direction:'tokyo',sampleSize:4,counts:{jammed:1,busy:2,moving:1,clear:0},leading:['busy']},
      {direction:'kisarazu',sampleSize:0,counts:null,leading:[]}
    ]}});
  });
  await page.goto('/');
  const panel = page.getByRole('region',{name:'みんなの混雑状況'});
  await expect(panel).toContainText('混み が最多');
  await expect(panel).toContainText('回答 4 件（参加券単位）');
  await expect(panel).toContainText('回答不足・判定できません');
  await expect(page.getByRole('button',{name:'位置を確認して、広場へ'})).toBeDisabled();
  // React StrictMode may start then abort the first development-only effect.
  expect(requests).toBeGreaterThanOrEqual(1);expect(requests).toBeLessThanOrEqual(2);
});

test('failed public summary supports retry without showing stale counts', async ({ page }) => {
  let fail = true;
  await page.route('**/api/congestion', async route => {
    if (fail) return route.fulfill({status:503,json:{error:'unavailable'}});
    await route.fulfill({json:{generatedAt:Date.now(),windowStart:Date.now()-900000,windowMinutes:15,minimumSamples:3,directions:[{direction:'tokyo',sampleSize:0,counts:null,leading:[]},{direction:'kisarazu',sampleSize:0,counts:null,leading:[]}]}});
  });
  await page.goto('/');
  const panel=page.getByRole('region',{name:'みんなの混雑状況'});
  await expect(panel).toContainText('混雑状況を更新できません');
  fail=false;await panel.getByRole('button',{name:'再試行'}).click();
  await expect(panel).toContainText('回答不足・判定できません');
});

test('participant can submit congestion without text and delete the test post',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('checkbox').check();await page.getByText('開発・動作確認用',{exact:true}).click();await page.getByRole('button',{name:'テスト位置で入る（開発専用）'}).click();
 await expect(page.locator('.plaza')).toBeVisible();await page.locator('.congestion-select').getByRole('button',{name:'動いてる',exact:true}).click();await page.getByRole('button',{name:'ひとこと送る'}).click();
 const mine=page.locator('article').filter({has:page.locator('.you')}).filter({has:page.locator('.congestion-tag',{hasText:'動いてる'})});await expect(mine).toHaveCount(1);await expect(mine.locator('.post-text')).toHaveText('動いてる');
 page.on('dialog',d=>d.accept());await mine.getByRole('button',{name:/投稿メニュー/}).click();await page.getByRole('button',{name:'自分の投稿を削除'}).click();await expect(mine).toHaveCount(0);await page.getByRole('button',{name:'退出する',exact:true}).click();await expect(page.locator('.plaza')).toHaveCount(0);
});


test('optional congestion follows send controls on mobile and desktop, with keyboard and combined submission', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox').check();
  await page.getByText('開発・動作確認用', { exact: true }).click();
  await page.getByRole('button', { name: 'テスト位置で入る（開発専用）' }).click();
  await expect(page.locator('.plaza')).toBeVisible();
  const send = page.getByRole('button', { name: 'ひとこと送る' });
  const choices = page.getByRole('group', { name: 'いまの混雑状況（任意）' });
  const moving = choices.getByRole('button', { name: '動いてる', exact: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await choices.scrollIntoViewIfNeeded();
    const sendBox = await send.boundingBox();
    const choicesBox = await choices.boundingBox();
    expect(choicesBox!.y).toBeGreaterThanOrEqual(sendBox!.y + sendBox!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await moving.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `previews/congestion-below-${width}.png` });
  }
  await expect(send).toBeDisabled();
  await moving.focus();
  await page.keyboard.press('Space');
  await expect(moving).toHaveAttribute('aria-pressed', 'true');
  await expect(send).toBeEnabled();
  await page.keyboard.press('Space');
  await expect(moving).toHaveAttribute('aria-pressed', 'false');
  await expect(send).toBeDisabled();
  await moving.click();
  const text = '補助の混雑情報 QA ' + Date.now();
  await page.getByLabel('ひとこと', { exact: true }).fill(text);
  await send.click();
  const mine = page.locator('article').filter({ hasText: text });
  await expect(mine.locator('.congestion-tag')).toHaveText('動いてる');
  await expect(moving).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('ひとこと', { exact: true })).toHaveValue('');
  page.on('dialog', d => d.accept());
  await mine.getByRole('button', { name: /投稿メニュー/ }).click();
  await page.getByRole('button', { name: '自分の投稿を削除' }).click();
  await expect(mine).toHaveCount(0);
  await page.getByRole('button', { name: '退出する', exact: true }).click();
});
