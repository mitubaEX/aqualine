import {describe,it,expect} from 'vitest';
import {locationStatus,validText,postingAllowed,visible,retained,TICKET_MS,VISIBLE_MS,DELETE_MS,QUARANTINE_MS,type Post,type Session} from './domain';
describe('location decisions',()=>{
 it('accepts synthetic center only with reliable accuracy',()=>{expect(locationStatus({lat:35.4645,lng:139.8753,accuracy:10})).toBe('inside');expect(locationStatus({lat:35.4645,lng:139.8753,accuracy:900})).toBe('unknown');});
 it('reliably outside / invalid / missing are distinct',()=>{expect(locationStatus({lat:36,lng:140,accuracy:10})).toBe('outside');expect(locationStatus(undefined)).toBe('unknown');expect(locationStatus({lat:91,lng:139,accuracy:1})).toBe('unknown');expect(locationStatus({lat:35,lng:139,accuracy:-1})).toBe('unknown');});
});
describe('content and lifecycle',()=>{
 it('counts unicode, trims, and rejects links',()=>{expect(validText(' 波🌊 ')).toBe('波🌊');expect(validText('🌊'.repeat(140))).toHaveLength(280);expect(()=>validText('🌊'.repeat(141))).toThrow();for(const s of ['','https://example.com','example.xyz','ftp://host/path','www.example.jp'])expect(()=>validText(s)).toThrow();});
 it('enforces both posting limits',()=>{const s={posts:[1000]} as Session;expect(postingAllowed(s,10_999)).toBe(false);expect(postingAllowed(s,11_000)).toBe(true);expect(postingAllowed({posts:Array.from({length:10},(_,i)=>i*10_000)} as Session,110_000)).toBe(false);expect(postingAllowed(s,700_000)).toBe(true);});
 it('hides at 60min, deletes at24h, quarantines30d after report',()=>{const p={createdAt:1000} as Post;expect(visible(p,1000+VISIBLE_MS)).toBe(false);expect(retained(p,1000+DELETE_MS)).toBe(false);p.reportedAt=2000;expect(visible(p,3000)).toBe(false);expect(retained(p,2000+QUARANTINE_MS-1)).toBe(true);expect(retained(p,2000+QUARANTINE_MS)).toBe(false);expect(TICKET_MS).toBe(1_200_000);});
});
