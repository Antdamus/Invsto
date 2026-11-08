import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={window:{},Intl,Date};
vm.runInNewContext(await readFile(new URL('../streamer-performance.js',import.meta.url),'utf8'),context);
const analysis=context.window.StreamerPerformance,period={from:'2026-11-02',through:'2026-11-08'};
const show=(id,start,net=100,extra={})=>({event_id:id,title:'Jewelry',scheduled_start:start,starts_at:start,seller:'Sydney',seller_source:'recorded',net,orders:1,linked_lines:1,airtime_seconds:3600,airtime_provisional:false,insights:{paid_items:1},...extra});
const history=shows=>({from:'2026-06-01',until:'2026-11-09',as_of:'2026-11-08T19:00:00Z',coverage:{},shows});
test('same-weekday comparisons use distinct active dates and strictly prior shows',()=>{
 const m=analysis.model(history([show('a','2026-10-05T14:00Z',100),show('b','2026-10-05T18:00Z',300),show('c','2026-10-12T14:00Z',600),show('d','2026-11-02T15:00Z',750)]),period);
 const monday=m.sellers[0].comparisons[0];assert.equal(monday.base,500);assert.equal(monday.now,750);assert.equal(monday.lift,.5);assert.equal(monday.previous,2);assert.equal(m.past.length,3);
 assert.equal(m.sellers[0].comparisons[1].base,null);
});
test('DST uses Eastern start dates; missing, partial and provisional evidence never becomes a zero day',()=>{
 const a=show('a','2026-10-05T14:00Z'),b=show('b','2026-10-05T18:00Z',500,{airtime_provisional:true});
 const m=analysis.model(history([a,b,show('partial','2026-10-12T14:00Z',100,{insights:{paid_items:30}}),show('today','2026-11-08T15:00Z'),show('unknown','2026-10-06T14:00Z',0,{orders:0,insights:null,airtime_seconds:null}),show('zero','2026-10-07T14:00Z',0,{orders:0,linked_lines:0,insights:{paid_items:0}}),show('dst','2026-11-02T04:30Z',200,{seller:'Otello'})]),period);
 assert.equal(m.excluded.length,4);assert.equal(m.sellers.find(s=>s.name==='Sydney').comparisons[0].previous,0);
 assert.equal(m.all.find(s=>s.event_id==='dst').day,'2026-11-01');assert.equal(m.all.find(s=>s.event_id==='dst').slot,22);
 assert.equal(m.past.find(s=>s.event_id==='zero').net,0);
});
test('sample size alone cannot recommend a window without matched weekday/month/type groups',()=>{
 const a=[];for(let i=0;i<8;i++)a.push({event_id:String(i),weekday:0,month:i<4?'2026-09':'2026-10',format:'Jewelry',slot:10,net:100,rate:100,day:String(i)});
 assert.equal(analysis.windows(a)[0].supported,false);
 for(let i=0;i<12;i++)a.push({event_id:'c'+i,weekday:1,month:i<6?'2026-09':'2026-10',format:'Watches',slot:14,net:1,rate:1,day:String(i)});
 assert.ok(analysis.windows(a).every(w=>!w.supported));
});
test('matched recommendations require repeated comparable groups and robust median metrics',()=>{
 const a=[];for(const month of ['2026-08','2026-09','2026-10'])for(let i=0;i<4;i++)a.push({event_id:month+i,weekday:0,month,format:'Jewelry',slot:i<2?10:14,net:i<2?200:100,rate:i<2?200:100,day:month+i});
 const w=analysis.windows(a).find(w=>w.slot===10);assert.equal(w.supported,true);assert.equal(w.lift,1);assert.equal(w.matchedShows,6);assert.equal(w.controlShows,6);
 assert.equal(analysis.stats([{net:100},{net:200},{net:100000}]).median,200);
});
test('rendering escapes names and exports exclusions and provenance',()=>{
 const state={status:'ready',data:history([show('x','2026-10-05T14:00Z',100,{seller:'<img onerror=x>',airtime_provisional:true})])};
 const html=analysis.render(state,period);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/No reliable|More completed/);
 const rows=analysis.csvRows(state,period);assert.ok(rows.some(r=>r.includes('Insights still processing')));assert.match(analysis.render({status:'error',message:'<bad>'},period),/Retry historical analysis/);
});
test('source analytics export preserves missing values and stays separate from net sales',()=>{
 const state={status:'ready',data:history([show('x','2026-10-05T14:00Z',100,{insights:{paid_items:1,studio_gross_including_tax_shipping:120,studio_average_sales_price:120,total_viewers:0,peak_viewers:null,source_url:'https://www.ebay.com/ebaylive/host/events/example?tab=insights'}})])};
 const rows=analysis.csvRows(state,period),header=rows.find(r=>r[0]==='Historical show'),row=rows.find(r=>r[1]==='x');
 assert.equal(row[header.indexOf('Net merchandise sales')],100);assert.equal(row[header.indexOf('Studio sales including tax and shipping')],120);
 assert.equal(row[header.indexOf('Total viewers')],0);assert.equal(row[header.indexOf('Peak viewers')],null);
});
