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
 create table task_notifications(id uuid default gen_random_uuid(),recipient_user_id uuid,source text,task_id uuid,notification_type text constraint task_notifications_notification_type_check check(notification_type<>'invalid'),title text,body text,metadata jsonb);
 create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language plpgsql as $$declare n uuid:=gen_random_uuid();begin insert into public.task_notifications values(n,$1,$3,$4,$6,$7,$8,$11);return n;end $$;`);
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

});
after(async()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);select set_config('test.admin','yes',false);
 truncate ebay_return_messages,ebay_conversation_messages,ebay_conversations,customer_issue_sync_alert_recipients,customer_issue_sync_incidents,ebay_issue_sync_jobs,customer_return_receipts,ebay_return_task_events,ebay_return_tasks,ebay_return_events,ebay_return_items,ebay_return_cases,stock_transactions,item_stock_locations,ebay_order_lines,ebay_orders,task_notifications,task_followers cascade;
 update ebay_issue_worker set monitoring_started_at=now(),last_run_finished_at=now(),last_manual_retry_at=null;
 update ebay_issue_sync_lanes set status='ok',error_count=0,error=null,last_progress_at=now();
 insert into ebay_orders(id,order_number,buyer_username,status) values('${id(10)}','01-12345-12345','buyer.one','fulfilled');
 insert into ebay_order_lines(id,order_id,item_number,item_title,quantity,fulfilled_quantity,line_status,internal_item_id,stock_location_row_id,location_id,stock_transaction_id,transaction_id) values('${id(11)}','${id(10)}','287000000001','Watch',2,2,'fulfilled','${id(20)}',null,null,null,'local-tx');
 insert into ebay_return_cases(id,order_id,order_number,ebay_return_id,status,source_lane,issue_kind,ebay_status,synced_at,ebay_due_at)
 values('${id(100)}','${id(10)}','01-12345-12345','12345','open','return','return','OPEN',now(),'2026-10-15T18:00:00Z');
 insert into ebay_return_items(return_case_id,order_id,order_line_id,internal_item_id,item_title,expected_quantity)
 values('${id(100)}','${id(10)}','${id(11)}','${id(20)}','Watch',2);`);
});
const receive=(key=200,qty=1,disposition='restock',caseId=100)=>scalar('select receive_customer_return($1,$2,$3,$4,$5,$6) v',[
 id(key),id(caseId),JSON.stringify([{order_line_id:id(11),received_quantity:qty,condition_received:'used_good',disposition,destination_location_id:disposition==='restock'?id(30):null,notes:'Inspected'}]),
 '[{"bucket":"ebay-return-evidence","path":"test/photo.jpg"}]','Received carefully','TRACK1']);
const stock=()=>scalar('select coalesce(sum(quantity),0)::int v from item_stock_locations');

test('case notes preserve status, ownership, stock and provider data and retry only once',async()=>{
 const before=await scalar('select to_jsonb(c) v from ebay_return_cases c');
 const args=[id(301),id(100),'  Reviewed shipping proof. Waiting for eBay.  '];
 const note=await scalar('select add_customer_issue_note($1,$2,$3) v',args);
 assert.equal(note.notes,'Reviewed shipping proof. Waiting for eBay.');assert.equal(note.signed_by,id(1));assert.equal(note.signed_by_email,'operator@example.test');assert.equal(note.note_count,1);
 assert.deepEqual(await scalar('select add_customer_issue_note($1,$2,$3) v',args),note);
 assert.equal(await scalar('select count(*)::int v from ebay_return_events'),1);
 assert.deepEqual(await scalar('select to_jsonb(c) v from ebay_return_cases c'),before);
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),0);assert.equal(await stock(),0);
 await assert.rejects(scalar('select add_customer_issue_note($1,$2,$3) v',[id(301),id(100),'Different note']),/already used/);
});

test('notes work across case types and History; previews and history are paginated and isolated',async()=>{
 for(const [i,lane] of ['return','inquiry','case','payment_dispute'].entries()){
  await db.query('update ebay_return_cases set source_lane=$1,status=$2',[lane,i===3?'closed':'open']);
  await scalar('select add_customer_issue_note($1,$2,$3) v',[id(310+i),id(100),'Note '+i]);
 }
 await db.exec(`update ebay_return_events set created_at='2026-10-10'::timestamptz;insert into ebay_return_cases(id,source_lane,status) values('${id(101)}','return','open')`);
 const preview=await scalar('select customer_issue_notes($1) v',[[id(100),id(101)]]);
 assert.equal(preview.find(r=>r.case_id===id(100)).note_count,4);assert.equal(preview.find(r=>r.case_id===id(100)).notes.length,1);
 assert.equal(preview.find(r=>r.case_id===id(100)).notes[0].notes,'Note 3');assert.equal(preview.find(r=>r.case_id===id(101)).note_count,0);
 const page=await scalar('select customer_issue_notes($1,$2,$3) v',[[id(100)],2,2]);
 assert.deepEqual(page[0].notes.map(n=>n.notes),['Note 1','Note 0']);assert.equal(page[0].note_count,4);
});

test('case notes reject blank, overlong, missing cases and unauthorized writers/readers',async()=>{
 for(const note of ['','   ','x'.repeat(10001)])await assert.rejects(scalar('select add_customer_issue_note($1,$2,$3) v',[id(301),id(100),note]),/Enter a note/);
 await assert.rejects(scalar('select add_customer_issue_note($1,$2,$3) v',[id(301),id(999),'Missing']),/Case not found/);
 await db.exec("select set_config('test.access','no',false)");
 await assert.rejects(scalar('select add_customer_issue_note($1,$2,$3) v',[id(301),id(100),'Denied']),/access required/);
 assert.deepEqual(await scalar('select customer_issue_notes($1) v',[[id(100)]]),[]);
 await db.exec("select set_config('test.access','yes',false);select set_config('test.actor','',false)");
 await assert.rejects(scalar('select add_customer_issue_note($1,$2,$3) v',[id(301),id(100),'Denied']),/access required/);
});

// Decoded directly from the user's FedEx Ground label, not a guessed suffix.
const fedexBarcode='9632001520534711760300878065496736',fedexTracking='878065496736';
test('FedEx full barcode and printed tracking resolve the same return without suffix guesses',async()=>{
 await db.query('update ebay_return_cases set return_tracking_number=$1',[fedexTracking]);
 for(const scan of [fedexTracking,'8780 6549 6736',fedexBarcode,']C0'+fedexBarcode+'\r\n',fedexBarcode.slice(0,9)+'('+fedexBarcode.slice(9,18)+')'+fedexBarcode.slice(18)]){
  const result=await scalar('select lookup_customer_return_package($1) v',[scan]);
  assert.equal(result.tracking_number,fedexTracking);assert.equal(result.matches[0].case_id,id(100));
 }
 for(const scan of ['65496736','1234567890'+fedexTracking,'95'+fedexBarcode.slice(2)])assert.equal((await scalar('select lookup_customer_return_package($1) v',[scan])).matches.length,0);
 await db.query('update ebay_return_cases set return_tracking_number=$1',[fedexBarcode]);
 assert.equal((await scalar('select lookup_customer_return_package($1) v',[fedexTracking])).matches[0].case_id,id(100),'legacy saved full barcode can be found by TRK number');
 await db.query("insert into ebay_return_cases(id,order_id,order_number,source_lane,return_tracking_number) values($1,$2,'02-12345-12345','return',$3)",[id(101),id(10),fedexTracking]);
 assert.equal((await scalar('select lookup_customer_return_package($1) v',[fedexBarcode])).matches.length,2,'ambiguous tracking must retain both cases');
 assert.equal(await stock(),0);
});

test('FedEx keeps real 14-digit tracking and does not strip leading digits from short tracking',async()=>{
 assert.equal(await scalar('select customer_return_tracking_number($1) v',['96'+'0'.repeat(18)+'12345678901234']),'12345678901234');
 assert.equal(await scalar('select customer_return_tracking_number($1) v',['001234567890']),'001234567890');
});

test('outside-inventory receipt saves evidence and tracking with no stock or catalog changes; retry is idempotent',async()=>{
 await db.exec('update ebay_order_lines set internal_item_id=null;update ebay_return_items set internal_item_id=null');
 const args=[id(200),id(100),JSON.stringify([{order_line_id:id(11),received_quantity:2,condition_received:'used_good',disposition:'received_no_restock'}]),JSON.stringify([{path:'return/item.jpg'},{path:'return/opening.mp4'}]),'Received and inspected; not in inventory',fedexBarcode];
 const result=await scalar('select receive_customer_return($1,$2,$3,$4,$5,$6) v',args);
 assert.equal(result.restocked_units,0);await scalar('select receive_customer_return($1,$2,$3,$4,$5,$6) v',args);
 assert.equal(await stock(),0);assert.equal(await scalar('select count(*)::int v from stock_transactions'),0);assert.equal(await scalar('select count(*)::int v from item_types'),1);
 assert.equal(await scalar('select received_quantity v from ebay_return_items'),2);assert.equal(await scalar('select disposition v from ebay_return_items'),'received_no_restock');
 assert.equal(await scalar('select return_tracking_number v from ebay_return_cases'),fedexTracking);assert.equal(await scalar('select status v from ebay_return_cases'),'received');
 assert.equal(await scalar("select payload->>'tracking_scan' v from ebay_return_events"),fedexBarcode);
 assert.equal(await scalar('select jsonb_array_length(evidence_photos) v from ebay_return_events'),2);
 await assert.rejects(receive(201,1,'received_no_restock'),/more than was shipped/);
 await assert.rejects(scalar('select finish_customer_issue($1,$2) v',[id(100),'Received']),/eBay case is still open/);
 await db.exec("update ebay_return_cases set ebay_status='CLOSED'");await scalar('select finish_customer_issue($1,$2) v',[id(100),'All work finished, no inventory intake required']);
 assert.equal(await scalar('select status v from ebay_return_cases'),'closed');
});

test('uninspected or missing evidence cannot become a completed non-restock receipt',async()=>{
 const args=[id(200),id(100),JSON.stringify([{order_line_id:id(11),received_quantity:1,condition_received:'unknown',disposition:'received_no_restock'}]),'[{}]'];
 await assert.rejects(scalar('select receive_customer_return($1,$2,$3,$4) v',args),/Inspect the item/);
 args[2]=args[2].replace('unknown','used_good');args[3]='[]';
 await assert.rejects(scalar('select receive_customer_return($1,$2,$3,$4) v',args),/photo or video/);assert.equal(await stock(),0);
});

test('a previously held outside-inventory item can finish inspection without receiving or restocking it twice',async()=>{
 await db.exec('update ebay_order_lines set internal_item_id=null;update ebay_return_items set internal_item_id=null');
 await receive(200,2,'quarantine');const item=await scalar('select id v from ebay_return_items');
 const args=[id(201),item,'received_no_restock',null,'Inspected and good; item is outside inventory','[{"path":"inspection.jpg"}]'];
 await scalar('select inspect_customer_return($1,$2,$3,$4,$5,$6) v',args);await scalar('select inspect_customer_return($1,$2,$3,$4,$5,$6) v',args);
 assert.equal(await scalar('select received_quantity v from ebay_return_items'),2);assert.equal(await scalar('select status v from ebay_return_cases'),'received');assert.equal(await stock(),0);
 await assert.rejects(scalar('select inspect_customer_return($1,$2,$3,$4,$5) v',[id(202),item,'restock',id(30),'Ready']),/no verified inventory link/);
});

test('package scan matches exact return labels, original labels and order numbers; ambiguity is preserved',async()=>{
 await db.exec(`update ebay_return_cases set return_tracking_number='9400123456789012345678';update ebay_orders set tracking_number='1Z1234567890123456'`);
 let result=await scalar('select lookup_customer_return_package($1) v',['420123459400123456789012345678']);
 assert.equal(result.matches[0].case_id,id(100));assert.equal(result.matches[0].matched_by,'return_tracking');
 result=await scalar('select lookup_customer_return_package($1) v',['1Z1234567890123456']);assert.equal(result.matches.length,1);
 await db.exec(`insert into ebay_return_cases(id,order_id,order_number,status,source_lane) values('${id(101)}','${id(10)}','01-12345-12345','closed','return')`);
 result=await scalar('select lookup_customer_return_package($1) v',['01-12345-12345']);assert.equal(result.matches.length,2);
 result=await scalar('select lookup_customer_return_package($1) v',['9400123456789012345678']);assert.equal(result.matches.length,1,'exact return label takes precedence');
 assert.equal(await stock(),0);
});
test('unregistered return offers fulfilled original order; unknown code never creates a case',async()=>{
 await db.exec('delete from ebay_return_items;delete from ebay_return_cases');
 const result=await scalar('select lookup_customer_return_package($1) v',['01-12345-12345']);assert.equal(result.matches[0].case_id,null);assert.equal(result.matches[0].order_id,id(10));
 assert.equal((await scalar('select lookup_customer_return_package($1) v',['NOTKNOWN'])).matches.length,0);
 assert.equal(await scalar('select count(*)::int v from ebay_return_cases'),0);
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(scalar('select lookup_customer_return_package($1) v',['01-12345-12345']),/access required/);
});
test('package notes survive blank item notes; problem outcomes require an explanation',async()=>{
 const payload=[{order_line_id:id(11),received_quantity:2,condition_received:'damaged',disposition:'damaged',notes:''}];
 await assert.rejects(scalar('select receive_customer_return($1,$2,$3,$4,$5) v',[id(200),id(100),JSON.stringify(payload),'[{"path":"photo.jpg"}]','']),/Explain/);
 await scalar('select receive_customer_return($1,$2,$3,$4,$5) v',[id(200),id(100),JSON.stringify(payload),'[{"path":"photo.jpg"}]','Clasp broken; do not sell']);
 assert.equal(await scalar('select notes v from ebay_return_items'),'Clasp broken; do not sell');assert.equal(await scalar('select notes v from ebay_return_events'),'Clasp broken; do not sell');assert.equal(await stock(),0);
 assert.equal(await scalar('select status v from ebay_return_cases'),'needs_review');
});
test('later inspection retains new photos and video, with idempotent restocking',async()=>{
 await receive(200,1,'quarantine');const item=await scalar('select id v from ebay_return_items');
 const evidence=[{bucket:'ebay-return-evidence',path:'inspection/photo.jpg'},{bucket:'ebay-return-evidence',path:'inspection/video.mp4',mime_type:'video/mp4'}];
 const args=[id(201),item,'restock',id(30),'Verified serial and condition',JSON.stringify(evidence)];
 await scalar('select inspect_customer_return($1,$2,$3,$4,$5,$6) v',args);await scalar('select inspect_customer_return($1,$2,$3,$4,$5,$6) v',args);
 assert.equal(await stock(),1);assert.deepEqual(await scalar("select evidence_photos v from ebay_return_events where action='restocked'"),evidence);
});

test('receiving employee can request follow-up once, with the same case and order evidence',async()=>{
 await db.exec("select set_config('test.admin','no',false)");
 const args=[id(250),id(100),id(2),'decision','Please review the damaged clasp'];
 const task=await scalar('select request_customer_return_followup($1,$2,$3,$4,$5) v',args);
 assert.equal(await scalar('select request_customer_return_followup($1,$2,$3,$4,$5) v',args),task);
 const saved=(await db.query('select * from ebay_return_tasks where id=$1',[task])).rows[0];
 assert.equal(saved.assigned_to_user_id,id(2));assert.equal(saved.metadata.request_kind,'decision');assert.deepEqual(saved.order_line_ids,[id(11)]);
 assert.equal(await scalar('select count(*)::int v from ebay_return_task_events'),1);assert.equal(await stock(),0);
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(scalar('select request_customer_return_followup($1,$2,$3,$4,$5) v',[id(251),...args.slice(1)]),/access required/);
});

test('order link repair connects unique listings, preserves work and stock, and audits once',async()=>{
 await db.exec(`delete from ebay_return_items;update ebay_return_cases set buyer_username='buyer.one',raw_payload='{"apiExtractedDetails":{"itemNumber":"287000000001","transactionId":"different-provider-tx","quantity":1}}';
 insert into ebay_return_tasks(id,return_case_id,order_id,task_type,status,title,question,order_line_ids) values('${id(201)}','${id(100)}','${id(10)}','return_review','waiting_on_admin','Keep my title','Employee instructions','{}');`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),1);
 assert.deepEqual(await scalar('select customer_issue_order_line_ids($1) v',[id(100)]),[id(11)]);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),0);
 assert.equal(await scalar('select count(*)::int v from ebay_return_events'),1);
 assert.equal(await scalar('select received_quantity v from ebay_return_items'),0);
 assert.equal(await stock(),0);
 const task=(await db.query('select status,title,question from ebay_return_tasks')).rows[0];
 assert.deepEqual(task,{status:'waiting_on_admin',title:'Keep my title',question:'Employee instructions'});
 assert.equal(await scalar('select status v from ebay_orders'),'fulfilled');
});
test('order repair rejects ambiguities, conflicting buyers and manually verified cases',async()=>{
 await db.exec(`delete from ebay_return_items;update ebay_return_cases set buyer_username='other',raw_payload='{"apiExtractedDetails":{"itemNumber":"287000000001","transactionId":"different"}}';`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),0);
 await db.exec(`update ebay_return_cases set buyer_username='buyer.one';insert into ebay_order_lines(id,order_id,item_number,transaction_id,quantity) values('${id(12)}','${id(10)}','287000000001','second',1);`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),0);
 await db.exec(`update ebay_return_cases set raw_payload=jsonb_set(raw_payload,'{apiExtractedDetails,transactionId}','"second"');`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),1);
 assert.deepEqual(await scalar('select customer_issue_order_line_ids($1) v',[id(100)]),[id(12)]);
 await db.exec(`delete from ebay_return_items;delete from ebay_return_events;update ebay_return_cases set raw_payload='{"manualOrderMatch":{"line_ids":[]},"apiExtractedDetails":{"itemNumber":"287000000001"}}';`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),0);
});
test('closed disputes gain evidence identity without a new task or inventory intake',async()=>{
 await db.exec(`delete from ebay_return_items;update ebay_return_cases set order_id=null,order_number=null,buyer_username='buyer.one',source_lane='case',status='closed',closed_at=now(),raw_payload='{"apiExtractedDetails":{"itemNumber":"287000000001","transactionId":"different"}}';`);
 assert.equal(await scalar('select repair_customer_issue_order_links() v'),1);
 assert.equal(await scalar('select status v from ebay_return_cases'),'closed');
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),0);
 assert.equal(await scalar('select count(*)::int v from ebay_return_items'),0);
 assert.deepEqual(await scalar('select customer_issue_order_line_ids($1) v',[id(100)]),[id(11)]);
 // A malformed reference to an unrelated order cannot expose that order's evidence.
 await db.exec(`update ebay_return_cases set order_id='${id(10)}',raw_payload='{"automaticOrderMatch":{"line_ids":["${id(12)}"]}}';`);
 assert.deepEqual(await scalar('select customer_issue_order_line_ids($1) v',[id(100)]),[]);
 await db.exec('set role authenticated');await assert.rejects(scalar('select repair_customer_issue_order_links() v'),/permission denied/);
});

test('case identity recovery preserves work, audits the old ID and refuses collisions',async()=>{
 await db.exec(`update ebay_return_cases set source_lane='case',ebay_return_id='111',raw_payload='{"ebaySummary":{"caseId":900},"ebayDetail":{"caseId":900}}' where id='${id(100)}';
 insert into ebay_return_tasks(return_case_id,order_id,task_type,status,title) values('${id(100)}','${id(10)}','follow_up','open','Keep this work');
 insert into ebay_issue_sync_jobs(lane,external_id) values('case','111');`);
 const migration=await sqlFile('20261009047000_customer_issue_case_identity.sql');await db.exec(migration);
 assert.equal(await scalar('select ebay_return_id v from ebay_return_cases where id=$1',[id(100)]),'900');
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks where status=\'open\''),1);
 assert.equal(await scalar('select state v from ebay_issue_sync_jobs where external_id=\'111\''),'superseded');
 assert.equal(await scalar('select count(*)::int v from ebay_return_events where payload->>\'source\'=\'customer_issue_identity_correction\''),1);
 await db.exec(migration);assert.equal(await scalar('select count(*)::int v from ebay_return_events'),1);
 await db.exec(`insert into ebay_return_cases(id,order_id,source_lane,ebay_return_id,raw_payload) values('${id(101)}','${id(10)}','case','222','{"ebaySummary":{"caseId":900},"ebayDetail":{"caseId":900}}')`);
 await db.exec(migration);assert.equal(await scalar('select ebay_return_id v from ebay_return_cases where id=$1',[id(101)]),'222');
});
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

const syncPayment=async(status='OPEN',due=null)=>db.query("update ebay_return_cases set source_lane='payment_dispute',issue_kind='dispute',ebay_status=$1,ebay_due_at=$2,synced_at=now(),sync_error=null where id=$3",[status,due,id(100)]);
const autoTask=async(status='open',extra='{}')=>db.query("insert into ebay_return_tasks(id,return_case_id,order_id,title,task_type,status,metadata) values($1,$2,$3,'Review','return_review',$4,'{\"source\":\"ebay_return_api\",\"request_kind\":\"decision\"}'::jsonb||$5::jsonb)",[id(300),id(100),id(10),status,extra]);

test('priority batches put urgent work first while preserving retries, older work, and backoff',async()=>{
 await db.exec(`insert into ebay_issue_sync_jobs(lane,external_id,priority,state,attempts,next_attempt_at,enqueued_at)
  select 'return','routine-'||n,0,'queued',0,now(),now() from generate_series(1,20)n;
 insert into ebay_issue_sync_jobs(lane,external_id,priority,state,attempts,next_attempt_at,enqueued_at) values
 ('return','manual',-10,'queued',0,now(),now()),('return','changed',-6,'queued',0,now(),now()),
 ('return','retry',20,'retry',2,now(),now()),('return','old',20,'queued',0,now(),now()-interval '1 hour'),
 ('return','cooldown',-10,'retry',3,now()+interval '1 hour',now());
 update ebay_return_cases set ebay_due_at=now()+interval '1 hour';
 insert into ebay_issue_sync_jobs(lane,external_id,priority) values('return','12345',0);`);
 const jobs=(await db.query('select external_id from customer_issue_job_batch()')).rows.map(r=>r.external_id);
 assert.equal(jobs[0],'manual');assert.equal(jobs[1],'retry');assert.ok(jobs.includes('old'));
 assert.ok(jobs.indexOf('12345')<jobs.indexOf('changed'));assert.equal(jobs.length,12);assert.equal(new Set(jobs).size,12);assert.ok(!jobs.includes('cooldown'));
});

test('discovery promotion keeps the latest summary, retry errors, backoff, age and manual priority',async()=>{
 await db.exec(`insert into ebay_issue_sync_jobs(lane,external_id,summary,priority,state,attempts,next_attempt_at,last_error,enqueued_at)
 values('return','r1','{"version":1}',0,'retry',3,now()+interval '1 hour','timeout',now()-interval '1 hour');`);
 const before=(await db.query("select * from ebay_issue_sync_jobs where external_id='r1'")).rows[0];
 await scalar('select enqueue_customer_issue_jobs($1) v',[JSON.stringify([{lane:'return',external_id:'r1',summary:{version:2},priority:-6}])]);
 const after=(await db.query("select * from ebay_issue_sync_jobs where external_id='r1'")).rows[0];
 assert.equal(after.priority,-6);assert.deepEqual(after.summary,{version:2});assert.equal(after.attempts,3);assert.equal(after.last_error,'timeout');
 assert.deepEqual(after.next_attempt_at,before.next_attempt_at);assert.deepEqual(after.enqueued_at,before.enqueued_at);assert.ok(after.updated_at.getTime()>=before.updated_at.getTime());
 await db.exec("update ebay_issue_sync_jobs set priority=-10");
 await scalar('select enqueue_customer_issue_jobs($1) v',[JSON.stringify([{lane:'return',external_id:'r1',summary:{version:3},priority:-6}])]);
 assert.equal(await scalar('select priority v from ebay_issue_sync_jobs'),-10);
});

test('urgent cases refresh sooner than routine cases, and fresh or closed cases are not requeued',async()=>{
 await db.exec("update ebay_return_cases set ebay_due_at=now()+interval '2 hours',synced_at=now()-interval '3 minutes'");
 await scalar('select schedule_customer_issue_refreshes() v');assert.equal(await scalar('select priority v from ebay_issue_sync_jobs'),-8);
 await db.exec("truncate ebay_issue_sync_jobs;update ebay_return_cases set ebay_due_at=now()+interval '20 days'");
 await scalar('select schedule_customer_issue_refreshes() v');assert.equal(await scalar('select count(*)::int v from ebay_issue_sync_jobs'),0);
 await db.exec("update ebay_return_cases set synced_at=now()-interval '12 minutes'");
 await scalar('select schedule_customer_issue_refreshes() v');assert.equal(await scalar('select priority v from ebay_issue_sync_jobs'),0);
 await db.exec("truncate ebay_issue_sync_jobs;update ebay_return_cases set status='closed'");
 await scalar('select schedule_customer_issue_refreshes() v');assert.equal(await scalar('select count(*)::int v from ebay_issue_sync_jobs'),0);
});

test('recovery retries are rate limited and retain errors until provider success',async()=>{
 await db.exec("insert into ebay_issue_sync_jobs(lane,external_id,state,attempts,last_error,next_attempt_at) values('return','r1','retry',3,'timeout',now()+interval '1 hour')");
 await scalar('select retry_customer_issue_sync() v');assert.equal(await scalar('select next_attempt_at<=now() v from ebay_issue_sync_jobs'),true);
 assert.equal(await scalar('select attempts v from ebay_issue_sync_jobs'),3);assert.equal(await scalar('select last_error v from ebay_issue_sync_jobs'),'timeout');
 await assert.rejects(scalar('select retry_customer_issue_sync() v'),/just requested/);
 assert.equal(await scalar("select has_function_privilege('authenticated','retry_customer_issue_sync()','execute') v"),false);
});

test('sync health alerts administrators once per outage, updates its reason and records recovery without closing work',async()=>{
 await db.exec("update ebay_issue_sync_lanes set status='error',error_count=3 where lane='return'");
 assert.equal(await scalar('select check_customer_issue_sync() v'),1);assert.equal(await scalar('select check_customer_issue_sync() v'),0);
 assert.equal(await scalar('select recipient_user_id v from task_notifications'),id(2));
 await db.exec("update ebay_issue_sync_lanes set status='needs_access' where lane='return'");
 await scalar('select check_customer_issue_sync() v');assert.match(await scalar('select body v from task_notifications'),/reconnect eBay/);
 await db.exec("update ebay_issue_sync_lanes set status='ok',error_count=0,last_progress_at=now()");await scalar('select check_customer_issue_sync() v');
 assert.equal(await scalar('select title v from task_notifications'),'eBay sync restored');assert.equal(await scalar('select count(*)::int v from customer_issue_sync_incidents where resolved_at is null'),0);
 assert.equal(await scalar('select status v from ebay_return_cases'),'open');assert.equal(await stock(),0);
 await db.exec("update ebay_issue_sync_lanes set status='needs_access' where lane='return'");assert.equal(await scalar('select check_customer_issue_sync() v'),1);
 assert.equal(await scalar('select count(*)::int v from task_notifications'),2);
});

test('independent health check detects a stopped worker without four duplicate feed alerts',async()=>{
 await db.exec("update ebay_issue_worker set last_run_finished_at=now()-interval '15 minutes';update ebay_issue_sync_lanes set last_progress_at=now()-interval '1 hour'");
 assert.deepEqual((await db.query('select * from customer_issue_sync_problems()')).rows,[{monitor_key:'worker',reason:'stalled'}]);
 assert.equal(await scalar('select check_customer_issue_sync() v'),1);
 assert.equal(await scalar("select has_function_privilege('authenticated','check_customer_issue_sync(timestamptz)','execute') v"),false);
});

test('healthy pagination is progress; transient failures do not alert, repeated detail failures and old queues do',async()=>{
 await db.exec("update ebay_issue_sync_lanes set last_success_at=now()-interval '3 hours',last_progress_at=now(),status='syncing';insert into ebay_issue_sync_jobs(lane,external_id,state,attempts) values('return','r1','retry',1)");
 assert.equal(await scalar('select check_customer_issue_sync() v'),0);
 await db.exec("update ebay_issue_sync_jobs set attempts=3");assert.equal(await scalar('select check_customer_issue_sync() v'),1);
 await db.exec("truncate ebay_issue_sync_jobs;insert into ebay_issue_sync_jobs(lane,external_id,enqueued_at) values('inquiry','i1',now()-interval '40 minutes')");
 assert.ok((await db.query('select * from customer_issue_sync_problems()')).rows.some(r=>r.monitor_key==='inquiry'&&r.reason==='backlog'));
});

test('monitor-only imports move to Following without closing the case or changing inventory',async()=>{
 await autoTask();await syncPayment();
 assert.equal(await scalar('select status v from ebay_return_tasks'),'deferred');
 assert.equal(await scalar("select metadata->>'customer_issue_watch' v from ebay_return_tasks"),'true');
 await db.exec("select set_config('test.actor','"+id(2)+"',false);set role authenticated");
 assert.equal((await scalar("select list_customer_issues('dispute','mine') v")).total,0);
 assert.equal((await scalar("select list_customer_issues('dispute','following') v")).total,1);
 assert.equal((await scalar("select list_customer_issues('dispute','unassigned') v")).total,0);
 await db.exec("reset role");assert.equal(await stock(),0);
});
test('monitoring resumes exactly once for a new response; completed reviews stay in history',async()=>{
 await autoTask();await syncPayment();await syncPayment('ACTION_NEEDED','2026-10-14T06:59:59Z');
 assert.equal(await scalar('select status v from ebay_return_tasks'),'open');
 assert.equal(await scalar('select count(*)::int v from task_notifications'),1);
 await syncPayment('ACTION_NEEDED','2026-10-14T06:59:59Z');assert.equal(await scalar('select count(*)::int v from task_notifications'),1);
 await db.exec("update ebay_return_tasks set status='resolved' where id='"+id(300)+"'");
 await syncPayment('OPEN');await syncPayment('ACTION_NEEDED','2026-10-16T06:59:59Z');
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),2);
 assert.equal(await scalar('select status v from ebay_return_tasks where id=$1',[id(300)]),'resolved');
 assert.equal(await scalar('select count(*)::int v from task_notifications'),2);
});
test('assigned employee work and comments are never automatically parked',async()=>{
 await autoTask();await db.exec("update ebay_return_tasks set assigned_to_user_id='"+id(1)+"',question='Inspect this clasp',due_at=now()+interval '1 day'");
 await syncPayment();assert.equal(await scalar('select status v from ebay_return_tasks'),'open');
 assert.equal(await scalar('select question v from ebay_return_tasks'),'Inspect this clasp');
});

test('only the current reviewer can finish an unassigned import, with an audit and attachments',async()=>{
 await autoTask();const updated=await scalar('select updated_at::text v from ebay_return_tasks');
 const finish=stamp=>scalar('select finish_customer_issue_review($1,$2,$3,$4) v',[id(300),stamp,'Outcome checked','[{"bucket":"ebay-return-evidence","path":"review.jpg"}]']);
 await assert.rejects(finish(updated),/Only the current reviewer/);
 await db.exec("select set_config('test.actor','"+id(2)+"',false);set role authenticated");
 await assert.rejects(finish('2020-01-01T00:00:00Z'),/changed/);
 await finish(updated);await db.exec('reset role');
 assert.equal(await scalar('select status v from ebay_return_tasks'),'resolved');
 assert.equal(await scalar("select photo_attachments->0->>'path' v from ebay_return_task_events where payload->>'reason'='review_completed'"),'review.jpg');
 assert.equal(await scalar('select status v from ebay_return_cases'),'open');
 assert.equal(await stock(),0);
});
test('eBay deadline stages deduplicate and use provider deadline independently of task due date',async()=>{
 await autoTask();await syncPayment('ACTION_NEEDED','2026-10-14T06:00:00Z');
 await db.exec("update ebay_return_tasks set due_at='2027-01-01T00:00:00Z'");
 for(const now of ['2026-10-12T12:00:00Z','2026-10-12T12:05:00Z','2026-10-13T12:00:00Z','2026-10-14T03:00:00Z','2026-10-14T07:00:00Z'])await scalar('select enqueue_customer_issue_deadlines($1) v',[now]);
 assert.equal(await scalar("select count(*)::int v from task_notifications where notification_type='customer_issue_deadline'"),4);
 await syncPayment('CLOSED');await scalar('select enqueue_customer_issue_deadlines($1) v',['2026-10-15T00:00:00Z']);
 assert.equal(await scalar("select count(*)::int v from task_notifications where notification_type='customer_issue_deadline'"),4);
 assert.equal(await scalar("select has_function_privilege('authenticated','enqueue_customer_issue_deadlines(timestamptz)','execute') v"),false);
});
test('closing a followed provider case requests outcome review once',async()=>{
 await autoTask();await syncPayment();await syncPayment('CLOSED');
 assert.equal(await scalar('select status v from ebay_return_tasks'),'open');
 assert.equal(await scalar('select count(*)::int v from task_notifications'),1);
 await syncPayment('CLOSED');assert.equal(await scalar('select count(*)::int v from task_notifications'),1);
});


test('evidence excludes internal messages, voided certificates, removed packaging files and unrelated buyers',async()=>{
 await db.exec(`update ebay_return_cases set buyer_username='buyer.one';
 insert into ebay_order_line_certificates values('${id(11)}','https://certificate.example/1','123','serial','[{"bucket":"photos","path":"certificate.pdf"}]',null),('${id(11)}',null,'VOID','serial','[]',now());
 insert into packaging_shipments values('${id(900)}',array['${id(10)}']::uuid[],'TRACK1','dispatched',now());
 insert into packaging_evidence values('${id(900)}','photos','kept.jpg','image/jpeg','image','Package',now(),null),('${id(900)}','photos','removed.jpg','image/jpeg','image','Package',now(),now());
 insert into ebay_return_messages values('${id(100)}','inbound','Buyer comment',now(),'imported'),('${id(100)}','internal','Private instruction',now(),'imported');
 insert into ebay_conversations values('${id(901)}','buyer.one','FROM_MEMBERS','287000000001'),('${id(902)}','other.buyer','FROM_MEMBERS','287000000001'),('${id(903)}','buyer.one','FROM_MEMBERS','unrelated-item');
 insert into ebay_conversation_messages values('${id(904)}','${id(901)}','buyer.one','inbound','Linked message',now()),('${id(905)}','${id(902)}','other.buyer','inbound','Other buyer',now()),('${id(906)}','${id(903)}','buyer.one','inbound','Different item',now());`);
 const data=await scalar('select customer_issue_evidence($1) v',[id(100)]);
 assert.equal(data.certificates.length,1);assert.equal(data.packaging_photos.length,1);assert.equal(data.case_messages.length,1);assert.equal(data.buyer_messages.length,1);
 assert.equal(data.buyer_messages[0].message_body,'Linked message');
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(scalar('select customer_issue_evidence($1) v',[id(100)]),/access required/);
});


const listIssues=(sort='newest',view='attention',offset=0,limit=30)=>scalar('select list_customer_issues($1,$2,$3,$4,$5,$6) v',[view,'all','',offset,limit,sort]);
test('return progress uses current return evidence and never invents transit from a label or replacement',async()=>{
 const stage=(status='OPEN',raw={},local='open',kind='return')=>scalar('select customer_issue_return_stage($1,$2,$3,$4) v',[kind,local,status,JSON.stringify(raw)]);
 assert.equal(await stage('READY_FOR_SHIPPING',{returnState:'ITEM_READY_TO_SHIP',returnTrackingNumber:'LABEL-ONLY',returnLifecycleStage:'shipped'}),'awaiting_shipment');
 assert.equal(await stage('OPEN',{returnTrackingNumber:'LABEL-ONLY',returnLifecycleStage:'shipped'}),'unknown');
 assert.equal(await stage('RETURN_REQUESTED'),'requested');
 assert.equal(await stage('ITEM_SHIPPED'),'in_transit');assert.equal(await stage('ITEM_DELIVERED'),'delivered');
 const raw=deliveryStatus=>({ebayDetail:{returnShipmentInfo:{shipmentTracking:{deliveryStatus,active:true}}}});
 assert.equal(await stage('CLOSED',raw('DELIVERED')),'delivered','provider closure does not erase shipment evidence');
 assert.equal(await stage('OPEN',raw('IN_TRANSIT')),'in_transit');assert.equal(await stage('OPEN',raw('CREATED')),'unknown');
 assert.equal(await stage('OPEN',{ebayDetail:{replacementShipmentInfo:{shipmentTracking:{deliveryStatus:'DELIVERED'}},responseHistory:[{toState:'ITEM_DELIVERED'}]},sellerActionDue:'SELLER_MARK_AS_RECEIVED'}),'unknown');
 assert.equal(await stage('OPEN',{ebayDetail:{returnShipmentInfo:{shipmentTracking:{deliveryStatus:'DELIVERED',active:false}}}}),'unknown');
 for(const local of ['received','partially_received','needs_review'])assert.equal(await stage('ITEM_DELIVERED',raw('DELIVERED'),local),local);
 assert.equal(await stage('ITEM_DELIVERED',raw('DELIVERED'),'open','request'),null);
});
test('return filters apply before pagination and update after provider or local receiving changes',async()=>{
 await db.exec(`insert into ebay_return_cases(id,status,source_lane,issue_kind,ebay_status,opened_at)
 select gen_random_uuid(),'open','return','return','ITEM_SHIPPED',now()-i*interval '1 minute' from generate_series(1,35) i;
 update ebay_return_cases set ebay_status='ITEM_DELIVERED',opened_at=now()-interval '1 year' where id='${id(100)}';`);
 const filtered=(stage,offset=0)=>scalar("select list_customer_issues('return','all','',$1,30,'newest',$2) v",[offset,stage]);
 let result=await filtered('delivered');assert.equal(result.total,1);assert.equal(result.rows[0].id,id(100));assert.equal(result.rows[0].return_stage,'delivered');assert.equal(result.counts.return,36);
 result=await filtered('in_transit',30);assert.equal(result.total,35);assert.equal(result.rows.length,5);
 await db.exec(`update ebay_return_cases set status='received' where id='${id(100)}'`);
 assert.equal((await filtered('delivered')).total,0);assert.equal((await filtered('received')).total,1);
 assert.equal((await listIssues()).total,36,'cached six-argument clients remain unfiltered');
 assert.equal((await scalar("select list_customer_issues('attention','all','',0,30,'newest','delivered') v")).total,36,'return filter does not hide other tabs');
 await db.exec("select set_config('test.access','no',false)");assert.equal((await filtered('in_transit')).total,0);
});
test('customer cards use only their linked order, with name search and return-only shipping fields',async()=>{
 const payload={order:{fulfillmentStartInstructions:[{shippingStep:{shipTo:{fullName:'Robin Taylor',contactAddress:{addressLine1:'123 Example Lane',addressLine2:'Apt 4',city:'Boston',stateOrProvince:'MA',postalCode:'02108',countryCode:'US'},primaryPhone:{phoneNumber:'PRIVATE'}}}}],buyer:{buyerRegistrationAddress:{fullName:'Other name',contactAddress:{addressLine1:'WRONG REGISTRATION'}}}},returnAddress:{addressLine1:'WRONG SELLER'}};
 await db.query('update ebay_orders set buyer_name=$1,raw_payload=$2 where id=$3',['Alex Taylor',JSON.stringify(payload),id(10)]);
 await db.exec(`insert into ebay_orders(id,order_number,buyer_username,buyer_name) values('${id(19)}','other','buyer.one','Wrong unrelated name')`);
 let row=(await listIssues()).rows[0];assert.equal(row.customer_name,'Alex Taylor');assert.equal(row.shipping_name,'Robin Taylor');assert.equal(row.shipping_address.line2,'Apt 4');assert.equal(row.shipping_address.postal_code,'02108');assert.equal(row.raw_payload,undefined);assert.ok(!JSON.stringify(row).includes('PRIVATE'));assert.ok(!JSON.stringify(row).includes('WRONG'));
 assert.equal((await scalar("select list_customer_issues('attention','all','alex taylor',0,30,'newest') v")).total,1);
 await db.exec(`update ebay_return_cases set issue_kind='dispute',source_lane='payment_dispute'`);
 row=(await listIssues()).rows[0];assert.equal(row.customer_name,'Alex Taylor');assert.equal(row.shipping_address,null);assert.equal(row.shipping_name,null);
 await db.exec('update ebay_return_cases set order_id=null');row=(await listIssues()).rows[0];assert.equal(row.customer_name,null,'never borrow from another order by username');
});
test('contact projection supports CSV and flat API snapshots without mixing registration and shipping addresses',async()=>{
 const contact=raw=>scalar('select customer_issue_order_contact(null,$1) v',[JSON.stringify(raw)]);
 let p=await contact({first_row:{'Buyer Name':'  Alex Taylor ','Ship To Name':'Robin Taylor','Ship To Address 1':'10 Sample Street','Ship To Address 2':'Unit 2','Ship To City':'Boston','Ship To State':'MA','Ship To Zip':'02108','Ship To Country':'US','Buyer Address 1':'NOT SHIPPING'}});
 assert.equal(p.customer_name,'Alex Taylor');assert.equal(p.shipping_name,'Robin Taylor');assert.equal(p.shipping_address.line1,'10 Sample Street');assert.equal(p.shipping_address.postal_code,'02108');
 p=await contact({fulfillmentStartInstructions:[{shippingStep:{shipTo:{fullName:'Legacy Name',contactAddress:{addressLine1:'12 Legacy Road',city:'London',postalCode:'SW1A 1AA',countryCode:'GB'}}}}]});assert.equal(p.customer_name,'Legacy Name');assert.equal(p.shipping_address.postal_code,'SW1A 1AA');
 p=await contact({order:{fulfillmentStartInstructions:[{shippingStep:{shipTo:{contactAddress:{addressLine1:'Only this street'}}}}]},first_row:{'Ship To City':'Wrong other city'}});assert.equal(p.shipping_address.line1,'Only this street');assert.equal(p.shipping_address.city,undefined);
 p=await contact({order:{buyer:{buyerRegistrationAddress:{fullName:'Name only',contactAddress:{addressLine1:'Registration street'}}}}});assert.equal(p.customer_name,'Name only');assert.equal(p.shipping_address,null);
 p=await contact({order:{fulfillmentStartInstructions:[{shippingStep:{shipTo:{contactAddress:'malformed'}}}]}});assert.equal(p.shipping_address,null);
});
test('summary exposes only the matching dispute response and picks up renewed action without sending raw evidence',async()=>{
 await db.exec(`insert into ebay_return_cases(id,source_lane,issue_kind,ebay_return_id,status,ebay_status,raw_payload) values
 ('${id(101)}','payment_dispute','dispute','5010603112','open','OPEN','{"ebayDetail":{"paymentDisputeId":"5010603112","sellerResponse":"SELLER_CONTEST","note":"Private response"}}');`);
 let row=(await listIssues()).rows[0];assert.equal(row.seller_response,'SELLER_CONTEST');assert.equal(row.ebay_status,'OPEN');assert.equal(row.raw_payload,undefined);
 await db.exec(`update ebay_return_cases set ebay_status='ACTION_NEEDED',ebay_due_at='2026-10-16T06:59:59Z' where id='${id(101)}'`);
 row=(await listIssues()).rows[0];assert.equal(row.ebay_status,'ACTION_NEEDED');assert.equal(row.seller_response,'SELLER_CONTEST');assert.ok(row.ebay_due_at.startsWith('2026-10-16'));
 await db.exec(`update ebay_return_cases set raw_payload=jsonb_set(raw_payload,'{ebayDetail,paymentDisputeId}','"different-case"') where id='${id(101)}'`);
 assert.equal((await listIssues()).rows[0].seller_response,null);
});
test('cards use exact linked item sale values and original purchase date, never whole order or refund amount',async()=>{
 await db.exec(`update ebay_orders set sale_date='2026-08-01T15:30:00Z';update ebay_order_lines set sold_for=70,total_price=160;
 insert into ebay_order_lines(id,order_id,item_title,quantity,sold_for,total_price) values('${id(12)}','${id(10)}','Unrelated expensive item',1,9999,9999);
 update ebay_return_cases set raw_payload='{"apiExtractedDetails":{"requestAmount":"USD 800.00"}}';
 insert into ebay_return_tasks(return_case_id,order_id,order_line_ids,title,status) values('${id(100)}','${id(10)}',array['${id(11)}'::uuid],'Same line','assigned');`);
 let c=(await listIssues()).rows[0];assert.equal(c.item_value,140);assert.equal(c.linked_line_count,1);assert.equal(c.item_currency,'USD');assert.equal(Date.parse(c.order_placed_at),Date.parse('2026-08-01T15:30:00Z'));assert.match(c.ebay_due_at,/2026-10-15/);
 await db.exec("update ebay_order_lines set sold_for=null where item_title='Watch'");c=(await listIssues()).rows[0];assert.equal(c.item_value,null,'unknown item value is not replaced by tax-inclusive total or refund amount');
});
test('all lanes default newest first, user sorting spans pagination, and null values are last',async()=>{
 await db.exec(`update ebay_return_cases set opened_at='2026-09-01',ebay_due_at='2026-10-20';update ebay_orders set sale_date='2026-08-01';update ebay_order_lines set sold_for=20;
 insert into ebay_orders(id,order_number,sale_date) values('${id(15)}','02-12345-12345','2026-07-01');
 insert into ebay_order_lines(id,order_id,item_title,quantity,sold_for) values('${id(16)}','${id(15)}','Earlier order',1,500);
 insert into ebay_return_cases(id,order_id,opened_at,status,source_lane,issue_kind,ebay_status,ebay_due_at,raw_payload) values
 ('${id(101)}','${id(15)}','2026-09-03','open','return','return','OPEN','2026-10-10','{"automaticOrderMatch":{"line_ids":["${id(16)}"]}}'),
 ('${id(102)}',null,'2026-09-02','open','return','return','OPEN',null,'{}');`);
 assert.deepEqual((await listIssues()).rows.map(x=>x.id),[id(101),id(102),id(100)]);
 assert.equal((await scalar('select list_customer_issues() v')).rows[0].id,id(101),'old clients get newest first too');
 for(const [sort,expected] of [['oldest',100],['order_newest',100],['order_oldest',101],['due_soonest',101],['due_latest',100],['value_highest',101],['value_lowest',100],['unknown',101]])assert.equal((await listIssues(sort)).rows[0].id,id(expected),sort);
 assert.equal((await listIssues('oldest','return',2,1)).rows[0].id,id(101));
 for(const lane of ['return','request','dispute']){await db.query('update ebay_return_cases set issue_kind=$1',[lane]);assert.equal((await listIssues('newest',lane)).rows[0].id,id(101));}
 await db.exec("update ebay_return_cases set status='closed',ebay_status='CLOSED'");assert.equal((await listIssues('newest','history')).rows[0].id,id(101));
});
test('incomplete or mixed-currency linked items never show a misleading summed value',async()=>{
 await db.exec(`update ebay_order_lines set sold_for=20;
 insert into ebay_order_lines(id,order_id,item_title,quantity,sold_for,raw_payload) values('${id(12)}','${id(10)}','Other currency',1,99,'{"line":{"total":{"currency":"EUR"}}}');
 insert into ebay_return_items(return_case_id,order_id,order_line_id,item_title,expected_quantity) values('${id(100)}','${id(10)}','${id(12)}','Other currency',1);`);
 const c=(await listIssues()).rows[0];assert.equal(c.linked_line_count,2);assert.equal(c.item_value,null);assert.equal(c.item_currency,null);
});
test('case conversation evidence includes exact order/item messages and excludes unrelated buyers and staff notes',async()=>{
 await db.exec(`update ebay_return_cases set buyer_username='buyer.one';
 insert into ebay_return_messages values('${id(100)}','inbound','Case complaint','2026-10-01','imported'),('${id(100)}','internal','Private staff note','2026-10-02','sent');
 insert into ebay_conversations values('${id(300)}','buyer.one','FROM_MEMBERS','01-12345-12345'),('${id(301)}','other.buyer','FROM_MEMBERS','01-12345-12345'),('${id(302)}','buyer.one','FROM_MEMBERS','unrelated');
 insert into ebay_conversation_messages values('${id(310)}','${id(300)}','buyer.one','inbound','Matching buyer chat','2026-10-03'),('${id(311)}','${id(301)}','other.buyer','inbound','Wrong buyer','2026-10-03'),('${id(312)}','${id(302)}','buyer.one','inbound','Different item','2026-10-03');`);
 const result=await scalar('select customer_issue_evidence($1) v',[id(100)]);assert.equal(result.case_messages.length,1);assert.equal(result.buyer_messages.length,1);assert.equal(result.buyer_messages[0].message_body,'Matching buyer chat');
});

async function closeSnapshot(){
 return [id(100),await scalar('select updated_at v from ebay_return_cases where id=$1',[id(100)]),
  JSON.stringify(await scalar("select coalesce(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at)),'[]') v from ebay_return_tasks where return_case_id=$1 and status not in ('resolved','cancelled','closed','approved_by_admin')",[id(100)])),true,null];
}
const directClose=args=>scalar('select close_resolved_customer_issue($1,$2,$3,$4,$5) v',args);
const terminalCase=()=>db.exec("update ebay_return_cases set ebay_status='CLOSED',synced_at=now()-interval '7 days'");

test('direct close archives a resolved case with no tasks, stock changes or fabricated receipts',async()=>{
 await terminalCase();const items=await scalar('select jsonb_agg(to_jsonb(i)) v from ebay_return_items i');
 const args=await closeSnapshot(),result=await directClose(args);
 assert.equal(result.status,'closed');assert.equal(result.closed_tasks,0);
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),0);
 assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(i)) v from ebay_return_items i'),items);
 assert.equal(await stock(),0);assert.equal(await scalar('select count(*)::int v from stock_transactions'),0);
 const event=await scalar("select to_jsonb(e) v from ebay_return_events e where action='closed'");
 assert.equal(event.signed_by,id(1));assert.equal(event.payload.confirmed_resolved,true);assert.equal(event.payload.inventory_changed,false);
 assert.equal((await scalar("select list_customer_issues('history','all','',0,30) v")).total,1);
 assert.equal((await scalar("select list_customer_issues('attention','all','',0,30) v")).total,0);
 assert.equal((await directClose(args)).already_closed,true);assert.equal(await scalar('select count(*)::int v from ebay_return_events'),1);
});

const addCloseTasks=()=>db.exec(`insert into ebay_return_tasks(id,return_case_id,order_id,task_type,title,status,assigned_to_user_id,created_by,latest_note)
 values('${id(301)}','${id(100)}','${id(10)}','return_review','Unassigned review','open',null,'${id(2)}','Keep this employee update'),
 ('${id(302)}','${id(100)}','${id(10)}','follow_up','Assigned work','assigned','${id(2)}','${id(1)}','Photos checked'),
 ('${id(303)}','${id(100)}','${id(10)}','follow_up','Old finished task','resolved','${id(2)}','${id(1)}','Earlier outcome');`);

test('direct close cancels existing follow-ups without assignment, preserves evidence and audits previous task state',async()=>{
 await terminalCase();await addCloseTasks();const previous=await scalar('select to_jsonb(t) v from ebay_return_tasks t where id=$1',[id(303)]);
 await db.exec(`insert into ebay_return_task_events(task_id,return_case_id,action,notes,photo_attachments) values('${id(302)}','${id(100)}','commented','Photo attached','[{"path":"evidence.jpg"}]')`);
 const args=await closeSnapshot();args[4]='Already handled with buyer';const result=await directClose(args);
 assert.equal(result.closed_tasks,2);assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),3);
 assert.equal(await scalar('select assigned_to_user_id v from ebay_return_tasks where id=$1',[id(301)]),null);
 assert.equal(await scalar('select assigned_to_user_id v from ebay_return_tasks where id=$1',[id(302)]),id(2));
 assert.deepEqual(await scalar('select to_jsonb(t) v from ebay_return_tasks t where id=$1',[id(303)]),previous);
 assert.equal(await scalar('select latest_note v from ebay_return_tasks where id=$1',[id(301)]),'Keep this employee update');
 assert.equal(await scalar("select payload->'previous_task'->>'status' v from ebay_return_task_events where task_id=$1 and action='cancelled'",[id(302)]),'assigned');
 assert.equal(await scalar("select photo_attachments->0->>'path' v from ebay_return_task_events where action='commented'"),'evidence.jpg');
 assert.equal(await scalar("select count(*)::int v from ebay_return_tasks where status='cancelled'"),2);
 assert.equal((await scalar("select list_customer_issues('history','all','',0,30) v")).total,1);
});

test('direct close rejects provider-open cases, unconfirmed closeout and unauthorized users',async()=>{
 let args=await closeSnapshot();await assert.rejects(directClose(args),/eBay still reports/);
 await terminalCase();args=await closeSnapshot();args[3]=false;await assert.rejects(directClose(args),/Confirm that/);args[3]=true;
 await db.exec("select set_config('test.admin','no',false)");await assert.rejects(directClose(args),/administrator/);
 await db.exec("select set_config('test.admin','yes',false);select set_config('test.access','no',false)");await assert.rejects(directClose(args),/administrator/);
 await db.exec("select set_config('test.access','yes',false);select set_config('test.actor','',false)");await assert.rejects(directClose(args),/administrator/);
 assert.equal(await scalar('select status v from ebay_return_cases'),'open');
});

test('direct close detects new work and changed case or task before changing anything',async()=>{
 await terminalCase();let args=await closeSnapshot();await addCloseTasks();await assert.rejects(directClose(args),/follow-ups changed/);
 args=await closeSnapshot();await db.exec("update ebay_return_tasks set updated_at=now()+interval '1 minute' where status='assigned'");await assert.rejects(directClose(args),/follow-ups changed/);
 args=await closeSnapshot();await db.exec("update ebay_return_cases set updated_at=now()+interval '2 minutes'");await assert.rejects(directClose(args),/case changed/);
 assert.equal(await scalar("select count(*)::int v from ebay_return_tasks where status='cancelled'"),0);
 assert.equal(await scalar("select count(*)::int v from ebay_return_events where action='closed'"),0);
});

test('direct close preserves unresolved received items until inspection, with no task requirement',async()=>{
 await receive(200,1,'quarantine');await terminalCase();await assert.rejects(directClose(await closeSnapshot()),/Inspect the received items first/);
 const item=await scalar('select id v from ebay_return_items');
 await scalar('select inspect_customer_return($1,$2,$3,$4,$5,$6) v',[id(201),item,'received_no_restock',null,'Checked, outside stock','[{"path":"checked.jpg"}]']);
 await directClose(await closeSnapshot());assert.equal(await stock(),0);
 assert.equal(await scalar('select received_quantity v from ebay_return_items'),1);assert.equal(await scalar('select expected_quantity v from ebay_return_items'),2);
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),0);
});

test('direct close does not recreate follow-ups on terminal refresh; a new provider action can resurface',async()=>{
 await terminalCase();await addCloseTasks();await directClose(await closeSnapshot());
 await db.exec("update ebay_return_cases set synced_at=now()");
 assert.equal(await scalar("select count(*)::int v from ebay_return_tasks where status not in ('resolved','cancelled')"),0);
 await db.exec("update ebay_return_cases set status='open',closed_at=null,ebay_status='SELLER_ACTION_REQUIRED',ebay_action='Respond to buyer',synced_at=now()");
 assert.ok(await scalar("select count(*)::int v from ebay_return_tasks where status not in ('resolved','cancelled')")>0);
});


test('case evidence projects saved inquiry history for existing and future syncs without rewriting tasks',async()=>{
 const history=[{actor:'BUYER',action:'Case created',description:'Original complaint',date:{value:'2026-10-01T03:16:26Z'}},
 {actor:'SELLER',action:'Seller replied',description:'Mailbox reply',date:{value:'2026-10-04T17:57:18Z'}},
 {actor:'SELLER',action:'Tracking provided',date:{value:'2026-10-04T18:52:52Z'}},
 {actor:'SYSTEM',action:'Reminder',date:{value:'2026-10-03T07:00:54Z'}}];
 const payload={ebayDetail:{inquiryId:'12345',inquiryHistoryDetails:{history},privateToken:'must not project',caseHistoryDetails:{history:[{description:'Unrelated case history'}]}}};
 await db.query("update ebay_return_cases set source_lane='inquiry',raw_payload=$1",[JSON.stringify(payload)]);
 let result=await scalar('select customer_issue_evidence($1) v',[id(100)]);
 assert.equal(result.case_history.length,4);assert.equal(result.case_history[0].action,'Tracking provided');assert.equal(result.case_history[1].description,'Mailbox reply');
 assert.ok(!JSON.stringify(result).includes('must not project'));assert.ok(!JSON.stringify(result).includes('Unrelated case history'));
 payload.ebayDetail.inquiryHistoryDetails.history.push({actor:'BUYER',description:'Latest response',date:{value:'2026-10-06T12:00:00Z'}});
 await db.query('update ebay_return_cases set raw_payload=$1',[JSON.stringify(payload)]);
 result=await scalar('select customer_issue_evidence($1) v',[id(100)]);assert.equal(result.case_history[0].description,'Latest response');
 assert.equal(await scalar('select count(*)::int v from ebay_return_tasks'),0);assert.equal(await stock(),0);
});

test('escalated case history is scoped to provider identity, with malformed and missing history safe',async()=>{
 for(const history of [null,{},'bad',[]]){
  await db.query("update ebay_return_cases set source_lane='case',raw_payload=$1",[JSON.stringify({ebayDetail:{caseId:'12345',caseHistoryDetails:{history}}})]);
  assert.equal((await scalar('select customer_issue_evidence($1) v',[id(100)])).case_history.length,0);
 }
 const payload={ebayDetail:{caseId:'12345',caseHistoryDetails:{history:[{actor:'CSR',description:'Support reply',date:{value:'2026-10-05T12:00:00Z'}}]}}};
 await db.query('update ebay_return_cases set raw_payload=$1',[JSON.stringify(payload)]);
 assert.equal((await scalar('select customer_issue_evidence($1) v',[id(100)])).case_history[0].actor,'CSR');
 payload.ebayDetail.caseId='different';await db.query('update ebay_return_cases set raw_payload=$1',[JSON.stringify(payload)]);
 assert.equal((await scalar('select customer_issue_evidence($1) v',[id(100)])).case_history.length,0);
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(scalar('select customer_issue_evidence($1) v',[id(100)]),/access required/);
});
