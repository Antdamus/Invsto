import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
for(const [method,source] of [['createEbayConversationMessageTask','message'],['createEbayConversationLinkedOrderTask','linked_message']])test(source+': message task retains explicit intent, recipient and context',async()=>{
 const window={};const ctx=vm.createContext({window,console,URL,URLSearchParams,setTimeout,clearTimeout});
 vm.runInContext(await readFile(new URL('../email-triage.api.js',import.meta.url),'utf8'),ctx);
 const writes=[],context={client:{auth:{getSession:async()=>({data:{session:{access_token:'fixture-only',user:{email:'staff@example.test'}}}})},rpc:async(name,args)=>{writes.push([name,JSON.parse(JSON.stringify(args))]);return {data:{id:'task'},error:null};}}};
 await window.EmailTriageApi[method](context,{requestKind:'decision',assignedToUserId:'worker',conversationId:'chat',messageId:'message',orderId:'order',orderLineIds:['line'],title:'Decision needed',description:'Can we proceed?'});
 assert.equal(writes[0][0],'create_task_request');assert.equal(writes[0][1]._request_kind,'decision');assert.equal(writes[0][1]._source,source);
 assert.equal(writes[0][1]._details._assigned_to_user_id,'worker');assert.equal(writes[0][1]._details._conversation_id,'chat');
});
test('closed-order task forwards scope, photos, ownership and intent without reopening an order',async()=>{
 const context=vm.createContext({console,URLSearchParams,setTimeout:()=>0,clearTimeout,window:{addEventListener(){},location:{search:''}},document:{addEventListener(){}}});
 vm.runInContext(await readFile(new URL('../ebay-order-history.js',import.meta.url),'utf8'),context);
 vm.runInContext(`var writes=[];state.user={email:'staff@example.test'};state.employee={};
 const values={'history-order-task-note':'Can we approve this?','history-order-task-assignee':'worker','history-order-task-priority':'high','history-order-task-due-at':''};
 document.getElementById=id=>({value:values[id]||'',textContent:'Create Task',toggleAttribute(){},focus(){}});
 document.querySelector=()=>({value:'decision'});
 getHistoryOrderTaskSelection=()=>({option:{id:'order'},lines:[{id:'line'}],scope:'group',orderIds:['order','other'],orderNumbers:['12-34567-89012']});
 getHistoryOrderTaskPhotoFiles=()=>[];getHistoryOrderTaskLinkedEvidenceAttachments=()=>[{bucket:'photos',path:'proof.jpg'}];
 setHistoryOrderTaskStatus=setHistoryOrderTaskError=closeHistoryOrderTaskModal=()=>{};loadOrderHistory=async()=>{};
 var supabase={rpc:async(name,args)=>{writes.push([name,args]);return {error:null};}};`,context);
 await vm.runInContext('submitHistoryOrderTask()',context);
 const writes=JSON.parse(vm.runInContext('JSON.stringify(writes)',context));assert.equal(writes.length,1);assert.equal(writes[0][0],'create_task_request');
 assert.equal(writes[0][1]._source,'history');assert.equal(writes[0][1]._request_kind,'decision');assert.equal(writes[0][1]._details._task_scope,'group');
 assert.deepEqual(writes[0][1]._details._group_order_ids,['order','other']);assert.equal(writes[0][1]._details._photo_attachments.length,1);
});
