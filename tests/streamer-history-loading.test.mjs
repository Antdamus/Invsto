import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={window:{},Intl,Date};
vm.runInNewContext(await readFile(new URL('../weekly-production-report.js',import.meta.url),'utf8'),context);
test('full history loads bounded adjacent ranges and combines coverage once',async()=>{
 const calls=[],client={rpc:async(name,args)=>{calls.push(args);return {data:{from:args._from,until:args._until,as_of:'2026-11-08T20:00Z',coverage:{first_show:'2025-08-08T01:58Z',orders:2,unlinked_orders:1,unlinked_net:.1},shows:[{event_id:args._from}]}};}};
 const data=await context.window.WeeklyProductionReport.fetchHistory(client,{through:'2026-11-08'},'all');
 assert.equal(data.from,'2025-08-07');assert.equal(data.until,'2026-11-09');assert.equal(calls.length,6);
 for(let i=1;i<calls.length;i++){assert.equal(calls[i]._until,calls[i-1]._from);assert.ok((Date.parse(calls[i]._until)-Date.parse(calls[i]._from))/86400000<=93);}
 assert.equal(data.shows.length,6);assert.equal(data.coverage.orders,12);assert.equal(data.coverage.unlinked_orders,6);assert.equal(data.coverage.unlinked_net,.6);
});
test('cancelled report requests stop before fetching more history and failures never return partial reports',async()=>{
 let calls=0;const client={rpc:async()=>{calls++;return {data:{shows:[],coverage:{first_show:'2025-08-08T01:58Z'}}};}};
 assert.equal(await context.window.WeeklyProductionReport.fetchHistory(client,{through:'2026-11-08'},'all',()=>false),null);assert.equal(calls,1);
 await assert.rejects(context.window.WeeklyProductionReport.fetchHistory({rpc:async()=>({error:{message:'unavailable'}})},{through:'2026-11-08'},'all'),e=>e.message==='unavailable');
});
