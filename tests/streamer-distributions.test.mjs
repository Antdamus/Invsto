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

test('push labels preserve unknowns and dual labels across charts, filters, shared bins and CSV',()=>{
 const rows=[show('manual',50,undefined,{push:{manual:true,automatic:true,note:'<script>no</script>',manual_source:'recorded'}}),show('rule',1000,'2026-10-04T23:00-04:00',{push:{manual:false,automatic:null,manual_source:'date_rule'}}),show('unknown',500,'2026-10-04T20:00-04:00')],m=model(rows);
 assert.equal(D.pushSymbols(rows[0]),'★◆');assert.equal(D.pushSymbols(rows[1]),'☆');assert.equal(D.pushSymbols(rows[2]),'');
 assert.equal(D.build(m,{distPush:'manual_yes'}).rows.length,1);assert.equal(D.build(m,{distPush:'automatic_yes'}).rows[0].event_id,'manual');
 assert.equal(D.build(m,{distPush:'manual_no'}).rows[0].event_id,'rule');assert.equal(D.build(m,{distPush:'unknown'}).rows[0].event_id,'unknown');
 const shared=D.build(m,{distScale:'shared'});assert.ok(shared.groups.every(g=>JSON.stringify(g.bounds)===JSON.stringify(shared.bounds)&&g.maxCount===shared.maxCount));
 const html=D.render(m,{distShow:'manual',distScale:'shared'});
 assert.match(html,/Same bins across start times · On/);assert.match(D.render(m,{distView:'calendar'}),/★◆/);assert.match(html,/eBay automatic push/);assert.match(html,/&lt;script&gt;no&lt;\/script&gt;/);assert.ok(!html.includes('<script>no</script>'));
 assert.match(html,/data-wpr-push="manual"/);assert.match(html,/sde-push-chart-mark/);
 const csv=D.csvRows(m,{distShow:'manual'}),head=csv.find(r=>r[0]==='Event ID'),row=csv.find(r=>r[0]==='manual');
 assert.equal(row[head.indexOf('Manual push')],'Yes');assert.equal(row[head.indexOf('eBay automatic push')],'Yes');assert.equal(row[head.indexOf('Push note')],'<script>no</script>');
});

test('calendar view shows the push cutoff and shares calendar and money axes across start times',()=>{
 const m=model([show('july',100,'2026-07-01T20:00-04:00'),show('september',20000,'2026-09-01T22:00-04:00')]);
 const html=D.render(m,{distView:'calendar'});
 assert.match(html,/X axis: calendar date/);assert.match(html,/Y axis: net sales per show/);assert.match(html,/Aug 25 · no manual push/);
 assert.equal((html.match(/class="sde-push-cutoff"/g)||[]).length,3);assert.match(html,/sde-calendar-multiples/);assert.ok(!html.includes('class="sde-hist"'));
 assert.match(html,/data-sde-tooltip="sde-tip-show-july"/);assert.match(html,/id="sde-tip-show-july"/);
 assert.match(D.render(model([show('later',100)]),{distView:'calendar'}),/outside displayed dates/);
});
test('selling nights group 6 PM through next-day 5:59 AM, across month and DST boundaries',()=>{
 const dates=['2026-10-05T17:59-04:00','2026-10-05T18:00-04:00','2026-10-06T02:00-04:00','2026-10-06T05:59-04:00','2026-10-06T06:00-04:00','2026-11-01T01:30-04:00','2026-11-01T01:30-05:00'];
 const shows=dates.map((d,i)=>show(String(i),100,d)),m=A.build(history(shows),period,{...filters,dayMode:'night'}),d=D.build(m);
 assert.equal(m.rows.length,5);assert.deepEqual(Array.from(d.starts),[18,1,2,5]);assert.equal(d.daily.length,2);
 assert.equal(d.daily[0].day,'2026-10-05');assert.equal(d.daily[0].shows.length,3);assert.equal(d.daily[0].net,300);assert.equal(d.daily[0].airtime,54000);
 assert.equal(d.daily[1].day,'2026-10-31');assert.equal(d.daily[1].shows.length,2);assert.equal(m.rows.find(s=>s.event_id==='5').weekday,5);
 const mon=A.build(history(shows),period,{...filters,dayMode:'night',weekday:'0'});assert.equal(mon.rows.length,3);assert.match(D.render(mon),/Monday → Tuesday/);
 const boundary=A.build(history([show('previous-night',100,'2026-11-02T02:00-05:00'),show('current-night',100,'2026-11-02T18:00-05:00')]),period,{...filters,dayMode:'night'});
 assert.equal(boundary.rows.length,1);assert.equal(boundary.rows[0].day,'2026-11-01');assert.equal(boundary.selected,1);
});
test('traffic metrics preserve missing and zero values, conversion and non-currency labels',()=>{
 const m=model([show('viewed',100,undefined,{insights:{status:'ready',sales_status:'ready',paid_items:1,total_viewers:1000,peak_viewers:40,purchasers:20,average_viewing_seconds:368,new_followers:0}}),show('missing',100)]);
 const a=D.build(m,{distMetric:'audience:total_viewers'});assert.equal(a.rows.length,1);assert.equal(a.stats.median,1000);
 assert.equal(D.build(m,{distMetric:'audience:new_followers'}).stats.median,0);assert.equal(D.build(m,{distMetric:'audience:conversion'}).stats.median,2);
 const html=D.render(m,{distMetric:'audience:total_viewers'});assert.match(html,/Median <b>1,000/);assert.doesNotMatch(html,/Median <b>\$1,000/);assert.match(html,/Peak concurrent/);
 const details=D.render(m,{distShow:'viewed'});assert.match(details,/6m 8s/);assert.match(details,/hourly viewer curve is unavailable/);
});
test('per-show elapsed hours retain zero intervals, partial exposure and adjustments at original purchase time',()=>{
 const s=show('overnight',420,'2026-11-01T01:30-04:00',{booked:600,cancelled:100,refunded:50,held:30,airtime_seconds:9000,orders:3,commercial:{version:1,orders:3,precise_orders:3,halves:[{bin:0,orders:1,booked:300,net:200},{bin:1,orders:1,booked:100,net:100},{bin:4,orders:1,booked:200,net:120}]}});
 const h=D.elapsedHours(s);assert.equal(h.available,true);
 assert.deepEqual(Array.from(h.rows,r=>[r.index,r.exposure,r.orders,r.booked,r.net,r.rate,r.complete]),[[0,3600,2,400,300,300,true],[1,3600,0,0,0,0,true],[2,1800,1,200,120,240,false]]);
 assert.equal(h.outsideNet,0);assert.equal(D.finance(s).reconciled,true);
 assert.equal(D.finance({...s,net:421}).reconciled,false);assert.equal(D.finance({...s,refunded:null}).complete,false);
 assert.equal(D.elapsedHours({...s,airtime_provisional:true}).available,false);
 assert.equal(D.elapsedHours({...s,commercial:{...s.commercial,precise_orders:2}}).available,false);
 assert.equal(D.elapsedHours({...s,net:450}).outsideNet,30);
 const html=D.render(model([s]),{distShow:'overnight'});assert.match(html,/Original sales − canceled − refunded − under review/);assert.match(html,/2–3h · partial/);assert.match(html,/2h 30m 00s/);
 const csv=D.csvRows(model([s]),{});assert.ok(csv.some(r=>r[0]==='Elapsed hour'&&r[3]==='2–3'&&r[4]===1800&&r[9]===240));
});
test('elapsed-hour distributions use complete eligible intervals and exclude missing timestamp evidence',()=>{
 const a=show('a',500),m=model([a,show('partial',200,undefined,{airtime_seconds:5400}),show('missing',300,undefined,{commercial:null})]);
 const first=D.build(m,{distMetric:'elapsed:0'}),second=D.build(m,{distMetric:'elapsed:1'});
 assert.equal(first.rows.length,2);assert.equal(first.stats.median,350);assert.equal(second.rows.length,1);assert.equal(second.stats.median,0);assert.equal(second.excluded,2);
});
test('monthly start-hour matrix retains missing months and honors Sunday and month-position scope',()=>{
 const shows=[show('aug',100,'2026-08-02T22:00-04:00'),show('oct',300,'2026-10-04T22:00-04:00'),show('early',500,'2026-10-04T19:00-04:00'),show('monday',10000,'2026-10-05T22:00-04:00'),show('later',900,'2026-10-25T22:00-04:00')];
 const m=A.build(history(shows),period,{...filters,weekday:'6'}),d=D.build(m,{distMonth:'2026-10',distStart:'22',distOccurrence:'1'});
 assert.deepEqual(Array.from(d.monthGroups,g=>g.month),['2026-08','2026-09','2026-10']);assert.equal(d.monthGroups[1].cells[0].stats.n,0);
 assert.equal(d.monthGroups[2].cells.find(c=>c.hour===22).stats.median,300);assert.equal(d.rows.length,1);assert.equal(d.monthGroups[0].rows.length,1);
 assert.match(D.render(m,{distOccurrence:'1'}),/data-sde-month="2026-08"/);
});
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
test('start hours fit their own bins and counts by default and shared comparison remains available',()=>{
 const m=model([show('a',100),show('b',300),show('c',10000,'2026-10-04T21:30-04:00')]);
 const all=D.build(m),late=D.build(m,{distStart:'22'});assert.notDeepEqual(late.bounds,all.bounds);assert.ok(late.bounds.at(-1)<=350);assert.equal(late.maxCount,1);assert.equal(late.rows.length,2);assert.equal(late.stats.median,200);
 assert.deepEqual(late.bounds,all.groups.find(g=>g.hour===22).bounds);
 const shared=D.build(m,{distScale:'shared'}),sharedLate=D.build(m,{distStart:'22',distScale:'shared'});
 assert.deepEqual(sharedLate.bounds,shared.bounds);assert.equal(sharedLate.maxCount,shared.maxCount);assert.ok(shared.groups.every(g=>JSON.stringify(g.bounds)===JSON.stringify(shared.bounds)));
 const b=all.histogram.find(b=>b.rows.some(s=>s.event_id==='c'));
 const picked=D.build(m,{distBin:String(b.index)});assert.equal(picked.stats.median,300);assert.equal(picked.selectedRows.length,1);assert.equal(picked.selectedRows[0].event_id,'c');
});
test('weekday counts reconcile per chart, per bin, per card and selected records using Eastern start dates',()=>{
 const m=model([show('sunday',100,'2026-10-04T23:30-04:00'),show('monday',100,'2026-10-05T23:30-04:00'),show('tuesday',100,'2026-10-06T23:30-04:00'),show('other-hour',300,'2026-10-06T21:00-04:00')]);
 const d=D.build(m,{distStart:'23'}),b=d.histogram.find(b=>b.rows.length);
 assert.deepEqual(Array.from(b.weekdays,w=>w.n),[1,1,0,0,0,0,1]);
 assert.equal(b.weekdays.reduce((n,w)=>n+w.n,0),b.rows.length);
 assert.ok(d.groups.every(g=>g.bins.reduce((n,b)=>n+b.weekdays.reduce((t,w)=>t+w.n,0),0)===g.rows.length));
 const selected=D.build(m,{distStart:'23',distBin:String(b.index)});assert.equal(D.weekdayCounts(selected.selectedRows)[6].n,1);
 const csv=D.csvRows(m,{distStart:'23'});assert.ok(csv.some(r=>r[0]==='Shows'&&r[1]==='Displayed'&&r.slice(2).join(',')==='1,1,0,0,0,0,1'));
 const html=D.render(m,{distStart:'23'});assert.match(html,/sde-tip-main-/);assert.match(html,/Mon, Oct 5, 2026, 11:30 PM/);assert.match(html,/Tuesday <b>1/);
});
test('calendar filters use the Eastern start date once across midnight, month boundaries and DST',()=>{
 const m=model([show('month-end',100,'2026-09-01T03:30Z'),show('dst',200,'2026-11-01T01:30-04:00'),show('dst2',300,'2026-11-01T01:30-05:00')]);
 const late=D.build(m,{distMonth:'2026-08',distPhase:'2',distOccurrence:'5'});assert.equal(late.rows.length,1);assert.equal(late.rows[0].day,'2026-08-31');assert.equal(late.rows[0].startHour,23);
 const dst=D.build(m,{distMonth:'2026-11',distStart:'1',distOccurrence:'1'});assert.equal(dst.rows.length,2);assert.equal(dst.stats.median,250);assert.equal(dst.rows[0].day,'2026-11-01');
});
test('hourly rates include short shows; complete half-hours still match common duration cohorts',()=>{
 const a=show('a',500),m=model([a,show('short',50,undefined,{airtime_seconds:600}),show('missing',100,undefined,{airtime_seconds:null}),show('incomplete',200,undefined,{commercial:{...a.commercial,precise_orders:0}})]);
 assert.equal(D.build(m).rows.length,4);assert.equal(D.build(m,{distMetric:'rate'}).rows.length,3);
 assert.equal(D.elapsedHours(m.rows.find(s=>s.event_id==='short')).rows[0].exposure,600);
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
