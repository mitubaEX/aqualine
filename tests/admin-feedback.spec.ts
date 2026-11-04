import {test,expect} from '@playwright/test';
test('operator inbox keeps its key out of browser storage and renders feedback as text',async({page})=>{
 let reads=0,reviewed=false;const key='browser-test-key-not-a-secret-12345';
 await page.route('**/api/admin/feedback**',async route=>{expect(route.request().headers().authorization).toBe('Bearer '+key);expect(route.request().url()).not.toContain(key);if(route.request().method()==='POST'){reviewed=true;await route.fulfill({json:{ok:true}});}else{reads++;await route.fulfill({json:{unread:reviewed?0:1,feedback:[{id:'test-id',category:'bug',text:'<img src=x onerror=alert(1)>',createdAt:Date.now(),...(reviewed?{reviewedAt:Date.now()}:{})}]}});}});
 await page.goto('/feedback-admin');expect(reads).toBe(0);
 await page.getByLabel('管理用キー').fill(key);await page.getByRole('button',{name:'受信箱を開く'}).click();
 await expect(page.getByRole('status')).toContainText('未確認 1 件');await expect(page.locator('.admin-feedback-text')).toHaveText('<img src=x onerror=alert(1)>');await expect(page.locator('.admin-feedback img')).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(key);
 await page.getByRole('button',{name:'確認済みにする'}).click();await expect(page.getByRole('status')).toContainText('未確認 0 件');
 await page.getByRole('button',{name:'閉じて消去'}).click();await expect(page.getByLabel('管理用キー')).toHaveValue('');await expect(page.locator('.admin-feedback-text')).toHaveCount(0);
});
