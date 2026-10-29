// Transactional storage model: failed writes roll back together, including migrations.
export function memoryStorage(saved=new Map<string,any>()) {
 let failure=false;const sqlCalls:any[]=[];
 const storage:any={
  sql:{exec:(...args:any[])=>{sqlCalls.push(args);return {toArray:()=>[]};}},transactionSync:(fn:()=>unknown)=>fn(),
  get:async(k:string)=>structuredClone(saved.get(k)),
  put:async(k:string,v:any)=>{if(failure){failure=false;throw Error('private storage diagnostic');}saved.set(k,structuredClone(v));},
  getAlarm:async()=>null,setAlarm:async()=>{},
  transaction:async(fn:(tx:any)=>Promise<unknown>)=>{const before=structuredClone(saved);try{return await fn(storage);}catch(e){saved.clear();for(const [k,v]of before)saved.set(k,v);throw e;}},
 };
 return {saved,storage,sqlCalls,failNext:()=>{failure=true;}};
}
