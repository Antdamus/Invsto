import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../customer-issue-chats.js',import.meta.url),'utf8');
const c={id:'case-1',buyer_username:'buyer&one'};
function setup(rpc=async()=>({data:[]})){
 const slot={dataset:{caseChat:c.id,chatBuyer:c.buyer_username},innerHTML:''};
 const context=vm.createContext({URLSearchParams,Date,setTimeout,clearTimeout,addEventListener(){},document:{hidden:false,addEventListener(){},querySelectorAll(){return [slot];}}});
 vm.runInContext(source,context);const api=context.OGIssueChats;api.init({rpc});return {api,slot};
}
test('direct chat link retains exact case and safely encodes buyer identity',()=>{
 const {api}=setup();const url=new URL(api.testing.href(c,{conversation_id:'chat-1'}),'https://example.test');
 assert.equal(url.searchParams.get('ebayConversationDbId'),'chat-1');assert.equal(url.searchParams.get('caseId'),c.id);assert.equal(url.searchParams.get('ebayBuyer'),c.buyer_username);
 const html=api.testing.html(c,{conversation_id:'chat-1',conversation_count:1,unread_count:1,match_scope:'item',latest_buyer_preview:'<img src=x onerror=alert(1)>'});
 assert.match(html,/Linked to this item/);assert.match(html,/Unread/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('buyer-only fallback and unavailable checks never claim a confirmed order chat',()=>{
 const {api}=setup();assert.match(api.testing.html(c,{conversation_count:2,match_scope:'buyer'}),/Same buyer · check the item/);
 assert.match(api.testing.html(c,undefined,{unavailable:true}),/Chat updates unavailable/);assert.match(api.testing.html(c,{conversation_count:0}),/No saved chat found yet/);
});
test('batch refresh ignores a stale response and preserves last known chat on error',async()=>{
 const pending=[];const {api,slot}=setup(()=>new Promise(r=>pending.push(r)));
 const first=api.load([c]),second=api.load([c]);
 pending[1]({data:[{case_id:c.id,conversation_id:'new',conversation_count:1,match_scope:'item',latest_buyer_preview:'Newest'}]});await second;
 pending[0]({data:[{case_id:c.id,conversation_id:'old',conversation_count:1,match_scope:'item',latest_buyer_preview:'Old'}]});await first;
 assert.match(slot.innerHTML,/Newest/);assert.doesNotMatch(slot.innerHTML,/Old/);
 const third=api.load([c]);pending[2]({error:{message:'offline'}});await third;
 assert.match(slot.innerHTML,/Newest/);assert.match(slot.innerHTML,/Chat updates unavailable/);
});
test('return-to-case banner works on direct conversation links without initiating a send',async()=>{
 const triage=await readFile(new URL('../email-triage.order-chat.js',import.meta.url),'utf8');
 const panel={hidden:true,innerHTML:'',classList:{add(){}}};const context=vm.createContext({URLSearchParams,location:{search:'?from=issues&caseId=case-1&ebayBuyer=Buyer'},document:{getElementById(){return panel;}}});
 context.window=context;vm.runInContext(triage,context);await context.InvstoOrderChat.init({},{});
 assert.equal(panel.hidden,false);assert.match(panel.innerHTML,/Back to customer issue/);assert.match(panel.innerHTML,/ebay-returns.html\?caseId=case-1/);
});
