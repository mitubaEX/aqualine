import { cleanRates, networkKeys, type RateState } from './limits';

export const FEEDBACK_MS = 30 * 24 * 60 * 60_000;
interface Entry { id:string; category:'bug'|'idea'|'other'; text:string; createdAt:number; reviewedAt?:number; key:string }
interface Inbox { entries:Entry[]; rates:RateState }
const empty=():Inbox=>({entries:[],rates:{salts:[],buckets:[]}});
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===429||status===503?{'Retry-After':'600'}:{})}});
const clean=(inbox:Inbox,now:number)=>{inbox.entries=inbox.entries.filter(e=>now-e.createdAt<FEEDBACK_MS);cleanRates(inbox.rates,now);};
export async function cleanFeedback(storage:DurableObjectStorage,now:number){
 await storage.transaction(async tx=>{const inbox=await tx.get<Inbox>('feedback-v1');if(inbox){clean(inbox,now);await tx.put('feedback-v1',inbox);}});
}
async function authorized(request:Request,secret?:string){
 if(!secret||secret.length<32)return false;
 const candidate=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
 const hash=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([hash(secret),hash(candidate)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export async function feedbackRoute(request:Request,body:any,storage:DurableObjectStorage,secret?:string):Promise<Response|null>{
 const path=new URL(request.url).pathname,admin=path.startsWith('/api/admin/feedback');
 if(path!=='/api/feedback'&&!admin)return null;
 if(!admin&&(!secret||secret.length<32))return json({error:'ご意見窓口は準備中です。時間をおいてお試しください'},503);
 if(admin&&!await authorized(request,secret))return json({error:'管理者認証が必要です'},401);
 if(path==='/api/feedback'&&request.method!=='POST')return json({error:'この操作はできません'},405);
 if(admin&&!(path==='/api/admin/feedback'&&request.method==='GET')&&!( /^\/api\/admin\/feedback\/[^/]+\/reviewed$/.test(path)&&request.method==='POST'))return json({error:'この操作はできません'},405);
 const now=Date.now();
 return storage.transaction(async tx=>{
  const inbox=await tx.get<Inbox>('feedback-v1')||empty();clean(inbox,now);
  if(admin){
   if(request.method==='GET'){await tx.put('feedback-v1',inbox);return json({unread:inbox.entries.filter(e=>!e.reviewedAt).length,feedback:inbox.entries.map(({key,...entry})=>entry).reverse()});}
   const id=path.split('/')[4],entry=inbox.entries.find(e=>e.id===id);if(!entry)return json({error:'見つかりません'},404);
   entry.reviewedAt=entry.reviewedAt||now;await tx.put('feedback-v1',inbox);return json({ok:true});
  }
  if(!body||!['bug','idea','other'].includes(body.category)||typeof body.text!=='string'||!body.text.trim()||[...body.text.trim()].length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body.text)||typeof body.idempotencyKey!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.idempotencyKey))return json({error:'種類を選び、本文を1〜500文字で入力してください'},400);
  const existing=inbox.entries.find(e=>e.key===body.idempotencyKey);
  if(existing){if(existing.text!==body.text.trim()||existing.category!==body.category)return json({error:'内容が変更されています。フォームを開き直してください'},409);return json({id:existing.id},200);}
  const address=request.headers.get('X-Aqua-Network');if(!address)return json({error:'接続元を確認できません。時間をおいてお試しください'},503);
  const keys=await networkKeys(inbox.rates,address,now);
  const count=inbox.rates.buckets.filter(([key])=>keys.includes(key)).reduce((n,[,b])=>n+b.posts.length,0);
  if(count>=3)return json({error:'同じ回線からのご意見は10分に3件までです。時間をおいてお試しください'},429);
  if(inbox.entries.length>=40)return json({error:'ご意見の保存枠が満杯です。時間をおいてお試しください'},503);
  const key=keys[keys.length-1];let bucket=inbox.rates.buckets.find(([k])=>k===key);
  if(!bucket){if(inbox.rates.buckets.length>=100)return json({error:'混み合っています。時間をおいてお試しください'},503);bucket=[key,{admissions:[],posts:[]}];inbox.rates.buckets.push(bucket);}
  bucket[1].posts.push(now);
  const entry:Entry={id:crypto.randomUUID(),category:body.category,text:body.text.trim(),createdAt:now,key:body.idempotencyKey};inbox.entries.push(entry);
  if(new TextEncoder().encode(JSON.stringify(inbox)).byteLength>96*1024)return json({error:'ご意見の保存枠が満杯です。時間をおいてお試しください'},503);
  await tx.put('feedback-v1',inbox);return json({id:entry.id},201);
 });
}
