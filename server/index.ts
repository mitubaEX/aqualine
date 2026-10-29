import { LIMITS, cleanRates, networkKeys, type RateState } from './limits';
import { TICKET_MS, locationStatus, postingAllowed, retained, validText, visible, type Session, type Post, type Reaction } from './domain';
interface Env { PLAZA: DurableObjectNamespace; ENVIRONMENT?: string; ASSETS?: Fetcher }
interface Snapshot { sessions: [string,Session][]; posts: Post[]; rates?: RateState }
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
 private sockets=new Map<WebSocket,{token:string,timer:ReturnType<typeof setTimeout>}>();
 private queue:Promise<unknown>=Promise.resolve();
 private rates: RateState = {salts:[],buckets:[]};
 private committed: Snapshot = {sessions:[],posts:[]};
 private ready: Promise<void>;
 constructor(private state:DurableObjectState,private env:Env){
  this.ready=state.blockConcurrencyWhile(async()=>{const data=await state.storage.get<Snapshot>('plaza'); if(data){this.restore(data);this.committed=structuredClone(data);} else {await state.storage.put('plaza',this.committed);} if(await state.storage.getAlarm()===null)await state.storage.setAlarm(Date.now()+60_000);});
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const result=this.queue.then(fn,fn);this.queue=result.catch(()=>{});return result;}
 async fetch(request:Request){return this.serial(async()=>{try{await this.ready;return await this.route(request);}catch(error){return json({error:error instanceof ApiError ? error.message:'操作を保存できませんでした。しばらくして再試行してください'},error instanceof ApiError?error.status:503);}});}
 private publicSession(s:Session){return {id:s.id,name:s.name,direction:s.direction,expiresAt:s.expiresAt};}
 private token(request:Request){return request.headers.get('Authorization')?.replace(/^Bearer /,'') || request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(x=>x.trim()).find(x=>x.startsWith('auth.'))?.slice(5) || '';}
 private auth(token:string){const s=this.sessions.get(token);if(!s || s.expiresAt<=Date.now()){this.closeToken(token);throw new ApiError(401,'参加時間が終了しました。位置情報を確認して入り直してください');} return s;}
 private restore(data: Snapshot) {
  this.sessions=new Map(structuredClone(data.sessions));this.posts=structuredClone(data.posts);
  this.rates=structuredClone(data.rates || {salts:[],buckets:[]});
 }
 private clean(now=Date.now()) {
  for(const [token,s] of this.sessions) if(s.expiresAt<=now){this.sessions.delete(token);this.closeToken(token);}
  this.posts=this.posts.filter(p=>retained(p,now));cleanRates(this.rates,now);
 }
 private async save(){
  const next:Snapshot={sessions:[...this.sessions],posts:this.posts,rates:this.rates.salts.length?this.rates:undefined};
  const size=(data:Snapshot)=>new TextEncoder().encode(JSON.stringify(data)).byteLength;
  try {
   // Preserve legacy data even above the new ceiling; allow only shrinking writes then.
   if(size(next)>LIMITS.snapshotBytes && size(next)>size(this.committed))
    throw new ApiError(503,'広場の保存容量が上限です。既存の投稿は保持しています。時間をおいてお試しください');
   await this.state.storage.put('plaza',next);this.committed=structuredClone(next);
  } catch(error) { this.restore(this.committed);throw error; }
 }
 private async rate(request:Request,kind:'admissions'|'posts',now:number){
  const address=request.headers.get('X-Aqua-Network') ||
   (this.env.ENVIRONMENT==='development' && ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)?'local-test-network':'');
  if(!address)throw new ApiError(503,'接続元を確認できません。時間をおいてお試しください');
  const keys=await networkKeys(this.rates,address,now);
  const count=this.rates.buckets.filter(([k])=>keys.includes(k)).reduce((n,[,b])=>n+b[kind].length,0);
  const limit=kind==='admissions'?LIMITS.admissionsPerWindow:LIMITS.postsPerWindow;
  if(count>=limit)throw new ApiError(429,kind==='admissions'?'同じ接続元からの参加は10分に5回までです。時間をおいてお試しください':'同じ接続元からの投稿・返信は参加券を取り直しても10分に10件までです');
  const key=keys[keys.length-1];let entry=this.rates.buckets.find(([k])=>k===key);
  if(!entry){
   if(this.rates.buckets.length>=LIMITS.networkBuckets)throw new ApiError(503,'広場が混み合っています。時間をおいてお試しください');
   entry=[key,{admissions:[],posts:[]}];this.rates.buckets.push(entry);
  }
  entry[1][kind].push(now);
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
  const reader=request.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
  if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new ApiError(413,'リクエストが大きすぎます');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
  try{const data=JSON.parse(text);if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();return data;}catch{throw new ApiError(400,'JSONオブジェクトが必要です');}
 }
 private async route(request:Request):Promise<Response>{
  const url=new URL(request.url),path=url.pathname,method=request.method,now=Date.now();
  if(path==='/api/session'&&method==='POST'){
   this.clean(now);
   const body=await this.body(request);
   if(body.passenger!==true)throw new ApiError(400,'運転していない同乗者のみ参加できます');
   if(!['tokyo','kisarazu'].includes(body.direction))throw new ApiError(400,'進行方向を選んでください');
   const status=this.location(body,request);if(status!=='inside')throw new ApiError(403,status==='outside'?'アクアラインのエリア外です':'位置情報の精度が足りません。地上で再確認してください');
   if(this.sessions.size>=LIMITS.sessions)throw new ApiError(503,'広場の参加人数が上限です。時間をおいてお試しください');
   await this.rate(request,'admissions',now);
   const token=crypto.randomUUID()+crypto.randomUUID().replaceAll('-','');
   const id=crypto.randomUUID(),s:Session={id,name:`波待ち ${id.slice(0,4).toUpperCase()}`,direction:body.direction,expiresAt:now+TICKET_MS,posts:[]};this.sessions.set(token,s);await this.save();return json({token,session:this.publicSession(s)},201);
  }
  const token=this.token(request),session=this.auth(token);
  if(path==='/api/session/revoke'&&method==='POST'){this.sessions.delete(token);this.closeToken(token);await this.save();return json({ok:true});}
  if(path==='/api/session/renew'&&method==='POST'){
   const status=this.location(await this.body(request),request);
   if(status==='outside'){this.sessions.delete(token);this.closeToken(token);await this.save();throw new ApiError(403,'エリア外になったため退出しました');}
   if(status==='inside'){session.expiresAt=now+TICKET_MS;await this.save();for(const [ws,info] of this.sockets)if(info.token===token)this.arm(ws,token);}
   return json({session:this.publicSession(session),locationStatus:status});
  }
  if(path==='/api/events'&&method==='GET'){
   if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new ApiError(426,'WebSocket接続が必要です');
   if(this.sockets.size>=LIMITS.sockets || [...this.sockets.values()].filter(s=>s.token===token).length>=LIMITS.socketsPerTicket)throw new ApiError(503,'接続数が上限です。別のタブを閉じてお試しください');
   const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();this.arm(server,token);
   // This is a server-to-client invalidation channel; unsolicited messages close it.
   server.addEventListener('message',()=>{try{server.close(1008,'receive-only channel');}catch{}this.release(server);});
   server.addEventListener('close',()=>this.release(server));
   server.addEventListener('error',()=>this.release(server));
   return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':'aqualine'}});
  }
  if(path==='/api/posts'&&method==='GET')return json({posts:this.posts.filter(p=>visible(p,now)).map(p=>({id:p.id,authorId:p.authorId,name:p.name,direction:p.direction,text:p.text,parentId:p.parentId,createdAt:p.createdAt,mine:p.authorId===session.id,reactions:Object.fromEntries(Object.entries(p.reactions).map(([k,v])=>[k,v.length])),myReactions:Object.entries(p.reactions).filter(([,v])=>v.includes(session.id)).map(([k])=>k)})).reverse()});
  if(path==='/api/posts'&&method==='POST'){
   this.clean(now);
   const body=await this.body(request);let text:string;try{text=validText(body.text);}catch(e){throw new ApiError(400,e instanceof Error?e.message:'本文が不正です');}
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
   else if(method==='POST'&&match[2]==='report'){post.reportedAt=now;post.reactions={wave:[],thanks:[],same:[]};}
   else if(method==='POST'&&match[2]==='react'){const {reaction}=await this.body(request);if(!['wave','thanks','same'].includes(reaction))throw new ApiError(400,'リアクションが不正です');const list=post.reactions[reaction as Reaction],i=list.indexOf(session.id);if(i<0){if(Object.values(post.reactions).reduce((n,v)=>n+v.length,0)>=LIMITS.reactionsPerPost)throw new ApiError(503,'この投稿へのリアクション数が上限です');list.push(session.id);}else list.splice(i,1);}
   else throw new ApiError(405,'この操作はできません');
   await this.save();this.broadcast();return json({ok:true});
  }
  throw new ApiError(404,'見つかりません');
 }
 async alarm(){await this.ready;await this.serial(async()=>{this.clean();await this.save();this.broadcast();await this.state.storage.setAlarm(Date.now()+60_000);});}
}
