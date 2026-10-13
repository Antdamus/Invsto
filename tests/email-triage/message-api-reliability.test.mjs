import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
const source=await readFile(new URL('../../email-triage.api.js',import.meta.url),'utf8');
function api(){const c=vm.createContext({window:{},console,Date,URL,URLSearchParams,setTimeout,clearTimeout});vm.runInContext(source,c);return c.window.EmailTriageApi;}
const session={access_token:'fixture',user:{id:'fixture'}};
const auth={getSession:async()=>({data:{session}})};
test('conversations longer than 200 messages include latest replies and preserve chronological order',async()=>{
 const calls=[];const messages=Array.from({length:403},(_,id)=>({id}));
 const query={select(){return this;},eq(){return this;},order(){return this;},range:async(a,b)=>{calls.push([a,b]);return {data:messages.slice(a,b+1)};}};
 const result=await api().fetchEbayConversationMessages({client:{auth,from:()=>query}},'conversation');
 assert.equal(result.messages.length,403);assert.equal(result.messages.at(-1).id,402);assert.deepEqual(calls,[[0,199],[200,399],[400,599]]);
});
test('mailbox timeout is surfaced instead of launching a legacy full-mailbox scan',async()=>{
 let fallbackReads=0;const client={auth,rpc:async()=>({error:{code:'57014',message:'statement timeout'}}),from:()=>{fallbackReads++;throw Error('Unexpected fallback');}};
 await assert.rejects(api().fetchEbayConversations({client},{}),e=>e.code==='57014');assert.equal(fallbackReads,0);
});

test('date/read filters, full counts and explicit team receipts survive the mailbox API',async()=>{
 const filters={activityDate:'2026-10-13',teamReadState:'unread',tags:['shipping_problem']};
 const counts={all:12,read:5,unread:7};let request;
 const client={auth,rpc:async(name,args)=>{request=args;return {data:{read_counts:counts,conversations:[{id:'conversation',unread_count:0,activity_at:'2026-10-13T15:00:00Z',team_read:{conversation_id:'conversation',is_read:false,read_by:'Sandra'},classification:{id:'classification',topic_tags:['shipping_problem']}}]}};},from:()=>{throw Error('Unexpected legacy query');}};
 const result=await api().fetchEbayConversations({client},{structuredFilters:filters,systemFilter:'unread'});
 assert.deepEqual(request._structured_filters,filters);assert.deepEqual(result.read_counts,counts);
 assert.equal(result.conversations[0].team_read.is_read,false);assert.equal(result.conversations[0].team_read.read_by,'Sandra');assert.equal(result.conversations[0].activity_at,'2026-10-13T15:00:00Z');
});

test('missing date-filter support never falls back to an unfiltered inbox',async()=>{
 for(const response of [{data:{conversations:[]}},{error:{code:'PGRST202',message:'Function unavailable'}}]){
  let fallbackReads=0;const client={auth,rpc:async()=>response,from:()=>{fallbackReads++;throw Error('Unexpected legacy query');}};
  await assert.rejects(api().fetchEbayConversations({client},{structuredFilters:{activityDate:'2026-10-13',teamReadState:'all'}}));assert.equal(fallbackReads,0);
 }
});
