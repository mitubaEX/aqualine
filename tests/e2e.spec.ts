import { test, expect, type Page } from '@playwright/test';
async function join(page:Page, dev=true){await page.goto('/');await page.getByRole('checkbox').check();if(dev){await page.getByText('開発・動作確認用',{exact:true}).click();await page.getByRole('button',{name:'テスト位置で入る（開発専用）'}).click();}else await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByRole('heading',{name:'いま、この道の上で'})).toBeVisible();}
const post=(page:Page,text:string)=>page.locator('article').filter({has:page.locator('.post-text',{hasText:text})});
test('mobile onboarding, GPS denial and low accuracy',async({page})=>{await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByRole('button',{name:'位置を確認して、広場へ'})).toBeDisabled();await expect(page.locator('article')).toHaveCount(0);await page.getByRole('checkbox').check();await page.evaluate(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(_s:unknown,e:(x:unknown)=>void)=>e({code:1})}}));await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByRole('alert')).toContainText('位置情報が許可されていません');await page.evaluate(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(s:(x:unknown)=>void)=>s({coords:{latitude:35.4645,longitude:139.8753,accuracy:500}})}}));await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByText(/参加チケットが終了|位置情報の精度/)).toBeVisible();await expect(page.locator('body')).not.toHaveJSProperty('scrollWidth',0);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);});
test('two clients live posts, reactions, reply, delete, report and mute',async({browser})=>{const a=await browser.newPage(),b=await browser.newPage();a.on('dialog',d=>d.accept());b.on('dialog',d=>d.accept());await join(a);await join(b);const text='QA 海のひとこと '+Date.now();await a.getByLabel('ひとこと',{exact:true}).fill(text);await a.getByRole('button',{name:'ひとこと送る'}).click();await expect(post(b,text)).toBeVisible();await post(b,text).getByRole('button',{name:'ありがとう',exact:true}).click();await expect(post(a,text).getByRole('button',{name:'ありがとう',exact:true})).toContainText('1');await post(b,text).getByRole('button',{name:'返信',exact:false}).click();const replyText='QA 返信 '+Date.now();await b.getByLabel('ひとこと',{exact:true}).fill(replyText);await b.getByRole('button',{name:'ひとこと送る'}).click();await expect(post(a,replyText).locator('.reply-context')).toBeVisible();await post(b,replyText).getByRole('button',{name:/投稿メニュー/}).click();await b.getByRole('button',{name:'自分の投稿を削除'}).click();await expect(post(a,replyText)).toHaveCount(0);await post(b,text).getByRole('button',{name:/投稿メニュー/}).click();await b.getByRole('button',{name:'この参加者をミュート'}).click();await expect(post(b,text)).toHaveCount(0);await expect(post(a,text)).toBeVisible();const c=await browser.newPage();c.on('dialog',d=>d.accept());await join(c);await post(c,text).getByRole('button',{name:/投稿メニュー/}).click();await c.getByRole('button',{name:'投稿を通報',exact:true}).click();await expect(post(c,text)).toHaveCount(0);await expect(post(a,text)).toBeVisible();await a.close();await b.close();await c.close();});
test('offline reconnect, unknown GPS grace and reliable outside revoke',async({page,context})=>{await page.clock.install();await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:35.4645,longitude:139.8753,accuracy:10});await join(page,false);await context.setOffline(true);await expect(page.getByText('オフラインです。再接続すると更新されます。送信はできません。')).toBeVisible();await page.getByLabel('ひとこと',{exact:true}).fill('offline test');await expect(page.getByRole('button',{name:'ひとこと送る'})).toBeDisabled();await context.setOffline(false);await expect(page.locator('.connection')).toHaveText('LIVE');await context.setGeolocation({latitude:35.4645,longitude:139.8753,accuracy:500});await page.clock.fastForward(61_000);await expect(page.getByText('位置情報が不確かなため、チケットは延長されていません。有効期限までは参加できます。')).toBeVisible();await context.setGeolocation({latitude:35,longitude:140,accuracy:10});await page.clock.fastForward(61_000);await expect(page.getByRole('heading',{name:'いま、同じ道にいますか？'})).toBeVisible();});
test('140 character bound and local ticket expiry removes feed',async({page})=>{await page.route('**/api/session',async route=>{const response=await route.fetch();const data=await response.json();data.session.expiresAt=data.session.serverNow+3000;await route.fulfill({response,json:data});});await join(page);await page.getByLabel('ひとこと',{exact:true}).fill('あ'.repeat(141));await expect(page.getByRole('button',{name:'ひとこと送る'})).toBeDisabled();await expect(page.getByRole('heading',{name:'いま、同じ道にいますか？'})).toBeVisible({timeout:6000});await expect(page.locator('article')).toHaveCount(0);});
test('429 keeps draft and retry succeeds; report capacity error remains honest with mute fallback',async({browser})=>{
 const a=await browser.newPage(),b=await browser.newPage();a.on('dialog',d=>d.accept());b.on('dialog',d=>d.accept());await join(a);await join(b);
 let rejectOnce=true;await a.route('**/api/posts',async route=>{if(route.request().method()==='POST'&&rejectOnce){rejectOnce=false;await route.fulfill({status:429,headers:{'Content-Type':'application/json','Retry-After':'1'},body:JSON.stringify({error:'操作が続いています。少しお待ちください'})});}else await route.continue();});
 const text='制限復帰 QA '+Date.now();await a.getByLabel('ひとこと',{exact:true}).fill(text);await a.getByRole('button',{name:'ひとこと送る'}).click();await expect(a.getByRole('alert')).toContainText('操作が続いています');await expect(a.getByLabel('ひとこと',{exact:true})).toHaveValue(text);await a.getByRole('button',{name:'ひとこと送る'}).click();await expect(post(b,text)).toBeVisible();
 await post(b,text).getByRole('button',{name:/返信/}).click();await b.getByLabel('ひとこと',{exact:true}).fill('返信の下書き');await b.getByRole('button',{name:'返信を取り消す'}).click();await expect(b.getByLabel('ひとこと',{exact:true})).toHaveValue('返信の下書き');
 await b.route('**/report',route=>route.fulfill({status:503,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:'通報の保存枠が満杯です。通報は保存されませんでした。ミュートを利用してください'})}));
 await post(b,text).getByRole('button',{name:/投稿メニュー/}).click();await b.getByRole('button',{name:'投稿を通報',exact:true}).click();await expect(b.getByRole('alert')).toContainText('保存されませんでした');await expect(post(b,text)).toBeVisible();await post(b,text).getByRole('button',{name:/投稿メニュー/}).click();await b.getByRole('button',{name:'この参加者をミュート'}).click();await expect(post(b,text)).toHaveCount(0);await a.close();await b.close();
});
test('public-map bridge position joins without dev bypass, outside and accuracy errors stay distinct',async({browser})=>{
 const context=await browser.newContext({permissions:['geolocation'],geolocation:{latitude:35.4488717,longitude:139.8970914,accuracy:81},viewport:{width:390,height:844}});
 const page=await context.newPage();await page.goto('/');await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByRole('alert')).toContainText('位置情報の精度が足りません');
 await context.setGeolocation({latitude:35.4468,longitude:139.9179,accuracy:10});
 await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByRole('alert')).toContainText('アクアラインのエリア外です');
 await context.setGeolocation({latitude:35.4488717,longitude:139.8970914,accuracy:80});
 await page.getByRole('button',{name:'位置を確認して、広場へ'}).click();await expect(page.getByRole('heading',{name:'いま、この道の上で'})).toBeVisible();
 await page.getByText('参加チケット・利用上の注意',{exact:true}).click();await page.getByRole('button',{name:/広場を退出する/}).click();
 await expect(page.getByRole('heading',{name:'いま、同じ道にいますか？'})).toBeVisible();await context.close();
});

test('same-tab reload validates server ticket without GPS or renewal; clock changes do not extend it',async({page,context})=>{
 await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:35.4488717,longitude:139.8970914,accuracy:10});
 await join(page,false);await expect(page.locator('.ticket-compact')).toContainText('60 分');
 const original=await page.evaluate(async()=>{const {token}=JSON.parse(sessionStorage.getItem('aqualine.ticket.v1')!);return (await (await fetch('/api/session',{headers:{Authorization:'Bearer '+token}})).json() as any).session;});
 let renewals=0;page.on('request',r=>{if(r.url().endsWith('/api/session/renew'))renewals++;});
 await page.addInitScript(()=>{Date.now=()=>1;Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(_s:unknown,e:(x:unknown)=>void)=>e({code:2})}});});
 await page.reload();await expect(page.getByRole('heading',{name:'いま、この道の上で'})).toBeVisible();
 await expect(page.locator('.ticket-compact')).toContainText('位置未確認・猶予中');await expect(page.locator('.ticket-compact')).toContainText('60 分');
 expect(renewals).toBe(0);
 const restored=await page.evaluate(async()=>{const saved=JSON.parse(sessionStorage.getItem('aqualine.ticket.v1')!);if(Object.keys(saved).sort().join(',')!=='dev,token')throw Error('Unexpected retained information');return (await (await fetch('/api/session',{headers:{Authorization:'Bearer '+saved.token}})).json() as any).session;});
 expect(restored.id).toBe(original.id);expect(restored.expiresAt).toBe(original.expiresAt);
 await page.evaluate(()=>{Date.now=()=>9e15;});await expect(page.getByRole('heading',{name:'いま、この道の上で'})).toBeVisible();
 await context.setOffline(true);await expect(page.getByText('オフラインです。再接続すると更新されます。送信はできません。')).toBeVisible();
 await context.setOffline(false);await expect(page.locator('.connection')).toHaveText('LIVE');expect(renewals).toBe(0);
 await page.getByText('参加チケット・利用上の注意',{exact:true}).click();await page.getByRole('button',{name:/広場を退出する/}).click();
 await expect(page.getByRole('heading',{name:'いま、同じ道にいますか？'})).toBeVisible();
 expect(await page.evaluate(()=>sessionStorage.getItem('aqualine.ticket.v1'))).toBeNull();
});
test('invalid stored data and invalid tickets never unlock the feed; transient restore failure can retry',async({page})=>{
 await page.goto('/');await page.evaluate(()=>sessionStorage.setItem('aqualine.ticket.v1','{invalid'));await page.reload();
 await expect(page.getByRole('heading',{name:'いま、同じ道にいますか？'})).toBeVisible();expect(await page.evaluate(()=>sessionStorage.getItem('aqualine.ticket.v1'))).toBeNull();
 await page.evaluate(()=>sessionStorage.setItem('aqualine.ticket.v1',JSON.stringify({token:'a'.repeat(68),expiresAt:9e15})));await page.reload();
 await expect(page.getByText('保存した参加券は無効または期限切れです。エリア内で入り直してください。')).toBeVisible();await expect(page.locator('.plaza')).toHaveCount(0);
 await join(page);let fail=true;
 await page.route('**/api/session',route=>route.request().method()==='GET'&&fail?route.fulfill({status:503,json:{error:'temporary'}}):route.continue());
 await page.reload();await expect(page.getByRole('button',{name:'保存した参加券の復元を再試行'})).toBeVisible();await expect(page.locator('.plaza')).toHaveCount(0);
 fail=false;await page.getByRole('button',{name:'保存した参加券の復元を再試行'}).click();await expect(page.locator('.plaza')).toBeVisible();
});

test('repeated geolocation failures keep the same deadline and show GPS uncertainty separately',async({page,context})=>{
 await page.clock.install();await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:35.4488717,longitude:139.8970914,accuracy:10});await join(page,false);
 const expiry=()=>page.evaluate(async()=>{const {token}=JSON.parse(sessionStorage.getItem('aqualine.ticket.v1')!);return (await (await fetch('/api/session',{headers:{Authorization:'Bearer '+token}})).json() as any).session.expiresAt;});
 const before=await expiry();let renewals=0;page.on('request',r=>{if(r.url().endsWith('/api/session/renew'))renewals++;});
 await page.evaluate(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(_s:unknown,e:(x:unknown)=>void)=>e({code:2})}}));
 for(let i=0;i<2;i++){await page.clock.fastForward(61_000);await expect(page.getByText('現在地を確認できないため、チケットは延長されていません。有効期限までは参加できます。')).toBeVisible();expect(await expiry()).toBe(before);}
 expect(renewals).toBe(0);await expect(page.locator('.ticket-compact')).toContainText('位置未確認・猶予中');await expect(page.locator('.connection')).toHaveText('LIVE');
});
