import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const c={window:{},Intl,Date};for(const f of ['streamer-performance','streamer-commercial-analysis'])vm.runInNewContext(await readFile(new URL('../'+f+'.js',import.meta.url),'utf8'),c);
const A=c.window.StreamerCommercialAnalysis,period={from:'2026-11-02',through:'2026-11-08'},options={seller:'Otello',format:'all',weekday:'all',minHours:3};
const show=(id,extra={})=>({event_id:id,title:'Rolex watches',seller:'Otello',seller_source:'time_rule',scheduled_start:'2026-10-04T22:00-04:00',starts_at:'2026-10-04T22:00-04:00',orders:2,linked_lines:2,net:100,booked:120,cancelled:10,refunded:5,held:5,airtime_seconds:10800,insights:{paid_items:2,sales_status:'ready',total_viewers:100,purchasers:10},commercial:{version:1,orders:2,precise_orders:2,halves:[{bin:0,net:80,orders:1},{bin:2,net:20,orders:1}],clocks:[{hour:22,net:80},{hour:23,net:20}],merchandise:[],largest_order_net:80,top_three_orders_net:100,largest_buyer_net:90,missing_buyer_orders:0},...extra});
const history=shows=>({from:'2025-08-07',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{},shows});
test('timing uses identical duration cohorts, zero intervals and excludes imprecise/missing evidence',()=>{
 const a=show('a'),b=show('b',{airtime_seconds:3600}),missing=show('c',{commercial:null}),imprecise=show('d',{commercial:{...a.commercial,precise_orders:1}});
 const m=A.build(history([a,b,missing,imprecise]),period,options);
 assert.equal(m.cohort.length,1);assert.equal(m.halves[0].net,80);assert.equal(m.halves[1].net,0);assert.equal(m.halves[1].n,1);
 assert.equal(m.hours[0].n,2);assert.equal(m.hours[1].n,1);assert.equal(m.missingDetails,1);
});
test('clock exposure handles overnight, partial hours and the repeated DST hour',()=>{
 const dst=show('dst',{scheduled_start:'2026-11-01T00:30-04:00',airtime_seconds:4*3600});
 assert.equal(A.exposure(dst,0),.5);assert.equal(A.exposure(dst,1),2);assert.equal(A.exposure(dst,2),1);assert.equal(A.exposure(dst,3),.5);
 const m=A.build(history([dst]),period,options);assert.ok(m.clock.every(r=>r.hour!==0&&r.hour!==3));
});
test('filters retain only strictly prior shows and resetting a missing title does not hide all data',()=>{
 const m=A.build(history([show('a'),show('current',{scheduled_start:'2026-11-02T23:00-05:00'}),show('s',{seller:'Sydney'})]),period,{...options,series:'missing'});
 assert.equal(m.rows.length,1);assert.equal(m.series,'all');assert.equal(m.selected,1);
});
test('retention reports current age bands without inventing fixed-age historical outcomes',()=>{
 const m=A.build(history([show('a'),show('b',{scheduled_start:'2026-10-25T23:00-04:00'})]),period,options);
 assert.equal(m.retention.length,2);assert.equal(m.retention[0].name,'Under 30 days');assert.equal(m.retention[1].name,'30–59 days');assert.equal(m.retention[0].retained,100/120);
 assert.match(A.render(history([show('a')]),period,options),/not exact day-30 outcomes/);
});
test('audience preserves zero metrics, excludes incomplete pairs and buyer concentration requires identified buyers',()=>{
 const a=show('a'),b=show('b',{insights:{...a.insights,total_viewers:null},commercial:{...a.commercial,missing_buyer_orders:1}}),z=show('z',{insights:{...a.insights,total_viewers:0,purchasers:0}});
 const m=A.build(history([a,b,z]),period,options),aud=m.audience[0],con=m.concentration[0];
 assert.equal(aud.n,2);assert.equal(aud.viewers,50);assert.equal(aud.conversion,.1);assert.equal(con.n,3);assert.equal(con.buyerN,2);assert.equal(con.withoutOrder,20/3);assert.equal(con.withoutBuyer,10/3);
});
test('calendar matching never claims an adjustment from unmatched Sunday positions',()=>{
 const shows=[1,2,3,4].map((n,i)=>show(String(n),{scheduled_start:'2026-10-'+String(4+i*7).padStart(2,'0')+'T'+(i%2?'23':'21')+':00-04:00'}));
 const m=A.build(history(shows),period,options);assert.equal(m.sunday.length,4);assert.ok(m.matched.every(r=>r.groups===0&&r.lift===null));
 assert.equal(A.season('2025-12'),'Winter 2025–2026');assert.equal(A.season('2026-02'),'Winter 2025–2026');
});
test('merchandise separates unknown identities, unpriced units and original versus net sales; output escapes text',()=>{
 const a=show('a');a.commercial.merchandise=[{category:'Watch',brand:'<img onerror=x>',evidence:'Staff classification',price_band:'$100-$499',lines:1,units:2,priced_lines:1,priced_units:2,original_sales:240},{category:'Item not identified',brand:'Not identified',evidence:'Not identified',price_band:'Price unavailable',lines:1,units:1,priced_lines:0,priced_units:null,original_sales:null}];
 const h=history([a]),m=A.build(h,period,options);assert.equal(m.identifiedLines,1);assert.equal(m.lines,2);assert.equal(m.brands[0].sales,240);assert.equal(m.brands[1].sales,null);
 const html=A.render(h,period,options);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/original item sales/);
 const csv=A.csvRows(h,period,options);assert.ok(csv.some(r=>r.includes(240)));assert.ok(csv.some(r=>r.includes('Staff classification')));
});
