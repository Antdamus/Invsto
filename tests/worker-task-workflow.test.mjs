import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

test('worker preview filters finished/review work before its limit so active assignments remain visible',async()=>{
 const source=await readFile(new URL('../worker-dashboard.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function fetchWorkerOrderTasks('),source.indexOf('function getWorkerOrderTaskOrder('));
 const rows=Array.from({length:80},(_,i)=>({id:i,status:'completed_by_employee',assigned_to_user_id:'worker'}));
 rows.push({id:81,status:'waiting_on_admin',assigned_to_user_id:'worker'},{id:82,status:'assigned',assigned_to_user_id:'worker'},
  {id:83,status:'sent_back_for_rework',assigned_to_user_id:'worker'},{id:84,status:'assigned',assigned_to_user_id:'someone-else'});
 const seen={};const query={select:()=>query,eq:(key,value)=>{seen.owner=value;return query;},in:(key,values)=>{seen.statuses=values;return query;},order:()=>query,
  limit:n=>Promise.resolve({data:rows.filter(row=>row.assigned_to_user_id===seen.owner&&seen.statuses.includes(row.status)).slice(0,n),error:null})};
 const context=vm.createContext({window:{supabase:{from:table=>{assert.equal(table,'ebay_order_tasks');return query;}}}});
 vm.runInContext(fn,context);const result=await context.fetchWorkerOrderTasks('worker');
 assert.deepEqual(result.map(row=>row.id),[82,83]);
});
