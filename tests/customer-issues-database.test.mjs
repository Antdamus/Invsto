import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sqlFile=n=>readFile(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${id(1)}'),('${id(2)}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"operator@example.test"}'::jsonb$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create function can_access_post_order_issues() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create function is_admin() returns boolean language sql stable as $$select current_setting('test.admin',true)='yes'$$;
 create table employees(id uuid primary key,user_id uuid,email text,display_name text,role text,active boolean);
 insert into employees values('${id(1)}','${id(1)}','operator@example.test','Operator','worker',true),('${id(2)}','${id(2)}','review@example.test','Reviewer','admin',true);
 create table item_types(id uuid primary key);insert into item_types values('${id(20)}');
 create table locations(id uuid primary key,active boolean,location_name text,location_code text);insert into locations values('${id(30)}',true,'Return tray','LOC-30');
 create table item_stock_locations(id uuid primary key default gen_random_uuid(),item_id uuid,location_id uuid,quantity int,condition_status text default 'good',batch_id uuid,
 added_by uuid,confirmation_email text,confirmation_method text,confirmed_at timestamptz,last_updated timestamptz,locked_by uuid,locked_at timestamptz);
 create table stock_transactions(id uuid primary key default gen_random_uuid(),item_id uuid,location_id uuid,quantity int,action_type text,confirmed_at timestamptz,user_id uuid,email text,notes text,source_transaction_id uuid,method text,timestamp timestamptz);
 create table metadata(id text primary key,inventory_version text,changed_item_ids text[],updated_at timestamptz);insert into metadata(id) values('inventory');
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,status text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,item_title text,quantity int,fulfilled_quantity int,line_status text,internal_item_id uuid,stock_location_row_id uuid,location_id uuid,stock_transaction_id uuid);
 create function task_workflow_reviewer(t jsonb) returns uuid language sql stable as $$select '${id(2)}'::uuid$$;
 revoke all on function task_workflow_reviewer(jsonb) from public,anon,authenticated;
 grant usage on schema auth to authenticated;
 select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);select set_config('test.admin','yes',false);`);
 const original=await sqlFile('20260521123000_ebay_returns_workflow.sql');await db.exec(original.slice(original.indexOf('create table if not exists public.ebay_return_cases')));
 await db.exec(await sqlFile('20260521164500_ebay_return_task_queue.sql'));
 await db.exec(`alter table ebay_return_cases add column case_type text default 'matched_order';alter table ebay_return_cases alter column order_id drop not null;alter table ebay_return_cases alter column order_number drop not null;
 alter table ebay_return_tasks drop constraint ebay_return_tasks_status_check;alter table ebay_return_tasks add column latest_note text;
 grant select on employees,ebay_orders,ebay_order_lines to authenticated;`);
 await db.exec(await sqlFile('20261009040000_customer_issues_workspace.sql'));
 await db.exec(await sqlFile('20261009041000_customer_return_safety.sql'));
 await db.exec(await sqlFile('20261009044000_customer_issue_reviewer_access.sql'));
});
after(async()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);select set_config('test.admin','yes',false);
 truncate customer_return_receipts,ebay_return_task_events,ebay_return_tasks,ebay_return_events,ebay_return_items,ebay_return_cases,stock_transactions,item_stock_locations,ebay_order_lines,ebay_orders cascade;
 insert into ebay_orders values('${id(10)}','01-12345-12345','buyer.one','fulfilled');
 insert into ebay_order_lines values('${id(11)}','${id(10)}','287000000001','Watch',2,2,'fulfilled','${id(20)}',null,null,null);
 insert into ebay_return_cases(id,order_id,order_number,ebay_return_id,status,source_lane,issue_kind,ebay_status,synced_at,ebay_due_at)
 values('${id(100)}','${id(10)}','01-12345-12345','12345','open','return','return','OPEN',now(),'2026-10-15T18:00:00Z');
 insert into ebay_return_items(return_case_id,order_id,order_line_id,internal_item_id,item_title,expected_quantity)
 values('${id(100)}','${id(10)}','${id(11)}','${id(20)}','Watch',2);`);
});
const receive=(key=200,qty=1,disposition='restock',caseId=100)=>scalar('select receive_customer_return($1,$2,$3,$4,$5,$6) v',[
 id(key),id(caseId),JSON.stringify([{order_line_id:id(11),received_quantity:qty,condition_received:'used_good',disposition,destination_location_id:disposition==='restock'?id(30):null,notes:'Inspected'}]),
 '[{"bucket":"ebay-return-evidence","path":"test/photo.jpg"}]','Received carefully','TRACK1']);
const stock=()=>scalar('select coalesce(sum(quantity),0)::int v from item_stock_locations');
test('imported placeholders receive partial parcels safely, retries return the same receipt, cumulative quantity is enforced',async()=>{
 const first=await receive();assert.equal(first.restocked_units,1);assert.equal(await stock(),1);
 assert.deepEqual(await receive(),first);assert.equal(await stock(),1);
 await assert.rejects(receive(200,2),/different return details/);assert.equal(await stock(),1);
 assert.equal((await receive(201)).restocked_units,1);assert.equal(await stock(),2);
 await assert.rejects(receive(202),/more than was shipped/);assert.equal(await stock(),2);
 assert.equal(await scalar('select count(*)::int v from ebay_return_items'),1);
 assert.equal(await scalar('select status v from ebay_return_cases where id=$1',[id(100)]),'received');
});
test('a second case cannot receive the same shipped units again',async()=>{
 await receive(200,2);await db.exec(`insert into ebay_return_cases(id,order_id,order_number,status) values('${id(101)}','${id(10)}','01-12345-12345','open')`);
 await assert.rejects(receive(201,1,'restock',101),/more than was shipped/);assert.equal(await stock(),2);
});
test('quarantine preserves inventory and requires explicit inspection; repeated inspection cannot restock twice',async()=>{
 await receive(200,2,'quarantine');assert.equal(await stock(),0);
 assert.equal(await scalar('select status v from ebay_return_cases where id=$1',[id(100)]),'needs_review');
 const item=await scalar('select id v from ebay_return_items');
 const inspect=key=>scalar('select inspect_customer_return($1,$2,$3,$4,$5) v',[id(key),item,'restock',id(30),'Checked serial and condition; sellable']);
 assert.equal((await inspect(210)).restocked_units,2);assert.equal(await stock(),2);
 await inspect(210);assert.equal(await stock(),2);await assert.rejects(inspect(211),/already restocked/);
});
test('denied users and legacy cached clients cannot change returned inventory',async()=>{
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(receive(),/access required/);assert.equal(await stock(),0);
 assert.equal(await scalar("select has_function_privilege('authenticated','receive_ebay_return(jsonb,text,text,text,text,jsonb,text)','execute') v"),false);
 assert.equal(await scalar("select has_function_privilege('anon','claim_customer_issue_worker(uuid)','execute') v"),false);
});
test('new task statuses stay visible, provider deadlines remain separate and pages are bounded',async()=>{
 await db.exec(`insert into ebay_return_tasks(return_case_id,order_id,title,task_type,status,assigned_to_user_id,due_at)
 values('${id(100)}','${id(10)}','Review','return_review','completed_by_employee','${id(1)}','2026-10-20T19:00:00Z');
 insert into ebay_return_cases(order_id,order_number,status,source_lane,issue_kind) select '${id(10)}','01-12345-12345','open','inquiry','request' from generate_series(1,520);`);
 await db.exec('set role authenticated');
 const result=await scalar("select list_customer_issues('return','all','',0,30) v");assert.equal(result.total,1);assert.equal(result.rows[0].open_tasks,1);
 assert.equal(result.rows[0].next_user,id(2));assert.notEqual(result.rows[0].ebay_due_at,result.rows[0].follow_up_at);
 const page=await scalar("select list_customer_issues('request','all','',510,30) v");assert.equal(page.total,520);assert.equal(page.rows.length,10);
 await db.exec("select set_config('test.access','no',false)");assert.equal((await scalar("select list_customer_issues() v")).rows.length,0);
});
test('provider closure does not bypass open tasks or missing physical items',async()=>{
 await db.exec(`update ebay_return_cases set ebay_status='CLOSED' where id='${id(100)}'`);
 await assert.rejects(scalar('select finish_customer_issue($1,$2) v',[id(100),'Done']),/inspection or reconciliation/);
 await receive(200,2);await scalar('select finish_customer_issue($1,$2) v',[id(100),'All received, inspected and reconciled']);
 await assert.rejects(receive(201),/already finished/);assert.equal(await stock(),2);
});
test('manual matching rejects wrong-order items and preserves received stock',async()=>{
 const stamp=await scalar('select updated_at v from ebay_return_cases where id=$1',[id(100)]);
 await assert.rejects(scalar('select link_customer_issue_order($1,$2,$3,$4,$5) v',[id(100),id(10),[id(999)],'Verified',stamp]),/belong/);
 await receive();const now=await scalar('select updated_at v from ebay_return_cases where id=$1',[id(100)]);
 await assert.rejects(scalar('select link_customer_issue_order($1,$2,$3,$4,$5) v',[id(100),id(10),[id(11)],'Verified',now]),/already received/);
});

test('manual intake reuses one exact active case and rejects ambiguous cases',async()=>{
 assert.equal(await scalar('select prepare_customer_return($1,null,$2) v',[[id(11)],'Received parcel']),id(100));
 await db.exec(`insert into ebay_return_cases(id,order_id,order_number,status) values('${id(101)}','${id(10)}','01-12345-12345','open')`);
 await assert.rejects(scalar('select prepare_customer_return($1,null,null) v',[[id(11)]]),/Several return cases/);
 assert.equal(await scalar('select prepare_customer_return($1,$2,null) v',[[id(11)],'12345']),id(100));
});

test('stale eBay closure cannot finish a case and a no-return outcome requires an administrator',async()=>{
 await db.exec(`update ebay_return_cases set ebay_status='CLOSED',synced_at=now()-interval '2 hours'`);
 await assert.rejects(scalar('select finish_customer_issue($1,$2) v',[id(100),'Done']),/Refresh/);
 await db.exec("select set_config('test.admin','no',false)");
 await assert.rejects(receive(230,0,'refund_only'),/administrator/);
 await db.exec("select set_config('test.admin','yes',false)");
 await receive(230,0,'refund_only');assert.equal(await stock(),0);
 await db.exec('update ebay_return_cases set synced_at=now()');
 await scalar('select finish_customer_issue($1,$2) v',[id(100),'eBay refund-only outcome verified; no physical return expected']);
 assert.equal(await scalar('select status v from ebay_return_cases'),'closed');
});

test('a bad second item rolls the entire receipt back',async()=>{
 const entries=[{order_line_id:id(11),received_quantity:1,condition_received:'used_good',disposition:'restock',destination_location_id:id(30)},
 {order_line_id:id(999),received_quantity:1,condition_received:'used_good',disposition:'restock',destination_location_id:id(30)}];
 await assert.rejects(scalar('select receive_customer_return($1,$2,$3,$4,null,null) v',[id(240),id(100),JSON.stringify(entries),'[{"path":"photo.jpg"}]']),/belonging/);
 assert.equal(await stock(),0);assert.equal(await scalar('select count(*)::int v from customer_return_receipts'),0);
});
