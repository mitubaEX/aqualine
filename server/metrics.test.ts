import {it,expect,vi} from 'vitest';
import {Metrics} from './metrics';
import {memoryStorage} from './test-storage';
it('persists daily numeric aggregates immediately and prunes old buckets',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
 const m=memoryStorage();const metrics=new Metrics(m.storage);
 metrics.record(200);metrics.record(401);metrics.record(503);metrics.record(400,true);metrics.flush();metrics.flush();
 const writes=m.sqlCalls.filter(c=>c[0].startsWith('INSERT'));
 expect(writes).toHaveLength(4);expect(writes.map(w=>w.slice(1))).toEqual([['2026-10-29',1,0,0,0],['2026-10-29',0,1,0,0],['2026-10-29',0,0,1,0],['2026-10-29',0,0,0,1]]);
 expect(m.sqlCalls.at(-1).slice(1)).toEqual(['2026-10-23']);vi.useRealTimers();
});
