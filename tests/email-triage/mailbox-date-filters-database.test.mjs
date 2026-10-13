import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const mailbox=async({date=null,state='all',search=[],filter='all',limit=30,offset=0,tags={}}={})=>(await db.query('select get_ebay_canonical_mailbox_v2($1,$2,$3,$4,$5,$6) r',[limit,offset,filter,search,{activityDate:date,teamReadState:state},tags])).rows[0].r;
before(async()=>{
 db=new PGlite();
 await db.exec(`create schema auth;create function auth.role() returns text language sql stable as $$select 'authenticated'::text$$;
 create function can_access_email_triage() returns boolean language sql stable as $$select current_setting('test.allowed',true)='yes'$$;
 create function list_email_triage_task_counts() returns table(conversation_id text,task_count int,pending_task_count int) language sql stable as $$select null::text,0,0 where false$$;`);
 await db.exec(await readFile(new URL('../fixtures/mailbox-date-filter-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261013190000_mailbox_date_read_filters.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{
 const names=(await db.query("select tablename from pg_tables where schemaname='public'")).rows.map(r=>r.tablename);
 await db.exec(`truncate ${names.join(',')};set test.allowed='yes';`);
});
async function conversation(n,stamp,{read=false,username='buyer',type='FROM_MEMBERS'}={}){
 await db.query('insert into ebay_conversations(id,other_party_username,conversation_type,latest_message_id,latest_message_created_at,unread_count) values($1,$2,$3,$4,$5,$6)',[id(n),username,type,'provider-'+n,stamp,read?1:0]);
 await db.query("insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay,created_at,message_body_preview) values($1,$2,$3,'inbound',$4,$4,'Shipping question')",[id(n+10000),id(n),'provider-'+n,stamp]);
 if(read)await db.query("insert into ebay_message_team_reads(message_id,is_read,last_read_name,last_read_at) values($1,true,'Sandra',$2)",[id(n+10000),stamp]);
}
test('date and team-read state filter the canonical inbox with complete, consistent counts',async()=>{
 await conversation(1,'2026-10-13T13:00Z',{read:true});await conversation(2,'2026-10-13T14:00Z');await conversation(3,'2026-10-12T14:00Z');
 const all=await mailbox({date:'2026-10-13'}),read=await mailbox({date:'2026-10-13',state:'read'}),unread=await mailbox({date:'2026-10-13',state:'unread'});
 assert.deepEqual(all.read_counts,{all:2,read:1,unread:1});assert.deepEqual(read.read_counts,all.read_counts);assert.deepEqual(unread.read_counts,all.read_counts);
 assert.deepEqual(read.conversations.map(c=>c.id),[id(1)]);assert.equal(read.conversations[0].team_read.read_by,'Sandra');
 assert.deepEqual(unread.conversations.map(c=>c.id),[id(2)]);
 assert.equal((await mailbox()).read_counts.all,3);assert.equal((await mailbox({date:'2020-01-01'})).matching_total,0);
 assert.deepEqual((await mailbox({date:'2026-10-13',filter:'unread'})).conversations.map(c=>c.id),[id(2)],'provider unread flags cannot override explicit team receipts');
});
test('new inbound and outgoing replies move a conversation by actual latest activity, including missing provider details',async()=>{
 await conversation(1,'2026-10-12T15:00Z',{read:true});
 await db.query("insert into ebay_conversation_messages(id,conversation_id,direction,created_at_ebay) values($1,$2,'outbound','2026-10-13T16:00Z')",[id(30001),id(1)]);
 assert.equal((await mailbox({date:'2026-10-12'})).matching_total,0);
 assert.equal((await mailbox({date:'2026-10-13',state:'read'})).matching_total,1);
 await db.query("insert into ebay_conversation_messages(id,conversation_id,direction,created_at_ebay) values($1,$2,'inbound','2026-10-14T16:00Z')",[id(30002),id(1)]);
 assert.equal((await mailbox({date:'2026-10-13'})).matching_total,0);
 assert.equal((await mailbox({date:'2026-10-14',state:'unread'})).matching_total,1);
 await db.query("update ebay_conversations set latest_message_id='not-yet-loaded',latest_message_created_at='2026-10-15T16:00Z' where id=$1",[id(1)]);
 assert.equal((await mailbox({date:'2026-10-15',state:'unread'})).matching_total,1);
});
test('New York boundaries are exclusive at the next midnight and handle daylight saving',async()=>{
 for(const [i,time] of ['2026-03-08T04:59:59Z','2026-03-08T05:00:00Z','2026-03-09T03:59:59Z','2026-03-09T04:00:00Z'].entries())await conversation(i+1,time);
 assert.equal((await mailbox({date:'2026-03-08'})).matching_total,2);
 for(const [i,time] of ['2026-11-01T03:59:59Z','2026-11-01T04:00:00Z','2026-11-02T04:59:59Z','2026-11-02T05:00:00Z'].entries())await conversation(i+11,time);
 assert.equal((await mailbox({date:'2026-11-01'})).matching_total,2);
});
test('search, folders and classification combine with dates; pages do not limit read totals',async()=>{
 for(let n=1;n<=65;n++)await conversation(n,'2026-10-13T14:00Z',{username:n%2?'goldbuyer':'silverbuyer',read:n%2===0});
 const a=await mailbox({date:'2026-10-13'}),b=await mailbox({date:'2026-10-13',offset:30});
 assert.equal(a.matching_total,65);assert.deepEqual(a.read_counts,{all:65,read:32,unread:33});assert.equal(new Set([...a.conversations,...b.conversations].map(c=>c.id)).size,60);
 const search=await mailbox({date:'2026-10-13',search:['goldbuyer']});assert.equal(search.read_counts.all,33);assert.equal(search.read_counts.read,0);
 await db.query("insert into ebay_conversation_classifications(id,conversation_id,is_current,topic_tags) values($1,$2,true,array['shipping_problem'])",[id(900),id(1)]);
 const tagged=await mailbox({date:'2026-10-13',tags:{topics:['shipping_problem']}});assert.equal(tagged.matching_total,1);assert.equal(tagged.conversations[0].id,id(1));
});
test('invalid state and unauthorized access fail without returning message contents',async()=>{
 await assert.rejects(mailbox({state:'other'}),/Invalid team read filter/);
 await db.exec("set test.allowed='no'");await assert.rejects(mailbox(),/not_authorized/);
});
