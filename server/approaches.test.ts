import {describe,it,expect} from 'vitest';
import {locationStatus,ROADS,TICKET_MS} from './domain';
// Independent GSI standard raster observations; pixel provenance in docs/approach-corridors.md.
const status=(p:number[],accuracy=30)=>locationStatus({lat:p[0],lng:p[1],accuracy});
describe('approach corridors',()=>{
 it('k6',()=>{for(const p of [[35.5267779, 139.7773361], [35.5302705, 139.771328], [35.5329247, 139.7666073]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('tokyo',()=>{for(const p of [[35.5278257, 139.793644], [35.5330644, 139.7949314], [35.5410964, 139.7918415], [35.5435408, 139.7902107]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('yokohama',()=>{for(const p of [[35.5089635, 139.779911], [35.5051206, 139.7730446], [35.5026751, 139.7678947]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('junction/ramps',()=>{for(const p of [[35.5180458, 139.791069], [35.514902, 139.7889233], [35.520421, 139.7884941]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('tunnel',()=>{for(const p of [[35.5114088, 139.8056602], [35.5023257, 139.8185349]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('kisarazu',()=>{for(const p of [[35.4347291, 139.92033], [35.4284349, 139.9271965], [35.4215806, 139.9366379], [35.4191325, 139.9413586]])for(const accuracy of [30,80])expect(status(p,accuracy),String(p)).toBe('inside');});
 it('outside general roads/gaps',()=>{for(const p of [[35.5330644, 139.779911], [35.5169979, 139.779911], [35.538652, 139.7781944], [35.5180458, 139.7670364], [35.5359979, 139.7618866], [35.5002294, 139.7627449], [35.5470326, 139.7884941]])expect(status(p),String(p)).toBe('outside');});
 it('outside east',()=>{for(const p of [[35.4331206, 139.9332047], [35.4268263, 139.9374962], [35.4156351, 139.9289131], [35.4166844, 139.9460793]])expect(status(p),String(p)).toBe('outside');});
 it('poor accuracy never becomes outside or extends ticket policy',()=>{expect(TICKET_MS).toBe(3600000);expect(status([35.52,139.79],81)).toBe('unknown');expect(status([35.1,139.1],81)).toBe('unknown');});
 it('source lines have no degenerate segments or artificial long joins',()=>{for(const road of ROADS)for(let i=1;i<road.length;i++){const a=road[i-1],b=road[i];expect(a).not.toEqual(b);const metres=Math.hypot((b[0]-a[0])*111320,(b[1]-a[1])*90500);expect(metres).toBeLessThan(5000);}});
});
