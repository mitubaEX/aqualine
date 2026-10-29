import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { Plaza } from './index';
import { LIMITS } from './limits';
import { TICKET_MS, DELETE_MS, QUARANTINE_MS } from './domain';

function fixture(seed?: any) {
 const saved=new Map<string,any>();if(seed)saved.set('plaza',structuredClone(seed));
 let fail=false;
 const state={blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),storage:{
  get:async(k:string)=>structuredClone(saved.get(k)),
  put:async(k:string,v:any)=>{if(fail){fail=false;throw Error('private storage diagnostic');}saved.set(k,structuredClone(v));},
  getAlarm:async()=>null,setAlarm:async()=>{},
 }};
 let plaza=new Plaza(state as any,{ENVIRONMENT:'development'} as any);
 const call=async(path:string,body?:any,token?:string,network='fixture-a',method=body===undefined?'GET':'POST')=>{
  const r=await plaza.fetch(new Request('http://localhost/api'+path,{method,headers:{'X-Aqua-Network':network,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
  return {status:r.status,data:await r.json() as any,retry:r.headers.get('Retry-After')};
 };
 const enter=async(network='fixture-a')=>call('/session',{passenger:true,direction:'tokyo',dev:true},undefined,network);
 return {saved,call,enter,get plaza(){return plaza;},restart(){plaza=new Plaza(state as any,{ENVIRONMENT:'development'} as any);},failNext(){fail=true;}};
}
function session(){return {id:'owner',name:'テスト',direction:'tokyo',expiresAt:Date.now()+TICKET_MS,posts:[]};}
function post(id='p'){return {id,authorId:'owner',name:'テスト',direction:'tokyo',text:'テスト投稿',createdAt:Date.now(),reactions:{wave:[],thanks:[],same:[]}};}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('small deployment bounds and persistence',()=>{
 it('initializes durable storage and preserves an alarm across cold construction',async()=>{
  const stored=new Map<string,unknown>();const setAlarm=vi.fn();
  const state={blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),storage:{get:async(k:string)=>stored.get(k),put:async(k:string,v:unknown)=>{stored.set(k,structuredClone(v));},getAlarm:async()=>Date.now()-1,setAlarm}};
  const plaza=new Plaza(state as any,{ENVIRONMENT:'production'} as any);
  expect((await plaza.fetch(new Request('https://example.com/api/posts'))).status).toBe(401);
  expect(stored.get('plaza')).toEqual({sessions:[],posts:[]});expect(setAlarm).not.toHaveBeenCalled();
  await plaza.alarm();expect(setAlarm).toHaveBeenCalledTimes(1);
 });
 it('limits ticket reissue across revocation and restart, then expires anonymous network records',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const f=fixture();
  for(let i=0;i<LIMITS.admissionsPerWindow;i++){
   const r=await f.enter();expect(r.status).toBe(201);await f.call('/session/revoke',{},r.data.token);
  }
  f.restart();expect((await f.enter()).status).toBe(429);
  const serialized=JSON.stringify(f.saved.get('plaza'));expect(serialized).not.toContain('fixture-a');
  vi.setSystemTime(1_000_000+LIMITS.windowMs);await f.plaza.alarm();
  expect(f.saved.get('plaza').rates.buckets).toEqual([]);expect((await f.enter()).status).toBe(201);
 });
 it('retains the rolling post budget over ticket reissue, object restart and salt rotation',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const f=fixture();await f.enter();
  vi.setSystemTime(1_000_000+LIMITS.saltEpochMs-100_000);const a=await f.enter();
  for(let i=0;i<LIMITS.postsPerWindow;i++){
   vi.setSystemTime(1_000_000+LIMITS.saltEpochMs-100_000+i*10_000);
   expect((await f.call('/posts',{text:'予算 '+i},a.data.token)).status).toBe(201);
  }
  vi.setSystemTime(1_000_000+LIMITS.saltEpochMs);f.restart();const b=await f.enter();
  expect(b.status).toBe(201);expect((await f.call('/posts',{text:'取り直し'},b.data.token)).status).toBe(429);
  expect(f.saved.get('plaza').rates.salts).toHaveLength(2);
 });
 it('caps active tickets globally without deleting existing participants',async()=>{
  const f=fixture();for(let i=0;i<LIMITS.sessions;i++)expect((await f.enter('n'+i)).status).toBe(201);
  const r=await f.enter('overflow');expect(r.status).toBe(503);expect(r.retry).toBe('60');
  expect(f.saved.get('plaza').sessions).toHaveLength(LIMITS.sessions);
 });
 it('keeps existing posts at the record limit, and permits deletion to free space',async()=>{
  const f=fixture({sessions:[['token',session()]],posts:Array.from({length:LIMITS.posts},(_,i)=>post('p'+i))});
  expect((await f.call('/posts',{text:'追加'},'token')).status).toBe(503);
  expect((await f.call('/posts',undefined,'token')).data.posts).toHaveLength(LIMITS.posts);
  await f.call('/posts/p0',undefined,'token','fixture-a','DELETE');
  expect((await f.call('/posts',{text:'追加'},'token')).status).toBe(201);
 });
 it('rejects byte growth without partial in-memory writes; legacy oversized data can shrink',async()=>{
  const old={...post(),text:'x'.repeat(LIMITS.snapshotBytes)};
  const f=fixture({sessions:[['token',session()]],posts:[old]});
  expect((await f.call('/posts',{text:'追加'},'token')).status).toBe(503);
  expect((await f.call('/posts',undefined,'token')).data.posts).toHaveLength(1);
  expect(f.saved.get('plaza').posts[0].text).toBe(old.text);
  expect((await f.call('/posts/p',undefined,'token','fixture-a','DELETE')).status).toBe(200);
  expect((await f.call('/posts',{text:'空いた容量'},'token')).status).toBe(201);
 });
 it('restores committed state after a storage failure without exposing diagnostics',async()=>{
  const f=fixture();const a=await f.enter();f.failNext();
  const r=await f.call('/posts',{text:'未保存'},a.data.token);expect(r.status).toBe(503);expect(JSON.stringify(r.data)).not.toContain('private');
  expect((await f.call('/posts',undefined,a.data.token)).data.posts).toEqual([]);
  expect((await f.call('/posts',{text:'再試行'},a.data.token)).status).toBe(201);
  f.restart();expect((await f.call('/posts',undefined,a.data.token)).data.posts[0].text).toBe('再試行');
 });
 it('cleans only records past their advertised retention deadlines',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const ordinary=post('normal'),reported={...post('report'),reportedAt:Date.now()};
  const f=fixture({sessions:[['token',session()]],posts:[ordinary,reported]});
  vi.setSystemTime(1_000_000+DELETE_MS);await f.plaza.alarm();expect(f.saved.get('plaza').posts.map((p:any)=>p.id)).toEqual(['report']);
  vi.setSystemTime(1_000_000+QUARANTINE_MS);await f.plaza.alarm();expect(f.saved.get('plaza').posts).toEqual([]);
 });
 it('overwrites forged internal network headers at the Worker boundary',async()=>{
  let received='';const env={ENVIRONMENT:'production',PLAZA:{idFromName:()=>'',get:()=>({fetch:(r:Request)=>{received=r.headers.get('X-Aqua-Network')||'';return new Response('{}');}})}};
  await worker.fetch(new Request('https://example.com/api/posts',{headers:{'X-Aqua-Network':'forged','CF-Connecting-IP':'203.0.113.7'}}),env as any);
  expect(received).toBe('203.0.113.7');
 });
 it('caps sockets per ticket and globally; closing sockets frees capacity',async()=>{
  class Socket extends EventTarget{accept(){}send(){}close(){this.dispatchEvent(new Event('close'));}}
  const servers:Socket[]=[];vi.stubGlobal('WebSocketPair',class{0=new Socket();1=new Socket();constructor(){servers.push(this[1]);}});
  const Original=Response;vi.stubGlobal('Response',class extends Original{constructor(body:any,init:any){super(body,init?.status===101?{status:200}:init);}});
  const f=fixture({sessions:Array.from({length:33},(_,i)=>['t'+i,{...session(),id:'s'+i}]),posts:[]});
  const connect=(token:string)=>f.plaza.fetch(new Request('http://localhost/api/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'aqualine, auth.'+token}}));
  for(let i=0;i<32;i++){expect((await connect('t'+i)).status).toBe(200);expect((await connect('t'+i)).status).toBe(200);}
  expect((await connect('t0')).status).toBe(503);expect((await connect('t32')).status).toBe(503);
  servers[0].close();expect((await connect('t32')).status).toBe(200);
  for(const s of servers)s.close();
 });
});
