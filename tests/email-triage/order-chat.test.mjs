import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
const source=await readFile(new URL('../../supabase/functions/_shared/ebay-order-chat.ts',import.meta.url),'utf8');
const lineId='11111111-1111-4111-8111-111111111111', requestId='22222222-2222-4222-8222-222222222222';
function fixture(extra={}) {
 const tables={ebay_order_lines:[{id:lineId,order_id:'order',item_number:'287123456789',item_title:'Gold chain',quantity:1}],ebay_orders:[{id:'order',buyer_username:'Buyer_One',order_number:'01-12345-67890'}],ebay_seller_accounts:[{id:'seller',account_key:'production:og',status:'active',seller_username:'og'}],ebay_conversations:[],ebay_conversation_links:[],ebay_order_chat_starts:[],...extra};
 const writes=[];let id=1;
 const db={from(table){let filters=[],limit=Infinity,mutation=null,single=false;const q={
 select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},
 ilike(k,v){const literal=v.replace(/\\([\\%_*])/g,'$1').toLowerCase();filters.push(r=>String(r[k]||'').toLowerCase()===literal);return q;},
 order(){return q;},limit(n){limit=n;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
 insert(row){mutation={kind:'insert',row};return q;},upsert(row){mutation={kind:'upsert',row};return q;},update(row){mutation={kind:'update',row};return q;},
 then(resolve,reject){try{const rows=tables[table]||=([]);let found=rows.filter(r=>filters.every(f=>f(r))).slice(0,limit);
 if(mutation){writes.push({table,...mutation});const {kind,row}=mutation;
 if(table==='ebay_order_chat_starts'&&kind==='insert'&&rows.some(r=>r.id===row.id||r.order_line_id===row.order_line_id&&['sending','sent','unknown'].includes(r.status)))return Promise.resolve({error:{code:'23505'}}).then(resolve,reject);
 if(kind==='update'){found.forEach(r=>Object.assign(r,row));}else{const saved={id:`row-${id++}`,...row};rows.push(saved);found=[saved];}}
 return Promise.resolve({data:single?found[0]||null:found,error:null}).then(resolve,reject);
 }catch(e){return Promise.reject(e).then(resolve,reject);}}
 };return q;}};
 const c=vm.createContext({console,Date});vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm,''),{mode:'transform'}),c);
 c.db=db;c.calls=[];c.deps={accountKey:'production:og',refreshEbayToken:async()=>'fixture-token',sha256Hex:async s=>createHash('sha256').update(s).digest('hex'),safeMessage:p=>p.message||'Rejected',ebayPost:async(token,path,body)=>{c.calls.push({path,body});return {ok:true,status:201,payload:{conversationId:'provider-chat',messageId:'provider-message'}};}};
 c.input={orderLineId:lineId,requestId,draftText:'We are checking your chain.',sendConfirmed:true};c.actor={userId:'operator'};
 return {c,tables,writes,context:()=>vm.runInContext(`orderChatContext(db,'${lineId}','production:og')`,c),send:()=>vm.runInContext('startOrderChat(db,input,actor,deps)',c)};
}
const chat=(id,fields={})=>({id,seller_account_id:'seller',conversation_type:'FROM_MEMBERS',other_party_username:'buyer_one',reference_id:'',...fields});
test('resolver preserves line, matches case-insensitively, rejects other buyers/accounts and never mutates',async()=>{
 const f=fixture({ebay_conversations:[chat('exact',{reference_id:'287123456789'}),chat('buyer'),chat('wild',{other_party_username:'buyerXone'}),chat('wrong',{reference_id:'287123456789',other_party_username:'someone'}),chat('seller2',{seller_account_id:'other'})]});const r=await f.context();
 assert.equal(r.preferred_conversation_id,'exact');assert.deepEqual(Array.from(r.conversations,c=>c.id),['exact','buyer']);assert.equal(r.line.id,lineId);assert.equal(f.writes.length,0);
});
test('two matches require a choice, suggested links do not become exact matches',async()=>{
 const f=fixture({ebay_conversations:[chat('a'),chat('b')],ebay_conversation_links:[{seller_account_id:'seller',conversation_id:'a',ebay_order_id:'order',status:'suggested'}]});let r=await f.context();assert.equal(r.preferred_conversation_id,null);assert.ok(r.conversations.every(c=>c.match==='buyer'));
  f.tables.ebay_conversations.forEach(c=>c.reference_id='287123456789');r=await f.context();assert.equal(r.preferred_conversation_id,null);
});
test('a historical buyer/time guess never opens as an exact order match',async()=>{
 const f=fixture({ebay_conversations:[chat('old')],ebay_conversation_links:[{seller_account_id:'seller',conversation_id:'old',ebay_order_id:'order',status:'confirmed',match_method:'buyer_recent_unique_order'}]});const r=await f.context();assert.equal(r.preferred_conversation_id,null);assert.equal(r.conversations[0].match,'buyer');
});
test('legacy verified participant links find a chat with no main username, never override a conflicting username',async()=>{
 const f=fixture({ebay_conversations:[chat('legacy',{other_party_username:null,reference_id:'287123456789'}),chat('conflict',{other_party_username:'someone_else',reference_id:'287123456789'})],ebay_conversation_links:['legacy','conflict'].map(id=>({seller_account_id:'seller',conversation_id:id,link_type:'buyer_username',buyer_username:'BUYER_ONE',matched_value:'BUYER_ONE',status:'confirmed',match_method:'message_participant'}))});const r=await f.context();assert.equal(r.preferred_conversation_id,'legacy');assert.deepEqual(Array.from(r.conversations,c=>c.id),['legacy']);assert.equal(f.writes.length,0);
});
test('missing buyer, nonexistent line, and wrong seller account fail closed',async()=>{
 const f=fixture();f.tables.ebay_orders[0].buyer_username='';await assert.rejects(f.context(),{code:'order_buyer_missing'});f.tables.ebay_orders[0].buyer_username='buyer';f.tables.ebay_seller_accounts=[];await assert.rejects(f.context(),{code:'seller_account_unavailable'});f.tables.ebay_order_lines=[];await assert.rejects(f.context(),{code:'order_line_not_found'});assert.equal(f.c.calls.length,0);
});
test('first send uses trusted order recipient/listing, persists exact link, double click sends once',async()=>{
 const f=fixture();f.c.input.buyer_username='attacker';const r=await f.send();assert.equal(r.delivery_status,'sent');assert.ok(r.conversation_id);assert.equal(f.c.calls[0].body.otherPartyUsername,'Buyer_One');assert.equal(f.c.calls[0].body.reference.referenceId,'287123456789');assert.equal(f.tables.ebay_conversation_links[0].ebay_order_line_id,lineId);assert.equal(f.tables.ebay_conversation_messages[0].direction,'outbound');
 await f.send();assert.equal(f.c.calls.length,1);assert.ok(f.writes.every(w=>!['ebay_orders','ebay_order_lines'].includes(w.table)));
});
test('parallel first messages are claimed atomically, existing exact chat blocks a new conversation',async()=>{
 const f=fixture();await Promise.all([f.send(),f.send()]);assert.equal(f.c.calls.length,1);
 const g=fixture({ebay_conversations:[chat('a',{reference_id:'287123456789'})]});await assert.rejects(g.send(),{code:'order_chat_already_exists'});assert.equal(g.c.calls.length,0);
});
test('confirmation, length, reused key with changed body and actor are validated',async()=>{
 const f=fixture();f.c.input.sendConfirmed=false;await assert.rejects(f.send(),{code:'send_confirmation_required'});f.c.input.sendConfirmed=true;f.c.input.draftText='x'.repeat(2001);await assert.rejects(f.send(),{code:'message_text_invalid'});f.c.input.draftText='Hello';await f.send();f.c.input.draftText='Changed';await assert.rejects(f.send(),{code:'send_request_mismatch'});assert.equal(f.c.calls.length,1);
});
for(const mode of ['network','server','empty-success'])test(`${mode} never automatically repeats a potentially delivered message`,async()=>{
 const f=fixture();f.c.deps.ebayPost=async()=>{f.c.calls.push({});if(mode==='network')throw Error('Connection lost');return {ok:mode==='empty-success',status:mode==='server'?500:201,payload:{}};};
 const first=await f.send();assert.equal(first.delivery_status,mode==='empty-success'?'sent':'unknown');f.c.input.requestId='33333333-3333-4333-8333-333333333333';await f.send();assert.equal(f.c.calls.length,1);
});
test('explicit provider rejection is visible and permits a fresh operator attempt',async()=>{
 const f=fixture();f.c.deps.ebayPost=async()=>{f.c.calls.push({});return {ok:false,status:400,payload:{message:'Listing not available'}};};assert.equal((await f.send()).delivery_status,'failed');f.c.input.requestId='33333333-3333-4333-8333-333333333333';await f.send();assert.equal(f.c.calls.length,2);
});
