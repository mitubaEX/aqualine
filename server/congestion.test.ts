import { describe, it, expect, vi, afterEach } from 'vitest';
import { congestionSummary, validCongestion } from './congestion';
import { Plaza } from './index';
import { memoryStorage } from './test-storage';
import type { Post } from './domain';
const now = 1_000_000;
function post(id: string, congestion: Post['congestion'] = 'busy', createdAt = now): Post {
 return { id, authorId: id, name: 'private name', direction: 'tokyo', text: 'private text', congestion, createdAt, reactions: {wave: [], thanks: [], same: []} };
}
afterEach(() => vi.useRealTimers());
describe('privacy-preserving congestion aggregate', () => {
 it('deduplicates tickets, suppresses small samples and never exposes individual data', () => {
  const posts = [post('a'), post('b'), post('c'), {...post('new', 'clear'), authorId: 'a'}];
  const summary = congestionSummary(posts, now);
  expect(summary.directions[0]).toEqual({direction:'tokyo', sampleSize:3, counts:{jammed:0,busy:2,moving:0,clear:1}, leading:['busy']});
  expect(summary.directions[1].counts).toBeNull();
  const serialized = JSON.stringify(summary);
  for (const value of ['authorId', 'private name', 'private text', 'location', 'session']) expect(serialized).not.toContain(value);
  expect(congestionSummary(posts.slice(0,2), now).directions[0].counts).toBeNull();
 });
 it('ignores legacy, expired, future, quarantined data and handles ties without guessing', () => {
  const legacy = post('legacy'); delete legacy.congestion;
  const posts = [legacy, post('expired','busy',now-900000),post('future','busy',now+1),{...post('reported'),reportedAt:now},post('a'),post('b'),post('c','clear'),post('d','clear')];
  expect(congestionSummary(posts,now).directions[0].leading).toEqual(['busy','clear']);
  expect(congestionSummary(posts,now).directions[0].sampleSize).toBe(4);
  expect(validCongestion(undefined)).toBeUndefined();
  for(const value of [null,1,'unknown',{},''])expect(()=>validCongestion(value)).toThrow();
 });
 it('failed status saves do not leak into aggregates and deleted posts vanish', async () => {
  vi.useFakeTimers();vi.setSystemTime(now);
  const {saved,storage,failNext}=memoryStorage();
  const session={id:'a',name:'private',direction:'tokyo',expiresAt:now+3600000,posts:[]};
  saved.set('plaza',{sessions:[['token',session]],posts:[post('a'),post('b'),post('c')]});
  const plaza=new Plaza({storage,blockConcurrencyWhile:(f:any)=>f()} as any,{ENVIRONMENT:'development'} as any);
  const call=(path:string,method='GET',body?:unknown)=>plaza.fetch(new Request('http://localhost/api'+path,{method,headers:{Authorization:'Bearer token'},body:body===undefined?undefined:JSON.stringify(body)}));
  await call('/congestion');
  // Ignore ticket-usage persistence, fail only the snapshot write inside its transaction.
  const put=storage.put;storage.put=async(k:string,v:unknown)=>{if(k==='reports-v1'){storage.put=put;failNext();}return put(k,v);};
  expect((await call('/posts','POST',{congestion:'clear'})).status).toBe(503);
  expect((await (await call('/congestion')).json() as any).directions[0].counts.busy).toBe(3);
  expect((await call('/posts/a','DELETE')).status).toBe(200);
  const summary=await (await call('/congestion')).json() as any;
  expect(summary.directions[0].sampleSize).toBe(2);expect(summary.directions[0].counts).toBeNull();
 });
 it('public GET works without ticket, while posting remains protected and validated', async () => {
  vi.useFakeTimers();vi.setSystemTime(now);
  const {saved,storage}=memoryStorage();
  const plaza=new Plaza({storage,blockConcurrencyWhile:(f:any)=>f()} as any,{ENVIRONMENT:'development'} as any);
  const call=(path:string,body?:unknown,token?:string)=>plaza.fetch(new Request('http://localhost/api'+path,{method:body===undefined?'GET':'POST',headers:token?{Authorization:'Bearer '+token}:{},body:body===undefined?undefined:JSON.stringify(body)}));
  expect((await call('/congestion')).status).toBe(200);
  expect((await call('/posts')).status).toBe(401);
  expect((await call('/posts',{congestion:'busy'})).status).toBe(401);
  const ticket=await (await call('/session',{passenger:true,direction:'tokyo',dev:true})).json() as any;
  expect((await call('/posts',{congestion:'made-up'},ticket.token)).status).toBe(400);
  expect((await call('/posts',{congestion:'jammed',direction:'kisarazu',createdAt:0},ticket.token)).status).toBe(201);
  const p=saved.get('plaza').posts[0];expect(p.direction).toBe('tokyo');expect(p.createdAt).toBe(now);expect(p.text).toBe('激混み');
  expect((await (await call('/posts',undefined,ticket.token)).json() as any).posts[0].congestion).toBe('jammed');
  const restarted=new Plaza({storage,blockConcurrencyWhile:(f:any)=>f()} as any,{ENVIRONMENT:'development'} as any);
  const summary=await (await restarted.fetch(new Request('http://localhost/api/congestion'))).json() as any;
  expect(summary.directions[0].sampleSize).toBe(1);expect(summary.directions[0].counts).toBeNull();
 });
});
