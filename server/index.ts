import { Metrics } from './metrics';
import { LIMITS, cleanRates, networkKeys, type RateState } from './limits';
import { TICKET_MS, VISIBLE_MS, QUARANTINE_MS, locationStatus, postingAllowed, retained, validText, visible, type Session, type Post, type Reaction } from './domain';
interface Env { PLAZA: DurableObjectNamespace; ENVIRONMENT?: string; ASSETS?: Fetcher }
interface Snapshot { sessions: [string,Session][]; posts: Post[]; rates?: RateState }
interface Report { post:Post; reportedAt:number; reporters:string[]; networks:string[]; salt?:string; quarantined:boolean }
interface Usage { expiresAt:number; minute:number; reads:number; mutations:number; renewals:number; connections:number; reportWindow:number; reports:number }
type Action = 'reads'|'mutations'|'renewals'|'connections'|'reports';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===429||status===503?{'Retry-After':'60'}:{})}});
class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export default {
 async fetch(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')) {
   const origin=request.headers.get('Origin');
   if(origin && origin!==url.origin) return json({error:'別のサイトからの操作はできません'},403);
   // This internal header is always overwritten at the public boundary.
   const forwarded = new Request(request);
   forwarded.headers.set('X-Aqua-Network', request.headers.get('CF-Connecting-IP') ||
     (env.ENVIRONMENT==='development' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) ? 'local-test-network' : ''));
   return env.PLAZA.get(env.PLAZA.idFromName('aqualine-single-plaza')).fetch(forwarded);
  }
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response('AquaLine API',{status:200});
 }
};
export class Plaza {
 private sessions=new Map<string,Session>(); private posts:Post[]=[];
 private reports:Report[]=[]; private committedReports:Report[]=[];
 private usage:Record<string,Usage>={};
 private pending=0; private globalMinute=0; private globalCount=0;
 private sockets=new Map<WebSocket,{token:string,timer:ReturnType<typeof setTimeout>}>();
 private queue:Promise<unknown>=Promise.resolve();
 private rates: RateState = {salts:[],buckets:[]};
 private committed: Snapshot = {sessions:[],posts:[]};
 private ready: Promise<void>; private metrics:Metrics;
 constructor(private state:DurableObjectState,private env:Env){
  this.metrics=new Metrics(state.storage);
  this.ready=state.blockConcurrencyWhile(async()=>{
   await state.storage.transaction(async tx=>{
    const data=await tx.get<Snapshot>('plaza') || {sessions:[],posts:[]};
    const reports=await tx.get<Report[]>('reports-v1') || [];
    for(const post of data.posts.filter(p=>p.reportedAt!==undefined))if(!reports.some(r=>r.post.id===post.id))
     reports.push({post,reportedAt:post.reportedAt!,reporters:[],networks:[],quarantined:true});
    const next={...data,posts:data.posts.filter(p=>p.reportedAt===undefined)};
    await tx.put('reports-v1',reports);await tx.put('plaza',next);
    this.restore(next);this.committed=structuredClone(next);this.reports=structuredClone(reports);this.committedReports=structuredClone(reports);
   });
   this.usage=await state.storage.get<Record<string,Usage>>('usage-v1') || {};
   if(await state.storage.getAlarm()===null)await state.storage.setAlarm(Date.now()+60_000);
  });
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const result=this.queue.then(fn,fn);this.queue=result.catch(()=>{});return result;}
 async fetch(request:Request){
  const minute=Math.floor(Date.now()/60_000);
  if(minute!==this.globalMinute){this.globalMinute=minute;this.globalCount=0;}
  if(++this.globalCount>LIMITS.globalRequestsPerMinute){if(this.globalCount===LIMITS.globalRequestsPerMinute+1)this.metrics.record(429);return json({error:'広場へのアクセスが集中しています。1分ほどお待ちください'},429);}
  if(this.pending>=LIMITS.pendingRequests){this.metrics.record(503);return json({error:'広場が混み合っています。時間をおいてお試しください'},503);}
  this.pending++;
  try {
   // Slow uploads are bounded and never hold the state mutation queue.
   const body=request.body || request.method==='POST'?await this.body(request):undefined;
   const response=await this.serial(async()=>{await this.ready;return this.route(request,body);});this.metrics.record(response.status);return response;
  }catch(error){this.metrics.record(error instanceof ApiError?error.status:503);return json({error:error instanceof ApiError?error.message:'操作を保存できませんでした。しばらくして再試行してください'},error instanceof ApiError?error.status:503);}
  finally{this.pending--;}
 }
 private publicSession(s:Session){return {id:s.id,name:s.name,direction:s.direction,expiresAt:s.expiresAt};}
 private token(request:Request){return request.headers.get('Authorization')?.replace(/^Bearer /,'') || request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(x=>x.trim()).find(x=>x.startsWith('auth.'))?.slice(5) || '';}
 private auth(token:string){const s=this.sessions.get(token);if(!s || s.expiresAt<=Date.now()){this.closeToken(token);throw new ApiError(401,'参加時間が終了しました。位置情報を確認して入り直してください');} return s;}
 private restore(data: Snapshot) {
  this.sessions=new Map(structuredClone(data.sessions));this.posts=structuredClone(data.posts);
  this.rates=structuredClone(data.rates || {salts:[],buckets:[]});
 }
 private clean(now=Date.now()) {
  for(const [token,s] of this.sessions) if(s.expiresAt<=now){this.sessions.delete(token);this.closeToken(token);}
  this.posts=this.posts.filter(p=>retained(p,now));
  this.reports=this.reports.filter(r=>now-r.reportedAt<QUARANTINE_MS);
  for(const r of this.reports)if(now-r.post.createdAt>=VISIBLE_MS){r.reporters=[];r.networks=[];delete r.salt;}
  cleanRates(this.rates,now);
 }
 private async save(){
  const next:Snapshot={sessions:[...this.sessions],posts:this.posts,rates:this.rates.salts.length?this.rates:undefined};
  const size=(data:unknown)=>new TextEncoder().encode(JSON.stringify(data)).byteLength;
  try {
   // Preserve legacy data even above the new ceiling; allow only shrinking writes then.
   if(size(next)>LIMITS.snapshotBytes && size(next)>size(this.committed))
    throw new ApiError(503,'広場の保存容量が上限です。既存の投稿は保持しています。時間をおいてお試しください');
   if((this.reports.length>LIMITS.reports && this.reports.length>this.committedReports.length) || (size(this.reports)>LIMITS.reportBytes && size(this.reports)>size(this.committedReports)))
    throw new ApiError(503,'通報の保存枠が満杯です。通報は保存されませんでした。ミュートを利用してください');
   await this.state.storage.transaction(async tx=>{await tx.put('reports-v1',this.reports);await tx.put('plaza',next);});
   this.committed=structuredClone(next);this.committedReports=structuredClone(this.reports);
  } catch(error) { this.restore(this.committed);this.reports=structuredClone(this.committedReports);throw error; }
 }
 private async rate(request:Request,kind:'admissions'|'posts',now:number){
  const address=request.headers.get('X-Aqua-Network') ||
   (this.env.ENVIRONMENT==='development' && ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)?'local-test-network':'');
  if(!address)throw new ApiError(503,'接続元を確認できません。時間をおいてお試しください');
  const keys=await networkKeys(this.rates,address,now);
  const count=this.rates.buckets.filter(([k])=>keys.includes(k)).reduce((n,[,b])=>n+b[kind].length,0);
  const limit=kind==='admissions'?LIMITS.admissionsPerWindow:LIMITS.postsPerWindow;
  if(count>=limit)throw new ApiError(429,kind==='admissions'?'共有回線の参加上限（10分に60回）です。時間をおいてお試しください':'共有回線の投稿上限（10分に120件）です。時間をおいてお試しください');
  const key=keys[keys.length-1];let entry=this.rates.buckets.find(([k])=>k===key);
  if(!entry){
   if(this.rates.buckets.length>=LIMITS.networkBuckets)throw new ApiError(503,'広場が混み合っています。時間をおいてお試しください');
   entry=[key,{admissions:[],posts:[]}];this.rates.buckets.push(entry);
  }
  entry[1][kind].push(now);
 }

 private async ticketRate(session:Session,kind:Action,now:number){
  const next=structuredClone(this.usage);
  for(const [id,v]of Object.entries(next))if(v.expiresAt<=now)delete next[id];
  const minute=Math.floor(now/60_000),reportWindow=Math.floor(now/600_000);
  const usage:Usage=next[session.id]||{expiresAt:session.expiresAt,minute,reads:0,mutations:0,renewals:0,connections:0,reportWindow,reports:0};
  if(usage.minute!==minute){usage.minute=minute;usage.reads=usage.mutations=usage.renewals=usage.connections=0;}
  if(usage.reportWindow!==reportWindow){usage.reportWindow=reportWindow;usage.reports=0;}
  usage.expiresAt=session.expiresAt;
  const limits={reads:LIMITS.ticketReads,mutations:LIMITS.ticketMutations,renewals:LIMITS.ticketRenewals,connections:LIMITS.ticketConnections,reports:LIMITS.ticketReports};
  if(usage[kind]>=limits[kind])throw new ApiError(429,kind==='reports'?'通報は参加券ごとに10分に3件までです。ミュートも利用できます':'操作が続いています。1分ほどお待ちください。下書きと参加状態は保持されます');
  usage[kind]++;next[session.id]=usage;
  await this.state.storage.put('usage-v1',next);this.usage=next;
 }
 private async report(post:Post,session:Session,request:Request,now:number){
  if(post.authorId===session.id)throw new ApiError(400,'自分の投稿は削除メニューを利用してください');
  let report=this.reports.find(r=>r.post.id===post.id);
  if(report?.reporters.includes(session.id))return;
  if(!report && this.reports.length>=LIMITS.reports)throw new ApiError(503,'通報の保存枠が満杯です。通報は保存されませんでした。ミュートを利用してください');
  const address=request.headers.get('X-Aqua-Network') || (this.env.ENVIRONMENT==='development'?'local-test-network':'');
  if(!address)throw new ApiError(503,'接続元を確認できません。時間をおいてお試しください');
  const salt=report?.salt || crypto.randomUUID();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':'+address))),b=>b.toString(16).padStart(2,'0')).join('');
  if(!report){report={post:structuredClone(post),reportedAt:now,reporters:[],networks:[],salt,quarantined:false};this.reports.push(report);}
  if(report.reporters.length>=64)throw new ApiError(503,'この投稿の通報人数が上限です。ミュートを利用してください');
  report.reporters.push(session.id);
  if(!report.networks.includes(hash))report.networks.push(hash);
  if(report.networks.length>=LIMITS.reportThreshold){report.quarantined=true;this.posts=this.posts.filter(p=>p.id!==post.id);}
 }

 private closeToken(token:string){for(const [ws,info] of this.sockets){if(info.token===token){clearTimeout(info.timer);try{ws.close(4001,'ticket expired or revoked');}catch{} this.sockets.delete(ws);}}}
 private release(ws:WebSocket){const entry=this.sockets.get(ws);if(entry)clearTimeout(entry.timer);this.sockets.delete(ws);}
 private arm(ws:WebSocket,token:string){const old=this.sockets.get(ws);if(old)clearTimeout(old.timer);const expiry=this.sessions.get(token)?.expiresAt||0;const timer=setTimeout(()=>this.closeToken(token),Math.max(1,expiry-Date.now()));this.sockets.set(ws,{token,timer});}
 private broadcast(){for(const [ws,info] of this.sockets){try{this.auth(info.token);ws.send(JSON.stringify({type:'changed'}));}catch{this.closeToken(info.token);}}}
 private location(body:any,request:Request){
  if(body.dev===true){const host=new URL(request.url).hostname;if(this.env.ENVIRONMENT!=='development'||!['localhost','127.0.0.1','[::1]'].includes(host))throw new ApiError(403,'開発モードは本番では使えません');return 'inside' as const;}
  return locationStatus(body.location);
 }
 private async body(request:Request){
  if(Number(request.headers.get('Content-Length')||0)>4096)throw new ApiError(413,'リクエストが大きすぎます');
  const deadline=Date.now()+5000;const reader=request.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
  if(reader){try{while(true){let timer:ReturnType<typeof setTimeout>|undefined;
    const {done,value}=await Promise.race([reader.read(),new Promise<ReadableStreamReadResult<Uint8Array>>((_,reject)=>{timer=setTimeout(()=>{reject(new ApiError(408,'送信に時間がかかりました。再試行してください'));void reader.cancel();},Math.max(1,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new ApiError(413,'リクエストが大きすぎます');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
  if(request.method!=='POST' && size>0)throw new ApiError(400,'この操作に本文は送信できません');
  try{const data=JSON.parse(text||'{}');if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();return data;}catch{throw new ApiError(400,'JSONオブジェクトが必要です');}
 }
 private async route(request:Request,body:any):Promise<Response>{
  const url=new URL(request.url),path=url.pathname,method=request.method,now=Date.now();
  if(path==='/api/session'&&method==='POST'){
   this.clean(now);
   if(body.passenger!==true)throw new ApiError(400,'運転していない同乗者のみ参加できます');
   if(!['tokyo','kisarazu'].includes(body.direction))throw new ApiError(400,'進行方向を選んでください');
   const status=this.location(body,request);if(status!=='inside')throw new ApiError(403,status==='outside'?'アクアラインのエリア外です':'位置情報の精度が足りません。地上で再確認してください');
   if(this.sessions.size>=LIMITS.sessions)throw new ApiError(503,'広場の参加人数が上限です。時間をおいてお試しください');
   await this.rate(request,'admissions',now);
   const token=crypto.randomUUID()+crypto.randomUUID().replaceAll('-','');
   const id=crypto.randomUUID(),s:Session={id,name:`波待ち ${id.slice(0,4).toUpperCase()}`,direction:body.direction,expiresAt:now+TICKET_MS,posts:[]};this.sessions.set(token,s);await this.save();return json({token,session:this.publicSession(s)},201);
  }
  const token=this.token(request),session=this.auth(token);
  if(path!=='/api/session/revoke')await this.ticketRate(session,
   path==='/api/events'?'connections':path==='/api/session/renew'?'renewals':method==='GET'?'reads':path.endsWith('/report')?'reports':'mutations',now);
  if(path==='/api/session/revoke'&&method==='POST'){this.sessions.delete(token);this.closeToken(token);await this.save();return json({ok:true});}
  if(path==='/api/session/renew'&&method==='POST'){
   const status=this.location(body,request);
   if(status==='outside'){this.sessions.delete(token);this.closeToken(token);await this.save();throw new ApiError(403,'エリア外になったため退出しました');}
   if(status==='inside'){session.expiresAt=now+TICKET_MS;await this.save();for(const [ws,info] of this.sockets)if(info.token===token)this.arm(ws,token);}
   return json({session:this.publicSession(session),locationStatus:status});
  }
  if(path==='/api/events'&&method==='GET'){
   if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new ApiError(426,'WebSocket接続が必要です');
   if(this.sockets.size>=LIMITS.sockets || [...this.sockets.values()].filter(s=>s.token===token).length>=LIMITS.socketsPerTicket)throw new ApiError(503,'接続数が上限です。別のタブを閉じてお試しください');
   const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();this.arm(server,token);
   // This is a server-to-client invalidation channel; unsolicited messages close it.
   server.addEventListener('message',()=>{this.metrics.record(400,true);try{server.close(1008,'receive-only channel');}catch{}this.release(server);});
   server.addEventListener('close',()=>this.release(server));
   server.addEventListener('error',()=>this.release(server));
   return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':'aqualine'}});
  }
  if(path==='/api/posts'&&method==='GET')return json({posts:this.posts.filter(p=>visible(p,now)&&!this.reports.some(r=>r.post.id===p.id&&r.reporters.includes(session.id))).map(p=>({id:p.id,authorId:p.authorId,name:p.name,direction:p.direction,text:p.text,parentId:p.parentId,createdAt:p.createdAt,mine:p.authorId===session.id,reactions:Object.fromEntries(Object.entries(p.reactions).map(([k,v])=>[k,v.length])),myReactions:Object.entries(p.reactions).filter(([,v])=>v.includes(session.id)).map(([k])=>k)})).reverse()});
  if(path==='/api/posts'&&method==='POST'){
   this.clean(now);
   let text:string;try{text=validText(body.text);}catch(e){throw new ApiError(400,e instanceof Error?e.message:'本文が不正です');}
   if(body.parentId!==undefined && (typeof body.parentId!=='string'||body.parentId.length>64))throw new ApiError(400,'返信先が不正です');
   if(!postingAllowed(session,now))throw new ApiError(429,'投稿は10秒あけて、10分に10件までです');
   if(body.parentId && !this.posts.some(p=>p.id===body.parentId&&visible(p,now)))throw new ApiError(404,'返信先の投稿は表示期間を終了しました');
   if(this.posts.length>=LIMITS.posts)throw new ApiError(503,'広場の保存件数が上限です。既存の投稿は保持しています。時間をおいてお試しください');
   await this.rate(request,'posts',now);
   const post:Post={id:crypto.randomUUID(),authorId:session.id,name:session.name,direction:session.direction,text,parentId:body.parentId||undefined,createdAt:now,reactions:{wave:[],thanks:[],same:[]}};
   this.posts.push(post);session.posts=session.posts.filter(t=>now-t<600_000);session.posts.push(now);await this.save();this.broadcast();return json({id:post.id},201);
  }
  const match=path.match(/^\/api\/posts\/([^/]+)(?:\/(react|report))?$/);
  if(match){const post=this.posts.find(p=>p.id===match[1]&&visible(p,now));if(!post)throw new ApiError(404,'投稿は表示期間を終了しました');
   if(method==='DELETE'&&!match[2]){if(post.authorId!==session.id)throw new ApiError(403,'自分の投稿だけ削除できます');this.posts=this.posts.filter(p=>p.id!==post.id);}
   else if(method==='POST'&&match[2]==='report'){await this.report(post,session,request,now);}
   else if(method==='POST'&&match[2]==='react'){const {reaction}=body;if(!['wave','thanks','same'].includes(reaction))throw new ApiError(400,'リアクションが不正です');const list=post.reactions[reaction as Reaction],i=list.indexOf(session.id);if(i<0){if(Object.values(post.reactions).reduce((n,v)=>n+v.length,0)>=LIMITS.reactionsPerPost)throw new ApiError(503,'この投稿へのリアクション数が上限です');list.push(session.id);}else list.splice(i,1);}
   else throw new ApiError(405,'この操作はできません');
   await this.save();this.broadcast();return json({ok:true});
  }
  throw new ApiError(404,'見つかりません');
 }
 async alarm(){await this.ready;await this.serial(async()=>{this.metrics.flush();this.clean();await this.save();for(const [id,u]of Object.entries(this.usage))if(u.expiresAt<=Date.now())delete this.usage[id];await this.state.storage.put('usage-v1',this.usage);this.broadcast();await this.state.storage.setAlarm(Date.now()+60_000);});}
}
