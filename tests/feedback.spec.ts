import {test,expect} from '@playwright/test';
const url='https://docs.google.com/forms/d/e/1FAIpQLSeIQZRPsiWgp8Za9JuBKBd2PZrdGhycglW76tJvMKEjOBGwZA/viewform';
test('feedback is a clear external link with no ticket, coordinates or local inbox',async({page})=>{
 await page.goto('/');
 const link=page.getByRole('link',{name:'ご意見・不具合を送る'});
 await expect(link).toHaveAttribute('href',url);await expect(link).toHaveAttribute('target','_blank');await expect(link).toHaveAttribute('rel','noopener noreferrer');await expect(link).toHaveAttribute('referrerpolicy','no-referrer');
 for(const width of [320,390]){await page.setViewportSize({width,height:844});await link.scrollIntoViewIfNeeded();await expect(link).toBeVisible();expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.screenshot({path:`/tmp/aqua-google-feedback-${width}.png`});}
 await expect(page.locator('.feedback')).toContainText('新しいタブ');await expect(page.locator('.feedback input,.feedback textarea')).toHaveCount(0);
 await page.goto('/feedback-admin');await expect(page.getByLabel('管理用キー')).toHaveCount(0);
});
