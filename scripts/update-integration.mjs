import assert from 'node:assert/strict';
const base=process.env.API_URL||'http://127.0.0.1:5175';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Synthetic congestion is local-only');
async function api(path,body,token,method=body?'POST':'GET'){
 const r=await fetch(base+'/api'+path,{method,headers:{Origin:base,...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
}
const people=[],posts=[];
try{
 for(let i=0;i<3;i++){
  const s=await api('/session',{passenger:true,direction:'kisarazu',dev:true});assert.equal(s.status,201);people.push(s.data.token);
  const p=await api('/posts',{congestion:'moving'},s.data.token);assert.equal(p.status,201);posts.push([s.data.token,p.data.id]);
 }
 const summary=await api('/congestion');assert.equal(summary.status,200);const d=summary.data.directions.find(x=>x.direction==='kisarazu');assert.ok(d.sampleSize>=3);assert.ok(d.counts.moving>=3);
 assert.ok(!JSON.stringify(summary.data).includes('authorId'));
 console.log('PASS real local congestion-only posts and public aggregate');
}finally{
 for(const [token,id] of posts)assert.equal((await api('/posts/'+id,undefined,token,'DELETE')).status,200);
 for(const token of people)assert.equal((await api('/session/revoke',{},token)).status,200);
}
