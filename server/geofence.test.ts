import {describe,it,expect} from 'vitest';
import {locationStatus,ROAD} from './domain';
// Independent raster observations, not points interpolated from ROAD.
// GSI standard tiles z16; tile IDs/pixels and uncertainty in docs/geofence-source.md.
const bridge=[[35.449973,139.8954821],[35.4488717,139.8970914],[35.4477705,139.8987007]];
const curve=[[35.4391871,139.9113178],[35.4387851,139.9119616]];
const status=(p:number[],accuracy=10)=>locationStatus({lat:p[0],lng:p[1],accuracy});
describe('public-map bridge regression',()=>{
 it('admits independent bridge observations, including accuracy 80, but not 81',()=>{
  for(const p of bridge){expect(status(p)).toBe('inside');expect(status(p,80)).toBe('inside');expect(status(p,81)).toBe('unknown');}
 });
 it('follows the Kisarazu curve instead of the obsolete offshore endpoint',()=>{
  for(const p of curve)expect(status(p,80)).toBe('inside');
  expect(status([35.4468,139.9179])).toBe('outside');
 });
 it('connects the PA mainline and both sides of the bridge connection',()=>{
  for(const p of [[35.4632216,139.875226],[35.462173,139.8767281],
    // Withheld Vector vertices: PA mainline, bridge beginning, and coast landing.
    [35.4630643434,139.8762077093],[35.4614651771,139.8786270618],[35.4366740354,139.9166661501]])expect(status(p,30)).toBe('inside');
 });
 it('does not admit offshore points on either side or nearby ordinary roads',()=>{
  for(const p of [[35.453,139.898],[35.444,139.893],[35.4350481,139.9129540],[35.433,139.920]])
   for(const accuracy of [10,80])expect(status(p,accuracy)).toBe('outside');
 });
 it('caps the landing instead of extending the infinite line along the approach',()=>{
  expect(status([35.4365604,139.9169344],80)).toBe('inside');
  expect(status([35.4348427,139.9203944],10)).toBe('outside');
 });
 it('preserves the 100m admission / 150m outside hysteresis and accuracy limit',()=>{
  const a=ROAD[6],b=ROAD[7],lat=(a[0]+b[0])/2,lng=(a[1]+b[1])/2;
  const sx=111320*Math.cos(lat*Math.PI/180),dx=(b[1]-a[1])*sx,dy=(b[0]-a[0])*111320,n=Math.hypot(dx,dy);
  const offset=(m:number)=>[lat+m*dx/n/111320,lng-m*dy/n/sx];
  expect(status(offset(89),10)).toBe('inside');expect(status(offset(91),10)).toBe('unknown');
  expect(status(offset(159),10)).toBe('unknown');expect(status(offset(161),10)).toBe('outside');
  expect(status(offset(0),500)).toBe('unknown');
 });
 it('keeps the existing tunnel vertices and PA special area unchanged',()=>{
  expect(ROAD.slice(0,3)).toEqual([[35.5199,139.8159],[35.4924,139.8506],[35.4645,139.8753]]);
  expect(status([35.4645,139.8753],80)).toBe('inside');
 });
});
