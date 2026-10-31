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
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,buyer_name text,raw_payload jsonb default '{}',status text,tracking_number text,label_metadata jsonb,sale_date timestamptz);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,item_title text,quantity int,fulfilled_quantity int,line_status text,internal_item_id uuid,stock_location_row_id uuid,location_id uuid,stock_transaction_id uuid,transaction_id text,sold_for numeric,total_price numeric,raw_payload jsonb default '{}');
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
 await db.exec(`create table task_followers(source text,task_id uuid,user_id uuid,primary key(source,task_id,user_id));grant select on task_followers to authenticated;
 create function notify_ebay_return_task_assignment() returns trigger language plpgsql as $$begin return new;end $$;
 create trigger trg_notify_ebay_return_task_assignment after insert or update on ebay_return_tasks for each row execute function notify_ebay_return_task_assignment();
 create table task_notifications(id uuid default gen_random_uuid(),recipient_user_id uuid,source text,task_id uuid,notification_type text constraint task_notifications_notification_type_check check(notification_type<>'invalid'),title text,body text,metadata jsonb,read_at timestamptz,created_at timestamptz default now());
 create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language plpgsql as $$declare n uuid:=gen_random_uuid();begin insert into public.task_notifications(id,recipient_user_id,source,task_id,notification_type,title,body,metadata) values(n,$1,$3,$4,$6,$7,$8,$11);return n;end $$;`);
 await db.exec(await sqlFile('20261009050000_customer_issue_action_cycles.sql'));
 await db.exec(await sqlFile('20261009051000_customer_issue_health_queue.sql'));
 await db.exec(`alter table ebay_return_task_events add column photo_attachments jsonb default '[]';
 create function packaging_detail(uuid,uuid[]) returns jsonb language sql as $$select '{"orders":[],"lines":[],"bag_photos":[],"completion_events":[]}'::jsonb$$;
 create table packaging_shipments(id uuid,order_ids uuid[],tracking_code text,status text,updated_at timestamptz);
 create table packaging_evidence(shipment_id uuid,bucket text,path text,mime_type text,media_type text,label text,created_at timestamptz,removed_at timestamptz);
 create table ebay_order_line_certificates(order_line_id uuid,certificate_url text,report_number text,watch_serial text,attachments jsonb,voided_at timestamptz);
 create table ebay_return_messages(return_case_id uuid,direction text,message_body text,sent_at timestamptz,message_status text);
 create table ebay_conversations(id uuid,other_party_username text,conversation_type text,reference_id text);
 create table ebay_conversation_messages(id uuid,conversation_id uuid,sender_username text,direction text,message_body text,created_at_ebay timestamptz);`);
 await db.exec(await sqlFile('20261009052000_customer_issue_evidence.sql'));
 await db.exec(await sqlFile('20261009045000_customer_issue_refresh_priority.sql'));
 await db.exec(await sqlFile('20261009054000_customer_issue_sync_priority.sql'));
 await db.exec(await sqlFile('20261009055000_customer_issue_sync_alerts.sql'));
 await db.exec(await sqlFile('20261009057000_customer_issue_order_links.sql'));
 await db.exec(await sqlFile('20261009058000_customer_issue_evidence_links.sql'));
 const packaging=await sqlFile('20261008020000_packaging_workspace.sql');
 await db.exec(packaging.slice(packaging.indexOf('create function public.packaging_normalize_tracking'),packaging.indexOf('create index packaging_orders_tracking_idx')));
 await db.exec(`create table ebay_order_label_events(order_ids uuid[],action text,label_metadata jsonb);`);
 await db.exec(await sqlFile('20261009059000_return_receiving_workflow.sql'));
 await db.exec(await sqlFile('20261009062000_return_barcode_no_restock.sql'));
 await db.exec(await sqlFile('20261009065000_customer_issue_card_sorting.sql'));
 await db.exec(await sqlFile('20261009066000_customer_issue_direct_close.sql'));
 await db.exec(await sqlFile('20261009067000_customer_issue_saved_conversation.sql'));
 await db.exec(await sqlFile('20261010010000_customer_issue_notes.sql'));
 await db.exec(await sqlFile('20261010020000_customer_issue_response_badges.sql'));
 await db.exec(await sqlFile('20261010030000_customer_issue_customer_cards.sql'));
 await db.exec(await sqlFile('20261010040000_customer_issue_return_stages.sql'));
 await db.exec(await sqlFile('20261010050000_customer_issue_closed_outcomes.sql'));
 await db.exec(await sqlFile('20261010060000_customer_issue_escalated_badges.sql'));
 await db.exec(await sqlFile('20261010070000_customer_issue_task_notes.sql'));
 await db.exec(await sqlFile('20261010080000_customer_issue_refund_badges.sql'));
 await db.exec(await sqlFile('20261010090000_customer_issue_refund_dates.sql'));
 await db.exec(await sqlFile('20261010100000_customer_issue_staff_task_notes.sql'));
 await db.exec(await sqlFile('20261010110000_customer_issue_employee_tasks.sql'));
 await db.exec(await sqlFile('20261010111000_customer_issue_employee_task_reads.sql'));
 // The production editor can preserve SQL as a single line. Migration guards
 // must accept equivalent whitespace without depending on formatting.
 const liveDefinition=await scalar("select pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text)'::regprocedure) v");
 await db.exec(liveDefinition.replace(/\s+/g,' '));
 await db.exec(await sqlFile('20261010193000_customer_issue_review_navigation.sql'));
 await db.exec(await sqlFile('20261012203000_customer_issue_dispute_filters.sql'));
 await db.exec(await sqlFile('20261013100000_customer_issue_return_stage_counts.sql'));
 await db.exec(await sqlFile('20261014110000_customer_return_final_review.sql'));
 await db.exec(await sqlFile('20261031040000_customer_issue_finalized_history.sql'));
 await db.exec(await sqlFile('20261031050000_customer_issue_history_button.sql'));


});
after(async()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);select set_config('test.admin','yes',false);
 truncate ebay_return_cases,ebay_order_lines,ebay_orders cascade;
 insert into ebay_orders(id) values('${id(10)}');insert into ebay_order_lines(id,order_id) values('${id(11)}','${id(10)}');
 insert into ebay_return_cases(id,source_lane,issue_kind,ebay_return_id,status,ebay_status,synced_at,raw_payload)
 values('${id(100)}','payment_dispute','dispute','D100','open','CLOSED',now(),'{"ebayDetail":{"paymentDisputeId":"D100","resolution":{"reasonForClosure":"SELLER_WON"}}}');`);
});
const preview=()=>scalar('select customer_issue_history_preview() v');
const archive=()=>scalar('select archive_finalized_customer_issues($1) v',[[id(100)]]);
const status=()=>scalar('select status v from ebay_return_cases where id=$1',[id(100)]);
const manualPlan=async()=> (await preview()).checks[id(100)].manual;
const manualArchive=async(accept=false,expected)=>scalar('select send_customer_issue_to_history($1,$2,$3) v',[id(100),JSON.stringify(expected||(await manualPlan()).cases),accept]);
async function monitor(extra=''){
 await db.exec(`insert into ebay_return_tasks(id,return_case_id,task_type,title,status,metadata)
 values('${id(200)}','${id(100)}','return_review','Check eBay','open','{"source":"ebay_return_api"}');${extra}`);
}
test('fully won case archives once, retires only its untouched monitor and preserves audit evidence',async()=>{
 await monitor();assert.equal((await preview()).ready,1);
 const result=await archive();assert.equal(result.archived,1);assert.equal(await status(),'closed');
 assert.equal(await scalar('select status v from ebay_return_tasks where id=$1',[id(200)]),'cancelled');
 assert.equal((await archive()).archived,0);
 assert.equal(await scalar("select count(*)::int v from ebay_return_events where payload->>'source'='customer_issue_finalized_history'"),1);
 const history=await scalar("select list_customer_issues('history','all','',0,30,'newest','all') v");assert.equal(history.total,1);
 assert.equal((await preview()).ready,0);
});
test('seller lost stays active even with full protection and paid reimbursement',async()=>{
 await db.exec(`update ebay_return_cases set raw_payload='{"ebayDetail":{"paymentDisputeId":"D100","resolution":{"reasonForClosure":"SELLER_LOST","protectionStatus":"FULLY_PROTECTED"}}}'`);
 assert.equal((await preview()).against_us,1);assert.equal((await archive()).archived,0);assert.equal(await status(),'open');
});
test('human follow-ups, employee completions awaiting review, deadlines and signed notes remain active',async()=>{
 await monitor();
 for(const change of ["assigned_to_user_id='"+id(1)+"'","status='completed_by_employee'","due_at=now()","latest_note='Needs further review'"]){
  await db.exec(`update ebay_return_tasks set assigned_to_user_id=null,status='open',due_at=null,latest_note=null;update ebay_return_tasks set ${change};`);
  assert.equal((await preview()).ready,0,change);assert.equal((await archive()).archived,0);
 }
 await db.exec(`update ebay_return_tasks set latest_note=null;insert into ebay_return_task_events(task_id,return_case_id,action,signed_by,notes) values('${id(200)}','${id(100)}','commented','${id(1)}','Still checking');`);
 assert.equal((await preview()).ready,0);
});
test('unknown, mismatched, open and pending appeal outcomes cannot archive',async()=>{
 for(const [s,raw] of [['CLOSED',{ebayDetail:{paymentDisputeId:'different',resolution:{reasonForClosure:'SELLER_WON'}}}],['CLOSED',{}],['OPEN',{ebayDetail:{paymentDisputeId:'D100',resolution:{reasonForClosure:'SELLER_WON'}}}],['CLOSED',{ebayDetail:{paymentDisputeId:'D100',resolution:{reasonForClosure:'SELLER_WON'},appealDetails:{appealStatus:'PENDING'}}}]]){
  await db.query('update ebay_return_cases set ebay_status=$1,raw_payload=$2',[s,JSON.stringify(raw)]);
  assert.equal((await archive()).archived,0);
 }
});
test('final review, stale sync and sync errors block the bulk action',async()=>{
 await db.exec(`insert into customer_return_reviews(return_case_id,status,reviewer_id,submitted_by,submission_note) values('${id(100)}','pending','${id(2)}','${id(1)}','Please review')`);
 assert.equal((await archive()).archived,0);
 await db.exec(`delete from customer_return_reviews;alter table ebay_return_cases disable trigger customer_issue_after_sync;update ebay_return_cases set synced_at=now()-interval '2 days';alter table ebay_return_cases enable trigger customer_issue_after_sync;`);
 assert.equal((await archive()).archived,0);
 await db.exec(`update ebay_return_cases set sync_error='Could not refresh'`);assert.equal((await archive()).archived,0);
});
test('returned packages require receipt and inspection; pending refunds and escalations are not final',async()=>{
 const raw={ebayReturnId:'D100',physicalReturnExpected:true,ebayDetail:{closeInfo:{returnCloseReason:'FULL_REFUNDED'}}};
 await db.query("update ebay_return_cases set source_lane='return',issue_kind='return',raw_payload=$1",[JSON.stringify(raw)]);
 await db.exec(`insert into ebay_return_items(return_case_id,order_id,order_line_id,item_title,expected_quantity,received_quantity,disposition) values('${id(100)}','${id(10)}','${id(11)}','Watch',1,0,'quarantine')`);
 assert.equal((await preview()).ready,0);
 await db.exec('update ebay_return_items set received_quantity=1');assert.equal((await archive()).archived,0);
 await db.exec("update ebay_return_items set disposition='received_no_restock'");assert.equal((await preview()).ready,1);
 raw.ebayDetail.refundInfo={actualRefundDetail:{refundStatus:'PENDING'}};
 await db.query('update ebay_return_cases set raw_payload=$1',[JSON.stringify(raw)]);assert.equal((await archive()).archived,0);
 delete raw.ebayDetail.refundInfo;raw.ebayDetail.closeInfo.returnCloseReason='ESCALATED';
 await db.query('update ebay_return_cases set raw_payload=$1',[JSON.stringify(raw)]);assert.equal((await archive()).archived,0);
});
test('buyer-closed inquiry can finish, but its escalated case loss blocks it',async()=>{
 await db.query("update ebay_return_cases set source_lane='inquiry',issue_kind='request',raw_payload=$1",[JSON.stringify({ebayDetail:{inquiryId:'D100',state:'CLOSED'}})]);
 assert.equal((await preview()).ready,1);
 await db.exec(`insert into ebay_return_cases(source_lane,issue_kind,ebay_return_id,status,ebay_status,synced_at,raw_payload) values('case','dispute','D100','open','CLOSED',now(),'{"ebayDetail":{"caseId":"D100","sellerOutcome":"LOSE"}}')`);
 assert.equal((await archive()).archived,0);
});
test('a successful sync archives eligible work and restores visibility when outcome changes',async()=>{
 await db.exec('update ebay_return_cases set synced_at=now()');assert.equal(await status(),'closed');
 await db.exec(`update ebay_return_cases set raw_payload='{"ebayDetail":{"paymentDisputeId":"D100","resolution":{"reasonForClosure":"SELLER_LOST"}}}',synced_at=now()`);
 assert.equal(await status(),'open');assert.equal((await preview()).against_us,1);
});
test('new closed imports with unfinished outcomes become active; old history is preserved',async()=>{
 await db.exec(`update ebay_return_cases set status='closed',raw_payload='{}',synced_at=now()`);assert.equal(await status(),'open');
 await db.exec(`update ebay_return_cases set history_managed=false,status='closed',raw_payload='{}',synced_at=now()`);assert.equal(await status(),'closed');
});
test('preview is not authority: new work added before clicking prevents archive',async()=>{
 assert.equal((await preview()).ready,1);await monitor("update ebay_return_tasks set assigned_to_user_id='"+id(1)+"';");
 assert.equal((await archive()).archived,0);assert.equal(await status(),'open');
});
test('older manual close APIs cannot bypass unfinished-work and adverse-outcome guards',async()=>{
 await monitor("update ebay_return_tasks set assigned_to_user_id='"+id(1)+"';");
 const version=await scalar('select updated_at v from ebay_return_cases where id=$1',[id(100)]);
 await assert.rejects(scalar('select close_resolved_customer_issue($1,$2,$3,true,null) v',[id(100),version,'[]']),/Internal work is unfinished/);
 await db.exec(`update ebay_return_cases set raw_payload='{"ebayDetail":{"paymentDisputeId":"D100","resolution":{"reasonForClosure":"SELLER_LOST"}}}'`);
 await assert.rejects(scalar('select finish_customer_issue($1,$2) v',[id(100),'No more work']),/Decided against us/);
});
test('only administrators can use bulk preview/archive; internal helpers are not callable',async()=>{
 await db.exec("select set_config('test.admin','no',false);set role authenticated");
 await assert.rejects(preview(),/Administrator/);await assert.rejects(archive(),/Administrator/);
 await assert.rejects(scalar('select send_customer_issue_to_history($1,$2,true) v',[id(100),'[]']),/Administrator/);
 await assert.rejects(scalar('select archive_finalized_customer_issue_internal($1,true) v',[id(100)]),/permission denied/);
});
test('a decision against us can be explicitly accepted as fair without automatic bulk archiving',async()=>{
 await monitor();await db.exec(`update ebay_return_cases set raw_payload='{"ebayDetail":{"paymentDisputeId":"D100","resolution":{"reasonForClosure":"SELLER_LOST"}}}'`);
 assert.equal((await preview()).ready,0);assert.equal((await manualPlan()).allowed,true);assert.equal((await manualPlan()).accept_decision,true);
 await assert.rejects(manualArchive(false),/Review and accept/);assert.equal(await status(),'open');
 assert.equal((await manualArchive(true)).archived,1);assert.equal(await status(),'closed');
 assert.equal(await scalar("select payload->>'decision_accepted_as_fair' v from ebay_return_events where payload->>'source'='customer_issue_manual_history'"),'true');
 await db.exec('update ebay_return_cases set synced_at=now()');assert.equal(await status(),'closed','unchanged lost outcome stays in History after explicit acceptance');
});
test('one click archives the entire linked issue; an unrelated issue on the same order remains active',async()=>{
 await db.exec(`update ebay_return_cases set source_lane='inquiry',issue_kind='request',raw_payload='{"ebayDetail":{"inquiryId":"D100","state":"CLOSED","inquiryDetails":{"escalationDate":{"value":"2026-10-29"}}}}';
 insert into ebay_return_cases(id,source_lane,issue_kind,ebay_return_id,status,ebay_status,synced_at,raw_payload) values
 ('${id(101)}','case','dispute','D100','open','CLOSED',now(),'{"ebayDetail":{"caseId":"D100","sellerOutcome":"LOSE"}}'),
 ('${id(102)}','case','dispute','OTHER','open','CLOSED',now(),'{"ebayDetail":{"caseId":"OTHER","sellerOutcome":"LOSE"}}');`);
 await db.exec(`update ebay_return_cases set order_id='${id(10)}'`);
 const plan=await manualPlan();assert.equal(plan.case_count,2);assert.equal(plan.accept_decision,true);assert.equal(plan.allowed,true);
 assert.equal((await manualArchive(true)).archived,2);assert.equal(await status(),'closed');
 assert.equal(await scalar('select status v from ebay_return_cases where id=$1',[id(101)]),'closed');
 assert.equal(await scalar('select status v from ebay_return_cases where id=$1',[id(102)]),'open');
 await db.exec('update ebay_return_cases set synced_at=now()');assert.equal(await status(),'closed');
});
test('new information returns an archived closed case and remains visible until reviewed again',async()=>{
 await manualArchive();await db.exec("update ebay_return_cases set raw_payload=raw_payload||'{\"syncedAt\":\"poll time changed\"}',synced_at=now()");
 assert.equal(await status(),'closed','poll time alone is not new activity');
 await db.exec(`update ebay_return_cases set raw_payload=jsonb_set(raw_payload,'{ebayDetail,note}','"New evidence received"'),synced_at=now()`);
 assert.equal(await status(),'open');assert.equal((await preview()).checks[id(100)].update_pending,true);
 await db.exec('update ebay_return_cases set synced_at=now()');assert.equal(await status(),'open','automatic cleanup must not hide the new update');
 await manualArchive();assert.equal(await status(),'closed');assert.equal(await scalar('select history_update_pending v from ebay_return_cases where id=$1',[id(100)]),false);
});
test('new case message returns the record immediately; historical message imports do not',async()=>{
 await manualArchive();await db.exec(`insert into ebay_return_messages(return_case_id,direction,message_body,sent_at) values('${id(100)}','inbound','Old message',now()-interval '1 day')`);
 assert.equal(await status(),'closed');
 await db.exec(`insert into ebay_return_messages(return_case_id,direction,message_body,sent_at) values('${id(100)}','inbound','New buyer update',now()+interval '1 second')`);
 assert.equal(await status(),'open');assert.equal(await scalar('select history_update_pending v from ebay_return_cases where id=$1',[id(100)]),true);
});
test('manual acceptance cannot discard employee work or a changed family snapshot',async()=>{
 const plan=await manualPlan();await monitor("update ebay_return_tasks set assigned_to_user_id='"+id(1)+"';");
 await assert.rejects(manualArchive(true,plan.cases),/Internal work is unfinished/);
 await db.exec("update ebay_return_tasks set assigned_to_user_id=null;update ebay_return_cases set item_title='Changed since preview'");
 await assert.rejects(manualArchive(true,plan.cases),/This issue changed/);assert.equal(await status(),'open');
});
