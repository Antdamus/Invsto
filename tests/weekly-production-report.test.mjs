import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={window:{},Intl,Date};
vm.runInNewContext(await readFile(new URL('../weekly-production-report.js',import.meta.url),'utf8'),context);
const report=context.window.WeeklyProductionReport;
test('show airtime counts each show once, keeps zero-sales shows and excludes prior-week airtime',()=>{
 const week='2026-11-02',order=(id,show,seller='Otello')=>({order:id,week,day:week,show,seller,net:100,booked:100,show_source:'captured'});
 const data={as_of:'2026-11-08T18:00Z',days:[{day:week,week},{day:'2026-11-03',week}],orders:[order('1','night'),order('2','night'),order('3','prior')],timing:[
  {event_id:'night',starts_at:'2026-11-03T04:00Z',airtime_seconds:7200,title:'=Unsafe <script>',airtime_provisional:true},
  {event_id:'prior',starts_at:'2026-11-02T04:00Z',airtime_seconds:3600,title:'Prior week'},
  {event_id:'zero',starts_at:'2026-11-03T15:00Z',airtime_seconds:1800,title:'Zero sales'},
  {event_id:'missing',starts_at:'2026-11-03T19:00Z',title:'No duration'}]};
 const m=report.model(data,week);assert.equal(m.airtime,9000);assert.equal(m.shows.length,4);assert.equal(m.inPeriod.length,3);assert.equal(m.timed.length,2);
 const html=report.render(m);assert.match(html,/Mon, Nov 2, 2026/);assert.match(html,/Not recorded/);assert.match(html,/Previously recorded|Scheduled start/);assert.ok(!html.includes('<script>'));
 assert.match(report.csv(m),/"'=Unsafe <script>"/);assert.match(html,/Streaming hours by streamer/);assert.ok(!html.includes('timeclock'));assert.equal(m.rows.reduce((n,r)=>n+r.net,0),300);
});
test('mixed sellers never double-count airtime and a linked show without metadata keeps its sales',()=>{
 const week='2026-11-02';
 const m=report.model({days:[{day:week,week}],orders:[
  {order:'1',week,day:week,show:'mixed',seller:'Otello',net:10,booked:10},
  {order:'2',week,day:week,show:'mixed',seller:'Sydney',net:20,booked:20},
  {order:'3',week,day:week,show:'lost',seller:'Sydney',net:30,booked:30,show_title:'Missing metadata'}
 ],timing:[{event_id:'mixed',title:'Mixed show',starts_at:'2026-11-02T18:00Z',airtime_seconds:3600}]},week);
 assert.equal(m.airtime,3600);assert.equal(m.inPeriod.length,1);assert.equal(m.shows[0].seller,'Multiple sellers — review');
 assert.equal(m.shows.length,2);assert.equal(m.shows[1].inPeriod,false);
 assert.match(report.render(m),/Missing metadata/);assert.match(report.render(m),/Start not recorded/);
 assert.match(report.csv(m),/"Multiple sellers — review","1","1","1","3600","3600"/);
});
