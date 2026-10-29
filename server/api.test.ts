import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import worker,{Plaza} from './index';
import {TICKET_MS,DELETE_MS,QUARANTINE_MS} from './domain';
function setup(environment='development'){
 const saved=new Map<string,unknown>();
 const state={blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),storage:{get:async(key:string)=>saved.get(key),put:async(key:string,v:unknown)=>saved.set(key,structuredClone(v)),setAlarm:async()=>{}}};
 const plaza=new Plaza(state as any,{ENVIRONMENT:environment} as any);
 const call=async(path:string,body?:unknown,token?:string,method=body===undefined?'GET':'POST',host='localhost')=>{
  const response=await plaza.fetch(new Request(`http://${host}/api${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
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
  expect((await call('/posts',undefined,a.token)).data.posts).toEqual([]);
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
 it('alarm removes expired sessions and retention records without storing coordinates',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const {call,enter,plaza,saved}=setup();const a=await enter();
  const p=await call('/posts',{text:'保存期限'},a.token);await call(`/posts/${p.data.id}/report`,{},a.token);
  const snapshot=JSON.stringify(saved.get('plaza'));expect(snapshot).not.toContain('accuracy');expect(snapshot).not.toContain('location');
  vi.advanceTimersByTime(DELETE_MS);await plaza.alarm();expect((saved.get('plaza') as any).posts).toHaveLength(1);expect((saved.get('plaza') as any).sessions).toHaveLength(0);
  vi.advanceTimersByTime(QUARANTINE_MS);await plaza.alarm();expect((saved.get('plaza') as any).posts).toHaveLength(0);
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
