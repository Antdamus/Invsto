import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../../supabase/functions/ebay-message-notification/index.ts',import.meta.url),'utf8');
function runtime(client){
 const c=vm.createContext({console,Request,Response,URL,Date,TextEncoder,TextDecoder,AbortSignal,crypto,
  createClient:()=>client,Deno:{serve:()=>{},env:{get:name=>name==='SUPABASE_URL'?'https://fixture.invalid':name==='SUPABASE_SERVICE_ROLE_KEY'?'fixture-only':''}},
  fetch:async()=>new Response(JSON.stringify({ok:true,runId:'run'}),{status:200})});
 vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,''),{mode:'transform'}),c);return c;
}
test('HTTP success is not delivery success until the notified message exists',async()=>{
 let saved=false;const q={select(){return this;},eq(){return this;},limit:async()=>({data:saved?[{id:'one'}]:[]})};
 const c=runtime({from:()=>q});c.fields={ebayConversationId:'chat',ebayMessageId:'message',conversationType:'FROM_MEMBERS'};
 await assert.rejects(vm.runInContext('requestTargetedSync(fields,true)',c),/notified_message_not_available_yet/);
 saved=true;const result=await vm.runInContext('requestTargetedSync(fields,true)',c);assert.equal(result.runId,'run');
});
test('duplicate notification never rewrites verified payload or success status',async()=>{
 const writes=[];const q={insert(row){writes.push(row);return this;},select(){return this;},eq(){return this;},
  maybeSingle:async()=>writes.length===1&&q.first?(q.first=false,{error:{code:'23505'}}):({data:{id:'existing'}}),first:true,
  update(){throw Error('Must not overwrite duplicate');}};
 const client={from:()=>q};const c=runtime(client);c.options={supabase:client,fields:{notificationId:'duplicate'},signatureVerified:false,processingStatus:'signature_failed'};
 assert.equal(await vm.runInContext('insertNotification(options)',c),'existing');
});
test('invalid or replayed worker token cannot execute recovery',async()=>{
 let calls=0;const c=runtime({rpc:async()=>{calls++;return {data:null};}});c.client={rpc:async()=>{calls++;return {data:null};}};
 assert.equal((await vm.runInContext("runMessageRecovery(client,'bogus')",c)).status,403);assert.equal(calls,0);
 assert.equal((await vm.runInContext("runMessageRecovery(client,'00000000-0000-4000-8000-000000000001')",c)).status,403);assert.equal(calls,1);
});
