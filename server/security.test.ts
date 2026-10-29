import {describe,it,expect,vi,afterEach} from 'vitest';
import {Plaza} from './index';
import {LIMITS} from './limits';
import {TICKET_MS, VISIBLE_MS, QUARANTINE_MS} from './domain';
import {memoryStorage} from './test-storage';
function setup(seed?:any,archives:any[]=[]){
 const mem=memoryStorage();if(seed)mem.saved.set('plaza',seed);mem.saved.set('reports-v1',archives);
 const state={blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),storage:mem.storage};
 let plaza=new Plaza(state as any,{ENVIRONMENT:'development'} as any);
 const call=async(path:string,token?:string,body?:any,network='bus',method=body===undefined?'GET':'POST')=>{
  const r=await plaza.fetch(new Request('http://localhost/api'+path,{method,headers:{'X-Aqua-Network':network,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
  return {status:r.status,data:await r.json() as any};
 };
 const enter=async(network='bus')=>{const r=await call('/session',undefined,{passenger:true,direction:'tokyo',dev:true},network);expect(r.status).toBe(201);return r.data.token as string;};
 return {...mem,call,enter,get plaza(){return plaza;},restart(){plaza=new Plaza(state as any,{ENVIRONMENT:'development'} as any);}};
}
const post=(id='p')=>({id,authorId:'author',name:'test',direction:'tokyo',text:'test',createdAt:Date.now(),reactions:{wave:[],thanks:[],same:[]}});
const session=(id='author')=>({id,name:'test',direction:'tokyo',expiresAt:Date.now()+TICKET_MS,posts:[]});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('report isolation and durable abuse limits',()=>{
 it('migrates a full legacy quarantine atomically without consuming normal slots, idempotently',async()=>{
  const old=Array.from({length:128},(_,i)=>({...post('old'+i),reportedAt:Date.now()}));
  const f=setup({sessions:[['a',session()]],posts:old});
  expect((await f.call('/posts','a',{text:'normal'})).status).toBe(201);
  expect(f.saved.get('reports-v1')).toHaveLength(128);expect(f.saved.get('plaza').posts).toHaveLength(1);
  f.restart();expect((await f.call('/posts','a')).data.posts).toHaveLength(1);expect(f.saved.get('reports-v1')).toHaveLength(128);
 });
 it('same network reissued tickets do not add independent votes; three networks quarantine',async()=>{
  const f=setup();const author=await f.enter();const id=(await f.call('/posts',author,{text:'sample'})).data.id;
  for(let i=0;i<3;i++){const t=await f.enter('bus');expect((await f.call('/posts/'+id+'/report',t,{},'bus')).status).toBe(200);expect((await f.call('/posts',t)).data.posts).toEqual([]);}
  expect(f.saved.get('reports-v1')[0].networks).toHaveLength(1);
  expect((await f.call('/posts',author)).data.posts).toHaveLength(1);
  for(const network of ['second','third']){const t=await f.enter(network);expect((await f.call('/posts/'+id+'/report',t,{},network)).status).toBe(200);}
  expect((await f.call('/posts',author)).data.posts).toEqual([]);expect(f.saved.get('reports-v1')[0].quarantined).toBe(true);
  expect(JSON.stringify(f.saved.get('reports-v1'))).not.toContain('second');
 });
 it('full report storage rejects honestly and does not block ordinary posts or delete old reports',async()=>{
  const reports=Array.from({length:128},(_,i)=>({post:post('r'+i),reportedAt:Date.now(),reporters:[],networks:[],quarantined:true}));
  const f=setup({sessions:[['a',session()],['b',session('reader')]],posts:[post()]},reports);
  expect((await f.call('/posts/p/report','b',{})).status).toBe(503);
  expect((await f.call('/posts','b')).data.posts).toHaveLength(1);
  expect((await f.call('/posts','a',{text:'still available'})).status).toBe(201);
  expect(f.saved.get('reports-v1')).toHaveLength(128);
 });
 it('archive byte ceiling rolls back report without hiding or partial storage',async()=>{
  const report={post:{...post('old'),text:'x'.repeat(LIMITS.reportBytes)},reportedAt:Date.now(),reporters:[],networks:[],quarantined:true};
  const f=setup({sessions:[['a',session()],['b',session('reader')]],posts:[post()]},[report]);
  expect((await f.call('/posts/p/report','b',{})).status).toBe(503);
  expect((await f.call('/posts','b')).data.posts).toHaveLength(1);
  expect(f.saved.get('reports-v1')).toEqual([report]);
  expect((await f.call('/posts','a',{text:'normal remains available'})).status).toBe(201);
 });
 it('clears short-lived voting identifiers at 60 minutes but keeps report until 30 days',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const f=setup();const a=await f.enter(),b=await f.enter();
  const id=(await f.call('/posts',a,{text:'test'})).data.id;await f.call('/posts/'+id+'/report',b,{});
  const at=f.saved.get('reports-v1')[0].reportedAt;
  await f.call('/posts/'+id,a,undefined,'bus','DELETE');expect(f.saved.get('reports-v1')).toHaveLength(1);
  vi.setSystemTime(1_000_000+VISIBLE_MS);await f.plaza.alarm();const r=f.saved.get('reports-v1')[0];expect(r.salt).toBeUndefined();expect(r.networks).toEqual([]);expect(r.reporters).toEqual([]);
  vi.setSystemTime(at+QUARANTINE_MS-1);await f.plaza.alarm();expect(f.saved.get('reports-v1')).toHaveLength(1);
  vi.setSystemTime(at+QUARANTINE_MS);await f.plaza.alarm();expect(f.saved.get('reports-v1')).toEqual([]);
 });
 it('rate limits each ticket independently and persists across restart; exit still works',async()=>{
  const f=setup();const a=await f.enter(),b=await f.enter();
  for(let i=0;i<LIMITS.ticketReads;i++)expect((await f.call('/posts',a)).status).toBe(200);
  f.restart();expect((await f.call('/posts',a)).status).toBe(429);expect((await f.call('/posts',b)).status).toBe(200);
  expect((await f.call('/session/revoke',a,{})).status).toBe(200);
 });
 it('limits mutation, renewal and report attempts and recovers the minute budget',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_020_000);const f=setup();const a=await f.enter();
  for(let i=0;i<LIMITS.ticketMutations;i++)expect((await f.call('/posts/missing/react',a,{reaction:'wave'})).status).toBe(404);
  expect((await f.call('/posts/missing/react',a,{reaction:'wave'})).status).toBe(429);
  for(let i=0;i<LIMITS.ticketRenewals;i++)expect((await f.call('/session/renew',a,{dev:true})).status).toBe(200);
  expect((await f.call('/session/renew',a,{dev:true})).status).toBe(429);
  for(let i=0;i<LIMITS.ticketReports;i++)expect((await f.call('/posts/missing/report',a,{})).status).toBe(404);
  expect((await f.call('/posts/missing/report',a,{})).status).toBe(429);
  vi.setSystemTime(1_080_000);expect((await f.call('/session/renew',a,{dev:true})).status).toBe(200);
 });
 it('storage failure does not manufacture a successful report',async()=>{
  const f=setup({sessions:[['b',session('reader')]],posts:[post()]});await f.call('/posts','b');
  const original=f.storage.put;f.storage.put=async(k:string,v:any)=>{if(k==='plaza')throw Error('failure');return original(k,v);};
  expect((await f.call('/posts/p/report','b',{})).status).toBe(503);
  expect(f.saved.get('reports-v1')).toEqual([]);expect((await f.call('/posts','b')).data.posts).toHaveLength(1);
 });
 it('rejects oversized payloads even on report/revoke routes and bounds a stalled upload',async()=>{
  const f=setup();const a=await f.enter();expect((await f.call('/session/revoke',a,{text:'x'.repeat(5000)})).status).toBe(413);
  vi.useFakeTimers();const stream=new ReadableStream({start(){}});
  const stalled=f.plaza.fetch(new Request('http://localhost/api/session',{method:'POST',body:stream,duplex:'half'} as any));
  expect((await f.call('/posts',a)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(5001);expect((await stalled).status).toBe(408);
 });
});
it('caps pending bodies without blocking quick requests, then releases slots after timeout',async()=>{
 vi.useFakeTimers();const f=setup();const pending=Array.from({length:LIMITS.pendingRequests},()=>f.plaza.fetch(new Request('http://localhost/api/session',{method:'POST',body:new ReadableStream({start(){}}),duplex:'half'} as any)));
 expect((await f.plaza.fetch(new Request('http://localhost/api/posts'))).status).toBe(503);
 await vi.advanceTimersByTimeAsync(5001);expect((await Promise.all(pending)).every(r=>r.status===408)).toBe(true);
 expect((await f.plaza.fetch(new Request('http://localhost/api/posts'))).status).toBe(401);
});
it('limits repeated websocket handshakes and closes client application messages without echo',async()=>{
 class Socket extends EventTarget {closed=0;accept(){}send(){throw Error('must not echo');}close(code:number){this.closed=code;this.dispatchEvent(new Event('close'));}}
 const servers:Socket[]=[];vi.stubGlobal('WebSocketPair',class{0=new Socket();1=new Socket();constructor(){servers.push(this[1]);}});
 const Original=Response;vi.stubGlobal('Response',class extends Original{constructor(body:any,init:any){super(body,init?.status===101?{status:200}:init);}});
 const f=setup();const token=await f.enter();const connect=()=>f.plaza.fetch(new Request('http://localhost/api/events',{headers:{Upgrade:'websocket',Authorization:'Bearer '+token}}));
 for(let i=0;i<LIMITS.ticketConnections;i++){expect((await connect()).status).toBe(200);servers.at(-1)!.dispatchEvent(new MessageEvent('message',{data:'untrusted payload'}));expect(servers.at(-1)!.closed).toBe(1008);}
 f.restart();expect((await connect()).status).toBe(429);
});
