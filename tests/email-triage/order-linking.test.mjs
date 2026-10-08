import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../../supabase/functions/_shared/ebay-conversation-context.ts',import.meta.url),'utf8');
function runtime(){const c=vm.createContext({console,Date});vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm,''),{mode:'transform'}),c);return c;}
function database(tables){
 const writes=[],reads=[];let next=1;
 function from(table){const filters=[];let limit=Infinity,single=false,mutation=null;const q={
 select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},
 ilike(k,v){const literal=v.replace(/\\([\\%_*])/g,'$1').toLowerCase();filters.push(r=>String(r[k]||'').toLowerCase()===literal);return q;},
 order(){return q;},limit(n){limit=n;return q;},overlaps(k,vs){filters.push(r=>(r[k]||[]).some(v=>vs.includes(v)));return q;},
 maybeSingle(){single=true;return q;},upsert(row){mutation={kind:'upsert',row};return q;},insert(row){mutation={kind:'insert',row};return q;},update(row){mutation={kind:'update',row};return q;},
 then(resolve,reject){try{const rows=tables[table] ||= [];let selected=rows.filter(r=>filters.every(f=>f(r))).slice(0,limit);
 if(mutation){writes.push({table,...mutation});if(mutation.kind==='upsert'){const existing=rows.find(r=>r.conversation_id===mutation.row.conversation_id&&r.link_type===mutation.row.link_type&&r.link_key===mutation.row.link_key);if(existing)Object.assign(existing,mutation.row);else rows.push({id:`saved-${next++}`,...mutation.row});}else if(mutation.kind==='insert')rows.push({id:`saved-${next++}`,...mutation.row});else selected.forEach(r=>Object.assign(r,mutation.row));}else reads.push(table);
 return Promise.resolve({data:single?(selected[0]||null):selected,error:null}).then(resolve,reject);
 }catch(e){return Promise.reject(e).then(resolve,reject);}}
 };return q;}
 return {from,rpc:async()=>({data:{},error:null}),writes,reads};
}
const conversation={id:'chat',seller_account_id:'seller',conversation_type:'FROM_MEMBERS',last_message_created_at:'2026-10-08T12:00:00Z'};
const message={id:'msg',conversation_id:'chat',direction:'inbound',sender_username:'Buyer_One',recipient_username:'ogjewelers',message_body:'Please check my order'};
const order={id:'order-1',order_number:'12-34567-89012',buyer_username:'buyer_one',sale_date:'2026-10-01T12:00:00Z',status:'pending'};
function fixture(extra={}){return {ebay_conversations:[conversation],ebay_conversation_messages:[message],ebay_orders:[order],ebay_conversation_links:[],...extra};}
test('buyer lookup is case-insensitive and treats username wildcards literally',async()=>{
 const c=runtime();assert.equal(vm.runInContext("exactBuyerPattern('Buyer_One')",c),'Buyer\\_One');
 c.db=database(fixture({ebay_orders:[order,{...order,id:'other',buyer_username:'buyerXone'}]}));
 const rows=await vm.runInContext("loadBuyerOrders(db,['BUYER_ONE'])",c);assert.deepEqual(Array.from(rows,r=>r.id),['order-1']);
});
test('ambiguous buyer orders are visible without inventing a chat/order link',async()=>{
 const c=runtime();c.db=database(fixture({ebay_orders:[order,{...order,id:'order-2'}],ebay_conversation_links:[{id:'buyer-link',conversation_id:'chat',link_type:'buyer_username',buyer_username:'Buyer_One',confidence:.88,status:'confirmed',match_method:'message_participant'}],ebay_order_lines:[{id:'line',order_id:'order-1',item_title:'Watch',quantity:1}]}));
 const result=await vm.runInContext("buildEbayConversationContext(db,'chat')",c);
 assert.equal(result.buyer_order_options.length,2);assert.equal(result.buyer_order_options[0].lines[0].item_title,'Watch');assert.equal(result.matched_orders.length,0);assert.equal(c.db.writes.length,0);assert.equal(result.buyer_orders_available,true);
});
test('manual selection validates buyer, persists, takes precedence, and can be removed',async()=>{
 const c=runtime();const tables=fixture({ebay_orders:[order,{...order,id:'wrong',buyer_username:'someone_else'},{...order,id:'old'}],ebay_conversation_links:[{id:'auto',conversation_id:'chat',link_type:'ebay_order',ebay_order_id:'old',status:'suggested',confidence:.68}]});c.db=database(tables);
 await assert.rejects(vm.runInContext("selectEbayConversationOrder(db,'chat','wrong','operator')",c),{code:'order_buyer_mismatch'});assert.equal(c.db.writes.length,0);
 await vm.runInContext("selectEbayConversationOrder(db,'chat','order-1','operator')",c);
 const selected=tables.ebay_conversation_links.find(r=>r.link_key==='operator:order');assert.equal(selected.status,'confirmed');assert.equal(selected.metadata.selected_by,'operator');
 let result=await vm.runInContext("buildEbayConversationContext(db,'chat')",c);assert.deepEqual(Array.from(result.matched_orders,r=>r.id),['order-1']);
 await vm.runInContext("selectEbayConversationOrder(db,'chat',null,'operator')",c);assert.equal(selected.status,'rejected');assert.equal(tables.ebay_orders[0].status,'pending');
 assert.ok(c.db.writes.every(w=>w.table==='ebay_conversation_links'));
});
test('same-buyer proximity alone is never confirmed and ambiguity stays unlinked',async()=>{
 const c=runtime();c.db=database(fixture());c.chat=conversation;c.identifiers=vm.runInContext('extractConversationIdentifiers(chat,[])',c);c.identifiers.buyerUsernames=['buyer_one'];c.candidates=[];c.warnings=[];
 await vm.runInContext("pushBuyerRecentOrderCandidates(db,candidates,chat,identifiers,'2026-10-02T12:00:00Z',warnings)",c);assert.equal(c.candidates[0].status,'suggested');
 c.db=database(fixture({ebay_orders:[order,{...order,id:'two'}]}));c.candidates=[];
 await vm.runInContext("pushBuyerRecentOrderCandidates(db,candidates,chat,identifiers,'2026-10-08T12:00:00Z',warnings)",c);assert.equal(c.candidates.length,0);
});
test('automatic relinking cannot overwrite an operator choice',async()=>{
 const c=runtime();c.db=database(fixture({ebay_conversation_links:[{id:'link',conversation_id:'chat',link_type:'ebay_order',link_key:'operator:order',match_method:'operator_selected_order',confidence:1,status:'confirmed'}]}));c.candidate={conversation_id:'chat',link_type:'ebay_order',link_key:'operator:order',confidence:.8,status:'suggested'};
 await vm.runInContext('upsertConversationLink(db,candidate)',c);assert.equal(c.db.writes.length,0);
});
