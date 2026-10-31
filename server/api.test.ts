import {memoryStorage} from './test-storage';
import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import worker,{Plaza} from './index';
import {TICKET_MS,DELETE_MS,QUARANTINE_MS,ROAD} from './domain';
function setup(environment='development'){
 const {saved,storage}=memoryStorage();
 const state={blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),storage};
 const plaza=new Plaza(state as any,{ENVIRONMENT:environment} as any);
 const call=async(path:string,body?:unknown,token?:string,method=body===undefined?'GET':'POST',host='localhost')=>{
  const response=await plaza.fetch(new Request(`http://${host}/api${path}`,{method,headers:{...(environment==='production'?{'X-Aqua-Network':'192.0.2.1'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
  return {status:response.status,data:await response.json() as any};
 };
 const enter=async()=>{const r=await call('/session',{passenger:true,direction:'tokyo',dev:true});expect(r.status).toBe(201);return r.data;};
 return {plaza,call,enter,saved};
}
beforeEach(()=>{vi.useRealTimers();});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('Durable Object HTTP integration',()=>{
 it('joins, posts, replies, reacts, enforces ownership, reports and filters for both clients',async()=>{
  const {call,enter}=setup();const a=await enter(),b=await enter();
  const p=await call('/posts',{text:'こんにちは'},a.token);expect(p.status).toBe(201);
  const list=await call('/posts',undefined,b.token);expect(list.data.posts[0].mine).toBe(false);
  expect((await call(`/posts/${p.data.id}/react`,{reaction:'thanks'},b.token)).status).toBe(200);
  expect((await call('/posts',undefined,a.token)).data.posts[0].reactions.thanks).toBe(1);
  const reply=await call('/posts',{text:'こんにちは！',parentId:p.data.id},b.token);expect(reply.status).toBe(201);
  expect((await call(`/posts/${p.data.id}`,undefined,b.token,'DELETE')).status).toBe(403);
  expect((await call(`/posts/${reply.data.id}`,undefined,b.token,'DELETE')).status).toBe(200);
  expect((await call(`/posts/${p.data.id}/report`,{},b.token)).status).toBe(200);
  expect((await call('/posts',undefined,b.token)).data.posts).toEqual([]);
  expect((await call('/posts',undefined,a.token)).data.posts).toHaveLength(1);
 });
 it('rejects URLs, long posts, spam, invalid replies and unauthenticated reads',async()=>{
  const {call,enter}=setup();const a=await enter();
  expect((await call('/posts')).status).toBe(401);
  expect((await call('/posts',{text:'x'.repeat(141)},a.token)).status).toBe(400);
  expect((await call('/posts',{text:'example.xyz'},a.token)).status).toBe(400);
  expect((await call('/posts',{text:'返事',parentId:'missing'},a.token)).status).toBe(404);
  expect((await call('/posts',{text:'最初'},a.token)).status).toBe(201);
  expect((await call('/posts',{text:'連投'},a.token)).status).toBe(429);
 });
 it('never allows production or remote-host dev bypass and requires passenger confirmation',async()=>{
  const prod=setup('production');expect((await prod.call('/session',{passenger:true,direction:'tokyo',dev:true})).status).toBe(403);
  const dev=setup();expect((await dev.call('/session',{passenger:true,direction:'tokyo',dev:true},undefined,'POST','example.com')).status).toBe(403);
  expect((await dev.call('/session',{passenger:false,direction:'tokyo',dev:true})).status).toBe(400);
  expect((await dev.call('/session',{passenger:true,direction:'tokyo'})).status).toBe(403);
 });
 it('unknown GPS preserves expiry, reliable outside revokes, expiry denies every API',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);
  const {call,enter}=setup();const a=await enter();vi.setSystemTime(1_030_000);
  const unknown=await call('/session/renew',{location:{lat:35.4645,lng:139.8753,accuracy:500}},a.token);
  expect(unknown.data.locationStatus).toBe('unknown');expect(unknown.data.session.expiresAt).toBe(a.session.expiresAt);
  expect((await call('/session/renew',{location:{lat:36,lng:140,accuracy:10}},a.token)).status).toBe(403);
  expect((await call('/posts',undefined,a.token)).status).toBe(401);
  const b=await enter();vi.setSystemTime(b.session.expiresAt);
  for(const [path,body]of [['/posts',undefined],['/posts',{text:'期限切れ'}],['/session/renew',{dev:true}],['/posts/fake/report',{}],['/events',undefined]] as const)expect((await call(path,body,b.token)).status).toBe(401);
 });
 it('separates entry distance and accuracy without changing uncertain/outside session handling',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);
  const a=ROAD[6],b=ROAD[7],lat=(a[0]+b[0])/2,lng=(a[1]+b[1])/2;
  const sx=111320*Math.cos(lat*Math.PI/180),dx=(b[1]-a[1])*sx,dy=(b[0]-a[0])*111320,n=Math.hypot(dx,dy);
  const location=(metres:number,accuracy:number)=>({lat:lat+metres*dx/n/111320,lng:lng-metres*dy/n/sx,accuracy});
  const {call}=setup('production');
  const poor=await call('/session',{passenger:true,direction:'tokyo',location:location(1000,81)});
  expect(poor.status).toBe(403);expect(poor.data.error).toContain('精度');
  const entry=await call('/session',{passenger:true,direction:'tokyo',location:location(50,60)});
  expect(entry.status).toBe(201);const token=entry.data.token;
  vi.setSystemTime(1_030_000);
  const renewed=await call('/session/renew',{location:location(50,60)},token);
  expect(renewed.data.locationStatus).toBe('inside');expect(renewed.data.session.expiresAt).toBe(1_030_000+TICKET_MS);
  for(const point of [location(1000,81),location(200,60)]){
   const r=await call('/session/renew',{location:point},token);
   expect(r.status).toBe(200);expect(r.data.locationStatus).toBe('unknown');expect(r.data.session.expiresAt).toBe(renewed.data.session.expiresAt);
   expect((await call('/posts',undefined,token)).status).toBe(200);
  }
  expect((await call('/session/renew',{location:location(220,60)},token)).status).toBe(403);
  expect((await call('/posts',undefined,token)).status).toBe(401);
 });
 it('restores without renewal, survives restart, and rejects expired tickets despite client clocks',async()=>{
  vi.useFakeTimers();const start=1_000_000;vi.setSystemTime(start);
  const {call,enter,saved}=setup();const ticket=await enter();
  expect(ticket.session.expiresAt).toBe(start+60*60_000);
  for(const elapsed of [5,20,59]){
   vi.setSystemTime(start+elapsed*60_000);
   const r=await call('/session/renew',{location:{lat:0,lng:0,accuracy:500},expiresAt:9e15,serverNow:0},ticket.token);
   expect(r.data.session.expiresAt).toBe(ticket.session.expiresAt);
   const check=await call('/session',undefined,ticket.token);
   expect(check.data.session.expiresAt).toBe(ticket.session.expiresAt);expect(check.data.session.serverNow).toBe(Date.now());
  }
  const {storage}=memoryStorage(saved);const restarted=new Plaza({storage,blockConcurrencyWhile:(fn:any)=>fn()} as any,{ENVIRONMENT:'development'} as any);
  const get=()=>restarted.fetch(new Request('http://localhost/api/session',{headers:{Authorization:'Bearer '+ticket.token}}));
  vi.setSystemTime(ticket.session.expiresAt-1);expect((await get()).status).toBe(200);
  vi.setSystemTime(ticket.session.expiresAt);expect((await get()).status).toBe(401);
  expect((await call('/session/renew',{dev:true,expiresAt:9e15},ticket.token)).status).toBe(401);
 });
 it('does not upgrade legacy 20-minute tickets during restoration or resurrect expired ones',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);
  const {saved,storage}=memoryStorage();
  saved.set('plaza',{sessions:[['legacy',{id:'legacy',name:'legacy',direction:'tokyo',expiresAt:2_200_000,posts:[]}]],posts:[]});
  const plaza=new Plaza({storage,blockConcurrencyWhile:(fn:any)=>fn()} as any,{ENVIRONMENT:'development'} as any);
  const check=()=>plaza.fetch(new Request('http://localhost/api/session',{headers:{Authorization:'Bearer legacy'}}));
  const r=await check();expect(r.status).toBe(200);expect((await r.json() as any).session.expiresAt).toBe(2_200_000);
  vi.setSystemTime(2_200_000);expect((await check()).status).toBe(401);
 });
 it('alarm removes expired sessions and retention records without storing coordinates',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const {call,enter,plaza,saved}=setup();const a=await enter();
  const p=await call('/posts',{text:'保存期限'},a.token);const b=await enter();await call(`/posts/${p.data.id}/report`,{},b.token);
  const snapshot=JSON.stringify(saved.get('plaza'));expect(snapshot).not.toContain('accuracy');expect(snapshot).not.toContain('location');
  vi.advanceTimersByTime(DELETE_MS);await plaza.alarm();expect((saved.get('plaza') as any).posts).toHaveLength(0);expect(saved.get('reports-v1')).toHaveLength(1);expect((saved.get('plaza') as any).sessions).toHaveLength(0);
  vi.advanceTimersByTime(QUARANTINE_MS);await plaza.alarm();expect((saved.get('plaza') as any).posts).toHaveLength(0);expect(saved.get('reports-v1')).toHaveLength(0);
 });
 it('rejects cross-origin mutations before forwarding',async()=>{
  const r=await worker.fetch(new Request('https://aqua.example/api/session',{method:'POST',headers:{Origin:'https://evil.example'}}),{} as any);expect(r.status).toBe(403);
 });
});

describe('WebSocket lifetime',()=>{
 it('renews timers, delivers invalidation only while authorized, and closes at expiry',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);
  class Socket extends EventTarget { messages:string[]=[];closed=0;accept(){}send(s:string){this.messages.push(s);}close(code:number){this.closed=code;this.dispatchEvent(new Event('close'));} }
  let server:Socket;
  vi.stubGlobal('WebSocketPair',class {0=new Socket();1=new Socket();constructor(){server=this[1];}});
  const NativeResponse=Response;
  vi.stubGlobal('Response',class extends NativeResponse {constructor(body:any,init:any){super(body,init?.status===101?{status:200}:init);} });
  const {plaza,call,enter}=setup();const a=await enter();
  await plaza.fetch(new Request('http://localhost/api/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':`aqualine, auth.${a.token}`}}));
  expect(server!.closed).toBe(0);
  await call('/posts',{text:'ストリーム更新'},a.token);expect(server!.messages).toContain(JSON.stringify({type:'changed'}));
  vi.advanceTimersByTime(60_000);await call('/session/renew',{dev:true},a.token);
  vi.advanceTimersByTime(TICKET_MS-60_000);expect(server!.closed).toBe(0);
  vi.advanceTimersByTime(60_000);expect(server!.closed).toBe(4001);
 });
 it('immediately closes a socket on reliable outside renewal',async()=>{
  class Socket extends EventTarget {closed=0;accept(){}send(){}close(code:number){this.closed=code;this.dispatchEvent(new Event('close'));} }
  let server:Socket;
  vi.stubGlobal('WebSocketPair',class {0=new Socket();1=new Socket();constructor(){server=this[1];}});
  const NativeResponse=Response;vi.stubGlobal('Response',class extends NativeResponse {constructor(body:any,init:any){super(body,init?.status===101?{status:200}:init);} });
  const {plaza,call,enter}=setup();const a=await enter();
  await plaza.fetch(new Request('http://localhost/api/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':`aqualine, auth.${a.token}`}}));
  await call('/session/renew',{location:{lat:36,lng:140,accuracy:5}},a.token);expect(server!.closed).toBe(4001);
 });
});
