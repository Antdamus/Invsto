import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const report=async(args={})=>(await db.query('select admin_employee_work_report($1,$2,$3,$4,$5,$6,$7,$8) r',[
 args.day||'2026-10-13',args.worker||null,args.shift||null,args.category||null,args.search||null,args.offset??0,args.limit??50,args.asOf||'2026-10-14T04:00:00Z'
])).rows[0].r;
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;`);
 await db.exec(await readFile(new URL('fixtures/admin-work-report-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261013170000_admin_employee_work_report.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261013180000_work_report_closed_orders.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
 const tables=(await db.query("select tablename from pg_tables where schemaname='public'")).rows.map(r=>r.tablename);
 await db.exec('truncate '+tables.join(',')+' cascade');
 await db.exec(`set test.actor='${id(100)}';insert into employees(id,user_id,display_name,email,role,active) values
 ('${id(1)}','${id(100)}','Admin','admin@example.test','admin',true),
 ('${id(2)}','${id(200)}','Sandra','sandra@example.test','employee',true),
 ('${id(3)}','${id(300)}','Other worker','other@example.test','employee',true);`);
});
after(()=>db?.close());

test('order completions count whole orders once, preserve evidence after reopen, and credit the final signer',async()=>{
 await db.exec(`insert into ebay_orders(id,order_number,buyer_username) values('${id(600)}','09-15269-87504','buyer');
 insert into ebay_order_lines(id,order_id,item_title,quantity,fulfilled_quantity,line_status) values
 ('${id(601)}','${id(600)}','First item',2,0,'pending'),('${id(602)}','${id(600)}','Second item',1,0,'pending');
 set test.actor='${id(300)}';
 update ebay_order_lines set fulfilled_quantity=1,line_status='partially_fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where id='${id(601)}';`);
 assert.equal((await db.query('select count(*)::int n from pending_order_completion_events')).rows[0].n,0);
 await db.exec(`update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where id='${id(601)}';`);
 assert.equal((await db.query('select count(*)::int n from pending_order_completion_events')).rows[0].n,0);
 await db.exec(`set test.actor='${id(200)}';update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where id='${id(602)}';`);
 const e=(await db.query('select * from pending_order_completion_events')).rows[0];
 assert.equal(e.actor_user_id,id(200));assert.equal(e.order_number,'09-15269-87504');assert.equal(e.items.length,2);
 await db.exec(`update ebay_order_lines set notes='Later note' where order_id='${id(600)}';
 update ebay_order_lines set line_status='pending',fulfilled_quantity=0,fulfilled_by=null,fulfilled_at=null,item_title='Edited after closure' where id='${id(602)}';`);
 assert.equal((await db.query('select count(*)::int n from pending_order_completion_events')).rows[0].n,1);
 assert.equal((await db.query('select items from pending_order_completion_events')).rows[0].items[1].item_title,'Second item');
 await db.exec(`set test.actor='${id(200)}';update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where id='${id(602)}';
 set test.actor='${id(100)}'; update pending_order_completion_events set occurred_at='2026-10-13T15:00Z';`);
 const r=await report({worker:id(2),category:'closed_orders'});
 assert.equal(r.total,2);assert.equal(r.workers[0].metrics.pending_orders_closed,1);assert.equal(r.events[0].details.order_number,'09-15269-87504');
 const privileges=(await db.query("select has_table_privilege('authenticated','pending_order_completion_events','insert') writable,has_table_privilege('authenticated','pending_order_completion_events','select') readable")).rows[0];
 assert.deepEqual(privileges,{writable:false,readable:false});
});

test('multi-order updates record each finished order, excluding partial, unsigned, imported and cancelled-only work',async()=>{
 await db.exec(`insert into ebay_orders(id,order_number) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Order '||n from generate_series(700,704) n;
 insert into ebay_order_lines(id,order_id,quantity,fulfilled_quantity,line_status)
 select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('00000000-0000-4000-8000-'||lpad((700+(n-710)/2)::text,12,'0'))::uuid,2,0,'pending' from generate_series(710,719) n;
 set test.actor='${id(200)}';
 update ebay_order_lines set fulfilled_quantity=2,line_status='fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where order_id in('${id(700)}','${id(701)}');
 update ebay_order_lines set fulfilled_quantity=1,line_status='partially_fulfilled',fulfilled_by=auth.uid(),fulfilled_at=now() where order_id='${id(702)}';
 update ebay_order_lines set fulfilled_quantity=0,line_status='cancelled',fulfilled_by=auth.uid(),fulfilled_at=now() where order_id='${id(703)}';
 set test.actor='';update ebay_order_lines set fulfilled_quantity=2,line_status='fulfilled',fulfilled_by='${id(200)}',fulfilled_at=now() where order_id='${id(704)}';`);
 const rows=(await db.query('select order_id,items from pending_order_completion_events order by order_id')).rows;
 assert.deepEqual(rows.map(r=>r.order_id),[id(700),id(701)]);assert.ok(rows.every(r=>r.items.length===2));
});

test('historical backfill requires matching signed evidence and never invents an actor for imported completion',async()=>{
 await db.exec(`insert into ebay_orders(id,order_number) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Order '||n from generate_series(800,803) n;
 insert into ebay_order_lines(id,order_id,quantity,fulfilled_quantity,line_status,fulfilled_at,fulfilled_by)
 select ('00000000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,1,1,'fulfilled','2026-10-13T15:00Z','${id(200)}' from generate_series(800,803) n;
 insert into ebay_order_admin_events(id,action,signed_by,created_at,order_line_ids) values
 ('${id(820)}','fulfilled_no_inventory','${id(200)}','2026-10-13T15:00Z',array['${id(810)}','${id(811)}','${id(812)}']::uuid[]);
 update ebay_order_lines set fulfilled_quantity=0,line_status='pending' where id='${id(811)}';
 update ebay_order_lines set fulfilled_by=null where id='${id(812)}';`);
 const migration=await readFile(new URL('../supabase/migrations/20261013180000_work_report_closed_orders.sql',import.meta.url),'utf8');
 const backfill=migration.slice(migration.indexOf('-- Recover only'),migration.indexOf('create or replace view'));
 await db.exec(backfill);
 const rows=(await db.query('select order_id,actor_user_id,record_basis from pending_order_completion_events')).rows;
 assert.deepEqual(rows,[{order_id:id(800),actor_user_id:id(200),record_basis:'verified_historical_snapshot'}]);
});

test('admin-only RPC and private stream enforce permissions on the server',async()=>{
 const {rows:[p]}=await db.query("select has_table_privilege('authenticated','admin_work_event_stream','select') stream,has_function_privilege('anon','admin_employee_work_report(date,uuid,uuid,text,text,integer,integer,timestamptz)','execute') anonymous");
 assert.equal(p.stream,false);assert.equal(p.anonymous,false);
 await db.exec(`set test.actor='${id(200)}'`);await assert.rejects(report(),e=>e.code==='42501');
 await db.exec(`set test.actor='${id(100)}';update employees set active=false where id='${id(1)}'`);await assert.rejects(report(),e=>e.code==='42501');
 await db.exec("set test.actor=''");await assert.rejects(report(),e=>e.code==='42501');
});

test('attribution follows the signer, counts completions separately from closures and excludes automatic message sync',async()=>{
 await db.exec(`insert into team_tasks(id,title,assigned_to_user_id) values('${id(10)}','Include certificate','${id(300)}');
 insert into team_task_events(id,task_id,created_at,signed_by,action,old_status,new_status) values
 ('${id(11)}','${id(10)}','2026-10-13T14:00Z','${id(200)}','completed_by_employee','in_progress','completed_by_employee'),
 ('${id(12)}','${id(10)}','2026-10-13T15:00Z','${id(100)}','resolved','completed_by_employee','resolved'),
 ('${id(13)}','${id(10)}','2026-10-13T16:00Z','${id(200)}','commented','resolved','resolved'),
 ('${id(14)}','${id(10)}','2026-10-13T17:00Z','${id(200)}','completed_by_employee','resolved','completed_by_employee');
 insert into ebay_message_activity_events(id,created_at,actor_user_id,event_type,title,send_attempt_id) values
 ('${id(21)}','2026-10-13T14:01Z','${id(200)}','send_attempt_succeeded','Sent reply','${id(25)}'),
 ('${id(22)}','2026-10-13T14:02Z','${id(200)}','conversation_synced','Automated sync',null);
 insert into ebay_message_read_events(id,created_at,actor_user_id,is_read,actor_name) values
 ('${id(23)}','2026-10-13T14:03Z','${id(200)}',true,'Sandra');`);
 const all=await report(),worker=all.workers.find(w=>w.id===id(2)),admin=all.workers.find(w=>w.id===id(1));
 assert.equal(worker.metrics.tasks_completed,1);assert.equal(worker.metrics.tasks_closed,undefined);assert.equal(worker.metrics.replies_sent,1);
 assert.equal(admin.metrics.tasks_closed,1);assert.equal(all.workers.find(w=>w.id===id(3)).records,0);
 const detail=await report({worker:id(2)});assert.equal(detail.total,5);assert.ok(detail.events.every(e=>e.actor_user_id===id(200)));
 assert.equal(detail.events.find(e=>e.source==='team_task_events').details.task_source,'team');
});

test('inventory quantities and administrative package closeouts never inflate physical packing totals',async()=>{
 await db.exec(`insert into inventory_change_log(id,worker_id,changed_at,action,table_name,item_title) values
 ('${id(31)}','${id(200)}','2026-10-13T15:00Z','insert','item_types','Chain'),
 ('${id(32)}','${id(200)}','2026-10-13T15:00Z','insert','item_stock_locations','Chain');
 insert into stock_transactions(id,user_id,confirmed_at,action_type,quantity) values
 ('${id(33)}','${id(200)}','2026-10-13T15:00Z','checkin',4),
 ('${id(34)}','${id(200)}','2026-10-13T15:01Z','correction',-1);
 insert into packaging_events(id,shipment_id,created_by,created_at,action) values
 ('${id(35)}','${id(90)}','${id(200)}','2026-10-13T15:00Z','admin_closeout'),
 ('${id(36)}','${id(91)}','${id(200)}','2026-10-13T15:00Z','prior_dispatch_closeout'),
 ('${id(37)}','${id(92)}','${id(200)}','2026-10-13T15:00Z','pack'),
 ('${id(38)}','${id(92)}','${id(200)}','2026-10-13T16:00Z','pack'),
 ('${id(39)}','${id(92)}','${id(200)}','2026-10-13T17:00Z','dispatch');`);
 const r=await report({worker:id(2)}),m=r.workers[0].metrics;
 assert.equal(m.items_created,1);assert.equal(m.units_checked_in,4);assert.equal(m.admin_closeouts,2);assert.equal(m.packages_packed,1);assert.equal(m.packages_dispatched,1);
 assert.equal(r.total,9);
});

test('day boundaries, overnight shifts, exact clock-out and clipped breaks are handled in New York time',async()=>{
 await db.exec(`insert into time_entries(id,employee_id,clock_in,clock_out) values('${id(40)}','${id(2)}','2026-10-13T02:00Z','2026-10-13T06:00Z');
 insert into time_breaks(id,time_entry_id,started_at,ended_at) values('${id(41)}','${id(40)}','2026-10-13T03:50Z','2026-10-13T04:20Z');
 insert into team_task_events(id,signed_by,created_at,action) values
 ('${id(42)}','${id(200)}','2026-10-13T03:00Z','commented'),
 ('${id(43)}','${id(200)}','2026-10-13T04:00Z','commented'),
 ('${id(44)}','${id(200)}','2026-10-14T04:00Z','commented');`);
 const daily=await report({worker:id(2)});assert.equal(daily.workers[0].clocked_seconds,7200);assert.equal(daily.workers[0].break_seconds,1200);
 assert.ok(daily.events.some(e=>e.entity_id===id(43)));assert.ok(!daily.events.some(e=>e.entity_id===id(42)||e.entity_id===id(44)));
 const shift=await report({worker:id(2),shift:id(40)});assert.equal(shift.workers[0].clocked_seconds,14400);assert.equal(shift.workers[0].break_seconds,1800);
 assert.ok(shift.events.some(e=>e.source==='clock_out'));assert.ok(shift.events.some(e=>e.entity_id===id(42)));
 await assert.rejects(report({worker:id(3),shift:id(40)}),e=>e.code==='22023');
 const spring=await report({day:'2026-03-08'}),fall=await report({day:'2025-11-02'});
 assert.equal((Date.parse(spring.end_at)-Date.parse(spring.start_at))/3600000,23);
 assert.equal((Date.parse(fall.end_at)-Date.parse(fall.start_at))/3600000,25);
});

test('open shift uses the requested snapshot, and records outside a shift remain visible in the whole day',async()=>{
 await db.exec(`insert into time_entries(id,employee_id,clock_in) values('${id(50)}','${id(2)}','2026-10-13T10:00Z');
 insert into team_task_events(id,signed_by,created_at,action) values
 ('${id(51)}','${id(200)}','2026-10-13T09:00Z','commented'),
 ('${id(52)}','${id(200)}','2026-10-13T11:00Z','commented'),
 ('${id(53)}','${id(200)}','2026-10-13T13:00Z','commented');`);
 const shift=await report({worker:id(2),shift:id(50),asOf:'2026-10-13T12:00Z'});
 assert.equal(shift.workers[0].clocked_seconds,7200);assert.equal(Date.parse(shift.end_at),Date.parse('2026-10-13T12:00:00Z'));
 assert.equal(shift.events.filter(e=>e.category==='tasks').length,1);
 const daily=await report({worker:id(2),asOf:'2026-10-13T12:00Z'});assert.equal(daily.events.filter(e=>e.category==='tasks').length,2);
});

test('full totals exceed 1000 rows, pages with identical timestamps stay stable, filtering does not alter summaries',async()=>{
 await db.exec(`insert into stock_transactions(id,user_id,confirmed_at,action_type,quantity,notes)
 select gen_random_uuid(),'${id(200)}','2026-10-13T15:00Z','checkin',2,case when n%2=0 then 'Gold chain' else 'Silver ring' end from generate_series(1,1101) n;`);
 const a=await report({worker:id(2)}),b=await report({worker:id(2),offset:50});
 assert.equal(a.total,1101);assert.equal(a.workers[0].metrics.units_checked_in,2202);assert.equal(a.events.length,50);
 assert.equal(new Set([...a.events,...b.events].map(e=>e.event_key)).size,100);
 const search=await report({worker:id(2),search:'Gold chain',category:'stock'});assert.equal(search.total,550);assert.equal(search.workers[0].metrics.units_checked_in,2202);
 const empty=await report({worker:id(2),category:'packaging'});assert.equal(empty.total,0);assert.equal(empty.workers[0].records,1101);
 await assert.rejects(report({limit:201}),e=>e.code==='22023');await assert.rejects(report({offset:-1}),e=>e.code==='22023');
});
