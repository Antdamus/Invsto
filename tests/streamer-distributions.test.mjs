import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const c={window:{},Intl,Date};
for(const name of ['streamer-performance','streamer-distributions','streamer-commercial-analysis'])vm.runInNewContext(await readFile(new URL('../'+name+'.js',import.meta.url),'utf8'),c);
const D=c.window.StreamerDistributions,A=c.window.StreamerCommercialAnalysis;
const period={from:'2026-11-02',through:'2026-11-08'},filters={seller:'Otello',format:'all',weekday:'all'};
const show=(id,net,start='2026-10-04T22:15-04:00',extra={})=>({event_id:id,title:'Rolex watch show',seller:'Otello',seller_source:'time_rule',scheduled_start:start,orders:1,linked_lines:1,net,airtime_seconds:18000,insights:{sales_status:'ready',paid_items:1},commercial:{version:1,orders:1,precise_orders:1,halves:[{bin:0,net,orders:1}]},...extra});
const history=shows=>({from:'2025-08-07',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{},shows});
const model=shows=>A.build(history(shows),period,filters);
test('skewed data retains zeros and extremes, with auditable medians, quartiles and counts',()=>{
 const m=model([0,100,200,300,10000].map((n,i)=>show(String(i),n))),d=D.build(m);
 assert.equal(d.stats.median,200);assert.equal(d.stats.mean,2120);assert.equal(d.stats.q1,100);assert.equal(d.stats.q3,300);
 assert.equal(d.stats.min,0);assert.equal(d.stats.max,10000);assert.equal(d.histogram.reduce((n,b)=>n+b.rows.length,0),5);
 const recovered=d.histogram.flatMap(b=>b.rows.map(s=>s.event_id));assert.equal(new Set(recovered).size,5);
});
test('equal-width bins include every boundary once, including the final upper bound and negative values',()=>{
 const bounds=[-10,0,10,20],values=[-10,-.01,0,9.99,10,20];
 assert.deepEqual(Array.from(D.bins(values.map(value=>({value})),bounds),b=>b.rows.length),[2,2,2]);
 assert.equal(D.binIndex(20,bounds),2);assert.equal(D.binIndex(20.01,bounds),-1);
 for(const values of [[0],[100,100],[.01,.02,.03],[-5,0,10000]]){
  const e=D.edges(values,8),b=D.bins(values.map(value=>({value})),e);assert.equal(b.reduce((n,x)=>n+x.rows.length,0),values.length);assert.ok(e.every(Number.isFinite));
 }
});
test('start-hour selection preserves shared histogram edges and scales; selecting a bar leaves the median intact',()=>{
 const m=model([show('a',100),show('b',300),show('c',10000,'2026-10-04T21:30-04:00')]);
 const all=D.build(m),late=D.build(m,{distStart:'22'});assert.deepEqual(late.bounds,all.bounds);assert.equal(late.maxCount,all.maxCount);assert.equal(late.rows.length,2);assert.equal(late.stats.median,200);
 const b=all.histogram.find(b=>b.rows.some(s=>s.event_id==='c'));
 const picked=D.build(m,{distBin:String(b.index)});assert.equal(picked.stats.median,300);assert.equal(picked.selectedRows.length,1);assert.equal(picked.selectedRows[0].event_id,'c');
});
test('calendar filters use the Eastern start date once across midnight, month boundaries and DST',()=>{
 const m=model([show('month-end',100,'2026-09-01T03:30Z'),show('dst',200,'2026-11-01T01:30-04:00'),show('dst2',300,'2026-11-01T01:30-05:00')]);
 const late=D.build(m,{distMonth:'2026-08',distPhase:'2',distOccurrence:'5'});assert.equal(late.rows.length,1);assert.equal(late.rows[0].day,'2026-08-31');assert.equal(late.rows[0].startHour,23);
 const dst=D.build(m,{distMonth:'2026-11',distStart:'1',distOccurrence:'1'});assert.equal(dst.rows.length,2);assert.equal(dst.stats.median,250);assert.equal(dst.rows[0].day,'2026-11-01');
});
test('hourly distributions exclude missing and short airtime; half-hours exactly match common duration cohorts',()=>{
 const a=show('a',500),m=model([a,show('short',50,undefined,{airtime_seconds:600}),show('missing',100,undefined,{airtime_seconds:null}),show('incomplete',200,undefined,{commercial:{...a.commercial,precise_orders:0}})]);
 assert.equal(D.build(m).rows.length,4);assert.equal(D.build(m,{distMetric:'rate'}).rows.length,2);
 const half=D.build(m,{distMetric:'half:1'});assert.equal(half.rows.length,1);assert.equal(half.stats.median,0);assert.equal(half.excluded,3);
 assert.equal(D.build(m,{distMetric:'half:99'}).metric,'net');
});
test('no selected-period or duplicate observations enter distributions; no matches stays empty',()=>{
 const s=show('one',100),m=model([s,s,show('current',10000,'2026-11-02T21:00-05:00')]);
 assert.equal(D.build(m).rows.length,1);assert.equal(D.build(m,{distPhase:'2'}).rows.length,0);
 assert.match(D.render(m,{distPhase:'2'}),/No usable shows match/);assert.ok(!D.render(m).includes('NaN'));
});
test('underlying records and CSV preserve chosen metric and dates and escape titles',()=>{
 const m=model([show('a',100,undefined,{title:'<img src=x onerror=alert(1)>'}),show('b',200)]),d=D.build(m,{distShow:'a',distMetric:'rate'});
 assert.equal(d.selectedRows.length,1);assert.equal(d.selectedRows[0].value,20);
 const html=D.render(m,{distShow:'a',distMetric:'rate'});assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/1st Sunday/);
 const rows=D.csvRows(m,{distShow:'a',distMetric:'rate'});assert.ok(rows.some(r=>r[0]==='a'&&r.includes(20)));assert.ok(!rows.some(r=>r[0]==='b'));
 const commercial=A.csvRows(history(m.rows),period,{...filters,distMetric:'rate'});assert.ok(commercial.some(r=>r[0]==='Historical show distribution'));
});
