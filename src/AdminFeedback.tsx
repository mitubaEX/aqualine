import { useRef, useState } from 'react';
import './admin-feedback.css';
type Entry={id:string;category:'bug'|'idea'|'other';text:string;createdAt:number;reviewedAt?:number};
const categories={bug:'不具合',idea:'アイデア・要望',other:'その他'};
export default function AdminFeedback(){
 const [secret,setSecret]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false),generation=useRef(0);
 const clear=()=>{generation.current++;setSecret('');setEntries([]);setLoaded(false);setError('');};
 async function run(review?:string){
  if(pending.current||!secret)return;pending.current=true;setBusy(true);setError('');const version=generation.current;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const call=async(path:string,method='GET')=>{const response=await fetch(path,{method,headers:{Authorization:'Bearer '+secret,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{}),credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});if(!response.ok)throw Error(response.status===401?'認証できません。管理用キーを確認してください。':'取得・保存を確認できませんでした。再読み込みで確認してください。');return response.json();};
   if(review)await call('/api/admin/feedback/'+encodeURIComponent(review)+'/reviewed','POST');
   const data=await call('/api/admin/feedback') as {feedback:Entry[]};if(!Array.isArray(data.feedback))throw Error('受信箱の応答を確認できませんでした。');
   if(version===generation.current){setEntries(data.feedback);setLoaded(true);}
  }catch(e){if(version===generation.current)setError(controller.signal.aborted?'通信がタイムアウトしました。再読み込みで確認してください。':e instanceof Error?e.message:'通信に失敗しました。');}
  finally{clearTimeout(timer);pending.current=false;setBusy(false);}
 }
 return <main className="admin-feedback"><a href="/">← AquaLineに戻る</a><h1>ご意見の受信箱</h1><p>運営者専用。管理用キーはこの画面のメモリだけで扱い、URL・ブラウザ保存には入れません。共有端末では利用後に「閉じて消去」を押してください。</p>
 <form onSubmit={e=>{e.preventDefault();void run();}}><label htmlFor="admin-feedback-secret">管理用キー</label><input id="admin-feedback-secret" type="password" autoComplete="off" spellCheck={false} value={secret} disabled={busy} onChange={e=>{setSecret(e.target.value);setEntries([]);setLoaded(false);setError('');}}/><button disabled={busy||!secret}>{busy?'確認中…':loaded?'再読み込み':'受信箱を開く'}</button><button type="button" onClick={clear}>閉じて消去</button></form>
 <p role="alert">{error}</p>{loaded&&<><p role="status">未確認 {entries.filter(e=>!e.reviewedAt).length} 件 / 全 {entries.length} 件</p><p>30日で削除対象になります。保存枠は40件です。確認済みにしても枠は空きません。定期的に確認してください。自動通知は未設定です。</p>{entries.length===0?<p>受け付けたご意見はありません。</p>:<ul>{entries.map(entry=><li key={entry.id}><h2>{categories[entry.category]||'その他'} · {entry.reviewedAt?'確認済み':'未確認'}</h2><time>{new Date(entry.createdAt).toLocaleString('ja-JP')}</time><p className="admin-feedback-text">{entry.text}</p><button type="button" disabled={busy||!!entry.reviewedAt} onClick={()=>void run(entry.id)}>確認済みにする</button></li>)}</ul>}</>}
 </main>;
}
