import {describe,it,expect} from 'vitest';
import worker,{Plaza} from './index';
import {memoryStorage} from './test-storage';
const admin='local-test-not-a-real-secret-'.repeat(2);
function setup(){const m=memoryStorage();const env:any={ENVIRONMENT:'production',FEEDBACK_ADMIN_TOKEN:admin};const plaza=new Plaza({storage:m.storage,blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn()} as any,env);env.PLAZA={idFromName:()=>1,get:()=>plaza};return {...m,plaza,env,call:(body:any={},headers:Record<string,string>={},path='/api/feedback',method='POST')=>worker.fetch(new Request('https://aqualine.test'+path,{method,headers:{'CF-Connecting-IP':'192.0.2.3',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})}),env)};}
const body=()=>({category:'idea',text:'便利です',idempotencyKey:crypto.randomUUID()});
describe('feedback public boundary',()=>{
 it('reschedules cleanup even after a storage failure',async()=>{const f=setup();await f.call(body());let scheduled=0;f.storage.setAlarm=async()=>{scheduled++;};f.failNext();await expect(f.plaza.alarm()).rejects.toThrow();expect(scheduled).toBe(1);});
 it('rejects cross-origin requests before storage',async()=>{const f=setup();expect((await f.call(body(),{Origin:'https://evil.test'})).status).toBe(403);expect(f.saved.has('feedback-v1')).toBe(false);});
 it('overwrites spoofed network headers and applies shared rate limit',async()=>{const f=setup();for(let i=0;i<3;i++)expect((await f.call(body(),{'X-Aqua-Network':String(i)})).status).toBe(201);expect((await f.call(body(),{'X-Aqua-Network':'new-network'})).status).toBe(429);});
 it('uses existing body cap and does not expose inbox to participant credentials',async()=>{const f=setup();expect((await f.call({text:'x'.repeat(5000)})).status).toBe(413);expect((await f.call({}, {Authorization:'Bearer participant-token'},'/api/admin/feedback','GET')).status).toBe(401);expect((await f.call({}, {Authorization:'Bearer '+admin},'/api/admin/feedback','GET')).status).toBe(200);});
});
